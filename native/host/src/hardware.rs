use crate::{AssetId, Assets};
use serde::Deserialize;
use std::{borrow::Cow, collections::HashMap, time::Duration};
use wgpu::util::DeviceExt;
type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
#[cfg(target_os = "macos")]
mod metal_refit;

// Explicit AOT packet metadata; units belong to the contract, not uniform words.
#[derive(Clone, serde::Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeLayout {
    pub has_alpha: bool,
    pub attribute_stride_bytes: usize,
    pub position_offset_bytes: usize,
    pub blas_offset: usize,
    pub is_empty: bool,
    pub bevel: bool,
    pub has_displacement: bool,
    #[serde(default)]
    pub indexed: bool,
    #[serde(default)]
    pub hardware_geometries: Vec<IndexedGeometry>,
}

#[derive(Clone, serde::Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexedGeometry {
    #[serde(default)]
    opaque: bool,
    index_offset: u32,
    index_count: u32,
    vertex_offset: u32,
    vertex_count: u32,
    procedural: bool,
    dynamic: bool,
    bounds_offset: u32,
}
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capture {
    pub eligible: bool,
    #[serde(default)]
    pub authoritative: bool,
    #[serde(default)]
    pub indexed: bool,
    pub reason: Option<String>,
    pub shader: Option<AssetId>,
    #[serde(default)]
    pub geometries: Vec<Geometry>,
    #[serde(default)]
    pub instances: Vec<Instance>,
    pub triangle_map: Option<AssetId>,
}
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
#[derive(Default)]
pub struct Geometry {
    positions: AssetId,
    #[serde(default)]
    indices: Option<AssetId>,
    vertex_count: u32,
    #[serde(default)]
    index_count: Option<u32>,
    #[serde(default)]
    index_offset: u32,
    #[serde(default)]
    first_vertex: u32,
    vertex_stride: u64,
    #[serde(default)]
    bounds_offset: u32,
    #[serde(default)]
    dynamic: bool,
    #[serde(default)]
    pub(super) procedural: bool,
    #[serde(default)]
    non_opaque: bool,
}
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Instance {
    geometry: usize,
    custom_index: u32,
    transform: [f32; 12],
}

