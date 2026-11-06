// Copyright 2026 MuTracer contributors.
// Instance transform composition adapted from OpenUSD v26.03
// hdEmbree/instancer.cpp (Copyright 2017 Pixar); changes: snapshot inputs,
// nested identity paths, C SDK. TOST 1.0: ../../../LICENSES/OpenUSD-TOST.txt.
// Other bridge code is original.
#include "bridge.h"
#include "gpu.h"
#include "pxr/base/gf/quatd.h"
#include "pxr/base/gf/quatf.h"
#include "pxr/base/gf/quath.h"
#include "pxr/base/tf/diagnostic.h"
#include "pxr/imaging/hd/meshUtil.h"
#include "pxr/imaging/hd/tokens.h"
#include "pxr/usd/sdf/assetPath.h"
#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <stdexcept>
PXR_NAMESPACE_OPEN_SCOPE
namespace mtHydra {
double Milliseconds(Clock::time_point start) {
  return std::chrono::duration<double, std::milli>(Clock::now() - start)
      .count();
}
void Check(int32_t status, char const *error) {
  if (status != MT_OK)
    throw std::runtime_error(std::string(error) + " (SDK " +
                             std::to_string(status) + ")");
}
void Matrix(GfMatrix4d const &m, float *out) {
  // Gf uses row vectors; flattening its row-major matrix gives the transpose
  // interpreted as the SDK's column-major column-vector transform.
  for (int i = 0; i < 4; ++i)
    for (int j = 0; j < 4; ++j)
      out[i * 4 + j] = m[i][j];
}
void Warn(std::string const &message) {
  static std::mutex mutex;
  static std::set<std::string> seen;
  std::lock_guard<std::mutex> lock(mutex);
  if (seen.insert(message).second)
    TF_WARN("hdMuTracer: %s", message.c_str());
}
template <class T>
static VtArray<T> Expand(HdMeshUtil const &util, Primvar const &pv,
                         HdType type) {
  if (!pv.value.IsHolding<VtArray<T>>())
    return {};
  auto a = pv.value.UncheckedGet<VtArray<T>>();
  if (pv.interpolation == HdInterpolationFaceVarying) {
    VtValue out;
    if (util.ComputeTriangulatedFaceVaryingPrimvar(a.cdata(), a.size(), type,
                                                   &out) !=
        HdMeshComputationResult::Success)
      return {};
    return out.Get<VtArray<T>>();
  }
  return a;
}
template <class T>
static T Sample(VtArray<T> const &a, HdInterpolation interpolation,
                size_t vertex, size_t corner, size_t face, T fallback) {
  size_t i = 0;
  if (interpolation == HdInterpolationVertex ||
      interpolation == HdInterpolationVarying)
    i = vertex;
  else if (interpolation == HdInterpolationFaceVarying)
    i = corner;
  else if (interpolation == HdInterpolationUniform)
    i = face;
  return i < a.size() ? a[i] : fallback;
}
Geometry Triangulate(HdMeshTopology const &topology, SdfPath const &id,
                     VtVec3fArray const &points, Primvar const &normals,
                     Primvar const &uv, Primvar const &colors) {
  HdMeshUtil util(&topology, id);
  VtVec3iArray triangles;
  VtIntArray params;
  util.ComputeTriangleIndices(&triangles, &params);
  auto n = Expand<GfVec3f>(util, normals, HdTypeFloatVec3);
  auto t = Expand<GfVec2f>(util, uv, HdTypeFloatVec2);
  auto c = Expand<GfVec3f>(util, colors, HdTypeFloatVec3);
  Geometry g;
  for (size_t i = 0; i < triangles.size(); ++i) {
    auto tri = triangles[i];
    for (int k = 0; k < 3; ++k)
      if (tri[k] < 0 || size_t(tri[k]) >= points.size())
        throw std::runtime_error("invalid point index at " + id.GetString());
    int face = HdMeshUtil::DecodeFaceIndexFromCoarseFaceParam(params[i]);
    g.faces.push_back(face);
    auto faceNormal = GfCross(points[tri[1]] - points[tri[0]],
                              points[tri[2]] - points[tri[0]])
                          .GetNormalized();
    for (int k = 0; k < 3; ++k) {
      auto p = points[tri[k]], normal = Sample(n, normals.interpolation, tri[k],
                                               i * 3 + k, face, faceNormal);
      auto tex =
          Sample(t, uv.interpolation, tri[k], i * 3 + k, face, GfVec2f(0));
      auto color =
          Sample(c, colors.interpolation, tri[k], i * 3 + k, face, GfVec3f(1));
      g.indices.push_back(g.indices.size());
      g.points.insert(g.points.end(), p.data(), p.data() + 3);
      g.normals.insert(g.normals.end(), normal.data(), normal.data() + 3);
      g.uv.insert(g.uv.end(), tex.data(), tex.data() + 2);
      g.colors.insert(g.colors.end(), color.data(), color.data() + 3);
    }
  }
  return g;
}
template <class T>
static T Attr(InstanceData const &d, TfToken const &name, int index,
              T fallback) {
  auto it = d.attributes.find(name);
  if (it != d.attributes.end() && it->second.IsHolding<VtArray<T>>()) {
    auto const &a = it->second.UncheckedGet<VtArray<T>>();
    if (index >= 0 && size_t(index) < a.size())
      return a[index];
  }
  return fallback;
}
static std::vector<Instance>
FlattenImpl(std::map<SdfPath, InstanceData> const &all, SdfPath const &id,
            SdfPath const &proto, std::set<SdfPath> &visiting) {
  auto it = all.find(id);
  if (it == all.end())
    return {};
  if (!visiting.insert(id).second)
    throw std::runtime_error("cyclic instancer hierarchy");
  auto const &d = it->second;
  // Native USD instance prototypes can be scopes containing many mesh prims.
  // Match the prototype prefix, as HdInstancerTopologySchema does for queries.
  VtIntArray indices;
  for (auto const &entry : d.indices)
    if (proto.HasPrefix(entry.first))
      indices.insert(indices.end(), entry.second.begin(), entry.second.end());
  std::vector<Instance> local;
  if (d.visible)
    for (int index : indices) {
      GfMatrix4d t(1), r(1), s(1);
      t.SetTranslate(GfVec3d(
          Attr(d, HdInstancerTokens->instanceTranslations, index, GfVec3f(0))));
      s.SetScale(GfVec3d(
          Attr(d, HdInstancerTokens->instanceScales, index, GfVec3f(1))));
      auto rotation =
          Attr(d, HdInstancerTokens->instanceRotations, index, GfQuatf(1));
      auto q = d.attributes.find(HdInstancerTokens->instanceRotations);
      if (q != d.attributes.end() && q->second.IsHolding<VtQuathArray>())
        rotation = GfQuatf(
            Attr(d, HdInstancerTokens->instanceRotations, index, GfQuath(1)));
      if (q != d.attributes.end() && q->second.IsHolding<VtVec4fArray>()) {
        auto v = Attr(d, HdInstancerTokens->instanceRotations, index,
                      GfVec4f(1, 0, 0, 0));
        rotation = GfQuatf(v[0], v[1], v[2], v[3]);
      }
      r.SetRotate(GfQuatd(rotation));
      auto m =
          Attr(d, HdInstancerTokens->instanceTransforms, index, GfMatrix4d(1));
      local.push_back({m * s * r * t * d.matrix, int(local.size()), {index}});
    }
  if (!d.parent.IsEmpty()) {
    auto parents = FlattenImpl(all, d.parent, id, visiting);
    std::vector<Instance> result;
    for (auto const &parent : parents)
      for (auto const &child : local) {
        auto path = parent.path;
        path.insert(path.end(), child.path.begin(), child.path.end());
        // Hydra flattened selection uses parent-major, child-minor order.
        result.push_back({child.matrix * parent.matrix, int(result.size()),
                          std::move(path)});
      }
    visiting.erase(id);
    return result;
  }
  visiting.erase(id);
  return local;
}
std::vector<Instance> Flatten(std::map<SdfPath, InstanceData> const &all,
                              SdfPath const &id, SdfPath const &proto) {
  std::set<SdfPath> visiting;
  return FlattenImpl(all, id, proto, visiting);
}
Param::Param() {
  if (auto p = std::getenv("MUTRACER_HYDRA_TRACE"))
    trace.open(p, std::ios::app);
}
void Param::Cancel() {
  auto r = render.load();
  if (r) {
    char e[1024] = {};
    mt_render_cancel(r, e, sizeof e);
  }
}
Param::~Param() {
  gpu.reset();
  char e[1024] = {};
  if (engine)
    mt_engine_destroy(engine, e, sizeof e);
  if (scene)
    mt_scene_destroy(scene, e, sizeof e);
}
static VtValue LightValue(LightData const &d, char const *name) {
  auto it = d.values.find(TfToken(name));
  return it == d.values.end() ? VtValue() : it->second;
}
float DistantLightIrradiance(float intensity, float angleDegrees,
                             bool normalize) {
  // UsdLux sizeFactor for DistantLight (usdLux/schema.usda, inputs:normalize).
  double theta = std::clamp(double(angleDegrees) * M_PI / 360, 0., M_PI),
         s2 = std::sin(theta) * std::sin(theta);
  double size = theta == 0          ? 1
                : theta <= M_PI / 2 ? s2 * M_PI
                                    : (2 - s2) * M_PI;
  return normalize ? intensity : float(intensity * size);
}
static float Number(VtValue const &v, float fallback) {
  if (v.IsHolding<float>())
    return v.Get<float>();
  if (v.IsHolding<double>())
    return v.Get<double>();
  if (v.IsHolding<bool>())
    return v.Get<bool>() ? 1 : 0;
  return fallback;
}
void Param::ApplyLight(SdfPath const &path, LightData const &d) {
  char e[2048] = {};
  auto remove = [&]() {
    auto i = lightHandles.find(path);
    if (i != lightHandles.end()) {
      Check(mt_scene_remove_light(scene, i->second, e, sizeof e), e);
      lightHandles.erase(i);
    }
  };
  if (d.type == HdPrimTypeTokens->diskLight ||
      d.type == HdPrimTypeTokens->cylinderLight) {
    remove();
    Warn("skipping unsupported " + d.type.GetString());
    return;
  }
  auto linking = LightValue(d, "lightLink");
  if (linking.IsHolding<TfToken>() && !linking.Get<TfToken>().IsEmpty()) {
    remove();
    Warn("skipping light linking (no SDK support)");
    return;
  }
  if (d.type == HdPrimTypeTokens->domeLight) {
    mt_scene_environment_desc env;
    mt_scene_environment_desc_default(&env);
    env.color[3] = 0;
    if (d.visible) {
      auto file = LightValue(d, "texture:file");
      std::string filename;
      if (file.IsHolding<SdfAssetPath>()) {
        auto a = file.Get<SdfAssetPath>();
        filename = a.GetResolvedPath().empty() ? a.GetAssetPath()
                                               : a.GetResolvedPath();
      }
      TextureData data;
      if (filename.empty()) {
        mt_scene_texture_desc_default(&data.desc);
        data.desc.width = 2;
        data.desc.height = 1;
        data.desc.storage = MT_TEXTURE_STORAGE_RGBA32F;
        auto color = LightValue(d, "color");
        auto c = color.IsHolding<GfVec3f>() ? color.Get<GfVec3f>() : GfVec3f(1);
        data.floats = {c[0], c[1], c[2], 1, c[0], c[1], c[2], 1};
      } else
        data = ReadTexture(filename, false);
      data.desc.pixels = data.floats.data();
      data.desc.pixel_bytes = data.floats.size() * 4;
      std::string key = "dome:" + path.GetString();
      auto &texture = textureHandles[key];
      if (!texture)
        Check(mt_scene_add_texture(scene, &data.desc, &texture, e, sizeof e),
              e);
      else
        Check(mt_scene_set_texture(scene, texture, &data.desc, e, sizeof e), e);
      env.environment = texture;
      mt_scene_environment_settings settings;
      mt_scene_environment_settings_default(&settings);
      settings.intensity = Number(LightValue(d, "intensity"), 1) *
                           std::exp2(Number(LightValue(d, "exposure"), 0));
      auto forward = d.matrix.TransformDir(GfVec3d(0, 0, -1));
      settings.rotation = std::atan2(-forward[0], -forward[2]);
      Check(mt_scene_set_environment_settings(scene, &settings, e, sizeof e),
            e);
    }
    Check(mt_scene_set_environment(scene, &env, e, sizeof e), e);
    return;
  }
  if (!d.visible) {
    remove();
    return;
  }
  mt_scene_light_desc light;
  mt_scene_light_desc_default(&light);
  Matrix(d.matrix, light.world_matrix);
  auto color = LightValue(d, "color");
  if (color.IsHolding<GfVec3f>())
    std::copy_n(color.Get<GfVec3f>().data(), 3, light.color);
  light.intensity = Number(LightValue(d, "intensity"), 1) *
                    std::exp2(Number(LightValue(d, "exposure"), 0));
  if (Number(LightValue(d, "enableColorTemperature"), 0))
    Warn("light color temperature is unsupported; using light color");
  float cone = Number(LightValue(d, "shaping:cone:angle"), 180);
  if (cone < 180) {
    light.type = MT_LIGHT_TYPE_SPOT;
    light.size_or_radius = Number(LightValue(d, "radius"), 0);
    light.spread_or_outer_angle = cone;
    light.height_or_inner_angle =
        cone * (1 - Number(LightValue(d, "shaping:cone:softness"), 0));
  } else if (d.type == HdPrimTypeTokens->rectLight) {
    light.type = MT_LIGHT_TYPE_RECT;
    light.size_or_radius = Number(LightValue(d, "width"), 1);
    light.height_or_inner_angle = Number(LightValue(d, "height"), 1);
  } else if (d.type == HdPrimTypeTokens->sphereLight) {
    light.type = MT_LIGHT_TYPE_SPHERE;
    light.size_or_radius = Number(LightValue(d, "radius"), .5f);
  } else {
    // UsdLux gives distant lights angular radiance; the SDK takes irradiance.
    light.type = MT_LIGHT_TYPE_DIRECTIONAL;
    light.intensity = DistantLightIrradiance(
        light.intensity, Number(LightValue(d, "angle"), .53f),
        Number(LightValue(d, "normalize"), 0) != 0);
  }
  if (light.type != MT_LIGHT_TYPE_DIRECTIONAL &&
      Number(LightValue(d, "normalize"), 0))
    Warn("UsdLux normalize is unsupported; using SDK radiance units");
  // The SDK has no per-lobe light multipliers. Equal multipliers, such as the
  // pi that Hydra puts on its default camera light, scale the whole light.
  float diffuse = Number(LightValue(d, "diffuse"), 1),
        specular = Number(LightValue(d, "specular"), 1);
  if (diffuse == specular)
    light.intensity *= diffuse;
  else
    Warn("unequal light diffuse/specular multipliers are unsupported");
  auto &handle = lightHandles[path];
  if (!handle)
    Check(mt_scene_add_light(scene, &light, &handle, e, sizeof e), e);
  else
    Check(mt_scene_set_light(scene, handle, &light, e, sizeof e), e);
}
bool Param::Apply(int requestedBackend) {
  char e[2048] = {};
  auto begin = Clock::now();
  if (!engine || backend != requestedBackend) {
    gpu.reset();
    if (engine) {
      render = 0;
      Check(mt_engine_destroy(engine, e, sizeof e), e);
      engine = 0;
    }
    mt_engine_options options;
    mt_engine_options_default(&options);
    options.backend = requestedBackend;
    auto status = CreateHostEngine(hgi, options, &engine, e, sizeof e);
    if (status == MT_OK) {
      try {
        gpu = std::make_unique<GpuOutput>(hgi, engine);
      } catch (std::exception const &error) {
        Warn(std::string("GPU output initialization failed: ") + error.what());
        Check(mt_engine_destroy(engine, e, sizeof e), e);
        engine = 0;
      }
    }
    if (!gpu) {
      Warn(std::string("CPU output: ") + e);
      Check(mt_engine_create(&options, &engine, e, sizeof e), e);
    }
    backend = requestedBackend;
    Check(mt_engine_set_callback(
              engine,
              [](mt_engine_event const *event, void *user) {
                if (event->message &&
                    (event->kind == MT_ENGINE_EVENT_ERROR ||
                     event->kind == MT_ENGINE_EVENT_DEVICE_LOST))
                  static_cast<Param *>(user)->sdkError = event->message;
              },
              this, e, sizeof e),
          e);
    if (!scene) {
      Check(mt_scene_create(&scene, e, sizeof e), e);
      mt_scene_environment_desc env;
      mt_scene_environment_desc_default(&env);
      env.color[3] = 0;
      Check(mt_scene_set_environment(scene, &env, e, sizeof e), e);
    }
    for (auto const &x : meshes)
      changedMeshes.insert(x.first);
  }
  bool changed = !changedMeshes.empty() || !removedMeshes.empty() ||
                 !changedMaterials.empty() || !changedLights.empty() ||
                 !removedLights.empty() || instancesDirty;
  if (!changed)
    return false;
  for (auto const &id : removedMeshes) {
    auto i = resources.find(id);
    if (i != resources.end()) {
      if (i->second.mesh)
        Check(mt_scene_remove_mesh(scene, i->second.mesh, e, sizeof e), e);
      if (i->second.geometry)
        Check(mt_scene_remove_geometry(scene, i->second.geometry, e, sizeof e),
              e);
      resources.erase(i);
    }
  }
  removedMeshes.clear();
  for (auto const &id : changedMaterials)
    for (auto const &m : materialHandles)
      if (m.first.first == id)
        ApplyMaterial(id, m.first.second, m.second);
  for (auto const &x : meshes)
    if (instancesDirty)
      changedMeshes.insert(x.first);
  for (auto const &id : changedMeshes) {
    auto it = meshes.find(id);
    if (it == meshes.end())
      continue;
    auto const &m = it->second;
    auto &r = resources[id];
    r.primId = m.primId;
    // A Hydra topology resync may represent removal/recreation even when
    // authored arrays compare equal. Retire its SDK object identity; ordinary
    // transform/primvar edits retain the handle and incremental comparison.
    if (r.mesh && (m.dirty & HdChangeTracker::DirtyTopology)) {
      Check(mt_scene_remove_mesh(scene, r.mesh, e, sizeof e), e);
      r.mesh = 0;
    }
    auto key = std::make_pair(m.material, m.doubleSided);
    auto &material = materialHandles[key];
    if (!material) {
      mt_scene_material_desc desc;
      mt_scene_material_desc_default(&desc);
      desc.alpha_cutoff = 0;
      Check(mt_scene_add_material(scene, &desc, &material, e, sizeof e), e);
      ApplyMaterial(m.material, m.doubleSided, material);
    }
    auto geometryBits =
        HdChangeTracker::DirtyPoints | HdChangeTracker::DirtyNormals |
        HdChangeTracker::DirtyPrimvar | HdChangeTracker::DirtyTopology;
    if (!r.geometry || (m.dirty & geometryBits)) {
      auto g = Triangulate(m.topology, id, m.points, m.normals, m.uv, m.colors);
      r.faces = g.faces;
      if (g.indices.empty()) {
        if (r.mesh) {
          Check(mt_scene_remove_mesh(scene, r.mesh, e, sizeof e), e);
          r.mesh = 0;
        }
        continue;
      }
      mt_scene_geometry_desc desc;
      mt_scene_geometry_desc_default(&desc);
      desc.positions = g.points.data();
      desc.vertex_count = g.points.size() / 3;
      desc.indices = g.indices.data();
      desc.index_count = g.indices.size();
      desc.normals = g.normals.data();
      desc.uv = g.uv.data();
      desc.colors = g.colors.data();
      if (!r.geometry)
        Check(mt_scene_add_geometry(scene, &desc, &r.geometry, e, sizeof e), e);
      else
        Check(mt_scene_set_geometry(scene, r.geometry, &desc, e, sizeof e), e);
    }
    r.instances = m.instancer.IsEmpty() ? std::vector<Instance>()
                                        : Flatten(instancers, m.instancer, id);
    bool visible = m.visible && (m.instancer.IsEmpty() || !r.instances.empty());
    if (!visible) {
      if (r.mesh) {
        Check(mt_scene_remove_mesh(scene, r.mesh, e, sizeof e), e);
        r.mesh = 0;
      }
      continue;
    }
    mt_scene_mesh_desc desc;
    mt_scene_mesh_desc_default(&desc);
    desc.geometry = r.geometry;
    desc.material = material;
    Matrix(m.matrix, desc.world_matrix);
    mt_scene_instances_desc instances;
    mt_scene_instances_desc_default(&instances);
    std::vector<float> transforms;
    for (auto const &i : r.instances) {
      float matrix[16];
      Matrix(i.matrix, matrix);
      transforms.insert(transforms.end(), matrix, matrix + 16);
    }
    instances.count = r.instances.size();
    instances.transforms = transforms.data();
    if (!r.mesh) {
      if (!m.instancer.IsEmpty())
        Check(mt_scene_add_instances(scene, &desc, &instances, &r.mesh, e,
                                     sizeof e),
              e);
      else
        Check(mt_scene_add_mesh(scene, &desc, &r.mesh, e, sizeof e), e);
    } else {
      Check(mt_scene_set_mesh(scene, r.mesh, &desc, e, sizeof e), e);
      Check(mt_scene_set_instances(scene, r.mesh,
                                   m.instancer.IsEmpty() ? nullptr : &instances,
                                   e, sizeof e),
            e);
    }
  }
  for (auto const &id : removedLights) {
    auto i = lightHandles.find(id);
    if (i != lightHandles.end()) {
      Check(mt_scene_remove_light(scene, i->second, e, sizeof e), e);
      lightHandles.erase(i);
    }
    auto dome = textureHandles.find("dome:" + id.GetString());
    if (dome != textureHandles.end()) {
      mt_scene_environment_desc env;
      mt_scene_environment_desc_default(&env);
      env.color[3] = 0;
      Check(mt_scene_set_environment(scene, &env, e, sizeof e), e);
    }
  }
  for (auto const &id : changedLights) {
    auto i = lights.find(id);
    if (i != lights.end())
      ApplyLight(id, i->second);
  }
  identities.clear();
  for (auto const &x : resources)
    if (x.second.mesh) {
      auto const &r = x.second;
      uint32_t id = uint32_t(r.mesh);
      if (id == UINT32_MAX || identities.count(id))
        throw std::runtime_error("SDK AOV identity collision");
      identities.emplace(id, Identity{r.primId, r.faces, r.instances});
    }
  Check(mt_scene_pending_commit_kind(scene, &predicted, e, sizeof e), e);
  Check(mt_engine_set_scene_object(engine, scene, e, sizeof e), e);
  submitMs = Milliseconds(begin);
  updateMs = 0;
  for (auto &x : meshes)
    x.second.dirty = 0;
  changedMeshes.clear();
  changedMaterials.clear();
  changedLights.clear();
  removedLights.clear();
  instancesDirty = false;
  return true;
}
void Param::Record(uint32_t actual, uint32_t samples, double refineMs,
                   double readMs) {
  if (trace) {
    trace << "{\"dirty\":[";
    bool first = true;
    for (auto const &x : events) {
      if (!first)
        trace << ',';
      first = false;
      trace << "{\"path\":\"" << x.first.GetString()
            << "\",\"bits\":" << x.second << '}';
    }
    trace << "],\"objects\":[";
    first = true;
    if (!events.empty())
      for (auto const &x : resources)
        if (x.second.mesh) {
          if (!first)
            trace << ',';
          first = false;
          trace << "{\"path\":\"" << x.first.GetString()
                << "\",\"primId\":" << x.second.primId
                << ",\"sdkId\":" << uint32_t(x.second.mesh)
                << ",\"triangles\":" << x.second.faces.size()
                << ",\"instances\":" << x.second.instances.size() << '}';
        }
    trace << "],\"dirtyPrims\":" << events.size()
          << ",\"predicted\":" << predicted << ",\"actual\":" << actual
          << ",\"submitMs\":" << submitMs << ",\"updateMs\":" << updateMs
          << ",\"refineMs\":" << refineMs << ",\"readHdrMs\":" << readHdrMs
          << ",\"readDepthMs\":" << readDepthMs << ",\"readIdMs\":" << readIdMs
          << ",\"gpuOutput\":" << (usingGpuOutput ? "true" : "false")
          << ",\"renderBackend\":" << actualBackend
          << ",\"skippedExports\":" << skippedExports
          << ",\"exportMs\":" << exportMs << ",\"convertMs\":" << convertMs
          << ",\"readMs\":" << readMs << ",\"samples\":" << samples << "}\n";
    trace.flush();
  }
  events.clear();
  submitMs = updateMs = 0;
  readHdrMs = readDepthMs = readIdMs = exportMs = convertMs = 0;
}
} // namespace mtHydra
PXR_NAMESPACE_CLOSE_SCOPE
