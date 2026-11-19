use crate::{
    assets::Assets,
    error::{Error, Result},
    shot::{Channel, MaterialValue},
};
use mutracer_native::scene_api::{
    GraphInput, GraphNode, GraphTerminal, MaterialGraph, OpenPbrMaterial, Scene,
    graph_schema::{
        category as c, geometry as geo, port as p, port_type as pt, source as src, terminal as term,
    },
};
use quick_xml::{
    Reader, XmlVersion,
    events::{BytesStart, Event},
};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::File,
    io::Read,
    path::Path,
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

#[derive(Clone, Copy)]
struct Binding {
    slot: usize,
    ty: u32,
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
    file: &'a Path,
    pointer: &'a str,
    assets: &'a mut Assets,
    scene: &'a mut Scene,
}

type Input = (u32, u32, u32);
struct Port(&'static str, u32, u32, Input);

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
                    let element = self
                        .input(id, "input", name)
                        .ok_or_else(|| self.located(node, format!("Unknown interface {name:?}")))?;
                    if let Some(b) = self.binding_by_element.get(&element) {
                        if b.ty != ty {
                            return Err(self.located(node, "interface type mismatch"));
                        }
                        return Ok((src::PARAMETER, b.slot as u32, 0));
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
                    let entry = Binding {
                        slot: self.parameter(value).1 as usize,
                        ty,
                    };
                    self.binding_by_element.insert(element, entry);
                    self.bindings.insert(qualified, entry);
                    if !self.ambiguous.contains(&name)
                        && self.bindings.insert(name.clone(), entry).is_some()
                    {
                        self.bindings.remove(&name);
                        self.ambiguous.insert(name);
                    }
                    return Ok((src::PARAMETER, entry.slot as u32, 0));
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
            if e.attr("output").is_some_and(|name| name != "out") || e.attr("channels").is_some() {
                return Err(self.located(
                    node,
                    "named sub-outputs and channel swizzles are unsupported",
                ));
            }
            let (target, actual) = self.compile_node(target, depth + 1)?;
            if ty != actual {
                return Err(self.located(node, "source node type mismatch"));
            }
            return Ok((src::NODE, target, 0));
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
        let node = &self.elements[id];
        let ty = port_type(node.attr("type").unwrap_or("float"))?;
        let name = node.attr("name").unwrap_or(&node.tag).to_owned();
        let tag = node.tag.clone();
        let zero = [0.; 4];
        let one = std::array::from_fn(|i| if i < width(ty) { 1. } else { 0. });
        let value = |value| (src::PARAMETER, u32::MAX, value);
        let (cat, ports) = match tag.as_str() {
            "constant" => (c::CONSTANT, vec![Port("value", p::VALUE, ty, value(0))]),
            "mix" => (
                c::MIX,
                vec![
                    Port("bg", p::BG, ty, value(0)),
                    Port("fg", p::FG, ty, value(0)),
                    Port("mix", p::MIX, pt::FLOAT, value(0)),
                ],
            ),
            "add" | "subtract" | "multiply" | "divide" | "min" | "max" | "power" => {
                let cat = match tag.as_str() {
                    "add" => c::ADD,
                    "subtract" => c::SUBTRACT,
                    "multiply" => c::MULTIPLY,
                    "divide" => c::DIVIDE,
                    "min" => c::MIN,
                    "max" => c::MAX,
                    _ => c::POWER,
                };
                (
                    cat,
                    vec![
                        Port("in1", p::IN1, ty, value(0)),
                        Port(
                            "in2",
                            p::IN2,
                            ty,
                            value(u32::from(matches!(
                                tag.as_str(),
                                "multiply" | "divide" | "power"
                            ))),
                        ),
                    ],
                )
            }
            "noise2d" | "noise3d" => {
                let (cat, coord) = if tag == "noise2d" {
                    (
                        c::NOISE2D,
                        Port(
                            "texcoord",
                            p::TEXCOORD,
                            pt::VECTOR2,
                            (src::GEOMETRY, geo::TEXCOORD, 0),
                        ),
                    )
                } else {
                    (
                        c::NOISE3D,
                        Port(
                            "position",
                            p::POSITION,
                            pt::VECTOR3,
                            (src::GEOMETRY, geo::OBJECT_POSITION, 0),
                        ),
                    )
                };
                (
                    cat,
                    vec![
                        coord,
                        Port("amplitude", p::AMPLITUDE, ty, value(1)),
                        Port("pivot", p::PIVOT, pt::FLOAT, value(0)),
                    ],
                )
            }
            "image" => (
                c::IMAGE,
                vec![
                    Port("file", p::FILE, pt::FILENAME, value(0)),
                    Port("default", p::DEFAULT, ty, value(0)),
                    Port(
                        "texcoord",
                        p::TEXCOORD,
                        pt::VECTOR2,
                        (src::GEOMETRY, geo::TEXCOORD, 0),
                    ),
                    Port("filtertype", p::FILTERTYPE, pt::STRING, value(0)),
                    Port("uaddressmode", p::UADDRESSMODE, pt::STRING, value(0)),
                    Port("vaddressmode", p::VADDRESSMODE, pt::STRING, value(0)),
                ],
            ),
            _ => return Err(self.located(id, "unsupported MaterialX node category")),
        };
        let mut inputs = Vec::with_capacity(ports.len());
        for &input in &self.elements[id].children {
            if self.elements[input].tag == "input" {
                let author = self.elements[input].attr("name").unwrap_or_default();
                if !ports.iter().any(|port| port.0 == author) {
                    return Err(self.located(id, format!("Unsupported input {author:?}")));
                }
            }
        }
        for Port(key, port, mut port_type, default) in ports {
            let input = self.input(id, "input", key);
            if matches!(key, "amplitude" | "in2" | "mix")
                && input.is_some_and(|i| self.elements[i].attr("type") == Some("float"))
            {
                port_type = pt::FLOAT;
            }
            if key == "mix"
                && input.is_some_and(|i| {
                    self.elements[i]
                        .attr("type")
                        .map(|t| {
                            matches!(t, "color3" | "vector2" | "vector3" | "vector4" | "color4")
                        })
                        .unwrap_or(false)
                })
            {
                port_type = ty;
            }
            let source = match (port_type, input) {
                (pt::FILENAME, Some(input)) => {
                    let path = self.elements[input]
                        .attr("value")
                        .ok_or_else(|| self.located(input, "image file must be a literal path"))?;
                    let resolved = self.file.parent().unwrap_or(Path::new(".")).join(path);
                    let tex = self
                        .assets
                        .image(&resolved, self.pointer, false)
                        .map_err(|e| e.to_string())?;
                    let tex = self.scene.add_texture(tex).map_err(|e| e.to_string())?;
                    let slot = self.graph.textures.len();
                    self.graph.textures.push(Some(tex));
                    self.parameter([slot as f32, 0., 0., 0.])
                }
                (pt::FILENAME, None) => self.parameter([-1., 0., 0., 0.]),
                (pt::STRING, _) => {
                    if let Some(input) = input {
                        let expected = if key == "filtertype" {
                            "linear"
                        } else {
                            "periodic"
                        };
                        if self.elements[input].attr("value") != Some(expected) {
                            return Err(
                                self.located(input, format!("only {expected} is supported here"))
                            );
                        }
                    }
                    self.parameter(zero)
                }
                (_, Some(input)) => self.resolve(input, port_type, depth + 1)?,
                (_, None) if default.0 == src::GEOMETRY => default,
                (_, None) => self.parameter(if default.2 == 0 {
                    zero
                } else if port_type == ty {
                    one
                } else {
                    [1., 0., 0., 0.]
                }),
            };
            inputs.push((port, port_type, source));
        }
        let node = (self.push(cat, ty, name, inputs), ty);
        self.active.remove(&id);
        self.nodes.insert(id, node);
        Ok(node)
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
        if self.elements[shader].tag != "open_pbr_surface" {
            return Err(self.located(shader, "expected open_pbr_surface"));
        }
        for id in self.elements[shader].children.clone() {
            if self.elements[id].tag != "input" {
                continue;
            }
            let author = self.elements[id].attr("name").unwrap_or("");
            let (property, terminal, ty) = surface_port(author)
                .ok_or_else(|| self.located(id, format!("Unsupported OpenPBR input {author:?}")))?;
            let link = self.elements[id].attr("nodename").is_some()
                || self.elements[id].attr("nodegraph").is_some()
                || self.elements[id].attr("interfacename").is_some();
            if !link {
                let value = literal(
                    self.elements[id]
                        .attr("value")
                        .ok_or_else(|| self.located(id, "missing value"))?,
                    ty,
                )?;
                let [x, y, z, _] = value;
                if ty == pt::BOOLEAN {
                    material
                        .set_uint(property, x as u32)
                        .map_err(|e| e.to_string())?;
                } else {
                    material
                        .set_float(property, [x, y, z])
                        .map_err(|e| e.to_string())?;
                }
                continue;
            }
            let terminal = terminal
                .ok_or_else(|| self.located(id, "this surface field only supports literals"))?;
            let source = self.resolve(id, ty, 0)?;
            let node = if source.0 == src::NODE {
                source.1
            } else {
                self.push(
                    c::CONSTANT,
                    ty,
                    format!("surface/{id}"),
                    vec![(p::VALUE, ty, source)],
                )
            };
            self.graph.terminals.push(GraphTerminal {
                port: terminal,
                node,
                output: 0,
            });
        }
        Ok(())
    }
}

