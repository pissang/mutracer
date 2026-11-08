use super::*;
use crate::test_support::read_texture;
use std::sync::{Arc, Mutex};

fn fixture() -> (Engine, Render) {
    let engine = Engine::new(EngineOptions {
        backend: Backend::Software,
    })
    .unwrap();
    engine.display().set_size(9, 6).unwrap();
    engine.set_scene(&crate::scene::tests::input()).unwrap();
    engine.update().unwrap();
    let render = Render::new(
        &engine,
        RenderSettings {
            max_samples: 2,
            ..Default::default()
        },
    )
    .unwrap();
    (engine, render)
}
fn color_pass(context: PostProcessContext<'_>, color: wgpu::Color) -> Result<()> {
    let view = context.output.create_view(&Default::default());
    let _pass = context
        .encoder
        .begin_render_pass(&wgpu::RenderPassDescriptor {
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &view,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(color),
                    store: wgpu::StoreOp::Store,
                },
            })],
            ..Default::default()
        });
    Ok(())
}
#[test]
#[ignore = "requires a real GPU; run npm run native:ci:gpu"]
fn gpu_output_borrows_and_ordered_passes_cover_export_fallback_and_lifecycle() {
    let _lock = crate::abi_test_lock();
    let (engine, render) = fixture();
    assert!(
        render
            .get_output_texture(OutputKind::Hdr)
            .unwrap()
            .is_none()
    );
    render.converge(ConvergeOptions::new(2)).unwrap();
    let hdr = read_texture(
        &engine.inner.gpu,
        &render.get_output_texture(OutputKind::Hdr).unwrap().unwrap(),
    );
    let raw = render.read_pixels(PixelKind::Hdr).unwrap();
    assert!(
        render
            .get_output_texture(OutputKind::Display)
            .unwrap()
            .is_none()
    );
    let display = engine.display();
    let original = display.read_rgba8(&render).unwrap().2;
    assert_eq!(
        read_texture(
            &engine.inner.gpu,
            &render
                .get_output_texture(OutputKind::Display)
                .unwrap()
                .unwrap()
        ),
        original
    );
    let seen = Arc::new(Mutex::new(Vec::new()));
    let a = seen.clone();
    let first = display
        .add_post_process(move |context| {
            assert_eq!((context.width, context.height), (9, 6));
            assert_eq!(context.render.settings()?.max_samples, 2); // engine lock is free
            a.lock().unwrap().push(1);
            color_pass(
                context,
                wgpu::Color {
                    r: 0.25,
                    g: 0.5,
                    b: 0.75,
                    a: 0.5,
                },
            )
        })
        .unwrap();
    let b = seen.clone();
    let second = display
        .add_post_process(move |context| {
            b.lock().unwrap().push(2);
            context.encoder.copy_texture_to_texture(
                context.input.as_image_copy(),
                context.output.as_image_copy(),
                context.input.size(),
            );
            Ok(())
        })
        .unwrap();
    let processed = display.read_rgba8(&render).unwrap().2;
    assert_eq!(processed.len(), 54 * 4);
    // UNORM clears can select either adjacent integer code (in particular
    // 0.5 * 255 is a tie). Keep exact export/texture identity below.
    // https://docs.vulkan.org/spec/latest/chapters/fundamentals.html
    for pixel in processed.chunks_exact(4) {
        for (actual, (lower, upper)) in
            pixel
                .iter()
                .zip([(63, 64), (127, 128), (191, 192), (127, 128)])
        {
            assert!((*actual >= lower) && (*actual <= upper));
        }
    }
    assert_eq!(*seen.lock().unwrap(), [1, 2]);
    display.set_size(18, 12).unwrap();
    let pending = Render::new(&engine, RenderSettings::default()).unwrap();
    pending.set_fallback(Some(&render)).unwrap();
    assert!(display.present(&pending).unwrap().unwrap().fallback);
    let presentation = read_texture(&engine.inner.gpu, &display.texture().unwrap());
    for rgba in presentation.chunks_exact(4) {
        for (actual, expected) in rgba.iter().zip([32u8, 64, 96, 128]) {
            assert!(actual.abs_diff(expected) <= 1);
        }
    }
    assert_eq!(
        read_texture(
            &engine.inner.gpu,
            &render
                .get_output_texture(OutputKind::Display)
                .unwrap()
                .unwrap()
        ),
        processed
    );
    assert_eq!(
        read_texture(
            &engine.inner.gpu,
            &render.get_output_texture(OutputKind::Hdr).unwrap().unwrap()
        ),
        hdr
    );
    assert_eq!(render.read_pixels(PixelKind::Hdr).unwrap(), raw); // never touches accumulation
    first.remove();
    first.remove();
    drop(second);
    assert_eq!(display.read_rgba8(&render).unwrap().2, original);
    let edge = display
        .add_post_process(|ctx| {
            let stride = 256usize;
            let buffer = ctx.device.create_buffer(&wgpu::BufferDescriptor {
                label: None,
                size: (stride * ctx.height as usize) as u64,
                usage: wgpu::BufferUsages::COPY_SRC,
                mapped_at_creation: true,
            });
            {
                let mut mapped = buffer.get_mapped_range_mut(..).unwrap();
                for y in 0..ctx.height as usize {
                    for x in 0..ctx.width as usize {
                        mapped
                            .slice(y * stride + x * 4..y * stride + x * 4 + 4)
                            .copy_from_slice(if x < 4 {
                                &[255, 0, 0, 255]
                            } else {
                                &[0, 0, 255, 0]
                            });
                    }
                }
            }
            buffer.unmap();
            ctx.encoder.copy_buffer_to_texture(
                wgpu::TexelCopyBufferInfo {
                    buffer: &buffer,
                    layout: wgpu::TexelCopyBufferLayout {
                        offset: 0,
                        bytes_per_row: Some(stride as u32),
                        rows_per_image: None,
                    },
                },
                ctx.output.as_image_copy(),
                ctx.output.size(),
            );
            Ok(())
        })
        .unwrap();
    display.present(&render).unwrap();
    let scaled = read_texture(&engine.inner.gpu, &display.texture().unwrap());
    assert!(scaled.chunks_exact(4).any(|p| p[3] > 0 && p[3] < 255));
    for pixel in scaled.chunks_exact(4) {
        assert_eq!(pixel[1], 0);
        assert_eq!(pixel[2], 0);
        assert_eq!(pixel[0], pixel[3]);
    }
    drop(edge);
    render.restart().unwrap();
    assert!(
        render
            .get_output_texture(OutputKind::Hdr)
            .unwrap()
            .is_none()
    );
    assert!(
        render
            .get_output_texture(OutputKind::Display)
            .unwrap()
            .is_none()
    );
    render
        .set_settings(RenderSettings {
            size: RenderSize::Fixed {
                width: 5,
                height: 3,
            },
            ..Default::default()
        })
        .unwrap();
    render.converge(ConvergeOptions::new(1)).unwrap();
    let texture = render.get_output_texture(OutputKind::Hdr).unwrap().unwrap();
    assert_eq!((texture.width(), texture.height()), (5, 3));
    let mut settings = render.settings().unwrap();
    settings.max_samples = 1;
    render.set_settings(settings).unwrap();
    let render = Arc::new(render);
    let mut render_loop = RenderLoop::new(
        &engine,
        RenderLoopOptions {
            preview: None,
            final_render: LoopRender::Render(render.clone()),
            ..Default::default()
        },
    )
    .unwrap();
    render_loop.converge(ConvergeOptions::new(1)).unwrap();
    render_loop.tick().unwrap();
    assert!(!render_loop.needs_tick());
    let pass = display
        .add_post_process(|ctx| color_pass(ctx, wgpu::Color::BLUE))
        .unwrap();
    assert!(render_loop.needs_tick());
    render_loop.tick().unwrap();
    assert_eq!(render.samples(), 1);
    assert!(!render_loop.needs_tick());
    drop(pass);
    assert!(render_loop.needs_tick());
    render_loop.tick().unwrap();
    assert_eq!(render.samples(), 1);
    engine.device_loss_notifier().notify("output borrow loss");
    assert_eq!(
        render
            .get_output_texture(OutputKind::Hdr)
            .unwrap_err()
            .status,
        Status::Unavailable
    );
    engine.dispose();
    assert_eq!(
        render
            .get_output_texture(OutputKind::Display)
            .unwrap_err()
            .status,
        Status::InvalidHandle
    );
}
#[test]
#[ignore = "requires a real GPU; run npm run native:ci:gpu"]
fn gpu_output_pass_failure_discards_commands_and_allows_callback_reentry() {
    let _lock = crate::abi_test_lock();
    let (engine, render) = fixture();
    render.converge(ConvergeOptions::new(2)).unwrap();
    let display = engine.display();
    let original = display.read_rgba8(&render).unwrap().2;
    let events = Arc::new(Mutex::new(Vec::new()));
    let stored = events.clone();
    let callback_engine = engine.clone();
    let _events = engine.on(move |event| {
        if let EngineEvent::Error { .. } = event {
            // Error delivery occurs after the processing guard has been released.
            assert!(!callback_engine.lock().display.processing);
            stored.lock().unwrap().push(event.clone());
        }
    });
    let first = display
        .add_post_process(|ctx| color_pass(ctx, wgpu::Color::RED))
        .unwrap();
    for panic in [false, true] {
        let failing = display
            .add_post_process(move |ctx| {
                assert_eq!(
                    ctx.render
                        .get_output_texture(OutputKind::Display)
                        .unwrap_err()
                        .status,
                    Status::InvalidState
                );
                assert_eq!(
                    ctx.render
                        .engine()
                        .display()
                        .read_rgba8(ctx.render)
                        .unwrap_err()
                        .status,
                    Status::InvalidState
                );
                color_pass(ctx, wgpu::Color::GREEN)?;
                if panic {
                    panic!("intentional pass panic");
                }
                Err(super::error(Status::Error, "intentional pass failure"))
            })
            .unwrap();
        assert_eq!(display.read_rgba8(&render).unwrap().2, original);
        assert_eq!(
            read_texture(
                &engine.inner.gpu,
                &render
                    .get_output_texture(OutputKind::Display)
                    .unwrap()
                    .unwrap()
            ),
            original
        );
        drop(failing);
    }
    assert_eq!(events.lock().unwrap().len(), 2);
    drop(first);
    let changed = display
        .add_post_process(|ctx| {
            ctx.render.restart()?;
            Ok(())
        })
        .unwrap();
    assert_eq!(
        display.present(&render).unwrap_err().status,
        Status::InvalidState
    );
    drop(changed);
    render.converge(ConvergeOptions::new(1)).unwrap();
    assert!(display.present(&render).unwrap().is_some());
    let loss = engine.device_loss_notifier();
    let _lost = display
        .add_post_process(move |_| {
            loss.notify("loss while recording display pass");
            Ok(())
        })
        .unwrap();
    assert_eq!(
        display.present(&render).unwrap_err().status,
        Status::Unavailable
    );
    engine.dispose();
}

