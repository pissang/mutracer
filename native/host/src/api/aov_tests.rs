use super::*;

#[test]
#[ignore = "requires real GPU"]
fn temporal_camera_orbits_with_extreme_clip_ranges_preserve_history() {
    use std::sync::{Arc, Mutex};
    struct History(Arc<Mutex<Vec<(Vec<TemporalResetReason>, bool)>>>);
    impl CustomDenoiser for History {
        fn input_mode(&self) -> DenoiseInputMode {
            DenoiseInputMode::TemporalGpu
        }
        fn denoise(
            &self,
            mut input: DenoiseInput,
            _: CancelToken,
        ) -> std::result::Result<DenoiseOutput, String> {
            let frame = input.resident.take().unwrap();
            let temporal = frame.temporal.as_ref().unwrap();
            self.0.lock().unwrap().push((
                temporal.reset_reasons().to_vec(),
                temporal.previous_metadata().is_some(),
            ));
            let output = frame.buffers.color.clone();
            frame.submit([], output).map(DenoiseOutput::Resident)
        }
    }
    let _guard = crate::ABI_TEST_LOCK.lock().unwrap();
    let engine = aov_engine(aov_test_backend());
    engine.display().set_size(16, 12).unwrap();
    engine.set_scene(&tests::lit_scene()).unwrap();
    let frames = Arc::new(Mutex::new(Vec::new()));
    let render = Render::new(&engine, RenderSettings::default()).unwrap();
    render
        .set_custom_denoiser(
            Some(Arc::new(History(frames.clone()))),
            DenoiseSchedule::Converged,
        )
        .unwrap();
    for projection in [0, 1] {
        frames.lock().unwrap().clear();
        render.reset_temporal_history().unwrap();
        let mut camera = Camera {
            projection,
            near_clip: 0.0001,
            far_clip: 1000.,
            ..Default::default()
        };
        for yaw in [0.6f32, 0.7, 0.9] {
            let eye = glam::Vec3::new(yaw.sin(), 0.3, yaw.cos()) * 4.;
            camera.world_matrix = glam::Mat4::from(
                glam::Affine3A::look_at_rh(eye, glam::Vec3::ZERO, glam::Vec3::Y).inverse(),
            )
            .to_cols_array();
            engine.set_camera(Some(camera)).unwrap();
            engine.update().unwrap();
            render.converge(ConvergeOptions::new(2)).unwrap();
        }
        {
            let observed = frames.lock().unwrap();
            assert_eq!(observed.len(), 3);
            assert!(!observed[0].1);
            for (resets, previous) in &observed[1..] {
                assert!(resets.is_empty(), "{resets:?}");
                assert!(*previous);
            }
        }
        if projection == 0 {
            camera.fov += 5.;
        } else {
            camera.zoom = 1.2;
        }
        engine.set_camera(Some(camera)).unwrap();
        engine.update().unwrap();
        render.converge(ConvergeOptions::new(2)).unwrap();
        let observed = frames.lock().unwrap();
        assert!(
            observed[3]
                .0
                .contains(&TemporalResetReason::ProjectionChanged)
        );
        assert!(!observed[3].1);
    }
}
#[test]
fn aov_options_validate_without_a_device() {
    let defaults = RenderSettings::default();
    assert_eq!((defaults.aovs, defaults.aov_samples), (0, 16));
    for options in [
        RenderSettings {
            aovs: 128,
            ..defaults.clone()
        },
        RenderSettings {
            aov_samples: 0,
            ..defaults.clone()
        },
    ] {
        assert_eq!(
            options.validate().unwrap_err().status,
            Status::InvalidArgument
        );
    }
}
#[test]
#[ignore = "requires real GPU"]
fn independent_surface_aovs_preserve_beauty_and_exact_ids() {
    independent_surface_aovs(aov_test_backend());
}
fn independent_surface_aovs(backend: Backend) {
    let _guard = crate::ABI_TEST_LOCK.lock().unwrap();
    let engine = aov_engine(backend);
    let mut descriptor = tests::lit_scene();
    let mut words: Vec<_> = descriptor
        .chunks_exact(4)
        .map(|b| u32::from_le_bytes(b.try_into().unwrap()))
        .collect();
    words[24] = words.len() as u32;
    words.extend([101, 102]);
    words[25] = words.len() as u32;
    words.extend([202, 203]);
    words[1] = words.len() as u32;
    descriptor = words.into_iter().flat_map(u32::to_le_bytes).collect();
    engine.display().set_size(48, 32).unwrap();
    engine.set_scene(&descriptor).unwrap();
    engine.update().unwrap();
    let render = Render::new(
        &engine,
        RenderSettings {
            max_samples: 4,
            bounces: 1,
            ..Default::default()
        },
    )
    .unwrap();
    render.converge(ConvergeOptions::new(4)).unwrap();
    if backend == Backend::Hardware {
        assert_eq!(render.backend().unwrap().0, Backend::Hardware);
    }
    let before = render.read_pixels(PixelKind::Hdr).unwrap();
    let mut settings = render.settings().unwrap();
    settings.aovs = 127;
    settings.aov_samples = 4;
    render.set_settings(settings).unwrap();
    render.converge(ConvergeOptions::new(4)).unwrap();
    assert_eq!(before, render.read_pixels(PixelKind::Hdr).unwrap());
    let depth = render.read_pixels(PixelKind::Depth).unwrap();
    assert!(depth.data.iter().all(|v| v.is_finite()));
    assert!(depth.data.chunks_exact(4).any(|v| v[0] > 0. && v[3] > 0.));
    let ids = render.read_pixels(PixelKind::Id).unwrap().id_data.unwrap();
    assert!(ids.chunks_exact(4).any(|v| v[0] == 102 && v[2] == 203));
    assert!(ids.chunks_exact(4).all(|v| v[0] == u32::MAX || v[3] < 2));
    assert!(ids.chunks_exact(4).any(|v| v[0] == 101 && v[2] == 202));
    assert!(
        ids.chunks_exact(4)
            .all(|v| v[0] == u32::MAX || [101, 102].contains(&v[0]))
    );
    assert!(
        render
            .read_pixels(PixelKind::Motion)
            .unwrap()
            .data
            .iter()
            .all(|v| *v == 0.)
    );
    for kind in [PixelKind::DiffuseAlbedo, PixelKind::SpecularAlbedo] {
        let values = render.read_pixels(kind).unwrap().data;
        assert!(values.iter().all(|v| v.is_finite()));
        assert!(values.chunks_exact(4).any(|v| v[3] > 0. && v[0] > 0.));
    }
    let mut camera = Camera::from_bytes(&descriptor[160 * 4..192 * 4]).unwrap();
    camera.world_matrix[12] += 0.25;
    engine.set_camera(Some(camera)).unwrap();
    engine.update().unwrap();
    render.converge(ConvergeOptions::new(4)).unwrap();
    let motion = render.read_pixels(PixelKind::Motion).unwrap();
    let identity = render.read_pixels(PixelKind::Id).unwrap().id_data.unwrap();
    let expected = 32. * 0.5 / (std::f32::consts::PI / 8.).tan() * 0.25 / 4.;
    let valid: Vec<_> = motion
        .data
        .chunks_exact(4)
        .zip(identity.chunks_exact(4))
        .filter(|(m, id)| m[3] == 3. && id[0] == 101)
        .collect();
    assert!(valid.len() > 40);
    assert!(
        valid
            .iter()
            .all(|(m, _)| (m[0] - expected).abs() < 0.001 && m[1].abs() < 0.001)
    );
    descriptor[(44 + 4 + 12) * 4..(44 + 4 + 13) * 4].copy_from_slice(&0.25f32.to_le_bytes());
    engine.set_scene(&descriptor).unwrap();
    engine.update().unwrap();
    render.converge(ConvergeOptions::new(4)).unwrap();
    let motion = render.read_pixels(PixelKind::Motion).unwrap();
    let identity = render.read_pixels(PixelKind::Id).unwrap().id_data.unwrap();
    let valid: Vec<_> = motion
        .data
        .chunks_exact(4)
        .zip(identity.chunks_exact(4))
        .filter(|(m, id)| m[3] == 3. && id[0] == 101)
        .collect();
    assert!(valid.len() > 40);
    assert!(valid.iter().all(|(m, _)| (m[0] + expected).abs() < 0.001));
    let mut transform = glam::Mat4::from_rotation_z(0.1).to_cols_array();
    transform[12] = 0.25;
    for (i, v) in transform.iter().enumerate() {
        descriptor[(48 + i) * 4..(49 + i) * 4].copy_from_slice(&v.to_le_bytes());
    }
    engine.set_scene(&descriptor).unwrap();
    engine.update().unwrap();
    render.converge(ConvergeOptions::new(4)).unwrap();
    let rotated = render.read_pixels(PixelKind::Motion).unwrap();
    let identity = render.read_pixels(PixelKind::Id).unwrap().id_data.unwrap();
    let mut count = 0;
    let focal = 16. / (std::f32::consts::PI / 8.).tan();
    let (c, s) = (0.1f32.cos(), -0.1f32.sin());
    for (y, row) in rotated.data.chunks_exact(48 * 4).enumerate() {
        for (x, m) in row.chunks_exact(4).enumerate() {
            if m[3] != 3. || identity[(y * 48 + x) * 4] != 101 {
                continue;
            }
            let wx = camera.world_matrix[12] + (x as f32 + 0.5 - 24.) * 4. / focal;
            let wy = camera.world_matrix[13] + (16. - y as f32 - 0.5) * 4. / focal;
            let px = 0.25 + c * (wx - 0.25) - s * wy;
            let py = s * (wx - 0.25) + c * wy;
            let expected_x = (px - camera.world_matrix[12]) * focal / 4. + 24. - x as f32 - 0.5;
            let expected_y = 16. - (py - camera.world_matrix[13]) * focal / 4. - y as f32 - 0.5;
            assert!((m[0] - expected_x).abs() < 0.001 && (m[1] - expected_y).abs() < 0.001);
            count += 1;
        }
    }
    assert!(count > 40);
    descriptor[192 * 4..193 * 4].copy_from_slice(&(-1.2f32).to_le_bytes());
    engine.set_scene(&descriptor).unwrap();
    engine.update().unwrap();
    render.converge(ConvergeOptions::new(4)).unwrap();
    assert!(
        render
            .read_pixels(PixelKind::Motion)
            .unwrap()
            .data
            .chunks_exact(4)
            .all(|v| v[3] == 0.)
    );
    if let Ok(directory) = std::env::var("MUTRACER_AOV_EVIDENCE") {
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(
            format!("{directory}/native-ids.bin"),
            ids.iter().flat_map(|v| v.to_le_bytes()).collect::<Vec<_>>(),
        )
        .unwrap();
        std::fs::write(
            format!("{directory}/native-depth.bin"),
            depth
                .data
                .iter()
                .flat_map(|v| v.to_le_bytes())
                .collect::<Vec<_>>(),
        )
        .unwrap();
    }
}

