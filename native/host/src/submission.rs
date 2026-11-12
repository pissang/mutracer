//! Coordinate a shared presentation queue with background native uploads.
use std::sync::{Arc, Condvar, Mutex};

#[cfg(target_os = "macos")]
type MetalSharedEvent =
    objc2::rc::Retained<objc2::runtime::ProtocolObject<dyn objc2_metal::MTLSharedEvent>>;

#[derive(Default)]
struct State {
    paused: bool,
    configuring: bool,
    active: usize,
}

/// Pause submissions outside the embedding UI's update callback, where its
/// framework may configure a surface. CPU preparation and pipeline compilation
/// continue while paused. Resume before issuing native GPU work or destroying
/// contexts. Surface configuration must not race queue submission (wgpu contract).
#[derive(Default)]
pub struct SubmissionGate {
    state: Mutex<State>,
    changed: Condvar,
}
impl SubmissionGate {
    pub fn pause(&self) {
        let mut state = self.state.lock().unwrap();
        state.paused = true;
        while state.active != 0 {
            state = self.changed.wait(state).unwrap();
        }
    }
    pub fn resume(&self) {
        self.state.lock().unwrap().paused = false;
        self.changed.notify_all();
    }
    // Separate from the host's pause flag: configuration must not resume a
    // queue that the embedding UI intentionally left paused. The guard also
    // serializes configurations and releases waiters on unwinding.
    fn configuration(&self) -> Configuration<'_> {
        let mut state = self.state.lock().unwrap();
        while state.configuring {
            state = self.changed.wait(state).unwrap();
        }
        state.configuring = true;
        while state.active != 0 {
            state = self.changed.wait(state).unwrap();
        }
        Configuration(self)
    }
    fn enter(&self) -> Submission<'_> {
        let mut state = self.state.lock().unwrap();
        while state.paused || state.configuring {
            state = self.changed.wait(state).unwrap();
        }
        state.active += 1;
        Submission(self)
    }
}
struct Configuration<'a>(&'a SubmissionGate);
impl Drop for Configuration<'_> {
    fn drop(&mut self) {
        self.0.state.lock().unwrap().configuring = false;
        self.0.changed.notify_all();
    }
}
struct Submission<'a>(&'a SubmissionGate);
impl Drop for Submission<'_> {
    fn drop(&mut self) {
        self.0.state.lock().unwrap().active -= 1;
        self.0.changed.notify_all();
    }
}

