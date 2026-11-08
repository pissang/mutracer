//! Opt-in validation instrumentation. Never installed by the renderer API.
use super::*;

pub(super) fn install(scene: &mut Scene, assets: &mut Assets) -> Result<()> {
    install_history(scene, assets, 0)
}

// Keep the ordinary last-sample audit in the first plane. Additional planes
// observe every submitted sample without readbacks between dispatches, which
// would change the scheduling of the fault this instrumentation measures.
pub(super) fn install_history(scene: &mut Scene, assets: &mut Assets, samples: u32) -> Result<()> {
    let id = scene
        .hwrt
        .as_ref()
        .and_then(|h| h.shader)
        .unwrap_or(scene.shader);
    let shader = String::from_utf8(assets.get(&id).ok_or("Missing validation shader")?.clone())?;
    let direct = "\n  intersectScene(ray, &si, 0, false, false);";
    let fused = "intersectScene(path.ray, &si, depth, event != 0, path.isNextRefraction);";
    let (primary, first_query) = if shader.contains(direct) {
        (direct, "true")
    } else {
        (
            fused,
            if shader.contains("var primaryReady = false;") {
                "!primaryReady"
            } else {
                "event == 0"
            },
        )
    };
    let tail = "    accumulateDenoiseMoments(idx, dot(liAndAlpha.rgb, luminance));\n  }\n}";
    if shader.matches(primary).count() != 1
        || shader.matches(tail).count() != 1
        || shader.matches("fn integrator(").count() != 1
    {
        return Err("Shared shader changed; update sample audit anchors".into());
    }
    // Keep the scene bind group identical so retained AS updates exercise
    // their ordinary production bindings. The audit lives with the outputs.
    let declaration = format!(
        "@group({}) @binding({}) var<storage, read_write> mtSampleAudit: array<vec4u>;\nvar<private> mtPrimaryHit: u32;\nvar<private> mtInteriorHit: u32;\n",
        layout::group::OUTPUT,
        layout::hwrt_binding::DIAGNOSTIC
    );
    // Observe only the first query in both legacy and fused path loops, including
    // alpha/spectral primary reuse. No extra query or RNG call is introduced.
    let shader = shader.replacen("fn integrator(", &(declaration + "fn integrator("), 1).replace(primary, &format!("{primary}\n  if ({first_query}) {{\n    mtPrimaryHit = u32(si.hit);\n    mtInteriorHit = u32(si.hit && min(min(si.barycentrics.x, si.barycentrics.y), 1.0 - si.barycentrics.x - si.barycentrics.y) > 0.001);\n  }}"))
        .replace(tail, "    accumulateDenoiseMoments(idx, dot(liAndAlpha.rgb, luminance));\n  }\n  mtSampleAudit[idx] = vec4u(mtSampleAudit[idx].x + 1u, pixelSampleIndex, mtPrimaryHit, mtInteriorHit);\n}");
    let pixels = scene.width as usize * scene.height as usize;
    let shader = if samples > 0 {
        shader.replace(
            "mtSampleAudit[idx] = vec4u(mtSampleAudit[idx].x + 1u, pixelSampleIndex, mtPrimaryHit, mtInteriorHit);",
            &format!("mtSampleAudit[idx] = vec4u(mtSampleAudit[idx].x + 1u, pixelSampleIndex, mtPrimaryHit, mtInteriorHit);\n  let submitted = u32(rtUniform.sampleCount);\n  if (submitted < {samples}u) {{ mtSampleAudit[(submitted + 1u) * {pixels}u + idx] = mtSampleAudit[idx]; }}"),
        )
    } else {
        shader
    };
    assets.insert(id, shader.into_bytes());
    let size = pixels * 16 * (samples as usize + 1);
    assets.insert(AssetId::Diagnostic(52), vec![0; size]);
    scene.buffers.push(Buffer {
        id: layout::resource::QUERY_COUNTS,
        size: size as u64,
        usage: 140,
        resource: AssetId::Diagnostic(52),
    });
    scene.bind_groups[layout::group::OUTPUT]
        .layout
        .push(storage_layout(
            layout::hwrt_binding::DIAGNOSTIC as u32,
            false,
        ));
    scene.bind_groups[layout::group::OUTPUT]
        .entries
        .push(Binding {
            binding: layout::hwrt_binding::DIAGNOSTIC as u32,
            kind: BindingKind::Buffer,
            id: layout::resource::QUERY_COUNTS,
        });
    Ok(())
}

