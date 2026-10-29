//! Flat virtualized rows retain glTF hierarchy, including empty groups and cameras.
use crate::*;
use std::collections::HashSet;
#[derive(Clone, Default)]
pub struct Node {
    pub name: String,
    pub parent: Option<usize>,
    pub children: Vec<usize>,
    pub meshes: Vec<usize>,
    pub camera: Option<usize>,
    pub light: bool,
    pub unused: bool,
    pub root_order: usize,
}
#[derive(Default)]
pub struct Tree {
    expanded: HashSet<usize>,
    selection: Option<usize>,
    initialized: bool,
}
struct Row {
    node: usize,
    depth: usize,
    material: Option<usize>,
}
fn rows(
    nodes: &[Node],
    expanded: &HashSet<usize>,
    query: &str,
    materials: &[Vec<usize>],
    names: &[&str],
) -> Vec<Row> {
    fn walk(
        id: usize,
        depth: usize,
        nodes: &[Node],
        expanded: &HashSet<usize>,
        query: &str,
        out: &mut Vec<Row>,
        materials: &[Vec<usize>],
        names: &[&str],
    ) {
        if depth > 512 || nodes[id].unused {
            return;
        }
        let start = out.len();
        let material_ids = materials.get(id).map(Vec::as_slice).unwrap_or(&[]);
        let matching = query.is_empty()
            || nodes[id].name.to_lowercase().contains(query)
            || material_ids
                .iter()
                .any(|&material| names[material].to_lowercase().contains(query));
        out.push(Row {
            node: id,
            depth,
            material: None,
        });
        if !query.is_empty() || expanded.contains(&id) {
            if matching {
                out.extend(material_ids.iter().map(|&material| Row {
                    node: id,
                    depth: depth + 1,
                    material: Some(material),
                }));
            }
            for &child in &nodes[id].children {
                walk(
                    child,
                    depth + 1,
                    nodes,
                    expanded,
                    query,
                    out,
                    materials,
                    names,
                );
            }
        }
        if !matching && out.len() == start + 1 {
            out.pop();
        }
    }
    let mut out = Vec::new();
    let mut roots: Vec<_> = nodes
        .iter()
        .enumerate()
        .filter(|(_, n)| n.parent.is_none())
        .collect();
    roots.sort_by_key(|(_, node)| node.root_order);
    for (i, _) in roots {
        walk(i, 0, nodes, expanded, query, &mut out, materials, names);
    }
    out
}
impl Viewer {
    pub(super) fn scene_rows(&mut self, ui: &mut egui::Ui) {
        ui.spacing_mut().item_spacing = egui::vec2(2., 4.);
        if !self.scene_tree.initialized {
            self.scene_tree.initialized = true;
            // Match the web tree: reveal the first two levels of authored groups.
            for (id, node) in self.model.1.nodes.iter().enumerate() {
                if node.meshes.is_empty()
                    && (node.parent.is_none()
                        || node
                            .parent
                            .is_some_and(|p| self.model.1.nodes[p].parent.is_none()))
                {
                    self.scene_tree.expanded.insert(id);
                }
            }
        }
        let reveal = self.scene_tree.selection != self.selected_mesh;
        if reveal {
            self.scene_tree.selection = self.selected_mesh;
            if let Some(mesh) = self.selected_mesh {
                if let Some(id) = self
                    .model
                    .1
                    .nodes
                    .iter()
                    .position(|n| n.meshes.contains(&mesh))
                {
                    self.object_query.clear();
                    let mut parent = self.model.1.nodes[id].parent;
                    while let Some(id) = parent {
                        self.scene_tree.expanded.insert(id);
                        parent = self.model.1.nodes[id].parent;
                    }
                }
            }
        }
        let nodes = self.model.1.nodes.clone();
        let materials: Vec<Vec<usize>> = nodes
            .iter()
            .map(|node| {
                let mut ids = Vec::new();
                for &mesh in &node.meshes {
                    let mesh = &self.model.meshes[mesh];
                    for id in std::iter::once(mesh.material).chain(mesh.materials.iter().copied()) {
                        if !ids.contains(&id) {
                            ids.push(id);
                        }
                    }
                }
                ids
            })
            .collect();
        let material_names: Vec<_> = self
            .model
            .materials
            .iter()
            .map(|m| m.name.as_str())
            .collect();
        let items = rows(
            &nodes,
            &self.scene_tree.expanded,
            &self.object_query.trim().to_lowercase(),
            &materials,
            &material_names,
        );
        if items.is_empty() {
            ui.weak("No matching objects");
            return;
        }
        let mut scroll = egui::ScrollArea::vertical()
            .id_salt("objects")
            .auto_shrink([false, false]);
        if reveal {
            if let Some(index) = items.iter().position(|r| {
                self.selected_mesh
                    .is_some_and(|m| nodes[r.node].meshes.contains(&m))
            }) {
                let offset =
                    egui::scroll_area::State::load(ui.ctx(), ui.make_persistent_id("objects"))
                        .unwrap_or_default()
                        .offset
                        .y;
                let height = ui.available_height();
                let pitch = 24. + ui.spacing().item_spacing.y;
                let top = index as f32 * pitch;
                let bottom = top + 24.;
                let target = if top < offset {
                    top
                } else if bottom > offset + height {
                    bottom - height
                } else {
                    offset
                };
                scroll = scroll.vertical_scroll_offset(
                    target.clamp(0., (items.len() as f32 * pitch - height).max(0.)),
                );
            }
        }
        scroll.show_rows(ui, 24., items.len(), |ui, range| {
            for row in &items[range] {
                let node = &nodes[row.node];
                ui.push_id((row.node, row.material), |ui| {
                    if let Some(material) = row.material {
                        ui.horizontal(|ui| {
                            ui.add_space(row.depth as f32 * 10. + 14.);
                            let selected = self.selected == material
                                && self.selected_mesh.is_some_and(|m| node.meshes.contains(&m));
                            let response = ui.add_sized(
                                [ui.available_width() - 24., 24.],
                                egui::Button::new("").selected(selected).frame(false),
                            );
                            let mat = &self.model.materials[material];
                            let color: egui::Color32 =
                                egui::Rgba::from_rgb(mat.color[0], mat.color[1], mat.color[2])
                                    .into();
                            ui.painter().circle_filled(
                                response.rect.left_center() + egui::vec2(10., 0.),
                                4.,
                                color,
                            );
                            let text = egui::WidgetText::from(
                                egui::RichText::new(&mat.name).color(if selected {
                                    theme::ACCENT
                                } else {
                                    theme::SUBTLE
                                }),
                            )
                            .into_galley(
                                ui,
                                Some(egui::TextWrapMode::Truncate),
                                (response.rect.width() - 24.).max(1.),
                                egui::TextStyle::Button,
                            );
                            ui.painter().galley(
                                response.rect.left_center() + egui::vec2(22., -text.size().y * 0.5),
                                text,
                                theme::SUBTLE,
                            );
                            response.widget_info(|| {
                                egui::WidgetInfo::selected(
                                    egui::WidgetType::SelectableLabel,
                                    ui.is_enabled(),
                                    selected,
                                    &mat.name,
                                )
                            });
                            #[cfg(test)]
                            ui.ctx().data_mut(|data| {
                                data.insert_temp(
                                    egui::Id::new(("scene-material", row.node, material)),
                                    response.rect,
                                )
                            });
                            if response.on_hover_text(&mat.name).clicked() {
                                self.selected_mesh = node.meshes.iter().copied().find(|&m| {
                                    self.model.meshes[m].material == material
                                        || self.model.meshes[m].materials.contains(&material)
                                });
                                self.selected = material;
                                self.tab = 1;
                                self.inspector_open = true;
                            }
                        });
                        return;
                    }
                    ui.horizontal(|ui| {
                        ui.add_space(row.depth as f32 * 10.);
                        if !node.children.is_empty() || !materials[row.node].is_empty() {
                            let response =
                                ui.add_sized([14., 24.], egui::Button::new("").frame(false));
                            let c = response.rect.center();
                            let open = self.scene_tree.expanded.contains(&row.node);
                            let points = if open {
                                vec![
                                    c + egui::vec2(-3., -2.),
                                    c + egui::vec2(3., -2.),
                                    c + egui::vec2(0., 2.),
                                ]
                            } else {
                                vec![
                                    c + egui::vec2(-2., -3.),
                                    c + egui::vec2(2., 0.),
                                    c + egui::vec2(-2., 3.),
                                ]
                            };
                            ui.painter().add(egui::Shape::convex_polygon(
                                points,
                                theme::MUTED,
                                egui::Stroke::NONE,
                            ));
                            #[cfg(test)]
                            ui.ctx().data_mut(|data| {
                                data.insert_temp(
                                    egui::Id::new(("scene-expand", row.node)),
                                    response.rect,
                                )
                            });
                            if response.clicked() {
                                if !self.scene_tree.expanded.remove(&row.node) {
                                    self.scene_tree.expanded.insert(row.node);
                                }
                            }
                        } else {
                            ui.add_space(14.);
                        }
                        let selected = self.selected_mesh.is_some_and(|m| node.meshes.contains(&m));
                        let response = ui.add_sized(
                            [ui.available_width() - 24., 24.],
                            egui::Button::new("").selected(selected).frame(selected),
                        );
                        let color = if selected { theme::ACCENT } else { theme::TEXT };
                        controls::paint_icon(
                            ui,
                            response.rect.left_center() + egui::vec2(10., 0.),
                            if node.camera.is_some() {
                                controls::Icon::Camera
                            } else if node.light {
                                controls::Icon::Lighting
                            } else if node.meshes.is_empty() {
                                controls::Icon::Folder
                            } else {
                                controls::Icon::Object
                            },
                            color,
                        );
                        let galley = egui::WidgetText::from(node.name.as_str()).into_galley(
                            ui,
                            Some(egui::TextWrapMode::Truncate),
                            (response.rect.width() - 24.).max(1.),
                            egui::TextStyle::Button,
                        );
                        ui.painter().galley(
                            response.rect.left_center() + egui::vec2(22., -galley.size().y * 0.5),
                            galley,
                            color,
                        );
                        response.widget_info(|| {
                            egui::WidgetInfo::selected(
                                egui::WidgetType::SelectableLabel,
                                ui.is_enabled(),
                                selected,
                                &node.name,
                            )
                        });
                        if response.on_hover_text(&node.name).clicked() {
                            if let Some(&mesh) = node.meshes.first() {
                                self.selected_mesh = Some(mesh);
                                self.selected = self.model.meshes[mesh].material;
                                self.tab = 1;
                                self.inspector_open = true;
                            } else if let Some(camera) = node.camera {
                                self.camera_index = Some(camera);
                                self.model.1.cameras[camera]
                                    .apply(&mut self.camera, self.model.center);
                                self.dirty(Change::Camera);
                            } else if !self.scene_tree.expanded.remove(&row.node) {
                                self.scene_tree.expanded.insert(row.node);
                            }
                        }
                        let mut descendants = node.meshes.clone();
                        let mut pending = node.children.clone();
                        while let Some(id) = pending.pop() {
                            descendants.extend_from_slice(&nodes[id].meshes);
                            pending.extend_from_slice(&nodes[id].children);
                        }
                        if !descendants.is_empty() {
                            let visible =
                                descendants.iter().any(|m| !self.model.1.hidden.contains(m));
                            let response =
                                ui.add_sized([22., 24.], egui::Button::new("").frame(false));
                            let c = response.rect.center();
                            let stroke = egui::Stroke::new(1., theme::MUTED);
                            let points = (0..24)
                                .map(|i| {
                                    let t = i as f32 / 24. * std::f32::consts::TAU;
                                    c + egui::vec2(t.cos() * 6., t.sin() * 3.5)
                                })
                                .collect();
                            ui.painter().add(egui::Shape::closed_line(points, stroke));
                            if visible {
                                ui.painter().circle_filled(c, 1.7, theme::MUTED);
                            } else {
                                ui.painter().line_segment(
                                    [c + egui::vec2(-6., -5.), c + egui::vec2(6., 5.)],
                                    stroke,
                                );
                            }
                            response.widget_info(|| {
                                egui::WidgetInfo::labeled(
                                    egui::WidgetType::Button,
                                    ui.is_enabled(),
                                    if visible {
                                        "Hide object"
                                    } else {
                                        "Show object"
                                    },
                                )
                            });
                            if response
                                .on_hover_text(if visible {
                                    "Hide object"
                                } else {
                                    "Show object"
                                })
                                .clicked()
                            {
                                for mesh in descendants {
                                    if visible {
                                        self.model.1.hidden.insert(mesh);
                                    } else {
                                        self.model.1.hidden.remove(&mesh);
                                    }
                                }
                                self.dirty(Change::Scene);
                            }
                        }
                    });
                });
            }
        });
    }
}
pub fn from_gltf(
    json: &serde_json::Value,
    model: &mutracer_native_probe::scene_api::viewer_support::Model,
) -> Vec<Node> {
    let mut nodes: Vec<Node> = json["nodes"]
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
        .map(|(i, n)| Node {
            name: n["name"]
                .as_str()
                .filter(|name| !name.is_empty())
                .or_else(|| {
                    n["mesh"]
                        .as_u64()
                        .and_then(|id| json["meshes"][id as usize]["name"].as_str())
                })
                .or_else(|| {
                    n["camera"]
                        .as_u64()
                        .and_then(|id| json["cameras"][id as usize]["name"].as_str())
                })
                .map(str::to_owned)
                .unwrap_or_else(|| format!("Node {}", i + 1)),
            children: n["children"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|v| v.as_u64().map(|i| i as usize))
                .collect(),
            meshes: model
                .node_indices
                .iter()
                .enumerate()
                .filter_map(|(mesh, &node)| (node == i).then_some(mesh))
                .collect(),
            light: n["extensions"]["KHR_lights_punctual"]["light"].is_number(),
            ..Default::default()
        })
        .collect();
    for id in 0..nodes.len() {
        for child in nodes[id].children.clone() {
            if let Some(n) = nodes.get_mut(child) {
                n.parent = Some(id);
            }
        }
    }
    let scene = json["scene"].as_u64().unwrap_or(0) as usize;
    let mut pending: Vec<_> = json["scenes"][scene]["nodes"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|v| v.as_u64().map(|i| i as usize))
        .collect();
    for (order, &id) in pending.iter().enumerate() {
        if let Some(node) = nodes.get_mut(id) {
            node.root_order = order;
        }
    }
    let mut active = HashSet::new();
    while let Some(id) = pending.pop() {
        if id < nodes.len() && active.insert(id) {
            pending.extend_from_slice(&nodes[id].children);
        }
    }
    for i in 0..nodes.len() {
        nodes[i].unused = !active.contains(&i);
        if nodes[i].parent.is_some_and(|p| !active.contains(&p)) {
            nodes[i].parent = None;
        }
    }
    nodes
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn materials_are_expandable_children_and_search_keeps_their_ancestors() {
        let nodes = vec![
            Node {
                name: "Scene".into(),
                children: vec![1],
                ..Default::default()
            },
            Node {
                name: "Mesh".into(),
                parent: Some(0),
                meshes: vec![0],
                ..Default::default()
            },
        ];
        let materials = vec![vec![], vec![0, 1]];
        let names = ["Ceramic", "Gold"];
        assert_eq!(
            rows(&nodes, &HashSet::new(), "", &materials, &names).len(),
            1
        );
        assert_eq!(
            rows(&nodes, &HashSet::from([0]), "", &materials, &names).len(),
            2
        );
        let expanded = rows(&nodes, &HashSet::from([0, 1]), "", &materials, &names);
        assert_eq!(
            expanded
                .iter()
                .map(|r| (r.node, r.depth, r.material))
                .collect::<Vec<_>>(),
            [(0, 0, None), (1, 1, None), (1, 2, Some(0)), (1, 2, Some(1))]
        );
        let found = rows(&nodes, &HashSet::new(), "gold", &materials, &names);
        assert_eq!(
            found
                .iter()
                .map(|r| (r.node, r.depth, r.material))
                .collect::<Vec<_>>(),
            [(0, 0, None), (1, 1, None), (1, 2, Some(0)), (1, 2, Some(1))]
        );
        assert!(rows(&nodes, &HashSet::new(), "missing", &materials, &names).is_empty());
    }

    #[test]
    fn imported_gltf_keeps_groups_root_order_and_mesh_mapping() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("assets/sample.glb");
        let bytes = std::fs::read(&path).unwrap();
        let mut json = crate::examples::model_json(&bytes).unwrap();
        json["nodes"] = serde_json::json!([
            {"name":"Assembly", "children":[1]},
            {"name":"Nested group", "children":[2,5]},
            {"mesh":0},
            {"name":"Other scene", "mesh":1},
            {"name":"Authored camera", "camera":0},
            {"name":"Empty group"}
        ]);
        json["meshes"][0]["name"] = "Authored mesh".into();
        let primitive = json["meshes"][0]["primitives"][0].clone();
        json["meshes"][0]["primitives"]
            .as_array_mut()
            .unwrap()
            .push(primitive);
        json["cameras"] =
            serde_json::json!([{"type":"perspective", "perspective":{"yfov":0.5, "znear":0.01}}]);
        json["scene"] = 0.into();
        json["scenes"] = serde_json::json!([{"nodes":[4,0]}, {"nodes":[3]}]);
        let bytes = crate::examples::with_json(&bytes, &json).unwrap();
        let model = mutracer_native_probe::scene_api::viewer_support::Model::load_bytes(
            &bytes,
            Some(&path),
        )
        .unwrap();
        let nodes = from_gltf(&json, &model);
        let visible = rows(&nodes, &HashSet::from([0, 1]), "", &[], &[]);
        assert_eq!(
            visible
                .iter()
                .map(|r| (r.node, r.depth))
                .collect::<Vec<_>>(),
            [(4, 0), (0, 0), (1, 1), (2, 2), (5, 2)]
        );
        assert_eq!(nodes[2].name, "Authored mesh");
        assert_eq!(nodes[2].parent, Some(1));
        assert_eq!(nodes.len(), 6);
        assert_eq!(nodes[2].meshes, [0, 1]);
        assert_eq!(model.node_indices, [2, 2]);
        assert!(nodes[3].unused);
        assert!(nodes[5].meshes.is_empty());
        let scene = crate::model_scene::Scene::load(&json, &path, &mut model.clone()).unwrap();
        assert_eq!(scene.nodes[4].camera, Some(0));
    }

    #[test]
    fn search_retains_ancestors_and_collapsed_branches_stay_small() {
        let nodes = vec![
            Node {
                name: "Group".into(),
                children: vec![1],
                ..Default::default()
            },
            Node {
                name: "Camera".into(),
                parent: Some(0),
                ..Default::default()
            },
        ];
        assert_eq!(rows(&nodes, &HashSet::new(), "", &[], &[]).len(), 1);
        let result = rows(&nodes, &HashSet::new(), "camera", &[], &[]);
        assert_eq!(result.len(), 2);
        assert_eq!(result[1].depth, 1);
        assert!(rows(&nodes, &HashSet::new(), "missing", &[], &[]).is_empty());
    }
}