#[test]
#[ignore = "requires a real GPU; run npm run native:ci:gpu"]
fn hdr_passes_keep_extended_pixels_order_failure_and_sdr_exports_independent() {
    let _lock = crate::abi_test_lock();
    let (engine, render) = fixture();
    render.converge(ConvergeOptions::new(2)).unwrap();
    let display = engine.display();
    let raw = render.read_pixels(PixelKind::Hdr).unwrap();
    let sdr = display.read_rgba8(&render).unwrap().2;
    let before = display
        .compose_mode(&render, false, true)
        .unwrap()
        .unwrap()
        .texture;
    let baseline = read_texture(&engine.inner.gpu, &before);
    let order = Arc::new(Mutex::new(Vec::new()));
    let seen = order.clone();
    let a = display
        .add_hdr_post_process(move |ctx| {
            assert_eq!(ctx.input.format(), wgpu::TextureFormat::Rgba16Float);
            assert_eq!(ctx.output.format(), wgpu::TextureFormat::Rgba16Float);
            assert_eq!(ctx.render.samples(), 2);
            let display = ctx.render.engine().display();
            let mut settings = display.settings();
            settings.hdr_output_enabled = !settings.hdr_output_enabled;
            assert_eq!(
                display.set_settings(settings).unwrap_err().status,
                Status::InvalidState
            );
            seen.lock().unwrap().push(1);
            color_pass(
                ctx,
                wgpu::Color {
                    r: 4.,
                    g: 2.,
                    b: 0.5,
                    a: 0.25,
                },
            )
        })
        .unwrap();
    let seen = order.clone();
    let b = display
        .add_hdr_post_process(move |ctx| {
            seen.lock().unwrap().push(2);
            ctx.encoder.copy_texture_to_texture(
                ctx.input.as_image_copy(),
                ctx.output.as_image_copy(),
                ctx.input.size(),
            );
            Ok(())
        })
        .unwrap();
    let hdr = display.compose_mode(&render, false, true).unwrap().unwrap();
    assert!(!hdr.premultiplied);
    assert_eq!(*order.lock().unwrap(), [1, 2]);
    let expected: Vec<u8> = [0x4400u16, 0x4000, 0x3800, 0x3400]
        .into_iter()
        .flat_map(u16::to_le_bytes)
        .collect();
    for pixel in read_texture(&engine.inner.gpu, &hdr.texture).chunks_exact(8) {
        assert_eq!(pixel, expected);
    }
    assert_eq!(display.read_rgba8(&render).unwrap().2, sdr);
    assert_eq!(*order.lock().unwrap(), [1, 2]); // SDR export must not run HDR callbacks.
    let bad = display
        .add_hdr_post_process(|_| Err(error(Status::Error, "HDR pass failure")))
        .unwrap();
    let failed = display.compose_mode(&render, false, true).unwrap().unwrap();
    assert_eq!(read_texture(&engine.inner.gpu, &failed.texture), baseline);
    assert!(engine.last_error().unwrap().contains("HDR pass failure"));
    bad.remove();
    a.remove();
    b.remove();
    assert_eq!(
        read_texture(
            &engine.inner.gpu,
            &display
                .compose_mode(&render, false, true)
                .unwrap()
                .unwrap()
                .texture
        ),
        baseline
    );
    assert_eq!(render.read_pixels(PixelKind::Hdr).unwrap(), raw);
    assert_eq!(display.read_rgba8(&render).unwrap().2, sdr);
}
