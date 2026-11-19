//! Check the independent triangle at workgroup completion. Replays also check
//! before tracing so a window ending at replay onset cannot corrupt the prefix.
use crate::*;
use std::sync::{Arc, Mutex};
use wgpu::util::DeviceExt;

pub(super) const INTERVAL: Duration = Duration::from_secs(1);

pub fn enabled(gpu: &GpuDevice, hardware: bool, scene: &Scene) -> bool {
    hardware
        && gpu.info.backend == wgpu::Backend::Metal
        && scene.entry_point == "main"
        && scene
            .bind_groups
            .get(layout::group::OUTPUT)
            .is_some_and(|group| group.entries.len() == 4)
}
#[cfg(test)]
pub(crate) fn injects(gpu: &GpuDevice, start: u32, end: u32) -> bool {
    gpu.recovery_test
        .lock()
        .unwrap()
        .silent_sample
        .is_some_and(|sample| (start..end).contains(&sample))
}
#[derive(Clone)]
pub(super) struct Pipelines {
    pub replay: wgpu::ComputePipeline,
    #[cfg(test)]
    pub miss: wgpu::ComputePipeline,
}

#[derive(Clone)]
pub(super) struct Guard {
    pub resources: Arc<Resources>,
    pub pipelines: Pipelines,
}
impl Pipelines {
    pub fn bind(self, gpu: &GpuDevice, scene: Option<&Guard>) -> Result<Guard> {
        let resources = match scene {
            Some(guard) => guard.resources.clone(),
            None => Arc::new(Resources::new(gpu)?),
        };
        Ok(Guard {
            resources,
            pipelines: self,
        })
    }
}
pub struct Resources {
    tlas: wgpu::Tlas,
    pub unused_flag: wgpu::Buffer,
    #[cfg(test)]
    window: Option<wgpu::Buffer>,
    _blas: wgpu::Blas,
    _vertices: wgpu::Buffer,
}
impl Resources {
    pub fn new(gpu: &GpuDevice) -> Result<Self> {
        let device = &gpu.device;
        let queue = &gpu.queue;
        let vertices: [f32; 9] = [-2., -2., 0., 4., -2., 0., -2., 4., 0.];
        let bytes: Vec<u8> = vertices.iter().flat_map(|v| v.to_le_bytes()).collect();
        let vertices = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Query canary triangle"),
            contents: &bytes,
            usage: wgpu::BufferUsages::BLAS_INPUT,
        });
        let size = wgpu::BlasTriangleGeometrySizeDescriptor {
            vertex_format: wgpu::VertexFormat::Float32x3,
            vertex_count: 3,
            index_format: None,
            index_count: None,
            flags: wgpu::AccelerationStructureGeometryFlags::OPAQUE,
        };
        let blas = device.create_blas(
            &wgpu::CreateBlasDescriptor {
                label: Some("Query canary BLAS"),
                flags: wgpu::AccelerationStructureFlags::PREFER_FAST_TRACE,
                update_mode: wgpu::AccelerationStructureUpdateMode::Build,
            },
            wgpu::BlasGeometrySizeDescriptors::Triangles {
                descriptors: vec![size.clone()],
            },
        );
        let mut encoder = device.create_command_encoder(&Default::default());
        encoder.build_acceleration_structures(
            [&wgpu::BlasBuildEntry {
                blas: &blas,
                geometry: wgpu::BlasGeometries::TriangleGeometries(vec![
                    wgpu::BlasTriangleGeometry {
                        size: &size,
                        vertex_buffer: &vertices,
                        first_vertex: 0,
                        vertex_stride: 12,
                        index_buffer: None,
                        first_index: None,
                        transform_buffer: None,
                        transform_buffer_offset: None,
                    },
                ]),
            }],
            std::iter::empty(),
        );
        let submission = queue.submit([encoder.finish()]);
        device.poll(wgpu::PollType::Wait {
            submission_index: Some(submission),
            timeout: Some(Duration::from_secs(30)),
        })?;
        let mut tlas = device.create_tlas(&wgpu::CreateTlasDescriptor {
            label: Some("Query canary TLAS"),
            max_instances: 1,
            flags: wgpu::AccelerationStructureFlags::PREFER_FAST_TRACE,
            update_mode: wgpu::AccelerationStructureUpdateMode::Build,
        });
        tlas[0] = Some(wgpu::TlasInstance::new(
            &blas,
            [1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0.],
            0,
            255,
        ));
        let mut encoder = device.create_command_encoder(&Default::default());
        encoder.build_acceleration_structures(std::iter::empty(), [&tlas]);
        let submission = queue.submit([encoder.finish()]);
        device.poll(wgpu::PollType::Wait {
            submission_index: Some(submission),
            timeout: Some(Duration::from_secs(30)),
        })?;

        let buffer = |size| {
            device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("Workgroup canary state"),
                size,
                mapped_at_creation: false,
                usage: wgpu::BufferUsages::STORAGE
                    | wgpu::BufferUsages::COPY_SRC
                    | wgpu::BufferUsages::COPY_DST,
            })
        };
        Ok(Self {
            tlas,
            unused_flag: buffer(4),
            #[cfg(test)]
            window: gpu
                .recovery_test
                .lock()
                .unwrap()
                .query_window
                .then(|| buffer(20)),
            _blas: blas,
            _vertices: vertices,
        })
    }
    pub(super) fn entries<'a>(&'a self, flag: &'a wgpu::Buffer) -> Vec<wgpu::BindGroupEntry<'a>> {
        #[allow(unused_mut)]
        let mut entries = vec![
            wgpu::BindGroupEntry {
                binding: 4,
                resource: self.tlas.as_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 5,
                resource: flag.as_entire_binding(),
            },
        ];
        #[cfg(test)]
        if let Some(window) = &self.window {
            entries.push(wgpu::BindGroupEntry {
                binding: 15,
                resource: window.as_entire_binding(),
            });
        }
        entries
    }
}
pub fn layout_entries(#[cfg(test)] window: bool) -> Vec<wgpu::BindGroupLayoutEntry> {
    let mut entries = Vec::new();
    #[cfg(test)]
    let bindings = [4, 5].into_iter().chain(window.then_some(15));
    #[cfg(not(test))]
    let bindings = [4, 5];
    for binding in bindings {
        entries.push(wgpu::BindGroupLayoutEntry {
            binding,
            visibility: wgpu::ShaderStages::COMPUTE,
            count: None,
            ty: if binding == 4 {
                wgpu::BindingType::AccelerationStructure {
                    vertex_return: false,
                }
            } else {
                wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Storage { read_only: false },
                    has_dynamic_offset: false,
                    min_binding_size: None,
                }
            },
        });
    }
    entries
}
pub fn instrument(source: &str) -> Result<String> {
    let entry = "@compute @workgroup_size(8, 8, 1)\nfn main(@builtin(global_invocation_id) globalId: vec3u)";
    if !source.contains(entry) {
        return Err("Unexpected HWRT beauty entry".into());
    }
    // The AOT scene owns triangle/material intersection semantics. Extend its
    // one query initializer so ordinary rays and the private AS share traversal.
    let query = "rayQueryInitialize(&query, mtAcceleration, RayDesc(flags, 255u,";
    let committed = "let hit = rayQueryGetCommittedIntersection(&query);";
    if !source.contains("fn mtTrace(") || !source.contains(query) || !source.contains(committed) {
        return Err("Missing native HWRT intersection routine".into());
    }
    let mut source=source.replace(entry, "fn mtBeauty(globalId: vec3u)")
        .replace("mtTrace(", "mtTrace(mtAcceleration, false, ")
        .replace("fn mtTrace(mtAcceleration, false, ", "fn mtTrace(accel: acceleration_structure, markerRay: bool, ")
        .replace(query, "rayQueryInitialize(&query, accel, RayDesc(select(flags, 5u, markerRay), 255u /* all instances */,")
        .replace(committed, "let hit = rayQueryGetCommittedIntersection(&query); if markerRay { var marker: MtHit; marker.kind = hit.kind; return marker; }");
    source.push_str(include_str!("workgroup_canary.wgsl"));
    Ok(source)
}

