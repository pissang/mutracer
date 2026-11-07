// Copyright 2026 MuTracer contributors. SPDX-License-Identifier: MIT
#include "bridge.h"
#include "pxr/base/gf/half.h"
#include "pxr/imaging/hd/tokens.h"
#include "pxr/imaging/hio/image.h"
#include "pxr/usd/ar/resolver.h"
#include "pxr/usd/sdf/assetPath.h"
#include "pxr/usd/usdShade/udimUtils.h"
#include <algorithm>
#include <cmath>
#include <filesystem>
#include <iomanip>
#include <sstream>
#include <optional>
#include <stdexcept>
PXR_NAMESPACE_OPEN_SCOPE
namespace mtHydra {
std::vector<Property> OpenPbrDefaults() {
  return {
#include "openPbrDefaults.inc"
  };
}
static GfVec3f Value(VtValue const &v, GfVec3f fallback) {
  if (v.IsHolding<GfVec3f>())
    return v.UncheckedGet<GfVec3f>();
  if (v.IsHolding<GfVec4f>()) {
    auto x = v.UncheckedGet<GfVec4f>();
    return GfVec3f(x[0], x[1], x[2]);
  }
  if (v.IsHolding<float>())
    return GfVec3f(v.UncheckedGet<float>(), 0, 0);
  if (v.IsHolding<double>())
    return GfVec3f(v.UncheckedGet<double>(), 0, 0);
  if (v.IsHolding<int>())
    return GfVec3f(v.UncheckedGet<int>(), 0, 0);
  if (v.IsHolding<bool>())
    return GfVec3f(v.UncheckedGet<bool>() ? 1 : 0, 0, 0);
  return fallback;
}
static VtValue Input(HdMaterialNode2 const &n, std::string const &key) {
  auto i = n.parameters.find(TfToken(key));
  return i == n.parameters.end() ? VtValue() : i->second;
}
static std::string String(VtValue const &v, std::string fallback = "");
static std::optional<GfVec3f>
Constant(HdMaterialNetwork2 const &network, HdMaterialNode2 const &node,
         std::string const &key, std::set<SdfPath> &visiting);
static std::optional<GfVec3f>
Constant(HdMaterialNetwork2 const &network, SdfPath const &path,
         TfToken const &output, std::set<SdfPath> &visiting) {
  auto found = network.nodes.find(path);
  if (found == network.nodes.end() || !visiting.insert(path).second)
    return std::nullopt;
  auto const &node = found->second;
  auto id = node.nodeTypeId.GetString();
  auto in = [&](char const *name, GfVec3f fallback) {
    auto value = Constant(network, node, name, visiting);
    return value.value_or(fallback);
  };
  std::optional<GfVec3f> result;
  if (id.find("ND_convert_") == 0 || id.find("ND_dot_") == 0)
    result = Constant(network, node, "in", visiting);
  else if (id.find("ND_add_") == 0)
    result = in("in1", GfVec3f(0)) + in("in2", GfVec3f(0));
  else if (id.find("ND_subtract_") == 0)
    result = in("in1", GfVec3f(0)) - in("in2", GfVec3f(0));
  else if (id.find("ND_multiply_") == 0)
    result = GfCompMult(in("in1", GfVec3f(0)), in("in2", GfVec3f(1)));
  else if (id.find("ND_divide_") == 0) {
    auto a = in("in1", GfVec3f(0)), b = in("in2", GfVec3f(1));
    result = GfVec3f(b[0] ? a[0] / b[0] : 0, b[1] ? a[1] / b[1] : 0,
                     b[2] ? a[2] / b[2] : 0);
  } else if (id.find("ND_mix_") == 0) {
    auto fg = in("fg", GfVec3f(1)), bg = in("bg", GfVec3f(0));
    float amount = in("mix", GfVec3f(.5f))[0];
    result = bg * (1 - amount) + fg * amount;
  } else if (id.find("ND_clamp_") == 0) {
    auto x = in("in", GfVec3f(0)), lo = in("low", GfVec3f(0)),
         hi = in("high", GfVec3f(1));
    result = GfVec3f(std::clamp(x[0], lo[0], hi[0]),
                     std::clamp(x[1], lo[1], hi[1]),
                     std::clamp(x[2], lo[2], hi[2]));
  } else if (id.find("ND_power_") == 0) {
    auto a = in("in1", GfVec3f(0)), b = in("in2", GfVec3f(1));
    result = GfVec3f(std::pow(a[0], b[0]), std::pow(a[1], b[1]),
                     std::pow(a[2], b[2]));
  } else if (id.find("ND_dotproduct_") == 0) {
    auto a = in("in1", GfVec3f(0)), b = in("in2", GfVec3f(0));
    result = GfVec3f(GfDot(a, b), 0, 0);
  } else if (id.find("ND_extract_") == 0) {
    auto x = in("in", GfVec3f(0));
    int index = int(in("index", GfVec3f(0))[0]);
    result = GfVec3f(x[std::clamp(index, 0, 2)], 0, 0);
  } else if (id.find("ND_ifgreater_") == 0 ||
             id.find("ND_ifequal_") == 0) {
    float a = in("value1", GfVec3f(0))[0], b = in("value2", GfVec3f(0))[0];
    bool chooseFirst = id.find("ND_ifgreater_") == 0 ? a > b : a == b;
    result = in(chooseFirst ? "in1" : "in2", GfVec3f(0));
  }
  visiting.erase(path);
  return result;
}
static std::optional<GfVec3f>
Constant(HdMaterialNetwork2 const &network, HdMaterialNode2 const &node,
         std::string const &key, std::set<SdfPath> &visiting) {
  auto connections = node.inputConnections.find(TfToken(key));
  if (connections != node.inputConnections.end() && !connections->second.empty()) {
    auto const &c = connections->second.front();
    return Constant(network, c.upstreamNode, c.upstreamOutputName, visiting);
  }
  auto value = Input(node, key);
  if (value.IsEmpty())
    return std::nullopt;
  return Value(value, GfVec3f(0));
}
static GfVec3f MaterialInput(HdMaterialNetwork2 const &network,
                             HdMaterialNode2 const &node, char const *key,
                             GfVec3f fallback,
                             std::vector<std::string> *warnings) {
  std::set<SdfPath> visiting;
  auto value = Constant(network, node, key, visiting);
  auto connections = node.inputConnections.find(TfToken(key));
  if (!value && connections != node.inputConnections.end() &&
      !connections->second.empty()) {
    auto message = "connected input " + std::string(key) +
                   " cannot be reduced to a constant; using the authored fallback";
    if (warnings)
      warnings->push_back(message);
    Warn(message);
  }
  return value.value_or(Value(Input(node, key), fallback));
}
static HdMaterialNode2 const *Surface(HdMaterialNetwork2 const &n) {
  auto t = n.terminals.find(HdMaterialTerminalTokens->surface);
  if (t == n.terminals.end())
    return nullptr;
  auto node = n.nodes.find(t->second.upstreamNode);
  return node == n.nodes.end() ? nullptr : &node->second;
}
std::vector<Property> ConvertMaterial(HdMaterialNetwork2 const &network,
                                      std::vector<std::string> *warnings) {
  auto values = OpenPbrDefaults();
  auto node = Surface(network);
  if (!node)
    return values;
  auto set = [&](uint32_t id, GfVec3f value) {
    for (auto &p : values)
      if (p.id == id)
        p.value = value;
  };
  if (node->nodeTypeId == TfToken("ND_open_pbr_surface_surfaceshader")) {
    for (auto &p : values)
      p.value = MaterialInput(network, *node, p.name.c_str(), p.value, warnings);
  } else if (node->nodeTypeId == TfToken("ND_standard_surface_surfaceshader") ||
             node->nodeTypeId == TfToken("standard_surface")) {
    auto get = [&](char const *name, GfVec3f fallback) {
      return MaterialInput(network, *node, name, fallback, warnings);
    };
    auto base = get("base", GfVec3f(.8f))[0];
    auto baseColor = get("base_color", GfVec3f(1));
    auto metalness = get("metalness", GfVec3f(0))[0];
    auto coat = get("coat", GfVec3f(0))[0];
    auto coatColor = get("coat_color", GfVec3f(1));
    set(MT_MAT_BASE_WEIGHT, GfVec3f(base, 0, 0));
    set(MT_MAT_BASE_COLOR,
        GfCompMult(baseColor, GfVec3f(1) * (1 - coat) + coatColor * coat));
    set(MT_MAT_BASE_DIFFUSE_ROUGHNESS,
        get("diffuse_roughness", GfVec3f(0)));
    set(MT_MAT_BASE_METALNESS, GfVec3f(metalness, 0, 0));
    auto specColor = get("specular_color", GfVec3f(1));
    set(MT_MAT_SPECULAR_WEIGHT,
        GfVec3f(metalness > 0 ? 1 : get("specular", GfVec3f(1))[0], 0, 0));
    set(MT_MAT_SPECULAR_COLOR,
        GfDot(specColor, GfVec3f(1)) == 0 ? GfVec3f(1) : specColor);
    set(MT_MAT_SPECULAR_ROUGHNESS,
        get("specular_roughness", GfVec3f(.2f, 0, 0)));
    set(MT_MAT_SPECULAR_IOR, get("specular_IOR", GfVec3f(1.5f, 0, 0)));
    set(MT_MAT_SPECULAR_ANISOTROPY,
        get("specular_anisotropy", GfVec3f(0)));
    struct Direct { char const *source; uint32_t target; GfVec3f fallback; };
    Direct direct[] = {
        {"transmission", MT_MAT_TRANSMISSION_WEIGHT, GfVec3f(0)},
        {"transmission_color", MT_MAT_TRANSMISSION_COLOR, GfVec3f(1)},
        {"transmission_depth", MT_MAT_TRANSMISSION_DEPTH, GfVec3f(0)},
        {"transmission_scatter", MT_MAT_TRANSMISSION_SCATTER, GfVec3f(0)},
        {"transmission_scatter_anisotropy", MT_MAT_TRANSMISSION_SCATTER_ANISOTROPY, GfVec3f(0)},
        {"transmission_dispersion", MT_MAT_TRANSMISSION_DISPERSION_SCALE, GfVec3f(0)},
        {"subsurface", MT_MAT_SUBSURFACE_WEIGHT, GfVec3f(0)},
        {"subsurface_color", MT_MAT_SUBSURFACE_COLOR, GfVec3f(1)},
        {"subsurface_scale", MT_MAT_SUBSURFACE_RADIUS, GfVec3f(1, 0, 0)},
        {"subsurface_radius", MT_MAT_SUBSURFACE_RADIUS_SCALE, GfVec3f(1)},
        {"subsurface_anisotropy", MT_MAT_SUBSURFACE_ANISOTROPY, GfVec3f(0)},
        {"sheen", MT_MAT_FUZZ_WEIGHT, GfVec3f(0)},
        {"sheen_color", MT_MAT_FUZZ_COLOR, GfVec3f(1)},
        {"coat_color", MT_MAT_COAT_COLOR, GfVec3f(1)},
        {"coat_roughness", MT_MAT_COAT_ROUGHNESS, GfVec3f(.1f, 0, 0)},
        {"coat_anisotropy", MT_MAT_COAT_ANISOTROPY, GfVec3f(0)},
        {"coat_IOR", MT_MAT_COAT_IOR, GfVec3f(1.5f, 0, 0)},
        {"coat_affect_roughness", MT_MAT_COAT_DARKENING, GfVec3f(0)},
        {"thin_film_IOR", MT_MAT_THIN_FILM_IOR, GfVec3f(1.5f, 0, 0)},
        {"emission", MT_MAT_EMISSION_LUMINANCE, GfVec3f(0)},
        {"emission_color", MT_MAT_EMISSION_COLOR, GfVec3f(1)},
        {"thin_walled", MT_MAT_THIN_WALLED, GfVec3f(0)}};
    for (auto const &m : direct)
      set(m.target, get(m.source, m.fallback));
    set(MT_MAT_FUZZ_ROUGHNESS,
        GfVec3f(std::pow(get("sheen_roughness", GfVec3f(.3f))[0], .4f), 0, 0));
    set(MT_MAT_COAT_WEIGHT,
        GfVec3f(coat * metalness > 0 ? 0 : coat, 0, 0));
    float thickness = get("thin_film_thickness", GfVec3f(0))[0] * .001f;
    set(MT_MAT_THIN_FILM_WEIGHT, GfVec3f(thickness > 0 ? 1 : 0, 0, 0));
    set(MT_MAT_THIN_FILM_THICKNESS, GfVec3f(thickness, 0, 0));
    auto opacity = get("opacity", GfVec3f(1));
    set(MT_MAT_OPACITY, GfVec3f(opacity[0], 0, 0));
  } else if (node->nodeTypeId == TfToken("UsdPreviewSurface")) {
    struct Mapping {
      char const *name;
      uint32_t id;
      GfVec3f fallback;
    };
    Mapping map[] = {
        {"diffuseColor", MT_MAT_BASE_COLOR, GfVec3f(.18f)},
        {"roughness", MT_MAT_SPECULAR_ROUGHNESS, GfVec3f(.5f, 0, 0)},
        {"metallic", MT_MAT_BASE_METALNESS, GfVec3f(0)},
        {"ior", MT_MAT_SPECULAR_IOR, GfVec3f(1.5f, 0, 0)},
        {"opacity", MT_MAT_OPACITY, GfVec3f(1, 0, 0)},
        {"clearcoat", MT_MAT_COAT_WEIGHT, GfVec3f(0)},
        {"clearcoatRoughness", MT_MAT_COAT_ROUGHNESS, GfVec3f(.01f, 0, 0)},
        {"emissiveColor", MT_MAT_EMISSION_COLOR, GfVec3f(0)}};
    for (auto const &m : map)
      set(m.id, MaterialInput(network, *node, m.name, m.fallback, warnings));
    auto emission = MaterialInput(network, *node, "emissiveColor", GfVec3f(0),
                                  warnings);
    set(MT_MAT_EMISSION_LUMINANCE,
        GfVec3f(emission != GfVec3f(0) ? 1 : 0, 0, 0));
    set(MT_MAT_COAT_IOR, GfVec3f(1.5f, 0, 0));
    set(MT_MAT_COAT_DARKENING, GfVec3f(0));
    if (Value(Input(*node, "useSpecularWorkflow"), GfVec3f(0))[0] != 0) {
      auto f0 = Value(Input(*node, "specularColor"), GfVec3f(.04f));
      float peak = std::max({f0[0], f0[1], f0[2], .0001f});
      float root = std::sqrt(std::min(peak, .999f));
      set(MT_MAT_SPECULAR_IOR, GfVec3f((1 + root) / (1 - root), 0, 0));
      set(MT_MAT_SPECULAR_COLOR, f0 / peak);
      set(MT_MAT_BASE_METALNESS, GfVec3f(0));
      Warn("PreviewSurface specular workflow uses a peak-F0 IOR approximation");
    }
  } else
    Warn("unsupported surface node " + node->nodeTypeId.GetString() +
         "; using OpenPBR defaults");
  return values;
}
static TextureData ReadTextureImage(std::string const &file, bool srgb) {
  auto image = HioImage::OpenForReading(file, 0, 0,
                                        srgb ? HioImage::SRGB : HioImage::Raw);
  if (!image)
    throw std::runtime_error("cannot read texture " + file);
  TextureData data;
  Check(mt_scene_texture_desc_default(&data.desc), "texture defaults");
  data.desc.width = image->GetWidth();
  data.desc.height = image->GetHeight();
  HioImage::StorageSpec storage;
  storage.width = data.desc.width;
  storage.height = data.desc.height;
  storage.flipped = false;
  storage.format = image->GetFormat();
  size_t pixelCount = size_t(storage.width) * storage.height;
  int channels = HioGetComponentCount(storage.format);
  auto type = HioGetHioType(storage.format);
  std::vector<uint8_t> source(pixelCount *
                              HioGetDataSizeOfFormat(storage.format));
  storage.data = source.data();
  if (!image->Read(storage))
    throw std::runtime_error("texture read failed " + file);
  data.desc.storage =
      srgb ? MT_TEXTURE_STORAGE_RGBA8_SRGB : MT_TEXTURE_STORAGE_RGBA32F;
  if (srgb)
    data.bytes.resize(pixelCount * 4);
  else
    data.floats.resize(pixelCount * 4);
  for (size_t i = 0; i < pixelCount; ++i)
    for (int k = 0; k < 4; ++k) {
      int channel = channels <= 2 && k < 3 ? 0 : k;
      if (channels == 2 && k == 3)
        channel = 1;
      float value = k == 3 ? 1.f : 0.f;
      if (channel < channels) {
        size_t index = i * channels + channel;
        if (type == HioTypeUnsignedByte)
          value = source[index] / 255.f;
        else if (type == HioTypeHalfFloat)
          value = float(reinterpret_cast<GfHalf const *>(source.data())[index]);
        else if (type == HioTypeFloat)
          value = reinterpret_cast<float const *>(source.data())[index];
        else if (type == HioTypeUnsignedShort)
          value = reinterpret_cast<uint16_t const *>(source.data())[index] /
                  65535.f;
        else
          throw std::runtime_error("unsupported image component type: " + file);
      }
      if (srgb)
        data.bytes[i * 4 + k] =
            uint8_t(std::round(std::clamp(value, 0.f, 1.f) * 255));
      else
        data.floats[i * 4 + k] = value;
    }
  return data;
}
static std::vector<UsdShadeUdimUtils::ResolvedPathAndTile>
TexturePaths(std::string const &file) {
  if (!UsdShadeUdimUtils::IsUdimIdentifier(file))
    return {{file, ""}};
  auto paths = UsdShadeUdimUtils::ResolveUdimTilePaths(file, {});
  paths.erase(std::remove_if(paths.begin(), paths.end(), [](auto const &entry) {
                try {
                  int tile = std::stoi(entry.second);
                  return tile < 1001 || tile > 1100;
                } catch (...) {
                  return true;
                }
              }),
              paths.end());
  std::sort(paths.begin(), paths.end(), [](auto const &a, auto const &b) {
    return std::stoi(a.second) < std::stoi(b.second);
  });
  paths.erase(std::unique(paths.begin(), paths.end(), [](auto const &a, auto const &b) {
                return a.second == b.second;
              }), paths.end());
  if (paths.empty())
    throw std::runtime_error("no readable UDIM tiles found for " + file);
  return paths;
}
std::string TextureReferenceKey(std::string const &file) {
  std::string result = file;
  for (auto const &[path, tile] : TexturePaths(file))
    result += "|" + tile + "=" + path;
  return result;
}
std::string TextureAssetVersion(std::string const &file) {
  std::ostringstream result;
  result << std::setprecision(17);
  for (auto const &[path, tile] : TexturePaths(file)) {
    auto resolved = ArResolvedPath(path);
    auto timestamp = ArGetResolver().GetModificationTimestamp(path, resolved);
    result << tile << '=' << path << ':';
    if (timestamp.IsValid())
      result << timestamp.GetTime();
    else
      result << "unknown";
    result << ';';
  }
  return result.str();
}
TextureData ReadTexture(std::string const &file, bool srgb) {
  auto paths = TexturePaths(file);
  if (!UsdShadeUdimUtils::IsUdimIdentifier(file))
    return ReadTextureImage(file, srgb);
  TextureData result;
  Check(mt_scene_texture_desc_default(&result.desc), "texture defaults");
  result.tileData.reserve(paths.size());
  result.tiles.reserve(paths.size());
  for (auto const &[path, tile] : paths) {
    auto image = ReadTextureImage(path, srgb);
    TextureData::Tile data;
    data.desc.udim = uint32_t(std::stoi(tile));
    data.desc.storage = image.desc.storage;
    data.desc.width = image.desc.width;
    data.desc.height = image.desc.height;
    data.bytes = std::move(image.bytes);
    data.floats = std::move(image.floats);
    result.tileData.push_back(std::move(data));
  }
  for (auto &tile : result.tileData) {
    tile.desc.pixels = srgb ? static_cast<void *>(tile.bytes.data())
                            : static_cast<void *>(tile.floats.data());
    tile.desc.pixel_bytes = srgb ? tile.bytes.size()
                                 : tile.floats.size() * sizeof(float);
    result.tiles.push_back(tile.desc);
  }
  result.desc.tiles = result.tiles.data();
  result.desc.tile_count = result.tiles.size();
  return result;
}
std::string MaterialAssetVersion(HdMaterialNetwork2 const &network) {
  std::string result;
  for (auto const &[path, node] : network.nodes) {
    auto id = node.nodeTypeId.GetString();
    if (id != "UsdUVTexture" && id.find("ND_image_") != 0)
      continue;
    auto file = String(Input(node, "file"));
    if (!file.empty()) {
      result += path.GetString() + ":";
      try {
        result += TextureAssetVersion(file);
      } catch (...) {
        result += "missing";
      }
      result += '\n';
    }
  }
  return result;
}
static std::string String(VtValue const &v, std::string fallback) {
  if (v.IsHolding<TfToken>())
    return v.UncheckedGet<TfToken>().GetString();
  if (v.IsHolding<std::string>())
    return v.UncheckedGet<std::string>();
  if (v.IsHolding<SdfAssetPath>()) {
    auto a = v.UncheckedGet<SdfAssetPath>();
    return a.GetResolvedPath().empty() ? a.GetAssetPath() : a.GetResolvedPath();
  }
  return fallback;
}
static uint32_t Wrap(std::string const &x) {
  if (x == "clamp")
    return MT_TEXTURE_WRAP_CLAMP_TO_EDGE;
  if (x == "mirror")
    return MT_TEXTURE_WRAP_MIRRORED_REPEAT;
  if (x != "periodic" && x != "repeat" && !x.empty())
    Warn("unsupported texture wrap " + x + "; using repeat");
  return MT_TEXTURE_WRAP_REPEAT;
}
void Param::ApplyMaterial(SdfPath const &path, bool doubleSided,
                          mt_scene_material_id handle) {
  char error[2048] = {};
  auto n = materials.find(path);
  HdMaterialNetwork2 empty;
  auto const &network = n == materials.end() ? empty : n->second;
  for (auto const &p : ConvertMaterial(network)) {
    if (p.boolean)
      Check(mt_scene_material_set_uint(scene, handle, p.id, p.value[0] != 0,
                                       error, sizeof error),
            error);
    else
      Check(mt_scene_material_set_float(scene, handle, p.id, p.value[0],
                                        p.value[1], p.value[2], error,
                                        sizeof error),
            error);
  }
  Check(mt_scene_material_set_uint(scene, handle, MT_MAT_DOUBLE_SIDED,
                                   doubleSided, error, sizeof error),
        error);
  Check(mt_scene_material_set_float(scene, handle, MT_MAT_ALPHA_CUTOFF, 0, 0, 0,
                                    error, sizeof error),
        error);
  auto root = Surface(network);
  bool preview = root && root->nodeTypeId == TfToken("UsdPreviewSurface");
  bool standard = root &&
                  (root->nodeTypeId == TfToken("ND_standard_surface_surfaceshader") ||
                   root->nodeTypeId == TfToken("standard_surface"));
  float cutoff =
      preview ? Value(Input(*root, "opacityThreshold"), GfVec3f(0))[0] : 0;
  Check(mt_scene_material_set_float(scene, handle, MT_MAT_ALPHA_CUTOFF, cutoff,
                                    0, 0, error, sizeof error),
        error);
  Check(mt_scene_material_set_uint(scene, handle, MT_MAT_ALPHA_MODE,
                                   cutoff > 0 ? 2 : 0, error, sizeof error),
        error);

  struct Slot {
    char const *mx;
    char const *standard;
    char const *usd;
    uint32_t id;
    bool color;
  };
  Slot slots[] = {
      {"base_color", "base_color", "diffuseColor", MT_MAT_MAP, true},
      {"specular_roughness", "specular_roughness", "roughness", MT_MAT_ROUGHNESS_MAP, false},
      {"base_metalness", "metalness", "metallic", MT_MAT_METALNESS_MAP, false},
      {"emission_color", "emission_color", "emissiveColor", MT_MAT_EMISSIVE_MAP, true},
      {"geometry_opacity", "opacity", "opacity", MT_MAT_ALPHA_MAP, false},
      {"geometry_normal", "normal", "normal", MT_MAT_NORMAL_MAP, false},
      {"geometry_coat_normal", "coat_normal", "__none", MT_MAT_COAT_NORMAL_MAP, false},
      {"coat_weight", "coat", "clearcoat", MT_MAT_COAT_WEIGHT_MAP, false},
      {"coat_roughness", "coat_roughness", "clearcoatRoughness", MT_MAT_COAT_ROUGHNESS_MAP,
       false},
      {"specular_color", "specular_color", "__none", MT_MAT_SPECULAR_COLOR_MAP, true},
      {"specular_weight", "specular", "__none", MT_MAT_SPECULAR_WEIGHT_MAP, false},
      {"transmission_weight", "transmission", "__none", MT_MAT_TRANSMISSION_MAP, false},
      {"fuzz_color", "sheen_color", "__none", MT_MAT_FUZZ_COLOR_MAP, true},
      {"fuzz_roughness", "sheen_roughness", "__none", MT_MAT_FUZZ_ROUGHNESS_MAP, false}};
  for (auto const &slot : slots) {
    Check(mt_scene_material_set_texture(scene, handle, slot.id, 0, error,
                                        sizeof error),
          error);
    if (!root)
      continue;
    auto inputName = preview ? slot.usd : standard ? slot.standard : slot.mx;
    auto c = root->inputConnections.find(TfToken(inputName));
    if (c == root->inputConnections.end() || c->second.empty())
      continue;
    auto connection = c->second.front();
    std::set<SdfPath> visited;
    HdMaterialNode2 const *image = nullptr;
    while (visited.insert(connection.upstreamNode).second) {
      auto it = network.nodes.find(connection.upstreamNode);
      if (it == network.nodes.end())
        break;
      auto const &node = it->second;
      std::string id = node.nodeTypeId.GetString();
      if (id == "UsdUVTexture" || id.find("ND_image_") == 0) {
        image = &node;
        break;
      }
      if (id.find("ND_normal_") == 0 || id.find("ND_tangent_") == 0)
        break;
      if (id.find("ND_convert_") == 0 || id.find("ND_normalmap") == 0 ||
          id.find("ND_normalize_") == 0) {
        auto input = node.inputConnections.find(TfToken("in"));
        if (input != node.inputConnections.end() && !input->second.empty()) {
          connection = input->second.front();
          continue;
        }
      }
      Warn("unsupported texture node " + id + "; using constant");
      break;
    }
    if (!image)
      continue;
    auto file = String(Input(*image, "file"));
    if (file.empty())
      continue;
    try {
      if (image->nodeTypeId == TfToken("UsdUVTexture")) {
        auto scale = Input(*image, "scale"), bias = Input(*image, "bias");
        if ((scale.IsHolding<GfVec4f>() &&
             scale.Get<GfVec4f>() != GfVec4f(1)) ||
            (bias.IsHolding<GfVec4f>() && bias.Get<GfVec4f>() != GfVec4f(0))) {
          Warn("UsdUVTexture scale/bias expressions are unsupported; using "
               "constant");
          continue;
        }
      }
      bool srgb = slot.color;
      auto cs = String(Input(*image, "sourceColorSpace"),
                       String(Input(*image, "colorSpace:file"),
                              String(Input(*image, "colorSpace"))));
      if (cs == "raw" || cs == "linear" || cs == "lin_rec709" ||
          cs == "lin_rec709_scene")
        srgb = false;
      else if (cs == "sRGB" || cs == "srgb_texture")
        srgb = true;
      else if (!cs.empty() && cs != "auto") {
        Warn("unsupported texture color space " + cs + "; using constant");
        continue;
      }
      TextureData data;
      mt_scene_texture_desc_default(&data.desc);
      data.desc.flip_y =
          1; // USD st is bottom-up; decoded Hio images start at the top row.
      data.desc.wrap_s =
          Wrap(String(Input(*image, "wrapS"),
                      String(Input(*image, "uaddressmode"), "repeat")));
      data.desc.wrap_t =
          Wrap(String(Input(*image, "wrapT"),
                      String(Input(*image, "vaddressmode"), "repeat")));
      // Texture scalar inputs select the connected output channel. MuTracer
      // scalar maps read R; repack once on ingestion instead of dropping it.
      int channel = -1;
      auto out = connection.upstreamOutputName.GetString();
      if (out == "r")
        channel = 0;
      if (out == "g")
        channel = 1;
      if (out == "b")
        channel = 2;
      if (out == "a")
        channel = 3;
      auto uv =
          image->inputConnections.find(TfToken(preview ? "st" : "texcoord"));
      if (uv != image->inputConnections.end() && !uv->second.empty()) {
        auto u = network.nodes.find(uv->second.front().upstreamNode);
        if (u != network.nodes.end()) {
          auto id = u->second.nodeTypeId.GetString();
          if (id == "UsdTransform2d") {
            auto s = Input(u->second, "scale"),
                 t = Input(u->second, "translation");
            if (s.IsHolding<GfVec2f>())
              std::copy_n(s.UncheckedGet<GfVec2f>().data(), 2, data.desc.scale);
            if (t.IsHolding<GfVec2f>())
              std::copy_n(t.UncheckedGet<GfVec2f>().data(), 2,
                          data.desc.offset);
            if (Value(Input(u->second, "rotation"), GfVec3f(0))[0] != 0)
              Warn("UV rotation is unsupported by the C texture descriptor; "
                   "using scale/offset");
          } else if (id != "UsdPrimvarReader_float2" &&
                     id.find("ND_texcoord_") != 0)
            Warn("unsupported UV node " + id);
        }
      }
      std::string key =
          TextureReferenceKey(file) + ":" + std::to_string(slot.id) + ":" + std::to_string(srgb) +
          ":" + std::to_string(data.desc.wrap_s) + ":" +
          std::to_string(data.desc.wrap_t) + ":" + std::to_string(channel);
      for (float f : data.desc.scale)
        key += ":" + std::to_string(f);
      for (float f : data.desc.offset)
        key += ":" + std::to_string(f);
      auto version = TextureAssetVersion(file);
      auto &texture = textureHandles[key];
      if (!texture || textureVersions[key] != version) {
        auto sampler = data.desc;
        data = ReadTexture(file, srgb);
        data.desc.flip_y = sampler.flip_y;
        data.desc.wrap_s = sampler.wrap_s;
        data.desc.wrap_t = sampler.wrap_t;
        std::copy_n(sampler.scale, 2, data.desc.scale);
        std::copy_n(sampler.offset, 2, data.desc.offset);
        auto channelToRed = [channel](std::vector<uint8_t> &bytes,
                                      std::vector<float> &floats) {
          if (channel < 0)
            return;
          if (!bytes.empty())
            for (size_t i = 0; i < bytes.size(); i += 4)
              bytes[i] = bytes[i + channel];
          if (!floats.empty())
            for (size_t i = 0; i < floats.size(); i += 4)
              floats[i] = floats[i + channel];
        };
        if (!slot.color && channel >= 0) {
          if (data.tileData.empty())
            channelToRed(data.bytes, data.floats);
          else
            for (auto &tile : data.tileData)
              channelToRed(tile.bytes, tile.floats);
        }
        if (data.tileData.empty()) {
          data.desc.pixels = srgb ? static_cast<void *>(data.bytes.data())
                                  : static_cast<void *>(data.floats.data());
          data.desc.pixel_bytes = srgb ? data.bytes.size()
                                       : data.floats.size() * sizeof(float);
        } else {
          for (size_t i = 0; i < data.tileData.size(); ++i) {
            auto &tile = data.tileData[i];
            tile.desc.pixels = srgb ? static_cast<void *>(tile.bytes.data())
                                    : static_cast<void *>(tile.floats.data());
            tile.desc.pixel_bytes = srgb ? tile.bytes.size()
                                         : tile.floats.size() * sizeof(float);
            data.tiles[i] = tile.desc;
          }
          data.desc.tiles = data.tiles.data();
          data.desc.tile_count = data.tiles.size();
        }

        if (texture)
          Check(mt_scene_set_texture(scene, texture, &data.desc, error,
                                     sizeof error),
                error);
        else
          Check(mt_scene_add_texture(scene, &data.desc, &texture, error,
                                     sizeof error),
                error);
        textureVersions[key] = std::move(version);
      }
      Check(mt_scene_material_set_texture(scene, handle, slot.id, texture,
                                          error, sizeof error),
            error);
      uint32_t factor = 0;
      int components = 1;
      if (slot.id == MT_MAT_MAP) {
        factor = MT_MAT_BASE_COLOR;
        components = 3;
      }
      if (slot.id == MT_MAT_ROUGHNESS_MAP)
        factor = MT_MAT_SPECULAR_ROUGHNESS;
      if (slot.id == MT_MAT_METALNESS_MAP)
        factor = MT_MAT_BASE_METALNESS;
      if (slot.id == MT_MAT_ALPHA_MAP)
        factor = MT_MAT_OPACITY;
      if (slot.id == MT_MAT_COAT_WEIGHT_MAP)
        factor = MT_MAT_COAT_WEIGHT;
      if (slot.id == MT_MAT_COAT_ROUGHNESS_MAP)
        factor = MT_MAT_COAT_ROUGHNESS;
      if (slot.id == MT_MAT_TRANSMISSION_MAP)
        factor = MT_MAT_TRANSMISSION_WEIGHT;
      if (slot.id == MT_MAT_EMISSIVE_MAP) {
        factor = MT_MAT_EMISSION_COLOR;
        components = 3;
        if (preview)
          Check(mt_scene_material_set_float(scene, handle,
                                            MT_MAT_EMISSION_LUMINANCE, 1, 0, 0,
                                            error, sizeof error),
                error);
      }
      if (factor)
        Check(mt_scene_material_set_float(
                  scene, handle, factor, 1, components == 3 ? 1 : 0,
                  components == 3 ? 1 : 0, error, sizeof error),
              error);

    } catch (std::exception const &e) {
      Warn(e.what());
    }
  }
  materialAssetVersions[path] = MaterialAssetVersion(network);
  if (!root)
    return;
  for (auto const &c : root->inputConnections) {
    bool handled = false;
    for (auto const &s : slots)
      if (c.first == TfToken(preview ? s.usd : standard ? s.standard : s.mx))
        handled = true;
    if (!handled) {
      auto i = network.nodes.find(
          c.second.empty() ? SdfPath() : c.second.front().upstreamNode);
      if (i != network.nodes.end()) {
        auto id = i->second.nodeTypeId.GetString();
        bool geometry = c.first == TfToken("geometry_tangent") ||
                        c.first == TfToken("geometry_coat_tangent") ||
                        c.first == TfToken("geometry_normal") ||
                        c.first == TfToken("geometry_coat_normal");
        bool folded = false;
        float angle = 0;
        std::set<SdfPath> seen;
        auto current = i;
        while (geometry && current != network.nodes.end() &&
               seen.insert(current->first).second) {
          auto kind = current->second.nodeTypeId.GetString();
          if (kind.find("ND_normal_") == 0 || kind.find("ND_tangent_") == 0) {
            folded = true;
            break;
          }
          if (kind.find("ND_normalize_") == 0 ||
              kind.find("ND_rotate3d_") == 0) {
            if (kind.find("ND_rotate3d_") == 0)
              angle += Value(Input(current->second, "amount"), GfVec3f(0))[0];
            auto in = current->second.inputConnections.find(TfToken("in"));
            if (in == current->second.inputConnections.end() ||
                in->second.empty())
              break;
            current = network.nodes.find(in->second.front().upstreamNode);
            continue;
          }
          break;
        }
        if (folded) {
          if (c.first == TfToken("geometry_tangent") ||
              c.first == TfToken("geometry_coat_tangent")) {
            auto prop = c.first == TfToken("geometry_coat_tangent")
                            ? MT_MAT_COAT_ANISOTROPY_ROTATION
                            : MT_MAT_SPECULAR_ANISOTROPY_ROTATION;
            Check(mt_scene_material_set_float(scene, handle, prop,
                                              angle * float(M_PI / 180), 0, 0,
                                              error, sizeof error),
                  error);
          }
        } else
          Warn("unsupported connected input " + c.first.GetString() +
               "; using nodedef constant");
      }
    }
  }
}
} // namespace mtHydra
PXR_NAMESPACE_CLOSE_SCOPE