struct AovFilter {
    resident: bool,
    calls: std::sync::Arc<std::sync::atomic::AtomicUsize>,
}
impl CustomDenoiser for AovFilter {
    fn aovs(&self) -> u32 {
        1 | 8 | 32
    }
    fn input_mode(&self) -> DenoiseInputMode {
        if self.resident {
            DenoiseInputMode::ResidentGpu
        } else {
            DenoiseInputMode::Cpu
        }
    }
    fn denoise(
        &self,
        mut input: DenoiseInput,
        _cancel: CancelToken,
    ) -> std::result::Result<DenoiseOutput, String> {
        self.calls
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        if self.resident {
            assert!(input.aovs.is_empty());
            let resident = input.resident.take().unwrap();
            assert_eq!(resident.aovs.len(), 3);
            for aov in &resident.aovs {
                assert_eq!(
                    aov.buffer.size(),
                    (input.size[0] * input.size[1] * 16) as u64
                );
            }
            let output = resident.buffers.color.clone();
            Ok(DenoiseOutput::Resident(resident.submit([], output)?))
        } else {
            assert!(input.resident.is_none());
            assert_eq!(input.aovs.len(), 3);
            let depth = input
                .aovs
                .iter()
                .find(|a| a.kind == PixelKind::Depth)
                .unwrap();
            assert!(depth.data.iter().any(|v| *v > 0.));
            let id = input
                .aovs
                .iter()
                .find(|a| a.kind == PixelKind::Id)
                .unwrap()
                .id_data
                .as_ref()
                .unwrap();
            assert!(id.iter().any(|v| *v == 0));
            Ok(DenoiseOutput::Cpu(input.color))
        }
    }
}
#[test]
#[ignore = "requires real GPU"]
fn custom_filters_receive_only_declared_aovs_in_cpu_and_resident_modes() {
    let _guard = crate::ABI_TEST_LOCK.lock().unwrap();
    let engine = aov_engine(aov_test_backend());
    engine.display().set_size(16, 12).unwrap();
    engine.set_scene(&tests::lit_scene()).unwrap();
    engine.update().unwrap();
    for resident in [false, true] {
        let calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let render = Render::new(
            &engine,
            RenderSettings {
                max_samples: 2,
                aovs: 0,
                ..Default::default()
            },
        )
        .unwrap();
        render
            .set_custom_denoiser(
                Some(std::sync::Arc::new(AovFilter {
                    resident,
                    calls: calls.clone(),
                })),
                DenoiseSchedule::Converged,
            )
            .unwrap();
        render.converge(ConvergeOptions::new(2)).unwrap();
        assert_eq!(calls.load(std::sync::atomic::Ordering::Relaxed), 1);
        assert!(render.read_pixels(PixelKind::Depth).is_err());
        assert!(
            render
                .read_pixels(PixelKind::Denoised)
                .unwrap()
                .data
                .iter()
                .all(|v| v.is_finite())
        );
    }
}

