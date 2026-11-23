use super::producer_tests::*;
use super::*;
use crate::*;

fn set_camera_pose(input: &mut [u8], translation: [f32; 2], yaw: f32) {
    let camera_offset = layout::header::CAMERA_OFFSET * 4;
    let camera_transform = u32::from_le_bytes(input[camera_offset..][..4].try_into().unwrap())
        as usize
        + layout::camera::TRANSFORM;
    let transform =
        glam::Mat4::from_translation(glam::Vec3::new(translation[0], translation[1], 0.))
            * glam::Mat4::from_rotation_y(yaw);
    for (i, value) in transform.to_cols_array().into_iter().enumerate() {
        set(input, camera_transform + i, value.to_bits());
    }
}

fn point_on_plane(inverse: glam::DMat4, pixel: glam::DVec2) -> glam::DVec3 {
    let ndc = glam::DVec2::new(pixel.x / 4. - 1., 1. - pixel.y / 4.);
    let a = inverse * glam::DVec4::new(ndc.x, ndc.y, -1., 1.);
    let b = inverse * glam::DVec4::new(ndc.x, ndc.y, 1., 1.);
    let origin = a.truncate() / a.w;
    let direction = b.truncate() / b.w - origin;
    origin + direction * ((-3. - origin.z) / direction.z)
}

