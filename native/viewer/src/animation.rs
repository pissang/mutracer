#[cfg(test)]
use crate::scene::Model;
#[cfg(test)]
use glam::{Mat4, Vec3};
#[cfg(test)]
use mutracer_native_probe::scene_api::viewer_support::Animation;
#[cfg(test)]
use std::sync::Arc;
#[cfg(test)]
mod tests {
    use super::*;
    use crate::renderer::Camera;
    use serde_json::{Value, json};
    use std::path::PathBuf;

    struct Fixture {
        json: Value,
        bytes: Vec<u8>,
    }
    struct File(PathBuf);
    impl Drop for File {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }
    impl Fixture {
        fn new() -> Self {
            let mut fixture = Self {
                json: json!({
                    "asset": {"version": "2.0"}, "scene": 0,
                    "scenes": [{"nodes": [0]}], "nodes": [{"mesh": 0}],
                    "meshes": [{"primitives": [{"attributes": {"POSITION": 0}}]}],
                    "buffers": [], "bufferViews": [], "accessors": [], "animations": []
                }),
                bytes: vec![],
            };
            fixture.floats(&[-0.5, -0.5, 0., 0.5, -0.5, 0., 0., 0.5, 0.], "VEC3", 3);
            fixture.json["accessors"][0]["min"] = json!([-0.5, -0.5, 0.]);
            fixture.json["accessors"][0]["max"] = json!([0.5, 0.5, 0.]);
            fixture
        }
        fn accessor(&mut self, bytes: &[u8], kind: &str, count: usize, component: u32) -> usize {
            let views = self.json["bufferViews"].as_array_mut().unwrap();
            let view = views.len();
            views.push(
                json!({"buffer": 0, "byteOffset": self.bytes.len(), "byteLength": bytes.len()}),
            );
            self.bytes.extend(bytes);
            let accessors = self.json["accessors"].as_array_mut().unwrap();
            let id = accessors.len();
            accessors.push(json!({"bufferView": view, "componentType": component, "count": count, "type": kind}));
            id
        }
        fn floats(&mut self, values: &[f32], kind: &str, count: usize) -> usize {
            let id = self.accessor(
                &values
                    .iter()
                    .flat_map(|v| v.to_le_bytes())
                    .collect::<Vec<_>>(),
                kind,
                count,
                5126,
            );
            let width = values.len() / count;
            let min: Vec<_> = (0..width)
                .map(|k| {
                    values
                        .iter()
                        .skip(k)
                        .step_by(width)
                        .copied()
                        .fold(f32::INFINITY, f32::min)
                })
                .collect();
            let max: Vec<_> = (0..width)
                .map(|k| {
                    values
                        .iter()
                        .skip(k)
                        .step_by(width)
                        .copied()
                        .fold(f32::NEG_INFINITY, f32::max)
                })
                .collect();
            self.json["accessors"][id]["min"] = json!(min);
            self.json["accessors"][id]["max"] = json!(max);
            id
        }
        fn clip(
            &mut self,
            node: usize,
            property: &str,
            times: &[f32],
            values: &[f32],
            interpolation: &str,
            kind: &str,
            count: usize,
        ) -> Value {
            let input = self.floats(times, "SCALAR", times.len());
            let output = self.floats(values, kind, count);
            json!({"samplers": [{"input": input, "output": output, "interpolation": interpolation}],
                "channels": [{"sampler": 0, "target": {"node": node, "path": property}}]})
        }
        fn document(&mut self) -> gltf::Document {
            self.json["buffers"] = json!([{"byteLength": self.bytes.len()}]);
            gltf::Gltf::from_slice(&serde_json::to_vec(&self.json).unwrap())
                .unwrap()
                .document
        }
        fn save(&mut self, path: &std::path::Path) {
            use base64::Engine;
            self.json["buffers"] = json!([{"byteLength": self.bytes.len(),
                "uri": format!("data:application/octet-stream;base64,{}", base64::engine::general_purpose::STANDARD.encode(&self.bytes))}]);
            std::fs::write(path, serde_json::to_vec(&self.json).unwrap()).unwrap();
        }
        fn load(&mut self) -> Model {
            // Parallel tests can receive the same clock timestamp on macOS.
            static NEXT_FIXTURE: std::sync::atomic::AtomicU64 =
                std::sync::atomic::AtomicU64::new(0);
            let nonce = NEXT_FIXTURE.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let file = File(std::env::temp_dir().join(format!(
                "mutracer-animation-{}-{nonce}.gltf",
                std::process::id()
            )));
            self.save(&file.0);
            Model::load(&file.0).unwrap()
        }
    }
    fn seek(model: &mut Model, time: f32) {
        model.0.animation.as_mut().unwrap().seek(time);
        model.apply_animation().unwrap();
    }
    fn close(a: Vec3, b: Vec3) {
        assert!((a - b).length() < 1e-5, "{a:?} != {b:?}");
    }