fn surface_port(name: &str) -> Option<(u32, Option<u32>, u32)> {
    let (id, terminal, ty) = match name {
        "base_weight" => (1, Some(term::BASE_WEIGHT), pt::FLOAT),
        "base_color" => (2, Some(term::BASE_COLOR), pt::COLOR3),
        "base_diffuse_roughness" => (3, Some(term::BASE_DIFFUSE_ROUGHNESS), pt::FLOAT),
        "base_metalness" => (4, Some(term::BASE_METALNESS), pt::FLOAT),
        "specular_weight" => (5, Some(term::SPECULAR_WEIGHT), pt::FLOAT),
        "specular_color" => (6, Some(term::SPECULAR_COLOR), pt::COLOR3),
        "specular_roughness" => (7, Some(term::SPECULAR_ROUGHNESS), pt::FLOAT),
        "specular_ior" => (8, Some(term::SPECULAR_IOR), pt::FLOAT),
        "transmission_weight" => (10, Some(term::TRANSMISSION_WEIGHT), pt::FLOAT),
        "transmission_color" => (11, Some(term::TRANSMISSION_COLOR), pt::COLOR3),
        "coat_weight" => (25, Some(term::COAT_WEIGHT), pt::FLOAT),
        "coat_color" => (26, Some(term::COAT_COLOR), pt::COLOR3),
        "coat_roughness" => (27, Some(term::COAT_ROUGHNESS), pt::FLOAT),
        "coat_ior" => (29, Some(term::COAT_IOR), pt::FLOAT),
        "emission_color" => (34, Some(term::EMISSION_COLOR), pt::COLOR3),
        "emission_luminance" => (35, Some(term::EMISSION_LUMINANCE), pt::FLOAT),
        "geometry_opacity" => (36, Some(term::OPACITY), pt::FLOAT),
        "geometry_thin_walled" => (37, None, pt::BOOLEAN),
        _ => return None,
    };
    Some((id, terminal, ty))
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
        material.graph = Some(compiler.graph);
    }
    Ok((
        material,
        MaterialBindings {
            by_name: compiler.bindings,
        },
    ))
}