struct TemporalFilter {
    engine: Engine,
    frames: std::sync::Arc<std::sync::Mutex<Vec<(u32, usize, Vec<TemporalResetReason>)>>>,
}
impl CustomDenoiser for TemporalFilter {
    fn input_mode(&self) -> DenoiseInputMode {
        DenoiseInputMode::TemporalGpu
    }
    fn denoise(
        &self,
        mut input: DenoiseInput,
        _cancel: CancelToken,
    ) -> std::result::Result<DenoiseOutput, String> {
        let resident = input.resident.take().unwrap();
        let frame = resident.temporal.as_ref().unwrap();
        assert_eq!(frame.metadata().sample_count, 1);
        assert_eq!(frame.metadata().pre_exposure, 1.);
        assert_eq!(
            frame.pixel_records().size(),
            (input.size[0] * input.size[1] * 240) as u64
        );
        assert_eq!(
            frame.stable_ids().size(),
            (input.size[0] * input.size[1] * 16) as u64
        );
        // Read both orientations independently: guides are top-first, while
        // pixel records and stable integer identities are bottom-first.
        let records =
            crate::hit_diagnostics::read_raw(&self.engine.inner.gpu, frame.pixel_records())
                .unwrap();
        let stable =
            crate::hit_diagnostics::read_raw(&self.engine.inner.gpu, frame.stable_ids()).unwrap();
        let depth = crate::test_support::read_texture(
            &self.engine.inner.gpu,
            frame.guide(TemporalGuide::LinearDepth).unwrap(),
        );
        for y in 0..input.size[1] as usize {
            for x in 0..input.size[0] as usize {
                let bottom = y * input.size[0] as usize + x;
                let top = (input.size[1] as usize - 1 - y) * input.size[0] as usize + x;
                assert_eq!(
                    &records[bottom * 240 + 44..bottom * 240 + 48],
                    &depth[top * 4..top * 4 + 4]
                );
                let flags = u32::from_le_bytes(
                    records[bottom * 240 + 140..bottom * 240 + 144]
                        .try_into()
                        .unwrap(),
                );
                let identity: Vec<_> = stable[bottom * 16..bottom * 16 + 16]
                    .chunks_exact(4)
                    .map(|b| u32::from_le_bytes(b.try_into().unwrap()))
                    .collect();
                assert_eq!(identity == [u32::MAX; 4], flags & 1 == 0);
            }
        }
        assert!(matches!(
            frame.metadata().capabilities.specular_distance,
            TemporalSupport::Unverified
        ));
        assert!(matches!(
            frame.metadata().capabilities.deformation_motion,
            TemporalSupport::Unverified
        ));
        let validity = crate::test_support::read_texture(
            &self.engine.inner.gpu,
            frame.guide(TemporalGuide::Validity).unwrap(),
        );
        let motion = crate::test_support::read_texture(
            &self.engine.inner.gpu,
            frame.guide(TemporalGuide::Motion).unwrap(),
        );
        let flags: Vec<_> = validity
            .chunks_exact(4)
            .map(|b| u32::from_le_bytes(b.try_into().unwrap()))
            .collect();
        let valid = flags.iter().filter(|f| **f & 2 != 0).count();
        if frame.metadata().sample_index == 0 {
            assert_eq!(valid, 0);
            assert!(frame.previous_metadata().is_none());
        }
        let motion_x: Vec<_> = motion
            .chunks_exact(8)
            .map(|b| f32::from_le_bytes(b[..4].try_into().unwrap()))
            .collect();
        if frame.metadata().sample_index == 1 {
            assert!(valid > 10);
            assert!(motion_x.iter().any(|x| *x > 0.5));
            assert!(frame.previous_metadata().is_some());
        }
        if frame.metadata().sample_index == 2 {
            assert!(valid > 10);
            assert!(motion_x.iter().any(|x| *x < -0.5));
        }
        self.frames.lock().unwrap().push((
            frame.metadata().sample_index,
            valid,
            frame.reset_reasons().to_vec(),
        ));
        let output = resident.buffers.color.clone();
        Ok(DenoiseOutput::Resident(resident.submit([], output)?))
    }
}
#[test]
#[ignore = "requires real GPU"]
fn temporal_resident_frames_advance_only_after_acceptance_and_support_rigid_motion() {
    accepted_temporal_frames(aov_test_backend());
}
fn accepted_temporal_frames(backend: Backend) {
    let _guard = crate::ABI_TEST_LOCK.lock().unwrap();
    let engine = aov_engine(backend);
    let mut scene = tests::lit_scene();
    engine.display().set_size(16, 12).unwrap();
    engine.set_scene(&scene).unwrap();
    engine.update().unwrap();
    let frames = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let render = Render::new(
        &engine,
        RenderSettings {
            max_samples: 2,
            ..Default::default()
        },
    )
    .unwrap();
    render
        .set_custom_denoiser(
            Some(std::sync::Arc::new(TemporalFilter {
                engine: engine.clone(),
                frames: frames.clone(),
            })),
            DenoiseSchedule::Converged,
        )
        .unwrap();
    render.converge(ConvergeOptions::new(2)).unwrap();
    if backend == Backend::Hardware {
        assert_eq!(render.backend().unwrap().0, Backend::Hardware);
    }
    let mut camera = Camera::from_bytes(&scene[160 * 4..192 * 4]).unwrap();
    camera.world_matrix[12] += 0.25;
    engine.set_camera(Some(camera)).unwrap();
    engine.update().unwrap();
    render.converge(ConvergeOptions::new(2)).unwrap();
    scene[(44 + 4 + 12) * 4..(44 + 4 + 13) * 4].copy_from_slice(&0.25f32.to_le_bytes());
    engine.set_scene(&scene).unwrap();
    engine.update().unwrap();
    render.converge(ConvergeOptions::new(2)).unwrap();
    assert_eq!(frames.lock().unwrap().len(), 3);
    assert!(
        frames.lock().unwrap()[0]
            .2
            .contains(&TemporalResetReason::FirstFrame)
    );
    assert!(frames.lock().unwrap()[1].2.is_empty());
    render.reset_temporal_history().unwrap();
    render.converge(ConvergeOptions::new(2)).unwrap();
    assert!(
        frames.lock().unwrap()[3]
            .2
            .contains(&TemporalResetReason::Explicit)
    );
}

