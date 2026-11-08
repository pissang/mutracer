use super::*;
use std::sync::{Arc, Mutex, mpsc};
use std::time::Duration;

#[test]
#[ignore = "requires a real GPU; run npm run native:ci:gpu"]
fn device_loss_shared_host_callback_fails_all_engines_without_recovery() {
    let _test = crate::abi_test_lock();
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
    let adapter = pollster::block_on(instance.request_adapter(&Default::default())).unwrap();
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
        required_limits: adapter.limits(),
        ..Default::default()
    }))
    .unwrap();
    let forward = Arc::new(Mutex::new(Vec::<DeviceLossNotifier>::new()));
    let host_calls = Arc::new(Mutex::new(0));
    let (callbacks, called) = (forward.clone(), host_calls.clone());
    // Installed before on_device: neither constructor may replace the host callback.
    device.set_device_lost_callback(move |reason, message| {
        *called.lock().unwrap() += 1;
        for signal in callbacks.lock().unwrap().iter() {
            signal.notify(format!("{reason:?}: {message}"));
        }
    });
    let options = EngineOptions {
        backend: Backend::Software,
    };
    let a = Engine::on_device(&adapter, &device, &queue, options.clone(), None);
    let b = Engine::on_device(&adapter, &device, &queue, options, None);
    forward
        .lock()
        .unwrap()
        .extend([a.device_loss_notifier(), b.device_loss_notifier()]);
    a.display().set_size(8, 8).unwrap();
    a.set_scene(&crate::scene::tests::input()).unwrap();
    let mut render_loop = RenderLoop::new(
        &a,
        RenderLoopOptions {
            preview: None,
            ..Default::default()
        },
    )
    .unwrap();
    render_loop.converge(ConvergeOptions::new(1)).unwrap();
    render_loop.final_render().restart().unwrap();
    render_loop.final_render().refine().unwrap();
    let rb = Render::new(&b, RenderSettings::default()).unwrap();
    let mut b_loop = RenderLoop::new(&b, RenderLoopOptions::default()).unwrap();
    let b_events = Arc::new(Mutex::new(Vec::new()));
    let stored_b = b_events.clone();
    let _b_subscription = b.on(move |event| stored_b.lock().unwrap().push(event.clone()));
    let events = Arc::new(Mutex::new(Vec::new()));
    let stored = events.clone();
    let callback_engine = a.clone();
    let _subscription = a.on(move |event| {
        // Device/error callbacks run without engine/driver locks and allow reentry.
        assert!(
            callback_engine
                .last_error()
                .unwrap()
                .contains("GPU device lost")
        );
        stored.lock().unwrap().push(event.clone());
    });
    device.destroy();
    // wgpu may defer the callback until the outstanding submission retires.
    let deadline = std::time::Instant::now() + Duration::from_secs(3);
    loop {
        match a.update() {
            Err(error) => {
                assert_eq!(error.status, Status::Unavailable);
                break;
            }
            Ok(_) => {
                assert!(std::time::Instant::now() < deadline);
                std::thread::sleep(Duration::from_millis(1));
            }
        }
    }
    assert_eq!(*host_calls.lock().unwrap(), 1);
    assert_eq!(rb.status(), RenderStatus::Error);
    // Even an idle host driven only by needs_tick must receive the loss once.
    assert!(b_loop.needs_tick());
    assert_eq!(b_loop.tick().unwrap_err().status, Status::Unavailable);
    assert!(!b_loop.needs_tick());
    assert_eq!(b_events.lock().unwrap().len(), 2);
    assert_eq!(render_loop.final_render().status(), RenderStatus::Error);
    assert_eq!(render_loop.status(), RenderLoopStatus::Error);
    assert!(!render_loop.needs_tick());
    assert!(!render_loop.final_render().converged());
    assert!(!render_loop.final_render().denoising());
    assert!(a.display().texture().is_none());
    assert_eq!(render_loop.tick().unwrap_err().status, Status::Unavailable);
    assert_eq!(
        render_loop
            .final_render()
            .read_pixels(PixelKind::Hdr)
            .unwrap_err()
            .status,
        Status::Unavailable
    );
    assert_eq!(
        a.display()
            .present(render_loop.final_render())
            .unwrap_err()
            .status,
        Status::Unavailable
    );
    assert_eq!(
        Render::new(&a, RenderSettings::default())
            .err()
            .unwrap()
            .status,
        Status::Unavailable
    );
    let original = a.last_error();
    a.device_loss_notifier()
        .notify("a later reason must not replace the first");
    assert_eq!(a.update().unwrap_err().status, Status::Unavailable);
    assert_eq!(a.last_error(), original);
    let events = events.lock().unwrap();
    assert_eq!(events.len(), 2);
    assert!(matches!(
        &events[0],
        EngineEvent::DeviceLost {
            recovering: false,
            ..
        }
    ));
    assert!(matches!(&events[1], EngineEvent::Error { .. }));
    drop(events);
    let unrelated = Engine::new(EngineOptions {
        backend: Backend::Software,
    })
    .unwrap();
    assert!(unrelated.update().is_ok());
    unrelated.dispose();
    a.dispose();
    b.dispose();
    assert_eq!(a.update().unwrap_err().status, Status::InvalidHandle);
}

