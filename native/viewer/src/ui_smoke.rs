//! Render the real egui panels offscreen, using the same shared-device texture
//! path as the app. This remains usable on a locked desktop and in GPU CI.
use crate::*;
use eframe::egui_wgpu;

fn frame(
    viewer: &mut Viewer,
    ctx: &egui::Context,
    gpu: &egui_wgpu::RenderState,
    size: [u32; 2],
    events: Vec<egui::Event>,
) -> Result<wgpu::Texture> {
    if let Some(gate) = &viewer.submission_gate {
        gate.resume();
    }
    let mut output = ctx.run_ui(
        egui::RawInput {
            screen_rect: Some(egui::Rect::from_min_size(
                egui::Pos2::ZERO,
                egui::vec2(size[0] as f32, size[1] as f32),
            )),
            events,
            ..Default::default()
        },
        |ui| {
            viewer.receive_model(ctx);
            viewer.panels(ui);
            viewer.tick(ctx).unwrap();
        },
    );
    let jobs = ctx.tessellate(output.shapes, output.pixels_per_point);
    let screen = egui_wgpu::ScreenDescriptor {
        size_in_pixels: size,
        pixels_per_point: output.pixels_per_point,
    };
    let texture = gpu.device.create_texture(&wgpu::TextureDescriptor {
        label: Some("Viewer UI evidence"),
        size: wgpu::Extent3d {
            width: size[0],
            height: size[1],
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba8Unorm,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });
    let view = texture.create_view(&Default::default());
    let mut encoder = gpu.device.create_command_encoder(&Default::default());
    let mut renderer = gpu.renderer.write();
    for (id, delta) in &output.textures_delta.set {
        for part in delta {
            renderer.update_texture(&gpu.device, &gpu.queue, *id, part);
        }
    }
    let mut commands =
        renderer.update_buffers(&gpu.device, &gpu.queue, &mut encoder, &jobs, &screen);
    {
        let pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("Viewer panels"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &view,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                    store: wgpu::StoreOp::Store,
                },
            })],
            ..Default::default()
        });
        renderer.render(&mut pass.forget_lifetime(), &jobs, &screen);
    }
    commands.push(encoder.finish());
    gpu.queue.submit(commands);
    for id in &output.textures_delta.free {
        renderer.free_texture(id);
    }
    output.textures_delta.clear();
    Ok(texture)
}
fn save(gpu: &egui_wgpu::RenderState, texture: &wgpu::Texture, path: &Path) -> Result<()> {
    let [w, h] = [texture.width(), texture.height()];
    let stride = (w * 4).div_ceil(256) * 256;
    let buffer = gpu.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("UI readback"),
        size: stride as u64 * h as u64,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let mut encoder = gpu.device.create_command_encoder(&Default::default());
    encoder.copy_texture_to_buffer(
        texture.as_image_copy(),
        wgpu::TexelCopyBufferInfo {
            buffer: &buffer,
            layout: wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(stride),
                rows_per_image: None,
            },
        },
        wgpu::Extent3d {
            width: w,
            height: h,
            depth_or_array_layers: 1,
        },
    );
    gpu.queue.submit([encoder.finish()]);
    let (tx, rx) = std::sync::mpsc::channel();
    buffer.map_async(wgpu::MapMode::Read, .., move |r| {
        let _ = tx.send(r);
    });
    gpu.device.poll(wgpu::PollType::wait_indefinitely())?;
    rx.recv_timeout(Duration::from_secs(30))??;
    let bytes = buffer.get_mapped_range(..)?;
    let pixels = bytes
        .chunks_exact(stride as usize)
        .flat_map(|row| row[..w as usize * 4].iter().copied())
        .collect();
    image::RgbaImage::from_raw(w, h, pixels)
        .unwrap()
        .save(path)?;
    Ok(())
}
fn settle(
    viewer: &mut Viewer,
    ctx: &egui::Context,
    gpu: &egui_wgpu::RenderState,
) -> Result<wgpu::Texture> {
    let started = std::time::Instant::now();
    frame(viewer, ctx, gpu, [1200, 800], vec![])?;
    while !viewer.settled()
        || viewer.environment.name == "Procedural sky" && viewer.environment.image.is_none()
    {
        ensure!(
            started.elapsed() < Duration::from_secs(90),
            "UI failed to settle: {}",
            viewer.error
        );
        frame(viewer, ctx, gpu, [1200, 800], vec![])?;
        std::thread::sleep(Duration::from_millis(2));
    }
    ensure!(viewer.error.is_empty(), "{}", viewer.error);
    frame(viewer, ctx, gpu, [1200, 800], vec![])
}
#[test]
#[ignore = "requires a real GPU; writes offscreen viewer screenshots"]
fn viewer_panels_examples_and_debug_use_the_shared_gpu_image() -> Result<()> {
    let out = PathBuf::from(
        std::env::var_os("MUTRACER_VIEWER_UI_EVIDENCE").expect("External UI evidence directory"),
    );
    std::fs::create_dir_all(&out)?;
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
    let adapter = pollster::block_on(instance.request_adapter(&Default::default()))?;
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
        required_limits: adapter.limits(),
        required_features: adapter.features()
            & (wgpu::Features::EXPERIMENTAL_RAY_QUERY
                | wgpu::Features::TIMESTAMP_QUERY
                | wgpu::Features::SHADER_F16
                | wgpu::Features::SUBGROUP),
        experimental_features: unsafe { wgpu::ExperimentalFeatures::enabled() },
        ..Default::default()
    }))?;
    let gpu = egui_wgpu::RenderState {
        available_adapters: vec![adapter.clone()],
        adapter,
        instance,
        target_format: wgpu::TextureFormat::Rgba8Unorm,
        renderer: Arc::new(egui::mutex::RwLock::new(egui_wgpu::Renderer::new(
            &device,
            wgpu::TextureFormat::Rgba8Unorm,
            Default::default(),
        ))),
        device,
        queue,
        surface_config: egui_wgpu::SurfaceConfig::HIGH_THROUGHPUT,
    };
    let ctx = egui::Context::default();
    crate::theme::install(&ctx);
    ctx.style_mut_of(egui::Theme::Dark, |style| style.animation_time = 0.);
    let mut viewer = Viewer::new_on_device(&default_model(), Some(gpu.clone()))?;
    viewer.resolution.scale = None;
    viewer.size = [240, 160];
    viewer.settings.max_samples = 4;
    viewer.denoise = false;
    viewer.debug_open = false;
    let image = settle(&mut viewer, &ctx, &gpu)?;
    save(&gpu, &image, &out.join("default.png"))?;
    viewer.tab = 5;
    viewer.inspector_open = true;
    // Allow thumbnail responses to arrive while using the same panel code.
    for _ in 0..60 {
        frame(&mut viewer, &ctx, &gpu, [1200, 800], vec![])?;
        std::thread::sleep(Duration::from_millis(15));
    }
    let image = frame(&mut viewer, &ctx, &gpu, [1200, 800], vec![])?;
    save(&gpu, &image, &out.join("models.png"))?;
    viewer.examples.research = true;
    for _ in 0..60 {
        frame(&mut viewer, &ctx, &gpu, [1200, 800], vec![])?;
        std::thread::sleep(Duration::from_millis(15));
    }
    let image = frame(&mut viewer, &ctx, &gpu, [1200, 800], vec![])?;
    save(&gpu, &image, &out.join("research.png"))?;
    let camera = viewer.camera.eye();
    let click = |pos| {
        vec![
            egui::Event::PointerMoved(pos),
            egui::Event::PointerButton {
                pos,
                button: egui::PointerButton::Primary,
                pressed: true,
                modifiers: Default::default(),
            },
            egui::Event::PointerButton {
                pos,
                button: egui::PointerButton::Primary,
                pressed: false,
                modifiers: Default::default(),
            },
        ]
    };
    let header_rect = |ctx: &egui::Context| {
        ctx.data(|data| {
            data.get_temp::<egui::Rect>(egui::Id::new("debug-header-rect"))
                .unwrap()
        })
    };
    // The collapsed performance graph and expanded chevron both toggle the card
    // without selecting or orbiting the scene beneath it.
    frame(
        &mut viewer,
        &ctx,
        &gpu,
        [1200, 800],
        click(header_rect(&ctx).right_center() - egui::vec2(35., 0.)),
    )?;
    assert!(viewer.debug_open);
    let image = frame(&mut viewer, &ctx, &gpu, [1200, 800], vec![])?;
    save(&gpu, &image, &out.join("debug-expanded.png"))?;
    frame(
        &mut viewer,
        &ctx,
        &gpu,
        [1200, 800],
        click(header_rect(&ctx).right_center() - egui::vec2(9., 0.)),
    )?;
    assert!(!viewer.debug_open);
    let image = frame(&mut viewer, &ctx, &gpu, [1200, 800], vec![])?;
    save(&gpu, &image, &out.join("debug-collapsed.png"))?;
    assert_eq!(
        viewer.camera.eye(),
        camera,
        "Debug header orbited the viewport"
    );
    assert!(
        viewer.selected_mesh.is_none(),
        "Debug header selected the underlying model"
    );
    let examples_pos = ctx
        .data(|data| {
            data.get_temp::<egui::Rect>(egui::Id::new("examples-button-rect"))
                .unwrap()
        })
        .center();
    // Collapse and reopen Examples through its real toolbar control.
    frame(&mut viewer, &ctx, &gpu, [1200, 800], click(examples_pos))?;
    assert!(!viewer.inspector_open);
    frame(&mut viewer, &ctx, &gpu, [1200, 800], click(examples_pos))?;
    assert!(viewer.inspector_open && viewer.tab == 5);
    assert!(viewer.examples.research);
    assert_eq!(
        viewer.camera.eye(),
        camera,
        "Examples controls orbited the viewport"
    );
    let image = frame(&mut viewer, &ctx, &gpu, [800, 600], vec![])?;
    save(&gpu, &image, &out.join("examples-tab-narrow.png"))?;
    frame(&mut viewer, &ctx, &gpu, [1200, 800], vec![])?;
    let expand = ctx
        .data(|data| {
            data.get_temp::<egui::Rect>(egui::Id::new(("scene-expand", 1usize)))
                .unwrap()
        })
        .center();
    frame(&mut viewer, &ctx, &gpu, [1200, 800], click(expand))?;
    frame(&mut viewer, &ctx, &gpu, [1200, 800], vec![])?;
    let material = ctx
        .data(|data| {
            data.get_temp::<egui::Rect>(egui::Id::new(("scene-material", 1usize, 0usize)))
                .unwrap()
        })
        .center();
    frame(&mut viewer, &ctx, &gpu, [1200, 800], click(material))?;
    assert_eq!(viewer.selected_mesh, Some(0));
    assert_eq!(viewer.selected, 0);
    assert_eq!(viewer.tab, 1);
    assert_eq!(
        viewer.camera.eye(),
        camera,
        "Tree controls orbited the scene"
    );
    let image = frame(&mut viewer, &ctx, &gpu, [1200, 800], vec![])?;
    save(&gpu, &image, &out.join("scene-material.png"))?;
    let frame_button = ctx
        .data(|data| {
            data.get_temp::<egui::Rect>(egui::Id::new("frame-selection-rect"))
                .unwrap()
        })
        .center();
    let (min, max) = viewer.model.mesh_bounds(0);
    frame(&mut viewer, &ctx, &gpu, [1200, 800], click(frame_button))?;
    assert_eq!(viewer.camera.target, (min + max) * 0.5);
    assert_eq!(viewer.camera_index, None);
    assert_eq!(viewer.selected_mesh, Some(0));
    // The four keyboard shortcuts and rail labels follow the browser order.
    for (key, tab, name) in [
        (egui::Key::Num1, 2, "lighting"),
        (egui::Key::Num2, 1, "material"),
        (egui::Key::Num3, 4, "camera"),
        (egui::Key::Num4, 0, "render"),
    ] {
        frame(
            &mut viewer,
            &ctx,
            &gpu,
            [1200, 800],
            vec![egui::Event::Key {
                key,
                physical_key: None,
                pressed: true,
                repeat: false,
                modifiers: Default::default(),
            }],
        )?;
        assert_eq!(viewer.tab, tab);
        assert!(viewer.inspector_open);
        let image = frame(
            &mut viewer,
            &ctx,
            &gpu,
            [1200, 800],
            vec![egui::Event::Key {
                key,
                physical_key: None,
                pressed: false,
                repeat: false,
                modifiers: Default::default(),
            }],
        )?;
        save(&gpu, &image, &out.join(format!("inspector-{name}.png")))?;
    }
    viewer.tab = 0;
    viewer.debug_open = true;
    viewer.display_settings.output = 5;
    let image = settle(&mut viewer, &ctx, &gpu)?;
    save(&gpu, &image, &out.join("debug-depth.png"))?;
    let beauty = viewer.final_render().samples();
    assert_eq!(beauty, 4);
    assert_eq!(viewer.samples, 16);
    assert!(viewer.can_export());
    let before = viewer.camera.eye();
    // A coalesced gesture beginning inside the debug card must not orbit.
    let start = egui::pos2(280., 90.);
    let end = egui::pos2(340., 95.);
    let button = |pressed| egui::Event::PointerButton {
        pos: if pressed { start } else { end },
        button: egui::PointerButton::Primary,
        pressed,
        modifiers: Default::default(),
    };
    frame(
        &mut viewer,
        &ctx,
        &gpu,
        [1200, 800],
        vec![
            egui::Event::PointerMoved(start),
            button(true),
            egui::Event::PointerMoved(end),
            button(false),
        ],
    )?;
    assert_eq!(
        viewer.camera.eye(),
        before,
        "Debug controls orbited the viewport"
    );
    viewer.load_preset("research-cornell-box", &ctx);
    while viewer.loading.is_some() {
        frame(&mut viewer, &ctx, &gpu, [1200, 800], vec![])?;
        std::thread::sleep(Duration::from_millis(5));
    }
    let image = settle(&mut viewer, &ctx, &gpu)?;
    save(&gpu, &image, &out.join("cornell-depth.png"))?;
    assert_eq!(
        viewer.examples.current.as_deref(),
        Some("research-cornell-box")
    );
    assert_eq!(viewer.camera_index, Some(0));
    assert!(viewer.environment.model_lighting);
    viewer.display_settings.output = 0;
    viewer.tab = 4;
    let image = settle(&mut viewer, &ctx, &gpu)?;
    save(&gpu, &image, &out.join("cornell-camera.png"))?;
    // Imported cameras, DOF and the settings drawer used to force the dock
    // outside small viewports. Exercise real panel geometry, including the menu.
    let saved_name = viewer.model.1.cameras[0].name.clone();
    viewer.model.1.cameras[0].name = "An authored camera with a deliberately long name".into();
    let saved_f_stop = viewer.camera.f_stop;
    let saved_denoise = viewer.denoise;
    viewer.camera.f_stop = 2.8;
    viewer.running = false;
    for (size, drawer) in [
        ([800, 560], false),
        ([960, 600], false),
        ([1200, 800], false),
        ([1600, 900], false),
        ([800, 560], true),
    ] {
        viewer.texture_browser.open = drawer;
        for denoise in [false, true] {
            viewer.denoise = denoise;
            for _ in 0..3 {
                frame(&mut viewer, &ctx, &gpu, size, vec![])?;
            }
            let (dock, viewport) = ctx.data(|data| {
                data.get_temp::<(egui::Rect, egui::Rect)>(egui::Id::new("dock-bounds"))
                    .unwrap()
            });
            ensure!(
                viewport.expand(1.).contains_rect(dock),
                "Dock {dock:?} exceeds viewport {viewport:?} at {size:?}, drawer={drawer}, denoise={denoise}"
            );
            let image = frame(&mut viewer, &ctx, &gpu, size, vec![])?;
            save(
                &gpu,
                &image,
                &out.join(format!(
                    "dock-{}-drawer-{drawer}-denoise-{denoise}.png",
                    size[0]
                )),
            )?;
        }
        if drawer {
            let options = ctx
                .data(|data| {
                    data.get_temp::<egui::Rect>(egui::Id::new("dock-options-rect"))
                        .unwrap()
                })
                .center();
            frame(&mut viewer, &ctx, &gpu, size, click(options))?;
            assert!(egui::Popup::is_any_open(&ctx));
            let image = frame(&mut viewer, &ctx, &gpu, size, vec![])?;
            save(&gpu, &image, &out.join("dock-narrow-settings.png"))?;
            frame(
                &mut viewer,
                &ctx,
                &gpu,
                size,
                vec![egui::Event::Key {
                    key: egui::Key::Escape,
                    physical_key: None,
                    pressed: true,
                    repeat: false,
                    modifiers: Default::default(),
                }],
            )?;
            frame(
                &mut viewer,
                &ctx,
                &gpu,
                size,
                vec![egui::Event::Key {
                    key: egui::Key::Escape,
                    physical_key: None,
                    pressed: false,
                    repeat: false,
                    modifiers: Default::default(),
                }],
            )?;
        }
    }
    viewer.texture_browser.open = false;
    viewer.model.1.cameras[0].name = saved_name;
    viewer.camera.f_stop = saved_f_stop;
    viewer.denoise = saved_denoise;
    viewer.running = true;
    viewer.preview_enabled = false;
    viewer.camera.orbit([5., 0.]);
    viewer.dirty(Change::Camera);
    settle(&mut viewer, &ctx, &gpu)?;
    assert!(std::sync::Arc::ptr_eq(
        viewer.target.render_loop.presented_render().unwrap(),
        viewer.target.render_loop.final_render()
    ));
    assert!(viewer.final_render().settings()?.aovs == 0);
    assert_eq!(viewer.target.render_loop.preview().unwrap().samples(), 0);
    viewer.tab = 5;
    for _ in 0..3 {
        frame(&mut viewer, &ctx, &gpu, [1200, 800], vec![])?;
    }
    let image = frame(&mut viewer, &ctx, &gpu, [1200, 800], vec![])?;
    save(&gpu, &image, &out.join("examples-tab.png"))?;
    viewer.tab = 0;
    viewer.load_preset("spheres", &ctx);
    while viewer.loading.is_some() {
        frame(&mut viewer, &ctx, &gpu, [1200, 800], vec![])?;
        std::thread::sleep(Duration::from_millis(5));
    }
    settle(&mut viewer, &ctx, &gpu)?;
    assert_eq!(viewer.environment.name, "Procedural sky");
    assert!(viewer.environment.image.is_some());
    assert_eq!(viewer.examples.current.as_deref(), Some("spheres"));
    viewer.display_settings.output = 0;
    viewer.denoise = true;
    viewer.denoiser_choice = denoiser::Choice::Jnlm;
    viewer.tab = 0;
    let image = settle(&mut viewer, &ctx, &gpu)?;
    save(&gpu, &image, &out.join("render-jnlm.png"))?;
    let hdr = viewer.hdr()?;
    let beauty = viewer.final_render().samples();
    let fov = viewer.camera.fov;
    let before = history::Snapshot::capture(&viewer);
    viewer.camera.fov = 50.;
    viewer.live_denoise = false;
    let after = history::Snapshot::capture(&viewer);
    viewer.history.record(before, after);
    viewer.undo(false);
    assert_eq!(viewer.camera.fov, fov);
    assert!(viewer.live_denoise);
    viewer.undo(true);
    assert_eq!(viewer.camera.fov, 50.);
    assert!(!viewer.live_denoise);
    viewer.undo(false);
    settle(&mut viewer, &ctx, &gpu)?;
    // Completed-only JNLM keeps the same final output and beauty accumulation.
    let filtered = viewer
        .target
        .engine
        .display()
        .read_rgba8(viewer.final_render())?
        .2;
    viewer.live_denoise = false;
    settle(&mut viewer, &ctx, &gpu)?;
    assert_eq!(
        viewer
            .target
            .engine
            .display()
            .read_rgba8(viewer.final_render())?
            .2,
        filtered
    );
    assert_eq!(viewer.hdr()?, hdr);
    assert_eq!(viewer.final_render().samples(), beauty);
    viewer.open_export(&ctx);
    frame(&mut viewer, &ctx, &gpu, [1200, 800], vec![])?;
    let image = frame(&mut viewer, &ctx, &gpu, [1200, 800], vec![])?;
    save(&gpu, &image, &out.join("export-dialog.png"))?;
    viewer.tools.export_samples = 16;
    viewer.tools.transparent = true;
    viewer.start_export(out.join("export-transparent.png"), &ctx);
    let deadline = std::time::Instant::now() + Duration::from_secs(120);
    while viewer.tools.job.is_some() {
        frame(&mut viewer, &ctx, &gpu, [1200, 800], vec![])?;
        ensure!(std::time::Instant::now() < deadline, "Export timed out");
        std::thread::sleep(Duration::from_millis(2));
    }
    ensure!(viewer.error.is_empty(), "{}", viewer.error);
    let export = image::open(out.join("export-transparent.png"))?.into_rgba8();
    assert_eq!(export.dimensions(), (viewer.size[0], viewer.size[1]));
    assert!(export.pixels().any(|p| p.0[3] < 255));
    assert_eq!(viewer.final_render().samples(), beauty);
    assert_eq!(viewer.hdr()?, hdr);
    viewer.environment.grounded = true;
    viewer.dirty(Change::Environment);
    let image = settle(&mut viewer, &ctx, &gpu)?;
    save(&gpu, &image, &out.join("grounded.png"))?;
    std::fs::write(out.join("render-setup.rs"), viewer.render_setup_code())?;
    Ok(())
}
