// Copyright 2026 MuTracer contributors. SPDX-License-Identifier: MIT
// Ingestion and packing only. Node rules/defaults are generated from the shared
// browser definitions, and shader evaluation remains in the shared AOT core.
#include "bridge.h"
#include "pxr/base/js/json.h"
#include "pxr/usd/sdf/assetPath.h"
#include "pxr/usd/sdr/registry.h"
#include "pxr/usd/sdr/shaderNode.h"
#include "pxr/usd/sdr/shaderProperty.h"
#include <algorithm>
#include <array>
#include <cctype>
#include <cmath>
#include <optional>
PXR_NAMESPACE_OPEN_SCOPE
namespace mtHydra {
namespace {
JsValue const &Get(JsValue const &v, std::string const &key) {
  static JsValue empty;
  if (!v.IsObject())
    return empty;
  auto i = v.GetJsObject().find(key);
  return i == v.GetJsObject().end() ? empty : i->second;
}
std::string Text(JsValue const &v, std::string fallback = "") {
  return v.IsString() ? v.GetString() : fallback;
}
JsValue const &Schema() {
  static JsValue schema = JsParseString(
#include "materialGraphSchema.inc"
  );
  return schema;
}
uint32_t Id(char const *group, std::string const &name) {
  auto const &a = Get(Schema(), group).GetJsArray();
  for (size_t i = 0; i < a.size(); ++i)
    if (Text(a[i]) == name)
      return uint32_t(i);
  return UINT32_MAX;
}
std::string Camel(std::string s) {
  std::string out;
  bool upper = false;
  for (unsigned char c : s) {
    if (c == '_') {
      upper = true;
      continue;
    }
    out += upper ? char(std::toupper(c)) : char(std::tolower(c));
    upper = false;
  }
  return out;
}
std::string Terminal(std::string const &name) {
  auto s = Camel(name);
  auto a = Get(Get(Schema(), "terminalAliases"), s);
  if (a.IsString())
    s = a.GetString();
  static std::map<std::string, std::string> aliases = {
      {"geometryThinWalled", "thinWalled"},
      {"subsurfaceScatterAnisotropy", "subsurfaceAnisotropy"},
      {"coatRoughnessAnisotropy", "coatAnisotropy"},
      {"geometryCoatNormal", "coatNormal"},
      {"geometryTangent", "tangent"},
      {"geometryCoatTangent", "coatTangent"}};
  auto i = aliases.find(s);
  return i == aliases.end() ? s : i->second;
}
std::string Type(SdrShaderPropertyConstPtr p, std::string fallback) {
  if (!p)
    return fallback;
  auto t = p->GetTypeAsSdfType().GetSdfType().GetAsToken().GetString();
  if (t == "float" || t == "double")
    return "float";
  if (t == "int")
    return "integer";
  if (t == "bool")
    return "boolean";
  if (t == "asset")
    return "filename";
  if (t == "token" || t == "string")
    return "string";
  if (t == "color3f" || t == "color3d")
    return "color3";
  if (t == "color4f" || t == "color4d")
    return "color4";
  if (t == "float2" || t == "double2" || t == "texCoord2f")
    return "vector2";
  if (t == "float4" || t == "double4")
    return "vector4";
  if (t == "float3" || t == "double3" || t == "vector3f" || t == "normal3f" ||
      t == "point3f")
    return "vector3";
  return fallback;
}
SdrShaderNodeConstPtr Definition(HdMaterialNode2 const &n) {
  return SdrRegistry::GetInstance().GetShaderNodeByIdentifier(n.nodeTypeId);
}
std::pair<std::string, std::string> Kind(HdMaterialNode2 const &n) {
  auto id = n.nodeTypeId.GetString();
  std::string category;
  for (auto const &c : Get(Schema(), "categories").GetJsArray()) {
    auto s = Text(c);
    if (id == s || id == "ND_" + s || id.find("ND_" + s + "_") == 0)
      if (s.size() > category.size())
        category = s;
  }
  if (category.empty() && id.find("ND_absval_") == 0)
    category = "abs";
  auto def = Definition(n);
  std::string type = "float";
  if (def) {
    auto outputs = def->GetShaderOutputNames();
    if (!outputs.empty())
      type = Type(def->GetShaderOutput(outputs.front()), type);
  } else {
    for (auto const &t : Get(Schema(), "types").GetJsArray()) {
      auto s = Text(t);
      if (id.find("_" + s) != std::string::npos) {
        type = s;
        break;
      }
    }
  }
  if (category == "gltf_colorimage")
    type = "color4";
  if (category.find("separate") == 0) {
    auto in = n.parameters.find(TfToken("in"));
    if (def)
      type = Type(def->GetShaderInput(TfToken("in")), type);
  }
  return {category.empty() ? id : category, type};
}
VtValue Literal(JsValue const &v, std::string const &type) {
  if (v.IsArray()) {
    auto const &a = v.GetJsArray();
    auto number = [&](size_t i) {
      return i < a.size()
                 ? float(a[i].IsInt() ? a[i].GetInt64() : a[i].GetReal())
                 : 0.f;
    };
    if (a.size() == 2)
      return VtValue(GfVec2f(number(0), number(1)));
    if (a.size() == 4)
      return VtValue(GfVec4f(number(0), number(1), number(2), number(3)));
    return VtValue(GfVec3f(number(0), number(1), number(2)));
  }
  if (v.IsString())
    return VtValue(v.GetString());
  if (v.IsBool())
    return VtValue(v.GetBool());
  if (v.IsInt())
    return type == "integer" ? VtValue(v.GetInt()) : VtValue(float(v.GetInt()));
  if (v.IsReal())
    return VtValue(float(v.GetReal()));
  return VtValue();
}
std::array<float, 4> Numbers(VtValue const &v) {
  std::array<float, 4> a{};
  if (v.IsHolding<GfVec2f>())
    std::copy_n(v.Get<GfVec2f>().data(), 2, a.data());
  else if (v.IsHolding<GfVec3f>())
    std::copy_n(v.Get<GfVec3f>().data(), 3, a.data());
  else if (v.IsHolding<GfVec4f>())
    std::copy_n(v.Get<GfVec4f>().data(), 4, a.data());
  else if (v.IsHolding<float>())
    a[0] = v.Get<float>();
  else if (v.IsHolding<double>())
    a[0] = float(v.Get<double>());
  else if (v.IsHolding<int>())
    a[0] = float(v.Get<int>());
  else if (v.IsHolding<bool>())
    a[0] = v.Get<bool>() ? 1 : 0;
  return a;
}
std::string String(VtValue const &v) {
  if (v.IsHolding<std::string>())
    return v.Get<std::string>();
  if (v.IsHolding<TfToken>())
    return v.Get<TfToken>().GetString();
  if (v.IsHolding<SdfAssetPath>()) {
    auto p = v.Get<SdfAssetPath>();
    return p.GetResolvedPath().empty() ? p.GetAssetPath() : p.GetResolvedPath();
  }
  return "";
}
// Uniform and inactive surface inputs may have been visited for folding. Keep
// only nodes reachable from the retained terminals before handing IR to the
// SDK.
void Prune(MaterialGraphData &graph) {
  std::vector<bool> live(graph.nodes.size());
  std::function<void(uint32_t)> mark = [&](uint32_t index) {
    if (index >= graph.nodes.size() || live[index])
      return;
    live[index] = true;
    auto const &node = graph.nodes[index];
    for (uint32_t i = 0; i < node.input_count; ++i) {
      auto const &input = graph.inputs[node.first_input + i];
      if (input.source_kind == MT_GRAPH_SOURCE_NODE)
        mark(input.source);
    }
  };
  for (auto const &terminal : graph.terminals)
    mark(terminal.node);
  std::vector<uint32_t> remap(graph.nodes.size(), UINT32_MAX);
  uint32_t count = 0;
  for (size_t i = 0; i < live.size(); ++i)
    if (live[i])
      remap[i] = count++;
  std::vector<mt_graph_node> nodes;
  std::vector<mt_graph_input> inputs;
  std::vector<std::string> authors;
  std::vector<float> parameters;
  std::map<uint32_t, uint32_t> slots;
  for (size_t i = 0; i < live.size(); ++i) {
    if (!live[i])
      continue;
    auto node = graph.nodes[i];
    for (uint32_t j = 0; j < node.input_count; ++j) {
      auto input = graph.inputs[node.first_input + j];
      if (input.source_kind == MT_GRAPH_SOURCE_NODE)
        input.source =
            input.source < remap.size() ? remap[input.source] : UINT32_MAX;
      else if (input.source_kind == MT_GRAPH_SOURCE_PARAMETER) {
        auto slot =
            slots.emplace(input.source, uint32_t(parameters.size() / 4));
        if (slot.second)
          parameters.insert(parameters.end(),
                            graph.parameters.begin() + input.source * 4,
                            graph.parameters.begin() + input.source * 4 + 4);
        input.source = slot.first->second;
      }
      inputs.push_back(input);
    }
    node.first_input = uint32_t(inputs.size()) - node.input_count;
    nodes.push_back(node);
    authors.push_back(graph.authorIds[i]);
  }
  for (auto &terminal : graph.terminals)
    terminal.node =
        terminal.node < remap.size() ? remap[terminal.node] : UINT32_MAX;
  graph.nodes = std::move(nodes);
  graph.inputs = std::move(inputs);
  graph.parameters = std::move(parameters);
  graph.authorIds = std::move(authors);
}
struct Input {
  std::string type;
  VtValue value;
  std::optional<HdMaterialConnection2> edge;
};
using Inputs = std::map<std::string, Input>;
Input Read(HdMaterialNetwork2 const &network, SdfPath const &path,
           std::string const &port, std::string fallbackType,
           VtValue fallback = VtValue()) {
  auto n = network.nodes.find(path);
  if (n == network.nodes.end())
    return {fallbackType, fallback, {}};
  auto def = Definition(n->second);
  Input value{
      Type(def ? def->GetShaderInput(TfToken(port)) : nullptr, fallbackType),
      fallback,
      {}};
  auto c = n->second.inputConnections.find(TfToken(port));
  if (c != n->second.inputConnections.end() && !c->second.empty())
    value.edge = c->second.front();
  auto p = n->second.parameters.find(TfToken(port));
  if (p != n->second.parameters.end())
    value.value = p->second;
  return value;
}

} // namespace
// The official Standard Surface translation is shared with the viewer as data.
// HdMaterialNetwork2 already flattens USD NodeGraph outputs and interface
// inputs; retaining the upstream USD paths keeps authorship and edits stable.
MaterialGraphData BuildMaterialGraph(
    HdMaterialNetwork2 const &source,
    std::function<mt_scene_texture_id(std::string const &, bool, uint32_t,
                                      uint32_t)> const &load,
    SdfPath const &authorRoot) {
  MaterialGraphData result;
  std::map<SdfPath, std::map<std::string, std::string>> typeHints;
  auto network = source;
  auto terminal = network.terminals.find(HdMaterialTerminalTokens->surface);
  if (terminal == network.terminals.end()) {
    result.warnings.push_back(authorRoot.GetString() +
                              ": missing surface terminal");
    return result;
  }
  auto rootPath = terminal->second.upstreamNode;
  auto root = network.nodes.find(rootPath);
  if (root == network.nodes.end())
    return result;
  auto rootId = root->second.nodeTypeId.GetString();
  Inputs terminals;
  auto addTerminal = [&](std::string name, std::string type, Input value) {
    value.type = type;
    terminals[name] = value;
  };
  if (rootId == "ND_standard_surface_surfaceshader" ||
      rootId == "standard_surface") {
    auto const &xml = Get(Schema(), "standardSurface");
    JsValue def, graph;
    for (auto const &c : Get(xml, "children").GetJsArray()) {
      if (Text(Get(c, "tag")) == "nodedef")
        def = c;
      if (Text(Get(c, "tag")) == "nodegraph")
        graph = c;
    }
    Inputs interfaces;
    for (auto const &c : Get(def, "children").GetJsArray()) {
      if (Text(Get(c, "tag")) != "input")
        continue;
      auto const &a = Get(c, "attrs");
      auto type = Text(Get(a, "type")), name = Text(Get(a, "name")),
           text = Text(Get(a, "value"));
      VtValue value;
      if (type == "boolean")
        value = VtValue(text == "true");
      else {
        std::replace(text.begin(), text.end(), ',', ' ');
        std::istringstream input(text);
        std::array<float, 4> a{};
        for (auto &x : a)
          input >> x;
        value = type == "color3" ? VtValue(GfVec3f(a[0], a[1], a[2]))
                                 : VtValue(a[0]);
      }
      interfaces[name] = Read(network, rootPath, name, type, value);
    }
    auto prefix = rootPath.AppendChild(TfToken("translation"));
    auto resolve = [&](JsValue const &e) -> Input {
      auto const &a = Get(e, "attrs");
      auto type = Text(Get(a, "type"));
      auto iface = Text(Get(a, "interfacename"));
      if (!iface.empty())
        return interfaces.at(iface);
      auto node = Text(Get(a, "nodename"));
      if (!node.empty())
        return {type,
                {},
                HdMaterialConnection2{prefix.AppendChild(TfToken(node)),
                                      TfToken(Text(Get(a, "output"), "out"))}};
      auto text = Text(Get(a, "value"));
      if (type == "string")
        return {type, VtValue(text), {}};
      std::replace(text.begin(), text.end(), ',', ' ');
      std::istringstream in(text);
      std::array<float, 4> v{};
      for (auto &x : v)
        in >> x;
      return {type,
              type == "color3" || type == "vector3"
                  ? VtValue(GfVec3f(v[0], v[1], v[2]))
                  : VtValue(v[0]),
              {}};
    };
    for (auto const &e : Get(graph, "children").GetJsArray()) {
      auto const &a = Get(e, "attrs");
      auto category = Text(Get(e, "tag")), name = Text(Get(a, "name")),
           type = Text(Get(a, "type"));
      if (category == "output") {
        if (name.size() > 4 && name.substr(name.size() - 4) == "_out")
          name.resize(name.size() - 4);
        terminals[Terminal(name)] = resolve(e);
        continue;
      }
      HdMaterialNode2 node;
      node.nodeTypeId = TfToken("ND_" + category + "_" + type);
      for (auto const &p : Get(e, "children").GetJsArray()) {
        auto port = Text(Get(Get(p, "attrs"), "name"));
        auto value = resolve(p);
        typeHints[prefix.AppendChild(TfToken(name))][port] = value.type;
        if (value.edge)
          node.inputConnections[TfToken(port)] = {*value.edge};
        else
          node.parameters[TfToken(port)] = value.value;
      }
      network.nodes[prefix.AppendChild(TfToken(name))] = node;
    }
    for (auto const &p : root->second.parameters)
      if (!interfaces.count(p.first.GetString()) &&
          p.first != TfToken("normal") &&
          p.first.GetString().find(':') == std::string::npos)
        terminals[Terminal(p.first.GetString())] =
            Read(network, rootPath, p.first.GetString(), "float");
    for (auto const &p : root->second.inputConnections)
      if (!interfaces.count(p.first.GetString()) &&
          p.first != TfToken("normal"))
        terminals[Terminal(p.first.GetString())] =
            Read(network, rootPath, p.first.GetString(), "float");
    auto normal = Read(network, rootPath, "normal", "vector3");
    if (normal.edge || !normal.value.IsEmpty())
      terminals["normal"] = normal;
  } else if (rootId == "ND_open_pbr_surface_surfaceshader" ||
             rootId == "open_pbr_surface") {
    for (auto const &p : root->second.parameters)
      if (p.first.GetString().find(':') == std::string::npos)
        terminals[Terminal(p.first.GetString())] =
            Read(network, rootPath, p.first.GetString(), "float");
    for (auto const &p : root->second.inputConnections)
      terminals[Terminal(p.first.GetString())] =
          Read(network, rootPath, p.first.GetString(), "float");
  } else if (rootId == "UsdPreviewSurface" ||
             rootId == "ND_UsdPreviewSurface_surfaceshader" ||
             rootId == "ND_gltf_pbr_surfaceshader" || rootId == "gltf_pbr") {
    bool gltf = rootId != "UsdPreviewSurface" &&
                rootId != "ND_UsdPreviewSurface_surfaceshader";
    std::set<std::string> handled;
    for (auto const &f :
         Get(Get(Schema(), "surfaces"), gltf ? "gltf" : "usd").GetJsObject()) {
      auto const &a = f.second.GetJsArray();
      auto port = Text(a[0]), type = Text(a[1]);
      handled.insert(port);
      auto value = Read(network, rootPath, port, type, Literal(a[2], type));
      if (!value.value.IsEmpty() || value.edge)
        terminals[f.first] = value;
    }
    terminals["coatIor"] = {"float", VtValue(1.5f), {}};
    terminals["emissionLuminance"] =
        gltf ? Read(network, rootPath, "emissive_strength", "float",
                    VtValue(1.f))
             : Input{"float", VtValue(1.f), {}};
    handled.insert("emissive_strength");
    auto literal = [](std::string type, VtValue value) {
      return Input{type, value, {}};
    };
    auto add = [&](std::string name, std::string category, std::string type,
                   Inputs const &inputs) {
      auto path = rootPath.AppendChild(TfToken("translation"))
                      .AppendChild(TfToken(name));
      HdMaterialNode2 node;
      node.nodeTypeId = TfToken("ND_" + category + "_" + type);
      for (auto const &p : inputs) {
        typeHints[path][p.first] = p.second.type;
        if (p.second.edge)
          node.inputConnections[TfToken(p.first)] = {*p.second.edge};
        else
          node.parameters[TfToken(p.first)] = p.second.value;
      }
      network.nodes[path] = node;
      return Input{type, {}, HdMaterialConnection2{path, TfToken("out")}};
    };
    if (gltf) {
      auto film = Read(network, rootPath, "iridescence_thickness", "float",
                       VtValue(100.f));
      terminals["thinFilmThickness"] =
          add("filmThickness", "multiply", "float",
              {{"in1", film}, {"in2", literal("float", VtValue(.001f))}});
      auto color = add("sheenVector", "convert", "vector3",
                       {{"in", terminals["fuzzColor"]}});
      auto sum = add(
          "sheenSum", "dotproduct", "float",
          {{"in1", color}, {"in2", literal("vector3", VtValue(GfVec3f(1)))}});
      terminals["fuzzWeight"] = add("sheenWeight", "ifgreater", "float",
                                    {{"value1", sum},
                                     {"value2", literal("float", VtValue(0.f))},
                                     {"in1", literal("float", VtValue(1.f))},
                                     {"in2", literal("float", VtValue(0.f))}});
      auto alpha = Read(network, rootPath, "alpha_mode", "integer", VtValue(0));
      if (alpha.edge)
        terminals["alphaMode"] = alpha;
      else {
        auto mode = Numbers(alpha.value)[0];
        if (mode >= 0 && mode <= 2 && mode == std::floor(mode))
          result.uintValues.push_back({MT_MAT_ALPHA_MODE, uint32_t(mode) + 1});
        else
          terminals["alphaMode"] = alpha;
      }
      auto cutoff =
          Read(network, rootPath, "alpha_cutoff", "float", VtValue(.5f));
      if (cutoff.edge)
        terminals["alphaCutoff"] = cutoff;
      else
        result.values.push_back(
            {MT_MAT_ALPHA_CUTOFF, GfVec3f(Numbers(cutoff.value)[0], 0, 0)});
      for (auto const &pair : std::vector<std::pair<std::string, std::string>>{
               {"attenuation_color", "transmissionColor"},
               {"attenuation_distance", "transmissionDepth"}}) {
        auto value =
            Read(network, rootPath, pair.first,
                 pair.first == "attenuation_color" ? "color3" : "float");
        if (value.edge || !value.value.IsEmpty())
          terminals[pair.second] = value;
        handled.insert(pair.first);
      }
      auto thickness = Read(network, rootPath, "thickness", "float");
      if (thickness.edge)
        terminals["volumeThickness"] = thickness;
      else if (!thickness.value.IsEmpty())
        result.uintValues.push_back(
            {MT_MAT_THIN_WALLED, Numbers(thickness.value)[0] <= 0 ? 1u : 0u});
      for (auto const &p :
           {"alpha_mode", "alpha_cutoff", "iridescence_thickness", "thickness"})
        handled.insert(p);
    } else {
      handled.insert("opacityThreshold");
      for (auto const &p : {"useSpecularWorkflow", "opacityMode"}) {
        auto value = Read(network, rootPath, p, "integer");
        if (value.edge || Numbers(value.value)[0] != 0)
          terminals[p] = value;
        handled.insert(p);
      }
      handled.insert("specularColor");
    }

    for (auto const &p : root->second.parameters) {
      auto name = p.first.GetString();
      auto value = Read(network, rootPath, name, "float");
      if (handled.count(name) || name.find(':') != std::string::npos)
        continue;
      if ((name == "occlusion" && Numbers(value.value)[0] == 1) ||
          (name == "displacement" && Numbers(value.value)[0] == 0))
        continue;
      terminals[name] = value;
    }
    for (auto const &p : root->second.inputConnections)
      if (!handled.count(p.first.GetString()))
        terminals[p.first.GetString()] =
            Read(network, rootPath, p.first.GetString(), "float");
  } else {
    result.warnings.push_back((rootPath.IsAbsolutePath() || authorRoot.IsEmpty()
                                   ? rootPath
                                   : authorRoot.AppendPath(rootPath))
                                  .GetString() +
                              ": unsupported-node " + rootId);
    return result;
  }
  std::map<std::string, uint32_t> properties;
  for (auto const &p : OpenPbrDefaults())
    properties[Terminal(p.name)] = p.id;
  std::map<SdfPath, uint32_t> indices;
  std::set<SdfPath> visiting;
  std::function<uint32_t(SdfPath const &)> visit;
  auto author = [&](SdfPath const &path) {
    return path.IsAbsolutePath() || authorRoot.IsEmpty()
               ? path
               : authorRoot.AppendPath(path);
  };
  auto issue = [&](SdfPath const &path, std::string const &port,
                   std::string const &reason) {
    result.warnings.push_back(author(path).GetString() +
                              (port.empty() ? "" : "." + port) + ": " + reason);
  };
  visit = [&](SdfPath const &path) -> uint32_t {
    auto previous = indices.find(path);
    if (previous != indices.end())
      return previous->second;
    if (!visiting.insert(path).second) {
      issue(path, "", "cycle");
      return UINT32_MAX;
    }
    auto found = network.nodes.find(path);
    if (found == network.nodes.end()) {
      issue(path, "", "missing-node");
      return UINT32_MAX;
    }
    auto const &node = found->second;
    auto [category, type] = Kind(node);
    auto definition = Get(Get(Schema(), "definitions"), category + "/" + type);
    JsObject defaults = Get(definition, "base").IsObject()
                            ? Get(definition, "base").GetJsObject()
                            : JsObject{};
    auto def = Definition(node);
    std::set<std::string> authored;
    for (auto const &p : node.parameters)
      authored.insert(p.first.GetString());
    for (auto const &p : node.inputConnections)
      authored.insert(p.first.GetString());
    for (auto const &p : authored) {
      auto defaultIt = defaults.find(p);
      auto fallback = defaultIt == defaults.end()
                          ? std::string("float")
                          : Text(Get(defaultIt->second, "type"), "float");
      auto t = Type(def ? def->GetShaderInput(TfToken(p)) : nullptr, fallback);
      if (typeHints[path].count(p))
        t = typeHints[path][p];
      else if (!def) {
        auto value = node.parameters.find(TfToken(p));
        if (value != node.parameters.end()) {
          if (value->second.IsHolding<GfVec2f>())
            t = "vector2";
          else if (value->second.IsHolding<GfVec3f>())
            t = fallback == "color3" ? "color3" : "vector3";
          else if (value->second.IsHolding<float>())
            t = "float";
        }
        auto c = node.inputConnections.find(TfToken(p));
        if (c != node.inputConnections.end() && !c->second.empty()) {
          auto upstream = network.nodes.find(c->second.front().upstreamNode);
          if (upstream != network.nodes.end())
            t = Kind(upstream->second).second;
        }
      }
      auto override = Get(Get(definition, "overrides"), p + "/" + t);
      if (override.IsObject())
        for (auto const &o : override.GetJsObject())
          defaults[o.first] = o.second;
    }
    for (auto const &p : authored)
      if (!defaults.count(p)) {
        auto v = node.parameters.find(TfToken(p));
        bool inactive =
            p.find("typeName:") == 0 || p.find("colorSpace:") == 0 ||
            v != node.parameters.end() &&
                ((p == "layer" || p == "framerange") &&
                     String(v->second).empty() ||
                 p == "frameoffset" && Numbers(v->second)[0] == 0 ||
                 p == "frameendaction" && String(v->second) == "constant");
        if (!inactive)
          issue(path, p, "unsupported-input");
      }
    if (definition.IsNull())
      issue(path, "", "unsupported-node " + category + "/" + type);
    std::vector<mt_graph_input> inputs;
    for (auto const &p : authored)
      if (!defaults.count(p) && p.find("typeName:") != 0 &&
          p.find("colorSpace:") != 0) {
        auto found = node.parameters.find(TfToken(p));
        bool inactive =
            found != node.parameters.end() &&
            (((p == "layer" || p == "framerange") &&
              String(found->second).empty()) ||
             (p == "frameoffset" && Numbers(found->second)[0] == 0) ||
             (p == "frameendaction" && String(found->second) == "constant"));
        if (inactive)
          continue;
        inputs.push_back({Id("ports", p), MT_GRAPH_PORT_TYPE_FLOAT,
                          MT_GRAPH_SOURCE_PARAMETER,
                          uint32_t(result.parameters.size() / 4),
                          MT_GRAPH_OUTPUT_OUT});
        result.parameters.insert(result.parameters.end(), 4, 0.f);
      }
    for (auto const &p : defaults) {
      auto expectedType = Text(Get(p.second, "type"));
      auto defaultValue = Get(p.second, "value");
      auto value = Read(network, path, p.first, expectedType,
                        Literal(defaultValue, expectedType));
      if (!authored.count(p.first))
        value.type = expectedType;
      if (typeHints[path].count(p.first))
        value.type = typeHints[path][p.first];
      mt_graph_input input{Id("ports", p.first), Id("types", value.type), 0, 0,
                           0};
      if (value.edge) {
        input.source_kind = MT_GRAPH_SOURCE_NODE;
        input.source = visit(value.edge->upstreamNode);
        input.output =
            Id("outputs", value.edge->upstreamOutputName.GetString().empty()
                              ? "out"
                              : value.edge->upstreamOutputName.GetString());
      } else if (!authored.count(p.first) && defaultValue.IsNull() &&
                 expectedType != "filename") {
        input.source_kind = MT_GRAPH_SOURCE_GEOMETRY;
        input.source =
            Id("geometry", p.first == "position" ? "objectPosition" : p.first);
      } else {
        auto numbers = Numbers(value.value);
        if (expectedType == "string") {
          auto text = String(value.value);
          auto fallback = Text(defaultValue);
          if (p.first == "space" || p.first == "fromspace" ||
              p.first == "tospace") {
            if (text != "world" && text != "object" &&
                !(text.empty() && p.first != "space"))
              issue(path, p.first, "unsupported-space");
            numbers[0] = text == "world"    ? 1
                         : text == "object" ? 0
                         : text.empty()     ? -1
                                            : -2;
          } else if ((p.first == "uaddressmode" || p.first == "vaddressmode") &&
                     (text == "clamp" || text == "mirror")) {
          } else if (!(category == "dot" && p.first == "note") &&
                     text != fallback) {
            issue(path, p.first, "unsupported-sampling");
            numbers[0] = -2; // Invalid control remains a located SDK fallback.
          }
        }
        if (expectedType == "filename") {
          auto file = String(value.value);
          numbers[0] = -1;
          if (!file.empty()) {
            auto wrap = [&](char const *port) {
              auto v = node.parameters.find(TfToken(port));
              auto s =
                  v == node.parameters.end() ? "periodic" : String(v->second);
              return s == "clamp" ? 1u : s == "mirror" ? 2u : 0u;
            };
            auto cs = node.parameters.find(TfToken("colorSpace:file"));
            auto colorSpace =
                cs == node.parameters.end() ? "" : String(cs->second);
            bool srgb = type.find("color") == 0 && colorSpace != "lin_rec709" &&
                        colorSpace != "lin_rec709_scene" &&
                        colorSpace != "linear";
            try {
              auto texture =
                  load(file, srgb, wrap("uaddressmode"), wrap("vaddressmode"));
              numbers[0] = float(result.textures.size());
              result.textures.push_back(texture);
            } catch (std::exception const &e) {
              issue(path, p.first, std::string("texture-load: ") + e.what());
              numbers[0] = -2;
            }
          }
        }
        input.source = uint32_t(result.parameters.size() / 4);
        result.parameters.insert(result.parameters.end(), numbers.begin(),
                                 numbers.end());
      }
      inputs.push_back(input);
    }
    uint32_t index = uint32_t(result.nodes.size());
    indices[path] = index;
    visiting.erase(path);
    result.nodes.push_back({Id("categories", category), 1, Id("types", type),
                            uint32_t(result.inputs.size()),
                            uint32_t(inputs.size())});
    result.inputs.insert(result.inputs.end(), inputs.begin(), inputs.end());
    result.authorIds.push_back(author(path).GetString());
    return index;
  };
  for (auto const &t : terminals) {
    auto value = t.second;
    auto property = properties.find(t.first);
    if (!value.edge && t.first == "normal" && !value.value.IsEmpty()) {
      auto path = rootPath.AppendChild(TfToken("constantNormal"));
      HdMaterialNode2 node;
      node.nodeTypeId = TfToken("ND_constant_vector3");
      node.parameters[TfToken("value")] = value.value;
      network.nodes[path] = node;
      value.edge = HdMaterialConnection2{path, TfToken("out")};
      value.type = "vector3";
    }
    if (!value.edge) {
      if (property != properties.end() && !value.value.IsEmpty()) {
        auto a = Numbers(value.value);
        result.values.push_back({property->second, GfVec3f(a[0], a[1], a[2])});
      } else if (!value.value.IsEmpty() &&
                 (Numbers(value.value) != std::array<float, 4>{} ||
                  !String(value.value).empty())) {
        issue(rootPath, t.first, "unsupported-terminal");
        // Retain an unsupported reachable terminal so the SDK falls back the
        // whole graph, rather than evaluating the remaining supported part.
        auto source = uint32_t(result.nodes.size()),
             slot = uint32_t(result.parameters.size() / 4);
        result.nodes.push_back({MT_GRAPH_CATEGORY_CONSTANT, 1,
                                MT_GRAPH_PORT_TYPE_FLOAT,
                                uint32_t(result.inputs.size()), 1});
        result.inputs.push_back({MT_GRAPH_PORT_VALUE, MT_GRAPH_PORT_TYPE_FLOAT,
                                 MT_GRAPH_SOURCE_PARAMETER, slot,
                                 MT_GRAPH_OUTPUT_OUT});
        result.parameters.insert(result.parameters.end(),
                                 {Numbers(value.value)[0], 0, 0, 0});
        result.terminals.push_back({UINT32_MAX, source, MT_GRAPH_OUTPUT_OUT});
        result.authorIds.push_back(author(rootPath).GetString());
      }
      continue;
    }
    auto index = visit(value.edge->upstreamNode);
    std::optional<GfVec3f> uniform;
    if (value.type == "boolean" || value.type == "integer") {
      // The viewer probes integer/bool surface values through a float convert.
      auto input = mt_graph_input{
          Id("ports", "in"), Id("types", value.type), MT_GRAPH_SOURCE_NODE,
          index,
          Id("outputs", value.edge->upstreamOutputName.GetString().empty()
                            ? "out"
                            : value.edge->upstreamOutputName.GetString())};
      index = uint32_t(result.nodes.size());
      result.nodes.push_back({Id("categories", "convert"), 1,
                              Id("types", "float"),
                              uint32_t(result.inputs.size()), 1});
      result.inputs.push_back(input);
      result.authorIds.push_back(author(rootPath).GetString() + "/fold/" +
                                 t.first);
      value.type = "float";
    }
    auto type = value.type;
    std::string probe = type == "float"     ? "specularRoughness"
                        : type == "color3"  ? "baseColor"
                        : type == "vector3" ? "normal"
                                            : "";
    if (!probe.empty()) {
      mt_graph_terminal terminal{
          Id("terminals", probe), index,
          Id("outputs", value.edge->upstreamOutputName.GetString().empty()
                            ? "out"
                            : value.edge->upstreamOutputName.GetString())};
      mt_scene_material_graph_desc desc;
      mt_scene_material_graph_desc_default(&desc);
      desc.nodes = result.nodes.data();
      desc.node_count = result.nodes.size();
      desc.inputs = result.inputs.data();
      desc.input_count = result.inputs.size();
      desc.terminals = &terminal;
      desc.terminal_count = 1;
      desc.parameters = result.parameters.data();
      desc.parameter_count = result.parameters.size() / 4;
      float values[4] = {};
      uint32_t width = 0;
      char error[2048] = {};
      if (mt_material_graph_fold(&desc, values, &width, 1, error,
                                 sizeof error) == MT_OK &&
          width)
        uniform = GfVec3f(values[0], values[1], values[2]);
    }
    if (uniform && property != properties.end() && t.first != "normal") {
      result.values.push_back({property->second, *uniform});
      continue;
    }
    if (Id("terminals", t.first) == UINT32_MAX) {
      auto source = network.nodes.find(value.edge->upstreamNode);
      bool frame = source != network.nodes.end() &&
                   ((t.first == "coatNormal" &&
                     Kind(source->second).first == "normal") ||
                    ((t.first == "tangent" || t.first == "coatTangent") &&
                     Kind(source->second).first == "tangent"));
      auto space = source == network.nodes.end()
                       ? VtValue()
                       : Read(network, source->first, "space", "string").value;
      if (uniform && *uniform == GfVec3f(0) ||
          frame && String(space) == "world")
        continue;
      issue(value.edge->upstreamNode, t.first, "unsupported-terminal");
    }
    result.terminals.push_back(
        {Id("terminals", t.first), index,
         Id("outputs", value.edge->upstreamOutputName.GetString().empty()
                           ? "out"
                           : value.edge->upstreamOutputName.GetString())});
  }
  auto emission = std::find_if(
      result.values.begin(), result.values.end(),
      [](auto const &p) { return p.first == MT_MAT_EMISSION_LUMINANCE; });
  bool emissive = emission != result.values.end() && emission->second[0] > 0;
  for (auto const &terminal : result.terminals)
    if (terminal.port == MT_GRAPH_TERMINAL_EMISSION_COLOR ||
        terminal.port == MT_GRAPH_TERMINAL_EMISSION_LUMINANCE ||
        (emissive && (terminal.port == MT_GRAPH_TERMINAL_COAT_COLOR ||
                      terminal.port == MT_GRAPH_TERMINAL_COAT_WEIGHT))) {
      issue(rootPath, "",
            "unsupported-emission-graph: lit emission uses the constant "
            "material fallback");
      break;
    }
  auto weight = std::find_if(
      result.values.begin(), result.values.end(),
      [](auto const &p) { return p.first == MT_MAT_SPECULAR_WEIGHT; });
  if (weight != result.values.end() && weight->second[0] == 0)
    for (auto &p : result.values)
      if (p.first == MT_MAT_SPECULAR_IOR && p.second[0] <= 0)
        p.second = GfVec3f(1.5f, 0, 0);
  Prune(result);
  return result;
}
} // namespace mtHydra
PXR_NAMESPACE_CLOSE_SCOPE
