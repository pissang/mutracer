use super::*;
use std::time::{Duration, Instant};

#[test]
fn depth_area_matches_viewport_contract_and_rejects_invalid_values() {
    let area = DepthSampleArea {
        x: 0.25,
        y: 0.75,
        size: 0.125,
    };
    assert_eq!(area.pack(2.).unwrap(), [0.25, 0.25, 0.0625, 0.125]);
    assert_eq!(
        DepthSampleArea {
            x: 1.,
            y: 0.,
            size: 0.
        }
        .pack(0.5)
        .unwrap(),
        [1., 1., 0., 0.]
    );
    for bad in [
        DepthSampleArea {
            x: f32::NAN,
            ..area
        },
        DepthSampleArea { x: -0.1, ..area },
        DepthSampleArea { y: 1.1, ..area },
        DepthSampleArea { size: -1., ..area },
        DepthSampleArea {
            size: f32::INFINITY,
            ..area
        },
    ] {
        assert_eq!(bad.pack(1.).unwrap_err().status, Status::InvalidArgument);
    }
    assert!(area.pack(0.).is_err());
}
fn set(scene: &mut [u8], word: usize, value: u32) {
    scene[word * 4..word * 4 + 4].copy_from_slice(&value.to_le_bytes());
}
fn query(engine: &Engine, area: DepthSampleArea) -> [f32; DEPTH_SAMPLE_COUNT] {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        if let Some(depths) = engine.read_depth_samples(area).unwrap() {
            return depths;
        }
        assert!(Instant::now() < deadline, "query never became ready");
        std::thread::sleep(Duration::from_millis(1));
    }
}
#[track_caller]
fn near(values: &[f32], expected: f32) {
    for value in values {
        assert!((value - expected).abs() < 0.0001, "{value} vs {expected}");
    }
}
#[test]
#[ignore = "requires a real GPU; run npm run native:ci:gpu"]
fn depth_samples_follow_committed_scene_camera_and_leave_render_outputs_unchanged() {
    let _lock = crate::ABI_TEST_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    for backend in [Backend::Software, Backend::Hardware] {
        let engine = Engine::new(EngineOptions { backend }).unwrap();
        let center = DepthSampleArea {
            x: 0.5,
            y: 0.5,
            size: 0.,
        };
        assert!(engine.read_depth_samples(center).unwrap().is_none());
        engine.display().set_size(64, 32).unwrap();
        let mut scene = super::tests::lit_scene();
        for axis in [0, 5, 10] {
            set(&mut scene, 48 + axis, 10f32.to_bits());
        }
        // Foreground is x=.2.. .8, y=.1.. .7 at z=1; background is z=0.
        set(&mut scene, 82, 1f32.to_bits());
        set(&mut scene, 118, 0f32.to_bits());
        set(&mut scene, 188, 0.5f32.to_bits());
        set(&mut scene, 189, 0.4f32.to_bits());
        engine.set_scene(&scene).unwrap();
        let mut camera = Camera::default();
        camera.world_matrix[14] = 4.;
        camera.f_stop = 0.5; // Query must ignore the nonzero aperture.
        engine.set_camera(Some(camera)).unwrap();
        // Pending inputs are never implicitly committed.
        assert!(engine.read_depth_samples(center).unwrap().is_none());
        let (resume, resumed) = std::sync::mpsc::sync_channel(1);
        *crate::context::PREPARATION_GATE.lock().unwrap() = Some(resumed);
        engine.update().unwrap();
        assert!(engine.read_depth_samples(center).unwrap().is_none());
        assert!(engine.read_depth_samples(center).unwrap().is_none());
        drop(resume);
        // No Render exists and no beauty samples have been traced.
        near(&query(&engine, center), 4.);
        if backend == Backend::Hardware {
            assert!(engine.info().hardware_ray_query);
        }
        let tan = (22.5f32).to_radians().tan();
        let foreground = DepthSampleArea {
            x: (0.5 / (3. * tan * 2.) + 1.) / 2.,
            y: (1. - 0.4 / (3. * tan)) / 2.,
            size: 0.,
        };
        near(&query(&engine, foreground), 3.);
        near(
            &query(
                &engine,
                DepthSampleArea {
                    y: 1. - foreground.y,
                    ..foreground
                },
            ),
            4.,
        );
        let grid = DepthSampleArea {
            size: 0.3,
            ..foreground
        };
        let depths = query(&engine, grid);
        for row in 0..7 {
            for col in 0..7 {
                let u = grid.x + grid.size / 2. * (col as f32 / 3. - 1.);
                let v = grid.y + grid.size * (row as f32 / 3. - 1.);
                let x = (u * 2. - 1.) * 3. * tan * 2.;
                let y = (1. - v * 2.) * 3. * tan;
                let expected = if !(0. ..=1.).contains(&u) || !(0. ..=1.).contains(&v) {
                    0.
                } else if (0.2..=0.8).contains(&x) && (0.1..=0.7).contains(&y) {
                    3.
                } else {
                    4.
                };
                near(&depths[row * 7 + col..row * 7 + col + 1], expected);
            }
        }
        assert_eq!(
            query(
                &engine,
                DepthSampleArea {
                    x: 0.,
                    y: 0.,
                    size: 0.1
                }
            )[0],
            0.
        );

        let render = Render::new(
            &engine,
            RenderSettings {
                size: RenderSize::Fixed {
                    width: 8,
                    height: 12,
                },
                ..Default::default()
            },
        )
        .unwrap();
        let mut override_camera = camera;
        override_camera.world_matrix[14] = 6.;
        let mut options = ConvergeOptions::new(2);
        options.camera = Some(override_camera);
        render.converge(options).unwrap();
        let before = [PixelKind::Hdr, PixelKind::Normal, PixelKind::Albedo]
            .map(|kind| render.read_pixels(kind).unwrap());
        let sdr = engine.display().read_rgba8(&render).unwrap();
        near(&query(&engine, foreground), 3.); // Not the render's camera/aspect.
        assert_eq!(render.samples(), 2);
        for (kind, image) in [PixelKind::Hdr, PixelKind::Normal, PixelKind::Albedo]
            .into_iter()
            .zip(before)
        {
            assert_eq!(render.read_pixels(kind).unwrap(), image);
        }
        assert_eq!(engine.display().read_rgba8(&render).unwrap(), sdr);
        engine.display().set_size(32, 32).unwrap();
        let square = DepthSampleArea {
            x: (0.5 / (3. * tan) + 1.) / 2.,
            ..foreground
        };
        near(&query(&engine, square), 3.);
        camera.world_matrix[14] = 5.;
        engine.set_camera(Some(camera)).unwrap();
        near(&query(&engine, center), 4.); // Still the committed camera.
        engine.update().unwrap();
        near(&query(&engine, center), 5.);
        camera.projection = 1;
        camera.world_matrix[12] = 0.5;
        camera.world_matrix[13] = 0.4;
        engine.set_camera(Some(camera)).unwrap();
        engine.update().unwrap();
        near(&query(&engine, center), 4.);

        // Transform edit is committed without requiring a beauty sample.
        set(&mut scene, 82, 2f32.to_bits());
        engine.set_scene(&scene).unwrap();
        engine.update().unwrap();
        near(&query(&engine, center), 3.);
        // A 1x1 alpha-zero map must not steal focus from the background.
        let mut cutout = scene.clone();
        cutout.extend(
            [
                1u32,
                1,
                0,
                222,
                0,
                0,
                1f32.to_bits(),
                1f32.to_bits(),
                0,
                0,
                0,
                0,
                0x00ffffff,
            ]
            .into_iter()
            .flat_map(u32::to_le_bytes),
        );
        cutout.extend(
            [54u32, 1, 0, 0, 41, 2, 0, 0, 42, 0.5f32.to_bits(), 0, 0]
                .into_iter()
                .flat_map(u32::to_le_bytes),
        );
        cutout.extend(
            [0f32, 0., 1., 0., 1., 1., 0., 1.]
                .into_iter()
                .flat_map(f32::to_le_bytes),
        );
        set(&mut cutout, 1, 243);
        set(&mut cutout, 37, 235);
        set(&mut cutout, 127, 3);
        set(&mut cutout, 128, 223);
        set(&mut cutout, 8, 1);
        set(&mut cutout, 13, 210);
        set(&mut cutout, 123, 0);
        engine.set_scene(&cutout).unwrap();
        engine.update().unwrap();
        near(&query(&engine, center), 5.);
        let mut catcher = scene.clone();
        catcher.extend([51u32, 1, 0, 0].into_iter().flat_map(u32::to_le_bytes));
        set(&mut catcher, 1, 214);
        set(&mut catcher, 127, 1);
        set(&mut catcher, 128, 210);
        engine.set_scene(&catcher).unwrap();
        engine.update().unwrap();
        near(&query(&engine, center), 5.);
        // Clearing the explicit engine camera restores the descriptor camera.
        engine.set_scene(&scene).unwrap();
        engine.set_camera(None).unwrap();
        engine.update().unwrap();
        near(&query(&engine, center), 2.); // descriptor eye (.5,.4,4), foreground z=2.
        let mut offscreen = scene.clone();
        set(&mut offscreen, 60, 100f32.to_bits());
        set(&mut offscreen, 80, 100f32.to_bits());
        engine.set_scene(&offscreen).unwrap();
        engine.update().unwrap();
        near(&query(&engine, center), 0.); // Ready geometry with 49 misses is not None.
        // AOT packing must leave the process registry available, and device
        // loss must interrupt the wait instead of waiting for unrelated AOT.
        let handle = engine.lock().shared.context().unwrap();
        let (entered, entry) = std::sync::mpsc::sync_channel(1);
        let (resume, resumed) = std::sync::mpsc::channel();
        *crate::runtime::CALL_GATE.lock().unwrap() = Some((entered, resumed));
        let reader = engine.clone();
        let (finished, result) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            finished.send(reader.read_depth_samples(center)).unwrap();
        });
        entry.recv_timeout(Duration::from_secs(5)).unwrap();
        let mut active = 99;
        let mut reason = [0i8; 256];
        let mut message = [0i8; 1024];
        assert_eq!(
            unsafe {
                crate::context::mt_context_backend(
                    handle,
                    &mut active,
                    reason.as_mut_ptr(),
                    reason.len(),
                    message.as_mut_ptr(),
                    message.len(),
                )
            },
            0
        );
        assert_eq!(
            active,
            backend.code(),
            "query must use the requested backend"
        );
        engine.device_loss_notifier().notify("depth terminal loss");
        let failure = result
            .recv_timeout(Duration::from_secs(2))
            .unwrap()
            .unwrap_err();
        assert_eq!(failure.status, Status::Unavailable);
        resume.send(()).unwrap();
        worker.join().unwrap();
        engine.dispose();
        assert_eq!(
            engine.read_depth_samples(center).unwrap_err().status,
            Status::InvalidHandle
        );
    }
}