struct RejectTemporal {
    calls: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    resets: std::sync::Arc<std::sync::Mutex<Vec<Vec<TemporalResetReason>>>>,
}
impl CustomDenoiser for RejectTemporal {
    fn input_mode(&self) -> DenoiseInputMode {
        DenoiseInputMode::TemporalGpu
    }
    fn denoise(
        &self,
        mut input: DenoiseInput,
        _: CancelToken,
    ) -> std::result::Result<DenoiseOutput, String> {
        let n = self
            .calls
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let resident = input.resident.take().unwrap();
        self.resets
            .lock()
            .unwrap()
            .push(resident.temporal.as_ref().unwrap().reset_reasons().to_vec());
        if n == 1 {
            return Err("deliberate temporal rejection".into());
        }
        let output = resident.buffers.color.clone();
        Ok(DenoiseOutput::Resident(resident.submit([], output)?))
    }
}
#[test]
#[ignore = "requires real GPU"]
fn temporal_rejection_resets_the_next_frame_and_pinhole_limits_are_enforced() {
    let _guard = crate::ABI_TEST_LOCK.lock().unwrap();
    let engine = aov_engine(aov_test_backend());
    let scene = tests::lit_scene();
    engine.display().set_size(16, 12).unwrap();
    engine.set_scene(&scene).unwrap();
    engine.update().unwrap();
    let calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let resets = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let filter = std::sync::Arc::new(RejectTemporal {
        calls: calls.clone(),
        resets: resets.clone(),
    });
    let render = Render::new(
        &engine,
        RenderSettings {
            max_samples: 2,
            ..Default::default()
        },
    )
    .unwrap();
    render
        .set_custom_denoiser(Some(filter.clone()), DenoiseSchedule::Converged)
        .unwrap();
    render.converge(ConvergeOptions::new(2)).unwrap();
    let _ = render.converge(ConvergeOptions::new(2));
    assert_eq!(calls.load(std::sync::atomic::Ordering::Relaxed), 2);
    render
        .set_custom_denoiser(Some(filter), DenoiseSchedule::Converged)
        .unwrap();
    render.converge(ConvergeOptions::new(2)).unwrap();
    assert!(resets.lock().unwrap()[2].contains(&TemporalResetReason::ConsumerRejected));
    let mut camera = Camera::from_bytes(&scene[160 * 4..192 * 4]).unwrap();
    camera.f_stop = 2.;
    engine.set_camera(Some(camera)).unwrap();
    engine.update().unwrap();
    let failure = render.converge(ConvergeOptions::new(2)).unwrap_err();
    assert!(failure.message.contains("pinhole"));
}

#[test]
#[ignore = "requires real GPU"]
fn surface_aov_plane_matches_cross_backend_fixture_with_uint32_ids() {
    let _guard = crate::ABI_TEST_LOCK.lock().unwrap();
    let engine = aov_engine(aov_test_backend());
    let mut words: Vec<_> = tests::lit_scene()
        .chunks_exact(4)
        .map(|b| u32::from_le_bytes(b.try_into().unwrap()))
        .collect();
    // Rotate the shared edge away from exact pixel centers: ties have no unique
    // surface triangle and depend on camera matrix rounding across hosts.
    let rotation = glam::Mat4::from_rotation_z(0.17);
    for (i, v) in rotation.to_cols_array().iter().enumerate() {
        words[48 + i] = v.to_bits();
    }
    words[5] = 1;
    words[6] = 1;
    words[7] = 0;
    for (i, v) in [-10f32, 10., 0., 10., 10., 0., -10., -10., 0., 10., -10., 0.]
        .iter()
        .enumerate()
    {
        words[192 + i] = v.to_bits();
    }
    words[204..210].copy_from_slice(&[0, 2, 1, 2, 3, 1]);
    words[84..89].copy_from_slice(&[
        1f32.to_bits(),
        1f32.to_bits(),
        1f32.to_bits(),
        0.4f32.to_bits(),
        0.2f32.to_bits(),
    ]);
    let mut camera = Camera::default();
    camera.far_clip = 100.;
    camera.world_matrix[14] = 4.;
    words[160..192].copy_from_slice(
        &camera
            .to_bytes()
            .chunks_exact(4)
            .map(|b| u32::from_le_bytes(b.try_into().unwrap()))
            .collect::<Vec<_>>(),
    );
    words[24] = words.len() as u32;
    words.push(0xfffffffe);
    words[25] = words.len() as u32;
    words.push(0x800001ff);
    words[1] = words.len() as u32;
    let descriptor: Vec<_> = words.into_iter().flat_map(u32::to_le_bytes).collect();
    engine.display().set_size(48, 32).unwrap();
    engine.set_scene(&descriptor).unwrap();
    engine.update().unwrap();
    let render = Render::new(
        &engine,
        RenderSettings {
            seed: 0,
            aovs: 127,
            aov_samples: 4,
            max_samples: 4,
            bounces: 1,
            ..Default::default()
        },
    )
    .unwrap();
    render.converge(ConvergeOptions::new(4)).unwrap();
    for kind in [
        PixelKind::Id,
        PixelKind::Depth,
        PixelKind::Position,
        PixelKind::DiffuseAlbedo,
        PixelKind::SpecularAlbedo,
    ] {
        let image = render.read_pixels(kind).unwrap();
        if kind == PixelKind::Id {
            assert!(
                image
                    .id_data
                    .as_ref()
                    .unwrap()
                    .chunks_exact(4)
                    .all(|p| p[0] == 0xfffffffe && p[1] == 0 && p[2] == 0x800001ff && p[3] < 2)
            );
        }
        if kind == PixelKind::Depth {
            assert!(
                image
                    .data
                    .chunks_exact(4)
                    .all(|p| (p[0] - 4.).abs() < 1e-4 && p[3] == 1.)
            );
        }
        if let Ok(directory) = std::env::var("MUTRACER_AOV_EVIDENCE") {
            let bytes: Vec<_> = if let Some(ids) = image.id_data {
                ids.into_iter().flat_map(u32::to_le_bytes).collect()
            } else {
                image.data.into_iter().flat_map(f32::to_le_bytes).collect()
            };
            std::fs::write(format!("{directory}/cross-native-{kind:?}.bin"), bytes).unwrap();
        }
    }
}
fn aov_test_backend() -> Backend {
    if std::env::var_os("MUTRACER_AOV_HWRT").is_some() {
        Backend::Hardware
    } else {
        Backend::Software
    }
}
// An explicit adapter index proves which graphics API executes these tests.
// WGPU_BACKEND alone does not change the default Engine constructor.
pub(super) fn aov_engine(backend: Backend) -> Engine {
    let options = EngineOptions { backend };
    let engine = match std::env::var("MUTRACER_TEST_ADAPTER") {
        Ok(index) => {
            let index: usize = index.parse().expect("MUTRACER_TEST_ADAPTER index");
            let adapters = Engine::adapters();
            let adapter = adapters.get(index).expect("selected AOV adapter");
            assert!(matches!(
                adapter.get_info().device_type,
                wgpu::DeviceType::DiscreteGpu | wgpu::DeviceType::IntegratedGpu
            ));
            println!("AOV selected adapter {index}: {:?}", adapter.get_info());
            Engine::on_adapter(adapter, options).unwrap()
        }
        Err(std::env::VarError::NotPresent) => Engine::new(options).unwrap(),
        Err(error) => panic!("MUTRACER_TEST_ADAPTER: {error}"),
    };
    println!(
        "AOV device: {:?}; requested traversal: {backend:?}",
        engine.inner.gpu.info
    );
    engine
}

