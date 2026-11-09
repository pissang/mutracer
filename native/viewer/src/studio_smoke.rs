//! Web placement oracle plus fresh-context checks on both native backends.
use crate::{
    renderer::{self, Camera, Renderer},
    scene::{Environment, KeyLight, Model},
    studio::Studio,
};
use anyhow::{Result, ensure};
use mutracer_native::layout::light as wire;
use std::path::Path;

pub fn run(path: &Path, out: &Path) -> Result<()> {
    let fixtures: serde_json::Value =
        serde_json::from_slice(&std::fs::read(out.join("web-studio-reference.json"))?)?;
    for input in fixtures.as_array().unwrap() {
        let n = |key: &str| input[key].as_f64().unwrap() as f32;
        let studio = Studio {
            enabled: true,
            preset: input["preset"].as_u64().unwrap() as usize,
            intensity: n("intensity"),
            rotation: n("rotation"),
            size: n("size"),
            ..Studio::default()
        };
        let center = glam::Vec3::from_array(std::array::from_fn(|i| {
            input["center"][i].as_f64().unwrap() as f32
        }));
        let records = studio.records(center, n("radius"), n("ground"));
        let expected = input["lights"].as_array().unwrap();
        ensure!(
            records.len() == expected.len(),
            "Studio light count mismatch"
        );
        for (record, expected) in records.iter().zip(expected) {
            for (field, key) in [
                (wire::SIZE, "width"),
                (wire::HEIGHT_OR_INNER, "height"),
                (wire::INTENSITY, "intensity"),
            ] {
                let a = f32::from_bits(record[field]) as f64;
                let b = expected[key].as_f64().unwrap();
                ensure!(
                    (a - b).abs() < 1e-5 * b.abs().max(1e-3),
                    "Web Studio {key} mismatch"
                );
            }
            for i in 0..16 {
                let a = f32::from_bits(record[wire::TRANSFORM + i]) as f64;
                let b = expected["transform"][i].as_f64().unwrap();
                ensure!(
                    (a - b).abs() < 1e-5 * b.abs().max(1.),
                    "Web Studio transform mismatch"
                );
            }
        }
    }
    let ambient: Vec<f32> =
        serde_json::from_slice(&std::fs::read(out.join("web-ambient-reference.json"))?)?;
    let (_, _, actual) = Studio {
        ambient: 1.,
        ..Studio::default()
    }
    .pixels();
    ensure!(ambient == actual, "Web Studio ambient mismatch");
    println!("PASS 24 Web Studio placement/power/ground fixtures and ambient pixels");
    let model = Model::load(path)?;
    let camera = Camera::fit(model.0.center, model.0.radius);
    let size = [128, 84];
    for mode in [0, 1] {
        let mut retained = Renderer::with_backend(mode)?;
        let mut environment = Environment::default();
        let mut model = model.clone();
        let mut camera = camera.clone();
        let mut descriptor = None;
        let light = KeyLight::default();
        retained.commit(model.update_descriptor(
            &mut descriptor,
            &camera.bytes(size),
            size,
            &environment,
            &light,
        ))?;
        let baseline = retained.finish(8)?;
        environment.studio.enabled = true;
        for case in 0..16 {
            match case {
                0..=7 => environment.studio.preset = case,
                8 => environment.studio.intensity = 0.5,
                9 => environment.studio.rotation = 75.,
                10 => environment.studio.size = 2.,
                11 => environment.studio.ambient = 0.3,
                12 => environment.studio.ambient_color = [0.6, 0.8, 1.],
                13 => model.0.materials[0].roughness = 0.8,
                14 => camera.orbit([15., 5.]),
                _ => {
                    model.0.meshes[0].transform.w_axis.x += model.0.radius * 0.3;
                    model.refresh_bounds();
                }
            }
            let bytes = model.update_descriptor(
                &mut descriptor,
                &camera.bytes(size),
                size,
                &environment,
                &light,
            );
            ensure!(
                bytes
                    == model.descriptor_with_light(&camera.bytes(size), size, &environment, &light),
                "Cached Studio descriptor mismatch"
            );
            retained.commit(bytes)?;
            ensure!(
                retained.backend()?.0 == mode,
                "Studio must exercise requested backend"
            );
            let pixels = retained.finish(8)?;
            let mut fresh = Renderer::with_backend(mode)?;
            fresh.commit(&model.descriptor_with_light(
                &camera.bytes(size),
                size,
                &environment,
                &light,
            ))?;
            ensure!(
                pixels == fresh.finish(8)?
                    && retained.image(1)? == fresh.image(1)?
                    && retained.image(2)? == fresh.image(2)?,
                "Studio fresh mismatch: backend {mode}, case {case}"
            );
            ensure!(pixels != baseline, "Studio did not affect render");
            if case < 8 {
                renderer::save(
                    &out.join(format!("studio-{mode}-{case}.png")),
                    &pixels,
                    size,
                    0.,
                )?;
            }
            println!(
                "PASS Studio backend {mode}, case {case}, incremental {}",
                retained.last_commit_incremental()?
            );
        }
        // Mode changes must restore the original HDR environment and camera/material edits.
        let mut restored = Environment::default();
        restored.studio.enabled = true;
        restored.studio.enabled = false;
        retained.commit(&model.descriptor_with_light(
            &camera.bytes(size),
            size,
            &restored,
            &light,
        ))?;
        let mut fresh = Renderer::with_backend(mode)?;
        fresh.commit(&model.descriptor_with_light(
            &camera.bytes(size),
            size,
            &Environment::default(),
            &light,
        ))?;
        ensure!(
            retained.finish(8)? == fresh.finish(8)?,
            "HDR environment not restored"
        );
    }
    Ok(())
}