#[test]
#[ignore = "requires real Vulkan and DX12 GPUs; run npm run native:ci:gpu"]
fn camera_motion_uses_accepted_unjittered_frames_and_checks_previous_coverage() {
    let _lock = crate::abi_test_lock();
    for backend in [wgpu::Backends::VULKAN, wgpu::Backends::DX12] {
        let Some(gpu) = test_gpu(backend) else {
            continue;
        };
        for ortho in [false, true] {
            for (translation, previous_yaw, yaw) in [
                ([0., 0.], 0., 0.),
                ([0.21, -0.16], 0., 0.),
                ([0.07, -0.05], 0., 0.12),
                ([0.07, -0.05], 0.52, 0.49),
            ] {
                let mut input = plane(false, ortho, false);
                set_camera_pose(&mut input, [0., 0.], previous_yaw);
                let (description, assets) =
                    scene::prepare_frame_inputs(&input, &settings::RenderSettings::default())
                        .unwrap();
                let source = String::from_utf8(
                    assets[&AssetId::Packet(layout::resource::SOFTWARE_FRAME_SHADER)].clone(),
                )
                .unwrap();
                let camera = &assets[&AssetId::Packet(layout::resource::CAMERA)];
                let trace = &assets[&AssetId::Packet(layout::resource::TRACE_UNIFORM)];
                let (scene, _) =
                    GpuScene::new(description, &RenderOptions::default(), &assets, gpu.clone())
                        .unwrap();
                let producer = FrameProducer::new(&scene, source).unwrap();
                let publication = Arc::new(());
                let geometry = || GeometrySnapshot {
                    publication: publication.clone(),
                    ..Default::default()
                };
                let mut history = GpuFrameHistory::new(gpu.frame_device, [8, 8]);
                let mut metadata = super::tests::metadata();
                metadata.camera = camera_metadata(camera, ortho);
                let previous_matrix =
                    glam::DMat4::from_cols_array(&metadata.camera.projection.map(f64::from))
                        * glam::DMat4::from_cols_array(&metadata.camera.view.map(f64::from));
                let previous_camera =
                    glam::DMat4::from_cols_array(&metadata.camera.view_inverse.map(f64::from));
                let previous_forward = -previous_camera.z_axis.truncate().normalize();
                let previous_eye = previous_camera.w_axis.truncate();
                let packed = values(camera);
                let previous_inverse =
                    glam::DMat4::from_cols_array(&std::array::from_fn(|i| packed[i] as f64));
                let old_jitter = metadata.jitter_pixels;
                let (first, dependency) = producer
                    .produce(
                        &scene,
                        &mut history,
                        metadata.clone(),
                        geometry(),
                        camera,
                        trace,
                    )
                    .unwrap();
                history
                    .evaluate_and_submit(&gpu, dependency, |_| {
                        Ok(EvaluatedCommands {
                            native: vec![],
                            consumer: vec![],
                        })
                    })
                    .unwrap();
                let previous_validity = read_texture(
                    &gpu,
                    &first
                        .current
                        .resources
                        .guide(Guide::Validity)
                        .unwrap()
                        .texture,
                );
                let mut moved = input.clone();
                set_camera_pose(&mut moved, translation, yaw);
                let (_, moved_assets) =
                    scene::prepare_frame_inputs(&moved, &settings::RenderSettings::default())
                        .unwrap();
                let moved_camera = &moved_assets[&AssetId::Packet(layout::resource::CAMERA)];
                metadata.camera = camera_metadata(moved_camera, ortho);
                metadata.jitter_pixels = [-0.31, 0.28];
                metadata.sample_index += 1;
                let (frame, _) = producer
                    .produce(
                        &scene,
                        &mut history,
                        metadata.clone(),
                        geometry(),
                        moved_camera,
                        trace,
                    )
                    .unwrap();
                assert_eq!(frame.previous_frame_id(), Some(first.key().frame));
                assert!(frame.reset_reasons.is_empty());
                let motion = values(&read_texture(
                    &gpu,
                    &frame
                        .current
                        .resources
                        .guide(Guide::Motion)
                        .unwrap()
                        .texture,
                ));
                let validity = read_texture(
                    &gpu,
                    &frame
                        .current
                        .resources
                        .guide(Guide::Validity)
                        .unwrap()
                        .texture,
                );
                // FP64 ray/plane intersection and previous-camera projection.
                // Translation also has an independent closed-form constant MV.
                let projection = metadata.camera.projection;
                let denominator = if ortho { 1. } else { 3. };
                let translation_motion = [
                    translation[0] as f64 * projection[0] as f64 * 4. / denominator,
                    -translation[1] as f64 * projection[5] as f64 * 4. / denominator,
                ];
                let packed = values(moved_camera);
                let inverse =
                    glam::DMat4::from_cols_array(&std::array::from_fn(|i| packed[i] as f64));
                let mut valid_count = 0;
                let mut legacy_depth_rejections = 0;
                let mut error = 0f64;
                for index in 0..64 {
                    let flags =
                        u32::from_le_bytes(validity[index * 4..index * 4 + 4].try_into().unwrap());
                    let current = glam::DVec2::new(
                        index as f64 % 8. + 0.5 + metadata.jitter_pixels[0] as f64,
                        (index / 8) as f64 + 0.5 + metadata.jitter_pixels[1] as f64,
                    );
                    let point = point_on_plane(inverse, current);
                    let clip = previous_matrix * point.extend(1.);
                    let previous =
                        glam::DVec2::new(clip.x / clip.w * 4. + 4., 4. - clip.y / clip.w * 4.);
                    let expected = (previous - current).to_array();
                    if yaw == 0. {
                        for channel in 0..2 {
                            assert!((expected[channel] - translation_motion[channel]).abs() < 1e-5);
                        }
                    }
                    let lookup = [
                        previous.x - old_jitter[0] as f64,
                        previous.y - old_jitter[1] as f64,
                    ];
                    let inside = lookup.iter().all(|v| *v >= 0. && *v < 8.);
                    let previous_hit = if inside {
                        let previous = lookup[0].floor() as usize + lookup[1].floor() as usize * 8;
                        u32::from_le_bytes(
                            previous_validity[previous * 4..previous * 4 + 4]
                                .try_into()
                                .unwrap(),
                        ) & validity::PRIMARY_HIT
                            != 0
                    } else {
                        false
                    };
                    let should_match = flags & validity::PRIMARY_HIT != 0 && previous_hit;
                    assert_eq!(
                        flags & validity::MOTION != 0,
                        should_match,
                        "motion coverage at {index}"
                    );
                    if should_match {
                        valid_count += 1;
                        let previous_ray_pixel = glam::DVec2::new(
                            lookup[0].floor() + 0.5 + f64::from(old_jitter[0]),
                            lookup[1].floor() + 0.5 + f64::from(old_jitter[1]),
                        );
                        let sampled = point_on_plane(previous_inverse, previous_ray_pixel);
                        let depth = (point - previous_eye).dot(previous_forward);
                        let sample_depth = (sampled - previous_eye).dot(previous_forward);
                        if (depth - sample_depth).abs() > (depth.abs() * 1e-3).max(1e-4) {
                            legacy_depth_rejections += 1;
                        }
                        for channel in 0..2 {
                            error = error.max(
                                (motion[index * 2 + channel] as f64 - expected[channel]).abs(),
                            );
                        }
                    } else {
                        assert_eq!(&motion[index * 2..index * 2 + 2], &[0., 0.]);
                    }
                }
                assert!(valid_count > 16);
                if previous_yaw != 0. {
                    assert!(legacy_depth_rejections * 2 > valid_count);
                }
                assert!(error < 1e-4, "camera motion error {error} pixels");
                history.reject(frame.key()).unwrap();
                let (foreign, _) = producer
                    .produce(
                        &scene,
                        &mut history,
                        metadata.clone(),
                        GeometrySnapshot::default(),
                        moved_camera,
                        trace,
                    )
                    .unwrap();
                let flags = read_texture(
                    &gpu,
                    &foreign
                        .current
                        .resources
                        .guide(Guide::Validity)
                        .unwrap()
                        .texture,
                );
                assert!(
                    flags
                        .chunks_exact(4)
                        .all(|b| u32::from_le_bytes(b.try_into().unwrap()) & validity::MOTION == 0)
                );
                println!(
                    "camera motion {:?}, ortho={ortho}, translation={translation:?}, yaw {previous_yaw}->{yaw}: {valid_count} matches, {legacy_depth_rejections} rejected by the old depth test, max error {error} pixels",
                    gpu.info.backend
                );
                if let Ok(root) = std::env::var("MUTRACER_FRAME_EVIDENCE") {
                    let directory = Path::new(&root).join(format!(
                        "motion-{:?}-ortho{ortho}-x{}-yaw{yaw}",
                        gpu.info.backend, translation[0]
                    ));
                    fs::create_dir_all(&directory).unwrap();
                    fs::write(
                        directory.join("motion.rg32f"),
                        motion
                            .iter()
                            .flat_map(|v| v.to_le_bytes())
                            .collect::<Vec<_>>(),
                    )
                    .unwrap();
                    fs::write(directory.join("validity.u32"), &validity).unwrap();
                    fs::write(directory.join("parameters.json"), serde_json::to_vec_pretty(&json!({"adapter":format!("{:?}",gpu.info),"translation":translation,"previousYaw":previous_yaw,"yaw":yaw,"orthographic":ortho,"currentJitter":metadata.jitter_pixels,"previousJitter":old_jitter,"validCount":valid_count,"legacyDepthRejections":legacy_depth_rejections,"maximumErrorPixels":error,"foreignPublicationRejected":true})).unwrap()).unwrap();
                }
            }
        }
    }
}
