//! Explicit first-hit execution; no diagnostic buffers or atomics in render PSOs.
use super::*;

pub(super) fn read_raw(gpu: &GpuDevice, source: &wgpu::Buffer) -> Result<Vec<u8>> {
    gpu.queue.read_buffer(&gpu.device, source.slice(..))
}

// Geometry is an explicit diagnostic payload, independent of shader text.
// NumPy evaluates barycentric world points in float64, with no GPU rounding.
pub(super) fn write_geometry_snapshot(scene: &Scene, assets: &Assets, output: &Path) -> Result<()> {
    fs::create_dir_all(output)?;
    fs::write(
        output.join("layout.json"),
        serde_json::to_vec_pretty(
            scene
                .native_layout
                .as_ref()
                .ok_or("Missing diagnostic layout")?,
        )?,
    )?;
    for id in [1, 2, 3, 35, 40] {
        let key = AssetId::Packet(id);
        fs::write(
            output.join(format!("{key}.bin")),
            assets.get(&key).ok_or("Missing diagnostic geometry")?,
        )?;
    }
    Ok(())
}

pub fn run(input: &[u8], output: &Path) -> Result<()> {
    run_side(input, &output.join("software"), false)?;
    run_side(input, &output.join("hardware"), true)?;
    for (side, file) in [
        ("software", "software.hit.bin"),
        ("hardware", "hardware.hit.bin"),
    ] {
        fs::copy(output.join(side).join(file), output.join(file))?;
    }
    fs::copy(output.join("hardware/info.json"), output.join("info.json"))?;
    fs::copy(output.join("hardware/rays.bin"), output.join("rays.bin"))?;
    Ok(())
}
fn run_side(input: &[u8], output: &Path, hardware: bool) -> Result<()> {
    let _entry = ENTRY_LOCK.try_lock().map_err(|_| "Native core is active")?;
    let (mut scene, mut assets) = if hardware {
        scene::prepare_hardware(input)?
    } else {
        scene::prepare_diagnostic(input, false)?
    };
    write_geometry_snapshot(&scene, &assets, output)?;
    let layout = scene
        .native_layout
        .as_ref()
        .ok_or("Missing native layout")?;
    let mut capture = hardware::capture_from_resources(&mut assets, layout)?;
    if std::env::var_os("MUTRACER_NATIVE_HIT_INPUTS").is_some_and(|v| v == "1") {
        fs::create_dir_all(output)?;
        fs::write(
            output.join("layout.json"),
            serde_json::to_vec_pretty(layout)?,
        )?;
        fs::write(
            output.join("capture.json"),
            serde_json::to_vec_pretty(&capture)?,
        )?;
        for (name, bytes) in &assets {
            if matches!(
                name,
                AssetId::Packet(1 | 2 | 3 | 4)
                    | AssetId::HardwareMap
                    | AssetId::GeometryPositions(_)
            ) {
                fs::write(output.join(format!("{name}.bin")), bytes)?;
            }
        }
    }
    if let Ok(instance) = std::env::var("MUTRACER_NATIVE_HIT_INSTANCE") {
        let primitive = std::env::var("MUTRACER_NATIVE_HIT_PRIMITIVE")
            .ok()
            .map(|v| v.parse())
            .transpose()?;
        hardware::isolate_diagnostic(
            &mut capture,
            &mut assets,
            instance.parse()?,
            if hardware { primitive } else { None },
        )?;
    }
    if capture.geometries.iter().any(|g| g.procedural) {
        return Err("First-hit diagnostics exclude displacement geometries".into());
    }
    capture.shader = Some(AssetId::Packet(34));
    scene.hwrt = Some(capture);
    scene.entry_point = "diagnoseHits".into();
    scene.shader = AssetId::Packet(39);
    let gpu = GpuDevice::with_backend(1)?;
    if !gpu.hardware_ray_query {
        return Err("Diagnostic requires actual HWRT".into());
    }
    let (state, target) = GpuScene::new(
        scene,
        &RenderOptions {
            flags: if hardware { 4 } else { 0 },
            ..Default::default()
        },
        &assets,
        gpu,
    )?;
    state.dispatch_target(&target, 0, 1, None)?;
    let sw = read_raw(&state.gpu, &target.buffers[&10])?;
    let sw_bary = read_raw(&state.gpu, &target.buffers[&11])?;
    let hw = read_raw(&state.gpu, &target.buffers[&12])?;
    let auxiliary = read_raw(&state.gpu, &target.buffers[&13])?;
    let pixels = state.scene.width as usize * state.scene.height as usize;
    let mut software = Vec::with_capacity(pixels * 32);
    let mut hardware = Vec::with_capacity(pixels * 32);
    let mut rays = Vec::with_capacity(pixels * 32);
    for i in 0..pixels {
        software.extend_from_slice(&sw[i * 16..i * 16 + 16]);
        software.extend_from_slice(&sw_bary[i * 16..i * 16 + 16]);
        hardware.extend_from_slice(&hw[i * 16..i * 16 + 16]);
        hardware.extend_from_slice(&auxiliary[i * 48..i * 48 + 16]);
        rays.extend_from_slice(&auxiliary[i * 48 + 16..i * 48 + 48]);
    }
    fs::create_dir_all(output)?;
    fs::write(output.join("software.hit.bin"), software)?;
    fs::write(output.join("hardware.hit.bin"), hardware)?;
    fs::write(output.join("rays.bin"), rays)?;
    fs::write(
        output.join("info.json"),
        serde_json::to_vec_pretty(&json!({
            "width":state.scene.width,"height":state.scene.height,"samples":1,"sampleIndex":0,"seed":12345,
            "actualBackend":1,"adapter":state.gpu.info.name,"recordBytes":32,
            "recordLayout":"u32 hit, i32 instance, i32 record, f32 t, f32 barycentric[3], f32 reserved",
            "orientation":"bottom row first","raysSecondVector":"direction.z, local normal dot direction, wanted confirmed, candidate count; direction.x in hit reserved; direction.y in origin.w","primaryAlpha":"first geometric hit, prior to integrator coverage"
        }))?,
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scene_api::{Geometry, Mesh, OpenPbrMaterial, Scene as SceneObject};

    #[test]
    #[ignore = "requires real hardware ray queries"]
    fn hardware_shadow_excludes_only_the_origin_primitive() {
        let _entry = ENTRY_LOCK.lock().unwrap();
        let gpu = GpuDevice::with_backend(1).unwrap();
        assert!(gpu.hardware_ray_query);
        // Exercise opaque closest-hit specialization and candidate-filtered
        // geometry, with both source-order and leaf-order primitive records.
        for double_sided in [false, true] {
            let mut object = SceneObject::new();
            let mut material = OpenPbrMaterial::default();
            material.values.double_sided = double_sided;
            let material = object.add_material(material).unwrap();
            for z in [0., 0.5] {
                let geometry = object
                    .add_geometry(Geometry::new(
                        vec![-1., -1., z, 1., -1., z, 0., 1., z],
                        vec![0, 1, 2],
                    ))
                    .unwrap();
                object.add_mesh(Mesh::new(geometry, material)).unwrap();
            }
            let mut input = object.descriptor().unwrap().as_ref().clone();
            input[8..12].copy_from_slice(&8u32.to_le_bytes());
            input[12..16].copy_from_slice(&8u32.to_le_bytes());
            for indexed in [false, true] {
                let (mut scene, mut assets) = scene::prepare_diagnostic(&input, indexed).unwrap();
                let layout = scene.native_layout.as_ref().unwrap();
                scene.hwrt = Some(hardware::capture_from_resources(&mut assets, layout).unwrap());
                scene.hwrt.as_mut().unwrap().shader = Some(AssetId::Packet(33));
                let shader = assets.get_mut(&AssetId::Packet(33)).unwrap();
                shader.extend_from_slice(
                    br#"
@compute @workgroup_size(8, 8, 1)
fn shadowContract(@builtin(global_invocation_id) id: vec3u) {
  if (any(id.xy != vec2u(0u))) { return; }
  var ray: Ray;
  initRay(&ray, vec3f(0.0, 0.0, -1.0), vec3f(0.0, 0.0, 1.0));
  let record = mtRecord(0, 0u);
  outColor[0] = vec4f(
    f32(intersectSceneShadow(ray, 1.25, record, 0)),
    f32(intersectSceneShadow(ray, 1.25, -1, -1)),
    f32(intersectSceneShadow(ray, 1.25, record, 1)),
    f32(intersectSceneShadow(ray, 3.0, record, 0)));
}
"#,
                );
                scene.shader = AssetId::Packet(33);
                scene.entry_point = "shadowContract".into();
                let (state, target) = GpuScene::new(
                    scene,
                    &RenderOptions {
                        flags: 4,
                        ..Default::default()
                    },
                    &assets,
                    gpu.clone(),
                )
                .unwrap();
                state.dispatch_target(&target, 0, 1, None).unwrap();
                let bytes = read_raw(&gpu, &target.buffers[&10]).unwrap();
                let values: Vec<_> = bytes[..16]
                    .chunks_exact(4)
                    .map(|v| f32::from_le_bytes(v.try_into().unwrap()))
                    .collect();
                assert_eq!(
                    values,
                    [0., 1., 1., 1.],
                    "indexed={indexed}, double_sided={double_sided}"
                );
            }
        }
    }
}
