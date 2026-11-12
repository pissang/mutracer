//! wgpu's queue callback also fires for failed Metal command buffers. Retain
//! each buffer submitted while recording a batch, then check execution
//! before credit. Metal queue forwarding avoids mixing wgpu and raw encoding.
//! Successful polling adds no handlers, extra GPU work, or waits.
#[derive(Default)]
pub(crate) struct Batch {
    #[cfg(target_os = "macos")]
    buffers:
        Vec<objc2::rc::Retained<objc2::runtime::ProtocolObject<dyn objc2_metal::MTLCommandBuffer>>>,
    #[cfg(test)]
    pub(crate) injected_error: Option<String>,
    #[cfg(test)]
    pub(crate) injected_kind: Option<FailureKind>,
}

// SAFETY: the retained Metal objects are never encoded or committed through
// this type. After capture, only the thread-safe status/error getters and
// retain/release are used. Registry ownership serializes access across polls.
#[cfg(target_os = "macos")]
unsafe impl Send for Batch {}

// Each recording belongs to the calling thread and spans encoding plus submit,
// including wgpu's upload/barrier buffers. Background preparation on another
// thread cannot be charged to this flight. Nesting restores the outer scope.
#[cfg(target_os = "macos")]
std::thread_local! {
    static RECORDINGS: std::cell::RefCell<Vec<Batch>> = const { std::cell::RefCell::new(Vec::new()) };
}
pub(crate) struct Recording(std::marker::PhantomData<*mut ()>);
impl Recording {
    pub(crate) fn new() -> Self {
        #[cfg(target_os = "macos")]
        RECORDINGS.with_borrow_mut(|stack| stack.push(Batch::default()));
        Self(std::marker::PhantomData)
    }
    pub(crate) fn finish(self) -> Batch {
        #[cfg(target_os = "macos")]
        {
            let batch = RECORDINGS.with_borrow_mut(|stack| stack.pop().unwrap());
            std::mem::forget(self);
            batch
        }
        #[cfg(not(target_os = "macos"))]
        {
            Batch::default()
        }
    }
}
impl Drop for Recording {
    fn drop(&mut self) {
        #[cfg(target_os = "macos")]
        RECORDINGS.with_borrow_mut(|stack| {
            stack.pop().unwrap();
        });
    }
}

#[cfg(target_os = "macos")]
type MetalQueue =
    objc2::rc::Retained<objc2::runtime::ProtocolObject<dyn objc2_metal::MTLCommandQueue>>;

#[cfg(target_os = "macos")]
pub(crate) fn observe_queue(queue: MetalQueue) -> MetalQueue {
    use objc2::rc::Retained;
    use std::ffi::c_void;
    unsafe extern "C" {
        fn mt_native_observe_metal_queue(
            queue: *mut c_void,
            record: extern "C" fn(*mut c_void),
        ) -> *mut c_void;
    }
    extern "C" fn record(buffer: *mut c_void) {
        RECORDINGS.with_borrow_mut(|stack| {
            if let Some(batch) = stack.last_mut() {
                // SAFETY: Metal returns a live autoreleased command buffer;
                // retain it before returning to the queue's caller.
                batch
                    .buffers
                    .push(unsafe { Retained::retain(buffer.cast()).unwrap() });
            }
        });
    }
    // SAFETY: the forwarding queue holds the original queue and returns +1.
    unsafe {
        Retained::from_raw(
            mt_native_observe_metal_queue(Retained::as_ptr(&queue) as *mut c_void, record).cast(),
        )
        .unwrap()
    }
}