#[derive(Clone)]
pub(crate) struct GpuQueue {
    queue: wgpu::Queue,
    pub(crate) observed: crate::native_completion::ObservedQueue,
    submit_lock: Arc<Mutex<()>>,
    #[cfg(target_os = "macos")]
    metal_barrier: Arc<Mutex<Option<(MetalSharedEvent, u64)>>>,
    gate: Option<Arc<SubmissionGate>>,
    #[cfg(test)]
    readbacks: Arc<std::sync::atomic::AtomicU64>,
}
impl GpuQueue {
    pub(crate) fn new(queue: wgpu::Queue, gate: Option<Arc<SubmissionGate>>) -> Self {
        Self {
            observed: crate::native_completion::ObservedQueue::new(&queue),
            queue,
            submit_lock: Default::default(),
            #[cfg(target_os = "macos")]
            metal_barrier: Default::default(),
            gate,
            #[cfg(test)]
            readbacks: Default::default(),
        }
    }
    pub(crate) fn renew(&self) -> crate::Result<()> {
        self.exclusive_submit(|_| self.observed.renew())
    }
    // DownloadBuffer submits through the raw queue, so enter the same gate as submit.
    pub(crate) fn read_buffer(
        &self,
        device: &wgpu::Device,
        source: wgpu::BufferSlice<'_>,
    ) -> crate::Result<Vec<u8>> {
        #[cfg(test)]
        self.record_readback();
        let (send, receive) = std::sync::mpsc::channel();
        {
            let _submission = self.gate.as_ref().map(|gate| gate.enter());
            let _exclusive = self.submit_lock.lock().unwrap_or_else(|e| e.into_inner());
            #[cfg(target_os = "macos")]
            self.stage_metal_barrier();
            wgpu::util::DownloadBuffer::read_buffer(device, &self.queue, &source, move |result| {
                let _ = send.send(result.map(|buffer| buffer.to_vec()));
            });
        }
        crate::GpuDevice::wait(device)?;
        Ok(receive.recv_timeout(std::time::Duration::from_secs(5))??)
    }
    #[cfg(test)]
    pub(crate) fn record_readback(&self) {
        self.readbacks
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    }
    #[cfg(test)]
    pub(crate) fn readback_count(&self) -> u64 {
        self.readbacks.load(std::sync::atomic::Ordering::Relaxed)
    }
    #[cfg(any(target_os = "linux", target_os = "windows", feature = "vulkan-interop"))]
    pub(crate) fn gate(&self) -> Option<Arc<SubmissionGate>> {
        self.gate.clone()
    }
    pub(crate) fn ensure_gate(&mut self) {
        self.gate.get_or_insert_with(Default::default);
    }
    pub(crate) fn configure_surface(
        &self,
        surface: &wgpu::Surface<'_>,
        device: &wgpu::Device,
        config: &wgpu::SurfaceConfiguration,
    ) {
        let _configuration = self.gate.as_ref().map(|gate| gate.configuration());
        surface.configure(device, config);
    }
    pub(crate) fn present(&self, frame: wgpu::SurfaceTexture) {
        let _submission = self.gate.as_ref().map(|gate| gate.enter());
        self.queue.present(frame);
    }
    pub(crate) fn submit(
        &self,
        commands: impl IntoIterator<Item = wgpu::CommandBuffer>,
    ) -> wgpu::SubmissionIndex {
        self.exclusive_submit(|queue| queue.submit(commands))
    }
    // Foreign event staging is queue-wide. Keep it atomic with submit, including
    // background uploads and DownloadBuffer's internal submission.
    pub(crate) fn exclusive_submit<T>(&self, f: impl FnOnce(&wgpu::Queue) -> T) -> T {
        let _submission = self.gate.as_ref().map(|gate| gate.enter());
        let _exclusive = self.submit_lock.lock().unwrap_or_else(|e| e.into_inner());
        #[cfg(target_os = "macos")]
        self.stage_metal_barrier();
        f(&self.queue)
    }
    // Metal's strict relay is monotonic: a later wait-free submission must not
    // publish a higher relay value that bypasses an outstanding foreign wait.
    // Every later submission therefore also waits for the last export's native
    // completion. Must be set while holding exclusive_submit's lock.
    #[cfg(target_os = "macos")]
    pub(crate) fn set_metal_barrier(
        &self,
        event: objc2::rc::Retained<objc2::runtime::ProtocolObject<dyn objc2_metal::MTLSharedEvent>>,
        value: u64,
    ) {
        *self.metal_barrier.lock().unwrap() = Some((event, value));
    }
    #[cfg(target_os = "macos")]
    fn stage_metal_barrier(&self) {
        use objc2_metal::MTLSharedEvent;
        let mut barrier = self.metal_barrier.lock().unwrap();
        if let Some((event, value)) = barrier.as_ref() {
            if event.signaledValue() >= *value {
                *barrier = None;
            } else if let Some(queue) = unsafe { self.queue.as_hal::<wgpu::hal::api::Metal>() } {
                queue.add_wait_event(event.clone(), *value);
            }
        }
    }
}
impl std::ops::Deref for GpuQueue {
    type Target = wgpu::Queue;
    fn deref(&self) -> &Self::Target {
        &self.queue
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{sync::mpsc, time::Duration};

    #[test]
    #[ignore = "requires a real GPU; run npm run native:ci:gpu"]
    fn download_respects_submission_gate_slice_and_readback_count() {
        use wgpu::util::DeviceExt;
        let gpu = crate::GpuDevice::with_backend(0).unwrap();
        let gate = Arc::new(SubmissionGate::default());
        let queue = GpuQueue::new(gpu.queue.queue.clone(), Some(gate.clone()));
        let source = gpu
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("Gated readback fixture"),
                contents: bytemuck::cast_slice(&[10u32, 20, 30, 40]),
                usage: wgpu::BufferUsages::COPY_SRC,
            });
        gate.pause();
        let worker_queue = queue.clone();
        let (send, receive) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            send.send(
                worker_queue
                    .read_buffer(&gpu.device, source.slice(4..12))
                    .map_err(|e| e.to_string()),
            )
            .unwrap();
        });
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while queue.readback_count() == 0 {
            assert!(std::time::Instant::now() < deadline);
            std::thread::yield_now();
        }
        assert!(matches!(
            receive.recv_timeout(Duration::from_millis(50)),
            Err(mpsc::RecvTimeoutError::Timeout)
        ));
        gate.resume();
        let bytes = receive
            .recv_timeout(Duration::from_secs(30))
            .unwrap()
            .unwrap();
        worker.join().unwrap();
        assert_eq!(bytes, bytemuck::cast_slice::<u32, u8>(&[20u32, 30]));
        assert_eq!(queue.readback_count(), 1);
    }

    #[test]
    fn pause_drains_inflight_submissions_and_resume_releases_waiters() {
        let gate = Arc::new(SubmissionGate::default());
        let active = gate.enter();
        let (paused, did_pause) = mpsc::channel();
        let worker_gate = gate.clone();
        let worker = std::thread::spawn(move || {
            worker_gate.pause();
            paused.send(()).unwrap();
        });
        // Observe pause taking effect before releasing the active submission.
        while !gate.state.lock().unwrap().paused {
            std::thread::yield_now();
        }
        assert!(did_pause.try_recv().is_err());
        drop(active);
        did_pause.recv_timeout(Duration::from_secs(5)).unwrap();
        worker.join().unwrap();
        let (submitted, did_submit) = mpsc::channel();
        let worker_gate = gate.clone();
        let worker = std::thread::spawn(move || {
            let _submission = worker_gate.enter();
            submitted.send(()).unwrap();
        });
        assert!(did_submit.try_recv().is_err());
        gate.resume();
        did_submit.recv_timeout(Duration::from_secs(5)).unwrap();
        worker.join().unwrap();
        gate.pause();
    }
    #[test]
    fn configuration_drains_submissions_and_preserves_host_pause() {
        let gate = Arc::new(SubmissionGate::default());
        let active = gate.enter();
        let (configured, did_configure) = mpsc::channel();
        let (release, released) = mpsc::channel();
        let other = gate.clone();
        let worker = std::thread::spawn(move || {
            let _guard = other.configuration();
            configured.send(()).unwrap();
            released.recv().unwrap();
        });
        while !gate.state.lock().unwrap().configuring {
            std::thread::yield_now();
        }
        assert!(did_configure.try_recv().is_err());
        drop(active);
        did_configure.recv_timeout(Duration::from_secs(5)).unwrap();
        let (submitted, did_submit) = mpsc::channel();
        let other = gate.clone();
        let submitter = std::thread::spawn(move || {
            let _guard = other.enter();
            submitted.send(()).unwrap();
        });
        assert!(did_submit.try_recv().is_err());
        release.send(()).unwrap();
        worker.join().unwrap();
        did_submit.recv_timeout(Duration::from_secs(5)).unwrap();
        submitter.join().unwrap();
        gate.pause();
        {
            let _guard = gate.configuration();
        }
        assert!(gate.state.lock().unwrap().paused);
        assert!(!gate.state.lock().unwrap().configuring);
        gate.resume();
    }
}
