// Copyright 2026 MuTracer contributors.
// Hydra class shells and instancer composition adapted from OpenUSD v26.03
// pxr/imaging/plugin/hdEmbree (Copyright 2016-2019 Pixar), rewritten for the
// MuTracer C SDK, queued Sync and CPU AOV resolve. Applicable TOST 1.0 license:
// ../../../LICENSES/OpenUSD-TOST.txt. No Embree rendering code is included.
#pragma once
#include "mutracer-material-properties.h"
#include "mutracer-scene-api.h"
#include "pxr/base/gf/matrix4d.h"
#include "pxr/base/vt/array.h"
#include "pxr/imaging/hd/camera.h"
#include "pxr/imaging/hd/instancer.h"
#include "pxr/imaging/hd/light.h"
#include "pxr/imaging/hd/material.h"
#include "pxr/imaging/hd/mesh.h"
#include "pxr/imaging/hd/meshTopology.h"
#include "pxr/imaging/hd/renderBuffer.h"
#include "pxr/imaging/hd/renderDelegate.h"
#include "pxr/imaging/hd/renderPass.h"
#include "pxr/imaging/hgi/texture.h"
#include "pxr/pxr.h"
#include <atomic>
#include <chrono>
#include <fstream>
#include <functional>
#include <map>
#include <mutex>
#include <set>
#include <stdexcept>
#include <vector>

