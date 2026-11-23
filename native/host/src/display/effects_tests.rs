use super::*;
fn put(gpu: &GpuDevice, buffer: &wgpu::Buffer, values: &[f32]) {
    gpu.queue.write_buffer(
        buffer,
        0,
        &values
            .iter()
            .flat_map(|v| v.to_le_bytes())
            .collect::<Vec<_>>(),
    );
}
fn snapshot(gpu: &GpuDevice, size: [u32; 2], samples: u32, pixels: &[[f64; 4]]) -> Display {
    let mut display = Display::new(gpu.clone(), size);
    update(&mut display, samples, pixels);
    display
}
fn update(display: &mut Display, samples: u32, pixels: &[[f64; 4]]) {
    let [w, h] = display.size;
    let values: Vec<f32> = (0..h)
        .flat_map(|y| {
            (0..w).flat_map(move |x| {
                pixels[((h - 1 - y) * w + x) as usize].map(|v| v as f32 * samples as f32)
            })
        })
        .collect();
    put(&display.gpu, &display.raw, &values);
    put(&display.gpu, &display.linear, &values);
    let normal = [0., 0., samples as f32, samples as f32].repeat((w * h) as usize);
    let albedo = [
        0.3 * samples as f32,
        0.4 * samples as f32,
        0.5 * samples as f32,
        samples as f32,
    ]
    .repeat((w * h) as usize);
    put(&display.gpu, &display.normal, &normal);
    put(&display.gpu, &display.albedo, &albedo);
    display.samples = samples;
    display.original_samples = samples;
    display.image_revision += 1;
}
fn srgb(x: f64) -> f64 {
    if x <= 0.0031308 {
        x * 12.92
    } else {
        1.055 * x.powf(1. / 2.4) - 0.055
    }
}
fn close(bytes: &[u8], expected: [f64; 4]) {
    for p in bytes.chunks_exact(4) {
        for (v, e) in p.iter().zip(expected) {
            assert!(
                (*v as f64 - e.clamp(0., 1.) * 255.).abs() <= 1.1,
                "{p:?} != {expected:?}"
            );
        }
    }
}
#[test]
#[ignore = "requires a real GPU; run npm run native:ci:gpu"]
fn display_effects_vignette_and_disjoint_catcher_layers_match_reference() {
    let gpu = GpuDevice::with_backend(0).unwrap();
    let size = [8, 6];
    let count = (size[0] * size[1]) as usize;
    let mut display = snapshot(&gpu, size, 32, &[[0.4, 0.2, 0.1, 1.]; 48]);
    let mut settings = Settings {
        tone_mapping: 4,
        vignette: 0.8,
        ..Default::default()
    };
    let rgba = display.read_rgba(&settings).unwrap();
    for y in 0..size[1] {
        for x in 0..size[0] {
            let distance = ((x as f64 / size[0] as f64 - 0.5).powi(2)
                + (y as f64 / size[1] as f64 - 0.5).powi(2))
            .sqrt();
            let t = ((distance - 0.2) / (0.72 - 0.2)).clamp(0., 1.);
            let weight = 1. - 0.8 * t * t * (3. - 2. * t);
            let at = ((y * size[0] + x) * 4) as usize;
            close(
                &rgba[at..at + 4],
                [
                    srgb(0.4 * weight),
                    srgb(0.2 * weight),
                    srgb(0.1 * weight),
                    1.,
                ],
            );
        }
    }
    settings.output = 1;
    let normal = display.read_rgba(&settings).unwrap();
    settings.vignette = 0.;
    assert_eq!(display.read_rgba(&settings).unwrap(), normal);
    settings.output = 0;
    let geometry = [0.4, 0.2, 0.1];
    let backdrop = [0.18, 0.4, 0.7];
    let color = [0.1, 0.05, 0.02];
    // Same primary-sample classes as tests/gpu/shadowCatcherLayers.ts. Native
    // keeps its established sRGB transfer, used by this independent analytic sum.
    for opaque in [false, true] {
        for (f, c, shadow, alpha) in [
            (0., 0., 0., 1.),
            (0.5, 0., 0., 1.),
            (0., 0.5, 0.75, 1.),
            (0.25, 0.25, 0.75, 1.),
            (1. / 32., 1. / 32., 0.5, 1.),
            (0.5, 0.5, 0.75, 1.),
            (0.25, 0.25, 0.75, 0.5),
        ] {
            let m = 1. - f - c;
            let bg = if opaque { c + m } else { 0. };
            let raw = [
                32. * (f * geometry[0] + bg * backdrop[0]),
                32. * (f * geometry[1] + bg * backdrop[1]),
                32. * (f * geometry[2] + bg * backdrop[2]),
                32. * (f * alpha + bg),
            ];
            put(&gpu, &display.raw, &raw.repeat(count));
            put(&gpu, &display.linear, &raw.repeat(count));
            put(
                &gpu,
                &display.albedo,
                &[0., 0., 0., 32. * (f + if opaque { c } else { 0. })].repeat(count),
            );
            let shadow_values = [
                32. * c,
                32. * bg,
                if opaque { 32. * c } else { 0. },
                0.,
                32. * bg * backdrop[0],
                32. * bg * backdrop[1],
                32. * bg * backdrop[2],
                32. * bg,
                0.,
                0.,
                32. * c * shadow,
                32. * c,
            ];
            let buffer = gpu.device.create_buffer(&wgpu::BufferDescriptor {
                label: None,
                size: (count * 48) as u64,
                usage: wgpu::BufferUsages::STORAGE
                    | wgpu::BufferUsages::COPY_DST
                    | wgpu::BufferUsages::COPY_SRC,
                mapped_at_creation: false,
            });
            put(&gpu, &buffer, &shadow_values.repeat(count));
            display.shadow = Some(buffer);
            display.metadata = Metadata {
                has_catcher: true,
                flat_background: if opaque {
                    [backdrop[0], backdrop[1], backdrop[2], 1.]
                } else {
                    [0.; 4]
                },
            };
            for opacity in [0., 0.5, 1.] {
                settings.shadow_catcher_color = color;
                settings.shadow_catcher_alpha = opacity;
                let shadow = (shadow - (1. - opacity)).max(0.) as f64;
                let visible = if opaque {
                    m as f64 + c as f64 * (1. - shadow)
                } else {
                    0.
                };
                let sa = c as f64 * shadow;
                let a = f as f64 * alpha as f64 + visible + sa;
                let expected = std::array::from_fn(|ch| {
                    if ch == 3 {
                        a
                    } else {
                        (srgb(geometry[ch] as f64) * f as f64 * alpha as f64
                            + srgb(backdrop[ch] as f64) * visible
                            + color[ch] as f64 * sa)
                            / a.max(0.000001)
                    }
                });
                close(&display.read_rgba(&settings).unwrap(), expected);
            }
            settings.output = 4;
            close(
                &display.read_rgba(&settings).unwrap(),
                [
                    c as f64,
                    bg as f64,
                    if opaque { c as f64 } else { 0. },
                    (c * shadow) as f64,
                ],
            );
            settings.output = 0;
        }
    }
    // A filtered HDR changes each layer's color without filtering its coverage
    // or shadow. An opaque flat backdrop keeps its declared display color.
    let filtered = [
        2. * (0.25 * geometry[0] + 0.75 * backdrop[0]),
        2. * (0.25 * geometry[1] + 0.75 * backdrop[1]),
        2. * (0.25 * geometry[2] + 0.75 * backdrop[2]),
        0.875,
    ]
    .repeat(count);
    display.upload(&filtered).unwrap();
    let expected = std::array::from_fn(|ch| {
        if ch == 3 {
            0.875
        } else {
            (srgb(2. * geometry[ch] as f64) * 0.125
                + srgb(backdrop[ch] as f64) * 0.5625
                + color[ch] as f64 * 0.1875)
                / 0.875
        }
    });
    close(&display.read_rgba(&settings).unwrap(), expected);
}
#[derive(Clone)]
struct Image {
    w: usize,
    h: usize,
    p: Vec<[f64; 4]>,
}
impl Image {
    fn load(&self, x: isize, y: isize) -> [f64; 4] {
        self.p[y.clamp(0, self.h as isize - 1) as usize * self.w
            + x.clamp(0, self.w as isize - 1) as usize]
    }
    fn sample(&self, u: f64, v: f64) -> [f64; 4] {
        let x = u * self.w as f64 - 0.5;
        let y = v * self.h as f64 - 0.5;
        let i = x.floor() as isize;
        let j = y.floor() as isize;
        let fx = x - x.floor();
        let fy = y - y.floor();
        std::array::from_fn(|c| {
            (self.load(i, j)[c] * (1. - fx) + self.load(i + 1, j)[c] * fx) * (1. - fy)
                + (self.load(i, j + 1)[c] * (1. - fx) + self.load(i + 1, j + 1)[c] * fx) * fy
        })
    }
    fn map(w: usize, h: usize, f: impl Fn(usize, usize) -> [f64; 4]) -> Self {
        Self {
            w,
            h,
            p: (0..h)
                .flat_map(|y| (0..w).map(move |x| (x, y)))
                .map(|(x, y)| f(x, y))
                .collect(),
        }
    }
}
fn reference_bloom(input: &Image, threshold: f64, radius: f64) -> Image {
    let med = |a: [f64; 4], b: [f64; 4], c: [f64; 4]| {
        std::array::from_fn(|i| {
            a[i] + b[i] + c[i] - a[i].min(b[i]).min(c[i]) - a[i].max(b[i]).max(c[i])
        })
    };
    let bright = Image::map(input.w, input.h, |x, y| {
        let (x, y) = (x as isize, y as isize);
        let v = med(
            med(input.load(x, y), input.load(x - 1, y), input.load(x + 1, y)),
            input.load(x, y - 1),
            input.load(x, y + 1),
        );
        let lit = v[0] * 0.2125 + v[1] * 0.7154 + v[2] * 0.0721 > threshold && v[3] > 0.;
        [
            if lit { v[0] } else { 0. },
            if lit { v[1] } else { 0. },
            if lit { v[2] } else { 0. },
            v[3],
        ]
    });
    let mut down = Vec::new();
    for i in 0..6 {
        let src = down.last().unwrap_or(&bright);
        let (w, h) = ((input.w >> (i + 1)).max(1), (input.h >> (i + 1)).max(1));
        down.push(Image::map(w, h, |x, y| {
            let (u, v) = ((x as f64 + 0.5) / w as f64, (y as f64 + 0.5) / h as f64);
            let taps = [
                src.sample(u - 1. / src.w as f64, v - 1. / src.h as f64),
                src.sample(u + 1. / src.w as f64, v - 1. / src.h as f64),
                src.sample(u - 1. / src.w as f64, v + 1. / src.h as f64),
                src.sample(u + 1. / src.w as f64, v + 1. / src.h as f64),
            ];
            std::array::from_fn(|c| taps.iter().map(|p| p[c]).sum::<f64>() / 4.)
        }));
    }
    let blur = |src: &Image, w: usize, h: usize, dir: [f64; 2]| {
        Image::map(w, h, |x, y| {
            let (u, v) = ((x as f64 + 0.5) / w as f64, (y as f64 + 0.5) / h as f64);
            let mut p = [0.; 4];
            for (i, weight) in [0.07, 0.09, 0.12, 0.14, 0.16, 0.14, 0.12, 0.09, 0.07]
                .iter()
                .enumerate()
            {
                let d = (i as f64 - 4.) * (radius * 2.).clamp(0.2, 1.);
                let s = src.sample(u + dir[0] * d / src.w as f64, v + dir[1] * d / src.h as f64);
                for c in 0..4 {
                    p[c] += s[c] * weight;
                }
            }
            p
        })
    };
    let levels: Vec<_> = (0..6)
        .map(|i| {
            let h = blur(&down[i], down[i].w, down[i].h, [1., 0.]);
            blur(&h, (input.w >> i).max(1), (input.h >> i).max(1), [0., 1.])
        })
        .collect();
    let mut result = levels[5].clone();
    let weight = 1. - (radius.powf(0.3) * 0.8).clamp(0., 0.8);
    for i in (0..5).rev() {
        let src = &levels[i];
        result = Image::map(src.w, src.h, |x, y| {
            let u = (x as f64 + 0.5) / src.w as f64;
            let v = (y as f64 + 0.5) / src.h as f64;
            let a = result.sample(u, v);
            let b = src.sample(u, v);
            std::array::from_fn(|c| a[c] * (1. - weight) + b[c] * weight)
        });
    }
    result
}
fn read_half(gpu: &GpuDevice, texture: &wgpu::Texture) -> Vec<[f64; 4]> {
    let mapped = crate::test_support::read_texture(gpu, texture);
    let half = |b: &[u8]| {
        let n = u16::from_le_bytes(b.try_into().unwrap());
        let e = (n >> 10) & 31;
        let f = (n & 1023) as f64;
        let v = if e == 0 {
            f * 2f64.powi(-24)
        } else {
            (1. + f / 1024.) * 2f64.powi(e as i32 - 15)
        };
        if n & 0x8000 == 0 { v } else { -v }
    };
    let pixels: Vec<[f64; 4]> = mapped
        .chunks_exact(8)
        .map(|p| std::array::from_fn(|c| half(&p[c * 2..c * 2 + 2])))
        .collect();
    if let Ok(dir) = std::env::var("MUTRACER_EFFECTS_SNAPSHOT") {
        static INDEX: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let index = INDEX.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            std::path::Path::new(&dir).join(format!("bloom-{index}.json")),
            serde_json::to_vec(&pixels).unwrap(),
        )
        .unwrap();
    }
    pixels
}
#[test]
#[ignore = "requires a real GPU; run npm run native:ci:gpu"]
fn display_effects_bloom_matches_reference_pyramid_and_refresh_policy() {
    let gpu = GpuDevice::with_backend(0).unwrap();
    let size = [73, 51];
    let input = Image::map(size[0], size[1], |x, y| {
        if x < 5 && y < 5 {
            [200., 100., 50., 0.]
        } else if (x > 22 && x < 45 && y > 17 && y < 32) || (x == 60 && y == 10) {
            [12., 7., 3., 1.]
        } else {
            [0.05, 0.1, 0.2, 0.]
        }
    });
    let mut display = snapshot(&gpu, [size[0] as u32, size[1] as u32], 9, &input.p);
    let mut settings = Settings {
        bloom_intensity: 0.4,
        bloom_threshold: 1.25,
        ..Default::default()
    };
    display.compose_with(&settings);
    assert!(
        display
            .effects
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .bloom_output()
            .is_none()
    );
    for radius in [0., 0.6, 1.] {
        settings.bloom_radius = radius;
        update(&mut display, 10, &input.p);
        display.compose_with(&settings);
        let effect = display.effects.lock().unwrap();
        let (texture, _) = effect.as_ref().unwrap().bloom_output().unwrap();
        let got = read_half(&gpu, texture);
        let reference = reference_bloom(&input, settings.bloom_threshold as f64, radius as f64);
        let max = got
            .iter()
            .zip(reference.p)
            .flat_map(|(a, b)| a.iter().zip(b).map(|(a, b)| (a - b).abs()))
            .fold(0., f64::max);
        assert!(max < 0.025, "bloom radius {radius}: max error {max}");
    }
    settings.tone_mapping = 4;
    let composed = display.read_rgba(&settings).unwrap();
    let bloom = reference_bloom(
        &input,
        settings.bloom_threshold as f64,
        settings.bloom_radius as f64,
    );
    for (i, pixel) in composed.chunks_exact(4).enumerate() {
        let b = bloom.p[i].map(|v| v * settings.bloom_intensity as f64);
        let alpha = input.p[i][3].max((b[0] * 0.2125 + b[1] * 0.7154 + b[2] * 0.0721).min(1.));
        // Half-float pyramid rounding permits two quantization levels here.
        let expected = [
            srgb(input.p[i][0] + b[0]),
            srgb(input.p[i][1] + b[1]),
            srgb(input.p[i][2] + b[2]),
            alpha,
        ];
        for (actual, expected) in pixel.iter().zip(expected) {
            assert!((*actual as f64 - expected.clamp(0., 1.) * 255.).abs() <= 2.1);
        }
    }
    let runs = display
        .effects
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .bloom_output()
        .unwrap()
        .1;
    update(&mut display, 11, &input.p);
    display.compose_with(&settings);
    settings.exposure = 2.;
    display.compose_with(&settings);
    assert_eq!(
        display
            .effects
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .bloom_output()
            .unwrap()
            .1,
        runs
    );
    update(&mut display, 20, &input.p);
    display.compose_with(&settings);
    assert_eq!(
        display
            .effects
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .bloom_output()
            .unwrap()
            .1,
        runs + 1
    );
    settings.bloom_threshold = 2.;
    display.compose_with(&settings);
    assert_eq!(
        display
            .effects
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .bloom_output()
            .unwrap()
            .1,
        runs + 2
    );
    display.original();
    display.compose_with(&settings);
    assert_eq!(
        display
            .effects
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .bloom_output()
            .unwrap()
            .1,
        runs + 3
    );
}