    #[test]
    fn hierarchy_shared_meshes_clip_restoration_and_user_offsets() {
        let mut fixture = Fixture::new();
        fixture.json["nodes"] = json!([
            {"children": [1, 2], "translation": [1., 0., 0.]},
            {"mesh": 0}, {"mesh": 0, "translation": [0., 3., 0.]}
        ]);
        let first = fixture.clip(
            0,
            "translation",
            &[0., 1.],
            &[1., 0., 0., 3., 0., 0.],
            "LINEAR",
            "VEC3",
            2,
        );
        let second = fixture.clip(
            1,
            "translation",
            &[0., 1.],
            &[0., 0., 0., 0., 2., 0.],
            "LINEAR",
            "VEC3",
            2,
        );
        fixture.json["animations"] = json!([first, second]);
        let mut model = fixture.load();
        assert_eq!(model.0.meshes[0].geometry, model.0.meshes[1].geometry);
        assert!(!model.0.animation.as_ref().unwrap().playing);
        seek(&mut model, 0.5);
        close(
            model.0.meshes[0].transform.w_axis.truncate(),
            Vec3::new(2., 0., 0.),
        );
        close(
            model.0.meshes[1].transform.w_axis.truncate(),
            Vec3::new(2., 3., 0.),
        );
        let before = model.0.meshes[1].transform;
        let after = Mat4::from_translation(Vec3::Z) * before;
        model
            .animation
            .as_mut()
            .unwrap()
            .edit_transform(1, before, after);
        model.0.meshes[1].transform = after;
        model.0.animation.as_mut().unwrap().select(1);
        seek(&mut model, 1.);
        close(
            model.0.meshes[0].transform.w_axis.truncate(),
            Vec3::new(1., 2., 0.),
        );
        close(
            model.0.meshes[1].transform.w_axis.truncate(),
            Vec3::new(1., 3., 1.),
        );
        assert!(!model.apply_animation().unwrap());
        model.0.animation.as_mut().unwrap().select(0);
        model.apply_animation().unwrap();
        close(model.0.meshes[0].transform.w_axis.truncate(), Vec3::X);
    }

    #[test]
    fn initial_clip_pose_is_paused_and_instancing_keeps_local_transforms() {
        let mut fixture = Fixture::new();
        let instances = fixture.floats(&[0., 0., 0., 0., 3., 0.], "VEC3", 2);
        fixture.json["extensionsUsed"] = json!(["EXT_mesh_gpu_instancing"]);
        fixture.json["nodes"][0]["extensions"] = json!({
            "EXT_mesh_gpu_instancing": {"attributes": {"TRANSLATION": instances}}
        });
        let clip = fixture.clip(
            0,
            "translation",
            &[0., 1.],
            &[4., 0., 0., 6., 0., 0.],
            "LINEAR",
            "VEC3",
            2,
        );
        fixture.json["animations"] = json!([clip]);
        let mut model = fixture.load();
        assert_eq!(model.0.meshes.len(), 2);
        assert_eq!(model.0.geometries.len(), 1);
        close(
            model.0.meshes[0].transform.w_axis.truncate(),
            Vec3::new(4., 0., 0.),
        );
        close(
            model.0.meshes[1].transform.w_axis.truncate(),
            Vec3::new(4., 3., 0.),
        );
        assert!(!model.0.animation.as_ref().unwrap().playing);
        assert!(!model.apply_animation().unwrap());
        seek(&mut model, 0.5);
        close(
            model.0.meshes[1].transform.w_axis.truncate(),
            Vec3::new(5., 3., 0.),
        );
    }