PXR_NAMESPACE_OPEN_SCOPE
namespace mtHydra {
class GpuOutput;
using Clock = std::chrono::steady_clock;
double Milliseconds(Clock::time_point start);
void Check(int32_t status, char const *error);
void Matrix(GfMatrix4d const &m, float *out);
void Warn(std::string const &message);
// Illuminance of a UsdLux distant light on a surface facing it. Without
// normalization, intensity is the radiance of a disk of `angleDegrees`.
float DistantLightIrradiance(float intensity, float angleDegrees,
                             bool normalize);
struct Primvar {
  VtValue value;
  HdInterpolation interpolation = HdInterpolationConstant;
};
struct Geometry {
  std::vector<float> points, normals, uv, colors;
  std::vector<uint32_t> indices;
  std::vector<int> faces;
};
Geometry Triangulate(HdMeshTopology const &, SdfPath const &,
                     VtVec3fArray const &, Primvar const &, Primvar const &,
                     Primvar const &);
struct MeshData {
  HdMeshTopology topology;
  VtVec3fArray points;
  Primvar normals, uv, colors;
  GfMatrix4d matrix{1};
  SdfPath material, instancer;
  int primId = -1;
  bool visible = true, doubleSided = false;
  HdDirtyBits dirty = 0;
};
struct InstanceData {
  SdfPath parent;
  GfMatrix4d matrix{1};
  std::map<SdfPath, VtIntArray> indices;
  std::map<TfToken, VtValue> attributes;
  bool visible = true;
};
struct Instance {
  GfMatrix4d matrix{1};
  int index = -1;
  std::vector<int> path;
};
std::vector<Instance> Flatten(std::map<SdfPath, InstanceData> const &,
                              SdfPath const &, SdfPath const &, bool includeHidden = false);
struct LightData {
  TfToken type;
  GfMatrix4d matrix{1};
  std::map<TfToken, VtValue> values;
  bool visible = true;
};
struct Property {
  std::string name;
  uint32_t id;
  int size;
  GfVec3f value;
  bool boolean = false;
};
std::vector<Property> OpenPbrDefaults();
std::vector<Property> ConvertMaterial(HdMaterialNetwork2 const &,
                                      std::vector<std::string> *warnings = nullptr);
struct TextureData {
  mt_scene_texture_desc desc{};
  std::vector<uint8_t> bytes;
  std::vector<float> floats;
};
TextureData ReadTexture(std::string const &file, bool srgb);
struct MeshResource {
  mt_scene_geometry_id geometry = 0;
  mt_scene_mesh_id mesh = 0;
  Geometry source;
  std::vector<int> faces;
  std::vector<Instance> instances;
  int primId = -1;
};
struct Identity {
  int primId;
  std::vector<int> faces;
  std::vector<Instance> instances;
};
class Param final : public HdRenderParam {
public:
  mutable std::mutex mutex;
  std::map<SdfPath, MeshData> meshes;
  std::map<SdfPath, HdMaterialNetwork2> materials;
  std::map<SdfPath, InstanceData> instancers;
  std::map<SdfPath, LightData> lights;
  std::set<SdfPath> changedMeshes, removedMeshes, changedMaterials,
      changedLights, removedLights;
  bool instancesDirty = false;
  bool cameraDirty = false;
  std::vector<std::pair<SdfPath, HdDirtyBits>> events;
  mt_engine engine = 0;
  std::atomic<mt_render> render{0};
  std::atomic<bool> stopped{false};
  mt_scene scene = 0;
  std::map<SdfPath, MeshResource> resources;
  std::map<std::pair<SdfPath, bool>, mt_scene_material_id> materialHandles;
  std::map<SdfPath, mt_scene_light_id> lightHandles;
  std::map<std::string, mt_scene_texture_id> textureHandles;
  std::map<uint32_t, Identity> identities;
  std::string sdkError;
  int backend = -1;
  uint32_t actualBackend = 0;
  Hgi *hgi = nullptr;
  bool forceCpu = false;
  bool usingGpuOutput = false;
  uint64_t skippedExports = 0;
  std::unique_ptr<GpuOutput> gpu;
  uint32_t predicted = 0;
  double submitMs = 0, updateMs = 0;
  double readHdrMs = 0, readDepthMs = 0, readIdMs = 0;
  double exportMs = 0, convertMs = 0;
  std::ofstream trace;
  Param();
  ~Param() override;
  void Cancel();
  bool Apply(int requestedBackend);
  void ApplyMaterial(SdfPath const &, bool, mt_scene_material_id);
  void ApplyLight(SdfPath const &, LightData const &);
  void Record(uint32_t actual, uint32_t samples, double refineMs,
              double readMs);
};
// All AOVs select one backend together. GPU installation must supply BOTH Hgi
// color/depth handles after ordering their producer before host consumers.
struct OutputResources {
  HgiTextureHandle color, depth;
  // The caller owns these host-Hgi textures and must finish the SDK/host
  // GPU queue handoff before installation, retaining them until Clear().
  void Install(HgiTextureHandle c, HgiTextureHandle d) {
    if (!c || !d)
      throw std::invalid_argument(
          "color and depth GPU resources must be installed together");
    color = c;
    depth = d;
  }
  void Clear() {
    color = HgiTextureHandle();
    depth = HgiTextureHandle();
  }
};
class Buffer final : public HdRenderBuffer {
public:
  explicit Buffer(SdfPath const &id) : HdRenderBuffer(id) {}
  bool Allocate(GfVec3i const &, HdFormat, bool) override;
  unsigned GetWidth() const override { return width; }
  unsigned GetHeight() const override { return height; }
  unsigned GetDepth() const override { return 1; }
  HdFormat GetFormat() const override { return format; }
  bool IsMultiSampled() const override { return multisampled; }
  void *Map() override {
    if (!mappers && readOnMap)
      readOnMap();
    ++mappers;
    return pixels.data();
  }
  void Unmap() override { --mappers; }
  bool IsMapped() const override { return mappers != 0; }
  bool IsConverged() const override { return converged; }
  void Resolve() override {}
  VtValue GetResource(bool) const override {
    if (!output || !output->color || !output->depth)
      return VtValue();
    if (role == TfToken("color"))
      return VtValue(output->color);
    if (role == TfToken("depth"))
      return VtValue(output->depth);
    return VtValue();
  }
  TfToken role;
  std::shared_ptr<OutputResources> output;
  std::vector<uint8_t> pixels;
  std::function<void()> readOnMap;
  std::atomic<bool> converged{false};

private:
  void _Deallocate() override {
    pixels.clear();
    readOnMap = {};
    output.reset();
    width = height = 0;
  }
  unsigned width = 0, height = 0;
  HdFormat format = HdFormatInvalid;
  bool multisampled = false;
  std::atomic<int> mappers{0};
};
class Delegate final : public HdRenderDelegate {
public:
  explicit Delegate(HdRenderSettingsMap const & = {});
  HdRenderParam *GetRenderParam() const override { return param.get(); }
  TfTokenVector const &GetSupportedRprimTypes() const override;
  TfTokenVector const &GetSupportedSprimTypes() const override;
  TfTokenVector const &GetSupportedBprimTypes() const override;
  HdResourceRegistrySharedPtr GetResourceRegistry() const override {
    return registry;
  }
  HdRenderPassSharedPtr CreateRenderPass(HdRenderIndex *,
                                         HdRprimCollection const &) override;
  HdInstancer *CreateInstancer(HdSceneDelegate *, SdfPath const &) override;
  void DestroyInstancer(HdInstancer *p) override { delete p; }
  HdRprim *CreateRprim(TfToken const &, SdfPath const &) override;
  void DestroyRprim(HdRprim *p) override { delete p; }
  HdSprim *CreateSprim(TfToken const &, SdfPath const &) override;
  HdSprim *CreateFallbackSprim(TfToken const &t) override {
    return CreateSprim(t, SdfPath());
  }
  void DestroySprim(HdSprim *p) override { delete p; }
  HdBprim *CreateBprim(TfToken const &, SdfPath const &id) override {
    return new Buffer(id);
  }
  HdBprim *CreateFallbackBprim(TfToken const &t) override {
    return CreateBprim(t, SdfPath());
  }
  void DestroyBprim(HdBprim *p) override { delete p; }
  void CommitResources(HdChangeTracker *) override {}
  TfToken GetMaterialBindingPurpose() const override;
  TfTokenVector GetMaterialRenderContexts() const override;
  HdRenderSettingDescriptorList GetRenderSettingDescriptors() const override;
  void SetDrivers(HdDriverVector const &) override;
  HdAovDescriptor GetDefaultAovDescriptor(TfToken const &) const override;
  bool IsStopSupported() const override { return true; }
  bool IsStopped() const override { return param->stopped.load(); }
  bool Stop(bool) override {
    param->stopped = true;
    param->Cancel();
    return true;
  }
  bool Restart() override {
    param->stopped = false;
    return true;
  }
  std::shared_ptr<Param> param;

private:
  HdResourceRegistrySharedPtr registry;
};
} // namespace mtHydra
PXR_NAMESPACE_CLOSE_SCOPE