#[test]
#[ignore = "requires a real GPU; run npm run native:ci:gpu"]
fn hdr_display_preserves_extended_radiance_grading_bloom_and_coverage() {
    let gpu = GpuDevice::with_backend(0).unwrap();
    let mut display = snapshot(&gpu, [8, 6], 32, &[[4., 0.5, 0.25, 0.5]; 48]);
    let mut settings = Settings {
        exposure: 2.,
        ..Default::default()
    };
    let sdr = display.read_rgba(&settings).unwrap();
    let hdr = display.compose_hdr(&settings);
    for pixel in read_half(&gpu, &hdr) {
        for (v, e) in pixel.into_iter().zip([8., 1., 0.5, 0.5]) {
            assert!((v - e).abs() < 0.01, "{v} != {e}");
        }
    }
    assert_eq!(display.read_rgba(&settings).unwrap(), sdr);
    settings.contrast = 0.5;
    settings.vignette = 0.8;
    let hdr = display.compose_hdr(&settings);
    for (i, p) in read_half(&gpu, &hdr).into_iter().enumerate() {
        let (x, y) = ((i % 8) as f64, (i / 8) as f64);
        let t =
            ((((x / 8. - 0.5).powi(2) + (y / 6. - 0.5).powi(2)).sqrt() - 0.2) / 0.52).clamp(0., 1.);
        let w = 1. - 0.8 * t * t * (3. - 2. * t);
        for (v, e) in p[..3]
            .iter()
            .zip([8., 1., 0.5].map(|v| ((v - 0.18) * 0.5 + 0.18) * w))
        {
            assert!((v - e).abs() < 0.01, "{v} != {e}");
        }
        assert_eq!(p[3], 0.5);
    }
    settings = Settings {
        exposure: 2.,
        bloom_intensity: 0.5,
        bloom_threshold: 1.,
        ..Default::default()
    };
    let hdr = display.compose_hdr(&settings);
    // Constant bright input remains constant through all bloom levels.
    for pixel in read_half(&gpu, &hdr) {
        for (v, e) in
            pixel
                .into_iter()
                .zip([12., 1.5, 0.75, 2. * 0.2125 + 0.25 * 0.7154 + 0.125 * 0.0721])
        {
            assert!((v - e).abs() < 0.02, "{v} != {e}");
        }
    }
    // Denoised values are used in HDR too, without replacing the raw samples.
    display
        .upload(&[2f32, 0.25, 0.125, 0.5].repeat(48))
        .unwrap();
    settings.bloom_intensity = 0.;
    let hdr = display.compose_hdr(&settings);
    for p in read_half(&gpu, &hdr) {
        assert!((p[0] - 4.).abs() < 0.01);
        assert_eq!(p[3], 0.5);
    }
    display.original();
    put(&gpu, &display.raw, &[32., 4., 2., 8.].repeat(48));
    put(&gpu, &display.linear, &[32., 4., 2., 8.].repeat(48));
    put(&gpu, &display.albedo, &[0., 0., 0., 8.].repeat(48));
    display.shadow = Some(gpu.device.create_buffer(&wgpu::BufferDescriptor {
        label: None,
        size: 48 * 48,
        usage: wgpu::BufferUsages::STORAGE
            | wgpu::BufferUsages::COPY_DST
            | wgpu::BufferUsages::COPY_SRC,
        mapped_at_creation: false,
    }));
    put(
        &gpu,
        display.shadow.as_ref().unwrap(),
        &[8., 0., 0., 6., 0., 0., 0., 0., 0., 0., 0., 0.].repeat(48),
    );
    display.metadata = Metadata {
        has_catcher: true,
        flat_background: [0.; 4],
    };
    let decode = |v: f64| {
        if v <= 0.04045 {
            v / 12.92
        } else {
            ((v + 0.055) / 1.055).powf(2.4)
        }
    };
    let hdr = display.compose_hdr(&settings);
    for p in read_half(&gpu, &hdr) {
        for (v, e) in p[..3]
            .iter()
            .zip([8., 1., 0.5].map(|v| decode(srgb(v) * 0.25 / 0.4375)))
        {
            assert!((v - e).abs() < 0.02, "{v} != {e}");
        }
        assert_eq!(p[3], 0.4375);
    }
    settings.output = 1;
    let hdr = display.compose_hdr(&settings);
    for p in read_half(&gpu, &hdr) {
        assert!((p[0] - 0.5).abs() < 0.001);
        assert_eq!(p[2], 1.);
    }
}

