//! C graph arrays are copied before the scene is changed.
use super::*;
#[repr(C)]
pub struct MaterialGraphDesc {
    struct_size: u32,
    version: u32,
    nodes: *const GraphNode,
    node_count: usize,
    inputs: *const GraphInput,
    input_count: usize,
    terminals: *const GraphTerminal,
    terminal_count: usize,
    parameters: *const [f32; 4],
    parameter_count: usize,
    textures: *const u64,
    texture_count: usize,
    author_ids: *const *const c_char,
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_scene_material_graph_desc_default(out: *mut MaterialGraphDesc) -> i32 {
    call(std::ptr::null_mut(), 0, || unsafe {
        output(
            out,
            MaterialGraphDesc {
                struct_size: size_of::<MaterialGraphDesc>() as u32,
                version: graph_schema::IR_VERSION,
                nodes: std::ptr::null(),
                node_count: 0,
                inputs: std::ptr::null(),
                input_count: 0,
                terminals: std::ptr::null(),
                terminal_count: 0,
                parameters: std::ptr::null(),
                parameter_count: 0,
                textures: std::ptr::null(),
                texture_count: 0,
                author_ids: std::ptr::null(),
            },
        )
    })
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_scene_material_set_graph(
    scene: u64,
    material: u64,
    graph: *const MaterialGraphDesc,
    error: *mut c_char,
    cap: usize,
) -> i32 {
    call(error, cap, || {
        with_scene(scene, |e| {
            let material = e.material(material)?;
            let graph = if graph.is_null() {
                None
            } else {
                let desc = unsafe { record(graph) }?;
                let counts = [
                    (desc.node_count, 5usize),
                    (desc.input_count, 5),
                    (desc.terminal_count, 3),
                    (desc.parameter_count, 4),
                    (desc.texture_count, 2),
                ];
                let words = counts
                    .iter()
                    .try_fold(16usize, |n, &(count, stride)| {
                        n.checked_add(count.checked_mul(stride)?)
                    })
                    .ok_or_else(|| invalid("Graph array sizes overflow"))?;
                crate::memory_budget::check(
                    words
                        .checked_mul(4)
                        .ok_or_else(|| invalid("Graph array sizes overflow"))?,
                    "Material graph",
                )
                .map_err(|e| invalid(&e.to_string()))?;
                let textures = unsafe { input(desc.textures, desc.texture_count) }?
                    .iter()
                    .map(|id| e.texture_option(*id))
                    .collect::<Result<Vec<_>>>()?;
                let author_ids = if desc.author_ids.is_null() {
                    vec![]
                } else {
                    unsafe { input(desc.author_ids, desc.node_count) }?
                        .iter()
                        .map(|id| {
                            if id.is_null() {
                                Ok(String::new())
                            } else {
                                unsafe { text(*id) }.map(str::to_owned)
                            }
                        })
                        .collect::<Result<Vec<_>>>()?
                };
                let graph = MaterialGraph {
                    version: desc.version,
                    nodes: unsafe { input(desc.nodes, desc.node_count) }?.to_vec(),
                    inputs: unsafe { input(desc.inputs, desc.input_count) }?.to_vec(),
                    terminals: unsafe { input(desc.terminals, desc.terminal_count) }?.to_vec(),
                    parameters: unsafe { input(desc.parameters, desc.parameter_count) }?.to_vec(),
                    textures,
                    author_ids,
                };
                graph.word_count()?;
                Some(graph)
            };
            e.scene.material_mut(material)?.set_graph(graph)
        })
    })
}

/// Uses the same pure evaluator as browser code generation. Arrays are copied
/// before crossing the AOT runtime; handles and author strings are not read.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_material_graph_fold(
    graph: *const MaterialGraphDesc,
    values: *mut f32,
    widths: *mut u32,
    capacity: usize,
    error: *mut c_char,
    cap: usize,
) -> i32 {
    call(error, cap, || {
        let d = unsafe { record(graph) }?;
        if capacity < d.terminal_count
            || d.terminal_count > 0 && (values.is_null() || widths.is_null())
        {
            return Err(invalid("Graph fold output capacity is too small"));
        }
        let counts = [
            (d.node_count, 20usize),
            (d.input_count, 20),
            (d.terminal_count, 12),
            (d.parameter_count, 16),
        ];
        let bytes = counts
            .iter()
            .try_fold(0usize, |sum, (count, stride)| {
                sum.checked_add(count.checked_mul(*stride)?)
            })
            .ok_or_else(|| invalid("Graph arrays overflow"))?;
        crate::memory_budget::check(bytes, "Material graph fold")
            .map_err(|e| invalid(&e.to_string()))?;
        let graph = MaterialGraph {
            version: d.version,
            nodes: unsafe { input(d.nodes, d.node_count) }?.to_vec(),
            inputs: unsafe { input(d.inputs, d.input_count) }?.to_vec(),
            terminals: unsafe { input(d.terminals, d.terminal_count) }?.to_vec(),
            parameters: unsafe { input(d.parameters, d.parameter_count) }?.to_vec(),
            ..Default::default()
        };
        let results = graph.fold_constants()?;
        for (i, result) in results.into_iter().enumerate() {
            let value = result.unwrap_or_default();
            let mut out = [0f32; 4];
            out[..value.len()].copy_from_slice(&value);
            unsafe {
                widths.add(i).write(value.len() as u32);
                std::ptr::copy_nonoverlapping(out.as_ptr(), values.add(i * 4), 4);
            }
        }

        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn graph_c_arrays_are_copied_and_invalid_replacements_keep_previous_graph() {
        unsafe {
            let mut scene = 0;
            assert_eq!(mt_scene_create(&mut scene, std::ptr::null_mut(), 0), 0);
            let mut material = 0;
            let mut material_desc = std::mem::MaybeUninit::<MaterialDesc>::uninit();
            assert_eq!(
                mt_scene_material_desc_default(material_desc.as_mut_ptr()),
                0
            );
            assert_eq!(
                mt_scene_add_material(
                    scene,
                    material_desc.as_ptr(),
                    &mut material,
                    std::ptr::null_mut(),
                    0
                ),
                0
            );
            let mut desc = std::mem::MaybeUninit::<MaterialGraphDesc>::uninit();
            assert_eq!(mt_scene_material_graph_desc_default(desc.as_mut_ptr()), 0);
            let mut desc = desc.assume_init();
            assert_eq!(size_of::<MaterialGraphDesc>(), 8 + 11 * size_of::<usize>());
            let mut parameters = [[0.25, 0., 0., 0.]];
            desc.parameters = parameters.as_ptr();
            desc.parameter_count = 1;
            assert_eq!(
                mt_scene_material_set_graph(scene, material, &desc, std::ptr::null_mut(), 0),
                0
            );
            parameters[0][0] = 0.75;
            let value = || {
                with_scene(scene, |e| {
                    Ok(e.scene
                        .material(e.material(material)?)?
                        .graph
                        .as_ref()
                        .unwrap()
                        .parameters[0][0])
                })
                .unwrap()
            };
            assert_eq!(value(), 0.25);
            desc.struct_size = 0;
            assert_eq!(
                mt_scene_material_set_graph(scene, material, &desc, std::ptr::null_mut(), 0),
                Status::InvalidArgument as i32
            );
            assert_eq!(value(), 0.25);
            desc.struct_size = size_of::<MaterialGraphDesc>() as u32;
            parameters[0][0] = f32::NAN;
            assert!(parameters[0][0].is_nan());
            assert_eq!(
                mt_scene_material_set_graph(scene, material, &desc, std::ptr::null_mut(), 0),
                Status::InvalidArgument as i32
            );
            assert_eq!(value(), 0.25);
            assert_eq!(
                mt_scene_material_set_graph(
                    scene,
                    material,
                    std::ptr::null(),
                    std::ptr::null_mut(),
                    0
                ),
                0
            );
            assert!(
                with_scene(scene, |e| Ok(e
                    .scene
                    .material(e.material(material)?)?
                    .graph
                    .is_none()))
                .unwrap()
            );
            assert_eq!(mt_scene_destroy(scene, std::ptr::null_mut(), 0), 0);
        }
    }
}
