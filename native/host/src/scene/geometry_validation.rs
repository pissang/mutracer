//! Per-geometry scans run independently; results are consumed in descriptor order.
use super::*;
use std::sync::{
    OnceLock,
    atomic::{AtomicUsize, Ordering},
};

pub(super) fn scan_workers(jobs: usize, elements: usize) -> usize {
    if jobs <= 1
        || elements < 131_072
        || std::env::var("MUTRACER_NATIVE_GEOMETRY_SCANS").as_deref() == Ok("serial")
    {
        1
    } else {
        std::thread::available_parallelism().map_or(1, |n| n.get().min(12).min(jobs))
    }
}

pub(super) fn validate(w: &Words<'_>, unchanged: &[u8]) -> Result<(usize, Vec<usize>)> {
    let count = w.u(h::GEOMETRY_COUNT);
    let elements = (0..count)
        .filter(|&i| unchanged.get(i) != Some(&1))
        .map(|i| {
            let o = w.u(h::GEOMETRY_OFFSET) + i * g::WORDS;
            w.u(o + g::VERTEX_COUNT) + w.u(o + g::INDEX_COUNT)
        })
        .sum();
    validate_with_workers(w, unchanged, scan_workers(count, elements))
}

fn geometry(w: &Words<'_>, i: usize, scan: bool, total: Option<usize>) -> Result<()> {
    let o = w.u(h::GEOMETRY_OFFSET) + i * g::WORDS;
    let v = w.u(o + g::VERTEX_COUNT);
    let n = w.u(o + g::INDEX_COUNT);
    if v == 0 || n == 0 || n % 3 != 0 || v > 4_000_000 || n > 12_000_000 {
        return Err("Invalid geometry counts".into());
    }
    if total.ok_or("Prepared geometry size overflow")? > crate::memory_budget::bytes() / 4 {
        return Err("Prepared geometry exceeds probe budget".into());
    }
    w.span(w.u(o + g::POSITION), v * 3)?;
    if scan {
        w.finite(w.u(o + g::POSITION), v * 3)?;
    }
    w.span(w.u(o + g::INDICES), n)?;
    if scan && (0..n).any(|k| w.u(w.u(o + g::INDICES) + k) >= v) {
        return Err("Geometry index is out of range".into());
    }
    for (field, stride) in [
        (g::NORMAL, 3),
        (g::UV, 2),
        (g::UV1, 2),
        (g::COLOR, 3),
        (g::TANGENT, 4),
    ] {
        if w.u(o + field) != 0 {
            w.span(w.u(o + field), v * stride)?;
            if scan {
                w.finite(w.u(o + field), v * stride)?;
            }
        }
    }
    if w.u(o + g::MATERIAL_INDEX) != 0 {
        w.span(w.u(o + g::MATERIAL_INDEX), v)?;
    }
    w.reserved(o + g::RESERVED, 2)?;
    Ok(())
}

