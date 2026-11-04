//! Offscreen import/render evidence through the viewer's real model/renderer path.
use crate::{
    renderer::{self, Camera, Renderer},
    scene::{Environment, Model},
};
use anyhow::{Result, ensure};
use std::{path::Path, time::Instant};
pub fn run(path: &Path, out: &Path) -> Result<()> {
    std::fs::create_dir_all(out)?;
    mutracer_native_probe::logging::stderr();
    let mode: u32 = std::env::var("MUTRACER_SCENE_BACKEND")
        .unwrap_or_else(|_| "1".into())
        .parse()?;
    ensure!(
        mode <= 2,
        "MUTRACER_SCENE_BACKEND must be 0 (software), 1 (hardware) or 2 (auto)"
    );
    let started = Instant::now();
    let model = Model::load(path)?;
    let imported = started.elapsed().as_secs_f64();
    let size = [96, 64];
    let camera = Camera::fit(model.center, model.radius);
    let mut cache = None;
    let descriptor = model.update_descriptor(
        &mut cache,
        &camera.bytes(size),
        size,
        &Environment::default(),
        &crate::scene::KeyLight::default(),
    );
    let encoded = started.elapsed().as_secs_f64();
    let word = |i: usize| u32::from_le_bytes(descriptor[i * 4..i * 4 + 4].try_into().unwrap());
    std::fs::write(
        out.join("input.json"),
        serde_json::to_vec_pretty(
            &serde_json::json!({"bytes":descriptor.len(),"geometries":word(4),"meshes":word(5),"materials":word(6),"lights":word(7),"textures":word(8),"importSeconds":imported}),
        )?,
    )?;
    let mut render = Renderer::with_backend(mode)?;
    render.commit(&descriptor)?;
    let committed = started.elapsed().as_secs_f64();
    let pixels = render.finish(8)?;
    let rendered = started.elapsed().as_secs_f64();
    for (name, data) in [
        ("hdr", pixels),
        ("normal", render.image(1)?),
        ("albedo", render.image(2)?),
    ] {
        ensure!(data.iter().all(|v| v.is_finite()), "Non-finite {name}");
        std::fs::write(
            out.join(format!("{name}.rgba32f")),
            data.iter()
                .flat_map(|v| v.to_le_bytes())
                .collect::<Vec<_>>(),
        )?;
        if name == "hdr" {
            renderer::save(&out.join("preview.png"), &data, size, 0.)?;
        }
    }
    let report = serde_json::json!({"path":path,"requestedBackend":mode,"backend":render.backend()?,
        "size":size,"samples":8,"importSeconds":imported,"encodeSeconds":encoded-imported,
        "commitSeconds":committed-encoded,"renderSeconds":rendered-committed,"descriptorBytes":descriptor.len(),
        "geometries":model.geometries.len(),"meshes":model.meshes.len(),"textures":model.textures.len(),
        "vertices":model.geometries.iter().map(|g| g.positions.len()/3).sum::<usize>(),
        "triangles":model.geometries.iter().map(|g| g.indices.len()/3).sum::<usize>(),"warnings":model.warnings});
    std::fs::write(out.join("result.json"), serde_json::to_vec_pretty(&report)?)?;
    println!("{report}");
    Ok(())
}
