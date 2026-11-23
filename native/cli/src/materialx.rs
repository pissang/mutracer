use crate::{
    assets::Assets,
    error::{Error, Result},
    shot::{Channel, MaterialValue},
};
use mutracer_native::scene_api::{
    GraphInput, GraphNode, GraphTerminal, MaterialGraph, OpenPbrMaterial, Scene,
    graph_schema::{category as c, port as p, port_type as pt, source as src},
};
use quick_xml::{
    Reader, XmlVersion,
    events::{BytesStart, Event},
};
use serde::Deserialize;
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::File,
    io::Read,
    path::Path,
    sync::{Arc, OnceLock},
};

const XML_LIMIT: u64 = 8 * 1024 * 1024;

struct Element {
    tag: String,
    attributes: BTreeMap<String, String>,
    children: Vec<usize>,
    parent: Option<usize>,
}

impl Element {
    fn attr(&self, key: &str) -> Option<&str> {
        self.attributes.get(key).map(String::as_str)
    }
}

type Parse<T> = std::result::Result<T, String>;

fn read_tree(text: &str) -> Parse<Vec<Element>> {
    let mut reader = Reader::from_str(text);
    let mut stack: Vec<usize> = Vec::new();
    let decoder = reader.decoder();
    let mut result: Vec<Element> = Vec::new();
    let element = |start: BytesStart<'_>, parent: Option<usize>| -> Parse<Element> {
        let tag = std::str::from_utf8(start.name().as_ref())
            .map_err(|e| e.to_string())?
            .to_owned();
        let mut attributes = BTreeMap::new();
        for attr in start.attributes() {
            let attr = attr.map_err(|e| e.to_string())?;
            let key = std::str::from_utf8(attr.key.as_ref())
                .map_err(|e| e.to_string())?
                .to_owned();
            let value = attr
                .decoded_and_normalized_value(XmlVersion::Explicit1_0, decoder)
                .map_err(|e| e.to_string())?
                .into_owned();
            attributes.insert(key, value);
        }
        Ok(Element {
            tag,
            attributes,
            children: Vec::new(),
            parent,
        })
    };
    loop {
        let event = reader.read_event().map_err(|e| e.to_string())?;
        let empty = matches!(&event, Event::Empty(_));
        match event {
            Event::Start(start) | Event::Empty(start) => {
                let parent = stack.last().copied();
                let id = result.len();
                if id >= 65_536 || stack.len() >= 64 {
                    return Err("MaterialX document exceeds element or nesting limits".into());
                }
                if let Some(parent) = parent {
                    result.get_mut(parent).unwrap().children.push(id);
                } else if !result.is_empty() {
                    return Err("Multiple XML roots".into());
                }
                result.push(element(start, parent)?);
                if !empty {
                    stack.push(id);
                }
            }
            Event::End(_) => {
                if stack.pop().is_none() {
                    return Err("Unexpected end tag".into());
                }
            }
            Event::DocType(_) => return Err("MaterialX DTD declarations are unsupported".into()),
            Event::Eof => break,
            _ => {}
        }
    }
    if !stack.is_empty() || result.first().is_none_or(|node| node.tag != "materialx") {
        return Err("Expected a complete MaterialX document".into());
    }
    Ok(result)
}

fn width(ty: u32) -> usize {
    match ty {
        pt::VECTOR2 => 2,
        pt::COLOR3 | pt::VECTOR3 => 3,
        pt::COLOR4 | pt::VECTOR4 => 4,
        _ => 1,
    }
}
fn port_type(name: &str) -> Parse<u32> {
    Ok(match name {
        "float" => pt::FLOAT,
        "integer" => pt::INTEGER,
        "boolean" => pt::BOOLEAN,
        "color3" => pt::COLOR3,
        "color4" => pt::COLOR4,
        "vector2" => pt::VECTOR2,
        "vector3" => pt::VECTOR3,
        "vector4" => pt::VECTOR4,
        "filename" => pt::FILENAME,
        "string" => pt::STRING,
        _ => return Err(format!("Unsupported type {name:?}")),
    })
}
fn literal(value: &str, ty: u32) -> Parse<[f32; 4]> {
    if ty == pt::BOOLEAN {
        return match value {
            "true" | "1" => Ok([1., 0., 0., 0.]),
            "false" | "0" => Ok([0.; 4]),
            _ => Err(format!("Invalid boolean {value:?}")),
        };
    }
    let parts = value
        .split(',')
        .map(|part| part.trim().parse::<f32>())
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    if parts.len() != width(ty)
        || parts.iter().any(|x| !x.is_finite())
        || ty == pt::INTEGER && (parts[0].fract() != 0. || parts[0].abs() > 16_777_216.)
    {
        return Err(format!("Invalid MaterialX value {value:?}"));
    }
    let mut packed = [0.; 4];
    packed[..parts.len()].copy_from_slice(&parts);
    Ok(packed)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GraphSchema {
    categories: Vec<String>,
    types: Vec<String>,
    ports: Vec<String>,
    terminals: Vec<String>,
    outputs: Vec<String>,
    geometry: Vec<String>,
    terminal_types: BTreeMap<String, String>,
    definitions: BTreeMap<String, NodeDefinition>,
    inactive_image_inputs: BTreeMap<String, Value>,
    inactive_lobes: BTreeMap<String, Vec<String>>,
    surfaces: BTreeMap<String, BTreeMap<String, (String, String, Option<Value>)>>,
    standard_surface: Prototype,
}

#[derive(Deserialize)]
struct Prototype {
    tag: String,
    attrs: BTreeMap<String, String>,
    children: Vec<Prototype>,
}

#[derive(Deserialize)]
struct NodeDefinition {
    base: BTreeMap<String, PortDefinition>,
    overrides: BTreeMap<String, BTreeMap<String, PortDefinition>>,
}

#[derive(Clone, Deserialize)]
struct PortDefinition {
    #[serde(rename = "type")]
    ty: String,
    value: Option<Value>,
}

fn schema() -> &'static GraphSchema {
    static SCHEMA: OnceLock<GraphSchema> = OnceLock::new();
    SCHEMA.get_or_init(|| {
        // The Hydra importer and CLI use the same data generated from nodeInputs
        // and the graph IR. The include stores JSON in adjacent C++ literals.
        let text: String = include_str!("../../integrations/hydra/materialGraphSchema.inc")
            .lines()
            .filter_map(|line| line.strip_prefix("R\"MT_GRAPH("))
            .map(|line| {
                line.strip_suffix(")MT_GRAPH\",")
                    .expect("graph schema chunk")
            })
            .collect();
        serde_json::from_str(&text).expect("generated material graph schema")
    })
}