fn validate_with_workers(
    w: &Words<'_>,
    unchanged: &[u8],
    workers: usize,
) -> Result<(usize, Vec<usize>)> {
    let count = w.u(h::GEOMETRY_COUNT);
    // Prefix costs preserve each record's budget check position. Do not return a
    // later count/budget/span error before an earlier record's payload scan.
    let mut total = Some(0usize);
    let mut totals = Vec::with_capacity(count);
    let costs: Vec<_> = (0..count)
        .map(|i| {
            let o = w.u(h::GEOMETRY_OFFSET) + i * g::WORDS;
            // Same conservative compact, source-index and software-BVH budget.
            let cost = w.u(o + g::VERTEX_COUNT) * 14 + w.u(o + g::INDEX_COUNT) * 8;
            total = total.and_then(|n| n.checked_add(cost));
            totals.push(total);
            cost
        })
        .collect();
    if workers <= 1 {
        for (i, &total) in totals.iter().enumerate() {
            geometry(w, i, unchanged.get(i) != Some(&1), total)?;
        }
    } else {
        let next = AtomicUsize::new(0);
        let results: Vec<_> = (0..count).map(|_| OnceLock::new()).collect();
        std::thread::scope(|scope| {
            for _ in 0..workers.min(count) {
                let (next, results, totals) = (&next, &results, &totals);
                scope.spawn(move || {
                    loop {
                        let i = next.fetch_add(1, Ordering::Relaxed);
                        if i >= count {
                            break;
                        }
                        // Only owned strings cross threads; the public error text
                        // and per-record check order stay identical to serial scans.
                        let result = geometry(w, i, unchanged.get(i) != Some(&1), totals[i])
                            .map_err(|error| error.to_string());
                        let _ = results[i].set(result);
                    }
                });
            }
        });
        for result in results {
            result
                .into_inner()
                .expect("Missing geometry validation result")?;
        }
    }
    Ok((total.expect("Validated geometry budget"), costs))
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;

    pub(in crate::scene) fn fixture(count: usize, vertices: usize) -> Vec<u8> {
        let original = super::super::small_fixture();
        let mut words: Vec<_> = original
            .chunks_exact(4)
            .map(|b| u32::from_le_bytes(b.try_into().unwrap()))
            .collect();
        let template = words[32..32 + g::WORDS].to_vec();
        let table = words.len();
        words.resize(table + count * g::WORDS, 0);
        words[h::GEOMETRY_COUNT] = count as u32;
        words[h::GEOMETRY_OFFSET] = table as u32;
        for i in 0..count {
            let off = table + i * g::WORDS;
            words[off..off + g::WORDS].copy_from_slice(&template);
            words[off + g::VERTEX_COUNT] = vertices as u32;
            words[off + g::POSITION] = words.len() as u32;
            for v in 0..vertices {
                for axis in 0..3 {
                    words.push(((v as f32 - i as f32) * (axis + 1) as f32).to_bits());
                }
            }
            words[off + g::INDICES] = words.len() as u32;
            words.extend_from_slice(&[0, 1, 2]);
            words[off + g::NORMAL] = words.len() as u32;
            for _ in 0..vertices {
                words.extend_from_slice(&[0, 1f32.to_bits(), 0]);
            }
        }
        words[h::LENGTH] = words.len() as u32;
        words.into_iter().flat_map(u32::to_le_bytes).collect()
    }
    fn set(bytes: &mut [u8], word: usize, value: u32) {
        bytes[word * 4..word * 4 + 4].copy_from_slice(&value.to_le_bytes());
    }
    fn offset(bytes: &[u8], i: usize) -> usize {
        Words(bytes).u(h::GEOMETRY_OFFSET) + i * g::WORDS
    }
    fn expect_error(bytes: &[u8], unchanged: &[u8], expected: &str) {
        for workers in [1, 2, 4, 12] {
            let error = validate_with_workers(&Words(bytes), unchanged, workers)
                .unwrap_err()
                .to_string();
            assert_eq!(error, expected, "workers={workers}");
        }
    }
    #[test]
    fn parallel_geometry_validation_preserves_results_and_unaligned_input() {
        for (count, vertices) in [(1, 3), (7, 31), (12, 16384)] {
            let bytes = fixture(count, vertices);
            assert!(super::super::validate(&bytes).is_ok());
            let expected = validate_with_workers(&Words(&bytes), &[], 1).unwrap();
            let mut unaligned = vec![0xff];
            unaligned.extend_from_slice(&bytes);
            for workers in [2, 4, 12] {
                assert_eq!(
                    validate_with_workers(&Words(&bytes), &[], workers).unwrap(),
                    expected
                );
                assert_eq!(
                    validate_with_workers(&Words(&unaligned[1..]), &[], workers).unwrap(),
                    expected
                );
            }
        }
    }
    #[test]
    fn parallel_geometry_validation_keeps_descriptor_and_field_error_priority() {
        let original = fixture(8, 17);
        let first = offset(&original, 0);
        let last = offset(&original, 7);
        let position = Words(&original).u(first + g::POSITION);
        // A later count error must not precede an earlier finite-value error.
        let mut bytes = original.clone();
        set(&mut bytes, position, f32::NAN.to_bits());
        set(&mut bytes, last + g::VERTEX_COUNT, 0);
        expect_error(&bytes, &[], "Scene contains non-finite values");
        // The position scan still precedes the same record's invalid index span.
        set(&mut bytes, first + g::INDICES, u32::MAX);
        expect_error(&bytes, &[], "Scene contains non-finite values");
        set(&mut bytes, position, 0);
        expect_error(&bytes, &[], "Scene span is out of bounds");
        // Indices precede optional attributes and reserved fields.
        let mut bytes = original.clone();
        let indices = Words(&bytes).u(first + g::INDICES);
        set(&mut bytes, indices, u32::MAX);
        set(&mut bytes, first + g::NORMAL, u32::MAX);
        expect_error(&bytes, &[], "Geometry index is out of range");
        set(&mut bytes, indices, 0);
        expect_error(&bytes, &[], "Scene span is out of bounds");
        let mut bytes = original.clone();
        set(&mut bytes, first + g::RESERVED, 1);
        set(&mut bytes, last + g::VERTEX_COUNT, 0);
        expect_error(&bytes, &[], "Unknown scene descriptor fields");
        // Count and prefix-budget checks retain their position before payloads.
        let w = Words(&original);
        assert_eq!(
            geometry(&w, 0, true, Some(usize::MAX))
                .unwrap_err()
                .to_string(),
            "Prepared geometry exceeds probe budget"
        );
        assert_eq!(
            geometry(&w, 0, true, None).unwrap_err().to_string(),
            "Prepared geometry size overflow"
        );
        let mut bytes = original;
        set(&mut bytes, first + g::VERTEX_COUNT, 0);
        assert_eq!(
            geometry(&Words(&bytes), 0, true, None)
                .unwrap_err()
                .to_string(),
            "Invalid geometry counts"
        );
    }
    #[test]
    fn parallel_geometry_validation_skips_only_unchanged_payload_scans() {
        let mut bytes = fixture(6, 13);
        let first = offset(&bytes, 0);
        let position = Words(&bytes).u(first + g::POSITION);
        let indices = Words(&bytes).u(first + g::INDICES);
        set(&mut bytes, position, f32::INFINITY.to_bits());
        set(&mut bytes, indices, u32::MAX);
        let unchanged = [1, 0, 0, 0, 0, 0];
        for workers in [1, 2, 4, 12] {
            assert!(validate_with_workers(&Words(&bytes), &unchanged, workers).is_ok());
        }
        set(&mut bytes, first + g::RESERVED, 1);
        expect_error(&bytes, &unchanged, "Unknown scene descriptor fields");
        set(&mut bytes, first + g::POSITION, u32::MAX);
        expect_error(&bytes, &unchanged, "Scene span is out of bounds");
    }
}
