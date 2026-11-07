// Copyright 2026 MuTracer contributors. SPDX-License-Identifier: MIT
#include "bridge.h"
#include "pxr/imaging/hd/tokens.h"
#include <cmath>
#include <iostream>
#include <stdexcept>
PXR_NAMESPACE_USING_DIRECTIVE
using namespace mtHydra;
static void Require(bool b, char const *message) {
  if (!b)
    throw std::runtime_error(message);
}
static Property Find(std::vector<Property> const &values, uint32_t id) {
  for (auto const &p : values)
    if (p.id == id)
      return p;
  throw std::runtime_error("missing property");
}
int main() {
  auto texture =
      ReadTexture(std::string(MT_TEST_SOURCE_DIR) + "/checker.png", true);
  Require(texture.desc.width == 2 && texture.desc.height == 2 &&
              texture.bytes.size() == 16,
          "Hio RGB to RGBA8 conversion");
  Require(texture.bytes[0] == 255 && texture.bytes[3] == 255,
          "Hio preserves source channels and adds opaque alpha");
  auto linear =
      ReadTexture(std::string(MT_TEST_SOURCE_DIR) + "/checker.png", false);
  Require(linear.floats.size() == 16 && linear.floats[0] == 1 &&
              linear.floats[3] == 1,
          "Hio raw to RGBA32F conversion");
  // Hydra's default camera light: 15000 over 0.53 degrees is about unit lux.
  Require(std::abs(DistantLightIrradiance(15000, .53f, false) - 1.0081f) < 1e-4f,
          "distant radiance integrates over the angular disk");
  Require(DistantLightIrradiance(2, .53f, true) == 2 &&
              DistantLightIrradiance(2, 0, false) == 2,
          "normalized and zero-angle distant intensity is illuminance");
  Require(std::abs(DistantLightIrradiance(1, 270, false) -
                   float((2 - .5) * M_PI)) < 1e-5f,
          "distant lights wider than a hemisphere");
  Delegate delegate;
  Require(!delegate.IsStopped() && delegate.Stop(false) && delegate.IsStopped(),
          "Hydra stop state");
  Require(delegate.Restart() && !delegate.IsStopped(), "Hydra restart state");
  Require(delegate.GetRenderSetting(TfToken("forceCpuOutput")) == VtValue(0),
          "automatic GPU output is the default");
  Buffer buffer(SdfPath("/Buffer"));
  Require(buffer.Allocate(GfVec3i(2, 2, 1), HdFormatFloat32Vec4, false),
          "float color allocation");
  unsigned reads = 0;
  buffer.readOnMap = [&] {
    ++reads;
    buffer.pixels[0] = 42;
  };
  Require(static_cast<uint8_t *>(buffer.Map())[0] == 42,
          "Map invokes lazy readback");
  buffer.Map();
  Require(reads == 1 && buffer.IsMapped(),
          "nested Map reuses pinned CPU pixels");
  Require(!buffer.Allocate(GfVec3i(3, 2, 1), HdFormatFloat32Vec4, false),
          "mapped pixels cannot be resized");
  buffer.Unmap();
  buffer.Unmap();
  buffer.Map();
  buffer.Unmap();
  Require(reads == 2 && !buffer.IsMapped(), "new Map refreshes CPU pixels");
  Require(buffer.Allocate(GfVec3i(3, 2, 1), HdFormatFloat32Vec4, false) &&
              !buffer.readOnMap && !buffer.output,
          "resize invalidates the old readback callback and GPU binding");
  OutputResources output;
  bool rejected = false;
  try {
    output.Install(HgiTextureHandle(), HgiTextureHandle());
  } catch (std::invalid_argument const &) {
    rejected = true;
  }
  Require(rejected, "GPU outputs require paired color and depth handles");
  auto defaults = OpenPbrDefaults();
  Require(defaults.size() == 37, "37 OpenPBR constants");
  HdMaterialNetwork2 network;
  SdfPath root("/Surface");
  network.terminals[HdMaterialTerminalTokens->surface] = {root, TfToken("out")};
  auto &node = network.nodes[root];
  node.nodeTypeId = TfToken("ND_open_pbr_surface_surfaceshader");
  auto values = ConvertMaterial(network);
  Require(Find(values, MT_MAT_BASE_COLOR).value == GfVec3f(.8f),
          "unassigned base color uses nodedef");
  Require(Find(values, MT_MAT_SPECULAR_IOR).value[0] == 1.5f,
          "unassigned IOR uses nodedef");
  Require(Find(values, MT_MAT_COAT_IOR).value[0] == 1.6f, "coat IOR default");
  std::set<uint32_t> ids;
  for (auto const &p : defaults) {
    Require(ids.insert(p.id).second, "unique property IDs");
    node.parameters[TfToken(p.name)] = p.boolean ? VtValue(true)
                                       : p.size == 3
                                           ? VtValue(GfVec3f(.1f, .2f, .3f))
                                           : VtValue(.123f);
  }
  values = ConvertMaterial(network);
  for (auto const &p : defaults)
    Require(Find(values, p.id).value == (p.boolean     ? GfVec3f(1, 0, 0)
                                         : p.size == 3 ? GfVec3f(.1f, .2f, .3f)
                                                       : GfVec3f(.123f, 0, 0)),
            "authored value reaches matching SDK ID");
  node.parameters.clear();
  node.nodeTypeId = TfToken("UsdPreviewSurface");
  node.parameters[TfToken("emissiveColor")] = VtValue(GfVec3f(2, 1, .5f));
  values = ConvertMaterial(network);
  Require(Find(values, MT_MAT_EMISSION_LUMINANCE).value[0] == 1,
          "Preview emission strength");
  Require(Find(values, MT_MAT_EMISSION_COLOR).value == GfVec3f(2, 1, .5f),
          "Preview emission radiance");
  Require(Find(values, MT_MAT_COAT_IOR).value[0] == 1.5f,
          "Preview coat approximation");
  HdMeshTopology topology(TfToken("none"), TfToken("rightHanded"),
                          VtIntArray{4, 3}, VtIntArray{0, 1, 2, 3, 0, 3, 4});
  VtVec3fArray points = {GfVec3f(0, 0, 0), GfVec3f(1, 0, 0), GfVec3f(1, 1, 0),
                         GfVec3f(0, 1, 0), GfVec3f(-1, 1, 0)};
  Primvar uv{
      VtValue(VtVec2fArray{GfVec2f(0), GfVec2f(1, 0), GfVec2f(1), GfVec2f(0, 1),
                           GfVec2f(.2f), GfVec2f(.3f), GfVec2f(.4f)}),
      HdInterpolationFaceVarying};
  auto g = Triangulate(topology, SdfPath("/Mesh"), points, {}, uv, {});
  Require(g.faces == std::vector<int>({0, 0, 1}),
          "triangle IDs map to original polygon");
  Require(g.points.size() == 27, "face corners split");
  Require(std::abs(g.uv[12] - .2f) < 1e-6f, "face-varying seam retained");
  std::map<SdfPath, InstanceData> instances;
  auto &inner = instances[SdfPath("/Inner")];
  auto &outer = instances[SdfPath("/Outer")];
  inner.parent = SdfPath("/Outer");
  inner.indices[SdfPath("/Mesh")] = VtIntArray{1, 3};
  outer.indices[SdfPath("/Inner")] = VtIntArray{2, 5};
  inner.matrix.SetTranslate(GfVec3d(1, 0, 0));
  outer.matrix.SetTranslate(GfVec3d(0, 2, 0));
  auto flat = Flatten(instances, SdfPath("/Inner"), SdfPath("/Mesh"));
  Require(Flatten(instances, SdfPath("/Outer"), SdfPath("/Inner"))[1].index ==
              1,
          "Hydra prototype-local instance index");
  Require(
      Flatten(instances, SdfPath("/Inner"), SdfPath("/Mesh/Child")).size() == 4,
      "native instancer scope matches child mesh prefix");
  Require(flat.size() == 4, "nested instancers Cartesian product");
  Require(flat[2].path == std::vector<int>({5, 1}), "nested identity path");
  Require(flat[2].index == 2, "parent-major flattened Hydra index");
  Require(flat[0].matrix.ExtractTranslation() == GfVec3d(1, 2, 0),
          "nested transforms compose");
  outer.visible = false;
  Require(Flatten(instances, SdfPath("/Inner"), SdfPath("/Mesh")).empty(),
          "hidden nested instancer has no visible instances");
  auto resident = Flatten(instances, SdfPath("/Inner"), SdfPath("/Mesh"), true);
  Require(resident.size() == flat.size() && resident[2].path == flat[2].path &&
              resident[2].matrix == flat[2].matrix,
          "hidden nested instancer retains batch membership and transforms");
  std::cout << "material defaults/37 mappings, PreviewSurface, "
               "triangulation/face-varying, nested identity contracts passed\n";
}
