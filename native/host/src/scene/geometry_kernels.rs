//! The two O(N) kernels selected by the Phase 2 D4 profiling gate.
//! Scene decoding, material/instance assembly and all Web implementations stay TS.
use super::*;
use crate::layout::{geometry_kernel_entry as ke, geometry_kernel_header as kh};
unsafe extern "C" {
    fn mt_core_geometry_kernel_hypot(x: f64, y: f64, z: f64) -> f64;
}
// Descriptors may arrive through an unaligned C byte slice. Borrow aligned
// payloads and keep the same portable decoding fallback for other callers.
fn floats<'a>(w: &Words<'a>, offset: usize, count: usize) -> Cow<'a, [f32]> {
    let bytes = &w.0[offset * WORD_BYTES..(offset + count) * WORD_BYTES];
    bytemuck::try_cast_slice(bytes)
        .map(Cow::Borrowed)
        .unwrap_or_else(|_| Cow::Owned((0..count).map(|i| w.f(offset + i)).collect()))
}
fn indices<'a>(w: &Words<'a>, offset: usize, count: usize) -> Cow<'a, [u32]> {
    let bytes = &w.0[offset * WORD_BYTES..(offset + count) * WORD_BYTES];
    bytemuck::try_cast_slice(bytes)
        .map(Cow::Borrowed)
        .unwrap_or_else(|_| Cow::Owned((0..count).map(|i| w.u(offset + i) as u32).collect()))
}
fn bounds(positions: &[f32]) -> [f32; 6] {
    let mut result = [
        f32::INFINITY,
        f32::INFINITY,
        f32::INFINITY,
        f32::NEG_INFINITY,
        f32::NEG_INFINITY,
        f32::NEG_INFINITY,
    ];
    for p in positions.chunks_exact(3) {
        if !p.iter().all(|v| v.is_finite()) {
            continue;
        }
        for axis in 0..3 {
            let value = p[axis];
            if value < result[axis] || value == 0. && result[axis] == 0. && value.is_sign_negative()
            {
                result[axis] = value;
            }
            if value > result[axis + 3]
                || value == 0. && result[axis + 3] == 0. && value.is_sign_positive()
            {
                result[axis + 3] = value;
            }
        }
    }
    result
}
// Preserve the scalar reduction (including signed zero) within each geometry.
// Workers borrow only descriptor bytes and never enter the AOT runtime.
fn geometry_bounds(w: &Words<'_>, workers: usize) -> Vec<[f32; 6]> {
    let count = w.u(h::GEOMETRY_COUNT);
    let calculate = |i| {
        let off = w.u(h::GEOMETRY_OFFSET) + i * g::WORDS;
        bounds(&floats(
            w,
            w.u(off + g::POSITION),
            w.u(off + g::VERTEX_COUNT) * 3,
        ))
    };
    if workers <= 1 {
        return (0..count).map(calculate).collect();
    }
    use std::sync::{
        OnceLock,
        atomic::{AtomicUsize, Ordering},
    };
    let next = AtomicUsize::new(0);
    let results: Vec<_> = (0..count).map(|_| OnceLock::new()).collect();
    std::thread::scope(|scope| {
        for _ in 0..workers.min(count) {
            let (next, results, calculate) = (&next, &results, &calculate);
            scope.spawn(move || {
                loop {
                    let i = next.fetch_add(1, Ordering::Relaxed);
                    if i >= count {
                        break;
                    }
                    let _ = results[i].set(calculate(i));
                }
            });
        }
    });
    results
        .into_iter()
        .map(|r| r.into_inner().expect("Missing geometry bounds result"))
        .collect()
}
fn tangents(positions: &[f32], normals: &[f32], uvs: &[f32], indices: &[u32]) -> Vec<f32> {
    let mut accumulated = vec![0f32; positions.len()];
    for triangle in indices.chunks_exact(3) {
        let [a, b, c] = [
            triangle[0] as usize,
            triangle[1] as usize,
            triangle[2] as usize,
        ];
        let p = |vertex: usize, axis: usize| positions[vertex * 3 + axis] as f64;
        let uv = |vertex: usize, axis: usize| uvs[vertex * 2 + axis] as f64;
        let [x1, y1, z1] = [p(b, 0) - p(a, 0), p(b, 1) - p(a, 1), p(b, 2) - p(a, 2)];
        let [x2, y2, z2] = [p(c, 0) - p(a, 0), p(c, 1) - p(a, 1), p(c, 2) - p(a, 2)];
        let [s1, t1, s2, t2] = [
            uv(b, 0) - uv(a, 0),
            uv(b, 1) - uv(a, 1),
            uv(c, 0) - uv(a, 0),
            uv(c, 1) - uv(a, 1),
        ];
        let determinant = s1 * t2 - s2 * t1;
        if determinant.abs() < 1e-12 {
            continue;
        }
        let inverse = 1. / determinant;
        let tangent = [
            (x1 * t2 - x2 * t1) * inverse,
            (y1 * t2 - y2 * t1) * inverse,
            (z1 * t2 - z2 * t1) * inverse,
        ];
        for vertex in [a, b, c] {
            for axis in 0..3 {
                let index = vertex * 3 + axis;
                accumulated[index] = (accumulated[index] as f64 + tangent[axis]) as f32;
            }
        }
    }
    let mut result = vec![0f32; positions.len()];
    for vertex in 0..positions.len() / 3 {
        let base = vertex * 3;
        let [nx, ny, nz] = [
            normals[base] as f64,
            normals[base + 1] as f64,
            normals[base + 2] as f64,
        ];
        let projection = accumulated[base] as f64 * nx
            + accumulated[base + 1] as f64 * ny
            + accumulated[base + 2] as f64 * nz;
        let mut value = [
            accumulated[base] as f64 - nx * projection,
            accumulated[base + 1] as f64 - ny * projection,
            accumulated[base + 2] as f64 - nz * projection,
        ];
        // Reuse the compiled TS Math.hypot primitive rather than changing its
        // rounding or maintaining another approximation. Owner/ENTRY_LOCK holds;
        // this synchronous kernel runs between AOT steps, never inside one.
        let length = unsafe { mt_core_geometry_kernel_hypot(value[0], value[1], value[2]) };
        if length > 1e-8 {
            for axis in 0..3 {
                value[axis] /= length;
            }
        } else {
            value = [0.; 3];
        }
        for axis in 0..3 {
            result[base + axis] = value[axis] as f32;
        }
    }
    result
}
// Wire-side selection mirrors materialNeedsVertexTangents. The TS/Rust kernel
// contract tests compare complete prepared assets with and without these hints.
fn tangent_requirements(w: &Words<'_>) -> Vec<bool> {
    let materials: Vec<bool> = (0..w.u(h::MATERIAL_COUNT))
        .map(|i| {
            let off = w.u(h::MATERIAL_OFFSET) + i * mat::WORDS;
            let (mut base, mut coat, mut weight, mut coat_normal) =
                (0., 0., w.f(off + mat::COAT_WEIGHT), false);
            for j in 0..w.u(off + mat::EXTENSION_COUNT) {
                let property = w.u(off + mat::EXTENSION_OFFSET) + j * ext::WORDS;
                match w.u(property + ext::ID) {
                    9 => base = w.f(property + ext::X),
                    28 => coat = w.f(property + ext::X),
                    25 => weight = w.f(property + ext::X),
                    74 => coat_normal = w.u(property + ext::X) != u32::MAX as usize,
                    _ => (),
                }
            }
            base > 0. || coat > 0. || weight > 0. && coat_normal
        })
        .collect();
    let mut required = vec![false; w.u(h::GEOMETRY_COUNT)];
    for i in 0..w.u(h::MESH_COUNT) {
        let off = w.u(h::MESH_OFFSET) + i * m::WORDS;
        let count = w.u(off + m::MATERIAL_COUNT);
        let needs = if count == 0 {
            materials[w.u(off + m::MATERIAL)]
        } else {
            (0..count).any(|j| materials[w.u(w.u(off + m::MATERIAL_TABLE) + j)])
        };
        required[w.u(off + m::GEOMETRY)] |= needs;
    }
    required
}
pub(super) fn packet(bytes: &[u8], include_bounds: bool) -> Option<Vec<u8>> {
    let profile = std::env::var_os("MUTRACER_NATIVE_PROFILE").is_some_and(|v| v == "1");
    let (mut bounds_ms, mut tangents_ms, mut tangent_calls) = (0f64, 0f64, 0u32);
    let w = Words(bytes);
    let count = w.u(h::GEOMETRY_COUNT);
    let required = tangent_requirements(&w);
    let need_tangents = |i: usize| {
        let off = w.u(h::GEOMETRY_OFFSET) + i * g::WORDS;
        required[i]
            && w.u(off + g::NORMAL) != 0
            && w.u(off + g::UV) != 0
            && w.u(off + g::TANGENT) == 0
    };
    let any_tangents = (0..count).any(need_tangents);
    if !include_bounds && !any_tangents {
        return None;
    }
    let vertices = (0..count)
        .map(|i| w.u(w.u(h::GEOMETRY_OFFSET) + i * g::WORDS + g::VERTEX_COUNT))
        .sum();
    let bounds_workers = if include_bounds {
        geometry_validation::scan_workers(count, vertices)
    } else {
        0
    };
    let bounds_start = profile.then(Instant::now);
    let geometry_bounds = if include_bounds {
        geometry_bounds(&w, bounds_workers)
    } else {
        Vec::new()
    };
    if let Some(start) = bounds_start {
        bounds_ms = start.elapsed().as_secs_f64() * 1000.;
    }
    let header = kh::WORDS + count * ke::WORDS;
    let words = header
        + (0..count)
            .map(|i| {
                let off = w.u(h::GEOMETRY_OFFSET) + i * g::WORDS;
                let needs = need_tangents(i);
                usize::from(include_bounds) * 6
                    + if needs {
                        w.u(off + g::VERTEX_COUNT) * 3
                    } else {
                        0
                    }
            })
            .sum::<usize>();
    // Write the wire buffer once; do not retain a second scene-sized u32 packet.
    let mut result = Vec::<u8>::with_capacity(words * WORD_BYTES);
    result.resize(header * WORD_BYTES, 0);
    let write = |result: &mut Vec<u8>, at: usize, value: u32| {
        result[at * WORD_BYTES..(at + 1) * WORD_BYTES].copy_from_slice(&value.to_le_bytes());
    };
    write(
        &mut result,
        kh::VERSION,
        crate::layout::version::GEOMETRY_KERNELS as u32,
    );
    write(&mut result, kh::COUNT, count as u32);
    for i in 0..count {
        let off = w.u(h::GEOMETRY_OFFSET) + i * g::WORDS;
        let vertices = w.u(off + g::VERTEX_COUNT);
        let entry = kh::WORDS + i * ke::WORDS;
        write(&mut result, entry + ke::SOURCE, i as u32);
        write(&mut result, entry + ke::VERTEX_COUNT, vertices as u32);
        let need_tangents = need_tangents(i);
        if !include_bounds && !need_tangents {
            continue;
        }
        if include_bounds {
            let offset = (result.len() / WORD_BYTES) as u32;
            write(&mut result, entry + ke::BOUNDS, offset);
            result.extend_from_slice(bytemuck::cast_slice(&geometry_bounds[i]));
        }
        if need_tangents {
            let positions = floats(&w, w.u(off + g::POSITION), vertices * 3);
            let normals = floats(&w, w.u(off + g::NORMAL), vertices * 3);
            let uvs = floats(&w, w.u(off + g::UV), vertices * 2);
            let indices = indices(&w, w.u(off + g::INDICES), w.u(off + g::INDEX_COUNT));
            let offset = (result.len() / WORD_BYTES) as u32;
            write(&mut result, entry + ke::TANGENTS, offset);
            let start = profile.then(Instant::now);
            result.extend_from_slice(bytemuck::cast_slice(&tangents(
                &positions, &normals, &uvs, &indices,
            )));
            if let Some(start) = start {
                tangents_ms += start.elapsed().as_secs_f64() * 1000.;
            }
            tangent_calls += 1;
        }
    }
    if profile {
        native_log!(
            "{}",
            json!({"nativeGeometryKernelProfile":{"boundsMs":bounds_ms,"boundsWorkers":bounds_workers,"tangentsMs":tangents_ms,"tangentCalls":tangent_calls}})
        );
    }
    write(&mut result, kh::LENGTH, words as u32);
    Some(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parallel_bounds_preserve_order_signed_zero_and_unaligned_inputs() {
        let mut bytes = geometry_validation::tests::fixture(13, 131);
        let w = Words(&bytes);
        let positions: Vec<_> = (0..w.u(h::GEOMETRY_COUNT))
            .map(|i| w.u(w.u(h::GEOMETRY_OFFSET) + i * g::WORDS + g::POSITION))
            .collect();
        for (i, &at) in positions.iter().enumerate() {
            for vertex in 0..131 {
                for axis in 0..3 {
                    let value = if i == 0 {
                        if vertex % 2 == 0 { -0f32 } else { 0f32 }
                    } else if i == 1 {
                        f32::NAN
                    } else {
                        (vertex as f32 - i as f32) * (axis + 1) as f32
                    };
                    let word = at + vertex * 3 + axis;
                    bytes[word * 4..word * 4 + 4].copy_from_slice(&value.to_le_bytes());
                }
            }
        }
        let expected = geometry_bounds(&Words(&bytes), 1)
            .into_iter()
            .map(|b| b.map(f32::to_bits))
            .collect::<Vec<_>>();
        assert_eq!(
            expected[0],
            [-0f32, -0f32, -0f32, 0f32, 0f32, 0f32].map(f32::to_bits)
        );
        assert_eq!(
            expected[1],
            [
                f32::INFINITY,
                f32::INFINITY,
                f32::INFINITY,
                f32::NEG_INFINITY,
                f32::NEG_INFINITY,
                f32::NEG_INFINITY
            ]
            .map(f32::to_bits)
        );
        let mut unaligned = vec![0xff];
        unaligned.extend_from_slice(&bytes);
        for workers in [2, 4, 12] {
            for source in [&bytes[..], &unaligned[1..]] {
                let actual = geometry_bounds(&Words(source), workers)
                    .into_iter()
                    .map(|b| b.map(f32::to_bits))
                    .collect::<Vec<_>>();
                assert_eq!(actual, expected, "workers={workers}");
            }
        }
    }
    unsafe extern "C" {
        fn mt_core_geometry_kernel_reference(
            input: *const u8,
            length: usize,
            with_bounds: u32,
            output: *mut *const u8,
            size: *mut usize,
        );
    }
    fn compare(input: &[u8], include_bounds: bool) {
        validate(input).unwrap();
        let mut pointer = std::ptr::null();
        let mut size = 0;
        unsafe {
            mt_core_geometry_kernel_reference(
                input.as_ptr(),
                input.len(),
                u32::from(include_bounds),
                &mut pointer,
                &mut size,
            );
        }
        let expected = unsafe { copy_core_result(pointer, size, size).unwrap() };
        unsafe {
            mt_core_reset();
            mt_core_collect();
        }
        let Some(actual) = packet(input, include_bounds) else {
            let w = Words(input);
            let hints = Words(&expected);
            assert!(!include_bounds);
            assert_eq!(
                expected.len(),
                (kh::WORDS + w.u(h::GEOMETRY_COUNT) * ke::WORDS) * WORD_BYTES
            );
            for i in 0..w.u(h::GEOMETRY_COUNT) {
                assert_eq!(hints.u(kh::WORDS + i * ke::WORDS + ke::BOUNDS), 0);
                assert_eq!(hints.u(kh::WORDS + i * ke::WORDS + ke::TANGENTS), 0);
            }
            return;
        };
        assert_eq!(
            actual, expected,
            "Rust kernel data must equal the compiled shared TS reference"
        );
    }
    #[test]
    fn geometry_kernels_preserve_production_assets() {
        let _test = ABI_TEST_LOCK.lock().unwrap();
        let _entry = ENTRY_LOCK.lock().unwrap();
        runtime::run(|| {
            init_core();
            let mut inputs = vec![super::super::tests::input()];
            if let Ok(path) = std::env::var("MUTRACER_KERNEL_FIXTURES") {
                let cases: Vec<serde_json::Value> =
                    serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
                for case in cases {
                    inputs.push(fs::read(case["input"].as_str().unwrap()).unwrap());
                }
            }
            for (i, input) in inputs.iter().enumerate() {
                for hardware in [false, true] {
                    let token = 2_000_000 + i as u32 * 2 + u32::from(hardware);
                    let settings = settings::RenderSettings::default();
                    let variants = if hardware { 2 } else { 1 };
                    let (_, actual) = prepare_impl_with_kernels(
                        input, token, hardware, false, &settings, variants, true,
                    )
                    .unwrap();
                    let (_, expected) = prepare_impl_with_kernels(
                        input, token, hardware, false, &settings, variants, false,
                    )
                    .unwrap();
                    assert_eq!(actual.len(), expected.len());
                    for (name, bytes) in actual {
                        let reference = expected.get(&name).unwrap();
                        assert!(
                            bytes == *reference,
                            "input {i}, hardware {hardware}, {name}: first difference {:?}, lengths {} / {}",
                            bytes.iter().zip(reference).position(|(a, b)| a != b),
                            bytes.len(),
                            reference.len()
                        );
                    }
                    let mut pointer = std::ptr::null();
                    let mut size = 0;
                    unsafe {
                        mt_core_scene_release(token, &mut pointer, &mut size);
                        mt_core_reset();
                        mt_core_collect();
                    }
                }
            }
        });
    }
    #[test]
    fn geometry_kernels_match_shared_ts_bytes() {
        let _test = ABI_TEST_LOCK.lock().unwrap();
        let _entry = ENTRY_LOCK.lock().unwrap();
        runtime::run(|| {
            init_core();
            let base = super::super::tests::input();
            let mut unaligned = vec![0u8];
            unaligned.extend_from_slice(&base);
            compare(&unaligned[1..], true);
            let mut seed = 0x12345678u32;
            for case in 0..80 {
                let count = 3 + case % 29;
                let mut words = base
                    .chunks_exact(4)
                    .map(|b| u32::from_le_bytes(b.try_into().unwrap()))
                    .collect::<Vec<_>>();
                let mut random = || {
                    seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
                    (seed as f64 / u32::MAX as f64 - 0.5) as f32
                };
                let geometry = words[h::GEOMETRY_OFFSET] as usize;
                words[geometry + g::VERTEX_COUNT] = count as u32;
                words[geometry + g::POSITION] = words.len() as u32;
                for i in 0..count * 3 {
                    let value = if case == 0 {
                        if i % 2 == 0 { -0.0f32 } else { 0.0f32 }
                    } else {
                        random() * if case % 11 == 0 { 1e20 } else { 10. }
                    };
                    words.push(value.to_bits());
                }
                words[geometry + g::NORMAL] = words.len() as u32;
                for _ in 0..count {
                    for n in [random(), random(), 1.] {
                        words.push(n.to_bits());
                    }
                }
                words[geometry + g::UV] = words.len() as u32;
                for _ in 0..count * 2 {
                    words.push(if case % 7 == 0 { 0 } else { random().to_bits() });
                }
                words[geometry + g::INDICES] = words.len() as u32;
                words[geometry + g::INDEX_COUNT] = (count * 6) as u32;
                for i in 0..count * 6 {
                    words.push(((i * 7 + i / 3) % count) as u32);
                }
                // Keep exercising the tangent kernel as well as the new no-work
                // path: both base and coat anisotropy consume generated tangents.
                if case % 4 != 0 {
                    let material = words[h::MATERIAL_OFFSET] as usize;
                    words[material + mat::EXTENSION_OFFSET] = words.len() as u32;
                    words[material + mat::EXTENSION_COUNT] = 1;
                    words.extend([if case % 2 == 0 { 28 } else { 9 }, 0.7f32.to_bits(), 0, 0]);
                }
                words[h::LENGTH] = words.len() as u32;
                let input = words
                    .into_iter()
                    .flat_map(u32::to_le_bytes)
                    .collect::<Vec<_>>();
                for include_bounds in [false, true] {
                    compare(&input, include_bounds);
                }
            }
            if let Ok(path) = std::env::var("MUTRACER_KERNEL_FIXTURES") {
                let cases: Vec<serde_json::Value> =
                    serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
                for case in cases {
                    let input = fs::read(case["input"].as_str().unwrap()).unwrap();
                    compare(&input, true);
                }
            }
        });
    }
}