// Metal's indirect TLAS descriptors refer to BLAS resource IDs, which do not
// establish a driver-visible dependency. wgpu-hal 30's Metal AS barrier is empty.
// Finish BLAS GPU work before even encoding the dependent TLAS, not merely before
// submitting it. The exact submission fence includes all earlier queue work.
fn wait_for_as(device: &wgpu::Device, submission: wgpu::SubmissionIndex) -> Result<()> {
    device.poll(wgpu::PollType::Wait {
        submission_index: Some(submission),
        timeout: Some(Duration::from_secs(30)),
    })?;
    Ok(())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(super) enum HardwareBufferId {
    Packet(usize),
    Vertices(usize),
    Indices(usize),
    Mapping,
}
pub struct Resources {
    pub inputs: HashMap<HardwareBufferId, wgpu::Buffer>,
    indexed: bool,
    pub tlas: wgpu::Tlas,
    pub mapping: wgpu::Buffer,
    _blases: Vec<wgpu::Blas>,
    _vertices: Vec<wgpu::Buffer>,
    _indices: Vec<Option<wgpu::Buffer>>,
    raw_instances: Option<HashMap<(u32, u32), (usize, u32)>>,
    pub(super) metal_refit_opt_in: bool,
    updatable_blases: Vec<bool>,
    #[cfg_attr(not(test), allow(dead_code))]
    pub(super) used_metal_refit: bool,
}

// Source-order indexed compact vertices build AS inputs without a software BVH. The
// opt-out retains leaf-order inputs for explicit regression diagnostics.
pub(super) fn direct_input_enabled() -> bool {
    std::env::var_os("MUTRACER_NATIVE_DIRECT_AS").is_none_or(|v| v != "0")
}

pub fn prepare(
    device: &wgpu::Device,
    queue: &crate::GpuQueue,
    capture: &Capture,
    assets: &Assets,
    buffers: Option<&HashMap<usize, wgpu::Buffer>>,
) -> Result<Resources> {
    prepare_reusing(device, queue, capture, assets, buffers, None)
}
pub fn prepare_reusing(
    device: &wgpu::Device,
    queue: &crate::GpuQueue,
    capture: &Capture,
    assets: &Assets,
    buffers: Option<&HashMap<usize, wgpu::Buffer>>,
    reusable: Option<&HashMap<HardwareBufferId, wgpu::Buffer>>,
) -> Result<Resources> {
    let read = |name: &AssetId| -> Result<Cow<'_, [u8]>> {
        assets
            .get(name)
            .map(|data| Cow::Borrowed(data.as_slice()))
            .ok_or_else(|| format!("Missing HWRT resource {name:?}").into())
    };
    if !capture.eligible {
        return Err(capture
            .reason
            .clone()
            .unwrap_or("Unsupported hardware capture".into())
            .into());
    }
    let preparation_started = std::time::Instant::now();
    if capture.instances.len() > device.limits().max_tlas_instance_count as usize {
        return Err("HWRT TLAS instance count exceeds device limit".into());
    }
    if capture.geometries.iter().any(|g| {
        g.index_count.unwrap_or(g.vertex_count) / 3 > device.limits().max_blas_primitive_count
    }) {
        return Err("HWRT BLAS primitive count exceeds device limit".into());
    }
    let mut inputs = HashMap::new();
    let mut reused_bytes = 0u64;
    let mut payload_bytes = 0u64;
    let mut vertex_payload_bytes = 0u64;
    let mut upload = |name: HardwareBufferId,
                      data: &[u8],
                      usage: wgpu::BufferUsages,
                      vertex: bool| {
        let usage = usage | wgpu::BufferUsages::COPY_DST;
        let previous = reusable
            .and_then(|b| b.get(&name))
            .filter(|b| b.size() == data.len() as u64 && b.usage() == usage);
        let buffer = if let Some(previous) = previous {
            crate::write_scene_buffer(queue, previous, data);
            reused_bytes += previous.size();
            previous.clone()
        } else {
            crate::create_scene_buffer(device, queue, &format!("MuTracer {name:?}"), data, usage)
        };
        payload_bytes += data.len() as u64;
        if vertex {
            vertex_payload_bytes += data.len() as u64;
        }
        inputs.insert(name, buffer.clone());
        buffer
    };
    let direct_indices = if capture.indexed {
        Some(upload(
            HardwareBufferId::Packet(35),
            &read(&AssetId::Packet(35))?,
            wgpu::BufferUsages::BLAS_INPUT
                | wgpu::BufferUsages::STORAGE
                | wgpu::BufferUsages::COPY_DST,
            false,
        ))
    } else {
        None
    };
    let direct_bounds = if capture.indexed && capture.geometries.iter().any(|g| g.procedural) {
        Some(upload(
            HardwareBufferId::Packet(38),
            &read(&AssetId::Packet(38))?,
            wgpu::BufferUsages::BLAS_INPUT,
            true,
        ))
    } else {
        None
    };
    let direct_positions = if capture.indexed && capture.geometries.iter().any(|g| !g.procedural) {
        Some(
            buffers
                .and_then(|b| b.get(&3))
                .ok_or("Missing resident compact attributes")?
                .clone(),
        )
    } else {
        None
    };
    let mut vertices = Vec::new();
    let mut sizes = Vec::new();
    let mut indices = Vec::new();
    let mut blases = Vec::new();
    for (geometry_id, geometry) in capture.geometries.iter().enumerate() {
        let data = if capture.indexed {
            Cow::Borrowed(&[] as &[u8])
        } else {
            read(&geometry.positions)?
        };
        if !capture.indexed
            && data.len()
                != if geometry.procedural {
                    geometry.vertex_count as usize / 3 * 24
                } else {
                    geometry.vertex_count as usize * 12
                }
        {
            return Err("Invalid hardware vertex bytes".into());
        }
        vertices.push(if capture.indexed {
            if geometry.procedural {
                direct_bounds
                    .as_ref()
                    .ok_or("Missing direct AABBs")?
                    .clone()
            } else {
                direct_positions
                    .as_ref()
                    .ok_or("Missing compact positions")?
                    .clone()
            }
        } else {
            upload(
                HardwareBufferId::Vertices(geometry_id),
                &data,
                wgpu::BufferUsages::BLAS_INPUT,
                true,
            )
        });
        indices.push(if capture.indexed {
            if geometry.procedural {
                None
            } else {
                direct_indices.clone()
            }
        } else {
            geometry
                .indices
                .as_ref()
                .map(|name| -> Result<wgpu::Buffer> {
                    let data = read(name)?;
                    if data.len() < geometry.vertex_count as usize * 4 {
                        return Err("HWRT explicit index buffer is too short".into());
                    }
                    Ok(upload(
                        HardwareBufferId::Indices(geometry_id),
                        &data[..geometry.vertex_count as usize * 4],
                        wgpu::BufferUsages::BLAS_INPUT,
                        false,
                    ))
                })
                .transpose()?
        });
        let flags = if geometry.non_opaque {
            wgpu::AccelerationStructureGeometryFlags::empty()
        } else {
            wgpu::AccelerationStructureGeometryFlags::OPAQUE
        };
        let descriptors = if geometry.procedural {
            wgpu::BlasGeometrySizeDescriptors::AABBs {
                descriptors: vec![wgpu::BlasAABBGeometrySizeDescriptor {
                    primitive_count: geometry.index_count.unwrap_or(geometry.vertex_count) / 3,
                    flags: wgpu::AccelerationStructureGeometryFlags::empty(),
                }],
            }
        } else {
            wgpu::BlasGeometrySizeDescriptors::Triangles {
                descriptors: vec![wgpu::BlasTriangleGeometrySizeDescriptor {
                    vertex_format: wgpu::VertexFormat::Float32x3,
                    vertex_count: geometry.vertex_count,
                    index_format: geometry.indices.as_ref().map(|_| wgpu::IndexFormat::Uint32),
                    index_count: geometry
                        .indices
                        .as_ref()
                        .map(|_| geometry.index_count.unwrap_or(geometry.vertex_count)),
                    flags,
                }],
            }
        };
        blases.push(device.create_blas(
            &wgpu::CreateBlasDescriptor {
                label: Some("MuTracer hardware BLAS"),
                flags: wgpu::AccelerationStructureFlags::PREFER_FAST_TRACE,
                update_mode: wgpu::AccelerationStructureUpdateMode::Build,
            },
            descriptors.clone(),
        ));
        sizes.push(descriptors);
    }
    let mut tlas = device.create_tlas(&wgpu::CreateTlasDescriptor {
        label: Some("MuTracer hardware TLAS"),
        max_instances: capture.instances.len() as u32,
        flags: wgpu::AccelerationStructureFlags::PREFER_FAST_TRACE,
        update_mode: wgpu::AccelerationStructureUpdateMode::Build,
    });
    for (index, instance) in capture.instances.iter().enumerate() {
        tlas[index] = Some(wgpu::TlasInstance::new(
            blases
                .get(instance.geometry)
                .ok_or("Invalid BLAS reference")?,
            instance.transform,
            instance.custom_index,
            255,
        ));
    }
    let entries: Vec<_> = blases
        .iter()
        .zip(&sizes)
        .zip(&vertices)
        .enumerate()
        .map(|(i, ((blas, size), vertex_buffer))| wgpu::BlasBuildEntry {
            blas,
            geometry: match size {
                wgpu::BlasGeometrySizeDescriptors::Triangles { descriptors } => {
                    wgpu::BlasGeometries::TriangleGeometries(vec![wgpu::BlasTriangleGeometry {
                        size: &descriptors[0],
                        vertex_buffer,
                        first_vertex: capture.geometries[i].first_vertex,
                        vertex_stride: capture.geometries[i].vertex_stride,
                        index_buffer: indices[i].as_ref(),
                        first_index: indices[i]
                            .as_ref()
                            .map(|_| capture.geometries[i].index_offset),
                        transform_buffer: None,
                        transform_buffer_offset: None,
                    }])
                }
                wgpu::BlasGeometrySizeDescriptors::AABBs { descriptors } => {
                    wgpu::BlasGeometries::AabbGeometries(vec![wgpu::BlasAabbGeometry {
                        size: &descriptors[0],
                        stride: 24,
                        aabb_buffer: vertex_buffer,
                        primitive_offset: capture.geometries[i].bounds_offset * 24,
                    }])
                }
            },
        })
        .collect();
    let setup_ms = preparation_started.elapsed().as_secs_f64() * 1000.0;
    // All AS input uploads above must complete before the AS wall clock starts.
    // Metal does not expose encoder timestamps through this wgpu version.
    let drain_started = std::time::Instant::now();
    if super::profiling::gpu_enabled() {
        queue.submit([]);
        crate::GpuDevice::wait(device)?;
    }
    let upload_drain_ms = drain_started.elapsed().as_secs_f64() * 1000.0;
    let as_started = std::time::Instant::now();
    let timer = super::profiling::GpuTimer::new(device, 1, true);
    let mut encoder = device.create_command_encoder(&Default::default());
    if let Some(t) = &timer {
        t.stamp(&mut encoder, 0);
    }
    encoder.build_acceleration_structures(entries.iter(), std::iter::empty::<&wgpu::Tlas>());
    let blas_submission = queue.submit([encoder.finish()]);
    wait_for_as(device, blas_submission)?;
    let mut encoder = device.create_command_encoder(&Default::default());
    encoder.build_acceleration_structures(std::iter::empty::<&wgpu::BlasBuildEntry<'_>>(), [&tlas]);
    if let Some(t) = &timer {
        t.stamp(&mut encoder, 1);
        t.resolve(&mut encoder);
    }
    queue.submit([encoder.finish()]);
    let build_submit_ms = as_started.elapsed().as_secs_f64() * 1000.0;
    let completed_wall_ms = if super::profiling::gpu_enabled() {
        crate::GpuDevice::wait(device)?;
        Some(as_started.elapsed().as_secs_f64() * 1000.0)
    } else {
        None
    };
    #[cfg(target_os = "macos")]
    let as_storage_bytes = if super::profiling::enabled() {
        metal_refit::storage_bytes(
            device,
            &vertices,
            &indices,
            &capture.geometries,
            capture.instances.len() as u32,
        )
        .ok()
    } else {
        None
    };
    #[cfg(not(target_os = "macos"))]
    let as_storage_bytes: Option<u64> = None;

    let data = read(
        capture
            .triangle_map
            .as_ref()
            .ok_or("Missing HWRT triangle map")?,
    )?;
    let mapping = if let Some(buffer) = direct_indices {
        buffer
    } else {
        upload(
            HardwareBufferId::Mapping,
            &data,
            wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
            false,
        )
    };
    drop(upload);
    if super::profiling::enabled() || super::profiling::gpu_enabled() {
        let gpu_ms = timer
            .as_ref()
            .and_then(|t| t.optional_milliseconds(device, queue));
        native_log!(
            "{}",
            serde_json::json!({"nativeAsProfile": {"inputSetupMs": setup_ms,"uploadDrainMs":upload_drain_ms,"cpuBuildSubmitMs": build_submit_ms,"completedWallMs": completed_wall_ms,"gpuMs": gpu_ms,"gpuTimestampUnavailable": if super::profiling::gpu_enabled() && timer.is_none() { Some("Encoder timestamp queries unavailable") } else { None },"blasCount": blases.len(),"instanceCount": capture.instances.len(),"vertexUploadBytes":vertex_payload_bytes,"asStorageRequiredBytes":as_storage_bytes}})
        );
    }
    if super::profiling::enabled() {
        native_log!(
            "{}",
            serde_json::json!({"nativeHardwareUploadProfile": {"kind":"geometry","writeBytes":payload_bytes, "vertexUploadBytes":vertex_payload_bytes, "bufferCapacityBytes":inputs.values().map(|b|b.size()).sum::<u64>(), "asStorageRequiredBytes":as_storage_bytes,"instanceCount":capture.instances.len()}})
        );
    }
    if super::profiling::enabled() {
        native_log!(
            "{}",
            serde_json::json!({"nativeHardwareReuseProfile": {"reusedBytes": reused_bytes}})
        );
    }
    // Software TLAS rebuilds may reorder instances. Match BLAS root/vertex region
    // rather than the previous instance index, preserving primitive identity.
    let raw_instances = assets.get(&AssetId::Packet(2)).map(|bytes| {
        bytes
            .chunks_exact(160)
            .zip(&capture.instances)
            .enumerate()
            .map(|(i, (record, instance))| {
                let word =
                    |offset| u32::from_le_bytes(record[offset..offset + 4].try_into().unwrap());
                (
                    (word(0), word(4)),
                    (
                        instance.geometry,
                        if capture.indexed {
                            word(0)
                        } else {
                            u32::from_le_bytes(data[i * 4..i * 4 + 4].try_into().unwrap())
                        },
                    ),
                )
            })
            .collect()
    });
    Ok(Resources {
        inputs,
        indexed: capture.indexed,
        raw_instances,
        tlas,
        mapping,
        updatable_blases: vec![false; blases.len()],
        metal_refit_opt_in: cfg!(target_os = "macos")
            && std::env::var_os("MUTRACER_NATIVE_METAL_REFIT").is_some_and(|v| v == "1"),
        used_metal_refit: false,
        _blases: blases,
        _vertices: vertices,
        _indices: indices,
    })
}

// A validated plan owns no GPU side effects; rejected updates preserve old ASes.
pub struct TransformPlan {
    instances: Vec<(usize, Instance, u32)>,
}
impl Resources {
    /// Stage independent replacement BLASes; unchanged BLASes and their input
    /// buffers stay shared. Validation precedes GPU work and accepted ASes are
    /// never mutated, so a rejected candidate leaves the scene usable.
    pub fn rebuild_changed(
        &self,
        device: &wgpu::Device,
        queue: &crate::GpuQueue,
        capture: &Capture,
        writes: &super::scene::LightingUpdates,
    ) -> Result<Resources> {
        if !self.indexed || !capture.indexed {
            return Err("Partial AS rebuild requires indexed source inputs".into());
        }
        let changed = writes
            .changed_blases
            .as_ref()
            .ok_or("Missing changed BLAS list")?;
        let mut unique = std::collections::HashSet::new();
        let mut plans = Vec::new();
        let mut used_writes = std::collections::HashSet::new();
        for &index in changed {
            if !unique.insert(index) {
                return Err("Duplicate changed BLAS".into());
            }
            let geometry = capture
                .geometries
                .get(index)
                .ok_or("Changed BLAS out of bounds")?;
            if geometry.procedural {
                // Procedural AS builds consume AABBs, while shading still
                // uploads the changed compact vertices through resource 3.
                let offset = geometry.first_vertex as u64 * geometry.vertex_stride;
                let length = geometry.vertex_count as usize * geometry.vertex_stride as usize;
                let attribute_write = writes
                    .hardware_writes
                    .iter()
                    .position(|(id, destination, data)| {
                        *id == 3 && *destination == offset && data.len() == length
                    })
                    .ok_or("Missing exact changed procedural vertex span")?;
                used_writes.insert(attribute_write);
            }
            let (id, offset, length) = if geometry.procedural {
                (
                    38,
                    geometry.bounds_offset as u64 * 24,
                    geometry.index_count.unwrap_or(geometry.vertex_count) as usize / 3 * 24,
                )
            } else {
                (
                    3,
                    geometry.first_vertex as u64 * geometry.vertex_stride,
                    geometry.vertex_count as usize * geometry.vertex_stride as usize,
                )
            };
            let (write_index, (_, _, data)) = writes
                .hardware_writes
                .iter()
                .enumerate()
                .find(|(_, (resource, destination, data))| {
                    *resource == id && *destination == offset && data.len() == length
                })
                .ok_or("Missing exact changed geometry AS span")?;
            used_writes.insert(write_index);
            plans.push((index, geometry, data));
        }
        if used_writes.len() != writes.hardware_writes.len() {
            return Err("Unexpected hardware geometry span".into());
        }
        #[cfg(target_os = "macos")]
        let allow_update = self.metal_refit_opt_in && metal_refit::available(device);
        #[cfg(not(target_os = "macos"))]
        let allow_update = false;
        let mut blases = self._blases.clone();
        let mut vertices = self._vertices.clone();
        let indices = self._indices.clone();
        let mut sizes = Vec::new();
        for (index, geometry, data) in &plans {
            let flags = if geometry.non_opaque {
                wgpu::AccelerationStructureGeometryFlags::empty()
            } else {
                wgpu::AccelerationStructureGeometryFlags::OPAQUE
            };
            let descriptors = if geometry.procedural {
                wgpu::BlasGeometrySizeDescriptors::AABBs {
                    descriptors: vec![wgpu::BlasAABBGeometrySizeDescriptor {
                        primitive_count: geometry.index_count.unwrap_or(geometry.vertex_count) / 3,
                        flags: wgpu::AccelerationStructureGeometryFlags::empty(),
                    }],
                }
            } else {
                wgpu::BlasGeometrySizeDescriptors::Triangles {
                    descriptors: vec![wgpu::BlasTriangleGeometrySizeDescriptor {
                        vertex_format: wgpu::VertexFormat::Float32x3,
                        vertex_count: geometry.vertex_count,
                        index_format: Some(wgpu::IndexFormat::Uint32),
                        index_count: geometry.index_count,
                        flags,
                    }],
                }
            };
            vertices[*index] = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("MuTracer changed AS input"),
                contents: data,
                usage: wgpu::BufferUsages::BLAS_INPUT | wgpu::BufferUsages::COPY_DST,
            });
            blases[*index] = device.create_blas(
                &wgpu::CreateBlasDescriptor {
                    label: Some("MuTracer changed BLAS"),
                    flags: wgpu::AccelerationStructureFlags::PREFER_FAST_TRACE
                        | if allow_update {
                            wgpu::AccelerationStructureFlags::ALLOW_UPDATE
                        } else {
                            wgpu::AccelerationStructureFlags::empty()
                        },
                    update_mode: wgpu::AccelerationStructureUpdateMode::Build,
                },
                descriptors.clone(),
            );
            sizes.push(descriptors);
        }
        let mut tlas = device.create_tlas(&wgpu::CreateTlasDescriptor {
            label: Some("MuTracer changed geometry TLAS"),
            max_instances: capture.instances.len() as u32,
            flags: wgpu::AccelerationStructureFlags::PREFER_FAST_TRACE,
            update_mode: wgpu::AccelerationStructureUpdateMode::Build,
        });
        for (index, instance) in capture.instances.iter().enumerate() {
            tlas[index] = Some(wgpu::TlasInstance::new(
                &blases[instance.geometry],
                instance.transform,
                instance.custom_index,
                255,
            ));
        }
        let mut metal_blas_wall_ms: Option<f64> = None;
        #[cfg(target_os = "macos")]
        if allow_update && changed.iter().all(|&i| self.updatable_blases[i]) {
            match self.refit_metal_candidate(
                device,
                queue,
                &plans,
                &mut blases,
                &vertices,
                &indices,
            ) {
                Ok(elapsed) => metal_blas_wall_ms = Some(elapsed),
                Err(error) => native_log!(
                    "{}",
                    serde_json::json!({"nativeMetalRefitFallback":error.to_string()})
                ),
            }
        }
        let entries: Vec<_> = plans
            .iter()
            .zip(&sizes)
            .map(|((index, geometry, _), size)| wgpu::BlasBuildEntry {
                blas: &blases[*index],
                geometry: match size {
                    wgpu::BlasGeometrySizeDescriptors::Triangles { descriptors } => {
                        wgpu::BlasGeometries::TriangleGeometries(vec![wgpu::BlasTriangleGeometry {
                            size: &descriptors[0],
                            vertex_buffer: &vertices[*index],
                            first_vertex: 0,
                            vertex_stride: geometry.vertex_stride,
                            index_buffer: indices[*index].as_ref(),
                            first_index: Some(geometry.index_offset),
                            transform_buffer: None,
                            transform_buffer_offset: None,
                        }])
                    }
                    wgpu::BlasGeometrySizeDescriptors::AABBs { descriptors } => {
                        wgpu::BlasGeometries::AabbGeometries(vec![wgpu::BlasAabbGeometry {
                            size: &descriptors[0],
                            stride: 24,
                            aabb_buffer: &vertices[*index],
                            primitive_offset: 0,
                        }])
                    }
                },
            })
            .collect();
        let profile = super::profiling::gpu_enabled();
        if profile {
            queue.submit([]);
            crate::GpuDevice::wait(device)?;
        }
        let started = std::time::Instant::now();
        let completed_wall_ms = if let Some(elapsed) = metal_blas_wall_ms {
            // wgpu prohibits mixing raw and high-level encoding APIs. The raw
            // refit has completed; encode its dependent TLAS after that fence.
            let mut encoder = device.create_command_encoder(&Default::default());
            encoder.build_acceleration_structures(
                std::iter::empty::<&wgpu::BlasBuildEntry<'_>>(),
                [&tlas],
            );
            queue.submit([encoder.finish()]);
            crate::GpuDevice::wait(device)?;
            Some(elapsed + started.elapsed().as_secs_f64() * 1000.0)
        } else {
            let mut encoder = device.create_command_encoder(&Default::default());
            encoder
                .build_acceleration_structures(entries.iter(), std::iter::empty::<&wgpu::Tlas>());
            let blas_submission = queue.submit([encoder.finish()]);
            wait_for_as(device, blas_submission)?;
            let mut encoder = device.create_command_encoder(&Default::default());
            encoder.build_acceleration_structures(
                std::iter::empty::<&wgpu::BlasBuildEntry<'_>>(),
                [&tlas],
            );
            queue.submit([encoder.finish()]);
            if profile {
                crate::GpuDevice::wait(device)?;
                Some(started.elapsed().as_secs_f64() * 1000.0)
            } else {
                None
            }
        };
        if super::profiling::enabled() || profile {
            native_log!(
                "{}",
                serde_json::json!({"nativeGeometryAsProfile":{
                    "changedBlasCount":changed.len(),"totalBlasCount":blases.len(),"blasCompletedWallMs":Option::<f64>::None,"blasTlasCompletedWallMs":completed_wall_ms,
                    "inputUploadBytes":plans.iter().map(|(_,_,data)|data.len()).sum::<usize>(),"method":if metal_blas_wall_ms.is_some() {"metal-refit"} else {"wgpu-rebuild"}
                }})
            );
        }
        let mut updatable_blases = self.updatable_blases.clone();
        for &index in changed {
            updatable_blases[index] = allow_update;
        }
        Ok(Resources {
            inputs: self.inputs.clone(),
            indexed: self.indexed,
            tlas,
            mapping: self.mapping.clone(),
            _blases: blases,
            _vertices: vertices,
            _indices: indices,
            raw_instances: self.raw_instances.clone(),
            metal_refit_opt_in: self.metal_refit_opt_in,
            used_metal_refit: metal_blas_wall_ms.is_some(),
            updatable_blases,
        })
    }

    #[cfg(target_os = "macos")]
    fn refit_metal_candidate(
        &self,
        device: &wgpu::Device,
        queue: &crate::GpuQueue,
        plans: &[(usize, &Geometry, &Vec<u8>)],
        blases: &mut [wgpu::Blas],
        vertices: &[wgpu::Buffer],
        indices: &[Option<wgpu::Buffer>],
    ) -> Result<f64> {
        // Draining completes old source-AS builds and all new input uploads.
        // Every raw input, source/destination AS and scratch stays owned here
        // until the completion fence. Each destination is a fresh allocation.
        queue.submit([]);
        crate::GpuDevice::wait(device)?;
        let started = std::time::Instant::now();
        let mut encoder = device.create_command_encoder(&Default::default());
        let mut scratches = Vec::new();
        let mut sources = Vec::new();
        for (index, geometry, _) in plans {
            let mut local = (*geometry).clone();
            local.first_vertex = 0;
            local.bounds_offset = 0;
            let size = metal_refit::scratch_size(
                device,
                &vertices[*index],
                indices[*index].as_ref(),
                &local,
                true,
            )?;
            scratches.push(device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("MuTracer Metal refit scratch"),
                size,
                usage: wgpu::BufferUsages::STORAGE,
                mapped_at_creation: false,
            }));
            sources.push(self._blases[*index].clone());
            metal_refit::encode(
                device,
                &mut encoder,
                &mut blases[*index],
                sources.last_mut().unwrap(),
                &vertices[*index],
                indices[*index].as_ref(),
                &local,
                scratches.last().unwrap(),
            )?;
        }
        // Only the raw encoder touched these fresh destinations. Register every
        // encoded BLAS; dependent high-level TLAS work follows the completion fence.
        unsafe {
            encoder.mark_acceleration_structures_built(
                plans.iter().map(|(index, _, _)| &blases[*index]),
                std::iter::empty::<&wgpu::Tlas>(),
            );
        }
        queue.submit([encoder.finish()]);
        crate::GpuDevice::wait(device)?;
        Ok(started.elapsed().as_secs_f64() * 1000.0)
    }
    pub fn transform_plan(
        &self,
        capture: &Capture,
        writes: &super::scene::LightingUpdates,
    ) -> Result<TransformPlan> {
        let roots = self
            .raw_instances
            .as_ref()
            .ok_or("Full scene commit required: no raw hardware instance metadata")?;
        let mut instances = Vec::new();
        for (_, offset, _, _, bytes) in writes.iter().filter(|record| record.0 == 2) {
            let first = *offset as usize / 160;
            if *offset % 160 != 0
                || bytes.len() % 160 != 0
                || first + bytes.len() / 160 > capture.instances.len()
            {
                return Err(
                    "Full scene commit required: hardware instance membership changed".into(),
                );
            }
            for (local, record) in bytes.chunks_exact(160).enumerate() {
                let i = first + local;
                let word =
                    |offset| u32::from_le_bytes(record[offset..offset + 4].try_into().unwrap());
                let &(geometry, base) = roots
                    .get(&(word(0), word(4)))
                    .ok_or("Full scene commit required: hardware BLAS placement changed")?;
                let matrix: [f32; 16] = std::array::from_fn(|k| f32::from_bits(word(80 + k * 4)));
                if matrix.iter().any(|v| !v.is_finite()) {
                    return Err("Non-finite hardware instance matrix".into());
                }
                instances.push((
                    i,
                    Instance {
                        geometry,
                        custom_index: i as u32,
                        transform: [0, 4, 8, 12, 1, 5, 9, 13, 2, 6, 10, 14].map(|k| matrix[k]),
                    },
                    base,
                ));
            }
        }
        Ok(TransformPlan { instances })
    }
    pub fn update_transforms(
        &mut self,
        device: &wgpu::Device,
        queue: &crate::GpuQueue,
        plan: TransformPlan,
        capture: &mut Capture,
    ) -> Result<()> {
        if plan.instances.is_empty() {
            return Ok(());
        }
        // Also fence a preceding geometry edit before encoding a TLAS-only edit.
        wait_for_as(device, queue.submit([]))?;
        let bytes = if self.indexed {
            0
        } else {
            plan.instances.len() * 4
        };
        for (index, instance, base) in &plan.instances {
            capture.instances[*index] = instance.clone();
            self.tlas[*index] = Some(wgpu::TlasInstance::new(
                &self._blases[instance.geometry],
                instance.transform,
                instance.custom_index,
                255,
            ));
            if !self.indexed {
                queue.write_buffer(&self.mapping, *index as u64 * 4, &base.to_le_bytes());
            }
        }
        if super::profiling::enabled() {
            native_log!(
                "{}",
                serde_json::json!({"nativeHardwareUploadProfile":{"kind":"transform","writeBytes":bytes,"instanceCount":plan.instances.len()}})
            );
        }
        let mut encoder = device.create_command_encoder(&Default::default());
        encoder.build_acceleration_structures(
            std::iter::empty::<&wgpu::BlasBuildEntry<'_>>(),
            [&self.tlas],
        );
        queue.submit([encoder.finish()]);
        Ok(())
    }
}
// Source-order inputs use the shared TS geometry regions. Leaf-order extraction
// remains available for explicit regression diagnostics; both supply identity
// only, never a software recomputation of a hardware hit or miss.
pub fn capture_from_resources(assets: &mut Assets, layout: &NativeLayout) -> Result<Capture> {
    if layout.indexed {
        return from_indexed(assets, layout);
    }
    let source = assets
        .get(&AssetId::Packet(33))
        .ok_or("Missing authoritative HWRT shader")?
        .clone();
    let words = |name: &AssetId| -> Result<Vec<u32>> {
        let bytes = assets.get(name).ok_or("Missing packed HWRT input")?;
        if bytes.len() % 4 != 0 {
            return Err("Invalid packed HWRT input".into());
        }
        Ok(bytemuck::pod_collect_to_vec::<u8, u32>(bytes))
    };
    let blas_offset = layout.blas_offset;
    let instances = words(&AssetId::Packet(2))?;
    let bvh = words(&AssetId::Packet(1))?;
    let attributes = words(&AssetId::Packet(3))?;
    if layout.attribute_stride_bytes % 4 != 0 || layout.position_offset_bytes % 4 != 0 {
        return Err("Invalid native HWRT attribute alignment".into());
    }
    let stride = layout.attribute_stride_bytes / 4;
    let position = layout.position_offset_bytes / 4;
    if !layout.is_empty && (stride == 0 || instances.len() % 40 != 0) {
        return Err("Invalid native HWRT layout".into());
    }
    let count = if layout.is_empty {
        0
    } else {
        instances.len() / 40
    };
    let mut mapping = vec![0u32; count];
    let mut geometries = Vec::new();
    let mut placements = Vec::new();
    let mut cache = HashMap::new();
    let mut generated = HashMap::new();
    for id in 0..count {
        let encoded = instances[id * 40];
        if encoded >> 30 != 0 {
            return Err("HWRT requires BVH2 packing".into());
        }
        let root = blas_offset + encoded as usize;
        let vertex_offset = instances[id * 40 + 1] as usize;
        let geometry = if let Some(&(index, _)) = cache.get(&(root, vertex_offset)) {
            index
        } else {
            let mut stack = vec![root];
            let mut positions = Vec::<u8>::new();
            let mut bounds = Vec::<u8>::new();
            let mut displaced = false;
            let mut triangle_count = 0u32;
            let base = mapping.len() as u32;
            let mut visited = 0;
            while let Some(node) = stack.pop() {
                visited += 1;
                if visited > bvh.len() / 4 {
                    return Err("Invalid cyclic BVH input".into());
                }
                let child = *bvh.get(node * 4 + 3).ok_or("BVH node out of bounds")? as i32;
                if child >= 0 {
                    stack.push(root + child as usize);
                    stack.push(node + 2);
                    continue;
                }
                for k in 0..child.unsigned_abs() as usize {
                    let record = node + 2 + k;
                    mapping.push(record as u32);
                    triangle_count += 1;
                    displaced |= f32::from_bits(instances[id * 40 + 3]).abs() > 0.0
                        && *bvh
                            .get(record * 4 + 3)
                            .ok_or("Missing displacement range")?
                            != 0;
                    for coordinate in [0, 1, 2, 4, 5, 6] {
                        bounds.extend(
                            bvh.get(node * 4 + coordinate)
                                .ok_or("Missing leaf bounds")?
                                .to_le_bytes(),
                        );
                    }
                    for corner in 0..3 {
                        let vertex = *bvh
                            .get(record * 4 + corner)
                            .ok_or("BVH triangle out of bounds")?
                            as usize
                            + vertex_offset;
                        let off = vertex
                            .checked_mul(stride)
                            .and_then(|v| v.checked_add(position))
                            .ok_or("Attribute offset overflow")?;
                        for &word in attributes
                            .get(off..off + 3)
                            .ok_or("HWRT vertex out of bounds")?
                        {
                            if !f32::from_bits(word).is_finite() {
                                return Err("Non-finite HWRT vertex".into());
                            }
                            positions.extend(word.to_le_bytes());
                        }
                    }
                }
            }
            if positions.is_empty() {
                return Err("Empty HWRT geometry".into());
            }
            let index = geometries.len();
            let name = AssetId::GeometryPositions(index);
            geometries.push(Geometry {
                positions: name.clone(),
                indices: (!displaced).then(|| AssetId::Packet(35)),
                vertex_count: triangle_count * 3,
                procedural: displaced,
                non_opaque: layout.has_alpha,
                vertex_stride: 12,
                ..Default::default()
            });
            generated.insert(name, if displaced { bounds } else { positions });
            cache.insert((root, vertex_offset), (index, base));
            index
        };
        mapping[id] = cache
            .get(&(root, vertex_offset))
            .ok_or("Missing HWRT map base")?
            .1;
        let m: Vec<_> = instances[id * 40 + 20..id * 40 + 36]
            .iter()
            .map(|v| f64::from(f32::from_bits(*v)))
            .collect();
        placements.push(Instance {
            geometry,
            custom_index: id as u32,
            transform: [0, 4, 8, 12, 1, 5, 9, 13, 2, 6, 10, 14].map(|i| m[i] as f32),
        });
    }
    generated.insert(
        AssetId::HardwareMap,
        bytemuck::cast_slice(&mapping).to_vec(),
    );
    generated.insert(AssetId::HardwareShader, source);
    assets.extend(generated);
    Ok(Capture {
        eligible: true,
        indexed: false,
        authoritative: true,
        reason: None,
        shader: Some(AssetId::HardwareShader),
        geometries,
        instances: placements,
        triangle_map: Some(AssetId::HardwareMap),
    })
}