#[cfg(test)]
pub(super) fn inject_misses(mut source: String, window: bool) -> String {
    let mask = if window {
        source.push_str(include_str!("query_guard/test_window.wgsl"));
        "select(mtWindowMask(markerRay), 0u, MT_TEST_MISS)"
    } else {
        "select(255u, 0u, MT_TEST_MISS)"
    };
    source = source.replace("255u /* all instances */", mask);
    source.push_str("\noverride MT_TEST_MISS: bool = false;\n");
    source
}

#[cfg(target_os = "macos")]
pub(super) fn execution_barrier_source(source: &str) -> Option<wgpu::ShaderSource<'static>> {
    use wgpu::naga::{Barrier, Statement, front::wgsl};
    let mut module = wgsl::parse_str(source).ok()?;
    let (_, rendezvous) = module
        .functions
        .iter_mut()
        .find(|(_, f)| f.name.as_deref() == Some("mtCanaryRendezvous"))?;
    // Group completion orders execution. No lane consumes another lane's memory.
    for statement in rendezvous.body.iter_mut() {
        if let Statement::ControlBarrier(scope) = statement {
            if *scope == Barrier::WORK_GROUP {
                *scope = Barrier::empty();
            }
        }
    }
    Some(wgpu::ShaderSource::Naga(std::borrow::Cow::Owned(module)))
}
#[derive(Clone)]
struct MappedReceipt {
    buffer: wgpu::Buffer,
    result: Arc<Mutex<Option<std::result::Result<(), String>>>>,
}
impl MappedReceipt {
    pub(super) fn copy(
        gpu: &GpuDevice,
        flag: &wgpu::Buffer,
        encoder: &mut wgpu::CommandEncoder,
    ) -> Self {
        let buffer = gpu.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Checkpoint query receipt"),
            size: 4,
            usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        encoder.copy_buffer_to_buffer(flag, 0, &buffer, 0, 4);
        Self {
            buffer,
            result: Default::default(),
        }
    }
    pub(super) fn map(&self) {
        let result = self.result.clone();
        self.buffer.map_async(wgpu::MapMode::Read, .., move |r| {
            *result.lock().unwrap() = Some(r.map_err(|e| e.to_string()));
        });
    }
    fn bits(&self) -> u32 {
        let view = self.buffer.slice(..).get_mapped_range().unwrap();
        u32::from_le_bytes(view[..4].try_into().unwrap())
    }
    pub fn check(&self) -> Result<bool> {
        match &*self.result.lock().unwrap() {
            None => Ok(false),
            Some(Err(e)) => Err(format!("Tail query readback failed: {e}").into()),
            Some(Ok(())) => {
                if self.bits() == 0 {
                    Ok(true)
                } else {
                    Err(status::fail(
                        Status::ContextFailed,
                        "Silent Metal query failure detected by workgroup canary",
                    ))
                }
            }
        }
    }
}
#[cfg(target_os = "macos")]
#[derive(Clone)]
pub(super) struct SharedFlag(
    objc2::rc::Retained<objc2::runtime::ProtocolObject<dyn objc2_metal::MTLBuffer>>,
);
// The object is retained exactly like wgpu-hal's Metal Buffer. Its only host
// access after initialization occurs under registry ownership after completion.
#[cfg(target_os = "macos")]
unsafe impl Send for SharedFlag {}
#[cfg(target_os = "macos")]
unsafe impl Sync for SharedFlag {}
#[cfg(target_os = "macos")]
impl SharedFlag {
    pub(super) fn allocate(
        device: &wgpu::Device,
        desc: &wgpu::BufferDescriptor,
    ) -> Option<(wgpu::Buffer, Self)> {
        use objc2_metal::{MTLBuffer, MTLDevice, MTLResourceOptions};
        let raw = {
            let hal = unsafe { device.as_hal::<wgpu::hal::api::Metal>() }?;
            let raw = hal.raw_device();
            if !raw.hasUnifiedMemory() {
                return None;
            }
            raw.newBufferWithLength_options(
                desc.size.try_into().ok()?,
                MTLResourceOptions::StorageModeShared,
            )?
        };
        unsafe {
            raw.contents()
                .cast::<u8>()
                .as_ptr()
                .write_bytes(0, desc.size as usize);
        }
        let buffer = unsafe {
            device.create_buffer_from_hal::<wgpu::hal::api::Metal>(
                wgpu::hal::metal::Device::buffer_from_raw(raw.clone(), desc.size),
                desc,
            )
        };
        Some((buffer, Self(raw)))
    }
    pub(super) fn fill_idle(&mut self, bytes: &[u8]) {
        use objc2_metal::MTLBuffer;
        assert!(bytes.len() <= self.0.length());
        unsafe {
            std::ptr::copy_nonoverlapping(
                bytes.as_ptr(),
                self.0.contents().cast::<u8>().as_ptr(),
                bytes.len(),
            );
        }
    }
}
#[derive(Clone)]
pub struct Receipt(ReceiptSource);
#[derive(Clone)]
enum ReceiptSource {
    Copy(MappedReceipt),
    #[cfg(target_os = "macos")]
    Shared(SharedFlag, Arc<std::sync::OnceLock<u32>>),
}
impl Receipt {
    pub(super) fn copy(
        gpu: &GpuDevice,
        flag: &wgpu::Buffer,
        encoder: &mut wgpu::CommandEncoder,
    ) -> Self {
        Self(ReceiptSource::Copy(MappedReceipt::copy(gpu, flag, encoder)))
    }
    pub(super) fn map(&self) {
        if let ReceiptSource::Copy(copy) = &self.0 {
            copy.map();
        }
    }
    fn observed(&self) -> Option<u32> {
        match &self.0 {
            ReceiptSource::Copy(copy) => {
                matches!(&*copy.result.lock().unwrap(), Some(Ok(()))).then(|| copy.bits())
            }
            #[cfg(target_os = "macos")]
            ReceiptSource::Shared(_, seen) => seen.get().copied(),
        }
    }
    pub fn failed(&self) -> bool {
        self.observed().is_some_and(|v| v != 0)
    }
    pub fn check(&self) -> Result<bool> {
        match &self.0 {
            ReceiptSource::Copy(copy) => copy.check(),
            #[cfg(target_os = "macos")]
            ReceiptSource::Shared(raw, seen) => {
                use objc2_metal::MTLBuffer;
                // Batch::check reaches this load only after every native buffer
                // has completed. The target cannot submit again before retirement.
                let bits = seen.get_or_init(|| unsafe {
                    raw.0.contents().cast::<u32>().as_ptr().read_volatile()
                });
                if *bits == 0 {
                    Ok(true)
                } else {
                    Err(status::fail(
                        Status::ContextFailed,
                        "Silent Metal query failure detected by workgroup canary",
                    ))
                }
            }
        }
    }
}
pub struct Checkpoint {
    pub(crate) start: u32,
    pub(crate) captured: std::time::Instant,
    native: Mutex<native_completion::Batch>,
    complete: std::sync::atomic::AtomicBool,
    copies: Vec<(wgpu::Buffer, Option<wgpu::Buffer>)>,
    pub(crate) flag: wgpu::Buffer,
    #[cfg(target_os = "macos")]
    pub(super) shared: Option<SharedFlag>,
    pub group: wgpu::BindGroup,
}
impl Checkpoint {
    pub(super) fn direct_receipt(&self) -> Option<Receipt> {
        #[cfg(target_os = "macos")]
        {
            self.shared
                .as_ref()
                .map(|raw| Receipt(ReceiptSource::Shared(raw.clone(), Default::default())))
        }
        #[cfg(not(target_os = "macos"))]
        {
            None
        }
    }