#[test]
#[ignore = "requires real hardware ray-query GPU"]
fn hardware_surface_aovs_preserve_beauty_ids_and_motion() {
    independent_surface_aovs(Backend::Hardware);
}
#[test]
#[ignore = "requires real hardware ray-query GPU"]
fn hardware_temporal_frames_support_rigid_motion_and_accepted_history() {
    accepted_temporal_frames(Backend::Hardware);
}

struct HeldTemporal {
    entered: std::sync::mpsc::Sender<(u32, Option<u32>, DenoiseFrameStatus)>,
    released: std::sync::Mutex<std::sync::mpsc::Receiver<()>>,
    mode: std::sync::atomic::AtomicU32,
}
impl CustomDenoiser for HeldTemporal {
    fn input_mode(&self) -> DenoiseInputMode {
        DenoiseInputMode::TemporalGpu
    }
    fn denoise(
        &self,
        mut input: DenoiseInput,
        _: CancelToken,
    ) -> std::result::Result<DenoiseOutput, String> {
        let resident = input.resident.take().unwrap();
        let frame = resident.temporal.as_ref().unwrap();
        self.entered
            .send((
                frame.metadata().sample_index,
                frame.previous_metadata().map(|m| m.sample_index),
                resident.status(),
            ))
            .unwrap();
        let mode = self.mode.load(std::sync::atomic::Ordering::Relaxed);
        if mode != 0 {
            self.released
                .lock()
                .unwrap()
                .recv_timeout(std::time::Duration::from_secs(30))
                .unwrap();
            if mode == 2 {
                return Err("deliberate pending temporal failure".into());
            }
        }
        let output = resident.buffers.color.clone();
        Ok(DenoiseOutput::Resident(resident.submit([], output)?))
    }
}

#[test]
#[ignore = "requires real GPU"]
fn temporal_cancel_replace_and_failure_keep_the_last_accepted_history() {
    use std::sync::{Arc, Mutex, atomic::Ordering, mpsc};
    use std::time::Duration;
    let _guard = crate::ABI_TEST_LOCK.lock().unwrap();
    for action in 0..3 {
        let engine = aov_engine(aov_test_backend());
        engine.display().set_size(16, 12).unwrap();
        engine.set_scene(&tests::lit_scene()).unwrap();
        engine.update().unwrap();
        let render = Arc::new(
            Render::new(
                &engine,
                RenderSettings {
                    max_samples: 2,
                    ..Default::default()
                },
            )
            .unwrap(),
        );
        let (entered, receive) = mpsc::channel();
        let (release, released) = mpsc::channel();
        let filter = Arc::new(HeldTemporal {
            entered,
            released: Mutex::new(released),
            mode: Default::default(),
        });
        render
            .set_custom_denoiser(Some(filter.clone()), DenoiseSchedule::Converged)
            .unwrap();
        render.converge(ConvergeOptions::new(2)).unwrap();
        let first = receive.recv_timeout(Duration::from_secs(30)).unwrap();
        assert_eq!((first.0, first.1), (0, None));
        assert_eq!(first.2.acceptance(), DenoiseAcceptance::Accepted);
        filter
            .mode
            .store(if action == 2 { 2 } else { 1 }, Ordering::Relaxed);
        let cancel = CancelToken::new();
        let token = cancel.clone();
        let worker_render = render.clone();
        let worker = std::thread::spawn(move || {
            let mut options = ConvergeOptions::new(2);
            options.cancel = Some(token);
            worker_render.converge(options)
        });
        let pending = receive.recv_timeout(Duration::from_secs(30)).unwrap();
        assert_eq!((pending.0, pending.1), (1, Some(0)));
        match action {
            0 => cancel.cancel(),
            1 => render
                .set_custom_denoiser(None, DenoiseSchedule::Converged)
                .unwrap(),
            _ => {}
        }
        release.send(()).unwrap();
        let result = worker.join().unwrap();
        if action != 1 {
            assert!(result.is_err());
        }
        assert_eq!(pending.2.acceptance(), DenoiseAcceptance::Rejected);
        filter.mode.store(0, Ordering::Relaxed);
        render
            .set_custom_denoiser(Some(filter), DenoiseSchedule::Converged)
            .unwrap();
        render.converge(ConvergeOptions::new(2)).unwrap();
        let next = receive.recv_timeout(Duration::from_secs(30)).unwrap();
        assert_eq!(
            (next.0, next.1),
            (2, Some(0)),
            "action {action}: rejected frame advanced temporal history"
        );
        assert_eq!(next.2.acceptance(), DenoiseAcceptance::Accepted);
        println!("temporal action {action}: accepted 0, rejected 1, next frame 2 uses history 0");
    }
}

#[test]
#[ignore = "requires real GPU"]
fn temporal_record_binding_limit_rejects_before_allocation_and_preserves_beauty() {
    let _guard = crate::ABI_TEST_LOCK.lock().unwrap();
    let adapters = Engine::adapters();
    let index = std::env::var("MUTRACER_TEST_ADAPTER")
        .map(|s| s.parse::<usize>().unwrap())
        .unwrap_or_else(|_| {
            adapters
                .iter()
                .position(|a| {
                    !matches!(
                        a.get_info().device_type,
                        wgpu::DeviceType::Cpu | wgpu::DeviceType::Other
                    )
                })
                .expect("real GPU adapter for the device-limit contract")
        });
    let adapter = &adapters[index];
    println!("limited temporal adapter: {:?}", adapter.get_info());
    let mut limits = adapter.limits();
    limits.max_storage_buffer_binding_size = 262144;
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
        required_limits: limits,
        ..Default::default()
    }))
    .unwrap();
    let engine = Engine::on_device(
        adapter,
        &device,
        &queue,
        EngineOptions {
            backend: Backend::Software,
        },
        None,
    );
    engine.set_scene(&tests::lit_scene()).unwrap();
    engine.update().unwrap();
    let render = Render::new(
        &engine,
        RenderSettings {
            max_samples: 1,
            size: RenderSize::Fixed {
                width: 48,
                height: 48,
            },
            ..Default::default()
        },
    )
    .unwrap();
    render.converge(ConvergeOptions::new(1)).unwrap();
    let before = render.read_pixels(PixelKind::Hdr).unwrap();
    let oversized = Render::new(
        &engine,
        RenderSettings {
            max_samples: 1,
            size: RenderSize::Fixed {
                width: 128,
                height: 128,
            },
            ..Default::default()
        },
    )
    .unwrap();
    let ordinary = oversized.converge(ConvergeOptions::new(1)).unwrap_err();
    assert!(ordinary.message.contains("storage buffer"), "{ordinary:?}");
    assert_eq!(render.read_pixels(PixelKind::Hdr).unwrap(), before);
    drop(oversized);
    let (entered, _) = std::sync::mpsc::channel();
    let (_, released) = std::sync::mpsc::channel();
    render
        .set_custom_denoiser(
            Some(std::sync::Arc::new(HeldTemporal {
                entered,
                released: std::sync::Mutex::new(released),
                mode: Default::default(),
            })),
            DenoiseSchedule::Converged,
        )
        .unwrap();
    let error = render.converge(ConvergeOptions::new(1)).unwrap_err();
    assert!(
        error
            .message
            .contains("Frame records exceed device storage limits"),
        "{error:?}"
    );
    assert_eq!(render.read_pixels(PixelKind::Hdr).unwrap(), before);
    render
        .set_custom_denoiser(None, DenoiseSchedule::Converged)
        .unwrap();
    render.converge(ConvergeOptions::new(1)).unwrap();
    println!(
        "48x48 beauty passed; 552960-byte temporal binding rejected against 262144 bytes; engine remains usable"
    );
}