// TS supplies compact geometry regions and local displacement AABBs. Rust only
// binds buffers and converts instance matrices for the wgpu API.
fn from_indexed(assets: &mut Assets, layout: &NativeLayout) -> Result<Capture> {
    if layout.position_offset_bytes != 0 || layout.attribute_stride_bytes < 12 {
        return Err("Unsupported HWRT position layout".into());
    }
    let attributes = assets
        .get(&AssetId::Packet(3))
        .ok_or("Missing indexed attributes")?;
    if attributes.len() < layout.attribute_stride_bytes && !layout.is_empty {
        return Err("Missing indexed attributes".into());
    }
    let geometries = layout
        .hardware_geometries
        .iter()
        .map(|g| Geometry {
            positions: AssetId::Packet(if g.procedural { 38 } else { 3 }),
            indices: (!g.procedural).then(|| AssetId::Packet(35)),
            vertex_count: g.vertex_count,
            first_vertex: g.vertex_offset,
            index_count: Some(g.index_count),
            index_offset: g.index_offset,
            vertex_stride: layout.attribute_stride_bytes as u64,
            bounds_offset: g.bounds_offset,
            dynamic: g.dynamic,
            procedural: g.procedural,
            // PDM keeps its accepted candidate order and AS flags. Its shared
            // random stream depends on traversal order, so the closest fast
            // path is conservatively disabled for a scene containing PDM.
            non_opaque: if layout.has_displacement {
                layout.has_alpha
            } else {
                !g.opaque
            },
        })
        .collect();
    let mut instances = Vec::new();
    if !layout.is_empty {
        for (i, record) in assets
            .get(&AssetId::Packet(2))
            .ok_or("Missing indexed instances")?
            .chunks_exact(160)
            .enumerate()
        {
            let word = |k: usize| u32::from_le_bytes(record[k * 4..k * 4 + 4].try_into().unwrap());
            let geometry = layout
                .hardware_geometries
                .iter()
                .position(|g| g.index_offset / 3 == word(0))
                .ok_or("Missing indexed geometry region")?;
            instances.push(Instance {
                geometry,
                custom_index: i as u32,
                transform: [0, 4, 8, 12, 1, 5, 9, 13, 2, 6, 10, 14]
                    .map(|k| f32::from_bits(word(20 + k))),
            });
        }
    }
    Ok(Capture {
        eligible: true,
        authoritative: true,
        indexed: true,
        reason: None,
        shader: Some(AssetId::Packet(33)),
        geometries,
        instances,
        triangle_map: Some(AssetId::Packet(35)),
    })
}