/// Retained with GpuQueue, including queues cloned into an embedding viewer.
#[derive(Clone, Default)]
pub(crate) struct ObservedQueue {
    #[cfg(target_os = "macos")]
    queue: Option<MetalQueue>,
}
impl ObservedQueue {
    pub(crate) fn new(queue: &wgpu::Queue) -> Self {
        #[cfg(target_os = "macos")]
        if let Some(hal) = unsafe { queue.as_hal::<wgpu::hal::api::Metal>() } {
            use objc2::Message;
            unsafe extern "C" {
                fn mt_native_is_observed_metal_queue(queue: *mut std::ffi::c_void) -> bool;
            }
            let raw = hal.as_raw();
            if unsafe {
                mt_native_is_observed_metal_queue(
                    (raw as *const objc2::runtime::ProtocolObject<
                        dyn objc2_metal::MTLCommandQueue,
                    >)
                        .cast_mut()
                        .cast(),
                )
            } {
                return Self {
                    queue: Some(raw.retain()),
                };
            }
        }
        let _ = queue;
        Self::default()
    }
    pub(crate) fn available(&self) -> bool {
        #[cfg(target_os = "macos")]
        return self.queue.is_some();
        #[cfg(not(target_os = "macos"))]
        false
    }
    pub(crate) fn renew(&self) -> crate::Result<()> {
        #[cfg(target_os = "macos")]
        if let Some(queue) = &self.queue {
            unsafe extern "C" {
                fn mt_native_renew_metal_queue(queue: *mut std::ffi::c_void) -> bool;
            }
            if unsafe {
                mt_native_renew_metal_queue(objc2::rc::Retained::as_ptr(queue).cast_mut().cast())
            } {
                return Ok(());
            }
        }
        Err("Cannot replace this Metal command queue".into())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum FailureKind {
    Retry,
    SubmissionsIgnored,
    Unrecoverable,
}

pub(crate) fn request_device(
    adapter: &wgpu::Adapter,
    descriptor: &wgpu::DeviceDescriptor<'_>,
) -> crate::Result<(wgpu::Device, wgpu::Queue)> {
    #[cfg(target_os = "macos")]
    if !adapter.features().contains(descriptor.required_features)
        || !descriptor.required_limits.check_limits(&adapter.limits())
        || (descriptor
            .required_features
            .intersects(wgpu::Features::all_experimental_mask())
            && !descriptor.experimental_features.is_enabled())
    {
        // Preserve wgpu's ordinary validation and error types. HAL opening and
        // create_device_from_hal assume these preconditions were checked already.
        return Ok(pollster::block_on(adapter.request_device(descriptor))?);
    }
    #[cfg(target_os = "macos")]
    if let Some(hal) = unsafe { adapter.as_hal::<wgpu::hal::api::Metal>() } {
        use objc2::Message;
        use wgpu::hal::{Adapter as _, Queue as _};
        // SAFETY: open through this adapter with the exact requested features
        // and limits; replace only the queue with a forwarding Metal object.
        let mut opened = unsafe {
            hal.open(
                descriptor.required_features,
                &descriptor.required_limits,
                &descriptor.memory_hints,
            )?
        };
        let period = unsafe { opened.queue.get_timestamp_period() };
        let observed = observe_queue(opened.queue.as_raw().retain());
        opened.queue = unsafe { wgpu::hal::metal::Queue::queue_from_raw(observed, period) };
        drop(hal);
        return Ok(unsafe {
            adapter.create_device_from_hal::<wgpu::hal::api::Metal>(opened, descriptor)?
        });
    }
    Ok(pollster::block_on(adapter.request_device(descriptor))?)
}

impl Batch {
    /// NSError domain/code, independent of localized descriptions and logging.
    /// An unrelated failure in the same batch always prevents replay.
    pub(crate) fn failure_kind(&self) -> FailureKind {
        #[cfg(test)]
        if self.injected_error.is_some() {
            return self.injected_kind.unwrap_or(FailureKind::Unrecoverable);
        }
        #[cfg(target_os = "macos")]
        {
            use objc2_metal::{MTLCommandBuffer, MTLCommandBufferStatus};
            let mut kind = FailureKind::Unrecoverable;
            for buffer in &self.buffers {
                if buffer.status() != MTLCommandBufferStatus::Error {
                    continue;
                }
                let Some(error) = buffer.error() else {
                    return FailureKind::Unrecoverable;
                };
                let next = classify_metal_error(&error.domain().to_string(), error.code());
                match next {
                    FailureKind::Unrecoverable => return next,
                    FailureKind::SubmissionsIgnored => kind = next,
                    FailureKind::Retry if kind != FailureKind::SubmissionsIgnored => kind = next,
                    _ => {}
                }
            }
            return kind;
        }
        #[cfg(not(target_os = "macos"))]
        FailureKind::Unrecoverable
    }

    /// False means native execution is still pending, even if wgpu's callback
    /// has run. Scan every buffer so a later error cannot hide behind a wait.
    pub(crate) fn check(&self, identity: &str) -> crate::Result<bool> {
        #[cfg(test)]
        if let Some(error) = &self.injected_error {
            return Err(crate::status::fail(
                crate::Status::ContextFailed,
                format!("GPU execution failed ({identity}): {error}"),
            ));
        }
        #[cfg(target_os = "macos")]
        {
            use objc2_metal::{MTLCommandBuffer, MTLCommandBufferStatus};
            let mut complete = true;
            let mut failure = None;
            let diagnostic = std::env::var_os("MUTRACER_NATIVE_COMMAND_STATUS").as_deref()
                == Some(std::ffi::OsStr::new("1"));
            if diagnostic && self.buffers.is_empty() {
                eprintln!(
                    "NATIVE_COMMAND_STATUS {}",
                    serde_json::json!({
                        "flight": identity, "coverage": "unavailable", "buffers": 0,
                    })
                );
            }
            for (index, buffer) in self.buffers.iter().enumerate() {
                let status = buffer.status();
                let error = (diagnostic || status == MTLCommandBufferStatus::Error)
                    .then(|| {
                        buffer.error().map(|error| {
                            serde_json::json!({
                                "domain": error.domain().to_string(), "code": error.code(),
                                "description": error.localizedDescription().to_string(),
                            })
                        })
                    })
                    .flatten();
                if diagnostic {
                    eprintln!(
                        "NATIVE_COMMAND_STATUS {}",
                        serde_json::json!({
                            "flight": identity, "buffer": index, "status": status.0,
                            "error": error, "label": buffer.label().map(|label| label.to_string()),
                        })
                    );
                }
                if status == MTLCommandBufferStatus::Error {
                    failure = Some(format!(
                        "Metal buffer {index} status={} error={error:?}",
                        status.0
                    ));
                } else if status != MTLCommandBufferStatus::Completed {
                    complete = false;
                }
            }
            if let Some(error) = failure {
                return Err(crate::status::fail(
                    crate::Status::ContextFailed,
                    format!("GPU execution failed ({identity}): {error}"),
                ));
            }
            return Ok(complete);
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = identity;
            Ok(true)
        }
    }

    pub(crate) fn require_success(&self, identity: &str) -> crate::Result<()> {
        if !self.check(identity)? {
            return Err(crate::status::fail(
                crate::Status::ContextFailed,
                format!("Native command buffer still pending after GPU wait ({identity})"),
            ));
        }
        Ok(())
    }
}

#[cfg(any(target_os = "macos", test))]
fn classify_metal_error(domain: &str, code: isize) -> FailureKind {
    match (domain, code) {
        ("MTLCommandBufferErrorDomain", 1 | 2) => FailureKind::Retry,
        ("MTLCommandBufferErrorDomain", 4) => FailureKind::SubmissionsIgnored,
        _ => FailureKind::Unrecoverable,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn injected_execution_failure_is_context_failed_and_never_success() {
        let batch = Batch {
            #[cfg(target_os = "macos")]
            buffers: Vec::new(),
            injected_error: Some("VK_ERROR_DEVICE_LOST".into()),
            injected_kind: None,
        };
        let error = batch.check("windows test flight").unwrap_err();
        assert_eq!(
            crate::status::classify(error.as_ref(), crate::Status::Error),
            crate::Status::ContextFailed
        );
        assert!(error.to_string().contains("VK_ERROR_DEVICE_LOST"));
    }

    #[test]
    fn metal_error_classification_uses_domain_and_code() {
        assert_eq!(
            classify_metal_error("MTLCommandBufferErrorDomain", 4),
            FailureKind::SubmissionsIgnored
        );
        assert_eq!(
            classify_metal_error("MTLCommandBufferErrorDomain", 2),
            FailureKind::Retry
        );
        assert_eq!(
            classify_metal_error("MTLCommandBufferErrorDomain", 3),
            FailureKind::Unrecoverable
        );
        assert_eq!(
            classify_metal_error("OtherDomain", 4),
            FailureKind::Unrecoverable
        );
    }

    #[test]
    fn an_empty_completed_batch_is_successful() {
        let batch = Batch::default();
        assert!(batch.check("completed test flight").unwrap());
    }

    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "requires a real GPU; run npm run native:ci:gpu"]
    fn renewal_preserves_inflight_callbacks_and_only_replaces_one_queue() {
        use objc2::rc::Retained;
        use objc2_metal::MTLCommandBuffer;
        let first = crate::GpuDevice::with_backend(0).unwrap();
        let second = crate::GpuDevice::with_backend(0).unwrap();
        let submit = |gpu: &crate::GpuDevice| {
            let recording = Recording::new();
            gpu.queue.submit([]);
            recording.finish()
        };
        let old = submit(&first);
        let other = submit(&second);
        let (tx, rx) = std::sync::mpsc::channel();
        first.queue.on_submitted_work_done(move || {
            tx.send(()).unwrap();
        });
        first.queue.renew().unwrap();
        let new = submit(&first);
        let other_after = submit(&second);
        crate::GpuDevice::wait(&first.device).unwrap();
        crate::GpuDevice::wait(&second.device).unwrap();
        rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap();
        for batch in [&old, &new, &other, &other_after] {
            batch.require_success("queue renewal").unwrap();
        }
        assert_ne!(
            Retained::as_ptr(&old.buffers[0].commandQueue()),
            Retained::as_ptr(&new.buffers[0].commandQueue())
        );
        assert_eq!(
            Retained::as_ptr(&other.buffers[0].commandQueue()),
            Retained::as_ptr(&other_after.buffers[0].commandQueue())
        );
        let failed = Batch {
            injected_error: Some("post-renewal observed failure".into()),
            ..new
        };
        assert!(
            failed
                .check("renewed queue")
                .unwrap_err()
                .to_string()
                .contains("post-renewal observed failure")
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "requires a real GPU; run npm run native:ci:gpu"]
    fn invalid_device_requests_keep_wgpu_validation() {
        let gpu = crate::GpuDevice::with_backend(0).unwrap();
        let mut limits = gpu.adapter.limits();
        limits.max_bind_groups += 1;
        assert!(
            request_device(
                &gpu.adapter,
                &wgpu::DeviceDescriptor {
                    required_limits: limits,
                    ..Default::default()
                }
            )
            .is_err()
        );
        assert!(
            request_device(
                &gpu.adapter,
                &wgpu::DeviceDescriptor {
                    required_limits: gpu.adapter.limits(),
                    required_features: wgpu::Features::EXPERIMENTAL_RAY_QUERY,
                    experimental_features: wgpu::ExperimentalFeatures::disabled(),
                    ..Default::default()
                }
            )
            .is_err()
        );
    }

    #[test]
    #[ignore = "requires a real GPU; run npm run native:ci:gpu"]
    #[cfg(target_os = "macos")]
    fn records_submission_of_preencoded_buffers_and_excludes_discarded_buffers() {
        let gpu = crate::GpuDevice::with_backend(0).unwrap();
        assert_eq!(gpu.info.backend, wgpu::Backend::Metal);
        let buffer = gpu.device.create_buffer(&wgpu::BufferDescriptor {
            label: None,
            size: 16,
            usage: wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let mut encoder = gpu.device.create_command_encoder(&Default::default());
        encoder.clear_buffer(&buffer, 0, None);
        let commands = encoder.finish();
        let recording = Recording::new();
        gpu.queue.submit([commands]);
        let batch = recording.finish();
        assert!(
            !batch.buffers.is_empty(),
            "preencoded submission was not observed"
        );
        crate::GpuDevice::wait(&gpu.device).unwrap();
        assert!(batch.check("preencoded submission").unwrap());

        let recording = Recording::new();
        let mut encoder = gpu.device.create_command_encoder(&Default::default());
        encoder.clear_buffer(&buffer, 0, None);
        drop(encoder.finish());
        let batch = recording.finish();
        assert!(
            batch.buffers.is_empty(),
            "discarded buffer was charged to a flight"
        );
        assert!(batch.check("discarded encoder").unwrap());
    }
}