fn index(names: &[String], name: &str) -> Parse<u32> {
    names
        .iter()
        .position(|n| n == name)
        .map(|i| i as u32)
        .ok_or_else(|| format!("Unsupported graph identifier {name:?}"))
}

fn default_literal(value: &Value, ty: u32) -> Parse<[f32; 4]> {
    if let Some(items) = value.as_array() {
        return literal(
            &items
                .iter()
                .map(Value::to_string)
                .collect::<Vec<_>>()
                .join(","),
            ty,
        );
    }
    literal(&value.to_string(), ty)
}

fn camel_case(name: &str) -> String {
    let mut words = name.split('_');
    let mut result = words.next().unwrap_or_default().to_owned();
    for word in words {
        let mut chars = word.chars();
        if let Some(first) = chars.next() {
            result.extend(first.to_uppercase());
            result.extend(chars);
        }
    }
    result
}

#[derive(Clone, Copy)]
struct Binding {
    slot: usize,
    ty: u32,
    node: u32,
}

pub struct MaterialBindings {
    by_name: BTreeMap<String, Binding>,
}
impl MaterialBindings {
    pub fn update(
        &self,
        graph: &mut MaterialGraph,
        inputs: &BTreeMap<String, Channel<MaterialValue>>,
        t: f64,
        pointer: &str,
    ) -> Result<()> {
        for (name, channel) in inputs {
            let path = format!("{pointer}/{}", crate::error::escape(name));
            let b = self.by_name.get(name).ok_or_else(|| {
                Error::validation(
                    &path,
                    format!("Unknown or ambiguous MaterialX interface {name:?}"),
                    "Use a connected interface name or graph/input.",
                )
            })?;
            let (value, n) = channel.at(t).packed();
            if n != width(b.ty)
                || b.ty == pt::BOOLEAN && !matches!(value[0], 0. | 1.)
                || b.ty == pt::INTEGER && value[0].fract() != 0.
            {
                return Err(Error::validation(
                    &path,
                    "Value shape or type does not match the MaterialX interface",
                    "Use the same component count and numeric type as the interface.",
                ));
            }
            graph.parameters[b.slot] = value;
        }
        Ok(())
    }
}

struct Compiler<'a> {
    elements: Vec<Element>,
    graph: MaterialGraph,
    nodes: BTreeMap<usize, (u32, u32)>,
    active: BTreeSet<usize>,
    binding_by_element: BTreeMap<usize, Binding>,
    bindings: BTreeMap<String, Binding>,
    ambiguous: BTreeSet<String>,
    translation: Option<(usize, usize, usize)>,
    file: &'a Path,
    pointer: &'a str,
    assets: &'a mut Assets,
    scene: &'a mut Scene,
}

type Input = (u32, u32, u32);