    #[test]
    fn concurrent_fixture_loads_keep_independent_animation_data() {
        let barrier = std::sync::Barrier::new(8);
        std::thread::scope(|scope| {
            for index in 0..8 {
                let barrier = &barrier;
                scope.spawn(move || {
                    barrier.wait();
                    for round in 0..4 {
                        let mut fixture = Fixture::new();
                        let x = (index * 4 + round + 1) as f32;
                        let clip = fixture.clip(
                            0,
                            "translation",
                            &[0., 1.],
                            &[x, 0., 0., x + 1., 0., 0.],
                            "LINEAR",
                            "VEC3",
                            2,
                        );
                        fixture.json["animations"] = json!([clip]);
                        let model = fixture.load();
                        close(
                            model.0.meshes[0].transform.w_axis.truncate(),
                            Vec3::new(x, 0., 0.),
                        );
                    }
                });
            }
        });
    }

    fn skinned_morph_fixture() -> Fixture {
        let mut fixture = Fixture::new();
        let morph = fixture.floats(&[2., 0., 0., 2., 0., 0., 2., 0., 0.], "VEC3", 3);
        fixture.json["meshes"][0]["primitives"][0]["targets"] = json!([{"POSITION": morph}]);
        fixture.json["meshes"][0]["weights"] = json!([0.]);
        fixture.json["nodes"] = json!([
            {"children": [1, 2], "translation": [1., 0., 0.]},
            {"mesh": 0, "skin": 0, "translation": [2., 0., 0.]}, {}
        ]);
        fixture.json["skins"] = json!([{"joints": [2]}]);
        let joints = fixture.accessor(&[0; 24], "VEC4", 3, 5123);
        let weights = fixture.floats(&[1., 0., 0., 0., 1., 0., 0., 0., 1., 0., 0., 0.], "VEC4", 3);
        fixture.json["meshes"][0]["primitives"][0]["attributes"]["JOINTS_0"] = json!(joints);
        fixture.json["meshes"][0]["primitives"][0]["attributes"]["WEIGHTS_0"] = json!(weights);
        let mut clip = fixture.clip(1, "weights", &[0., 1.], &[0., 1.], "LINEAR", "SCALAR", 2);
        let joint_clip = fixture.clip(
            2,
            "translation",
            &[0., 1.],
            &[0., 0., 0., 0., 2., 0.],
            "LINEAR",
            "VEC3",
            2,
        );
        clip["samplers"]
            .as_array_mut()
            .unwrap()
            .push(joint_clip["samplers"][0].clone());
        let mut joint_channel = joint_clip["channels"][0].clone();
        joint_channel["sampler"] = json!(1);
        clip["channels"].as_array_mut().unwrap().push(joint_channel);
        fixture.json["animations"] = json!([clip]);
        fixture
    }

    #[test]
    fn morph_is_applied_before_skin_and_geometry_snapshots_keep_their_pose() {
        let mut model = skinned_morph_fixture().load();
        let snapshot = model.clone();
        seek(&mut model, 0.5);
        let geometry = &model.0.geometries[0];
        let point = model.0.meshes[0]
            .transform
            .transform_point3(Vec3::from_slice(&geometry.positions[..3]));
        close(point, Vec3::new(1.5, 0.5, 0.));
        assert_ne!(
            model.0.geometries[0].positions,
            snapshot.geometries[0].positions
        );
        seek(&mut model, 0.);
        assert_eq!(
            model.0.geometries[0].positions,
            snapshot.geometries[0].positions
        );
    }

    #[test]
    fn playback_seek_speed_loop_and_nonloop_restart() {
        let mut fixture = Fixture::new();
        let clip = fixture.clip(
            0,
            "translation",
            &[0., 1.],
            &[0., 0., 0., 1., 0., 0.],
            "LINEAR",
            "VEC3",
            2,
        );
        fixture.json["animations"] = json!([clip]);
        let mut model = fixture.load();
        let animation = model.0.animation.as_mut().unwrap();
        animation.seek(0.95);
        animation.toggle();
        animation.speed = 2.;
        animation.advance(0.05);
        assert!((animation.time - 0.05).abs() < 1e-6);
        animation.looping = false;
        animation.seek(0.95);
        animation.toggle();
        animation.advance(0.05);
        assert_eq!(animation.time, 1.);
        assert!(!animation.playing);
        animation.toggle();
        assert_eq!(animation.time, 0.);
        assert!(animation.playing);
        animation.seek(9.);
        assert_eq!(animation.time, 1.);
        assert!(!animation.playing);
        animation.advance(0.1);
        assert_eq!(animation.time, 1.);
        animation.seek(-1.);
        assert_eq!(animation.time, 0.);
    }

