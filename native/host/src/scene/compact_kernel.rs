//! Shared TS compactVertices encoding on Rust-owned descriptor/output storage.
//! Layout/material-plane decisions and generated attributes remain in TS.
use super::*;
use std::borrow::Cow;

#[derive(Clone, Copy)]
struct Layout {
    stride: usize,
    uv: usize,
    uv1: usize,
    color: usize,
    tangent: usize,
    color_float: bool,
    normal_float: bool,
}
struct Input<'a> {
    positions: Cow<'a, [f32]>,
    normals: Cow<'a, [f32]>,
    uv: Cow<'a, [f32]>,
    uv1: Cow<'a, [f32]>,
    colors: Cow<'a, [f32]>,
    tangents: Cow<'a, [f32]>,
}
struct Job<'a> {
    first: usize,
    count: usize,
    input: Input<'a>,
}
fn floats<'a>(w: &Words<'a>, at: usize, count: usize) -> Result<Cow<'a, [f32]>> {
    if at == 0 {
        return Ok(Cow::Borrowed(&[]));
    }
    w.span(at, count)?;
    let bytes = &w.0[at * 4..(at + count) * 4];
    Ok(bytemuck::try_cast_slice(bytes)
        .map(Cow::Borrowed)
        .unwrap_or_else(|_| {
            Cow::Owned(
                bytes
                    .chunks_exact(4)
                    .map(|b| f32::from_le_bytes(b.try_into().unwrap()))
                    .collect(),
            )
        }))
}
// JS Math.round selects the integer towards +infinity at a half tie. Adding
// 0.5 before floor would also round values immediately below a half upwards.
fn round(value: f64) -> u32 {
    let lower = value.floor();
    (lower as i64 + i64::from(value - lower >= 0.5)) as u32
}
fn oct(mut x: f64, mut y: f64, z: f64, maximum: f64, bits: u32) -> u32 {
    let length = x.abs() + y.abs() + z.abs();
    if length == 0. {
        return (1 << (bits - 1)) | (1 << (bits * 2 - 1));
    }
    x /= length;
    y /= length;
    if z < 0. {
        let old_x = x;
        x = (1. - y.abs()) * if old_x < 0. { -1. } else { 1. };
        y = (1. - old_x.abs()) * if y < 0. { -1. } else { 1. };
    }
    let mask = (1 << bits) - 1;
    (round(x * maximum) & mask) | ((round(y * maximum) & mask) << bits)
}
fn write(output: &mut [u8], word: usize, value: u32) {
    output[word * 4..word * 4 + 4].copy_from_slice(&value.to_le_bytes());
}
fn pack(input: &Input<'_>, layout: Layout, first: usize, output: &mut [u8]) {
    for (i, vertex) in output.chunks_exact_mut(layout.stride * 4).enumerate() {
        let i = first + i;
        let p = i * 3;
        for axis in 0..3 {
            write(vertex, axis, input.positions[p + axis].to_bits());
        }
        if layout.normal_float {
            for axis in 0..3 {
                write(vertex, 3 + axis, input.normals[p + axis].to_bits());
            }
        } else {
            write(
                vertex,
                3,
                oct(
                    input.normals[p] as f64,
                    input.normals[p + 1] as f64,
                    input.normals[p + 2] as f64,
                    32767.,
                    16,
                ),
            );
        }
        if layout.tangent < layout.stride {
            let value = if input.tangents.is_empty() {
                oct(0., 0., 0., 16383., 15)
            } else {
                let t = i * 4;
                let w = input.tangents[t + 3];
                let sign = if w > 1.5 {
                    3
                } else if w < 0. {
                    2
                } else if w > 0. {
                    1
                } else {
                    0
                };
                oct(
                    input.tangents[t] as f64,
                    input.tangents[t + 1] as f64,
                    input.tangents[t + 2] as f64,
                    16383.,
                    15,
                ) | (sign << 30)
            };
            write(vertex, layout.tangent, value);
        }
        if layout.uv < layout.color {
            for axis in 0..2 {
                write(
                    vertex,
                    layout.uv + axis,
                    input.uv.get(i * 2 + axis).copied().unwrap_or(0.).to_bits(),
                );
                let uv1 = if input.uv1.is_empty() {
                    &input.uv
                } else {
                    &input.uv1
                };
                write(
                    vertex,
                    layout.uv1 + axis,
                    uv1.get(i * 2 + axis).copied().unwrap_or(0.).to_bits(),
                );
            }
        }
        if layout.color < layout.tangent {
            let r = input.colors.get(p).copied().unwrap_or(1.);
            let g = input.colors.get(p + 1).copied().unwrap_or(1.);
            let b = input.colors.get(p + 2).copied().unwrap_or(1.);
            if layout.color_float {
                for (axis, value) in [r, g, b].into_iter().enumerate() {
                    write(vertex, layout.color + axis, value.to_bits());
                }
            } else {
                write(
                    vertex,
                    layout.color,
                    round(r as f64 * 255.)
                        | (round(g as f64 * 255.) << 8)
                        | (round(b as f64 * 255.) << 16)
                        | 0xff000000,
                );
            }
        }
    }
}
fn requests<'a>(
    descriptor: &'a [u8],
    packet: &[u8],
    output_bytes: usize,
) -> Result<(Layout, Vec<Job<'a>>)> {
    if packet.len() < 48 || packet.len() % 4 != 0 {
        return Err("Invalid compact job packet".into());
    }
    let w = Words(packet);
    let (stride, count, flags, vertex_words) = (w.u(1), w.u(2), w.u(3), w.u(8));
    let layout = Layout {
        stride,
        uv: w.u(4),
        uv1: w.u(5),
        color: w.u(6),
        tangent: w.u(7),
        color_float: flags & 1 != 0,
        normal_float: flags & 2 != 0,
    };
    if w.u(0) != 1
        || !(4..=14).contains(&stride)
        || flags & !3 != 0
        || count > 65536
        || packet.len() != (12 + count * 4) * 4
        || vertex_words % stride != 0
        || vertex_words > output_bytes / 4
        || (9..12).any(|i| w.u(i) != 0)
        || layout.uv != if layout.normal_float { 6 } else { 4 }
        || layout.color > layout.tangent
        || layout.tangent > stride
        || (layout.uv != layout.color
            && (layout.uv + 2 > layout.color
                || layout.uv1 + 2 > layout.color
                || !(layout.uv1 == layout.uv || layout.uv1 == layout.uv + 2)))
        || (layout.uv == layout.color && layout.uv1 != layout.uv)
        || (layout.color != layout.tangent
            && layout.color + if layout.color_float { 3 } else { 1 } != layout.tangent)
        || (layout.tangent != stride && layout.tangent + 1 != stride)
    {
        return Err("Invalid compact layout or job count".into());
    }
    let d = Words(descriptor);
    let mut jobs = Vec::with_capacity(count);
    let mut end = 0;
    for i in 0..count {
        let off = 12 + i * 4;
        let (source, first, count) = (w.u(off), w.u(off + 1), w.u(off + 2));
        if source >= d.u(h::GEOMETRY_COUNT)
            || count == 0
            || first < end
            || w.u(off + 3) != 0
            || first
                .checked_add(count)
                .is_none_or(|end| end > vertex_words / stride)
        {
            return Err("Invalid or overlapping compact region".into());
        }
        let g = d.u(h::GEOMETRY_OFFSET) + source * g::WORDS;
        if d.u(g + g::VERTEX_COUNT) != count || d.u(g + g::NORMAL) == 0 {
            return Err("Invalid compact source geometry".into());
        }
        let read = |field, size| floats(&d, d.u(g + field), count * size);
        let input = Input {
            positions: read(g::POSITION, 3)?,
            normals: read(g::NORMAL, 3)?,
            uv: read(g::UV, 2)?,
            uv1: read(g::UV1, 2)?,
            colors: read(g::COLOR, 3)?,
            tangents: read(g::TANGENT, 4)?,
        };
        if input.positions.is_empty() {
            return Err("Missing compact positions".into());
        }
        end = first + count;
        jobs.push(Job {
            first,
            count,
            input,
        });
    }
    Ok((layout, jobs))
}
fn pack_jobs(layout: Layout, jobs: &[Job<'_>], output: &mut [u8], workers: usize) {
    if workers <= 1 {
        for job in jobs {
            let start = job.first * layout.stride * 4;
            pack(
                &job.input,
                layout,
                0,
                &mut output[start..start + job.count * layout.stride * 4],
            );
        }
        return;
    }
    let vertices: usize = jobs.iter().map(|job| job.count).sum();
    let chunk_vertices = vertices.div_ceil(workers).clamp(1, 65_536);
    let mut batches: Vec<_> = (0..workers).map(|_| Vec::new()).collect();
    let mut remaining = output;
    let mut cursor = 0;
    let mut next = 0;
    for job in jobs {
        let start = job.first * layout.stride * 4;
        let (_, tail) = remaining.split_at_mut(start - cursor);
        let (region, tail) = tail.split_at_mut(job.count * layout.stride * 4);
        remaining = tail;
        cursor = start + region.len();
        for (i, chunk) in region
            .chunks_mut(chunk_vertices * layout.stride * 4)
            .enumerate()
        {
            batches[next % workers].push((&job.input, i * chunk_vertices, chunk));
            next += 1;
        }
    }
    // Every input belongs to Rust; split_at_mut proves disjoint output regions.
    // Scoped joins complete before publication. Workers never enter AOT.
    std::thread::scope(|scope| {
        for batch in batches.into_iter().filter(|batch| !batch.is_empty()) {
            scope.spawn(move || {
                for (input, first, chunk) in batch {
                    pack(input, layout, first, chunk);
                }
            });
        }
    });
}
pub(super) fn apply(descriptor: &[u8], packet: &[u8], assets: &mut Assets) -> Result<()> {
    let output = assets
        .get_mut(&AssetId::Packet(res::ATTRIBUTES))
        .ok_or("Missing compact attribute buffer")?;
    let (layout, jobs) = requests(descriptor, packet, output.len())?;
    let vertices: usize = jobs.iter().map(|job| job.count).sum();
    let workers = if vertices < 131_072
        || std::env::var("MUTRACER_NATIVE_COMPACT").as_deref() == Ok("serial")
    {
        1
    } else {
        std::thread::available_parallelism().map_or(1, |n| n.get().min(12))
    };
    let started = Instant::now();
    pack_jobs(layout, &jobs, output, workers);
    if crate::profiling::enabled() {
        native_log!(
            "{}",
            json!({"nativeCompactProfile":{"vertices":vertices,"jobs":jobs.len(),"workers":workers,"packMs":started.elapsed().as_secs_f64()*1000.}})
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    unsafe extern "C" {
        fn mt_core_compact_reference(
            input: *const u8,
            length: usize,
            normal_float: u32,
            output: *mut *const u8,
            size: *mut usize,
        );
    }
    fn descriptor(case: usize) -> Vec<u8> {
        let base = super::super::tests::input();
        let mut words: Vec<_> = base
            .chunks_exact(4)
            .map(|b| u32::from_le_bytes(b.try_into().unwrap()))
            .collect();
        let off = words[h::GEOMETRY_OFFSET] as usize;
        let count = 3 + case * 7;
        words[off + g::VERTEX_COUNT] = count as u32;
        let mut seed = 0x84732854u32.wrapping_add(case as u32);
        for (field, width, present) in [
            (g::POSITION, 3, true),
            (g::NORMAL, 3, true),
            (g::UV, 2, case & 1 != 0),
            (g::UV1, 2, case & 2 != 0),
            (g::COLOR, 3, case & 4 != 0),
            (g::TANGENT, 4, case & 8 != 0),
        ] {
            words[off + field] = if present { words.len() as u32 } else { 0 };
            if !present {
                continue;
            }
            for i in 0..count * width {
                seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
                let random = seed as f64 / u32::MAX as f64;
                let directions = [
                    [0., 0., 0.],
                    [-0., -0., -0.],
                    [f32::MAX; 3],
                    [f32::MIN_POSITIVE; 3],
                    [-f32::from_bits(1); 3],
                    [-1., -1., 0.],
                    [1., 1., 0.],
                    [-1., 0., -1.],
                    [0., -1., -1.],
                    [1., 0., -1.],
                    [1., 1., -1.],
                    [-1., 1., -1.],
                ];
                let value = if (field == g::NORMAL || field == g::TANGENT)
                    && i / width < directions.len()
                    && i % width < 3
                {
                    directions[i / width][i % width]
                } else if field == g::COLOR {
                    if case >= 32 {
                        (random * 8. - 2.) as f32
                    } else {
                        random as f32
                    }
                } else if field == g::TANGENT && i % 4 == 3 {
                    [-2., -1., -0., 0., 1., 1.5, 2.][(i / 4) % 7]
                } else {
                    (random * 2. - 1.) as f32
                };
                words.push(value.to_bits());
            }
        }
        words[h::LENGTH] = words.len() as u32;
        words.into_iter().flat_map(u32::to_le_bytes).collect()
    }
    fn reference(input: &[u8], normal_float: bool) -> Vec<u8> {
        let mut pointer = std::ptr::null();
        let mut size = 0;
        unsafe {
            mt_core_compact_reference(
                input.as_ptr(),
                input.len(),
                u32::from(normal_float),
                &mut pointer,
                &mut size,
            );
            let result = copy_core_result(pointer, size, size).unwrap();
            mt_core_reset();
            mt_core_collect();
            result
        }
    }
    #[test]
    fn compact_records_match_compiled_shared_ts_bytes() {
        let _test = ABI_TEST_LOCK.lock().unwrap();
        let _entry = ENTRY_LOCK.lock().unwrap();
        runtime::run(|| {
            init_core();
            for case in 0..64 {
                let input = descriptor(case);
                validate(&input).unwrap();
                for normal_float in [false, true] {
                    let expected = reference(&input, normal_float);
                    let mut unaligned = vec![0x55];
                    unaligned.extend_from_slice(&input);
                    for input in [&input[..], &unaligned[1..]] {
                        let mut output = vec![0x99; expected.len() - 64 + 2];
                        let (layout, jobs) =
                            requests(input, &expected[..64], output.len() - 2).unwrap();
                        for workers in [1, 2, 7] {
                            output[1..expected.len() - 64 + 1].fill(0x99);
                            pack_jobs(
                                layout,
                                &jobs,
                                &mut output[1..expected.len() - 64 + 1],
                                workers,
                            );
                            assert_eq!(
                                &output[1..output.len() - 1],
                                &expected[64..],
                                "case {case}, workers={workers}"
                            );
                        }
                        assert_eq!(
                            &output[1..output.len() - 1],
                            &expected[64..],
                            "case {case}, normal_float={normal_float}"
                        );
                        assert_eq!((output[0], output[output.len() - 1]), (0x99, 0x99));
                    }
                }
            }
        });
    }
    #[test]
    fn compact_rounding_and_invalid_requests() {
        assert_eq!(round(0.5), 1);
        assert_eq!(round(-0.5), 0);
        assert_eq!(round(-1.5), u32::MAX);
        assert_eq!(round(f64::from_bits(0.5f64.to_bits() - 1)), 0);
        assert_eq!(round(f64::from_bits((-0.5f64).to_bits() + 1)), u32::MAX);
        let input = descriptor(0);
        let mut packet: Vec<u8> = [1u32, 4, 1, 0, 4, 4, 4, 4, 12, 0, 0, 0, 0, 0, 3, 0]
            .into_iter()
            .flat_map(u32::to_le_bytes)
            .collect();
        assert!(requests(&input, &packet, 48).is_ok());
        for (word, value) in [
            (0, 2u32),
            (1, 0),
            (2, u32::MAX),
            (3, 4),
            (4, 0),
            (5, 0),
            (6, 9),
            (7, 9),
            (8, 11),
            (9, 1),
            (12, u32::MAX),
            (13, 1),
            (14, 4),
            (15, 1),
        ] {
            let old = packet[word * 4..word * 4 + 4].to_vec();
            packet[word * 4..word * 4 + 4].copy_from_slice(&value.to_le_bytes());
            assert!(requests(&input, &packet, 48).is_err(), "word {word}");
            packet[word * 4..word * 4 + 4].copy_from_slice(&old);
        }
        assert!(requests(&input, &packet[..47], 48).is_err());
        // A later request cannot overwrite the previous output region.
        packet[8..12].copy_from_slice(&2u32.to_le_bytes());
        packet.extend_from_within(48..64);
        assert!(requests(&input, &packet, 48).is_err());
    }
    #[cfg(feature = "gltf")]
    #[test]
    fn compact_large_scene_production_assets_match_ts() {
        let Ok(path) = std::env::var("MUTRACER_COMPACT_MODEL") else {
            println!("SKIP compact large-scene oracle: set MUTRACER_COMPACT_MODEL");
            return;
        };
        let _test = ABI_TEST_LOCK.lock().unwrap();
        let _entry = ENTRY_LOCK.lock().unwrap();
        let imported = crate::scene_api::Scene::import_gltf(path).unwrap();
        let input = imported.scene.descriptor().unwrap();
        drop(imported);
        runtime::run(move || {
            let settings = settings::RenderSettings::default();
            let token = 3_000_000;
            let (_, expected) =
                prepare_impl_with_kernels(&input, token, true, false, &settings, 2, false).unwrap();
            let mut pointer = std::ptr::null();
            let mut size = 0;
            unsafe {
                mt_core_scene_release(token, &mut pointer, &mut size);
                mt_core_reset();
                mt_core_collect();
            }
            let (_, actual) =
                prepare_impl_with_kernels(&input, token, true, false, &settings, 2, true).unwrap();
            assert_eq!(actual.len(), expected.len());
            let mut compared = 0usize;
            for (name, bytes) in &actual {
                let reference = &expected[name];
                assert!(
                    bytes == reference,
                    "{name}: first difference {:?}",
                    bytes.iter().zip(reference).position(|(a, b)| a != b)
                );
                compared += bytes.len();
            }
            println!(
                "COMPACT_LARGE_SCENE_EXACT resources={} bytes={compared}",
                actual.len()
            );
            unsafe {
                mt_core_scene_release(token, &mut pointer, &mut size);
                mt_core_reset();
                mt_core_collect();
            }
        });
    }
}