impl Compiler<'_> {
    fn input(&self, node: usize, tag: &str, name: &str) -> Option<usize> {
        self.elements[node].children.iter().copied().find(|&id| {
            self.elements[id].tag == tag && self.elements[id].attr("name") == Some(name)
        })
    }
    fn named(&self, node: usize, name: &str) -> Option<usize> {
        self.elements[node].children.iter().copied().find(|&id| {
            !matches!(self.elements[id].tag.as_str(), "input" | "output")
                && self.elements[id].attr("name") == Some(name)
        })
    }
    fn parameter(&mut self, value: [f32; 4]) -> Input {
        let index = self.graph.parameters.len() as u32;
        self.graph.parameters.push(value);
        (src::PARAMETER, index, 0)
    }
    fn author_id(&self, id: usize) -> String {
        let element = &self.elements[id];
        let name = element.attr("name").unwrap_or(&element.tag);
        match element.parent {
            Some(parent) if parent != 0 => format!("{}/{name}", self.author_id(parent)),
            _ => name.to_owned(),
        }
    }

    fn inherited(&self, mut id: usize, name: &str) -> Option<&str> {
        loop {
            let element = &self.elements[id];
            if let Some(value) = element.attr(name).filter(|value| !value.is_empty()) {
                return Some(value);
            }
            id = element.parent?;
        }
    }

    fn located(&self, node: usize, message: impl std::fmt::Display) -> String {
        let element = &self.elements[node];
        format!(
            "{} ({}): {message}",
            element.attr("name").unwrap_or(&element.tag),
            element.tag
        )
    }
    fn reference(&self, node: usize) -> Parse<Option<usize>> {
        let element = &self.elements[node];
        if let Some(name) = element.attr("nodename") {
            let mut scope = element.parent;
            while let Some(id) = scope {
                if let Some(node) = self.named(id, name) {
                    return Ok(Some(node));
                }
                scope = self.elements[id].parent;
            }
            return Err(self.located(node, format!("Unknown node {name:?}")));
        }
        Ok(None)
    }
    fn resolve(&mut self, node: usize, ty: u32, depth: usize) -> Parse<Input> {
        if depth > 64 {
            return Err(self.located(node, "graph dependency depth exceeds 64"));
        }
        let e = &self.elements[node];
        if let Some(actual) = e.attr("type") {
            if port_type(actual)? != ty {
                return Err(
                    self.located(node, "connection type differs from the expected port type")
                );
            }
        }
        if let Some(name) = e.attr("interfacename") {
            let mut scope = e.parent;
            while let Some(id) = scope {
                if self.elements[id].tag == "nodegraph" {
                    if let Some((graph, defaults, shader)) = self.translation
                        && id == graph
                    {
                        let input = self
                            .input(shader, "input", name)
                            .or_else(|| self.input(defaults, "input", name))
                            .ok_or_else(|| {
                                self.located(node, format!("Unknown translation input {name:?}"))
                            })?;
                        return self.resolve(input, ty, depth + 1);
                    }
                    let element = self
                        .input(id, "input", name)
                        .ok_or_else(|| self.located(node, format!("Unknown interface {name:?}")))?;
                    if let Some(b) = self.binding_by_element.get(&element) {
                        if b.ty != ty {
                            return Err(self.located(node, "interface type mismatch"));
                        }
                        return Ok((src::NODE, b.node, 0));
                    }
                    let spec = &self.elements[element];
                    if spec
                        .attr("type")
                        .map(port_type)
                        .transpose()?
                        .is_some_and(|t| t != ty)
                    {
                        return Err(self.located(element, "interface type mismatch"));
                    }
                    let value = literal(
                        spec.attr("value").ok_or_else(|| {
                            self.located(element, "interface needs a numeric default")
                        })?,
                        ty,
                    )?;
                    let name = name.to_owned();
                    let qualified = format!(
                        "{}/{}",
                        self.elements[id].attr("name").unwrap_or("graph"),
                        name
                    );
                    let source = self.parameter(value);
                    let label = self.elements[element]
                        .attr("uiname")
                        .unwrap_or(&name)
                        .replace('/', " ");
                    let node = self.push(
                        c::CONSTANT,
                        ty,
                        format!("{}/interface/{}", self.author_id(id), label.trim()),
                        vec![(p::VALUE, ty, source)],
                    );
                    let entry = Binding {
                        slot: source.1 as usize,
                        ty,
                        node,
                    };
                    self.binding_by_element.insert(element, entry);
                    self.bindings.insert(qualified, entry);
                    if !self.ambiguous.contains(&name)
                        && self.bindings.insert(name.clone(), entry).is_some()
                    {
                        self.bindings.remove(&name);
                        self.ambiguous.insert(name);
                    }
                    return Ok((src::NODE, entry.node, 0));
                }
                scope = self.elements[id].parent;
            }
            return Err(self.located(node, "interface reference must be inside a nodegraph"));
        }
        if let Some(name) = e.attr("nodegraph") {
            let graph = self
                .named(0, name)
                .ok_or_else(|| self.located(node, format!("Unknown nodegraph {name:?}")))?;
            let output = match e.attr("output") {
                Some(name) => self.input(graph, "output", name),
                None => self.elements[graph]
                    .children
                    .iter()
                    .copied()
                    .find(|&i| self.elements[i].tag == "output"),
            }
            .ok_or_else(|| self.located(node, "nodegraph output is missing"))?;
            return self.resolve(output, ty, depth + 1);
        }
        if let Some(target) = self.reference(node)? {
            if e.attr("channels").is_some() {
                return Err(self.located(node, "channel swizzles are unsupported"));
            }
            let target_tag = self.elements[target].tag.clone();
            let output = e.attr("output").unwrap_or("out").to_owned();
            let (target, actual) = self.compile_node(target, depth + 1)?;
            let output_type = match target_tag.as_str() {
                "gltf_colorimage" if output == "outcolor" => pt::COLOR3,
                "gltf_colorimage" if output == "outa" => pt::FLOAT,
                "separate2" | "separate3" | "separate4" if output != "out" => pt::FLOAT,
                _ if output == "out" => actual,
                _ => return Err(self.located(node, "unsupported source output")),
            };
            if ty != output_type {
                return Err(self.located(node, "source node type mismatch"));
            }
            return Ok((src::NODE, target, index(&schema().outputs, &output)?));
        }
        let value = e
            .attr("value")
            .ok_or_else(|| self.located(node, "missing value or source connection"))?;
        Ok(self.parameter(literal(value, ty)?))
    }
    fn push(&mut self, cat: u32, ty: u32, id: String, ports: Vec<(u32, u32, Input)>) -> u32 {
        let index = self.graph.nodes.len() as u32;
        self.graph.nodes.push(GraphNode {
            category: cat,
            implementation: 1,
            port_type: ty,
            first_input: self.graph.inputs.len() as u32,
            input_count: ports.len() as u32,
        });
        self.graph.author_ids.push(id);
        self.graph.inputs.extend(ports.into_iter().map(
            |(port, port_type, (source_kind, source, output))| GraphInput {
                port,
                port_type,
                source_kind,
                source,
                output,
            },
        ));
        index
    }
    fn compile_node(&mut self, id: usize, depth: usize) -> Parse<(u32, u32)> {
        if let Some(&node) = self.nodes.get(&id) {
            return Ok(node);
        }
        if self.graph.nodes.len() >= 4096 || !self.active.insert(id) {
            return Err(self.located(id, "cycle or graph complexity limit"));
        }
        let shared = schema();
        let node = &self.elements[id];
        let mut tag = node.tag.as_str();
        if tag == "absval" {
            tag = "abs";
        }
        let mut authored = BTreeMap::new();
        let legacy = self.elements[0]
            .attr("version")
            .and_then(|version| version.split('.').nth(1))
            .and_then(|minor| minor.parse::<u32>().ok())
            .is_some_and(|minor| minor < 39);
        for &child in &node.children {
            let input = &self.elements[child];
            if input.tag != "input" {
                continue;
            }
            let mut name = input.attr("name").unwrap_or_default();
            if legacy && tag == "atan2" {
                name = match name {
                    "in1" => "iny",
                    "in2" => "inx",
                    _ => name,
                };
            }
            if shared
                .inactive_image_inputs
                .get(name)
                .is_some_and(|default| {
                    input.attr("value").is_some_and(|value| {
                        default.as_str() == Some(value) || default.to_string() == value
                    })
                })
            {
                continue;
            }
            authored.insert(name.to_owned(), child);
        }
        let type_name = match (tag, node.attr("type").unwrap_or("float")) {
            ("gltf_colorimage", "multioutput") => "color4",
            (_, "multioutput") => authored
                .get("in")
                .and_then(|&i| self.elements[i].attr("type"))
                .unwrap_or("vector3"),
            (_, ty) => ty,
        };
        let color_image = type_name.starts_with("color");
        let ty = index(&shared.types, type_name)?;
        let cat = index(&shared.categories, tag).map_err(|e| self.located(id, e))?;
        let definition = shared
            .definitions
            .get(&format!("{tag}/{type_name}"))
            .ok_or_else(|| self.located(id, format!("Unsupported node type {tag}/{type_name}")))?;
        let mut ports = definition.base.clone();
        for (name, &child) in &authored {
            if !ports.contains_key(name) {
                return Err(self.located(child, format!("Unsupported input {name:?}")));
            }
            if let Some(ty) = self.elements[child].attr("type") {
                if tag == "dotproduct" && name == "in2" && authored.contains_key("in1") {
                    continue;
                }
                if let Some(overrides) = definition.overrides.get(&format!("{name}/{ty}")) {
                    ports.extend(overrides.clone());
                }
            }
        }
        let mut inputs = Vec::with_capacity(ports.len());
        for (name, def) in ports {
            let port = index(&shared.ports, &name)?;
            let ty = port_type(&def.ty)?;
            let input = authored.get(&name).copied();
            let source = match (ty, input, def.value.as_ref()) {
                (pt::FILENAME, Some(input), _) => {
                    let path = self.elements[input]
                        .attr("value")
                        .ok_or_else(|| self.located(input, "image file must be a literal path"))?;
                    let prefix = self.inherited(input, "fileprefix").unwrap_or_default();
                    let resolved = self
                        .file
                        .parent()
                        .unwrap_or(Path::new("."))
                        .join(format!("{prefix}{path}"));
                    let mut texture = self
                        .assets
                        .image(&resolved, self.pointer, false)
                        .map_err(|e| e.to_string())?;
                    texture.wrap = ["uaddressmode", "vaddressmode"].map(|axis| {
                        match authored
                            .get(axis)
                            .and_then(|&i| self.elements[i].attr("value"))
                        {
                            Some("clamp") => 1,
                            Some("mirror") => 2,
                            _ => 0,
                        }
                    });
                    let colorspace = self.inherited(input, "colorspace");
                    if !color_image
                        || matches!(
                            colorspace,
                            Some("lin_rec709" | "lin_rec709_scene" | "linear")
                        )
                    {
                        if let mutracer_native::scene_api::TexturePixels::Rgba8(pixels) =
                            texture.pixels
                        {
                            texture.pixels =
                                mutracer_native::scene_api::TexturePixels::Rgba32F(Arc::from(
                                    pixels
                                        .iter()
                                        .map(|&byte| f32::from(byte) / 255.)
                                        .collect::<Vec<_>>(),
                                ));
                        }
                    }
                    let tex = self.scene.add_texture(texture).map_err(|e| e.to_string())?;
                    let slot = self.graph.textures.len();
                    self.graph.textures.push(Some(tex));
                    self.parameter([slot as f32, 0., 0., 0.])
                }
                (pt::FILENAME, None, _) => self.parameter([-1., 0., 0., 0.]),
                (pt::STRING, _, default) => {
                    let value = input
                        .and_then(|i| self.elements[i].attr("value"))
                        .or_else(|| default.and_then(Value::as_str))
                        .unwrap_or_default();
                    let encoded = match (name.as_str(), value) {
                        ("space" | "fromspace" | "tospace", "world") => 1.,
                        ("space" | "fromspace" | "tospace", "object") => 0.,
                        ("fromspace" | "tospace", "") => -1.,
                        ("uaddressmode" | "vaddressmode", "periodic" | "clamp" | "mirror") => 0.,
                        ("filtertype", "linear") | ("note", _) => 0.,
                        _ => {
                            return Err(self.located(
                                input.unwrap_or(id),
                                format!("Unsupported {name} value {value:?}"),
                            ));
                        }
                    };
                    self.parameter([encoded, 0., 0., 0.])
                }
                (_, Some(input), _) => self.resolve(input, ty, depth + 1)?,
                (_, None, Some(value)) => self.parameter(default_literal(value, ty)?),
                (_, None, None) => {
                    let geometry = if name == "position" {
                        "objectPosition"
                    } else {
                        &name
                    };
                    (src::GEOMETRY, index(&shared.geometry, geometry)?, 0)
                }
            };
            inputs.push((port, ty, source));
        }
        let node = (self.push(cat, ty, self.author_id(id), inputs), ty);
        self.active.remove(&id);
        self.nodes.insert(id, node);
        Ok(node)
    }

    fn insert_prototype(&mut self, prototype: &Prototype, parent: usize) -> usize {
        let id = self.elements.len();
        self.elements.push(Element {
            tag: prototype.tag.clone(),
            attributes: prototype.attrs.clone(),
            children: Vec::new(),
            parent: Some(parent),
        });
        self.elements[parent].children.push(id);
        for child in &prototype.children {
            self.insert_prototype(child, id);
        }
        id
    }

    fn default_port(&mut self, parent: usize, ty: &str, default: &Value) -> usize {
        let value = default.as_array().map_or_else(
            || default.to_string(),
            |items| {
                items
                    .iter()
                    .map(Value::to_string)
                    .collect::<Vec<_>>()
                    .join(",")
            },
        );
        self.insert_prototype(
            &Prototype {
                tag: "input".into(),
                attrs: BTreeMap::from([("type".into(), ty.into()), ("value".into(), value)]),
                children: Vec::new(),
            },
            parent,
        )
    }

    fn write_uniform(
        &self,
        material: &mut OpenPbrMaterial,
        id: usize,
        property: u32,
        ty: u32,
        value: [f32; 4],
    ) -> Parse<()> {
        let [x, y, z, _] = value;
        if matches!(property, 4 | 7 | 10 | 25 | 27 | 36) && !(0. ..=1.).contains(&x)
            || property == 8 && x < 1.
        {
            return Err(self.located(id, "MaterialX value exceeds the native surface range"));
        }
        let result = if ty == pt::BOOLEAN {
            material.set_uint(property, x as u32)
        } else {
            material.set_float(property, [x, y, z])
        };
        result.map_err(|e| self.located(id, e))
    }

    fn fold(&mut self, source: Input, ty: u32, id: usize) -> Parse<Option<[f32; 4]>> {
        if source.0 == src::PARAMETER {
            return Ok(Some(self.graph.parameters[source.1 as usize]));
        }
        let probe = match ty {
            pt::FLOAT | pt::BOOLEAN => "specularRoughness",
            pt::COLOR3 => "baseColor",
            _ => return Ok(None),
        };
        let mut graph = self.graph.clone();
        let (node, output) = if ty == pt::BOOLEAN {
            let index = graph.nodes.len() as u32;
            graph.nodes.push(GraphNode {
                category: c::CONVERT,
                implementation: 1,
                port_type: pt::FLOAT,
                first_input: graph.inputs.len() as u32,
                input_count: 1,
            });
            graph
                .author_ids
                .push(format!("{}/fold", self.author_id(id)));
            graph.inputs.push(GraphInput {
                port: p::IN,
                port_type: ty,
                source_kind: source.0,
                source: source.1,
                output: source.2,
            });
            (index, 0)
        } else {
            (source.1, source.2)
        };
        graph.terminals = vec![GraphTerminal {
            port: index(&schema().terminals, probe)?,
            node,
            output,
        }];
        let folded = graph
            .fold_constants()
            .map_err(|error| self.located(id, error))?;
        Ok(folded.into_iter().next().flatten().map(|values| {
            let mut value = [0.; 4];
            value[..values.len()].copy_from_slice(&values);
            value
        }))
    }

    fn surface_inputs(
        &mut self,
        shader: usize,
        material: &mut OpenPbrMaterial,
    ) -> Parse<BTreeMap<String, usize>> {
        let shared = schema();
        let mut inputs = BTreeMap::new();
        let tag = self.elements[shader].tag.clone();
        let mut handled = BTreeSet::new();
        let ports = match tag.as_str() {
            "open_pbr_surface" => self.elements[shader].children.clone(),
            "standard_surface" => {
                let defaults = shared
                    .standard_surface
                    .children
                    .iter()
                    .find(|e| e.tag == "nodedef")
                    .expect("translation defaults");
                let graph = shared
                    .standard_surface
                    .children
                    .iter()
                    .find(|e| e.tag == "nodegraph")
                    .expect("translation graph");
                let defaults = self.insert_prototype(defaults, 0);
                let graph = self.insert_prototype(graph, 0);
                self.translation = Some((graph, defaults, shader));
                if let Some(normal) = self.input(shader, "input", "normal") {
                    inputs.insert("normal".into(), normal);
                }
                self.elements[graph].children.clone()
            }
            "gltf_pbr" | "UsdPreviewSurface" => {
                let gltf = tag == "gltf_pbr";
                let mapping = &shared.surfaces[if gltf { "gltf" } else { "usd" }];
                for (key, (name, ty, default)) in mapping {
                    handled.insert(name.as_str());
                    if let Some(id) = self.input(shader, "input", name).or_else(|| {
                        default
                            .as_ref()
                            .map(|value| self.default_port(shader, ty, value))
                    }) {
                        inputs.insert(key.clone(), id);
                    }
                }
                material
                    .set_float(29, [1.5, 0., 0.])
                    .map_err(|e| self.located(shader, e))?;
                material
                    .set_float(35, [1., 0., 0.])
                    .map_err(|e| self.located(shader, e))?;
                let properties: &[(&str, &str)] = if gltf {
                    &[
                        ("alpha_cutoff", "alphaCutoff"),
                        ("attenuation_color", "transmissionColor"),
                        ("attenuation_distance", "transmissionDepth"),
                        ("emissive_strength", "emissionLuminance"),
                    ]
                } else {
                    &[("opacityThreshold", "alphaCutoff")]
                };
                for &(name, key) in properties {
                    handled.insert(name);
                    if let Some(id) = self.input(shader, "input", name) {
                        inputs.insert(key.into(), id);
                    }
                }
                if gltf {
                    let mode = self
                        .input(shader, "input", "alpha_mode")
                        .and_then(|id| self.elements[id].attr("value"))
                        .unwrap_or("0");
                    let mode = match mode {
                        "0" => 1,
                        "1" => 2,
                        "2" => 3,
                        _ => return Err(self.located(shader, "unsupported alpha_mode")),
                    };
                    material
                        .set_uint(41, mode)
                        .map_err(|e| self.located(shader, e))?;
                    handled.insert("alpha_mode");
                    if !inputs.contains_key("alphaCutoff") {
                        material
                            .set_float(42, [0.5, 0., 0.])
                            .map_err(|e| self.located(shader, e))?;
                    }
                    if let Some(id) = self.input(shader, "input", "thickness") {
                        let value = self.elements[id]
                            .attr("value")
                            .and_then(|n| n.parse::<f32>().ok())
                            .ok_or_else(|| {
                                self.located(id, "glTF volume thickness must be uniform")
                            })?;
                        material
                            .set_uint(37, u32::from(value <= 0.))
                            .map_err(|e| self.located(id, e))?;
                        handled.insert("thickness");
                    }
                    if let Some(id) = self.input(shader, "input", "iridescence_thickness") {
                        let value = self.elements[id]
                            .attr("value")
                            .and_then(|n| n.parse::<f32>().ok())
                            .ok_or_else(|| {
                                self.located(id, "glTF iridescence thickness must be uniform")
                            })?;
                        material
                            .set_float(32, [value * 0.001, 0., 0.])
                            .map_err(|e| self.located(id, e))?;
                        handled.insert("iridescence_thickness");
                    }
                } else {
                    for name in ["useSpecularWorkflow", "opacityMode"] {
                        if let Some(id) = self.input(shader, "input", name)
                            && self.elements[id].attr("value") != Some("0")
                        {
                            return Err(self.located(id, format!("Unsupported {name}")));
                        }
                        handled.insert(name);
                    }
                    handled.insert("specularColor");
                }
                for name in ["occlusion", "displacement"] {
                    if let Some(id) = self.input(shader, "input", name) {
                        let default = if name == "occlusion" { "1" } else { "0" };
                        if self.elements[id]
                            .attr("value")
                            .and_then(|v| v.parse::<f32>().ok())
                            == default.parse::<f32>().ok()
                            && self.elements[id].attr("value").is_some()
                        {
                            handled.insert(name);
                        }
                    }
                }
                for &id in &self.elements[shader].children {
                    if let Some(name) = self.elements[id].attr("name")
                        && self.elements[id].tag == "input"
                        && !handled.contains(name)
                        && !inputs.values().any(|&i| i == id)
                    {
                        return Err(self.located(id, format!("Unsupported {tag} input {name:?}")));
                    }
                }
                return Ok(inputs);
            }
            _ => return Err(self.located(shader, format!("Unsupported MaterialX surface {tag}"))),
        };
        for id in ports {
            let input = &self.elements[id];
            if !matches!(input.tag.as_str(), "input" | "output") {
                continue;
            }
            let author = input.attr("name").unwrap_or_default();
            let author = if input.tag == "output" {
                author.trim_end_matches("_out")
            } else {
                author
            };
            let key = match author {
                "base" => "baseWeight".into(),
                "specular" => "specularWeight".into(),
                "transmission" => "transmissionWeight".into(),
                "subsurface" => "subsurfaceWeight".into(),
                "coat" => "coatWeight".into(),
                "fuzz" => "fuzzWeight".into(),
                "thin_film" => "thinFilmWeight".into(),
                "geometry_normal" => "normal".into(),
                "geometry_opacity" => "opacity".into(),
                "specular_roughness_anisotropy" => "specularAnisotropy".into(),
                "coat_roughness_anisotropy" => "coatAnisotropy".into(),
                _ => camel_case(author),
            };
            if inputs.insert(key, id).is_some() {
                return Err(self.located(id, "duplicate OpenPBR input"));
            }
        }
        Ok(inputs)
    }

    fn surface(&mut self, material: &mut OpenPbrMaterial) -> Parse<()> {
        let surface = self.elements[0]
            .children
            .iter()
            .copied()
            .find(|&id| self.elements[id].tag == "surfacematerial")
            .ok_or("Missing surfacematerial")?;
        let shader = self
            .input(surface, "input", "surfaceshader")
            .ok_or("Missing surfaceshader input")?;
        let shader = self
            .reference(shader)?
            .ok_or("The surfaceshader input needs a nodename")?;
        let mut inputs = self.surface_inputs(shader, material)?;
        let shared = schema();
        for (weight, inactive) in &shared.inactive_lobes {
            let varies = inactive.iter().any(|key| {
                inputs.get(key).is_some_and(|input| {
                    ["nodename", "nodegraph", "interfacename"]
                        .into_iter()
                        .any(|a| self.elements[*input].attr(a).is_some())
                })
            });
            if varies && let Some(&id) = inputs.get(weight) {
                let value = self.resolve(id, pt::FLOAT, 0)?;
                if self
                    .fold(value, pt::FLOAT, id)?
                    .is_some_and(|value| value[0] == 0.)
                {
                    for key in inactive {
                        if let Some(input) = inputs.get(key)
                            && ["nodename", "nodegraph", "interfacename"]
                                .into_iter()
                                .any(|attribute| self.elements[*input].attr(attribute).is_some())
                        {
                            inputs.remove(key);
                        }
                    }
                }
            }
        }
        for (key, id) in inputs {
            let input = &self.elements[id];
            let property = crate::material::numeric_property(&key);
            let graph_type = shared.terminal_types.get(&key);
            let type_name = property
                .map(|(_, ty)| ty)
                .or(graph_type.map(String::as_str))
                .ok_or_else(|| self.located(id, format!("Unsupported OpenPBR input {key:?}")))?;
            let ty = port_type(type_name)?;
            let linked = ["nodename", "nodegraph", "interfacename"]
                .into_iter()
                .any(|key| input.attr(key).is_some());
            if !linked && let Some((property, _)) = property {
                let value = literal(
                    input
                        .attr("value")
                        .ok_or_else(|| self.located(id, "missing value"))?,
                    ty,
                )?;
                self.write_uniform(material, id, property, ty, value)?;
            } else {
                let source = self.resolve(id, ty, 0)?;
                let terminal = index(&shared.terminals, &key).ok();
                if let Some((property, _)) = property
                    && (terminal.is_none() || self.translation.is_some())
                    && let Some(value) = self.fold(source, ty, id)?
                {
                    self.write_uniform(material, id, property, ty, value)?;
                    continue;
                }
                let port = terminal.ok_or_else(|| {
                    self.located(id, "this surface field only supports uniform values")
                })?;
                let (node, output) = if source.0 == src::NODE {
                    (source.1, source.2)
                } else {
                    (
                        self.push(
                            c::CONSTANT,
                            ty,
                            format!("surface/value/{key}"),
                            vec![(p::VALUE, ty, source)],
                        ),
                        0,
                    )
                };
                self.graph
                    .terminals
                    .push(GraphTerminal { port, node, output });
            }
        }
        Ok(())
    }
}