// Explicit diagnostic isolation; never called by commit/render entry points.
pub fn isolate_diagnostic(
    capture: &mut Capture,
    assets: &mut Assets,
    instance: u32,
    primitive: Option<usize>,
) -> Result<()> {
    capture.instances.retain(|i| i.custom_index == instance);
    let placement = capture
        .instances
        .first()
        .ok_or("Unknown diagnostic instance")?;
    if let Some(primitive) = primitive {
        let geometry = &mut capture.geometries[placement.geometry];
        if geometry.procedural {
            return Err("Diagnostic isolation expects triangles".into());
        }
        if capture.indexed {
            let base = geometry.index_offset / 3 + primitive as u32;
            geometry.index_offset += primitive as u32 * 3;
            geometry.index_count = Some(3);
            let records = assets
                .get_mut(&AssetId::Packet(2))
                .ok_or("Missing indexed instances")?;
            records[instance as usize * 160..instance as usize * 160 + 4]
                .copy_from_slice(&base.to_le_bytes());
            return Ok(());
        }
        let source = assets
            .get(&geometry.positions)
            .ok_or("Missing diagnostic vertices")?;
        let vertices = source
            .get(primitive * 36..primitive * 36 + 36)
            .ok_or("Unknown diagnostic primitive")?
            .to_vec();
        assets.insert(geometry.positions.clone(), vertices);
        geometry.vertex_count = 3;
        let name = capture
            .triangle_map
            .as_ref()
            .ok_or("Missing diagnostic mapping")?;
        let old = assets.get(name).ok_or("Missing diagnostic mapping")?;
        let read = |i: usize| u32::from_le_bytes(old[i * 4..i * 4 + 4].try_into().unwrap());
        let record = read(read(instance as usize) as usize + primitive);
        let mut mapping = vec![0u32; instance as usize + 2];
        mapping[instance as usize] = instance + 1;
        mapping[instance as usize + 1] = record;
        assets.insert(name.clone(), bytemuck::cast_slice(&mapping).to_vec());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "requires a real GPU; run npm run native:ci:gpu"]
    fn retired_indices_are_reused_for_every_geometry_size() {
        let gpu =
            crate::GpuDevice::with_backend(1).expect("GPU validation requires a working device");
        assert!(gpu.hardware_ray_query, "GPU validation requires HWRT");
        let mut assets = HashMap::new();
        let triangle = [-1f32, 0., 0., 1., 0., 0., 0., 1., 0.];
        assets.insert(
            AssetId::Diagnostic(110),
            triangle.iter().flat_map(|v| v.to_le_bytes()).collect(),
        );
        assets.insert(
            AssetId::Diagnostic(111),
            triangle
                .repeat(2)
                .iter()
                .flat_map(|v| v.to_le_bytes())
                .collect(),
        );
        assets.insert(
            AssetId::Diagnostic(112),
            (0..6u32).flat_map(u32::to_le_bytes).collect(),
        );
        assets.insert(
            AssetId::Diagnostic(113),
            [2u32, 3, 10, 11, 12]
                .into_iter()
                .flat_map(u32::to_le_bytes)
                .collect(),
        );
        let capture = Capture {
            eligible: true,
            authoritative: true,
            indexed: false,
            reason: None,
            shader: None,
            triangle_map: Some(AssetId::Diagnostic(113)),
            geometries: [3, 6]
                .into_iter()
                .enumerate()
                .map(|(i, count)| Geometry {
                    positions: AssetId::Diagnostic(110 + i),
                    indices: Some(AssetId::Diagnostic(112)),
                    vertex_count: count,
                    vertex_stride: 12,
                    ..Default::default()
                })
                .collect(),
            instances: (0..2)
                .map(|geometry| Instance {
                    geometry,
                    custom_index: geometry as u32,
                    transform: [1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0.],
                })
                .collect(),
        };
        let first = prepare(&gpu.device, &gpu.queue, &capture, &assets, None).unwrap();
        gpu.device
            .poll(wgpu::PollType::Wait {
                submission_index: None,
                timeout: Some(Duration::from_secs(30)),
            })
            .unwrap();
        let second = prepare_reusing(
            &gpu.device,
            &gpu.queue,
            &capture,
            &assets,
            None,
            Some(&first.inputs),
        )
        .unwrap();
        gpu.device
            .poll(wgpu::PollType::Wait {
                submission_index: None,
                timeout: Some(Duration::from_secs(30)),
            })
            .unwrap();
        // Both BLASes read the same source index array, with different lengths.
        // A cache keyed only by that source name loses one of these buffers.
        for i in 0..2 {
            assert_eq!(first._indices[i], second._indices[i]);
            assert_eq!(first._vertices[i], second._vertices[i]);
        }
        assert_eq!(first.mapping, second.mapping);
    }
}

#[cfg(test)]
mod as_sync_tests;
