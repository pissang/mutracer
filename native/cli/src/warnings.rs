use crate::{render_settings::RenderOptions, scene::MaterialGraphTarget};
use mutracer_native::api::MaterialGraphDiagnostic;
use serde::Serialize;
use serde_json::json;
use std::collections::HashSet;

const CAUSTIC_GRAPH_MESSAGE: &str = "Material graphs currently use the constant material fallback with light tracing or photon mapping.";
const CAUSTIC_GRAPH_HINT: &str = "Disable lightTracing and photonMapping, or replace graph-driven inputs with constant values or supported texture slots.";

#[derive(Clone, Debug, Hash, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Warning {
    pub code: String,
    pub pointer: String,
    pub message: String,
    pub hint: String,
}

fn from_diagnostic(
    diagnostic: &MaterialGraphDiagnostic,
    target: Option<&MaterialGraphTarget>,
) -> Warning {
    let mut message = diagnostic.message.clone();
    if let Some(target) = target {
        message.push_str(&format!(
            " Affected object {:?}, material {:?}.",
            target.object_name, target.material_name
        ));
    } else if diagnostic.material_id != 0 {
        message.push_str(&format!(" Material ID {}.", diagnostic.material_id));
    }
    if !diagnostic.node.is_empty() {
        message.push_str(&format!(" Node {:?}.", diagnostic.node));
    }
    if !diagnostic.port.is_empty() {
        message.push_str(&format!(" Port {:?}.", diagnostic.port));
    }
    Warning {
        code: diagnostic.code.clone(),
        pointer: target.map_or_else(String::new, |target| target.pointer.clone()),
        message,
        hint: if diagnostic.code == "unsupported-transport" {
            CAUSTIC_GRAPH_HINT.into()
        } else {
            "Replace the unsupported graph input with a supported material value or texture slot."
                .into()
        },
    }
}

pub fn material_graph_warnings(
    diagnostics: &[MaterialGraphDiagnostic],
    targets: &[MaterialGraphTarget],
) -> Vec<Warning> {
    let mut seen = HashSet::new();
    let mut warnings = Vec::new();
    for diagnostic in diagnostics {
        let matched = targets
            .iter()
            .filter(|target| {
                diagnostic.material_id == 0 || target.material_id == diagnostic.material_id
            })
            .collect::<Vec<_>>();
        if matched.is_empty() {
            let warning = from_diagnostic(diagnostic, None);
            if seen.insert(warning.clone()) {
                warnings.push(warning);
            }
        } else {
            for target in matched {
                let warning = from_diagnostic(diagnostic, Some(target));
                if seen.insert(warning.clone()) {
                    warnings.push(warning);
                }
            }
        }
    }
    warnings
}

pub fn predicted_caustic_graph_warnings(targets: &[MaterialGraphTarget]) -> Vec<Warning> {
    if targets.is_empty() {
        return Vec::new();
    }
    let diagnostic = MaterialGraphDiagnostic {
        code: "unsupported-transport".into(),
        message: CAUSTIC_GRAPH_MESSAGE.into(),
        material_id: 0,
        node: String::new(),
        port: String::new(),
    };
    material_graph_warnings(&[diagnostic], targets)
}

pub fn descriptor_material_graph_targets(bytes: &[u8]) -> Vec<MaterialGraphTarget> {
    const HEADER_WORDS: usize = 32;
    const MESH_WORDS: usize = 21;
    const MATERIAL_WORDS: usize = 24;
    const MESH_MATERIAL: usize = 1;
    const MESH_MATERIAL_TABLE: usize = 2;
    const MESH_MATERIAL_COUNT: usize = 3;
    const MATERIAL_GRAPH: usize = 21;
    if bytes.len() % 4 != 0 {
        return Vec::new();
    }
    let words = bytes
        .chunks_exact(4)
        .map(|word| u32::from_le_bytes(word.try_into().unwrap()) as usize)
        .collect::<Vec<_>>();
    let word = |index: usize| words.get(index).copied();
    if words.len() < HEADER_WORDS || word(0) != Some(8) {
        return Vec::new();
    }
    let (
        Some(mesh_count),
        Some(scene_material_count),
        Some(mesh_offset),
        Some(material_offset),
        Some(mesh_ids_offset),
        Some(material_ids_offset),
    ) = (word(5), word(6), word(10), word(11), word(24), word(25))
    else {
        return Vec::new();
    };
    if mesh_offset
        .checked_add(mesh_count.saturating_mul(MESH_WORDS))
        .is_none_or(|end| end > words.len())
        || material_offset
            .checked_add(scene_material_count.saturating_mul(MATERIAL_WORDS))
            .is_none_or(|end| end > words.len())
        || mesh_ids_offset
            .checked_add(mesh_count)
            .is_none_or(|end| end > words.len())
        || material_ids_offset
            .checked_add(scene_material_count)
            .is_none_or(|end| end > words.len())
    {
        return Vec::new();
    }
    let graph_materials = (0..scene_material_count)
        .filter(|index| words[material_offset + index * MATERIAL_WORDS + MATERIAL_GRAPH] != 0)
        .collect::<HashSet<_>>();
    let mut targets = Vec::new();
    for mesh_index in 0..mesh_count {
        let start = mesh_offset + mesh_index * MESH_WORDS;
        let mesh_aov_id = words[mesh_ids_offset + mesh_index];
        let mesh_material_count = words[start + MESH_MATERIAL_COUNT];
        let table = words[start + MESH_MATERIAL_TABLE];
        let mut material_indices = vec![words[start + MESH_MATERIAL]];
        if mesh_material_count > 0 {
            let Some(end) = table
                .checked_add(mesh_material_count)
                .filter(|end| *end <= words.len())
            else {
                continue;
            };
            material_indices.extend_from_slice(&words[table..end]);
        }
        material_indices.sort_unstable();
        material_indices.dedup();
        for material_index in material_indices {
            if material_index >= scene_material_count {
                continue;
            }
            if graph_materials.contains(&material_index) {
                let material_id = words[material_ids_offset + material_index] as u32;
                targets.push(MaterialGraphTarget {
                    material_id,
                    object_name: format!("mesh index {mesh_index} (AOV ID {mesh_aov_id})"),
                    material_name: format!("material AOV ID {material_id}"),
                    pointer: String::new(),
                });
            }
        }
    }
    targets
}

