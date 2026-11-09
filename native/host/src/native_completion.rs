//! wgpu's queue callback also fires for failed Metal command buffers. Retain
//! each buffer submitted while recording a batch, then check execution
//! before credit. Metal queue forwarding avoids mixing wgpu and raw encoding.
//! No handlers, extra GPU work, or waits are added to the polling path.
#[derive(Default)]
pub(crate) struct Batch {
    #[cfg(target_os = "macos")]
    buffers:
        Vec<objc2::rc::Retained<objc2::runtime::ProtocolObject<dyn objc2_metal::MTLCommandBuffer>>>,
    #[cfg(test)]
    pub(crate) injected_error: Option<String>,
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

pub(crate) fn request_device(
    adapter: &wgpu::Adapter,
    descriptor: &wgpu::DeviceDescriptor<'_>,
) -> crate::Result<(wgpu::Device, wgpu::Queue)> {
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

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    #[test]
    #[ignore = "requires a real GPU; run npm run native:ci:gpu"]
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
