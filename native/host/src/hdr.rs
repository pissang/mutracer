//! L1 CPU HDR readback, matching WebGPU's resolved color and rawOutputPass.
//! L0 read_average and the GPU-borrowed HDR image keep their own contracts.
use crate::{GpuDevice, Result};

pub(crate) fn read(
    gpu: &GpuDevice,
    buffers: [&wgpu::Buffer; 3],
    size: [u32; 2],
    samples: u32,
    opaque_background: bool,
) -> Result<Vec<f32>> {
    let plane = u64::from(size[0]) * u64::from(size[1]) * 16;
    // A host-supplied device may have a smaller buffer limit than our three
    // individually valid accumulation buffers combined. Keep that device usable.
    if plane * 3 > gpu.device.limits().max_buffer_size {
        let means = buffers.map(|buffer| {
            crate::read_average(&gpu.device, &gpu.queue, buffer, size[0], size[1], samples)
        });
        let [color, normal, albedo] = means;
        let (color, normal, albedo) = (color?, normal?, albedo?);
        let value =
            |bytes: &[u8], at: usize| f32::from_le_bytes(bytes[at..at + 4].try_into().unwrap());
        let mut result = Vec::with_capacity(plane as usize / 4);
        for at in (0..plane as usize).step_by(16) {
            result.extend(resolve(
                std::array::from_fn(|i| value(&color, at + i * 4)),
                value(&normal, at + 12),
                value(&albedo, at + 12),
                samples,
                opaque_background,
            ));
        }
        return Ok(result);
    }
    let staging = gpu.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("L1 HDR color and coverage readback"),
        size: plane * 3,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let mut encoder = gpu
        .device
        .create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("MuTracer HDR readback"),
        });
    for (i, buffer) in buffers.into_iter().enumerate() {
        encoder.copy_buffer_to_buffer(buffer, 0, &staging, plane * i as u64, plane);
    }
    gpu.queue.submit([encoder.finish()]);
    let (send, receive) = std::sync::mpsc::channel();
    staging.map_async(wgpu::MapMode::Read, .., move |result| {
        let _ = send.send(result);
    });
    crate::GpuDevice::wait(&gpu.device)?;
    receive.recv_timeout(std::time::Duration::from_secs(5))??;
    let mapped = staging.get_mapped_range(..)?;
    // Start with the same f32 per-sample averages as L0. The L1 conversion is
    // therefore also reproducible by callers using the public L0 HDR/AOVs.
    let mean = |offset: usize| {
        f32::from_le_bytes(mapped[offset..offset + 4].try_into().unwrap()) / samples as f32
    };
    let mut result = Vec::with_capacity(plane as usize / 4);
    for at in (0..plane as usize).step_by(16) {
        let color = std::array::from_fn(|i| mean(at + i * 4));
        let count = mean(plane as usize + at + 12);
        let hit = mean(plane as usize * 2 + at + 12);
        if !color.iter().all(|v: &f32| v.is_finite()) || !count.is_finite() || !hit.is_finite() {
            return Err("Non-finite native HDR input".into());
        }
        result.extend(resolve(color, count, hit, samples, opaque_background));
    }
    Ok(result)
}

fn resolve(color: [f32; 4], count: f32, hit: f32, samples: u32, flat: bool) -> [f32; 4] {
    if count <= 0. {
        return [0.; 4];
    }
    let total = count.max(1. / samples as f32);
    let divisor = if hit > 0. { hit } else { total };
    let mut resolved = [
        color[0] / divisor,
        color[1] / divisor,
        color[2] / divisor,
        color[3] / total,
    ];
    let coverage = (hit / total).clamp(0., 1.);
    // WGPURenderingPipeline.rawOutputPass restores flat-background misses.
    // Alpha stays path coverage, rather than becoming the surface-hit fraction.
    if flat && coverage > 0. {
        for v in &mut resolved[..3] {
            *v *= coverage;
        }
    }
    resolved
}
