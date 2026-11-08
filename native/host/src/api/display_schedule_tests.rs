#[cfg(test)]
mod parity_schedule_tests {
    use super::*;
    struct Controlled {
        entered: mpsc::Sender<CancelToken>,
        release: Arc<Mutex<mpsc::Receiver<()>>>,
        scale: f32,
    }
    impl super::super::CustomDenoiser for Controlled {
        fn denoise(
            &self,
            input: super::super::DenoiseInput,
            cancel: CancelToken,
        ) -> std::result::Result<super::super::DenoiseOutput, String> {
            self.entered.send(cancel).unwrap();
            self.release.lock().unwrap().recv().unwrap();
            Ok(super::super::DenoiseOutput::Cpu(input.color.into_iter().enumerate().map(|(i, v)| if i % 4 == 3 { v } else { v * self.scale }).collect()))
        }
    }
    #[test]
    #[ignore = "real GPU schedule event table"]
    fn display_schedule_event_table() {
        let _guard = crate::abi_test_lock();
        let table: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../tests/fixtures/display-schedule.json"
        ))
        .unwrap();
        for row in table["cases"].as_array().unwrap() {
            let (engine, render) = super::super::lifecycle_tests::fixture();
            engine.set_scene(&crate::api::tests::lit_scene()).unwrap();
            engine.update().unwrap();
            render.converge(ConvergeOptions::new(1)).unwrap();
            let (entered, receive) = mpsc::channel();
            let (release, resume) = mpsc::channel();
            let resume = Arc::new(Mutex::new(resume));
            let controlled: Arc<dyn super::super::CustomDenoiser> = Arc::new(Controlled {
                entered: entered.clone(), release: resume.clone(), scale: 0.75,
            });
            render.set_custom_denoiser(Some(controlled.clone()), DenoiseSchedule::Progressive).unwrap();
            let mut actions = Vec::new();
            let mut token = CancelToken::new();
            let mut revisions = 0;
            for event in row["events"].as_array().unwrap() {
                match event.as_str().unwrap() {
                    "start" => {
                        assert!(!render.denoise_current().unwrap());
                        token = receive.recv_timeout(Duration::from_secs(20)).unwrap();
                        actions.push("Filter");
                        render
                            .with(|s, id| {
                                let r = &s.renders[&id];
                                assert!(r.denoise.worker.is_some());
                                assert_eq!(readiness(s, id).presentable, denoised_samples(r) > 0);
                                Ok(())
                            })
                            .unwrap();
                    }
                    "complete" => {
                        release.send(()).unwrap();
                        if token.is_cancelled() {
                            actions.push("Discard");
                        } else {
                            let start = Instant::now();
                            while !render.denoise_current().unwrap() {
                                assert!(start.elapsed() < Duration::from_secs(20));
                                std::thread::yield_now();
                            }
                            actions.push("Publish");
                        }
                    }
                    "advance" => {
                        render
                            .with(|s, id| {
                                let r = s.renders.get_mut(&id).unwrap();
                                r.samples += 1;
                                Ok(())
                            })
                            .unwrap();
                        actions.push("Retain");
                    }
                    "options" => {
                        render.set_custom_denoiser(Some(Arc::new(Controlled { entered: entered.clone(), release: resume.clone(), scale: 0.5 })), DenoiseSchedule::Progressive).unwrap();
                        let state = engine.lock(); let r = &state.renders[&render.id()];
                        assert_eq!(denoised_samples(r), 0); assert!(r.denoise.worker.is_none());
                        actions.push("Invalidate");
                    }
                    "present" => {
                        let retained = render.diagnostics().unwrap().denoised_samples;
                        let pending = render.diagnostics().unwrap().denoising;
                        assert!(engine.display().present(&render).unwrap().is_some());
                        assert_eq!(render.diagnostics().unwrap().denoised_samples, retained);
                        assert_eq!(render.diagnostics().unwrap().denoising, pending);
                        actions.push("Present");
                    }
                    "present-unavailable" => {
                        assert_eq!(engine.display().present(&render).unwrap_err().status, Status::Unavailable);
                        let state = engine.lock(); assert!(!readiness(&state, render.id()).presentable);
                        assert!(state.renders[&render.id()].denoise.denoised.is_none());
                        actions.push("Unavailable");
                    }
                    event @ ("diagnostic" | "final") => {
                        let retained = render.diagnostics().unwrap().denoised_samples;
                        engine.display().set_settings(super::super::DisplaySettings {
                            channel: if event == "diagnostic" { super::super::Channel::Normal } else { super::super::Channel::Final },
                            ..Default::default()
                        }).unwrap();
                        assert!(engine.display().present(&render).unwrap().is_some());
                        assert_eq!(render.diagnostics().unwrap().denoised_samples, retained);
                        assert!(!render.diagnostics().unwrap().denoising);
                        if event == "diagnostic" {
                            let raw = render.read_pixels(PixelKind::Normal).unwrap();
                            let (w, h, bytes) = engine.display().read_rgba8(&render).unwrap();
                            assert_eq!([w, h], [raw.width, raw.height]);
                            for (a, b) in bytes.chunks_exact(4).zip(raw.data.chunks_exact(4)) {
                                // SDK normal readback is signed; the diagnostic maps
                                // valid normals to [0,1] and leaves misses transparent.
                                let valid = b[..3].iter().map(|v| v * v).sum::<f32>() > 0.1;
                                let expected = if valid { [b[0]*0.5+0.5,b[1]*0.5+0.5,b[2]*0.5+0.5,1.] } else { [0.;4] };
                                for (a, b) in a.iter().zip(expected) {
                                    assert!((*a as f32 - b.clamp(0.,1.)*255.).abs() <= 1.);
                                }
                            }
                        }
                        actions.push(if event == "diagnostic" { "Diagnostic" } else { "Final" });
                    }
                    "revision" => {
                        revisions += 1;
                        let mut camera = super::super::Camera::default(); camera.world_matrix[12] = revisions as f32 * 0.1;
                        engine.set_camera(Some(camera)).unwrap(); engine.update().unwrap();
                        assert!(token.is_cancelled()); actions.push("Cancel");
                    }
                    "device-lost" => {
                        engine.device_loss_notifier().notify("schedule fixture loss");
                        let state = engine.lock(); let r = &state.renders[&render.id()];
                        assert!(token.is_cancelled()); assert!(r.denoise.worker.is_none());
                        assert!(!readiness(&state, render.id()).presentable); actions.push("Cancel");
                    }
                    "cancel" => {
                        render.with(|s, id| { cancel_denoise(s.renders.get_mut(&id).unwrap()); Ok(()) }).unwrap();
                        assert!(token.is_cancelled()); actions.push("Cancel");
                    }
                    event => panic!("Unknown schedule event: {event}"),
                }
            }
            assert_eq!(
                serde_json::json!(actions),
                row["actions"],
                "{}",
                row["name"]
            );
            eprintln!("schedule {}: {:?}", row["name"], actions);
        }
    }
}
