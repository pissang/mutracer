//! Explicit adapter/API validation. Run one invocation at a time on a real GPU.
//! `cargo run --example adapter-validation -- --list`
//! `cargo run --example adapter-validation -- INDEX software|hardware adapter|device OUT [4k|limits]`
use anyhow::{Result, ensure};
use glam::Mat4;
use mutracer_native::{
    api::{
        Backend, Camera, ConvergeOptions, Engine, EngineOptions, PixelKind, Render, RenderSettings,
        RenderSize,
    },
    scene_api::{
        Environment, EnvironmentSettings, Geometry, Mesh, OpenPbrMaterial, Scene, Texture,
        TexturePixels,
    },
};
use std::{fs, path::Path, sync::Arc};

fn save(render: &Render, directory: &Path, stage: &str) -> Result<()> {
    for kind in [PixelKind::Hdr, PixelKind::Normal, PixelKind::Albedo] {
        let image = render.read_pixels(kind)?;
        ensure!(
            image.data.iter().all(|v| v.is_finite()),
            "nonfinite {stage}/{kind:?}"
        );
        fs::write(
            directory.join(format!("{stage}-{kind:?}.bin")),
            image
                .data
                .iter()
                .flat_map(|v| v.to_le_bytes())
                .collect::<Vec<_>>(),
        )?;
    }
    Ok(())
}