fn compact_graph(
    source: &MaterialGraph,
    bindings: &mut BTreeMap<String, Binding>,
) -> MaterialGraph {
    struct Repack<'a> {
        source: &'a MaterialGraph,
        output: MaterialGraph,
        nodes: BTreeMap<u32, u32>,
        parameters: BTreeMap<u32, u32>,
    }
    impl Repack<'_> {
        fn node(&mut self, old: u32) -> u32 {
            if let Some(&node) = self.nodes.get(&old) {
                return node;
            }
            let mut record = self.source.nodes[old as usize];
            let first = record.first_input as usize;
            let ports = &self.source.inputs[first..first + record.input_count as usize];
            let mut inputs = Vec::with_capacity(ports.len());
            for &port in ports {
                let mut input = port;
                if input.source_kind == src::NODE {
                    input.source = self.node(input.source);
                } else if input.source_kind == src::PARAMETER {
                    input.source = *self.parameters.entry(input.source).or_insert_with(|| {
                        let index = self.output.parameters.len() as u32;
                        self.output
                            .parameters
                            .push(self.source.parameters[input.source as usize]);
                        index
                    });
                }
                inputs.push(input);
            }
            record.first_input = self.output.inputs.len() as u32;
            let node = self.output.nodes.len() as u32;
            self.output.nodes.push(record);
            self.output.inputs.extend(inputs);
            self.output
                .author_ids
                .push(self.source.author_ids[old as usize].clone());
            self.nodes.insert(old, node);
            node
        }
    }
    let mut out = Repack {
        source,
        output: MaterialGraph::default(),
        nodes: BTreeMap::new(),
        parameters: BTreeMap::new(),
    };
    for &terminal in &source.terminals {
        let node = out.node(terminal.node);
        out.output
            .terminals
            .push(GraphTerminal { node, ..terminal });
    }
    out.output.textures.clone_from(&source.textures);
    bindings.retain(|_, binding| {
        match (
            out.nodes.get(&binding.node),
            out.parameters.get(&(binding.slot as u32)),
        ) {
            (Some(&node), Some(&slot)) => {
                binding.node = node;
                binding.slot = slot as usize;
                true
            }
            _ => false,
        }
    });
    out.output
}

