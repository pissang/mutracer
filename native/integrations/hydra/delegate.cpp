// Copyright 2026 MuTracer contributors.
// Hydra plugin/class shells adapted from OpenUSD v26.03 hdEmbree
// (Copyright 2016-2019 Pixar). Rewritten for queued Sync and the MuTracer SDK.
// Applicable TOST 1.0 license: ../../../LICENSES/OpenUSD-TOST.txt.
#include "bridge.h"
#include "gpu.h"
#include "pxr/base/gf/half.h"
#include "pxr/base/tf/diagnostic.h"
#include "pxr/imaging/hd/driver.h"
#include "pxr/imaging/hd/renderIndex.h"
#include "pxr/imaging/hd/renderPassState.h"
#include "pxr/imaging/hd/rendererPlugin.h"
#include "pxr/imaging/hd/rendererPluginRegistry.h"
#include "pxr/imaging/hd/repr.h"
#include "pxr/imaging/hd/resourceRegistry.h"
#include "pxr/imaging/hd/sceneDelegate.h"
#include "pxr/imaging/hd/tokens.h"
#include "pxr/imaging/hgi/tokens.h"
#ifdef _WIN32
#include "pxr/imaging/glf/glContext.h"
#endif
#include <algorithm>
#include <cmath>
#include <limits>
#include <cstring>
#include <thread>
PXR_NAMESPACE_OPEN_SCOPE
namespace mtHydra {
static Primvar Pull(HdSceneDelegate *d, SdfPath const &id, TfToken const &key) {
  for (int i = 0; i < HdInterpolationCount; ++i)
    for (auto const &pv : d->GetPrimvarDescriptors(id, HdInterpolation(i)))
      if (pv.name == key)
        return {d->Get(id, key), HdInterpolation(i)};
  return {};
}
class Mesh final : public HdMesh {
public:
  explicit Mesh(SdfPath const &id) : HdMesh(id) {}
  HdDirtyBits GetInitialDirtyBitsMask() const override {
    return HdChangeTracker::AllDirty;
  }
  void Sync(HdSceneDelegate *d, HdRenderParam *p, HdDirtyBits *bits,
            TfToken const &) override {
    auto &state = *static_cast<Param *>(p);
    _UpdateInstancer(d, bits);
    HdInstancer::_SyncInstancerAndParents(d->GetRenderIndex(),
                                          GetInstancerId());
    std::lock_guard<std::mutex> lock(state.mutex);
    auto &m = state.meshes[GetId()];
    auto b = *bits;
    state.events.emplace_back(GetId(), b);
    m.primId = GetPrimId();
    m.dirty |= b;
    if (b & HdChangeTracker::DirtyTopology) {
      m.topology = d->GetMeshTopology(GetId());
      if (m.topology.GetScheme() != TfToken("none"))
        Warn("subdivision meshes render as control cages");
    }
    if (b & HdChangeTracker::DirtyPoints) {
      auto v = d->Get(GetId(), HdTokens->points);
      if (v.IsHolding<VtVec3fArray>())
        m.points = v.Get<VtVec3fArray>();
    }
    if (b & (HdChangeTracker::DirtyNormals | HdChangeTracker::DirtyPrimvar)) {
      m.normals = Pull(d, GetId(), HdTokens->normals);
      m.uv = Pull(d, GetId(), TfToken("st"));
      m.colors = Pull(d, GetId(), HdTokens->displayColor);
    }
    if (b & HdChangeTracker::DirtyTransform)
      m.matrix = d->GetTransform(GetId());
    if (b & HdChangeTracker::DirtyMaterialId)
      m.material = d->GetMaterialId(GetId());
    if (b & HdChangeTracker::DirtyVisibility) {
      _UpdateVisibility(d, bits);
      m.visible = IsVisible();
    }
    if (b & HdChangeTracker::DirtyDoubleSided)
      m.doubleSided = d->GetDoubleSided(GetId());
    m.instancer = GetInstancerId();
    state.changedMeshes.insert(GetId());
    *bits = HdChangeTracker::Clean;
  }
  void Finalize(HdRenderParam *p) override {
    auto &state = *static_cast<Param *>(p);
    std::lock_guard<std::mutex> lock(state.mutex);
    state.meshes.erase(GetId());
    state.changedMeshes.erase(GetId());
    state.removedMeshes.insert(GetId());
    state.events.emplace_back(GetId(), HdChangeTracker::AllDirty);
  }

protected:
  void _InitRepr(TfToken const &token, HdDirtyBits *) override {
    if (std::none_of(_reprs.begin(), _reprs.end(),
                     [&](auto const &r) { return r.first == token; }))
      _reprs.emplace_back(token, HdReprSharedPtr());
  }
  HdDirtyBits _PropagateDirtyBits(HdDirtyBits b) const override { return b; }
};
class Material final : public HdMaterial {
public:
  explicit Material(SdfPath const &id) : HdMaterial(id) {}
  HdDirtyBits GetInitialDirtyBitsMask() const override { return AllDirty; }
  void Sync(HdSceneDelegate *d, HdRenderParam *p, HdDirtyBits *b) override {
    auto v = d->GetMaterialResource(GetId());
    HdMaterialNetwork2 network;
    if (v.IsHolding<HdMaterialNetworkMap>())
      network = HdConvertToHdMaterialNetwork2(v.Get<HdMaterialNetworkMap>());
    else if (v.IsHolding<HdMaterialNetwork2>())
      network = v.Get<HdMaterialNetwork2>();
    auto &s = *static_cast<Param *>(p);
    std::lock_guard<std::mutex> lock(s.mutex);
    s.materials[GetId()] = std::move(network);
    s.changedMaterials.insert(GetId());
    s.events.emplace_back(GetId(), *b);
    *b = Clean;
  }
  void Finalize(HdRenderParam *p) override {
    auto &s = *static_cast<Param *>(p);
    std::lock_guard<std::mutex> lock(s.mutex);
    s.materials.erase(GetId());
    s.changedMaterials.insert(GetId());
  }
};
class Instancer final : public HdInstancer {
public:
  Instancer(HdSceneDelegate *d, SdfPath const &id) : HdInstancer(d, id) {}
  void Sync(HdSceneDelegate *d, HdRenderParam *p, HdDirtyBits *b) override {
    _UpdateInstancer(d, b);
    InstanceData data;
    data.parent = GetParentId();
    data.matrix = d->GetInstancerTransform(GetId());
    data.visible = d->GetVisible(GetId());
    for (auto const &proto : d->GetInstancerPrototypes(GetId()))
      data.indices[proto] = d->GetInstanceIndices(GetId(), proto);
    for (auto const &pv :
         d->GetPrimvarDescriptors(GetId(), HdInterpolationInstance))
      data.attributes[pv.name] = d->Get(GetId(), pv.name);
    auto &s = *static_cast<Param *>(p);
    std::lock_guard<std::mutex> lock(s.mutex);
    s.instancers[GetId()] = std::move(data);
    s.instancesDirty = true;
    s.events.emplace_back(GetId(), *b);
    *b = HdChangeTracker::Clean;
  }
  void Finalize(HdRenderParam *p) override {
    auto &s = *static_cast<Param *>(p);
    std::lock_guard<std::mutex> lock(s.mutex);
    s.instancers.erase(GetId());
    s.instancesDirty = true;
  }
};
class Light final : public HdLight {
public:
  Light(SdfPath const &id, TfToken const &type) : HdLight(id) {
    data.type = type;
  }
  HdDirtyBits GetInitialDirtyBitsMask() const override { return AllDirty; }
  void Sync(HdSceneDelegate *d, HdRenderParam *p, HdDirtyBits *b) override {
    if (*b & DirtyTransform)
      data.matrix = d->GetTransform(GetId());
    if (*b & (DirtyParams | DirtyResource | DirtyCollection)) {
      data.visible = d->GetVisible(GetId());
      for (auto const &name : HdLightTokens->allTokens)
        data.values[name] = d->GetLightParamValue(GetId(), name);
      data.values[TfToken("lightLink")] =
          d->GetLightParamValue(GetId(), TfToken("lightLink"));
    }
    auto &s = *static_cast<Param *>(p);
    std::lock_guard<std::mutex> lock(s.mutex);
    s.lights[GetId()] = data;
    s.changedLights.insert(GetId());
    s.events.emplace_back(GetId(), *b);
    *b = Clean;
  }
  void Finalize(HdRenderParam *p) override {
    auto &s = *static_cast<Param *>(p);
    std::lock_guard<std::mutex> lock(s.mutex);
    s.lights.erase(GetId());
    s.changedLights.erase(GetId());
    s.removedLights.insert(GetId());
  }

private:
  LightData data;
};
class Camera final : public HdCamera {
public:
  explicit Camera(SdfPath const &id) : HdCamera(id) {}
  void Sync(HdSceneDelegate *d, HdRenderParam *p, HdDirtyBits *b) override {
    auto bits = *b;
    HdCamera::Sync(d, p, b);
    auto &s = *static_cast<Param *>(p);
    std::lock_guard<std::mutex> lock(s.mutex);
    s.events.emplace_back(GetId(), bits);
    s.cameraDirty = true;
  }
};
bool Buffer::Allocate(GfVec3i const &size, HdFormat fmt, bool ms) {
  if (IsMapped() || size[0] <= 0 || size[1] <= 0 || size[2] != 1)
    return false;
  if (fmt != HdFormatFloat32Vec4 && fmt != HdFormatFloat16Vec4 &&
      fmt != HdFormatFloat32Vec3 && fmt != HdFormatFloat32 && fmt != HdFormatInt32)
    return false;
  readOnMap = {};
  output.reset();
  width = size[0];
  height = size[1];
  format = fmt;
  multisampled = ms;
  pixels.assign(size_t(width) * height * HdDataSizeOfFormat(format), 0);
  converged = false;
  return true;
}
static void ReadBuffers(Param *param,
                        HdRenderPassAovBindingVector const &bindings,
                        uint32_t width, uint32_t height, float scale,
                        GfMatrix4d const &view, GfMatrix4d const &projection) {
  char e[2048] = {};
  std::map<uint32_t, std::vector<uint8_t>> images;
  for (auto const &a : bindings) {
    uint32_t kind = a.aovName == HdAovTokens->color ? MT_IMAGE_HDR
                    : a.aovName == HdAovTokens->depth ? MT_IMAGE_CENTER_DEPTH
                    : a.aovName == HdAovTokens->Peye ? MT_IMAGE_CENTER_POSITION
                    : a.aovName == HdAovTokens->normal || a.aovName == HdAovTokens->Neye
                        ? MT_IMAGE_CENTER_NORMAL
                        : MT_IMAGE_ID;
    if (images.count(kind))
      continue;
    auto &bytes = images[kind];
    bytes.resize(size_t(width) * height * 16);
    size_t written;
    auto readStart = Clock::now();
    Check(mt_render_read_pixels(param->render, kind, bytes.data(), bytes.size(),
                                &written, e, sizeof e),
          e);
    double ms = Milliseconds(readStart);
    if (kind == MT_IMAGE_HDR)
      param->readHdrMs = ms;
    else if (kind == MT_IMAGE_CENTER_DEPTH)
      param->readDepthMs = ms;
    else
      param->readIdMs = ms;
  }
  for (auto const &a : bindings) {
    auto b = dynamic_cast<Buffer *>(a.renderBuffer);
    if (!b || b->IsMapped())
      continue;
    bool vectorAov = a.aovName == HdAovTokens->normal || a.aovName == HdAovTokens->Neye ||
                     a.aovName == HdAovTokens->Peye;
    bool idAov = a.aovName == HdAovTokens->primId || a.aovName == HdAovTokens->instanceId ||
                 a.aovName == HdAovTokens->elementId;
    if ((a.aovName == HdAovTokens->depth && b->GetFormat() != HdFormatFloat32) ||
        (vectorAov && b->GetFormat() != HdFormatFloat32Vec3 && b->GetFormat() != HdFormatFloat32Vec4) ||
        (idAov && b->GetFormat() != HdFormatInt32) ||
        (a.aovName == HdAovTokens->color && b->GetFormat() != HdFormatFloat32Vec4 && b->GetFormat() != HdFormatFloat16Vec4))
      throw std::runtime_error("unsupported AOV format");
    uint32_t kind = a.aovName == HdAovTokens->color ? MT_IMAGE_HDR
                    : a.aovName == HdAovTokens->depth ? MT_IMAGE_CENTER_DEPTH
                    : a.aovName == HdAovTokens->Peye ? MT_IMAGE_CENTER_POSITION
                    : a.aovName == HdAovTokens->normal || a.aovName == HdAovTokens->Neye
                        ? MT_IMAGE_CENTER_NORMAL
                        : MT_IMAGE_ID;
    auto const *floats = reinterpret_cast<float const *>(images[kind].data());
    auto const *ids = reinterpret_cast<uint32_t const *>(images[kind].data());
    GfVec4f clear(0);
    if (a.clearValue.IsHolding<GfVec4f>())
      clear = a.clearValue.Get<GfVec4f>();
    else if (a.clearValue.IsHolding<GfVec4d>())
      clear = GfVec4f(a.clearValue.Get<GfVec4d>());
    for (unsigned y = 0; y < b->GetHeight(); ++y)
      for (unsigned x = 0; x < b->GetWidth(); ++x) {
        size_t src =
            (size_t(std::min(height - 1,
                             uint32_t((b->GetHeight() - 1 - y) * scale))) *
                 width +
             std::min(width - 1, uint32_t(x * scale))) *
            4;
        size_t dst = size_t(y) * b->GetWidth() + x;
        if (kind == MT_IMAGE_HDR) {
          float pixel[4];
          float alpha = std::clamp(floats[src + 3], 0.f, 1.f);
          for (int k = 0; k < 3; ++k)
            pixel[k] = std::fma(floats[src + k], alpha,
                                clear[k] * clear[3] * (1 - alpha));
          pixel[3] = std::fma(clear[3], (1 - alpha), alpha);
          if (b->GetFormat() == HdFormatFloat32Vec4)
            std::memcpy(b->pixels.data() + dst * 16, pixel, 16);
          else if (b->GetFormat() == HdFormatFloat16Vec4)
            for (int k = 0; k < 4; ++k)
              reinterpret_cast<GfHalf *>(b->pixels.data())[dst * 4 + k] =
                  pixel[k];
        } else if (a.aovName == HdAovTokens->depth) {
          float depth = 1;
          if (floats[src + 3] > 0) {
            depth = ClipDepth(floats[src], projection);
          }
          std::memcpy(b->pixels.data() + dst * 4, &depth, 4);
        } else if (vectorAov) {
          GfVec3d value(floats[src], floats[src + 1], floats[src + 2]);
          if (floats[src + 3] <= 0) value = GfVec3d(0);
          else if (a.aovName == HdAovTokens->Neye) {
            auto transformed = GfVec4d(value[0], value[1], value[2], 0) *
                               view.GetInverse().GetTranspose();
            value = GfVec3d(transformed[0], transformed[1], transformed[2]);
            value.Normalize();
          } else if (a.aovName == HdAovTokens->Peye) {
            auto transformed = GfVec4d(value[0], value[1], value[2], 1) * view;
            value = GfVec3d(transformed[0], transformed[1], transformed[2]);
          }
          size_t stride = b->GetFormat() == HdFormatFloat32Vec4 ? 16 : 12;
          float pixel[4] = {float(value[0]), float(value[1]), float(value[2]), floats[src + 3]};
          std::memcpy(b->pixels.data() + dst * stride, pixel, stride);
        } else {
          int value = -1;
          auto i = param->identities.find(ids[src]);
          if (i != param->identities.end()) {
            if (a.aovName == HdAovTokens->primId)
              value = i->second.primId;
            else if (a.aovName == HdAovTokens->elementId &&
                     ids[src + 3] < i->second.faces.size())
              value = i->second.faces[ids[src + 3]];
            else if (a.aovName == HdAovTokens->instanceId &&
                     ids[src + 1] < i->second.instances.size())
              value = i->second.instances[ids[src + 1]].index;
          }
          std::memcpy(b->pixels.data() + dst * 4, &value, 4);
        }
      }
  }
}
class Pass final : public HdRenderPass {
public:
  Pass(HdRenderIndex *index, HdRprimCollection const &c,
       std::shared_ptr<Param> p)
      : HdRenderPass(index, c), param(std::move(p)) {}
  bool IsConverged() const override { return converged; }

protected:
  void _Execute(HdRenderPassStateSharedPtr const &state,
                TfTokenVector const &) override;
  void _MarkCollectionDirty() override { lastSamples = UINT32_MAX; }

private:
  std::shared_ptr<Param> param;
  GfMatrix4d view{0.0}, projection{0.0};
  unsigned lastSettings = UINT32_MAX;
  uint32_t lastSamples = UINT32_MAX, width = 0, height = 0;
  bool converged = false;
  Clock::time_point lastRead{};
  HdRenderPassAovBindingVector bindings;
  std::shared_ptr<OutputResources> output = std::make_shared<OutputResources>();
};
static int Setting(HdRenderDelegate *d, char const *name, int fallback) {
  auto v = d->GetRenderSetting(TfToken(name));
  return v.IsHolding<int>() ? v.Get<int>() : fallback;
}
static float FloatSetting(HdRenderDelegate *d, char const *name,
                          float fallback) {
  auto v = d->GetRenderSetting(TfToken(name));
  if (v.IsHolding<float>())
    return v.Get<float>();
  if (v.IsHolding<double>())
    return v.Get<double>();
  return fallback;
}
void Pass::_Execute(HdRenderPassStateSharedPtr const &state,
                    TfTokenVector const &) {
#ifdef _WIN32
  // SDK adapter discovery and lazy resource initialization may change the
  // current context. Hdx's following AOV upload must use the host's GL context.
  GlfGLContextScopeHolder context(GlfGLContext::GetCurrentGLContext());
#endif
  std::lock_guard<std::mutex> lock(param->mutex);
  if (param->stopped)
    return;
  char e[2048] = {};
  try {
    auto delegate = GetRenderIndex()->GetRenderDelegate();
    auto nextBindings = state->GetAovBindings();
    if (nextBindings.empty()) {
      if (param->gpu)
        param->gpu->Invalidate();
      bindings.clear();
      lastSamples = UINT32_MAX;
      converged = true;
      return;
    }
    auto buffer = dynamic_cast<Buffer *>(nextBindings.front().renderBuffer);
    if (!buffer)
      return;
    auto w = buffer->GetWidth(), h = buffer->GetHeight();
    if (!w || !h)
      return;
    float scale =
        std::clamp(FloatSetting(delegate, "resolutionScale", 1), .1f, 1.f);
    uint32_t rw = std::max(1u, uint32_t(w * scale)),
             rh = std::max(1u, uint32_t(h * scale));
    auto settings = delegate->GetRenderSettingsVersion();
    param->forceCpu = Setting(delegate, "forceCpuOutput", 0) != 0;
    bool changed = param->Apply(Setting(delegate, "backend", MT_BACKEND_HWRT));
    bool cameraChanged = state->GetWorldToViewMatrix() != view ||
                         state->GetProjectionMatrix() != projection ||
                         param->cameraDirty;
    param->cameraDirty = false;
    if (cameraChanged || changed) {
      view = state->GetWorldToViewMatrix();
      projection = state->GetProjectionMatrix();
      mt_camera_v4 camera{};
      camera.projection = std::abs(projection[3][3] - 1) < 1e-8
                              ? MT_CAMERA_PROJECTION_ORTHOGRAPHIC
                              : MT_CAMERA_PROJECTION_PERSPECTIVE;
      camera.zoom = 1;
      camera.near_clip = .01f;
      camera.far_clip = 1e6f;
      camera.meters_per_unit = 1;
      camera.focus_distance = 1;
      camera.sensor_height = 24;
      camera.fov = 2 * std::atan(1 / projection[1][1]) * 180 / M_PI;
      if (camera.projection == MT_CAMERA_PROJECTION_ORTHOGRAPHIC) {
        camera.left = (-1 - projection[3][0]) / projection[0][0];
        camera.right = (1 - projection[3][0]) / projection[0][0];
        camera.bottom = (-1 - projection[3][1]) / projection[1][1];
        camera.top = (1 - projection[3][1]) / projection[1][1];
      } else if (std::abs(projection[2][0]) + std::abs(projection[2][1]) > 1e-7)
        Warn("off-axis perspective projection is unsupported by the SDK "
             "camera; using symmetric frustum");
      if (auto c = state->GetCamera()) {
        camera.near_clip = c->GetClippingRange().GetMin();
        camera.far_clip = c->GetClippingRange().GetMax();
        camera.f_stop = c->GetFStop();
        camera.focus_distance = c->GetFocusDistance();
        camera.sensor_height = c->GetVerticalAperture() * 1000;
      }
      if (camera.focus_distance <= 0) {
        camera.f_stop = 0;
        camera.focus_distance = 1;
      }
      if (camera.sensor_height <= 0)
        camera.sensor_height = 24;
      Matrix(view.GetInverse(), camera.world_matrix);
      // Diagnostic snapshot for SDK-only reproductions. Keep Hydra's resolved
      // geometry/materials, but bake the active view and render dimensions into
      // the descriptor (Scene itself does not own this render's camera).
      if (auto path = std::getenv("MUTRACER_HYDRA_CAPTURE_SCENE")) {
        size_t length = 0;
        Check(mt_scene_encode(param->scene, nullptr, 0, &length, e, sizeof e), e);
        std::vector<uint8_t> bytes(length);
        Check(mt_scene_encode(param->scene, bytes.data(), bytes.size(), &length,
                              e, sizeof e), e);
        mt_scene_header_v4 header;
        std::memcpy(&header, bytes.data(), sizeof header);
        header.width = rw;
        header.height = rh;
        header.quality_flags = MT_QUALITY_DISPERSION; // Default render, bevel off.
        std::memcpy(bytes.data(), &header, sizeof header);
        std::memcpy(bytes.data() + header.camera_offset * 4, &camera,
                    sizeof camera);
        std::ofstream capture(path, std::ios::binary);
        capture.write(reinterpret_cast<char const *>(bytes.data()), bytes.size());
        if (!capture)
          throw std::runtime_error("Could not write diagnostic scene capture");
      }
      Check(mt_engine_set_camera(param->engine, &camera, e, sizeof e), e);
      auto begin = Clock::now();
      Check(mt_engine_update(param->engine, nullptr, e, sizeof e), e);
      param->updateMs += Milliseconds(begin);
    }
    if (!param->render || width != rw || height != rh ||
        settings != lastSettings || bindings != nextBindings) {
      mt_render_options options;
      mt_render_options_default(&options);
      options.width = rw;
      options.height = rh;
      options.max_samples = std::clamp(
          Setting(delegate, "convergedSamplesPerPixel", 64), 1, 16384);
      options.bounces = std::clamp(Setting(delegate, "maxBounces", 3), 1, 20);
      options.aovs = 0;
      for (auto const &a : nextBindings) {
        if (a.aovName == HdAovTokens->depth)
          options.aovs |= MT_AOV_CENTER_DEPTH;
        if (a.aovName == HdAovTokens->Peye)
          options.aovs |= MT_AOV_CENTER_POSITION;
        if (a.aovName == HdAovTokens->normal || a.aovName == HdAovTokens->Neye)
          options.aovs |= MT_AOV_CENTER_NORMAL;
      }
      for (auto const &a : nextBindings)
        if (a.aovName == HdAovTokens->primId ||
            a.aovName == HdAovTokens->instanceId ||
            a.aovName == HdAovTokens->elementId)
          options.aovs |= MT_AOV_ID;
      options.batch_samples = 0;
      options.bevel = 0;
      if (!param->render) {
        mt_render r;
        Check(mt_render_create(param->engine, &options, &r, e, sizeof e), e);
        param->render = r;
      } else
        Check(mt_render_set_options(param->render, &options, e, sizeof e), e);
      width = rw;
      height = rh;
      lastSettings = settings;
      lastSamples = UINT32_MAX;
    }
    if (param->gpu && bindings != nextBindings)
      param->gpu->Invalidate();
    if (changed || cameraChanged || bindings != nextBindings) {
      converged = false;
      lastSamples = UINT32_MAX;
      bindings = nextBindings;
    }
    Buffer *colorBuffer = nullptr, *depthBuffer = nullptr;
    for (auto const &a : bindings) {
      if (a.aovName == HdAovTokens->color)
        colorBuffer = dynamic_cast<Buffer *>(a.renderBuffer);
      if (a.aovName == HdAovTokens->depth)
        depthBuffer = dynamic_cast<Buffer *>(a.renderBuffer);
    }
    bool gpuBindings = colorBuffer &&
                       (colorBuffer->GetFormat() == HdFormatFloat32Vec4 ||
                        colorBuffer->GetFormat() == HdFormatFloat16Vec4) &&
                       (!depthBuffer ||
                        (depthBuffer->GetFormat() == HdFormatFloat32 &&
                         colorBuffer->GetWidth() == depthBuffer->GetWidth() &&
                         colorBuffer->GetHeight() == depthBuffer->GetHeight()));
    std::string cpuAovs;
    for (auto const &a : bindings)
      if (a.aovName == HdAovTokens->normal || a.aovName == HdAovTokens->Neye ||
          a.aovName == HdAovTokens->Peye) {
        if (!cpuAovs.empty()) cpuAovs += ", ";
        cpuAovs += a.aovName.GetString();
      }
    bool gpuOutput = param->gpu && !param->forceCpu && gpuBindings && cpuAovs.empty();
    if (param->gpu && !param->forceCpu && !cpuAovs.empty())
      Warn("CPU output: requested AOVs require CPU readback: " + cpuAovs);
    if (!gpuOutput) {
      if (output->color) {
        if (param->gpu)
          param->gpu->Invalidate();
        output->Clear();
        lastSamples = UINT32_MAX;
      }
    }
    if (gpuOutput) {
      GfVec4f clear(0);
      for (auto const &a : bindings)
        if (a.aovName == HdAovTokens->color &&
            a.clearValue.IsHolding<GfVec4f>())
          clear = a.clearValue.Get<GfVec4f>();
      try {
        param->gpu->Prepare(width, height, w, h, colorBuffer->GetFormat(),
                            clear, output);
      } catch (std::exception const &error) {
        Warn(std::string("CPU output: Hgi conversion setup failed: ") +
             error.what());
        param->gpu.reset();
        output->Clear();
        gpuOutput = false;
      }
    }
    param->usingGpuOutput = gpuOutput;
    if (param->forceCpu)
      Warn("CPU output: forced by forceCpuOutput");
    if (param->gpu && !param->forceCpu && !gpuBindings)
      Warn("CPU output: compatible color and optional same-size depth AOVs are required");
    for (auto const &a : bindings)
      if (auto b = dynamic_cast<Buffer *>(a.renderBuffer)) {
        b->converged = false;
        b->role = a.aovName;
        b->output = output;
        b->readOnMap = {};
        if (gpuOutput) {
          // Map is a synchronous, on-demand SDK read. Weak ownership lets Hydra
          // destroy buffers after the pass/delegate without a dangling
          // callback.
          std::weak_ptr<Param> weak = param;
          auto pw = width, ph = height;
          auto proj = projection;
          auto v = view;
          b->readOnMap = [weak, a, pw, ph, scale, v, proj] {
            if (auto p = weak.lock()) {
              std::lock_guard<std::mutex> lock(p->mutex);
              mt_render_snapshot info{};
              info.struct_size = sizeof info;
              char error[2048] = {};
              Check(mt_render_info(p->render, &info, error, sizeof error),
                    error);
              if (!info.samples)
                return;
              ReadBuffers(p.get(), {a}, pw, ph, scale, v, proj);
            }
          };
        }
      }
    auto refine = Clock::now();
    Check(mt_render_refine_until(param->render, 8, nullptr, e, sizeof e), e);
    double refineMs = Milliseconds(refine);
    mt_render_snapshot info{};
    info.struct_size = sizeof info;
    Check(mt_render_info(param->render, &info, e, sizeof e), e);
    param->actualBackend = info.backend;
    if (info.status == MT_RENDER_ERROR)
      throw std::runtime_error(param->sdkError.empty() ? info.message
                                                       : param->sdkError);
    double readMs = 0;
    int fps = std::clamp(Setting(delegate, "displayRefreshRate", 30), 0, 1000);
    bool ready = info.samples > 0 && info.samples != lastSamples &&
                 (info.converged || lastSamples == UINT32_MAX || fps == 0 ||
                  Milliseconds(lastRead) >= 1000. / fps);
    if (ready) {
      auto start = Clock::now();
      param->readHdrMs = param->readDepthMs = param->readIdMs = 0;
      if (gpuOutput) {
        GfVec4f clear(0);
        for (auto const &a : bindings)
          if (a.aovName == HdAovTokens->color) {
            if (a.clearValue.IsHolding<GfVec4f>())
              clear = a.clearValue.Get<GfVec4f>();
            else if (a.clearValue.IsHolding<GfVec4d>())
              clear = GfVec4f(a.clearValue.Get<GfVec4d>());
          }
        if (!param->gpu->Publish(param->render, width, height, w, h,
                                 colorBuffer->GetFormat(), scale, clear,
                                 projection, depthBuffer != nullptr, output, param->exportMs,
                                 param->convertMs)) {
          ready = false;
          ++param->skippedExports;
        }
      } else {
        ReadBuffers(param.get(), bindings, width, height, scale, view, projection);
      }
      if (ready) {
        lastSamples = info.samples;
        lastRead = Clock::now();
        readMs = Milliseconds(start);
      }
    }
    converged = info.converged && lastSamples == info.samples;
    for (auto const &a : bindings)
      if (auto b = dynamic_cast<Buffer *>(a.renderBuffer))
        b->converged = converged;
    param->Record(info.last_commit, info.samples, refineMs, readMs);
  } catch (std::exception const &error) {
    TF_RUNTIME_ERROR("hdMuTracer: %s", error.what());
    converged = true;
    for (auto const &a : state->GetAovBindings())
      if (auto b = dynamic_cast<Buffer *>(a.renderBuffer))
        b->converged = true;
  }
}
Delegate::Delegate(HdRenderSettingsMap const &settings)
    : HdRenderDelegate(settings), param(std::make_shared<Param>()),
      registry(std::make_shared<HdResourceRegistry>()) {
  _PopulateDefaultSettings(GetRenderSettingDescriptors());
  for (auto const &setting : settings)
    SetRenderSetting(setting.first, setting.second);
}
void Delegate::SetRenderSetting(TfToken const &key, VtValue const &value) {
  // Blender's Python bridge authors PyLong as C++ long, while the descriptors
  // and render pass use int. Normalize only the delegate's integer options.
  for (auto const &descriptor : GetRenderSettingDescriptors()) {
    if (descriptor.key != key || !descriptor.defaultValue.IsHolding<int>())
      continue;
    auto setInteger = [&](long long v) {
      HdRenderDelegate::SetRenderSetting(
          key, VtValue(int(std::clamp(v, (long long)std::numeric_limits<int>::min(),
                                    (long long)std::numeric_limits<int>::max()))));
    };
    if (value.IsHolding<long>()) {
      setInteger(value.Get<long>());
      return;
    }
    if (value.IsHolding<long long>()) {
      setInteger(value.Get<long long>());
      return;
    }
    if (value.IsHolding<bool>()) {
      setInteger(value.Get<bool>());
      return;
    }
    break;
  }
  HdRenderDelegate::SetRenderSetting(key, value);
}
void Delegate::SetDrivers(HdDriverVector const &drivers) {
  std::lock_guard<std::mutex> lock(param->mutex);
  for (auto driver : drivers)
    if (driver && driver->name == HgiTokens->renderDriver &&
        driver->driver.IsHolding<Hgi *>())
      param->hgi = driver->driver.Get<Hgi *>();
}
TfTokenVector const &Delegate::GetSupportedRprimTypes() const {
  static TfTokenVector t = {HdPrimTypeTokens->mesh};
  return t;
}
TfTokenVector const &Delegate::GetSupportedSprimTypes() const {
  static TfTokenVector t = {
      HdPrimTypeTokens->camera,       HdPrimTypeTokens->material,
      HdPrimTypeTokens->rectLight,    HdPrimTypeTokens->sphereLight,
      HdPrimTypeTokens->distantLight, HdPrimTypeTokens->domeLight,
      HdPrimTypeTokens->diskLight,    HdPrimTypeTokens->cylinderLight};
  return t;
}
TfTokenVector const &Delegate::GetSupportedBprimTypes() const {
  static TfTokenVector t = {HdPrimTypeTokens->renderBuffer};
  return t;
}
HdRenderPassSharedPtr Delegate::CreateRenderPass(HdRenderIndex *i,
                                                 HdRprimCollection const &c) {
  return std::make_shared<Pass>(i, c, param);
}
HdInstancer *Delegate::CreateInstancer(HdSceneDelegate *d, SdfPath const &id) {
  return new Instancer(d, id);
}
HdRprim *Delegate::CreateRprim(TfToken const &, SdfPath const &id) {
  return new Mesh(id);
}
HdSprim *Delegate::CreateSprim(TfToken const &t, SdfPath const &id) {
  if (t == HdPrimTypeTokens->camera)
    return new Camera(id);
  if (t == HdPrimTypeTokens->material)
    return new Material(id);
  return new Light(id, t);
}
TfToken Delegate::GetMaterialBindingPurpose() const { return HdTokens->full; }
TfTokenVector Delegate::GetMaterialRenderContexts() const {
  return {TfToken("mtlx"), TfToken()};
}
HdRenderSettingDescriptorList Delegate::GetRenderSettingDescriptors() const {
  return {{"Samples", TfToken("convergedSamplesPerPixel"), VtValue(64)},
          {"Bounces", TfToken("maxBounces"), VtValue(3)},
          {"Backend (0 software, 1 HWRT)", TfToken("backend"), VtValue(1)},
          {"Resolution scale", TfToken("resolutionScale"), VtValue(1.f)},
          {"Display refresh rate", TfToken("displayRefreshRate"), VtValue(30)},
          {"Force CPU output", TfToken("forceCpuOutput"), VtValue(0)}};
}
HdAovDescriptor Delegate::GetDefaultAovDescriptor(TfToken const &t) const {
  if (t == HdAovTokens->color)
    return {HdFormatFloat32Vec4, true, VtValue(GfVec4f(0))};
  if (t == HdAovTokens->depth)
    return {HdFormatFloat32, false, VtValue(1.f)};
  if (t == HdAovTokens->normal || t == HdAovTokens->Neye || t == HdAovTokens->Peye)
    return {HdFormatFloat32Vec3, false, VtValue(GfVec3f(0))};
  if (t == HdAovTokens->primId || t == HdAovTokens->instanceId ||
      t == HdAovTokens->elementId)
    return {HdFormatInt32, false, VtValue(-1)};
  return {};
}
} // namespace mtHydra
class HdMuTracerRendererPlugin final : public HdRendererPlugin {
public:
  HdRenderDelegate *CreateRenderDelegate() override {
    return new mtHydra::Delegate;
  }
  HdRenderDelegate *
  CreateRenderDelegate(HdRenderSettingsMap const &s) override {
    return new mtHydra::Delegate(s);
  }
  void DeleteRenderDelegate(HdRenderDelegate *d) override { delete d; }
  bool IsSupported(HdRendererCreateArgs const &, std::string *) const override {
    return true;
  }
};
TF_REGISTRY_FUNCTION(TfType) {
  HdRendererPluginRegistry::Define<HdMuTracerRendererPlugin>();
}
PXR_NAMESPACE_CLOSE_SCOPE