fn full_plane_scene() -> (
    crate::scene_api::Scene,
    crate::scene_api::MeshId,
    crate::scene_api::MaterialId,
) {
    use crate::scene_api::{Geometry, Mesh, OpenPbrMaterial, Scene};
    let mut scene = Scene::new();
    let geometry = scene
        .add_geometry(Geometry::new(
            vec![-10., 10., 0., 10., 10., 0., -10., -10., 0., 10., -10., 0.],
            vec![0, 2, 1, 2, 3, 1],
        ))
        .unwrap();
    let material = scene.add_material(OpenPbrMaterial::default()).unwrap();
    let mesh = scene.add_mesh(Mesh::new(geometry, material)).unwrap();
    scene.mesh_mut(mesh).unwrap().transform = glam::Mat4::from_rotation_z(0.17);
    let mut camera = Camera::default();
    camera.world_matrix[14] = 4.;
    scene.set_default_camera(Some(camera));
    (scene, mesh, material)
}

#[test]
#[ignore = "requires real GPU with a 256 MiB storage binding"]
fn aov_resolve_covers_images_larger_than_one_dispatch_dimension() {
    let _guard = crate::ABI_TEST_LOCK.lock().unwrap();
    let engine = aov_engine(aov_test_backend());
    let (scene, object, material) = full_plane_scene();
    let (object, material) = (object.aov_id(), material.aov_id());
    engine.set_scene_object(&scene).unwrap();
    engine.update().unwrap();
    // 4,194,303 pixels: the old 64-lane 1D resolve needed 65,536 groups.
    let size = [2049, 2047];
    let render = Render::new(
        &engine,
        RenderSettings {
            max_samples: 1,
            bounces: 1,
            bevel: false,
            aovs: 1 | 32,
            aov_samples: 1,
            size: RenderSize::Fixed {
                width: size[0],
                height: size[1],
            },
            ..Default::default()
        },
    )
    .unwrap();
    render.converge(ConvergeOptions::new(1)).unwrap();
    let depth = render.read_pixels(PixelKind::Depth).unwrap();
    assert_eq!([depth.width, depth.height], size);
    assert!(
        depth
            .data
            .chunks_exact(4)
            .all(|p| (p[0] - 4.).abs() < 1e-4 && p[1] == 0. && p[2] == 0. && p[3] == 1.)
    );
    let ids = render.read_pixels(PixelKind::Id).unwrap().id_data.unwrap();
    assert!(
        ids.chunks_exact(4)
            .all(|p| p[0] == object && p[1] == 0 && p[2] == material && p[3] < 2)
    );
    println!(
        "2049x2047: all 4194303 depth and uint32 ID pixels validated on {:?}",
        render.backend().unwrap().0
    );
}

#[test]
#[ignore = "requires real GPU"]
fn unsupported_reflectance_layers_report_invalid_coverage() {
    use crate::scene_api::OpenPbrMaterial;
    let _guard = crate::ABI_TEST_LOCK.lock().unwrap();
    let engine = aov_engine(aov_test_backend());
    let (mut scene, _, material) = full_plane_scene();
    let schema: serde_json::Value =
        serde_json::from_str(include_str!("../../../schemas/material-properties.json")).unwrap();
    let property = |name: &str| {
        schema
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["key"] == name)
            .unwrap()["id"]
            .as_u64()
            .unwrap() as u32
    };
    let render = Render::new(
        &engine,
        RenderSettings {
            max_samples: 1,
            bounces: 1,
            aovs: 4 | 8 | 16,
            aov_samples: 1,
            size: RenderSize::Fixed {
                width: 8,
                height: 8,
            },
            ..Default::default()
        },
    )
    .unwrap();
    for name in [
        "supported",
        "coat",
        "fuzz",
        "anisotropy",
        "subsurface",
        "volume",
        "thin-film",
        "dispersion",
        "bevel",
        "partial-alpha",
        "unlit",
    ] {
        let mut value = OpenPbrMaterial::default();
        let mut set = |key: &str, value3: [f32; 3]| value.set_float(property(key), value3).unwrap();
        match name {
            "coat" => set("coatWeight", [0.5, 0., 0.]),
            "fuzz" => set("fuzzWeight", [0.5, 0., 0.]),
            "anisotropy" => set("specularAnisotropy", [0.5, 0., 0.]),
            "subsurface" => set("subsurfaceWeight", [0.5, 0., 0.]),
            "volume" => {
                set("transmissionWeight", [1., 0., 0.]);
                // White transmittance has zero extinction and no scattering.
                set("transmissionColor", [0.7, 0.8, 0.9]);
                set("transmissionDepth", [1., 0., 0.]);
                set("transmissionScatter", [0.2, 0.3, 0.4]);
            }
            "thin-film" => set("thinFilmWeight", [0.5, 0., 0.]),
            "dispersion" => {
                set("transmissionWeight", [1., 0., 0.]);
                set("transmissionDispersionScale", [0.5, 0., 0.]);
            }
            "bevel" => set("bevelSize", [0.05, 0., 0.]),
            "partial-alpha" => {
                set("opacity", [0.75, 0., 0.]);
                // Default cutoff selects mask in auto mode, which resolves
                // this coverage to one. Test genuinely fractional coverage.
                value.set_uint(property("alphaMode"), 3).unwrap();
            }
            "unlit" => value.set_uint(property("unlit"), 1).unwrap(),
            _ => {}
        }
        *scene.material_mut(material).unwrap() = value;
        engine.set_scene_object(&scene).unwrap();
        engine.update().unwrap();
        render.converge(ConvergeOptions::new(1)).unwrap();
        let roughness = render.read_pixels(PixelKind::Roughness).unwrap().data;
        assert!(roughness.chunks_exact(4).all(|p| p[3] == 1.));
        for kind in [PixelKind::DiffuseAlbedo, PixelKind::SpecularAlbedo] {
            let data = render.read_pixels(kind).unwrap().data;
            if name == "supported" {
                assert!(data.chunks_exact(4).all(|p| p[3] == 1. && p[0] > 0.));
            } else {
                assert!(
                    roughness.chunks_exact(4).all(|p| p[2] == 1.),
                    "{name}: unsupported flag missing"
                );
                assert!(
                    data.iter().all(|v| *v == 0.),
                    "{name}: invalid reflectance appeared valid"
                );
            }
        }
        println!("reflectance layer {name}: coverage and validity verified");
    }
}

