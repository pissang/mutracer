//! Native binding to the same official TinyBVH adapter used by the browser.
use super::Result;
use std::{borrow::Cow, ffi::c_void, sync::OnceLock};
unsafe extern "C" {
    fn mt_native_tiny_parallel_for(
        count: u32,
        callback: extern "C" fn(u32, *mut c_void),
        payload: *mut c_void,
        capture_ids: u32,
    );
    fn mt_native_tiny_blas(
        positions: *const f32,
        vertices: u32,
        normals: *const f32,
        indices: *const u32,
        index_count: u32,
        scale: f32,
        ranges: *const f32,
    ) -> *mut c_void;
    fn mt_native_tiny_aabbs(boxes: *const f32, count: u32) -> *mut c_void;
    fn tinybvh_result_data(result: *const c_void) -> usize;
    fn tinybvh_result_size(result: *const c_void) -> u32;
    fn tinybvh_result_max_depth(result: *const c_void) -> u32;
    fn tinybvh_result_layout(result: *const c_void) -> u32;
    fn mt_native_tiny_triangle_ids(result: *const c_void) -> usize;
    fn mt_native_tiny_triangle_ids_size(result: *const c_void) -> u32;
    fn tinybvh_result_destroy(result: *mut c_void);
}
struct Handle(*mut c_void);
impl Drop for Handle {
    fn drop(&mut self) {
        unsafe { tinybvh_result_destroy(self.0) }
    }
}
pub(super) struct Built {
    pub bytes: Vec<u8>,
    pub triangle_ids: Vec<u32>,
    pub depth: u32,
    pub leaf_primitives: u32,
}
fn finish(pointer: *mut c_void, primitive_count: usize) -> Result<Built> {
    if pointer.is_null() {
        return Err("Native TinyBVH allocation/build failed".into());
    }
    let handle = Handle(pointer);
    let size = unsafe { tinybvh_result_size(handle.0) } as usize;
    let address = unsafe { tinybvh_result_data(handle.0) };
    let depth = unsafe { tinybvh_result_max_depth(handle.0) };
    if unsafe { tinybvh_result_layout(handle.0) } != 0
        || size % 16 != 0
        || size > crate::memory_budget::RESOURCE_WIRE_BYTES
        || (size > 0 && address == 0)
    {
        return Err("Invalid native TinyBVH output".into());
    }
    crate::memory_budget::check(size, "Software BVH; select HWRT if this exceeds the budget")?;
    if size == 0 {
        return Ok(Built {
            bytes: vec![],
            triangle_ids: vec![],
            depth: 0,
            leaf_primitives: 0,
        });
    }
    let bytes = unsafe { std::slice::from_raw_parts(address as *const u8, size) }.to_vec();
    let words = words(&bytes);
    let mut stack = vec![(0usize, 1u32)];
    let mut visited = vec![false; size / 16];
    let mut max_depth = 0;
    let mut leaf_primitives = 0;
    let mut count = 0usize;
    while let Some((node, level)) = stack.pop() {
        if node >= visited.len() || visited[node] || node * 4 + 8 > words.len() {
            return Err("Invalid native TinyBVH node graph".into());
        }
        visited[node] = true;
        max_depth = max_depth.max(level);
        let at = node * 4;
        if [0, 1, 2, 4, 5, 6]
            .iter()
            .any(|i| !f32::from_bits(words[at + i]).is_finite())
        {
            return Err("Non-finite native TinyBVH bounds".into());
        }
        let child = words[at + 3] as i32;
        if child >= 0 {
            stack.push((node + 2, level + 1));
            stack.push((child as usize, level + 1));
        } else {
            let primitives = child.unsigned_abs();
            leaf_primitives = leaf_primitives.max(primitives);
            if (node + 2 + primitives as usize) * 4 > words.len() {
                return Err("Invalid native TinyBVH leaf".into());
            }
            count += primitives as usize;
        }
    }
    if max_depth != depth || count != primitive_count {
        return Err("Native TinyBVH primitive/depth mismatch".into());
    }
    let ids_len = unsafe { mt_native_tiny_triangle_ids_size(handle.0) } as usize;
    let ids = unsafe { mt_native_tiny_triangle_ids(handle.0) };
    let triangle_ids = if ids_len == 0 {
        vec![]
    } else {
        unsafe { std::slice::from_raw_parts(ids as *const u32, ids_len) }.to_vec()
    };
    Ok(Built {
        bytes,
        triangle_ids,
        depth,
        leaf_primitives,
    })
}
pub(super) fn blas(
    positions: &[f32],
    normals: Option<&[f32]>,
    indices: &[u32],
    scale: f32,
    ranges: Option<&[f32]>,
) -> Result<Built> {
    if positions.len() % 3 != 0
        || indices.len() % 3 != 0
        || positions.len() / 3 > 4_194_304
        || indices.len() > 12_582_912
        || indices.iter().any(|&v| v as usize >= positions.len() / 3)
        || positions.iter().any(|v| !v.is_finite())
        || !scale.is_finite()
        || normals.is_some_and(|v| v.len() != positions.len() || v.iter().any(|v| !v.is_finite()))
        || ranges
            .is_some_and(|v| v.len() != indices.len() / 3 * 2 || v.iter().any(|v| !v.is_finite()))
    {
        return Err("Invalid native TinyBVH geometry".into());
    }
    let pointer = unsafe {
        mt_native_tiny_blas(
            positions.as_ptr(),
            (positions.len() / 3) as u32,
            normals.map_or(std::ptr::null(), |v| v.as_ptr()),
            indices.as_ptr(),
            indices.len() as u32,
            scale,
            ranges.map_or(std::ptr::null(), |v| v.as_ptr()),
        )
    };
    finish(pointer, indices.len() / 3)
}
pub(super) fn aabbs(boxes: &[f32]) -> Result<Built> {
    if boxes.len() % 6 != 0
        || boxes.len() / 6 > crate::scene::instance_limit()
        || boxes.iter().any(|v| !v.is_finite())
        || boxes
            .chunks_exact(6)
            .any(|b| (0..3).any(|i| b[i] > b[i + 3]))
    {
        return Err("Invalid native TinyBVH instance bounds".into());
    }
    finish(
        unsafe { mt_native_tiny_aabbs(boxes.as_ptr(), (boxes.len() / 6) as u32) },
        boxes.len() / 6,
    )
}
// Validated native packets are aligned by their owner allocation. Borrow them
// directly on little-endian hosts; unaligned callers retain the safe copy path.
fn floats(bytes: &[u8]) -> Cow<'_, [f32]> {
    let bytes = &bytes[..bytes.len() / 4 * 4];
    match bytemuck::try_cast_slice(bytes) {
        Ok(values) => Cow::Borrowed(values),
        Err(_) => Cow::Owned(bytemuck::pod_collect_to_vec(bytes)),
    }
}
fn words(bytes: &[u8]) -> Cow<'_, [u32]> {
    let bytes = &bytes[..bytes.len() / 4 * 4];
    match bytemuck::try_cast_slice(bytes) {
        Ok(values) => Cow::Borrowed(values),
        Err(_) => Cow::Owned(bytemuck::pod_collect_to_vec(bytes)),
    }
}
fn build_job(data: &[u8], instances: bool) -> Result<Built> {
    if instances {
        return aabbs(&floats(data));
    }
    if data.len() < 16 {
        return Err("Short native TinyBVH geometry request".into());
    }
    let u = |i: usize| u32::from_le_bytes(data[i * 4..i * 4 + 4].try_into().unwrap()) as usize;
    let vertices = u(0);
    let indices = u(1);
    let displacement = u(2);
    if vertices > 4_194_304 || indices > 12_582_912 || displacement > 1 || indices % 3 != 0 {
        return Err("Invalid native TinyBVH geometry request".into());
    }
    let p = 16;
    let n = p + vertices * 12;
    let idx = n + vertices * 12 * displacement;
    let end = idx + indices * 4;
    if data.len() != end + indices / 3 * 8 * displacement {
        return Err("Native TinyBVH request length mismatch".into());
    }
    let positions = floats(&data[p..n]);
    let normals = floats(&data[n..idx]);
    let indices = words(&data[idx..end]);
    let ranges = floats(&data[end..]);
    blas(
        &positions,
        if displacement == 1 {
            Some(&normals)
        } else {
            None
        },
        &indices,
        f32::from_bits(u(3) as u32),
        if displacement == 1 {
            Some(&ranges)
        } else {
            None
        },
    )
}
struct Batch<'a> {
    jobs: Vec<&'a [u8]>,
    instances: bool,
    results: Vec<OnceLock<std::result::Result<Built, String>>>,
}
extern "C" fn execute_job(index: u32, payload: *mut c_void) {
    // The synchronous C++ pool calls each valid index exactly once and joins all
    // work before returning; only the matching OnceLock is written by a worker.
    let batch = unsafe { &*payload.cast::<Batch<'_>>() };
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        build_job(batch.jobs[index as usize], batch.instances)
    }))
    .map_err(|_| "Native TinyBVH worker panicked".to_string())
    .and_then(|r| r.map_err(|e| e.to_string()));
    let _ = batch.results[index as usize].set(result);
}
// Diagnostic identities are opt-in so ordinary commits do not serialize or
// compose an O(triangles) identity sidecar that the renderer never consumes.
pub(super) fn jobs(packet: &[u8], instances: bool) -> Result<Vec<u8>> {
    jobs_with_ids(packet, instances, false)
}
pub(super) fn jobs_with_ids(packet: &[u8], instances: bool, capture_ids: bool) -> Result<Vec<u8>> {
    let word = |i: usize| u32::from_le_bytes(packet[i * 4..i * 4 + 4].try_into().unwrap()) as usize;
    if packet.len() < 16 || packet.len() % 4 != 0 || word(0) != 1 {
        return Err("Invalid native TinyBVH request packet".into());
    }
    let count = word(1);
    let header = 16 + count * 32;
    if count > 65_536 || packet.len() < header || (instances && count != 1) {
        return Err("Invalid native TinyBVH request count".into());
    }
    let mut jobs = Vec::with_capacity(count);
    for i in 0..count {
        let o = 4 + i * 8;
        let length = word(o + 2);
        let offset = word(o + 7);
        if word(o) != i
            || word(o + 1) != 0
            || offset < header
            || offset % 4 != 0
            || length % 4 != 0
            || offset > packet.len()
            || length > packet.len() - offset
        {
            return Err("Invalid native TinyBVH request span".into());
        }
        jobs.push(&packet[offset..offset + length]);
    }
    let batch = Batch {
        jobs,
        instances,
        results: (0..count).map(|_| OnceLock::new()).collect(),
    };
    fn assert_sync<T: Sync>(_: &T) {}
    assert_sync(&batch);
    unsafe {
        mt_native_tiny_parallel_for(
            count as u32,
            execute_job,
            (&batch as *const Batch<'_>).cast_mut().cast(),
            u32::from(capture_ids),
        );
    }
    let mut built = Vec::with_capacity(count);
    let mut total = header;
    for slot in batch.results {
        let bvh = slot
            .into_inner()
            .ok_or("Missing native TinyBVH job result")??;
        total = total
            .checked_add(bvh.bytes.len())
            .and_then(|n| n.checked_add(bvh.triangle_ids.len() * 4))
            .ok_or("Software BVH size overflow; use HWRT")?;
        crate::memory_budget::check(
            total,
            "Software BVH; select HWRT if this exceeds the budget",
        )?;
        if total > crate::memory_budget::RESOURCE_WIRE_BYTES {
            return Err(format!("Software BVH requires {total} bytes; 32-bit resource offsets allow {} bytes. Use HWRT.", crate::memory_budget::RESOURCE_WIRE_BYTES).into());
        }
        if bvh.depth > 64 {
            return Err("Software BVH exceeds traversal stack budget; use HWRT".into());
        }
        built.push(bvh);
    }
    let mut output = vec![0u8; total];
    let put = |data: &mut [u8], i: usize, value: u32| {
        data[i * 4..i * 4 + 4].copy_from_slice(&value.to_le_bytes())
    };
    put(&mut output, 0, 1);
    put(&mut output, 1, count as u32);
    let mut offset = header;
    for (i, bvh) in built.iter().enumerate() {
        let o = 4 + i * 8;
        put(&mut output, o, i as u32);
        put(&mut output, o + 2, bvh.bytes.len() as u32);
        put(&mut output, o + 3, bvh.depth);
        put(&mut output, o + 4, bvh.leaf_primitives);
        put(&mut output, o + 7, offset as u32);
        output[offset..offset + bvh.bytes.len()].copy_from_slice(&bvh.bytes);
        offset += bvh.bytes.len();
        put(&mut output, o + 5, bvh.triangle_ids.len() as u32);
        put(
            &mut output,
            o + 6,
            if bvh.triangle_ids.is_empty() {
                0
            } else {
                offset as u32
            },
        );
        for value in &bvh.triangle_ids {
            output[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
            offset += 4;
        }
    }
    Ok(output)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn byte_views_borrow_aligned_words_and_copy_unaligned_words() {
        let values = [1u32, 0x80000000, 0x7fc00001, 0x3f800000];
        let bytes = bytemuck::cast_slice(&values);
        assert!(matches!(words(bytes), Cow::Borrowed(_)));
        assert!(matches!(floats(bytes), Cow::Borrowed(_)));
        let mut storage = [0u32; 5];
        let unaligned = &mut bytemuck::cast_slice_mut::<u32, u8>(&mut storage)[1..18];
        unaligned[..16].copy_from_slice(bytes);
        unaligned[16] = 255;
        assert!(matches!(words(unaligned), Cow::Owned(_)));
        assert!(matches!(floats(unaligned), Cow::Owned(_)));
        assert_eq!(&*words(unaligned), &values);
        assert_eq!(
            floats(unaligned)
                .iter()
                .map(|v| v.to_bits())
                .collect::<Vec<_>>(),
            values
        );
    }
    fn packet(jobs: &[Vec<u8>]) -> Vec<u8> {
        let header = 16 + jobs.len() * 32;
        let mut output = vec![0; header];
        output[..4].copy_from_slice(&1u32.to_le_bytes());
        output[4..8].copy_from_slice(&(jobs.len() as u32).to_le_bytes());
        for (i, job) in jobs.iter().enumerate() {
            let o = 16 + i * 32;
            output[o..o + 4].copy_from_slice(&(i as u32).to_le_bytes());
            output[o + 8..o + 12].copy_from_slice(&(job.len() as u32).to_le_bytes());
            let offset = output.len() as u32;
            output[o + 28..o + 32].copy_from_slice(&offset.to_le_bytes());
            output.extend_from_slice(job);
        }
        output
    }
    #[test]
    fn parallel_blas_batches_preserve_order_and_unaligned_inputs() {
        // Exercise both the outer fan-out and the builder's nested subtree jobs.
        let count = 65_536usize;
        let mut positions = Vec::new();
        for i in 0..count {
            let x = (i % 256) as f32;
            let y = (i / 256) as f32;
            positions.extend_from_slice(&[x, y, 0., x + 0.7, y, 0., x, y + 0.5, 0.]);
        }
        let indices: Vec<u32> = (0..count as u32 * 3).collect();
        let reference = blas(&positions, None, &indices, 0., None).unwrap();
        let mut request = Vec::new();
        for value in [count as u32 * 3, count as u32 * 3, 0, 0] {
            request.extend_from_slice(&value.to_le_bytes());
        }
        for value in &positions {
            request.extend_from_slice(&value.to_le_bytes());
        }
        for value in &indices {
            request.extend_from_slice(&value.to_le_bytes());
        }
        let requests = packet(&vec![request; 12]);
        let result = jobs_with_ids(&requests, false, true).unwrap();
        for i in 0..12 {
            let at = 4 + i * 8;
            let w = words(&result);
            let offset = w[at + 7] as usize;
            assert_eq!(
                &result[offset..offset + w[at + 2] as usize],
                reference.bytes
            );
            assert_eq!(w[at + 5] as usize, reference.triangle_ids.len());
            let start = w[at + 6] as usize;
            assert_eq!(
                &*words(&result[start..start + w[at + 5] as usize * 4]),
                reference.triangle_ids
            );
        }
        let mut unaligned = vec![0];
        unaligned.extend_from_slice(&requests);
        assert_eq!(jobs_with_ids(&unaligned[1..], false, true).unwrap(), result);
        let ordinary = jobs(&requests, false).unwrap();
        for i in 0..12 {
            let w = words(&ordinary);
            assert_eq!((w[4 + i * 8 + 5], w[4 + i * 8 + 6]), (0, 0));
        }
    }
    #[test]
    fn native_triangle_preserves_geometry_and_lifetime() {
        for _ in 0..100 {
            let b = blas(
                &[-1., 0., 0., 1., 0., 0., 0., 2., 0.],
                None,
                &[0, 1, 2],
                0.,
                None,
            )
            .unwrap();
            assert_eq!((b.depth, b.leaf_primitives), (1, 1));
            let w: Vec<_> = b
                .bytes
                .chunks_exact(4)
                .map(|v| u32::from_le_bytes(v.try_into().unwrap()))
                .collect();
            assert_eq!(&w[8..11], &[0, 1, 2]);
            assert_eq!(f32::from_bits(w[0]), -1.);
            assert_eq!(f32::from_bits(w[5]), 2.);
        }
    }
    #[test]
    fn source_ids_preserve_duplicate_triangle_identities() {
        let indices = [0, 1, 2, 0, 1, 2];
        let built = blas(
            &[-1., 0., 0., 1., 0., 0., 0., 2., 0.],
            None,
            &indices,
            0.,
            None,
        )
        .unwrap();
        let mut sources = Vec::new();
        for pair in built.triangle_ids.chunks_exact(2) {
            let start = pair[0] as usize * 16;
            let actual: Vec<_> = built.bytes[start..start + 12]
                .chunks_exact(4)
                .map(|v| u32::from_le_bytes(v.try_into().unwrap()))
                .collect();
            assert_eq!(
                actual,
                indices[pair[1] as usize * 3..pair[1] as usize * 3 + 3]
            );
            sources.push(pair[1]);
        }
        sources.sort_unstable();
        assert_eq!(sources, [0, 1]);
    }

    #[test]
    fn native_boxes_and_empty_inputs() {
        assert!(aabbs(&[]).unwrap().bytes.is_empty());
        let b = aabbs(&[-2., 0., 0., -1., 1., 1., 1., 0., 0., 2., 1., 1.]).unwrap();
        assert!(!b.bytes.is_empty());
        assert!(blas(&[f32::NAN, 0., 0.], None, &[0, 0, 0], 0., None).is_err());
        assert!(aabbs(&[2., 0., 0., 1., 1., 1.]).is_err());
    }
    #[test]
    fn large_threaded_builds_keep_bounds_and_every_primitive() {
        // Cross the former 65,536-instance cap and upstream's worker threshold.
        // Serialized output must remain deterministic despite task scheduling.
        let count = 65_537usize;
        let mut positions = Vec::with_capacity(count * 9);
        let mut boxes = Vec::with_capacity(count * 6);
        for i in 0..count {
            let x = (i % 256) as f32;
            let y = (i / 256) as f32;
            let z = ((i * 17) % 31) as f32 * 0.125;
            positions.extend_from_slice(&[x, y, z, x + 0.75, y, z, x, y + 0.5, z + 0.25]);
            boxes.extend_from_slice(&[x, y, z, x + 0.75, y + 0.5, z + 0.25]);
        }
        let indices: Vec<u32> = (0..count as u32 * 3).collect();
        for is_tlas in [false, true] {
            let build = || {
                if is_tlas {
                    aabbs(&boxes).unwrap()
                } else {
                    blas(&positions, None, &indices, 0., None).unwrap()
                }
            };
            let built = build();
            for _ in 0..3 {
                assert_eq!(build().bytes, built.bytes);
            }
            let words: Vec<u32> = built
                .bytes
                .chunks_exact(4)
                .map(|v| u32::from_le_bytes(v.try_into().unwrap()))
                .collect();
            let mut stack = vec![(0usize, None::<[f32; 6]>)];
            let mut seen = vec![false; count];
            while let Some((node, parent)) = stack.pop() {
                let at = node * 4;
                let bounds = [0, 1, 2, 4, 5, 6].map(|j| f32::from_bits(words[at + j]));
                for axis in 0..3 {
                    assert!(bounds[axis] <= bounds[axis + 3]);
                    if let Some(parent) = parent {
                        assert!(bounds[axis] >= parent[axis]);
                        assert!(bounds[axis + 3] <= parent[axis + 3]);
                    }
                }
                let child = words[at + 3] as i32;
                if child >= 0 {
                    stack.push((node + 2, Some(bounds)));
                    stack.push((child as usize, Some(bounds)));
                } else {
                    for i in 0..child.unsigned_abs() as usize {
                        let record = at + 8 + i * 4;
                        let id = words[record] as usize / if is_tlas { 1 } else { 3 };
                        assert!(!seen[id], "duplicate primitive {id}");
                        seen[id] = true;
                        for corner in 0..3 {
                            assert_eq!(
                                words[record + corner] as usize,
                                if is_tlas { id } else { id * 3 + corner }
                            );
                        }
                        for axis in 0..3 {
                            assert!(bounds[axis] <= boxes[id * 6 + axis]);
                            assert!(bounds[axis + 3] >= boxes[id * 6 + axis + 3]);
                        }
                    }
                }
            }
            assert!(seen.iter().all(|v| *v));
        }
    }
    #[test]
    fn batch_rejects_invalid_spans_and_counts() {
        // One empty TLAS record is valid; malformed framing must never reach C++.
        let mut packet = vec![0u8; 48];
        let put = |p: &mut [u8], at: usize, value: u32| {
            p[at * 4..at * 4 + 4].copy_from_slice(&value.to_le_bytes())
        };
        put(&mut packet, 0, 1);
        put(&mut packet, 1, 1);
        put(&mut packet, 11, 48);
        let output = jobs(&packet, true).unwrap();
        assert_eq!(output, packet);
        for (at, value) in [
            (0, 2),
            (1, u32::MAX),
            (4, 1),
            (5, 1),
            (6, 4),
            (11, 0),
            (11, 49),
            (11, u32::MAX),
        ] {
            let mut bad = packet.clone();
            put(&mut bad, at, value);
            assert!(jobs(&bad, true).is_err(), "field {at} value {value}");
        }
        assert!(jobs(&packet, false).is_err());
        for length in 0..48 {
            assert!(jobs(&packet[..length], true).is_err());
        }
    }
}