#[test]
#[ignore = "requires a real GPU; run npm run native:ci:gpu"]
fn retained_denoising_freezes_composition_inputs_but_not_raw_capture() {
    let gpu = GpuDevice::with_backend(0).unwrap();
    let count = 48;
    for catcher in [false, true] {
        let mut source = snapshot(&gpu, [8, 6], 5, &[[0.6, 0.2, 0.1, 0.5]; 48]);
        let guide = || {
            gpu.device.create_buffer(&wgpu::BufferDescriptor {
                label: None,
                size: (count * 16) as u64,
                usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::COPY_SRC,
                mapped_at_creation: false,
            })
        };
        let normal = guide();
        let albedo = guide();
        put(&gpu, &normal, &[0., 0., 5., 5.].repeat(count));
        put(&gpu, &albedo, &[1., 1., 1., 2.5].repeat(count));
        let shadow = gpu.device.create_buffer(&wgpu::BufferDescriptor {
            label: None,
            size: (count * 48) as u64,
            usage: wgpu::BufferUsages::STORAGE
                | wgpu::BufferUsages::COPY_DST
                | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        });
        put(
            &gpu,
            &shadow,
            &[2.5, 0., 0., 1.25, 0.5, 0.25, 0.125, 2.5, 0., 0., 0., 0.].repeat(count),
        );
        let metadata = Metadata {
            has_catcher: catcher,
            flat_background: [0.1, 0.2, 0.3, 1.],
        };
        let mut display = Display::new(gpu.clone(), [8, 6]);
        display.capture(&source.raw, &normal, &albedo, &shadow, metadata, 5);
        display
            .upload(&[0.5, 0.25, 0.125, 0.5].repeat(count))
            .unwrap();
        let settings: Vec<_> = [0., 0.4]
            .into_iter()
            .flat_map(|bloom| {
                [0, 3].into_iter().map(move |output| Settings {
                    bloom_intensity: bloom,
                    output,
                    ..Default::default()
                })
            })
            .collect();
        let before: Vec<_> = settings
            .iter()
            .map(|s| {
                let straight = display.compose_straight(s);
                (
                    display.read_rgba(s).unwrap(),
                    display.read_image(&straight).unwrap(),
                    read_half(&gpu, &display.compose_hdr(s)),
                )
            })
            .collect();
        // Cross the bloom threshold while changing coverage, normals, colors,
        // catcher layers and background. None belongs to the retained result.
        update(&mut source, 10, &[[0.1, 0.8, 0.4, 1.]; 48]);
        put(&gpu, &normal, &[0., 10., 0., 10.].repeat(count));
        put(&gpu, &albedo, &[3., 4., 5., 10.].repeat(count));
        put(&gpu, &shadow, &[0.; 12].repeat(count));
        display.capture(
            &source.raw,
            &normal,
            &albedo,
            &shadow,
            Metadata::default(),
            10,
        );
        assert!(display.show_denoised());
        for (s, expected) in settings.iter().zip(&before) {
            let straight = display.compose_straight(s);
            assert_eq!(display.read_rgba(s).unwrap(), expected.0);
            assert_eq!(display.read_image(&straight).unwrap(), expected.1);
            assert_eq!(read_half(&gpu, &display.compose_hdr(s)), expected.2);
        }
        assert_eq!(display.uploads, 1);
        // Raw HDR input keeps advancing while the denoised image is shown.
        let raw = crate::read_average(&gpu.device, &gpu.queue, &display.raw, 8, 6, 10).unwrap();
        assert_eq!(
            raw,
            [0.1f32, 0.8, 0.4, 1.]
                .repeat(count)
                .iter()
                .flat_map(|v| v.to_le_bytes())
                .collect::<Vec<_>>()
        );
        let guides: Vec<_> = [1, 2, 4]
            .into_iter()
            .map(|output| {
                let s = Settings {
                    output,
                    ..Default::default()
                };
                (
                    s,
                    display.read_rgba(&s).unwrap(),
                    read_half(&gpu, &display.compose_hdr(&s)),
                )
            })
            .collect();
        display.original();
        for (s, rgba, hdr) in guides {
            assert_eq!(display.read_rgba(&s).unwrap(), rgba);
            assert_eq!(read_half(&gpu, &display.compose_hdr(&s)), hdr);
        }
        assert_ne!(display.read_rgba(&settings[0]).unwrap(), before[0].0);
    }
}

include!("parity_tests.rs");