/// Reuse the same immutable buffers and AS for an ordinary shader control.
pub(super) fn ordinary_pipeline(state: &mut GpuScene, source: String) {
    let layouts: Vec<_> = (0..state.layouts.len())
        .map(|i| state.pipeline.get_bind_group_layout(i as u32))
        .collect();
    let refs: Vec<_> = layouts.iter().map(Some).collect();
    let layout = state
        .gpu
        .device
        .create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("ordinary validation layout"),
            bind_group_layouts: &refs,
            ..Default::default()
        });
    let module = state
        .gpu
        .device
        .create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("ordinary validation shader"),
            source: wgpu::ShaderSource::Wgsl(source.into()),
        });
    state.pipeline = state
        .gpu
        .device
        .create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("ordinary validation pipeline"),
            layout: Some(&layout),
            module: &module,
            entry_point: Some(&state.scene.entry_point),
            compilation_options: Default::default(),
            cache: None,
        });
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Sample {
    pub sample: u32,
    pub pixels: usize,
    pub primary_hits: usize,
    pub interior_hits: usize,
    pub short_pixels: usize,
    pub invalid_pixels: usize,
}

pub(super) fn read(state: &GpuScene, target: &Target, sample: u32) -> Result<Sample> {
    let data =
        hit_diagnostics::read_raw(&state.gpu, &target.buffers[&layout::resource::QUERY_COUNTS])?;
    let normal = hit_diagnostics::read_raw(&state.gpu, &target.buffers[&layout::resource::NORMAL])?;
    classify(
        data.get(..normal.len())
            .ok_or("Short sample audit buffer")?,
        &normal,
        sample,
    )
}

#[cfg(test)]
#[derive(Debug, serde::Serialize)]
pub(crate) struct HistorySample {
    pub sample: u32,
    pub primary_hits: usize,
    pub unwritten_pixels: usize,
    pub wrong_sequence_pixels: usize,
}

#[cfg(test)]
#[derive(Default)]
pub(crate) struct History {
    pub samples: Vec<HistorySample>,
    pub records: Vec<u8>,
}

#[cfg(test)]
impl std::fmt::Debug for History {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.samples.fmt(f)
    }
}

#[cfg(test)]
pub(crate) fn read_history(state: &GpuScene, target: &Target, samples: u32) -> Result<History> {
    let data =
        hit_diagnostics::read_raw(&state.gpu, &target.buffers[&layout::resource::QUERY_COUNTS])?;
    let samples = summarize_history(
        &data,
        state.scene.width as usize * state.scene.height as usize,
        samples,
    )?;
    Ok(History {
        samples,
        records: data,
    })
}

#[cfg(test)]
fn summarize_history(data: &[u8], pixels: usize, samples: u32) -> Result<Vec<HistorySample>> {
    let plane = pixels * 16;
    if data.len() < plane * (samples as usize + 1) {
        return Err("Sample history was not installed".into());
    }
    Ok((0..samples)
        .map(|sample| {
            let mut summary = HistorySample {
                sample,
                primary_hits: 0,
                unwritten_pixels: 0,
                wrong_sequence_pixels: 0,
            };
            let start = plane * (sample as usize + 1);
            for record in data[start..start + plane].chunks_exact(16) {
                let w: [u32; 4] = std::array::from_fn(|i| {
                    u32::from_le_bytes(record[i * 4..i * 4 + 4].try_into().unwrap())
                });
                if w[0] == 0 {
                    summary.unwritten_pixels += 1;
                } else {
                    summary.primary_hits += w[2] as usize;
                    summary.wrong_sequence_pixels +=
                        usize::from(w[0] != sample + 1 || w[1] != sample);
                }
            }
            summary
        })
        .collect())
}

fn classify(data: &[u8], normal: &[u8], sample: u32) -> Result<Sample> {
    if data.len() != normal.len() || data.is_empty() || data.len() % 16 != 0 {
        return Err("Invalid sample audit lengths".into());
    }
    let mut result = Sample {
        sample,
        pixels: data.len() / 16,
        primary_hits: 0,
        interior_hits: 0,
        short_pixels: 0,
        invalid_pixels: 0,
    };
    for (record, pixel) in data.chunks_exact(16).zip(normal.chunks_exact(16)) {
        let w: [u32; 4] = std::array::from_fn(|i| {
            u32::from_le_bytes(record[i * 4..i * 4 + 4].try_into().unwrap())
        });
        let count = f32::from_le_bytes(pixel[12..16].try_into().unwrap());
        // Both independent buffers must agree. Stale sequence after a previous
        // omission is never used as new evidence: callers stop at first fault.
        if w[0] > sample + 1
            || count != w[0] as f32
            || w[2] > 1
            || w[3] > w[2]
            || (w[0] == sample + 1 && w[1] != sample)
        {
            result.invalid_pixels += 1;
        } else if w[0] < sample + 1 {
            result.short_pixels += 1;
        } else {
            result.primary_hits += w[2] as usize;
            result.interior_hits += w[3] as usize;
        }
    }
    Ok(result)
}

