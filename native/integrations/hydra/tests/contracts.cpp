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
  auto udim = ReadTexture(std::string(MT_TEST_SOURCE_DIR) +
                              "/checker.<UDIM>.png",
                          true);
  Require(udim.desc.tile_count == 2 && udim.desc.width == 0 &&
              udim.desc.height == 0 && udim.tiles[0].udim == 1001 &&
              udim.tiles[0].width == 2 && udim.tiles[0].height == 2 &&
              udim.tiles[1].udim == 1002 && udim.tiles[1].width == 1 &&
              udim.tiles[1].height == 1,
          "USD UDIM resolution loads existing Hio tiles at their native sizes");
  Require(!TextureReferenceKey(std::string(MT_TEST_SOURCE_DIR) +
                               "/checker.<UDIM>.png")
               .empty() &&
              !TextureAssetVersion(std::string(MT_TEST_SOURCE_DIR) +
                                  "/checker.<UDIM>.png")
                   .empty(),
          "tile set path and resolver timestamps are available for dirty checks");
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
  node.parameters.clear();
  node.inputConnections.clear();
  node.nodeTypeId = TfToken("ND_standard_surface_surfaceshader");
  node.parameters[TfToken("base")] = VtValue(.7f);
  node.parameters[TfToken("base_color")] = VtValue(GfVec3f(.8f, .4f, .2f));
  node.parameters[TfToken("coat")] = VtValue(.5f);
  node.parameters[TfToken("coat_color")] = VtValue(GfVec3f(.5f, 1, .5f));
  node.parameters[TfToken("metalness")] = VtValue(.25f);
  node.parameters[TfToken("sheen_roughness")] = VtValue(.25f);
  node.parameters[TfToken("thin_film_thickness")] = VtValue(500.f);
  values = ConvertMaterial(network);
  Require(Find(values, MT_MAT_BASE_WEIGHT).value[0] == .7f,
          "Standard Surface base weight");
  Require(Find(values, MT_MAT_BASE_COLOR).value == GfVec3f(.6f, .4f, .15f),
          "official coat attenuation translation");
  Require(Find(values, MT_MAT_SPECULAR_WEIGHT).value[0] == 1 &&
              Find(values, MT_MAT_COAT_WEIGHT).value[0] == 0,
          "official metallic specular and coat translation");
  Require(std::abs(Find(values, MT_MAT_FUZZ_ROUGHNESS).value[0] -
                       std::pow(.25f, .4f)) < 1e-6f,
          "official sheen roughness translation");
  Require(Find(values, MT_MAT_THIN_FILM_WEIGHT).value[0] == 1 &&
              Find(values, MT_MAT_THIN_FILM_THICKNESS).value[0] == .5f,
          "official nanometer thin-film translation");
  SdfPath add("/Add"), multiply("/Multiply"), convert("/Convert");
  network.nodes[add].nodeTypeId = TfToken("ND_add_color3");
  network.nodes[add].parameters[TfToken("in1")] = VtValue(GfVec3f(.1f));
  network.nodes[add].parameters[TfToken("in2")] = VtValue(GfVec3f(.2f));
  network.nodes[multiply].nodeTypeId = TfToken("ND_multiply_color3");
  network.nodes[multiply].parameters[TfToken("in2")] = VtValue(GfVec3f(2));
  network.nodes[multiply].inputConnections[TfToken("in1")] =
      {{add, TfToken("out")}};
  network.nodes[convert].nodeTypeId = TfToken("ND_convert_color3_vector3");
  network.nodes[convert].inputConnections[TfToken("in")] =
      {{multiply, TfToken("out")}};
  node.inputConnections[TfToken("base_color")] =
      {{convert, TfToken("out")}};
  node.parameters[TfToken("coat")] = VtValue(0.f);
  values = ConvertMaterial(network);
  Require(Find(values, MT_MAT_BASE_COLOR).value == GfVec3f(.6f),
          "connected convert and math nodes fold to a constant");
  std::vector<std::string> warnings;
  SdfPath noise("/Noise");
  network.nodes[noise].nodeTypeId = TfToken("ND_noise3d_color3");
  node.inputConnections[TfToken("base_color")] = {{noise, TfToken("out")}};
  node.parameters[TfToken("base_color")] = VtValue(GfVec3f(.25f));
  values = ConvertMaterial(network, &warnings);
  Require(Find(values, MT_MAT_BASE_COLOR).value == GfVec3f(.25f) &&
              !warnings.empty() &&
              warnings.back().find("base_color") != std::string::npos,
          "procedural graph warns and uses the authored fallback");

  auto noTexture = [](std::string const &, bool, uint32_t,
                      uint32_t) -> mt_scene_texture_id { return 0; };
  HdMaterialNetwork2 graphNetwork;
  graphNetwork.terminals[HdMaterialTerminalTokens->surface] = {
      SdfPath("/Material/Surface"), TfToken("out")};
  graphNetwork.nodes[SdfPath("/Material/Surface")].nodeTypeId =
      TfToken("ND_open_pbr_surface_surfaceshader");
  graphNetwork.nodes[SdfPath("/Material/Surface")]
      .inputConnections[TfToken("base_color")] = {
      {SdfPath("/Material/Noise"), TfToken("out")}};
  graphNetwork.nodes[SdfPath("/Material/Noise")].nodeTypeId =
      TfToken("ND_noise3d_color3");
  auto graph = BuildMaterialGraph(graphNetwork, noTexture);
  Require(graph.warnings.empty() && graph.nodes.size() == 1 &&
              graph.terminals.size() == 1,
          "varying noise reaches canonical graph without approximation");
  Require(graph.nodes[0].category == MT_GRAPH_CATEGORY_NOISE3D &&
              graph.nodes[0].port_type == MT_GRAPH_PORT_TYPE_COLOR3,
          "typed category maps to shared IDs");
  Require(graph.authorIds[0] == "/Material/Noise",
          "USD author paths survive normalization");
  Require(std::any_of(graph.inputs.begin(), graph.inputs.end(),
                      [](auto const &p) {
                        return p.source_kind == MT_GRAPH_SOURCE_GEOMETRY &&
                               p.source == MT_GRAPH_GEOMETRY_OBJECT_POSITION;
                      }),
          "implicit noise position uses the shared geometry default");
  graphNetwork.nodes[SdfPath("/Material/Surface")].nodeTypeId =
      TfToken("ND_standard_surface_surfaceshader");
  graph = BuildMaterialGraph(graphNetwork, noTexture);
  Require(!graph.nodes.empty(),
          "official Standard Surface translation expands into the graph");
  Require(std::find(graph.authorIds.begin(), graph.authorIds.end(),
                    "/Material/Noise") != graph.authorIds.end(),
          "translation retains the original upstream path");
  auto uniformNetwork = graphNetwork;
  uniformNetwork.nodes[SdfPath("/Material/Surface")].inputConnections.clear();
  auto uniformGraph = BuildMaterialGraph(uniformNetwork, noTexture);
  Require(uniformGraph.nodes.empty() && uniformGraph.terminals.empty() &&
              !uniformGraph.values.empty(),
          "uniform translation folds to constants without unreachable nodes");
  auto invalidNetwork = graphNetwork;
  invalidNetwork.nodes[SdfPath("/Material/Surface")].nodeTypeId =
      TfToken("ND_open_pbr_surface_surfaceshader");
  invalidNetwork.nodes[SdfPath("/Material/Surface")]
      .parameters[TfToken("unsupported_surface_input")] = VtValue(.5f);
  auto invalidGraph = BuildMaterialGraph(invalidNetwork, noTexture);
  Require(!invalidGraph.warnings.empty() &&
              std::any_of(invalidGraph.terminals.begin(),
                          invalidGraph.terminals.end(),
                          [](auto const &t) { return t.port == UINT32_MAX; }),
          "nonzero unsupported literals preserve whole-graph fallback");
  invalidNetwork.nodes[SdfPath("/Material/Surface")].parameters.clear();
  invalidNetwork.nodes[SdfPath("/Material/Noise")].nodeTypeId =
      TfToken("ND_add_color3");
  invalidNetwork.nodes[SdfPath("/Material/Noise")]
      .inputConnections[TfToken("in1")] = {
      {SdfPath("/Material/Noise"), TfToken("out")}};
  invalidGraph = BuildMaterialGraph(invalidNetwork, noTexture);
  Require(std::any_of(invalidGraph.warnings.begin(),
                      invalidGraph.warnings.end(),
                      [](auto const &w) {
                        return w.find("cycle") != std::string::npos;
                      }),
          "cycles remain diagnosed after reachability pruning");
  HdMaterialNetwork2 gltfNetwork;
  gltfNetwork.terminals[HdMaterialTerminalTokens->surface] = {
      SdfPath("/Material/Surface"), TfToken("out")};
  gltfNetwork.nodes[SdfPath("/Material/Surface")].nodeTypeId =
      TfToken("ND_open_pbr_surface_surfaceshader");
  gltfNetwork.nodes[SdfPath("/Material/Surface")]
      .inputConnections[TfToken("base_color")] = {
      {SdfPath("/Material/Image"), TfToken("outcolor")}};
  gltfNetwork.nodes[SdfPath("/Material/Image")].nodeTypeId =
      TfToken("ND_gltf_colorimage");
  auto gltfGraph = BuildMaterialGraph(gltfNetwork, noTexture);
  Require(gltfGraph.warnings.empty() && gltfGraph.nodes.size() == 1 &&
              gltfGraph.nodes[0].category ==
                  MT_GRAPH_CATEGORY_GLTF_COLORIMAGE &&
              gltfGraph.nodes[0].port_type == MT_GRAPH_PORT_TYPE_COLOR4 &&
              gltfGraph.terminals[0].output == MT_GRAPH_OUTPUT_OUTCOLOR,
          "unsuffixed glTF multioutput nodedef retains typed color output");
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
