// Test-only observer: record actual encoding sites, never decide pass order.
thread_local! {
    static ORDER: std::cell::RefCell<Vec<String>> = const { std::cell::RefCell::new(Vec::new()) };
}
pub(crate) fn record_order(node: &str) {
    ORDER.with(|v| v.borrow_mut().push(node.into()));
}
pub(crate) fn take_order() -> Vec<String> {
    ORDER.with(|v| std::mem::take(&mut *v.borrow_mut()))
}

#[test]
#[ignore = "real GPU display parity matrix"]
fn display_parity_matrix() {
    let gpu = GpuDevice::with_backend(0).unwrap();
    let table: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../tests/fixtures/display-order.json"
    ))
    .unwrap();
    let mut records = Vec::new();
    for row in table["cases"].as_array().unwrap() {
        let pixels: Vec<[f64; 4]> = (0..256u32)
            .map(|i| {
                let v = if i % 16 < 8 { 2. } else { 6. };
                let n = (i.wrapping_mul(1664525).wrapping_add(19) % 13) as f64 * 0.002;
                [v + n, v * 0.5 + n, v * 0.25 + n, 1.]
            })
            .collect();
        let catcher = row["catcher"].as_bool().unwrap_or(false);
        let pixels: Vec<[f64; 4]> = pixels
            .iter()
            .map(|p| {
                if catcher {
                    [p[0] * 0.5, p[1] * 0.5, p[2] * 0.5, 0.5]
                } else {
                    *p
                }
            })
            .collect();
        let mut display = snapshot(&gpu, [16, 16], 32, &pixels);
        if catcher {
            put(&gpu, &display.albedo, &[9.6, 12.8, 16., 16.].repeat(256));
            display.metadata.has_catcher = true;
        }
        let shadow = gpu.device.create_buffer(&wgpu::BufferDescriptor {
            label: None,
            size: 256 * 48,
            usage: wgpu::BufferUsages::STORAGE
                | wgpu::BufferUsages::COPY_DST
                | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        });
        let moments: Vec<f32> = (0..256usize)
            .flat_map(|i| {
                let p = pixels[(15 - i / 16) * 16 + i % 16];
                let l = (p[0] * 0.2126 + p[1] * 0.7152 + p[2] * 0.0722) as f32;
                [
                    if catcher { 16. } else { 0. },
                    0.,
                    0.,
                    0.,
                    0.,
                    0.,
                    0.,
                    0.,
                    l * 32.,
                    (l * l + 10.) * 32.,
                    if catcher { 8. } else { 0. },
                    if catcher { 16. } else { 0. },
                ]
            })
            .collect();
        put(&gpu, &shadow, &moments);
        display.shadow = Some(shadow);
        if row["filter"] == "jnlm" {
            display.set_jnlm(Some(jnlm::Options {
                strength: 3.,
                ..Default::default()
            }));
        }
        let settings = Settings {
            tone_mapping: row["tone"].as_u64().unwrap_or(0) as u32,
            exposure: row["exposure"].as_f64().unwrap_or(1.) as f32,
            output: row["output"].as_u64().unwrap() as u32,
            bloom_intensity: if row["bloom"].as_bool().unwrap() {
                0.2
            } else {
                0.
            },
            ..Default::default()
        };
        if row["filter"] == "scene" {
            let filtered: Vec<f32> = (0..256usize)
                .flat_map(|i| {
                    let p = pixels[(15 - i / 16) * 16 + i % 16];
                    [
                        p[0] as f32 * 0.5,
                        p[1] as f32 * 0.5,
                        p[2] as f32 * 0.5,
                        p[3] as f32,
                    ]
                })
                .collect();
            display.upload(&filtered).unwrap();
        }
        take_order();
        let hdr = row["hdr"].as_bool().unwrap();
        let bytes = if hdr {
            read_half(&gpu, &display.compose_hdr(&settings))
                .iter()
                .flatten()
                .flat_map(|v| (*v as f32).to_le_bytes())
                .collect::<Vec<_>>()
        } else {
            display.compose_inner(&settings, false);
            display.read_texture().unwrap()
        };
        let trace = take_order();
        records.push(serde_json::json!({"name":row["name"],"trace":trace}));
        if let Some(root) = std::env::var_os("MUTRACER_PARITY_OUTPUT") {
            std::fs::create_dir_all(&root).unwrap();
            std::fs::write(
                std::path::Path::new(&root).join(format!(
                    "native-{}.{}",
                    row["name"].as_str().unwrap(),
                    if hdr { "f32" } else { "rgba8" }
                )),
                bytes,
            )
            .unwrap();
        }
        if std::env::var_os("MUTRACER_PARITY_BASELINE").is_none() {
            assert_eq!(serde_json::json!(trace), row["trace"], "{}", row["name"]);
        }
    }
    if let Some(root) = std::env::var_os("MUTRACER_PARITY_OUTPUT") {
        std::fs::write(
            std::path::Path::new(&root).join("native-trace.json"),
            serde_json::to_vec_pretty(&records).unwrap(),
        )
        .unwrap();
    }
}