#[cfg(test)]
fn classify_accumulation(data: &[u8], sample: u32) -> serde_json::Value {
    let mut short = 0usize;
    let mut invalid = usize::from(data.is_empty() || data.len() % 16 != 0);
    let mut minimum = sample + 1;
    let mut maximum = 0u32;
    for pixel in data.chunks_exact(16) {
        let count = f32::from_le_bytes(pixel[12..16].try_into().unwrap());
        if !count.is_finite() || count < 0. || count > (sample + 1) as f32 || count.fract() != 0. {
            invalid += 1;
        } else {
            let count = count as u32;
            minimum = minimum.min(count);
            maximum = maximum.max(count);
            short += usize::from(count < sample + 1);
        }
    }
    json!({"sample":sample,"pixels":data.len()/16,"shortPixels":short,"invalidPixels":invalid,"expectedCount":sample+1,"observedMin":minimum,"observedMax":maximum})
}

#[cfg(test)]
pub(super) fn evidence(a: &Sample, b: Option<&Sample>) -> Option<serde_json::Value> {
    if a.invalid_pixels > 0 || b.is_some_and(|v| v.invalid_pixels > 0) {
        return None;
    }
    if a.short_pixels > 0 {
        return Some(
            json!({"kind":"sample-count-short", "sample":a.sample, "shortPixels":a.short_pixels, "pixels":a.pixels, "independentCountersAgree":true}),
        );
    }
    if let Some(b) = b {
        if b.short_pixels > 0 {
            return evidence(b, None);
        }
        if a.sample == b.sample
            && a.pixels == b.pixels
            && ((a.primary_hits == 0 && b.interior_hits > 0)
                || (b.primary_hits == 0 && a.interior_hits > 0))
        {
            return Some(
                json!({"kind":"all-primary-hits-lost", "sample":a.sample, "primaryHits":[a.primary_hits,b.primary_hits], "interiorHits":[a.interior_hits,b.interior_hits], "sameAttempt":true}),
            );
        }
    }
    None
}