    #[test]
    fn invalid_keys_are_rejected_and_singular_pose_keeps_the_last_good_model() {
        let mut fixture = Fixture::new();
        let clip = fixture.clip(0, "translation", &[0., 0.], &[0.; 6], "LINEAR", "VEC3", 2);
        fixture.json["animations"] = json!([clip]);
        let document = fixture.document();
        assert!(Animation::load(&document, &[gltf::buffer::Data(fixture.bytes.clone())]).is_err());
        let mut fixture = Fixture::new();
        let clip = fixture.clip(
            0,
            "scale",
            &[0., 1.],
            &[1., 1., 1., 0., 0., 0.],
            "LINEAR",
            "VEC3",
            2,
        );
        fixture.json["animations"] = json!([clip]);
        let mut model = fixture.load();
        let before = model.clone();
        model.0.animation.as_mut().unwrap().seek(1.);
        assert!(model.apply_animation().is_err());
        assert_eq!(model.0.meshes[0].transform, before.meshes[0].transform);
        assert!(Arc::ptr_eq(&model.0.geometries, &before.geometries));
        assert!(!model.0.animation.as_ref().unwrap().playing);
    }

    #[test]
    #[ignore = "requires a real GPU with software BVH and HWRT"]
    fn gpu_animated_poses_match_fresh_scenes_and_playback_keeps_presenting() {
        use crate::{
            Change, Viewer,
            renderer::Renderer,
            scene::{Environment, KeyLight},
        };
        use std::time::{Duration, Instant};

        fn tick(viewer: &mut Viewer, ctx: &eframe::egui::Context) {
            if let Err(error) = viewer.tick(ctx) {
                assert!(crate::renderer::NativeError::is_busy(&error), "{error:#}");
            }
            std::thread::sleep(Duration::from_millis(2));
        }
        fn settle(viewer: &mut Viewer, ctx: &eframe::egui::Context) {
            let deadline = Instant::now() + Duration::from_secs(30);
            loop {
                tick(viewer, ctx);
                if viewer.settled()
                    && viewer.pose_presented
                    && viewer.model.0.animation.as_ref().is_none_or(|a| !a.pending)
                    && viewer.samples == viewer.settings.max_samples
                {
                    return;
                }
                assert!(
                    Instant::now() < deadline,
                    "Animation did not settle: {}",
                    viewer.error
                );
            }
        }

        let mut fixture = skinned_morph_fixture();
        let second = fixture.clip(
            0,
            "translation",
            &[0., 1.],
            &[1., 0., 0., 2., 0., 0.],
            "LINEAR",
            "VEC3",
            2,
        );
        fixture.json["animations"]
            .as_array_mut()
            .unwrap()
            .push(second);
        let file = File(std::env::temp_dir().join(format!(
            "mutracer-animation-gpu-{}.gltf",
            std::process::id()
        )));
        fixture.save(&file.0);
        let evidence = std::env::var_os("MUTRACER_ANIMATION_EVIDENCE").map(PathBuf::from);
        if let Some(out) = &evidence {
            std::fs::create_dir_all(out).unwrap();
            fixture.save(&out.join("animated.gltf"));
        }
        let size = [96, 64];
        let mut camera = Camera::fit(Vec3::new(2., 1., 0.), 2.);
        camera.yaw = 0.;
        camera.pitch = 0.;
        let mut report = Vec::new();
        for mode in [0, 1] {
            let mut model = Model::load(&file.0).unwrap();
            let environment = Environment::default();
            let light = KeyLight::default();
            let mut retained = Renderer::with_backend(mode).unwrap();
            let mut fresh = Renderer::with_backend(mode).unwrap();
            let mut descriptor = None;
            let mut previous = Vec::new();
            let mut changed = 0;
            let mut incremental = 0;
            for (frame, time) in [0., 0.25, 0.5, 0.75, 1., 0.].into_iter().enumerate() {
                seek(&mut model, time);
                retained
                    .commit(model.update_descriptor(
                        &mut descriptor,
                        &camera.bytes(size),
                        size,
                        &environment,
                        &light,
                    ))
                    .unwrap();
                incremental += usize::from(retained.last_commit_incremental().unwrap());
                assert_eq!(retained.samples().unwrap(), 0);
                let actual = retained.finish(4).unwrap();
                assert_eq!(
                    retained.backend().unwrap().0,
                    mode,
                    "Unexpected backend fallback"
                );
                fresh
                    .commit(&model.descriptor_with_light(
                        &camera.bytes(size),
                        size,
                        &environment,
                        &light,
                    ))
                    .unwrap();
                assert_eq!(
                    actual,
                    fresh.finish(4).unwrap(),
                    "HDR differs: backend {mode}, time {time}"
                );
                assert_eq!(
                    retained.image(1).unwrap(),
                    fresh.image(1).unwrap(),
                    "Normal differs: backend {mode}, time {time}"
                );
                assert_eq!(
                    retained.image(2).unwrap(),
                    fresh.image(2).unwrap(),
                    "Albedo differs: backend {mode}, time {time}"
                );
                if !previous.is_empty() && actual != previous {
                    changed += 1;
                }
                previous = actual;
                if let Some(out) = &evidence {
                    crate::renderer::save(
                        &out.join(format!("mode-{mode}-pose-{frame}.png")),
                        &previous,
                        size,
                        0.,
                    )
                    .unwrap();
                    let positions: Vec<_> =
                        model.0.geometries.iter().map(|g| &g.positions).collect();
                    let transforms: Vec<_> = model
                        .meshes
                        .iter()
                        .map(|m| m.transform.to_cols_array())
                        .collect();
                    std::fs::write(
                        out.join(format!("mode-{mode}-pose-{frame}.json")),
                        serde_json::to_vec_pretty(
                            &json!({"time":time,"positions":positions.iter().map(|p|p.as_ref()).collect::<Vec<_>>(),"transforms":transforms}),
                        )
                        .unwrap(),
                    )
                    .unwrap();
                }
            }
            assert!(
                changed >= 4,
                "Animated poses did not change the rendered image"
            );
            assert!(incremental > 0, "No incremental animation commits");
            drop(retained);
            drop(fresh);

            let ctx = eframe::egui::Context::default();
            let mut viewer = Viewer::new(&file.0).unwrap();
            viewer.backend = mode;
            viewer.size = size;
            viewer.camera = camera.clone();
            viewer.settings.max_samples = 4;
            viewer.denoise = false;
            viewer.focus.enabled = false;
            viewer.dirty(Change::Scene);
            settle(&mut viewer, &ctx);
            // Distinct poses whose image was presented.
            let mut generations = std::collections::HashSet::new();
            let deadline = Instant::now() + Duration::from_secs(30);
            viewer.toggle_animation_or_render();
            while generations.len() < 6 {
                tick(&mut viewer, &ctx);
                assert!(viewer.texture.is_some(), "Playback blanked the viewport");
                if viewer.frame_samples > 0 && viewer.pose_presented {
                    generations.insert(viewer.model.0.animation.as_ref().unwrap().time.to_bits());
                }
                assert!(
                    Instant::now() < deadline,
                    "Playback stopped presenting: {}",
                    viewer.error
                );
            }
            viewer.toggle_animation_or_render();
            let paused = viewer.model.0.animation.as_ref().unwrap().time;
            assert!(paused > 0., "Playback clock did not advance");
            settle(&mut viewer, &ctx);
            assert_eq!(viewer.model.0.animation.as_ref().unwrap().time, paused);
            viewer.model.0.animation.as_mut().unwrap().seek(0.75);
            // The old frame has already converged; seeking must still schedule a new pose.
            settle(&mut viewer, &ctx);
            assert_eq!(viewer.model.0.animation.as_ref().unwrap().time, 0.75);
            viewer.model.0.animation.as_mut().unwrap().select(1);
            settle(&mut viewer, &ctx);
            assert_eq!(viewer.model.0.animation.as_ref().unwrap().time, 0.);
            let mut reference = Renderer::with_backend(mode).unwrap();
            reference
                .commit_with_settings(
                    &viewer.model.descriptor_with_light(
                        &viewer.camera.bytes(size),
                        size,
                        &viewer.environment,
                        &viewer.light,
                    ),
                    &viewer.settings,
                )
                .unwrap();
            assert_eq!(
                viewer.hdr().unwrap(),
                reference.finish(4).unwrap(),
                "Final paused pose differs from fresh scene"
            );
            assert_eq!(viewer.render_backend().unwrap(), mode);
            report.push(json!({"backend":mode,"poses":6,"changedImages":changed,"incrementalCommits":incremental,"displayedGenerations":generations.len(),"pausedTime":paused}));
        }
        if let Some(out) = evidence {
            std::fs::write(
                out.join("report.json"),
                serde_json::to_vec_pretty(&report).unwrap(),
            )
            .unwrap();
        }
    }
}
