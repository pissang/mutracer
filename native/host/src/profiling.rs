//! Optional GPU timings for the blocking benchmark path. No shader instrumentation.
use super::{Duration, Result, mpsc};
pub(super) fn enabled() -> bool {
    std::env::var_os("MUTRACER_NATIVE_PROFILE").is_some_and(|v| v == "1")
}
pub(super) fn gpu_enabled() -> bool {
    std::env::var_os("MUTRACER_NATIVE_GPU_TIMESTAMPS").is_some_and(|v| v == "1")
}
pub(super) struct GpuTimer {
    queries: wgpu::QuerySet,
    resolved: wgpu::Buffer,
    readback: wgpu::Buffer,
    count: u32,
}
impl GpuTimer {
    pub fn new(device: &wgpu::Device, pairs: u32, encoder: bool) -> Option<Self> {
        if !gpu_enabled() {
            return None;
        }
        Self::realtime(device, pairs, encoder)
    }
    pub fn realtime(device: &wgpu::Device, pairs: u32, encoder: bool) -> Option<Self> {
        let features = device.features();
        if !features.contains(wgpu::Features::TIMESTAMP_QUERY)
            || encoder && !features.contains(wgpu::Features::TIMESTAMP_QUERY_INSIDE_ENCODERS)
        {
            return None;
        }
        let count = pairs * 2;
        Some(Self {
            queries: device.create_query_set(&wgpu::QuerySetDescriptor {
                label: Some("MuTracer optional benchmark timestamps"),
                ty: wgpu::QueryType::Timestamp,
                count,
            }),
            resolved: device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("MuTracer timestamp resolve"),
                size: count as u64 * 8,
                usage: wgpu::BufferUsages::QUERY_RESOLVE | wgpu::BufferUsages::COPY_SRC,
                mapped_at_creation: false,
            }),
            readback: device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("MuTracer timestamp readback"),
                size: count as u64 * 8,
                usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            }),
            count,
        })
    }
    pub fn pass(&self, pair: u32) -> wgpu::ComputePassTimestampWrites<'_> {
        wgpu::ComputePassTimestampWrites {
            query_set: &self.queries,
            beginning_of_pass_write_index: Some(pair * 2),
            end_of_pass_write_index: Some(pair * 2 + 1),
        }
    }
    pub fn stamp(&self, encoder: &mut wgpu::CommandEncoder, index: u32) {
        encoder.write_timestamp(&self.queries, index);
    }
    pub fn resolve(&self, encoder: &mut wgpu::CommandEncoder) {
        encoder.resolve_query_set(&self.queries, 0..self.count, &self.resolved, 0);
        encoder.copy_buffer_to_buffer(&self.resolved, 0, &self.readback, 0, self.count as u64 * 8);
    }
    pub fn map(&self) -> mpsc::Receiver<std::result::Result<(), wgpu::BufferAsyncError>> {
        let (tx, rx) = mpsc::channel();
        self.readback
            .map_async(wgpu::MapMode::Read, .., move |result| {
                let _ = tx.send(result);
            });
        rx
    }
    pub fn mapped_milliseconds(&self, queue: &wgpu::Queue) -> Option<f64> {
        let result =
            self.readback.get_mapped_range(..).ok().and_then(|mapped| {
                timestamp_milliseconds(&mapped, queue.get_timestamp_period()).ok()
            });
        self.readback.unmap();
        result
    }
    pub fn milliseconds(&self, device: &wgpu::Device, queue: &wgpu::Queue) -> Result<f64> {
        let (sender, receiver) = mpsc::channel();
        self.readback
            .slice(..)
            .map_async(wgpu::MapMode::Read, move |r| {
                let _ = sender.send(r);
            });
        crate::GpuDevice::wait(device)?;
        receiver.recv_timeout(Duration::from_secs(5))??;
        let result = (|| {
            let mapped = self.readback.slice(..).get_mapped_range()?;
            timestamp_milliseconds(&mapped, queue.get_timestamp_period())
        })();
        self.readback.unmap();
        result
    }
    pub fn optional_milliseconds(&self, device: &wgpu::Device, queue: &wgpu::Queue) -> Option<f64> {
        match self.milliseconds(device, queue) {
            Ok(value) => Some(value),
            Err(error) => {
                native_log!(
                    "{}",
                    serde_json::json!({"nativeProfilingError": error.to_string()})
                );
                None
            }
        }
    }
}
fn timestamp_milliseconds(bytes: &[u8], period: f32) -> Result<f64> {
    if bytes.is_empty() || bytes.len() % 16 != 0 || !period.is_finite() || period <= 0. {
        return Err("Invalid GPU timestamp payload/period".into());
    }
    let mut ticks = 0u64;
    for pair in bytes.chunks_exact(16) {
        let begin = u64::from_le_bytes(pair[..8].try_into().unwrap());
        let end = u64::from_le_bytes(pair[8..].try_into().unwrap());
        if begin == 0 || end <= begin {
            return Err("GPU timestamps did not advance or were unordered".into());
        }
        ticks = ticks
            .checked_add(end - begin)
            .ok_or("GPU timestamp sum overflow")?;
    }
    Ok(ticks as f64 * period as f64 / 1e6)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "requires a real GPU; run npm run native:ci:gpu"]
    fn zero_timestamp_readback_does_not_prevent_real_gpu_rendering() {
        let _test = crate::abi_test_lock();
        let gpu =
            crate::GpuDevice::with_backend(1).expect("GPU validation requires a working device");
        assert!(gpu.hardware_ray_query, "GPU validation requires HWRT");
        let Some(timer) = GpuTimer::new(&gpu.device, 1, false) else {
            return;
        };
        // No query resolve was encoded: the initialized readback contains zero.
        assert!(
            timer
                .optional_milliseconds(&gpu.device, &gpu.queue)
                .is_none()
        );
        let input = crate::scene::tests::input();
        let (mut scene, mut assets, _retained) =
            crate::scene::prepare_retained(&input, true).unwrap();
        scene.hwrt = Some(
            crate::hardware::capture_from_resources(
                &mut assets,
                scene.native_layout.as_ref().unwrap(),
            )
            .unwrap(),
        );
        let (renderer, mut target) = crate::GpuScene::new(
            scene,
            &crate::RenderOptions {
                flags: 4,
                ..Default::default()
            },
            &assets,
            gpu,
        )
        .unwrap();
        assert!(renderer.hardware.is_some());
        renderer.add_samples(&mut target, 1).unwrap();
        assert_eq!(target.samples, 1);
        assert!(!renderer.read_target(&target, 0).unwrap().is_empty());
    }
    #[test]
    fn timestamp_payload_rejects_zero_unordered_and_overflowing_samples() {
        let bytes = |ticks: &[u64]| {
            ticks
                .iter()
                .flat_map(|t| t.to_le_bytes())
                .collect::<Vec<_>>()
        };
        for ticks in [
            &[0, 0][..],
            &[9, 0],
            &[9, 8],
            &[9, 9],
            &[9, 10, 0, 0],
            &[1, u64::MAX, 1, u64::MAX],
        ] {
            assert!(timestamp_milliseconds(&bytes(ticks), 1.).is_err());
        }
        assert!(timestamp_milliseconds(&[], 1.).is_err());
        assert!(timestamp_milliseconds(&[0; 17], 1.).is_err());
        assert!(timestamp_milliseconds(&bytes(&[1, 2]), f32::NAN).is_err());
        assert_eq!(
            timestamp_milliseconds(&bytes(&[10, 20, 40, 70]), 2.).unwrap(),
            0.00008
        );
    }
}