#[cfg(test)]
pub(super) fn retry_event(
    test: &str,
    attempt: u32,
    step: usize,
    sample: u32,
    evidence: Option<&serde_json::Value>,
    input: &[u8],
    states: [(&GpuScene, &Target); 2],
) -> Result<bool> {
    let base = std::env::var_os("MUTRACER_TEST_CAPTURE")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join("mutracer-platform-tests"));
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_nanos();
    let dir = base.join(format!(
        "{test}-{}-{stamp}-attempt{attempt}",
        std::process::id()
    ));
    fs::create_dir_all(&dir)?;
    fs::write(dir.join("input.bin"), input)?;
    for (side, (state, target)) in states.iter().enumerate() {
        for id in [
            layout::resource::COLOR,
            layout::resource::NORMAL,
            layout::resource::ALBEDO,
            layout::resource::QUERY_COUNTS,
        ] {
            fs::write(
                dir.join(format!("side{side}-buffer{id}.bin")),
                hit_diagnostics::read_raw(&state.gpu, &target.buffers[&id])?,
            )?;
        }
    }
    let event = json!({"test":test,"attempt":attempt,"step":step,"sample":sample,"classification":if evidence.is_some() {"a"} else {"unknown"},"evidence":evidence,"rerun":evidence.is_some() && attempt<3,"capture":dir});
    println!("{event}");
    fs::write(dir.join("event.json"), serde_json::to_vec_pretty(&event)?)?;
    Ok(evidence.is_some() && attempt < 3)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "requires a real GPU; run npm run native:ci:gpu"]
    fn instrumentation_preserves_aovs_on_the_same_acceleration_structures() {
        let _test = crate::abi_test_lock();
        let _entry = crate::entry_lock();
        for backend in [0, 1] {
            let gpu =
                GpuDevice::with_backend(backend).expect("GPU validation requires a working device");
            assert!(
                backend == 0 || gpu.hardware_ray_query,
                "GPU validation requires HWRT"
            );
            let input = scene::tests::translated_camera_input();
            let (mut scene, mut assets, _retained) = scene::prepare_retained_with_settings(
                &input,
                backend == 1,
                backend,
                &settings::RenderSettings::default(),
            )
            .unwrap();
            if backend == 1 {
                scene.hwrt = Some(
                    hardware::capture_from_resources(
                        &mut assets,
                        scene.native_layout.as_ref().unwrap(),
                    )
                    .unwrap(),
                );
            }
            let id = scene
                .hwrt
                .as_ref()
                .and_then(|h| h.shader)
                .unwrap_or(scene.shader);
            let original = String::from_utf8(assets[&id].clone()).unwrap();
            install_history(&mut scene, &mut assets, 4).unwrap();
            let (mut state, mut target) = GpuScene::new(
                scene,
                &RenderOptions {
                    flags: if backend == 1 { 4 } else { 0 },
                    ..Default::default()
                },
                &assets,
                gpu,
            )
            .unwrap();
            for sample in 0..8 {
                state.add_samples(&mut target, 1).unwrap();
                let audit = read(&state, &target, sample).unwrap();
                assert_eq!(audit.short_pixels + audit.invalid_pixels, 0);
            }
            for sample in read_history(&state, &target, 4).unwrap().samples {
                assert_eq!(sample.unwritten_pixels, 0, "{sample:?}");
                assert_eq!(sample.wrong_sequence_pixels, 0, "{sample:?}");
            }
            let audited: Vec<_> = (0..3)
                .map(|k| state.read_target(&target, k).unwrap())
                .collect();
            ordinary_pipeline(&mut state, original);
            state.reset_target(&mut target).unwrap();
            state.add_samples(&mut target, 8).unwrap();
            for kind in 0..3 {
                assert_eq!(
                    audited[kind as usize],
                    state.read_target(&target, kind).unwrap(),
                    "instrumented backend {backend}, AOV {kind}"
                );
            }
        }
    }

    fn record(count: u32, sequence: u32, hit: u32) -> (Vec<u8>, Vec<u8>) {
        (
            [count, sequence, hit, hit]
                .into_iter()
                .flat_map(u32::to_le_bytes)
                .collect(),
            [0., 0., 0., count as f32]
                .into_iter()
                .flat_map(f32::to_le_bytes)
                .collect(),
        )
    }
    #[test]
    fn history_distinguishes_misses_omissions_and_their_later_sequence_shift() {
        let data: Vec<_> = [
            record(3, 2, 1).0,
            record(1, 0, 1).0,
            record(2, 1, 0).0,
            record(0, 0, 0).0,
            record(3, 2, 1).0,
        ]
        .into_iter()
        .flatten()
        .collect();
        let history = summarize_history(&data, 1, 4).unwrap();
        assert_eq!(history[0].primary_hits, 1);
        assert_eq!(history[1].primary_hits, 0);
        assert_eq!(history[1].unwritten_pixels, 0);
        assert_eq!(history[1].wrong_sequence_pixels, 0);
        assert_eq!(history[2].unwritten_pixels, 1);
        assert_eq!(history[3].primary_hits, 1);
        assert_eq!(history[3].wrong_sequence_pixels, 1);
        assert!(summarize_history(&data[..64], 1, 4).is_err());
    }

    #[test]
    fn ordinary_accumulator_requires_finite_integral_counts() {
        let (_, normal) = record(1, 0, 1);
        assert_eq!(classify_accumulation(&normal, 0)["shortPixels"], 0);
        assert_eq!(classify_accumulation(&normal, 1)["shortPixels"], 1);
        for count in [f32::NAN, f32::INFINITY, -1., 0.5, 3.] {
            let mut data = normal.clone();
            data[12..16].copy_from_slice(&count.to_le_bytes());
            assert_eq!(classify_accumulation(&data, 1)["invalidPixels"], 1);
        }
    }

    #[test]
    fn independent_counts_and_same_sample_hits_bound_retry_evidence() {
        let (d, n) = record(1, 0, 1);
        let good = classify(&d, &n, 0).unwrap();
        let (d, n) = record(0, 0, 0);
        let omitted = classify(&d, &n, 0).unwrap();
        assert!(evidence(&omitted, None).is_some());
        let (d, n) = record(1, 0, 0);
        let miss = classify(&d, &n, 0).unwrap();
        assert!(evidence(&miss, Some(&good)).is_some());
        assert!(evidence(&miss, Some(&miss)).is_none());
        assert!(evidence(&good, None).is_none());
        let (_, bad_normal) = record(0, 0, 0);
        let corrupt = classify(&d, &bad_normal, 0).unwrap();
        assert!(corrupt.invalid_pixels > 0);
        assert!(evidence(&corrupt, Some(&good)).is_none());
        let later = Sample {
            sample: 1,
            ..good.clone()
        };
        assert!(evidence(&miss, Some(&later)).is_none());
        assert!(classify(&d, &[], 0).is_err());
    }
}