pub fn load(
    file: &Path,
    pointer: &str,
    assets: &mut Assets,
    scene: &mut Scene,
) -> Result<(OpenPbrMaterial, MaterialBindings)> {
    let mut text = String::new();
    File::open(file)
        .and_then(|f| f.take(XML_LIMIT + 1).read_to_string(&mut text))
        .map_err(|e| Error::asset(pointer, e.to_string()))?;
    if text.len() as u64 > XML_LIMIT {
        return Err(Error::budget("MaterialX XML exceeds 8 MiB"));
    }
    let elements =
        read_tree(&text).map_err(|e| Error::asset(pointer, format!("{}: {e}", file.display())))?;
    let mut compiler = Compiler {
        elements,
        graph: Default::default(),
        nodes: Default::default(),
        active: Default::default(),
        binding_by_element: Default::default(),
        bindings: Default::default(),
        ambiguous: Default::default(),
        translation: None,
        file,
        pointer,
        assets,
        scene,
    };
    let mut material = OpenPbrMaterial::default();
    compiler
        .surface(&mut material)
        .map_err(|e| Error::asset(pointer, format!("{}: {e}", file.display())))?;
    if !compiler.graph.terminals.is_empty() {
        material.graph = Some(if compiler.translation.is_some() {
            compact_graph(&compiler.graph, &mut compiler.bindings)
        } else {
            compiler.graph
        });
    }
    Ok((
        material,
        MaterialBindings {
            by_name: compiler.bindings,
        },
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Deserialize)]
    struct BrowserFixture {
        file: String,
        graph: Option<FlatGraph>,
        rejection: Option<String>,
        #[serde(default)]
        diagnostics: Vec<String>,
    }

    #[derive(Debug, Deserialize, PartialEq)]
    struct FlatGraph {
        nodes: Vec<u32>,
        inputs: Vec<u32>,
        terminal: Vec<u32>,
        parameters: Vec<f32>,
    }

    impl From<MaterialGraph> for FlatGraph {
        fn from(graph: MaterialGraph) -> Self {
            Self {
                nodes: graph
                    .nodes
                    .into_iter()
                    .flat_map(|node| {
                        [
                            node.category,
                            node.implementation,
                            node.port_type,
                            node.first_input,
                            node.input_count,
                        ]
                    })
                    .collect(),
                inputs: graph
                    .inputs
                    .into_iter()
                    .flat_map(|input| {
                        [
                            input.port,
                            input.port_type,
                            input.source_kind,
                            input.source,
                            input.output,
                        ]
                    })
                    .collect(),
                terminal: graph
                    .terminals
                    .into_iter()
                    .flat_map(|terminal| [terminal.port, terminal.node, terminal.output])
                    .collect(),
                parameters: graph.parameters.into_iter().flatten().collect(),
            }
        }
    }

    fn compile(file: &Path) -> Result<(OpenPbrMaterial, MaterialBindings)> {
        let shot = crate::shot::parse(
            br#"{
            "version":1, "output":{"duration":1},
            "objects":[{"name":"subject","shape":"sphere"}],
            "camera":{"position":[0,0,3],"target":"subject"}
        }"#,
        )
        .unwrap();
        let mut assets = Assets::load(&shot, file.parent().unwrap()).unwrap();
        load(file, "/material", &mut assets, &mut Scene::new())
    }

    fn compile_xml(xml: &str) -> Result<(OpenPbrMaterial, MaterialBindings)> {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.mtlx");
        std::fs::write(&path, xml).unwrap();
        compile(&path)
    }

    #[test]
    fn viewer_materials_match_browser_ir() {
        let directory =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../../viewer/src/assets/materialx");
        let fixtures: Vec<BrowserFixture> =
            serde_json::from_str(include_str!("../tests/fixtures/materialx-browser-ir.json"))
                .unwrap();
        let mut files: Vec<_> = std::fs::read_dir(&directory)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .filter(|file| file.ends_with(".mtlx"))
            .collect();
        files.sort();
        assert_eq!(
            files,
            fixtures
                .iter()
                .map(|row| row.file.clone())
                .collect::<Vec<_>>()
        );
        for row in fixtures {
            let result = compile(&directory.join(&row.file));
            if row.rejection.is_some() || !row.diagnostics.is_empty() {
                let Err(error) = result else {
                    panic!(
                        "{} accepted despite browser diagnostics: {:?} {:?}",
                        row.file, row.rejection, row.diagnostics
                    );
                };
                assert!(!error.message.is_empty(), "{}", row.file);
            } else {
                let (material, _) = result.unwrap_or_else(|error| panic!("{}: {error}", row.file));
                let actual = material.graph.map(FlatGraph::from);
                assert_eq!(actual, row.graph, "{}", row.file);
            }
        }
    }

    fn surface(shader: &str, nodes: &str, inputs: &str) -> String {
        format!(
            r#"<materialx>
            {nodes}
            <{shader} name="shader" type="surfaceshader">{inputs}</{shader}>
            <surfacematerial name="material" type="material">
              <input name="surfaceshader" type="surfaceshader" nodename="shader"/>
            </surfacematerial>
        </materialx>"#
        )
    }

    #[test]
    fn reports_unsupported_shader_and_node() {
        let shader = surface("unsupported_shader", "", "");
        let node = surface(
            "open_pbr_surface",
            r#"<unsupported_node name="mystery" type="float"/>"#,
            r#"<input name="specular_roughness" type="float" nodename="mystery"/>"#,
        );
        for (xml, expected) in [
            (shader, "Unsupported MaterialX surface unsupported_shader"),
            (node, r#"Unsupported graph identifier "unsupported_node""#),
        ] {
            let Err(error) = compile_xml(&xml) else {
                panic!("invalid material accepted")
            };
            assert!(error.message.contains(expected), "{error}");
        }
    }

    #[test]
    fn rejects_zero_ior_from_standard_surface_translation() {
        let xml = surface(
            "standard_surface",
            "",
            r#"<input name="specular_IOR" type="float" value="0"/>"#,
        );
        let Err(error) = compile_xml(&xml) else {
            panic!("zero IOR accepted")
        };
        assert!(error.message.contains("native surface range"), "{error}");
    }

    #[test]
    fn ambiguous_interface_requires_graph_and_input_name() {
        let make_graph = |name| {
            format!(
                r#"<nodegraph name="{name}">
            <input name="value" type="float" value="0.4"/>
            <output name="out" type="float" interfacename="value"/>
        </nodegraph>"#
            )
        };
        let xml = surface(
            "open_pbr_surface",
            &(make_graph("first") + &make_graph("second")),
            r#"<input name="specular_roughness" type="float" nodegraph="first"/>
               <input name="base_metalness" type="float" nodegraph="second"/>"#,
        );
        let (material, bindings) = compile_xml(&xml).unwrap();
        let mut graph = material.graph.unwrap();
        let inputs = |name: &str| serde_json::from_value(serde_json::json!({name: 0.8})).unwrap();
        let error = bindings
            .update(&mut graph, &inputs("value"), 0., "/inputs")
            .unwrap_err();
        assert_eq!(error.code, 2);
        assert!(error.message.contains("ambiguous"), "{error}");
        let before = graph.parameters.clone();
        for name in ["first/value", "second/value"] {
            bindings
                .update(&mut graph, &inputs(name), 0., "/inputs")
                .unwrap();
        }
        assert_eq!(graph.parameters, vec![[0.8, 0., 0., 0.]; 2]);
        assert_ne!(graph.parameters, before);
    }
}
