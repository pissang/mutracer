//! Persistent Metal instance descriptors. wgpu-core 30 rebuilds and uploads the
//! complete descriptor array even when only one public Tlas slot changed.
//! Use HAL's encoder and descriptor conversion, without duplicating Metal ABI.
use super::{Capture, Instance, Result};
use wgpu::hal::{self, CommandEncoder as _, Device as _};
use wgpu::util::DeviceExt;
type Metal = hal::api::Metal;
const FLAGS: wgpu::AccelerationStructureFlags = wgpu::AccelerationStructureFlags::PREFER_FAST_TRACE
    .union(wgpu::AccelerationStructureFlags::ALLOW_UPDATE);

pub(super) struct Inputs {
    buffer: wgpu::Buffer,
    scratch: wgpu::Buffer,
    stride: usize,
    count: u32,
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
        Ok(Self {
            buffer,
            scratch,
            stride,
            count: capture.instances.len() as u32,
        })
    }

    pub(super) fn update(
        &self,
        device: &wgpu::Device,
        queue: &crate::GpuQueue,
        blases: &[wgpu::Blas],
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
        let completion = crate::native_completion::Recording::new();
        let mut encoder = device.create_command_encoder(&Default::default());
        // SAFETY: registry ownership excludes concurrent AS use. Source and
        // destination are the same ALLOW_UPDATE TLAS with stable membership.
        // Inputs, scratch and every referenced BLAS are owned by Resources.
        unsafe {
            encoder.as_hal_mut::<Metal, _, _>(|raw| -> Result<()> {
                let raw = raw.ok_or("Metal TLAS encoder unavailable")?;
                let entries = hal::AccelerationStructureEntries::Instances(
                    hal::AccelerationStructureInstances {
                        buffer: Some(&*input),
                        offset: 0,
                        count: self.count,
                    },
                );
                raw.build_acceleration_structures(
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
                Ok(())
            })?;
            // This TLAS was already built through wgpu with the same BLASes.
            // Marking it built again would replace its tracked dependencies
            // with an empty list, losing Metal residency on later trace passes.
            // Stable matrix edits preserve that dependency list instead.
        }
        queue.submit([encoder.finish()]);
        // Raw submissions do not register buffer dependencies with wgpu.
        // Complete before a subsequent update can overwrite these inputs.
        super::wait_for_as(device, queue.submit([]))?;
        let _ = completion.finish().check("retained Metal TLAS update");
        Ok((bytes, calls))
    }
}
