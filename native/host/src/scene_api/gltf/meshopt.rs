//! Native meshopt execution; the existing decoder/filter algorithms are unchanged.
use super::{number, span};
use anyhow::{Context, Result, bail, ensure};
use serde_json::Value;
use std::{collections::BTreeSet, sync::OnceLock};

#[derive(Clone, Copy)]
enum Kind {
    Attributes,
    Triangles,
    Indices,
}
#[derive(Clone, Copy)]
enum Filter {
    None,
    Oct,
    Quat,
    Exp,
}
#[derive(Clone, Copy)]
pub(super) struct Decoder {
    count: usize,
    stride: usize,
    len: usize,
    kind: Kind,
    filter: Filter,
}
impl Decoder {
    pub(super) fn new(ext: &Value) -> Result<Self> {
        let count = number(ext, "count")?;
        let stride = number(ext, "byteStride")?;
        let len = count
            .checked_mul(stride)
            .context("Meshopt decoded size overflow")?;
        ensure!(count > 0, "Empty meshopt buffer");
        crate::memory_budget::check(len, "Meshopt decoded buffer")?;
        let mode = ext["mode"].as_str().context("Missing Meshopt mode")?;
        let filter = ext["filter"].as_str().unwrap_or("NONE");
        let kind = match mode {
            "ATTRIBUTES" => {
                ensure!(
                    (4..=256).contains(&stride) && stride % 4 == 0,
                    "Invalid Meshopt attribute stride"
                );
                Kind::Attributes
            }
            "TRIANGLES" | "INDICES" => {
                ensure!(
                    [2, 4].contains(&stride)
                        && filter == "NONE"
                        && (mode != "TRIANGLES" || count % 3 == 0),
                    "Invalid Meshopt index layout"
                );
                if mode == "TRIANGLES" {
                    Kind::Triangles
                } else {
                    Kind::Indices
                }
            }
            _ => bail!("Unsupported Meshopt mode {mode}"),
        };
        ensure!(
            match filter {
                "NONE" => true,
                "OCTAHEDRAL" => [4, 8].contains(&stride),
                "QUATERNION" => stride == 8,
                "EXPONENTIAL" => stride % 4 == 0,
                _ => false,
            },
            "Invalid Meshopt filter {filter}"
        );
        let filter = match filter {
            "OCTAHEDRAL" => Filter::Oct,
            "QUATERNION" => Filter::Quat,
            "EXPONENTIAL" => Filter::Exp,
            _ => Filter::None,
        };
        Ok(Self {
            count,
            stride,
            len,
            kind,
            filter,
        })
    }
    fn alignment(self) -> usize {
        if matches!(self.kind, Kind::Attributes) {
            4
        } else {
            self.stride
        }
    }
    // SAFETY: callers supply len writable bytes aligned for the decoder/filter.
    // Upstream keeps dispatch tables read-only and all per-call state on the stack.
    unsafe fn run(self, source: &[u8], destination: *mut u8) -> Result<()> {
        let status = unsafe {
            match self.kind {
                Kind::Attributes => meshopt::ffi::meshopt_decodeVertexBuffer(
                    destination.cast(),
                    self.count,
                    self.stride,
                    source.as_ptr(),
                    source.len(),
                ),
                Kind::Triangles => meshopt::ffi::meshopt_decodeIndexBuffer(
                    destination.cast(),
                    self.count,
                    self.stride,
                    source.as_ptr(),
                    source.len(),
                ),
                Kind::Indices => meshopt::ffi::meshopt_decodeIndexSequence(
                    destination.cast(),
                    self.count,
                    self.stride,
                    source.as_ptr(),
                    source.len(),
                ),
            }
        };
        ensure!(status == 0, "Meshopt decoding failed ({status})");
        unsafe {
            match self.filter {
                Filter::None => (),
                Filter::Oct => meshopt::ffi::meshopt_decodeFilterOct(
                    destination.cast(),
                    self.count,
                    self.stride,
                ),
                Filter::Quat => meshopt::ffi::meshopt_decodeFilterQuat(
                    destination.cast(),
                    self.count,
                    self.stride,
                ),
                Filter::Exp => meshopt::ffi::meshopt_decodeFilterExp(
                    destination.cast(),
                    self.count,
                    self.stride,
                ),
            }
        };
        Ok(())
    }
    pub(super) fn reference(self, source: &[u8]) -> Result<Vec<u8>> {
        let mut aligned = vec![0u64; self.len.div_ceil(8)];
        let ptr = aligned.as_mut_ptr().cast::<u8>();
        // The legacy path owns an aligned scratch and copies its filtered bytes.
        unsafe {
            self.run(source, ptr)?;
            Ok(std::slice::from_raw_parts(ptr, self.len).to_vec())
        }
    }
    fn into(self, source: &[u8], destination: &mut [u8]) -> Result<()> {
        ensure!(
            destination.len() == self.len
                && destination.as_ptr().align_offset(self.alignment()) == 0,
            "Invalid Meshopt destination alignment or size"
        );
        // Source and destination are disjoint Rust slices established by the plan.
        unsafe { self.run(source, destination.as_mut_ptr()) }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Mode {
    Legacy,
    Serial,
    Parallel,
}
impl Mode {
    pub(super) fn from_env() -> Self {
        match std::env::var("MUTRACER_NATIVE_MESHOPT").as_deref() {
            Ok("legacy") => Self::Legacy,
            Ok("serial") => Self::Serial,
            _ => Self::Parallel,
        }
    }
}
#[derive(Default)]
pub(super) struct Stats {
    pub views: usize,
    pub bytes: usize,
    pub direct_views: usize,
    pub workers: usize,
}
struct Job {
    decoder: Decoder,
    source: usize,
    source_offset: usize,
    source_len: usize,
    target: usize,
    offset: usize,
}
// Planning does not mutate buffers. Any unsupported layout or metadata error
// falls back before writes, preserving legacy dependency and error precedence.
fn plan(json: &Value, buffers: &[gltf::buffer::Data]) -> Result<Vec<Job>> {
    let mut jobs = Vec::new();
    for view in json["bufferViews"].as_array().into_iter().flatten() {
        let Some(ext) = view["extensions"].get("EXT_meshopt_compression") else {
            continue;
        };
        let decoder = Decoder::new(ext)?;
        ensure!(
            decoder.len == number(view, "byteLength")?,
            "Meshopt decoded length mismatch"
        );
        let job = Job {
            decoder,
            source: number(ext, "buffer")?,
            source_offset: ext["byteOffset"].as_u64().unwrap_or(0) as usize,
            source_len: number(ext, "byteLength")?,
            target: number(view, "buffer")?,
            offset: view["byteOffset"].as_u64().unwrap_or(0) as usize,
        };
        span(
            &buffers.get(job.source).context("Invalid Meshopt source")?.0,
            job.source_offset,
            job.source_len,
        )?;
        let destination = span(
            &buffers.get(job.target).context("Invalid Meshopt target")?.0,
            job.offset,
            decoder.len,
        )?;
        ensure!(
            destination.as_ptr().align_offset(decoder.alignment()) == 0,
            "Unaligned Meshopt destination"
        );
        jobs.push(job);
    }
    let targets: BTreeSet<_> = jobs.iter().map(|job| job.target).collect();
    ensure!(
        jobs.iter().all(|job| !targets.contains(&job.source)),
        "Meshopt source/target dependency"
    );
    let mut regions: Vec<_> = jobs
        .iter()
        .map(|job| (job.target, job.offset, job.decoder.len))
        .collect();
    regions.sort_unstable();
    for pair in regions.windows(2) {
        ensure!(
            pair[0].0 != pair[1].0 || pair[0].1 + pair[0].2 <= pair[1].1,
            "Overlapping Meshopt targets"
        );
    }
    Ok(jobs)
}
fn legacy(json: &Value, buffers: &mut [gltf::buffer::Data]) -> Result<Stats> {
    let mut stats = Stats {
        workers: 1,
        ..Default::default()
    };
    for view in json["bufferViews"].as_array().into_iter().flatten() {
        let Some(ext) = view["extensions"].get("EXT_meshopt_compression") else {
            continue;
        };
        let source = span(
            &buffers
                .get(number(ext, "buffer")?)
                .context("Invalid Meshopt source")?
                .0,
            ext["byteOffset"].as_u64().unwrap_or(0) as usize,
            number(ext, "byteLength")?,
        )?;
        let decoded = Decoder::new(ext)?.reference(source)?;
        ensure!(
            decoded.len() == number(view, "byteLength")?,
            "Meshopt decoded length mismatch"
        );
        let target = buffers
            .get_mut(number(view, "buffer")?)
            .context("Invalid Meshopt target")?;
        let offset = view["byteOffset"].as_u64().unwrap_or(0) as usize;
        let end = offset
            .checked_add(decoded.len())
            .context("Meshopt target overflow")?;
        target
            .0
            .get_mut(offset..end)
            .context("Meshopt target exceeds buffer")?
            .copy_from_slice(&decoded);
        stats.views += 1;
        stats.bytes += decoded.len();
    }
    Ok(stats)
}
struct Work<'a> {
    index: usize,
    decoder: Decoder,
    source: &'a [u8],
    target: &'a mut [u8],
}
fn direct(jobs: &[Job], buffers: &mut [gltf::buffer::Data], workers: usize) -> Result<()> {
    let mut sources = vec![None; buffers.len()];
    let mut targets: Vec<Option<&mut [u8]>> = (0..jobs.len()).map(|_| None).collect();
    let target_ids: BTreeSet<_> = jobs.iter().map(|job| job.target).collect();
    for (id, buffer) in buffers.iter_mut().enumerate() {
        if !target_ids.contains(&id) {
            sources[id] = Some(buffer.0.as_slice());
            continue;
        }
        let mut entries: Vec<_> = jobs
            .iter()
            .enumerate()
            .filter(|(_, job)| job.target == id)
            .collect();
        entries.sort_unstable_by_key(|(_, job)| job.offset);
        let mut tail = buffer.0.as_mut_slice();
        let mut cursor = 0;
        for (index, job) in entries {
            let (_, remaining) = tail.split_at_mut(job.offset - cursor);
            let (region, remaining) = remaining.split_at_mut(job.decoder.len);
            targets[index] = Some(region);
            tail = remaining;
            cursor = job.offset + job.decoder.len;
        }
    }
    let mut batches: Vec<Vec<Work<'_>>> = (0..workers).map(|_| Vec::new()).collect();
    let mut loads = vec![0usize; workers];
    for (index, (job, target)) in jobs.iter().zip(targets).enumerate() {
        let source = sources[job.source].expect("Validated meshopt source");
        let source = &source[job.source_offset..job.source_offset + job.source_len];
        let worker = loads
            .iter()
            .enumerate()
            .min_by_key(|(_, bytes)| **bytes)
            .unwrap()
            .0;
        loads[worker] += job.decoder.len;
        batches[worker].push(Work {
            index,
            decoder: job.decoder,
            source,
            target: target.expect("Validated meshopt target"),
        });
    }
    let results: Vec<_> = (0..jobs.len()).map(|_| OnceLock::new()).collect();
    if workers == 1 {
        for work in batches.pop().unwrap() {
            let _ = results[work.index].set(work.decoder.into(work.source, work.target));
        }
    } else {
        std::thread::scope(|scope| {
            for batch in batches.into_iter().filter(|batch| !batch.is_empty()) {
                let results = &results;
                scope.spawn(move || {
                    for work in batch {
                        let _ =
                            results[work.index].set(work.decoder.into(work.source, work.target));
                    }
                });
            }
        });
    }
    // Return the first failing view in document order, not completion order.
    for result in results {
        result
            .into_inner()
            .context("Missing meshopt worker result")??;
    }
    Ok(())
}
pub(super) fn apply(json: &Value, buffers: &mut [gltf::buffer::Data], mode: Mode) -> Result<Stats> {
    apply_with_workers(
        json,
        buffers,
        mode,
        std::thread::available_parallelism().map_or(1, |n| n.get().min(12)),
    )
}
fn apply_with_workers(
    json: &Value,
    buffers: &mut [gltf::buffer::Data],
    mode: Mode,
    available: usize,
) -> Result<Stats> {
    if mode == Mode::Legacy {
        return legacy(json, buffers);
    }
    let Ok(jobs) = plan(json, buffers) else {
        return legacy(json, buffers);
    };
    let bytes = jobs.iter().map(|job| job.decoder.len).sum();
    let workers = if mode == Mode::Parallel && bytes >= 1_048_576 {
        available.min(jobs.len()).max(1)
    } else {
        1
    };
    direct(&jobs, buffers, workers)?;
    Ok(Stats {
        views: jobs.len(),
        direct_views: jobs.len(),
        bytes,
        workers,
    })
}

#[cfg(test)]
#[path = "meshopt_tests.rs"]
mod tests;