#[test]
#[ignore = "real GPU retained filter invalidation"]
fn display_parity_filter_option_invalidation() {
    let gpu = GpuDevice::with_backend(0).unwrap();
    let mut display = snapshot(&gpu, [8, 8], 32, &[[0.4, 0.2, 0.1, 1.]; 64]);
    display.set_jnlm(Some(jnlm::Options::default()));
    // A retained filter must be dropped on shape/strength changes and disabling.
    *display.jnlm.lock().unwrap() = Some(jnlm::Jnlm::new(&gpu, [8, 8], jnlm::Options::default()));
    display.set_jnlm(Some(jnlm::Options {
        strength: 2.,
        ..Default::default()
    }));
    assert!(display.jnlm.lock().unwrap().is_none());
    *display.jnlm.lock().unwrap() = Some(jnlm::Jnlm::new(
        &gpu,
        [8, 8],
        jnlm::Options {
            strength: 2.,
            ..Default::default()
        },
    ));
    display.set_jnlm(None);
    assert!(display.jnlm.lock().unwrap().is_none());
}

#[test]
#[ignore = "real GPU scene denoise catcher correction"]
fn display_parity_scene_denoise_corrects_catcher_layers() {
    let gpu = GpuDevice::with_backend(0).unwrap();
    let mut display = snapshot(&gpu, [8, 8], 32, &[[0.4, 0.2, 0.1, 0.5]; 64]);
    let shadow = gpu.device.create_buffer(&wgpu::BufferDescriptor {
        label: None,
        size: 64 * 48,
        usage: wgpu::BufferUsages::STORAGE
            | wgpu::BufferUsages::COPY_DST
            | wgpu::BufferUsages::COPY_SRC,
        mapped_at_creation: false,
    });
    put(
        &gpu,
        &shadow,
        &[16., 0., 0., 8., 0., 0., 0., 0., 0., 0., 0., 0.].repeat(64),
    );
    display.shadow = Some(shadow);
    display.metadata.has_catcher = true;
    let settings = Settings {
        tone_mapping: 4,
        ..Default::default()
    };
    display.upload(&[0.2, 0.1, 0.05, 0.5].repeat(64)).unwrap();
    let filtered = display.read_rgba(&settings).unwrap();
    take_order();
    display.compose_inner(&settings, false);
    assert!(take_order().contains(&"CorrectLayers:SceneLinear".into()));
    display.original();
    put(&gpu, &display.linear, &[6.4, 3.2, 1.6, 16.].repeat(64));
    put(&gpu, &display.raw, &[6.4, 3.2, 1.6, 16.].repeat(64));
    let equivalent = display.read_rgba(&settings).unwrap();
    assert_eq!(
        filtered, equivalent,
        "Denoised foreground must compose like the same corrected raw layer"
    );
}

#[test]
#[ignore = "real GPU HDR retained display-linear result"]
fn display_parity_hdr_retains_completed_display_linear_result() {
    let gpu = GpuDevice::with_backend(0).unwrap();
    let mut display = snapshot(&gpu, [8, 8], 32, &[[6., 3., 1.5, 0.6]; 64]);
    let filtered = gpu.device.create_buffer(&wgpu::BufferDescriptor {
        label: None,
        size: 64 * 16,
        usage: wgpu::BufferUsages::STORAGE
            | wgpu::BufferUsages::COPY_SRC
            | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    put(&gpu, &filtered, &[0.25, 0.125, 0.0625, 0.6].repeat(64));
    let settings = Settings::default();
    display.upload_display_oidn(&filtered, settings).unwrap();
    let hdr = read_half(&gpu, &display.compose_hdr(&settings));
    for p in hdr {
        for (a, b) in p.into_iter().zip([0.25, 0.125, 0.0625, 0.6]) {
            assert!((a - b).abs() < 0.001, "{a} != {b}");
        }
    }
}