pub fn emit_file(warnings: impl IntoIterator<Item = Warning>, seen: &mut HashSet<Warning>) {
    for warning in warnings {
        if seen.insert(warning.clone()) {
            crate::progress(json!({
                "event": "warning",
                "code": warning.code,
                "pointer": warning.pointer,
                "message": warning.message,
                "hint": warning.hint,
            }));
        }
    }
}

pub fn caustics_enabled(render: RenderOptions) -> bool {
    render.has_caustic_transport()
}

pub fn deprecated_field(pointer: &str, replacement: &str) -> Warning {
    Warning {
        code: "deprecated-field".into(),
        pointer: pointer.into(),
        message: "Deprecated field.".into(),
        hint: replacement.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target(material_id: u32, object_name: &str) -> MaterialGraphTarget {
        MaterialGraphTarget {
            material_id,
            object_name: object_name.into(),
            material_name: format!("{object_name} material"),
            pointer: "/objects/0/material".into(),
        }
    }

    #[test]
    fn predicts_caustic_graph_fallback_once_per_affected_object() {
        let targets = [target(7, "Tablecloth"), target(9, "Wallpaper")];
        let warnings = predicted_caustic_graph_warnings(&targets);
        assert_eq!(warnings.len(), 2);
        assert!(
            warnings
                .iter()
                .all(|warning| warning.code == "unsupported-transport")
        );
        assert!(
            warnings
                .iter()
                .all(|warning| warning.pointer == "/objects/0/material")
        );
        assert!(
            warnings
                .iter()
                .all(|warning| warning.hint.contains("Disable lightTracing"))
        );
        assert!(warnings[0].message.contains("Tablecloth"));
        assert!(warnings[1].message.contains("Wallpaper"));
        assert!(predicted_caustic_graph_warnings(&[]).is_empty());
    }

    #[test]
    fn matches_material_diagnostics_and_deduplicates_repeated_render_entries() {
        let targets = [target(7, "Tablecloth")];
        let diagnostic = MaterialGraphDiagnostic {
            code: "unsupported-transport".into(),
            message: CAUSTIC_GRAPH_MESSAGE.into(),
            material_id: 7,
            node: String::new(),
            port: String::new(),
        };
        let warnings = material_graph_warnings(&[diagnostic.clone(), diagnostic], &targets);
        assert_eq!(warnings.len(), 1);
        assert_eq!(warnings[0].pointer, "/objects/0/material");
    }

    #[test]
    fn extracts_graph_material_ids_and_mesh_indices_from_descriptors() {
        const MATERIAL_GRAPH: usize = 21;
        let mut words = vec![0; 220];
        words[0] = 8;
        words[5] = 1;
        words[6] = 1;
        words[10] = 32;
        words[11] = 53;
        words[24] = 100;
        words[25] = 101;
        words[32 + 1] = 0;
        words[32 + 2] = 140;
        words[32 + 3] = 1;
        words[53 + MATERIAL_GRAPH] = 180;
        words[100] = 44;
        words[101] = 55;
        words[140] = 0;
        let targets = descriptor_material_graph_targets(
            &words
                .iter()
                .flat_map(|word| (*word as u32).to_le_bytes())
                .collect::<Vec<_>>(),
        );
        assert_eq!(targets.len(), 1);
        assert_eq!(targets[0].material_id, 55);
        assert_eq!(targets[0].object_name, "mesh index 0 (AOV ID 44)");
        assert!(targets[0].pointer.is_empty());
    }
}