#[test]
#[ignore = "requires a real GPU; optional driver pipeline-error reproduction"]
fn aov_pipeline_failure_returns_an_error_and_preserves_beauty() {
    let _guard = crate::ABI_TEST_LOCK.lock().unwrap();
    let engine = aov_engine(Backend::Software);
    engine.display().set_size(48, 32).unwrap();
    engine.set_scene(&tests::lit_scene()).unwrap();
    engine.update().unwrap();
    let render = Render::new(
        &engine,
        RenderSettings {
            max_samples: 4,
            bounces: 1,
            ..Default::default()
        },
    )
    .unwrap();
    render.converge(ConvergeOptions::new(4)).unwrap();
    let before = render.read_pixels(PixelKind::Hdr).unwrap().data;
    let mut settings = render.settings().unwrap();
    settings.aovs = 127;
    render.set_settings(settings.clone()).unwrap();
    let result = render.converge(ConvergeOptions::new(4));
    if std::env::var_os("MUTRACER_TEST_REQUIRE_AOV_PIPELINE_ERROR").is_some() {
        let error = result.unwrap_err();
        assert_eq!(error.status, Status::Error);
        assert!(
            error.message.contains("AOV pipeline creation failed"),
            "{error}"
        );
        println!("Driver rejected AOV pipeline without a panic: {error}");
    } else {
        result.unwrap();
        assert!(
            render
                .read_pixels(PixelKind::DiffuseAlbedo)
                .unwrap()
                .data
                .iter()
                .all(|v| v.is_finite())
        );
    }
    settings.aovs = 0;
    render.set_settings(settings).unwrap();
    render.converge(ConvergeOptions::new(4)).unwrap();
    assert_eq!(before, render.read_pixels(PixelKind::Hdr).unwrap().data);
    println!("Beauty remains byte-identical and usable after the AOV pipeline attempt");
}