#[test]
#[ignore = "requires a real GPU; run npm run native:ci:gpu"]
fn surface_picking_uses_source_ids_alpha_and_discards_stale_camera_queries() {
    let _lock = crate::ABI_TEST_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    for backend in [Backend::Software, Backend::Hardware] {
        let engine = Engine::new(EngineOptions { backend }).unwrap();
        assert_eq!(
            engine.pick_surface(0.5, 0.5).unwrap(),
            SurfacePick::Unavailable
        );
        assert_eq!(
            engine.pick_surface(-0.1, 0.5).unwrap_err().status,
            Status::InvalidArgument
        );
        engine.display().set_size(64, 32).unwrap();
        let mut scene = super::tests::lit_scene();
        use crate::layout::header as h;
        let count = scene.len() / 4;
        scene.extend(
            [101u32, 202, 303, 404]
                .into_iter()
                .flat_map(u32::to_le_bytes),
        );
        set(&mut scene, h::LENGTH, (count + 4) as u32);
        set(&mut scene, h::MESH_AOV_IDS, count as u32);
        set(&mut scene, h::MATERIAL_AOV_IDS, (count + 2) as u32);
        let mut camera = Camera::default();
        camera.world_matrix[12] = 0.5;
        camera.world_matrix[13] = 0.4;
        camera.world_matrix[14] = 4.;
        engine.set_scene(&scene).unwrap();
        engine.set_camera(Some(camera)).unwrap();
        engine.update().unwrap();
        let pick = |x, y| {
            let deadline = Instant::now() + Duration::from_secs(20);
            loop {
                let result = engine.pick_surface(x, y).unwrap();
                if result != SurfacePick::Unavailable {
                    return result;
                }
                assert!(Instant::now() < deadline);
                std::thread::sleep(Duration::from_millis(1));
            }
        };
        assert_eq!(
            pick(0.5, 0.5),
            SurfacePick::Hit(SurfaceHit {
                object: 202,
                material: 404,
                instance: 0
            })
        );
        assert_eq!(pick(0., 0.), SurfacePick::Background);
        let mut transparent = scene.clone();
        set(&mut transparent, 108 + 13, 0f32.to_bits());
        engine.set_scene(&transparent).unwrap();
        engine.update().unwrap();
        assert_eq!(
            pick(0.5, 0.5),
            SurfacePick::Hit(SurfaceHit {
                object: 101,
                material: 303,
                instance: 0
            })
        );
        // The camera and scene are not locked while AOT/GPU work waits.
        let (entered, entry) = std::sync::mpsc::sync_channel(1);
        let (resume, resumed) = std::sync::mpsc::channel();
        *crate::runtime::CALL_GATE.lock().unwrap() = Some((entered, resumed));
        let reader = engine.clone();
        let worker = std::thread::spawn(move || reader.pick_surface(0.5, 0.5));
        entry.recv_timeout(Duration::from_secs(5)).unwrap();
        camera.world_matrix[12] = 100.;
        engine.set_camera(Some(camera)).unwrap();
        engine.update().unwrap();
        resume.send(()).unwrap();
        assert_eq!(worker.join().unwrap().unwrap(), SurfacePick::Unavailable);
        assert_eq!(pick(0.5, 0.5), SurfacePick::Background);
    }
}
