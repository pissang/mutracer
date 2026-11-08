//! Owned canonical graph records; node semantics live in the shared AOT generator.
use super::{Dense, OpenPbrMaterial, Result, Scene, TextureId, invalid};
use crate::layout::{graph as g, header as h, material as m};

/// Stable IDs for graph categories, types, ports, outputs and implicit geometry.
#[path = "material_graph_schema.rs"]
pub mod schema;

/// One canonical node. Inputs must precede dependent nodes; implementation is 1.
/// `first_input`/`input_count` address records in [`MaterialGraph::inputs`].
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct GraphNode {
    pub category: u32,
    pub implementation: u32,
    pub port_type: u32,
    pub first_input: u32,
    pub input_count: u32,
}
/// Typed input. `source_kind` selects parameter slot, earlier node, or implicit
/// geometry; `source` indexes that table. `output` selects a connected node's
/// output and is zero for parameters and geometry. IDs are in [`schema`].
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct GraphInput {
    pub port: u32,
    pub port_type: u32,
    pub source_kind: u32,
    pub source: u32,
    pub output: u32,
}
/// OpenPBR terminal, source node and selected output; IDs are in [`schema`].
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct GraphTerminal {
    pub port: u32,
    pub node: u32,
    pub output: u32,
}
/// Owned, normalized MaterialX graph. Default: IR version 1 and empty tables,
/// which override no material inputs. All node inputs, including defaults, must
/// be explicit; connections point to earlier nodes. Numeric parameters use four
/// components per slot, with unused components zero. Filename parameters index
/// `textures`, or use -1 for the image default. Values must be finite; integer
/// parameters lie within ±16,777,216. Boolean values are 0 or 1; object/world
/// strings encode 0/1, and an unspecified transform space encodes -1.
///
/// Texture handles belong to the containing Scene; None samples the image's
/// default. `author_ids` is empty or contains one UTF-8 diagnostic location per
/// node. The graph owns every array/string; cloning copies them. Edit through
/// Scene::material_mut, then submit and update the engine. Scene access is
/// exclusive; submitted engine snapshots are independent.
#[derive(Clone, Debug, PartialEq)]
pub struct MaterialGraph {
    pub version: u32,
    pub nodes: Vec<GraphNode>,
    pub inputs: Vec<GraphInput>,
    pub terminals: Vec<GraphTerminal>,
    pub parameters: Vec<[f32; 4]>,
    /// Retained texture slots; default empty. Every listed entry is retained,
    /// including slots not currently selected by a filename parameter.
    pub textures: Vec<Option<TextureId>>,
    pub author_ids: Vec<String>,
}
impl Default for MaterialGraph {
    fn default() -> Self {
        Self {
            version: schema::IR_VERSION,
            nodes: vec![],
            inputs: vec![],
            terminals: vec![],
            parameters: vec![],
            textures: vec![],
            author_ids: vec![],
        }
    }
}
impl MaterialGraph {
    /// Fold each terminal without creating a scene or GPU. None means the
    /// terminal depends on textures or a shading context; Some contains 1..4
    /// finite components. Uses the browser's numeric evaluator and float32
    /// rounding after each node. Invalid reachable IR/non-finite folded values
    /// return InvalidArgument. Unreachable author errors do not affect another
    /// terminal. Texture handles and author labels are not dereferenced. This
    /// borrows the graph for the call and may run on any thread through the
    /// SDK's serialized CPU runtime.
    pub fn fold_constants(&self) -> Result<Vec<Option<Vec<f32>>>> {
        self.word_count()?;
        let graph = serde_json::json!({
            "version": self.version,
            "nodes": self.nodes.iter().flat_map(|n| [n.category, n.implementation, n.port_type, n.first_input, n.input_count]).collect::<Vec<_>>(),
            "inputs": self.inputs.iter().flat_map(|i| [i.port, i.port_type, i.source_kind, i.source, i.output]).collect::<Vec<_>>(),
            "terminal": self.terminals.iter().flat_map(|t| [t.port, t.node, t.output]).collect::<Vec<_>>(),
            "parameters": self.parameters.iter().flatten().copied().collect::<Vec<_>>()
        });
        let bytes = crate::scene::fold_material_graph(
            serde_json::to_vec(&graph).map_err(|e| invalid(&e.to_string()))?,
        )
        .map_err(|e| invalid(&e.to_string()))?;
        let rows: serde_json::Value =
            serde_json::from_slice(&bytes).map_err(|e| invalid(&e.to_string()))?;
        let rows = rows
            .as_array()
            .ok_or_else(|| invalid("Invalid graph fold result"))?;
        if rows.len() != self.terminals.len() {
            return Err(invalid("Invalid graph fold result length"));
        }
        rows.iter()
            .map(|row| {
                if row["diagnostics"].as_array().is_none_or(|a| !a.is_empty()) {
                    return Err(invalid(&row["diagnostics"].to_string()));
                }
                let value = row["value"]
                    .as_array()
                    .ok_or_else(|| invalid("Invalid graph fold value"))?;
                if value.is_empty() {
                    return Ok(None);
                }
                if value.len() > 4 {
                    return Err(invalid("Invalid graph fold width"));
                }
                let value = value
                    .iter()
                    .map(|v| {
                        v.as_f64()
                            .map(|v| v as f32)
                            .filter(|v| v.is_finite())
                            .ok_or_else(|| invalid("Non-finite folded graph value"))
                    })
                    .collect::<Result<Vec<_>>>()?;
                Ok(Some(value))
            })
            .collect()
    }
    pub(super) fn word_count(&self) -> Result<usize> {
        if !self.author_ids.is_empty() && self.author_ids.len() != self.nodes.len() {
            return Err(invalid(
                "Graph author_ids must be empty or match the node count",
            ));
        }
        if self.parameters.iter().flatten().any(|v| !v.is_finite()) {
            return Err(invalid("Graph parameters must be finite"));
        }
        let words = g::WORDS as u64
            + self.nodes.len() as u64 * 5
            + self.inputs.len() as u64 * 5
            + self.terminals.len() as u64 * 3
            + self.parameters.len() as u64 * 4
            + self.textures.len() as u64
            + if self.author_ids.is_empty() {
                0
            } else {
                self.nodes.len() as u64 * 2
                    + self
                        .author_ids
                        .iter()
                        .map(|s| s.len().div_ceil(4) as u64)
                        .sum::<u64>()
            };
        if words > u32::MAX as u64 {
            return Err(invalid("Graph descriptor word offsets overflow"));
        }
        Ok(words as usize)
    }
    pub(super) fn fits(&self, w: &[u32], at: usize) -> bool {
        if at == 0 || at + g::WORDS > w.len() {
            return false;
        }
        let counts = [
            (g::NODE_COUNT, self.nodes.len()),
            (g::INPUT_COUNT, self.inputs.len()),
            (g::TERMINAL_COUNT, self.terminals.len()),
            (g::PARAMETER_COUNT, self.parameters.len()),
            (g::TEXTURE_COUNT, self.textures.len()),
        ];
        if counts
            .iter()
            .any(|&(field, count)| w[at + field] as usize != count)
        {
            return false;
        }
        let ids = w[at + g::AUTHOR_IDS] as usize;
        if (ids == 0) != self.author_ids.is_empty() {
            return false;
        }
        self.author_ids
            .iter()
            .enumerate()
            .all(|(i, s)| w.get(ids + i * 2 + 1).copied() == Some(s.len() as u32))
    }
    fn write(&self, w: &mut Vec<u32>, textures: &[u32], previous: usize) -> usize {
        let reused = self.fits(w, previous);
        let at = if reused {
            previous
        } else {
            let at = w.len();
            w.resize(at + g::WORDS, 0);
            at
        };
        w[at + g::VERSION] = self.version;
        let nodes: Vec<u32> = self
            .nodes
            .iter()
            .flat_map(|n| {
                [
                    n.category,
                    n.implementation,
                    n.port_type,
                    n.first_input,
                    n.input_count,
                ]
            })
            .collect();
        let inputs: Vec<u32> = self
            .inputs
            .iter()
            .flat_map(|n| [n.port, n.port_type, n.source_kind, n.source, n.output])
            .collect();
        let terminals: Vec<u32> = self
            .terminals
            .iter()
            .flat_map(|n| [n.port, n.node, n.output])
            .collect();
        let parameters: Vec<u32> = self
            .parameters
            .iter()
            .flatten()
            .map(|v| v.to_bits())
            .collect();
        for (count, offset, stride, data) in [
            (g::NODE_COUNT, g::NODES, 5, nodes.as_slice()),
            (g::INPUT_COUNT, g::INPUTS, 5, inputs.as_slice()),
            (g::TERMINAL_COUNT, g::TERMINALS, 3, terminals.as_slice()),
            (g::PARAMETER_COUNT, g::PARAMETERS, 4, parameters.as_slice()),
            (g::TEXTURE_COUNT, g::TEXTURES, 1, textures),
        ] {
            w[at + count] = (data.len() / stride) as u32;
            let dest = if data.is_empty() {
                0
            } else if reused {
                w[at + offset] as usize
            } else {
                let dest = w.len();
                w.resize(dest + data.len(), 0);
                dest
            };
            w[at + offset] = dest as u32;
            if !data.is_empty() {
                w[dest..dest + data.len()].copy_from_slice(data);
            }
        }
        if !self.author_ids.is_empty() {
            let ids = if reused {
                w[at + g::AUTHOR_IDS] as usize
            } else {
                let ids = w.len();
                w.resize(ids + self.nodes.len() * 2, 0);
                ids
            };
            w[at + g::AUTHOR_IDS] = ids as u32;
            for (i, id) in self.author_ids.iter().enumerate() {
                let words: Vec<u32> = id
                    .as_bytes()
                    .chunks(4)
                    .map(|chunk| {
                        let mut b = [0; 4];
                        b[..chunk.len()].copy_from_slice(chunk);
                        u32::from_le_bytes(b)
                    })
                    .collect();
                let dest = if reused {
                    w[ids + i * 2] as usize
                } else {
                    let dest = w.len();
                    w.resize(dest + words.len(), 0);
                    dest
                };
                w[ids + i * 2] = dest as u32;
                w[ids + i * 2 + 1] = id.len() as u32;
                w[dest..dest + words.len()].copy_from_slice(&words);
            }
        }
        at
    }
}
impl Scene {
    pub(super) fn graph_word_count(&self) -> Result<usize> {
        self.materials.iter().try_fold(0usize, |n, (_, m)| {
            n.checked_add(
                m.graph
                    .as_ref()
                    .map(MaterialGraph::word_count)
                    .transpose()?
                    .unwrap_or(0),
            )
            .ok_or_else(|| invalid("Graph descriptor word offsets overflow"))
        })
    }
    pub(super) fn graphs_fit(&self, w: &[u32]) -> bool {
        if w.len() < h::WORDS || w[h::MATERIAL_COUNT] as usize != self.materials.iter().count() {
            return false;
        }
        self.materials.iter().enumerate().all(|(i, (_, material))| {
            let at = w[h::MATERIAL_OFFSET] as usize + i * m::WORDS;
            let Some(&graph) = w.get(at + m::GRAPH) else {
                return false;
            };
            material
                .graph
                .as_ref()
                .map_or(graph == 0, |g| g.fits(w, graph as usize))
        })
    }
    pub(super) fn write_graphs(&self, w: &mut Vec<u32>, d: &Dense) -> Result<()> {
        for (i, (_, material)) in self.materials.iter().enumerate() {
            let at = w[h::MATERIAL_OFFSET] as usize + i * m::WORDS;
            w[at + m::GRAPH] = if let Some(graph) = &material.graph {
                let textures: Vec<u32> = graph
                    .textures
                    .iter()
                    .map(|id| {
                        self.texture_index(d, *id)
                            .map(|id| id.map_or(u32::MAX, |id| id as u32))
                    })
                    .collect::<Result<_>>()?;
                let previous = w[at + m::GRAPH] as usize;
                graph.write(w, &textures, previous) as u32
            } else {
                0
            };
        }
        w[h::LENGTH] = w.len() as u32;
        Ok(())
    }
}

impl OpenPbrMaterial {
    /// Replace the normalized graph; None restores constants/maps. Arrays and
    /// strings move into the material. Rejects an author-ID count mismatch or non-finite
    /// parameters with InvalidArgument, leaving the previous graph unchanged.
    /// Node, type and terminal support is diagnosed during scene preparation.
    /// Texture handles are checked by the containing Scene when submitted.
    pub fn set_graph(&mut self, graph: Option<MaterialGraph>) -> Result<()> {
        if let Some(g) = &graph {
            g.word_count()?;
        }
        self.graph = graph;
        Ok(())
    }
}

#[cfg(test)]
#[path = "material_graph_tests.rs"]
mod tests;