#[test]
#[ignore = "requires a real GPU; run npm run native:ci:gpu"]
fn device_loss_interrupts_converge_and_target_aot_waits_before_the_worker_finishes() {
    let _test = crate::abi_test_lock();
    for retarget in [false, true] {
        let engine = Engine::new(EngineOptions {
            backend: Backend::Software,
        })
        .unwrap();
        engine.display().set_size(8, 8).unwrap();
        engine.set_scene(&crate::scene::tests::input()).unwrap();
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
        if retarget {
            render.converge(ConvergeOptions::new(1)).unwrap();
            render
                .set_settings(RenderSettings {
                    size: RenderSize::Fixed {
                        width: 12,
                        height: 8,
                    },
                    max_samples: 2,
                    ..Default::default()
                })
                .unwrap();
        }
        let events = Arc::new(Mutex::new(Vec::new()));
        let stored = events.clone();
        let _subscription = engine.on(move |event| {
            stored
                .lock()
                .unwrap()
                .push((std::thread::current().id(), event.clone()));
        });
        let (entered, started) = mpsc::sync_channel(1);
        let (resume, resumed) = mpsc::sync_channel(1);
        *crate::runtime::CALL_GATE.lock().unwrap() = Some((entered, resumed));
        let (finished, result) = mpsc::sync_channel(1);
        let working = render.clone();
        let worker = std::thread::spawn(move || {
            let value = if retarget {
                working.refine().map(|_| ())
            } else {
                working.converge(ConvergeOptions::new(2)).map(|_| ())
            };
            finished.send((std::thread::current().id(), value)).unwrap();
        });
        started.recv_timeout(Duration::from_secs(5)).unwrap();
        engine.inner.gpu.device.destroy();
        // The API must fail before AOT resumes, rather than waiting for its normal timeout.
        let (thread, result) = result.recv_timeout(Duration::from_secs(3)).unwrap();
        assert_eq!(result.unwrap_err().status, Status::Unavailable);
        worker.join().unwrap();
        assert_eq!(render.status(), RenderStatus::Error);
        assert_eq!(events.lock().unwrap().len(), 2);
        assert!(
            events
                .lock()
                .unwrap()
                .iter()
                .all(|(called, _)| *called == thread)
        );
        resume.send(()).unwrap();
        crate::runtime::init();
        assert_eq!(
            render.converge(ConvergeOptions::new(1)).unwrap_err().status,
            Status::Unavailable
        );
        assert_eq!(events.lock().unwrap().len(), 2);
        engine.dispose();
    }
}