    pub fn check(&self) -> Result<bool> {
        if self.complete.load(std::sync::atomic::Ordering::Acquire) {
            return Ok(true);
        }
        let done = self
            .native
            .lock()
            .map_err(|_| "Checkpoint proof is poisoned")?
            .check("sampling checkpoint")?;
        if done {
            self.complete
                .store(true, std::sync::atomic::Ordering::Release);
        }
        Ok(done)
    }
    pub fn is_invalid(&self) -> bool {
        self.check().is_err()
    }
    pub fn capture(scene: &GpuScene, target: &Target, start: u32) -> Self {
        let device = &scene.gpu.device;
        let resources = &target.query_guard.as_ref().unwrap().resources;
        let descriptor = wgpu::BufferDescriptor {
            label: Some("Checkpoint query flag"),
            size: 4,
            usage: wgpu::BufferUsages::STORAGE
                | wgpu::BufferUsages::COPY_SRC
                | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        };
        #[cfg(target_os = "macos")]
        let allocation = SharedFlag::allocate(device, &descriptor);
        #[cfg(target_os = "macos")]
        let (flag, shared) = allocation
            .map(|(b, r)| (b, Some(r)))
            .unwrap_or_else(|| (device.create_buffer(&descriptor), None));
        #[cfg(not(target_os = "macos"))]
        let flag = device.create_buffer(&descriptor);
        let mut entries: Vec<_> = (0..4)
            .map(|binding| wgpu::BindGroupEntry {
                binding,
                resource: target.output(binding).unwrap().as_entire_binding(),
            })
            .collect();
        entries.extend(resources.entries(&flag));
        let pipeline = target.pipeline.as_ref().unwrap_or(&scene.pipeline);
        let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Guarded sampling outputs"),
            layout: &pipeline.get_bind_group_layout(3),
            entries: &entries,
        });
        let recording = native_completion::Recording::new();
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("Sampling checkpoint"),
        });
        let copies = (0..4)
            .map(|i| {
                let original = target.output(i).unwrap().clone();
                if start == 0 {
                    // New buffers and a successful target reset define the empty sums.
                    return (original, None);
                }
                let snapshot = device.create_buffer(&wgpu::BufferDescriptor {
                    label: Some("Sampling checkpoint image"),
                    size: original.size(),
                    usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::COPY_SRC,
                    mapped_at_creation: false,
                });
                encoder.copy_buffer_to_buffer(&original, 0, &snapshot, 0, original.size());
                (original, Some(snapshot))
            })
            .collect();
        if start != 0 {
            scene.gpu.queue.submit([encoder.finish()]);
        }
        Self {
            start,
            captured: std::time::Instant::now(),
            native: Mutex::new(recording.finish()),
            complete: std::sync::atomic::AtomicBool::new(start == 0),
            copies,
            flag,
            #[cfg(target_os = "macos")]
            shared,
            group,
        }
    }
    fn read(
        self: &Arc<Self>,
        scene: &GpuScene,
        deadline: std::time::Instant,
    ) -> Result<native_completion::Batch> {
        let recording = native_completion::Recording::new();
        let mut encoder =
            scene
                .gpu
                .device
                .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                    label: Some("Verify checkpoint epoch"),
                });
        let receipt = Receipt::copy(&scene.gpu, &self.flag, &mut encoder);
        scene.gpu.queue.submit([encoder.finish()]);
        receipt.map();
        let mut batch = recording.finish();
        batch.health = Some(receipt);
        batch.checkpoint = Some(self.clone());
        batch.deadline = Some(deadline);
        wait(scene, deadline)?;
        Ok(batch)
    }
    fn restore(
        &self,
        scene: &GpuScene,
        deadline: std::time::Instant,
    ) -> Result<native_completion::Batch> {
        self.native
            .lock()
            .map_err(|_| "Checkpoint proof is poisoned")?
            .require_success("sampling checkpoint")?;
        let recording = native_completion::Recording::new();
        let mut encoder =
            scene
                .gpu
                .device
                .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                    label: Some("Restore sampling checkpoint"),
                });
        for (original, snapshot) in &self.copies {
            if let Some(snapshot) = snapshot {
                encoder.copy_buffer_to_buffer(snapshot, 0, original, 0, original.size());
            } else {
                encoder.clear_buffer(original, 0, None);
            }
        }
        encoder.clear_buffer(&self.flag, 0, None);
        scene.gpu.queue.submit([encoder.finish()]);
        #[allow(unused_mut)]
        let mut completion = recording.finish();
        #[cfg(test)]
        {
            let mut hook = scene.gpu.recovery_test.lock().unwrap();
            if hook.restore_failures > 0 {
                hook.restore_failures -= 1;
                completion.injected_error =
                    Some("controlled ignored checkpoint restoration".into());
                completion.injected_kind = Some(native_completion::FailureKind::SubmissionsIgnored);
            }
        }
        wait(scene, deadline)?;
        Ok(completion)
    }
}
impl GpuScene {
    pub(crate) fn verify_sampling_target(&self, target: &Target, end: u32) -> Result<bool> {
        let checkpoint = match &target.sampling_batch {
            None => None,
            Some(state) => {
                let mut state = state.lock().unwrap();
                if state.mirror_pending && end > 0 {
                    self.write_last_sample(target, end);
                    state.mirror_pending = false;
                }
                if state.verified >= end {
                    return Ok(false);
                }
                state.checkpoint.clone()
            }
        };
        let Some(checkpoint) = checkpoint else {
            return Ok(false);
        };
        let batch = if let Some(health) = checkpoint.direct_receipt() {
            {
                let mut batch = native_completion::Batch::default();
                batch.health = Some(health);
                batch.checkpoint = Some(checkpoint.clone());
                batch
            }
        } else {
            checkpoint.read(self, std::time::Instant::now() + Duration::from_secs(30))?
        };
        let mut repaired = false;
        if let Err(error) = batch.require_success("checkpoint epoch verification") {
            repaired = true;
            self.repair_target(target, checkpoint.start, end, &batch, error)?;
        }
        target
            .sampling_batch
            .as_ref()
            .unwrap()
            .lock()
            .unwrap()
            .verified = end;
        Ok(repaired)
    }
}
pub fn repair(
    scene: &GpuScene,
    target: &Target,
    start: u32,
    end: u32,
    failed: &native_completion::Batch,
    original: Box<dyn std::error::Error>,
) -> Result<()> {
    use native_completion::FailureKind;
    #[cfg(test)]
    {
        let mut injection = scene.gpu.recovery_test.lock().unwrap();
        injection.silent_sample = None;
        injection.repairs += 1;
    }
    let begun = std::time::Instant::now();
    let deadline = begun + crate::recovery::TIME_LIMIT;
    let checkpoint = failed
        .checkpoint
        .as_ref()
        .ok_or("Missing sampling checkpoint")?;
    let mut retries = 0;
    let mut silent_replays = 0u32;
    let mut renewed = false;
    let result = (|| -> Result<()> {
        wait(scene, deadline)?;
        if failed.failure_kind() == FailureKind::SubmissionsIgnored {
            scene.gpu.queue.renew()?;
            renewed = true;
        }
        loop {
            if retries >= crate::recovery::MAX_RETRIES || std::time::Instant::now() >= deadline {
                return Err("Checkpoint repair exceeded its bound".into());
            }
            let restored = checkpoint.restore(scene, deadline)?;
            if let Err(error) = restored.require_success("checkpoint restoration") {
                if restored.failure_kind() == FailureKind::Unrecoverable {
                    return Err(error);
                }
                if restored.failure_kind() == FailureKind::SubmissionsIgnored {
                    scene.gpu.queue.renew()?;
                    renewed = true;
                }
                retries += 1;
                continue;
            }
            let mut cursor = checkpoint.start;
            let mut retry = false;
            while cursor < end {
                let count = target
                    .sampling_batch
                    .as_ref()
                    .unwrap()
                    .lock()
                    .unwrap()
                    .limit()
                    .min(end - cursor);
                #[allow(unused_mut)]
                let mut batch = scene.dispatch_target_checkpointed(
                    target,
                    cursor,
                    count,
                    None,
                    Some(checkpoint.clone()),
                )?;
                #[cfg(test)]
                {
                    let mut hook = scene.gpu.recovery_test.lock().unwrap();
                    hook.replayed_ranges.push(cursor..cursor + count);
                    if hook.repair_failures > 0 {
                        hook.repair_failures -= 1;
                        batch.injected_error = Some("controlled persistent repair failure".into());
                        batch.injected_kind = Some(FailureKind::Retry);
                    }
                }
                wait(scene, deadline)?;
                if let Err(error) = batch.require_success("checkpoint sampling replay") {
                    if batch.failure_kind() == FailureKind::Unrecoverable {
                        return Err(error);
                    }
                    if batch.failure_kind() == FailureKind::SubmissionsIgnored {
                        scene.gpu.queue.renew()?;
                        renewed = true;
                    }
                    retries += 1;
                    retry = true;
                    break;
                }
                cursor += count;
            }
            if retry {
                continue;
            }
            let mut batch = checkpoint.read(scene, deadline)?;
            if batch.health.as_ref().is_some_and(Receipt::failed) {
                let receipt = batch.health.take();
                let executed = batch.require_success("replay receipt native completion");
                batch.health = receipt;
                // A continuous window can span many short replays. Only a proven
                // native success may retry against the wall deadline alone.
                if executed.is_ok() {
                    silent_replays += 1;
                    continue;
                }
            }
            match batch.require_success("checkpoint replay verification") {
                Ok(()) => return Ok(()),
                Err(error) => {
                    if batch.failure_kind() == FailureKind::Unrecoverable {
                        return Err(error);
                    }
                    if batch.failure_kind() == FailureKind::SubmissionsIgnored {
                        scene.gpu.queue.renew()?;
                        renewed = true;
                    }
                    retries += 1;
                }
            }
        }
    })();
    if result.is_ok() {
        let mut state = target.sampling_batch.as_ref().unwrap().lock().unwrap();
        state.verified = end;
        state.reset_adaptation();
    }
    native_log!(
        "{}",
        serde_json::json!({"nativeFlightRecovery":{"flight":[start,end],"checkpoint":checkpoint.start,"retries":retries,"silentReplays":silent_replays,"renewedQueue":renewed,"milliseconds":begun.elapsed().as_secs_f64()*1000.,"reason":original.to_string(),"recovered":result.is_ok(),"transactional":true,"error":result.as_ref().err().map(ToString::to_string)}})
    );
    result.map_err(|e| {
        status::fail(
            Status::ContextFailed,
            format!("{original}; checkpoint replay failed: {e}"),
        )
    })
}
fn wait(scene: &GpuScene, deadline: std::time::Instant) -> Result<()> {
    let remaining = deadline
        .checked_duration_since(std::time::Instant::now())
        .ok_or("Checkpoint operation exceeded its deadline")?;
    scene.gpu.device.poll(wgpu::PollType::Wait {
        submission_index: None,
        timeout: Some(remaining),
    })?;
    scene.gpu.loss.check()
}

/// A retry legitimately executes another marker. Require every committed slot
/// and bound duplicates by the independently recorded CPU submission attempts.
#[cfg(test)]
pub(crate) fn assert_audit_attempts(gpu: &GpuDevice, start: u32, counts: &[u32]) {
    let hook = gpu.recovery_test.lock().unwrap();
    for (offset, count) in counts.iter().enumerate() {
        let sample = start + offset as u32;
        let attempts = 1 + hook
            .replayed_ranges
            .iter()
            .filter(|range| range.contains(&sample))
            .count() as u32;
        assert!(
            (1..=attempts).contains(count),
            "sample={sample}: GPU tail count {count} outside recorded {attempts} attempts"
        );
    }
}

#[cfg(test)]
pub(crate) mod template_tests;
#[cfg(test)]
mod tests;