#[test]
#[ignore = "requires real GPU"]
fn display_only_aovs_preserve_beauty_and_filter_and_export_without_beauty() {
    let _guard = crate::ABI_TEST_LOCK.lock().unwrap();
    let engine = aov_engine(aov_test_backend());
    engine.display().set_size(24, 16).unwrap();
    engine.set_scene(&tests::lit_scene()).unwrap();
    let mut loop_ = RenderLoop::new(
        &engine,
        RenderLoopOptions {
            preview: None,
            final_render: LoopRender::Settings(RenderSettings {
                max_samples: 4,
                aov_samples: 3,
                ..Default::default()
            }),
            ..Default::default()
        },
    )
    .unwrap();
    let render = loop_.final_render().clone();
    // Auxiliary-only startup must export without dispatching a beauty sample.
    for channel in [
        Channel::Depth,
        Channel::Position,
        Channel::Roughness,
        Channel::DiffuseAlbedo,
        Channel::SpecularAlbedo,
        Channel::Id,
        Channel::Motion,
    ] {
        let kind = channel.aov_kind().unwrap();
        let mut settings = render.settings().unwrap();
        settings.aovs = kind.aov_mask();
        render.set_settings(settings).unwrap();
        let mut settings = engine.display().settings();
        settings.channel = channel;
        engine.display().set_settings(settings).unwrap();
        for _ in 0..2000 {
            if loop_.tick().unwrap() == RenderLoopStatus::Finished && !loop_.needs_tick() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
        assert_eq!(loop_.status(), RenderLoopStatus::Finished, "{channel:?}");
        assert_eq!(render.samples(), 0, "{channel:?} advanced beauty");
        assert_eq!(
            render.aov_samples_rendered(),
            if kind.aov_mask() & 31 == 0 { 1 } else { 3 }
        );
        assert_eq!(
            engine.display().read_rgba8(&render).unwrap().2.len(),
            24 * 16 * 4
        );
        assert!(
            render
                .get_output_texture(OutputKind::Display)
                .unwrap()
                .is_some()
        );
        assert!(
            render
                .get_output_texture(OutputKind::Hdr)
                .unwrap()
                .is_none()
        );
        assert!(!loop_.needs_tick());
        if channel == Channel::Motion {
            let image = render.read_pixels(PixelKind::Motion).unwrap();
            assert!(
                image
                    .data
                    .chunks_exact(4)
                    .all(|p| p[0].abs() < 1e-5 && p[1].abs() < 1e-5)
            );
        }
    }
    let mut display = engine.display().settings();
    display.channel = Channel::Final;
    engine.display().set_settings(display).unwrap();
    let mut settings = render.settings().unwrap();
    settings.aovs = 0;
    render.set_settings(settings).unwrap();
    render
        .set_denoiser(Some(DenoiserOptions {
            backend: 5,
            schedule: DenoiseSchedule::Converged,
            ..Default::default()
        }))
        .unwrap();
    render.converge(ConvergeOptions::new(4)).unwrap();
    let hdr = render.read_pixels(PixelKind::Hdr).unwrap().data;
    let filtered = render.read_pixels(PixelKind::Denoised).unwrap().data;
    for channel in [
        Channel::Depth,
        Channel::Id,
        Channel::Position,
        Channel::Final,
    ] {
        let mut settings = render.settings().unwrap();
        settings.aovs = channel.aov_kind().map_or(0, |k| k.aov_mask());
        render.set_settings(settings).unwrap();
        let mut display = engine.display().settings();
        display.channel = channel;
        engine.display().set_settings(display).unwrap();
        for _ in 0..2000 {
            if loop_.tick().unwrap() == RenderLoopStatus::Finished {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
        assert_eq!(render.samples(), 4);
        assert_eq!(render.read_pixels(PixelKind::Hdr).unwrap().data, hdr);
        assert_eq!(
            render.read_pixels(PixelKind::Denoised).unwrap().data,
            filtered
        );
        assert_eq!(render.denoise_report().unwrap().samples, 4);
        render.restart_aovs().unwrap();
        assert_eq!(render.aov_samples_rendered(), 0);
        assert_eq!(render.samples(), 4);
        assert_eq!(
            render.read_pixels(PixelKind::Denoised).unwrap().data,
            filtered
        );
    }
}

#[test]
#[ignore = "requires real GPU"]
fn display_motion_settles_without_a_final_input_edit_or_beauty_sample() {
    use std::sync::{Arc, Mutex};
    struct Activity(SyncActivity);
    impl LoopSync for Activity {
        fn update(&mut self) {}
        fn activity(&self) -> &SyncActivity {
            &self.0
        }
        fn activity_mut(&mut self) -> &mut SyncActivity {
            &mut self.0
        }
    }
    let _guard = crate::ABI_TEST_LOCK.lock().unwrap();
    let engine = aov_engine(aov_test_backend());
    engine.display().set_size(24, 16).unwrap();
    engine.set_scene(&tests::lit_scene()).unwrap();
    let activity: SharedSync = Arc::new(Mutex::new(Activity(Default::default())));
    let settings = RenderSettings {
        aovs: 64,
        max_samples: 4,
        ..Default::default()
    };
    let mut loop_ = RenderLoop::new(
        &engine,
        RenderLoopOptions {
            preview: None,
            final_render: LoopRender::Settings(settings),
            idle_ms: 0.,
            syncs: vec![activity.clone()],
            ..Default::default()
        },
    )
    .unwrap();
    let render = loop_.final_render().clone();
    let mut display = engine.display().settings();
    display.channel = Channel::Motion;
    engine.display().set_settings(display).unwrap();
    let mut camera = Camera::default();
    camera.world_matrix = glam::Mat4::from_translation(glam::Vec3::new(0., 0., 3.)).to_cols_array();
    engine.set_camera(Some(camera)).unwrap();
    for _ in 0..2000 {
        if loop_.tick().unwrap() == RenderLoopStatus::Finished {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(1));
    }
    activity.lock().unwrap().set_active(true);
    camera.world_matrix[12] = 0.2;
    engine.set_camera(Some(camera)).unwrap();
    for _ in 0..2000 {
        if loop_.tick().unwrap() == RenderLoopStatus::Finished {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(1));
    }
    let moving = render.read_pixels(PixelKind::Motion).unwrap();
    assert!(
        moving
            .data
            .chunks_exact(4)
            .any(|p| p[3] > 0. && p[0].abs() > 1e-3),
        "No valid moving history"
    );
    activity.lock().unwrap().set_active(false);
    loop_.tick().unwrap();
    let still = render.read_pixels(PixelKind::Motion).unwrap();
    assert!(
        still
            .data
            .chunks_exact(4)
            .all(|p| p[0].abs() < 1e-5 && p[1].abs() < 1e-5)
    );
    assert!(
        still.data.chunks_exact(4).any(|p| p[3] > 0.),
        "Stationary history became invalid"
    );
    assert_eq!(render.samples(), 0);
    assert_eq!(render.aov_samples_rendered(), 1);
    assert!(!loop_.needs_tick());

    // An isolated edit must first expose displacement, then request one more
    // unchanged frame to retire it even without explicit interaction activity.
    camera.world_matrix[12] = 0.4;
    engine.set_camera(Some(camera)).unwrap();
    for _ in 0..2000 {
        if loop_.tick().unwrap() == RenderLoopStatus::Finished {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(1));
    }
    let moved = render.read_pixels(PixelKind::Motion).unwrap();
    assert!(
        moved
            .data
            .chunks_exact(4)
            .any(|p| p[3] > 0. && p[0].abs() > 1e-3)
    );
    assert!(loop_.needs_tick());
    loop_.tick().unwrap();
    let settled = render.read_pixels(PixelKind::Motion).unwrap();
    assert!(
        settled
            .data
            .chunks_exact(4)
            .all(|p| p[0].abs() < 1e-5 && p[1].abs() < 1e-5)
    );
    assert_eq!(render.samples(), 0);
    assert!(!loop_.needs_tick());
}

#[test]
#[ignore = "requires real GPU"]
fn aov_targets_use_the_requested_sampling_variant_and_reuse_it() {
    let _guard = crate::ABI_TEST_LOCK.lock().unwrap();
    let backend = aov_test_backend();
    let descriptor = tests::lit_scene();
    let camera_offset = u32::from_le_bytes(
        descriptor[crate::layout::header::CAMERA_OFFSET * 4
            ..crate::layout::header::CAMERA_OFFSET * 4 + 4]
            .try_into()
            .unwrap(),
    ) as usize
        * 4;
    let mut expected = vec![];
    for pattern in [
        SamplingPattern::Sobol,
        SamplingPattern::ZSobol,
        SamplingPattern::Random,
    ] {
        let settings = RenderSettings {
            sampling_pattern: pattern,
            max_samples: 4,
            aovs: 1,
            aov_samples: 4,
            ..Default::default()
        };
        let raw_settings = settings.l0(settings.sample_cap(4), 0);
        let mut handle = 0;
        let mut error = [0i8; 1024];
        assert_eq!(
            unsafe {
                crate::context::mt_context_create_with_backend(
                    backend as u32,
                    &mut handle,
                    error.as_mut_ptr(),
                    error.len(),
                )
            },
            0
        );
        assert_eq!(
            unsafe {
                crate::context::mt_context_commit_with_settings(
                    handle,
                    descriptor.as_ptr(),
                    descriptor.len(),
                    &raw_settings,
                    error.as_mut_ptr(),
                    error.len(),
                )
            },
            0
        );
        let image = {
            let query = crate::context::aov_query(handle).unwrap();
            let words = query
                .metadata(
                    &descriptor[camera_offset..camera_offset + 128],
                    query.size(),
                )
                .unwrap();
            let layout = crate::aov::Layout {
                size: query.size(),
                display: false,
                compact: false,
            };
            let mut output = crate::aov::Output::new(&query, 1, &words, None, layout).unwrap();
            output.render(&query, 4, 1).unwrap();
            output.read(4).unwrap().data
        };
        expected.push(image);
        assert_eq!(
            unsafe { crate::context::mt_context_destroy(handle, error.as_mut_ptr(), error.len()) },
            0
        );
    }
    assert_ne!(
        expected[0], expected[2],
        "Fixture must distinguish sampling patterns"
    );
    let engine = aov_engine(backend);
    engine.display().set_size(16, 12).unwrap();
    engine.set_scene(&descriptor).unwrap();
    engine.update().unwrap();
    let render = Render::new(
        &engine,
        RenderSettings {
            max_samples: 4,
            aovs: 1,
            aov_samples: 4,
            ..Default::default()
        },
    )
    .unwrap();
    for index in [0, 1, 2, 1, 0] {
        let mut settings = render.settings().unwrap();
        settings.sampling_pattern = [
            SamplingPattern::Sobol,
            SamplingPattern::ZSobol,
            SamplingPattern::Random,
        ][index];
        render.set_settings(settings).unwrap();
        render.converge(ConvergeOptions::new(4)).unwrap();
        let actual = render.read_pixels(PixelKind::Depth).unwrap().data;
        let mismatches = actual
            .iter()
            .zip(&expected[index])
            .filter(|(a, b)| a != b)
            .count();
        assert_eq!(
            mismatches, 0,
            "Target sampling pattern {index} differs from a freshly prepared scene"
        );
    }
}
