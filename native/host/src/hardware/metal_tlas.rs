//! Persistent Metal instance descriptors. wgpu-core 30 rebuilds and uploads the
//! complete descriptor array even when only one public Tlas slot changed.
//! Use HAL's encoder and descriptor conversion, without duplicating Metal ABI.
use super::{Capture, Instance, Result};
use objc2_metal::{MTLCommandBuffer as _, MTLCommandBufferStatus};
use wgpu::hal::{self, CommandEncoder as _, Device as _, Queue as _};
use wgpu::util::DeviceExt;
type Metal = hal::api::Metal;
const FLAGS: wgpu::AccelerationStructureFlags = wgpu::AccelerationStructureFlags::PREFER_FAST_TRACE
    .union(wgpu::AccelerationStructureFlags::ALLOW_UPDATE);

pub(super) struct Inputs {
    buffer: wgpu::Buffer,
    scratch: wgpu::Buffer,
    stride: usize,
    count: u32,
    referenced_blases: Vec<usize>,
}

fn encode_instances(
    device: &wgpu::Device,
    blases: &[wgpu::Blas],
    instances: impl IntoIterator<Item = (usize, Instance)>,
) -> Result<Vec<(usize, Vec<u8>)>> {
    let raw = unsafe { device.as_hal::<Metal>() }.ok_or("Metal TLAS device unavailable")?;
    instances
        .into_iter()
        .map(|(index, instance)| {
            let address = blases
                .get(instance.geometry)
                .and_then(wgpu::Blas::handle)
                .ok_or("Missing Metal TLAS BLAS address")?;
            Ok((
                index,
                raw.tlas_instance_to_bytes(hal::TlasInstance {
                    transform: instance.transform,
                    custom_data: instance.custom_index,
                    mask: 255,
                    blas_address: address,
                    pipeline_intersection_data_offset: 0,
                }),
            ))
        })
        .collect()
}