fn main() -> Result<()> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    let adapters = Engine::adapters();
    let inventory: Vec<_> = adapters.iter().enumerate().map(|(index, a)| {
        let i = a.get_info();
        serde_json::json!({"index":index,"name":i.name,"api":format!("{:?}",i.backend),"type":format!("{:?}",i.device_type),"vendor":i.vendor,"device":i.device,"driver":i.driver,"driverInfo":i.driver_info,"rayQuery":a.features().contains(wgpu::Features::EXPERIMENTAL_RAY_QUERY),"limits":format!("{:?}",a.limits())})
    }).collect();
    println!("{}", serde_json::to_string_pretty(&inventory)?);
    if args.first().is_some_and(|s| s == "--list") {
        return Ok(());
    }
    ensure!(
        args.len() >= 4,
        "INDEX software|hardware adapter|device OUT [4k|limits]"
    );
    let index: usize = args[0].parse()?;
    let adapter = adapters
        .get(index)
        .ok_or_else(|| anyhow::anyhow!("adapter index out of range"))?;
    ensure!(
        matches!(
            adapter.get_info().device_type,
            wgpu::DeviceType::DiscreteGpu | wgpu::DeviceType::IntegratedGpu
        ),
        "real hardware required"
    );
    let backend = match args[1].as_str() {
        "software" => Backend::Software,
        "hardware" => Backend::Hardware,
        _ => anyhow::bail!("invalid traversal"),
    };
    if backend == Backend::Hardware {
        ensure!(
            adapter
                .features()
                .contains(wgpu::Features::EXPERIMENTAL_RAY_QUERY),
            "adapter lacks ray query"
        );
    }
    let engine = match args[2].as_str() {
        "adapter" => Engine::on_adapter(adapter, EngineOptions { backend })?,
        "device" => {
            let features = if backend == Backend::Hardware {
                wgpu::Features::EXPERIMENTAL_RAY_QUERY
            } else {
                wgpu::Features::empty()
            };
            let (device, queue) =
                pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
                    required_limits: {
                        let mut l = adapter.limits();
                        l.max_buffer_size = l.max_buffer_size.min(u32::MAX as u64);
                        l
                    },
                    required_features: features,
                    experimental_features: unsafe { wgpu::ExperimentalFeatures::enabled() },
                    ..Default::default()
                }))?;
            Engine::on_device(adapter, &device, &queue, EngineOptions { backend }, None)
        }
        _ => anyhow::bail!("invalid constructor"),
    };
    ensure!(
        engine.info().adapter_name == adapter.get_info().name,
        "selected adapter changed"
    );
    let directory = Path::new(&args[3]);
    fs::create_dir_all(directory)?;
    let mut scene = Scene::new();
    let geometry = scene.add_geometry(Geometry::new(
        vec![-10., 10., 0., 10., 10., 0., -10., -10., 0., 10., -10., 0.],
        vec![0, 2, 1, 2, 3, 1],
    ))?;
    scene.geometry_mut(geometry)?.uv[0] = vec![0., 1., 1., 1., 0., 0., 1., 0.].into();
    let material = scene.add_material(OpenPbrMaterial::default())?;
    scene.material_mut(material)?.values.roughness = 0.4;
    scene.material_mut(material)?.values.metalness = 0.2;
    let mesh = scene.add_mesh(Mesh::new(geometry, material))?;
    scene.mesh_mut(mesh)?.transform = Mat4::from_rotation_z(0.17);
    let source: Arc<[f32]> = vec![
        0.1, 0.2, 0.3, 1., 0.8, 0.4, 0.2, 1., 0.2, 0.9, 0.4, 1., 1.2, 0.1, 0.6, 1., 0.4, 0.1, 0.8,
        1., 0.6, 1.1, 0.2, 1., 0.7, 0.3, 0.5, 1., 0.2, 0.5, 1.3, 1.,
    ]
    .into();
    let texture = scene.add_texture(Texture {
        width: 4,
        height: 2,
        pixels: TexturePixels::Rgba32F(source.clone()),
        ..Texture::rgba8(1, 1, vec![])
    })?;
    scene.material_mut(material)?.textures[0] = Some(texture);
    scene.set_environment(Environment {
        texture: Some(texture),
        background: Some(texture),
        ..Default::default()
    })?;
    let mut camera = Camera::default();
    camera.world_matrix[14] = 4.;
    scene.set_default_camera(Some(camera));
    let large = args.get(4).is_some_and(|s| s == "4k");
    let extent = if large { [3840, 2160] } else { [48, 32] };
    let settings = RenderSettings {
        max_samples: if large { 1 } else { 4 },
        bounces: 1,
        bevel: false,
        dispersion_wavelengths: 1,
        size: RenderSize::Fixed {
            width: extent[0],
            height: extent[1],
        },
        ..Default::default()
    };
    let render = Render::new(&engine, settings.clone())?;
    engine.set_scene_object(&scene)?;
    engine.update()?;
    render.converge(ConvergeOptions::new(settings.max_samples))?;
    ensure!(
        render.backend()?.0 == backend,
        "actual traversal differs from request"
    );
    let image = render.read_pixels(PixelKind::Hdr)?;
    ensure!([image.width, image.height] == extent, "resolution changed");
    save(&render, directory, "original")?;
    let mut results = vec![];
    if !large {
        for (stage, controls) in [
            (
                "lighting-intensity",
                EnvironmentSettings {
                    intensity: 2.5,
                    ..Default::default()
                },
            ),
            (
                "lighting-yaw",
                EnvironmentSettings {
                    intensity: 2.5,
                    rotation: 1.2,
                    ..Default::default()
                },
            ),
            (
                "background-intensity",
                EnvironmentSettings {
                    intensity: 2.5,
                    rotation: 1.2,
                    background_intensity: 0.25,
                    ..Default::default()
                },
            ),
            (
                "background-yaw",
                EnvironmentSettings {
                    intensity: 2.5,
                    rotation: 1.2,
                    background_intensity: 0.25,
                    background_rotation: -0.8,
                },
            ),
        ] {
            scene.set_environment_settings(controls)?;
            engine.set_scene_object(&scene)?;
            engine.update()?;
            render.converge(ConvergeOptions::new(settings.max_samples))?;
            save(&render, directory, stage)?;
            let descriptor = scene.descriptor()?;
            let fresh = Engine::on_adapter(adapter, EngineOptions { backend })?;
            let other = Render::new(&fresh, settings.clone())?;
            fresh.set_scene(&descriptor)?;
            fresh.update()?;
            other.converge(ConvergeOptions::new(settings.max_samples))?;
            for kind in [PixelKind::Hdr, PixelKind::Normal, PixelKind::Albedo] {
                ensure!(
                    render.read_pixels(kind)? == other.read_pixels(kind)?,
                    "incremental/full mismatch: {stage} {kind:?}"
                );
            }
            let TexturePixels::Rgba32F(retained) = &scene.texture(texture)?.pixels else {
                anyhow::bail!("texture encoding changed")
            };
            ensure!(retained.as_ref() == source.as_ref(), "source HDRI modified");
            results.push(serde_json::json!({"stage":stage,"incrementalEqualsFull":true,"sourceUnchanged":true}));
        }
    }
    if args.get(4).is_some_and(|s| s == "limits") {
        for size in [[8193, 1], [1, 8193], [8192, 2049], [4096, 4097], [0, 1]] {
            let mut options = settings.clone();
            options.size = RenderSize::Fixed {
                width: size[0],
                height: size[1],
            };
            let error = match Render::new(&engine, options) {
                Ok(r) => {
                    let result = r.converge(ConvergeOptions::new(1));
                    ensure!(result.is_err(), "accepted invalid size {size:?}");
                    result.err().unwrap()
                }
                Err(e) => e,
            };
            results.push(serde_json::json!({"size":size,"error":error.message}));
        }
        for size in [[8192, 1], [1, 8192], [4096, 4096], [8192, 2048]] {
            let mut options = settings.clone();
            options.max_samples = 1;
            options.size = RenderSize::Fixed {
                width: size[0],
                height: size[1],
            };
            let boundary = Render::new(&engine, options)?;
            boundary.converge(ConvergeOptions::new(1))?;
            let output = boundary.read_pixels(PixelKind::Hdr)?;
            ensure!(
                [output.width, output.height] == size,
                "boundary resolution changed"
            );
            ensure!(
                output.data.iter().all(|v| v.is_finite()),
                "nonfinite boundary output"
            );
            results.push(serde_json::json!({"size":size,"accepted":true,"floats":output.data.len(),"actualTraversal":format!("{:?}",boundary.backend()?.0)}));
        }
        // Verify the engine is healthy after rejection.
        render.converge(ConvergeOptions::new(settings.max_samples))?;
    }
    fs::write(
        directory.join("summary.json"),
        serde_json::to_vec_pretty(
            &serde_json::json!({"passed":true,"adapter":inventory[index],"constructor":args[2],"actualTraversal":format!("{:?}",render.backend()?.0),"extent":extent,"checks":results}),
        )?,
    )?;
    engine.dispose();
    Ok(())
}