impl Inputs {
    pub(super) fn new(
        device: &wgpu::Device,
        blases: &[wgpu::Blas],
        capture: &Capture,
    ) -> Result<Self> {
        let records = encode_instances(
            device,
            blases,
            capture.instances.iter().cloned().enumerate(),
        )?;
        let stride = records.first().ok_or("Empty Metal TLAS")?.1.len();
        let data: Vec<u8> = records.into_iter().flat_map(|(_, data)| data).collect();
        let buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("MuTracer retained Metal instances"),
            contents: &data,
            usage: wgpu::BufferUsages::TLAS_INPUT | wgpu::BufferUsages::COPY_DST,
        });
        // HAL guards cannot nest: all owning handles remain live, and the
        // context lock excludes destroy/replacement until the submission fence.
        let pointer = {
            let raw = unsafe { buffer.as_hal::<Metal>() }.ok_or("Metal TLAS input unavailable")?;
            &*raw as *const hal::metal::Buffer
        };
        let raw = unsafe { device.as_hal::<Metal>() }.ok_or("Metal TLAS device unavailable")?;
        let entries =
            hal::AccelerationStructureEntries::Instances(hal::AccelerationStructureInstances {
                buffer: Some(unsafe { &*pointer }),
                offset: 0,
                count: capture.instances.len() as u32,
            });
        let sizes = unsafe {
            raw.get_acceleration_structure_build_sizes(
                &hal::GetAccelerationStructureBuildSizesDescriptor {
                    entries: &entries,
                    flags: FLAGS,
                },
            )
        };
        drop(raw);
        let scratch = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("MuTracer retained Metal TLAS scratch"),
            size: sizes
                .build_scratch_size
                .max(sizes.update_scratch_size)
                .max(256)
                .next_multiple_of(256),
            usage: wgpu::BufferUsages::STORAGE,
            mapped_at_creation: false,
        });
        let mut referenced_blases: Vec<_> = capture.instances.iter().map(|i| i.geometry).collect();
        referenced_blases.sort_unstable();
        referenced_blases.dedup();
        Ok(Self {
            buffer,
            scratch,
            stride,
            count: capture.instances.len() as u32,
            referenced_blases,
        })
    }

    pub(super) fn update(
        &self,
        device: &wgpu::Device,
        queue: &crate::GpuQueue,
        blases: &mut [wgpu::Blas],
        tlas: &mut wgpu::Tlas,
        instances: impl IntoIterator<Item = (usize, Instance)>,
        rebuild: bool,
    ) -> Result<(usize, usize)> {
        let mut records = encode_instances(device, blases, instances)?;
        records.sort_unstable_by_key(|(index, _)| *index);
        let mut bytes = 0;
        let mut calls = 0;
        let mut at = 0;
        while at < records.len() {
            let first = records[at].0;
            let mut data = Vec::new();
            loop {
                let (index, record) = &records[at];
                if *index >= self.count as usize || record.len() != self.stride {
                    return Err("Invalid Metal instance span".into());
                }
                data.extend_from_slice(record);
                at += 1;
                if at == records.len() || records[at].0 != records[at - 1].0 + 1 {
                    break;
                }
            }
            queue.write_buffer(&self.buffer, (first * self.stride) as u64, &data);
            bytes += data.len();
            calls += 1;
        }
        // Flush queued input writes before entering the raw encoder. This is
        // the same BLAS-before-TLAS completion boundary as the ordinary path.
        super::wait_for_as(device, queue.submit([]))?;
        let input = {
            let raw =
                unsafe { self.buffer.as_hal::<Metal>() }.ok_or("Metal TLAS input unavailable")?;
            &*raw as *const hal::metal::Buffer
        };
        let scratch = {
            let raw = unsafe { self.scratch.as_hal::<Metal>() }
                .ok_or("Metal TLAS scratch unavailable")?;
            &*raw as *const hal::metal::Buffer
        };
        let destination = {
            let raw = unsafe { tlas.as_hal::<Metal>() }.ok_or("Metal TLAS unavailable")?;
            &*raw as *const hal::metal::AccelerationStructure
        };
        let dependencies = self
            .referenced_blases
            .iter()
            .map(|&index| {
                let raw = unsafe { blases[index].as_hal::<Metal>() }
                    .ok_or("Metal TLAS BLAS unavailable")?;
                Ok(&*raw as *const hal::metal::AccelerationStructure)
            })
            .collect::<Result<Vec<_>>>()?;
        // SAFETY: The owning wgpu handles stay live until completion. The
        // registry serializes edits and tracing, and the input upload has
        // completed. HAL guards cannot nest, so each resource pointer is
        // obtained separately while these invariants hold.
        let dependencies: Vec<_> = dependencies.iter().map(|ptr| unsafe { &**ptr }).collect();
        queue.exclusive_submit(|queue| -> Result<()> {
            let raw_queue = {
                let raw =
                    unsafe { queue.as_hal::<Metal>() }.ok_or("Metal TLAS queue unavailable")?;
                &*raw as *const hal::metal::Queue
            };
            let raw_device =
                unsafe { device.as_hal::<Metal>() }.ok_or("Metal TLAS device unavailable")?;
            // Use a separate HAL encoder so we can attach the dependencies to
            // its finished command buffer using wgpu-hal's residency helper.
            // Submit through the same Metal queue and retain the tracked wgpu
            // TLAS dependencies for subsequent tracing.
            unsafe {
                let raw_queue = &*raw_queue;
                let mut encoder =
                    raw_device.create_command_encoder(&hal::CommandEncoderDescriptor {
                        label: Some("MuTracer retained Metal TLAS"),
                        queue: raw_queue,
                    })?;
                encoder.begin_encoding(Some("MuTracer retained Metal TLAS"))?;
                let entries = hal::AccelerationStructureEntries::Instances(
                    hal::AccelerationStructureInstances {
                        buffer: Some(&*input),
                        offset: 0,
                        count: self.count,
                    },
                );
                encoder.build_acceleration_structures(
                    1,
                    [hal::BuildAccelerationStructureDescriptor {
                        entries: &entries,
                        mode: if rebuild {
                            hal::AccelerationStructureBuildMode::Build
                        } else {
                            hal::AccelerationStructureBuildMode::Update
                        },
                        flags: FLAGS,
                        source_acceleration_structure: if rebuild {
                            None
                        } else {
                            Some(&*destination)
                        },
                        destination_acceleration_structure: &*destination,
                        scratch_buffer: &*scratch,
                        scratch_buffer_offset: 0,
                    }],
                );
                let native_buffer = objc2::rc::Retained::retain(
                    std::ptr::from_ref(encoder.raw_command_buffer().unwrap()).cast_mut(),
                )
                .unwrap();
                let commands = encoder.end_encoding()?;
                hal::metal::CommandEncoder::set_acceleration_structure_dependencies(
                    &[&commands],
                    &dependencies,
                );
                let fence = raw_device.create_fence()?;
                let submitted = raw_queue.submit(&[&commands], &[], (&fence, 1));
                if submitted.is_ok() {
                    // A HAL submission is invisible to wgpu's resource
                    // tracker. Complete it before returning so these inputs
                    // and the in-place TLAS can be reused safely.
                    native_buffer.waitUntilCompleted();
                }
                encoder.reset_all(std::iter::once(commands));
                raw_device.destroy_fence(fence);
                submitted?;
                if native_buffer.status() != MTLCommandBufferStatus::Completed {
                    let detail = native_buffer
                        .error()
                        .map(|error| error.localizedDescription().to_string())
                        .unwrap_or_else(|| format!("Metal status {}", native_buffer.status().0));
                    return Err(crate::status::fail(
                        crate::Status::ContextFailed,
                        format!("GPU execution failed (retained Metal TLAS update): {detail}"),
                    ));
                }
            }
            Ok(())
        })?;
        Ok((bytes, calls))
    }
}
