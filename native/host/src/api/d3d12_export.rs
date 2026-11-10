//! Same-device D3D12 resource and fence imports.
#![cfg(target_os = "windows")]
use super::{error, Engine, Result, Status};
use std::collections::{HashMap, HashSet};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use wgpu::hal::api::Dx12;
use windows::core::Interface;
use windows::Win32::Foundation::HANDLE;
use windows::Win32::Graphics::Direct3D12::{
    ID3D12Fence, ID3D12Fence1, ID3D12Resource, D3D12_FENCE_FLAG_SHARED,
    D3D12_FENCE_FLAG_SHARED_CROSS_ADAPTER, D3D12_HEAP_FLAGS, D3D12_HEAP_FLAG_SHARED,
    D3D12_HEAP_FLAG_SHARED_CROSS_ADAPTER, D3D12_HEAP_PROPERTIES, D3D12_HEAP_TYPE_DEFAULT,
    D3D12_RESOURCE_DIMENSION_TEXTURE2D, D3D12_RESOURCE_FLAG_ALLOW_UNORDERED_ACCESS,
};
use windows::Win32::Graphics::Dxgi::Common::{
    DXGI_FORMAT, DXGI_FORMAT_R16G16B16A16_FLOAT, DXGI_FORMAT_R32G32B32A32_FLOAT,
    DXGI_FORMAT_R32_FLOAT, DXGI_FORMAT_R8G8B8A8_UNORM,
};

fn invalid(message: &str) -> super::Error {
    error(Status::InvalidArgument, message)
}
fn unavailable() -> super::Error {
    error(Status::Unavailable, "D3D12 GPU export is unavailable")
}

fn reserve_timeline_value(last_signal: &Arc<Mutex<u64>>, value: u64) -> Result<()> {
    let mut last = last_signal.lock().unwrap();
    if value == 0 || value == u64::MAX || value <= *last {
        return Err(invalid("D3D12 timeline value is not strictly increasing"));
    }
    *last = value;
    Ok(())
}

/// Borrowed wrapper for a host-owned same-device D3D12 UAV texture.
#[derive(Clone)]
pub struct D3d12Image {
    pub(super) engine: Engine,
    pub(super) texture: wgpu::Texture,
    pub(super) raw_id: usize,
}
/// Borrowed wrapper for a host-owned same-device shared fence.
#[derive(Clone)]
pub struct D3d12Timeline {
    pub(super) engine: Engine,
    pub(super) fence: ID3D12Fence,
    pub(super) last_signal: Arc<Mutex<u64>>,
}

pub(crate) struct State {
    pub(super) sequence: u64,
    pub(super) completed: u64,
    pending: Vec<Pending>,
    pub(super) pipelines: HashMap<(wgpu::TextureFormat, u32, bool), wgpu::ComputePipeline>,
    pub(super) timelines: HashMap<usize, Arc<Mutex<u64>>>,
}
struct Pending {
    sequence: u64,
    complete: Arc<AtomicBool>,
    done: ID3D12Fence,
    value: u64,
    failed: bool,
    _images: Vec<wgpu::Texture>,
    _sources: Vec<wgpu::Texture>,
    _ready: Option<ID3D12Fence>,
}
impl State {
    pub(super) fn new() -> Self {
        Self {
            sequence: 0,
            completed: 0,
            pending: vec![],
            pipelines: HashMap::new(),
            timelines: HashMap::new(),
        }
    }

    pub(super) fn pending_is_empty(&self) -> bool {
        self.pending.is_empty()
    }
}

fn format(value: u32) -> Result<wgpu::TextureFormat> {
    match DXGI_FORMAT(value as i32) {
        DXGI_FORMAT_R32G32B32A32_FLOAT => Ok(wgpu::TextureFormat::Rgba32Float),
        DXGI_FORMAT_R16G16B16A16_FLOAT => Ok(wgpu::TextureFormat::Rgba16Float),
        DXGI_FORMAT_R32_FLOAT => Ok(wgpu::TextureFormat::R32Float),
        DXGI_FORMAT_R8G8B8A8_UNORM => Ok(wgpu::TextureFormat::Rgba8Unorm),
        _ => Err(unavailable()),
    }
}

fn fence_completed(value: u64, expected: u64) -> Result<bool> {
    if value == u64::MAX {
        return Err(error(
            Status::Unavailable,
            "D3D12 fence reports device removal; export outcome is unknown",
        ));
    }
    Ok(value >= expected)
}

impl Engine {
    pub(super) fn is_d3d12(&self) -> bool {
        self.inner.d3d12.lock().unwrap().is_some()
    }
    pub(super) fn d3d12_info(&self) -> Result<super::abi::d3d12_export_abi::DeviceInfo> {
        let hal = unsafe { self.inner.gpu.device.as_hal::<Dx12>() }.ok_or_else(unavailable)?;
        Ok(super::abi::d3d12_export_abi::DeviceInfo {
            struct_size: std::mem::size_of::<super::abi::d3d12_export_abi::DeviceInfo>() as u32,
            reserved: 0,
            device: hal.raw_device().as_raw().cast(),
            queue: hal.raw_queue().as_raw().cast(),
        })
    }

    /// Open a host NT-shared D3D12 texture on this engine's raw device.
    ///
    /// The returned wrapper borrows the resource. It does not close the NT
    /// handle or release the host's resource on behalf of the caller. The
    /// resource must be a same-adapter, shared DEFAULT-heap 2D UAV texture with
    /// one mip/sample and the exact declared format and extent.
    ///
    /// # Safety
    /// `handle` must be a valid NT handle created for the exact raw device
    /// behind this engine and must remain open, with its resource alive, until
    /// the wrapper and all accepted export work have been retired. The caller
    /// must keep D3D12 resource-state transitions coherent with the queue work.
    pub unsafe fn import_d3d12_image(
        &self,
        handle: HANDLE,
        format_value: u32,
        width: u32,
        height: u32,
    ) -> Result<D3d12Image> {
        self.check_device()?;
        if handle.0.is_null() || width == 0 || height == 0 {
            return Err(invalid("Null D3D12 resource handle or invalid dimensions"));
        }
        let format = format(format_value)?;
        let hal = unsafe { self.inner.gpu.device.as_hal::<Dx12>() }.ok_or_else(unavailable)?;
        let mut resource: Option<ID3D12Resource> = None;
        unsafe { hal.raw_device().OpenSharedHandle(handle, &mut resource) }.map_err(|e| {
            error(
                Status::InvalidArgument,
                format!("D3D12 OpenSharedHandle(resource) failed: {e}"),
            )
        })?;
        let resource = resource.ok_or_else(|| invalid("D3D12 shared resource returned null"))?;
        let native_desc = unsafe { resource.GetDesc() };
        let mut heap = D3D12_HEAP_PROPERTIES::default();
        let mut heap_flags = D3D12_HEAP_FLAGS::default();
        unsafe { resource.GetHeapProperties(Some(&mut heap), Some(&mut heap_flags)) }.map_err(
            |e| {
                error(
                    Status::InvalidArgument,
                    format!("D3D12 resource properties failed: {e}"),
                )
            },
        )?;
        if native_desc.Dimension != D3D12_RESOURCE_DIMENSION_TEXTURE2D
            || native_desc.Width != width as u64
            || native_desc.Height != height
            || native_desc.DepthOrArraySize != 1
            || native_desc.MipLevels != 1
            || native_desc.SampleDesc.Count != 1
            || native_desc.Format.0 as u32 != format_value
            || !native_desc
                .Flags
                .contains(D3D12_RESOURCE_FLAG_ALLOW_UNORDERED_ACCESS)
            || heap.Type != D3D12_HEAP_TYPE_DEFAULT
            || !heap_flags.contains(D3D12_HEAP_FLAG_SHARED)
            || heap_flags.contains(D3D12_HEAP_FLAG_SHARED_CROSS_ADAPTER)
        {
            return Err(invalid(
                "D3D12 shared resource must be a same-adapter 2D single-sample UAV texture matching the descriptor",
            ));
        }
        let raw_id = resource.as_raw() as usize;
        let size = wgpu::Extent3d {
            width,
            height,
            depth_or_array_layers: 1,
        };
        let raw = unsafe {
            wgpu::hal::dx12::Device::texture_from_raw(
                resource,
                format,
                wgpu::TextureDimension::D2,
                size,
                1,
                1,
            )
        };
        let texture = unsafe {
            self.inner.gpu.device.create_texture_from_hal::<Dx12>(
                raw,
                &wgpu::TextureDescriptor {
                    label: Some("MuTracer imported D3D12 image"),
                    size,
                    mip_level_count: 1,
                    sample_count: 1,
                    dimension: wgpu::TextureDimension::D2,
                    format,
                    usage: wgpu::TextureUsages::STORAGE_BINDING
                        | wgpu::TextureUsages::TEXTURE_BINDING,
                    view_formats: &[],
                },
                wgpu::TextureUses::UNINITIALIZED,
            )
        };
        Ok(D3d12Image {
            engine: self.clone(),
            texture,
            raw_id,
        })
    }

    /// Open a host NT-shared fence. The fence remains owned by the host.
    ///
    /// The fence must have `D3D12_FENCE_FLAG_SHARED` without
    /// `D3D12_FENCE_FLAG_SHARED_CROSS_ADAPTER`; values are strictly increasing
    /// per imported done timeline and `UINT64_MAX` is reserved for device loss.
    ///
    /// # Safety
    /// `handle` must be a valid NT handle for a fence created by the exact raw
    /// device behind this engine. Keep the handle and fence alive until the
    /// timeline wrapper is destroyed and all accepted exports have drained.
    pub unsafe fn import_d3d12_timeline(&self, handle: HANDLE) -> Result<D3d12Timeline> {
        self.check_device()?;
        if handle.0.is_null() {
            return Err(invalid("Null D3D12 fence handle"));
        }
        let hal = unsafe { self.inner.gpu.device.as_hal::<Dx12>() }.ok_or_else(unavailable)?;
        let mut fence: Option<ID3D12Fence> = None;
        unsafe { hal.raw_device().OpenSharedHandle(handle, &mut fence) }.map_err(|e| {
            error(
                Status::InvalidArgument,
                format!("D3D12 OpenSharedHandle(fence) failed: {e}"),
            )
        })?;
        let fence = fence.ok_or_else(|| invalid("D3D12 shared fence returned null"))?;
        let flags = unsafe {
            fence
                .cast::<ID3D12Fence1>()
                .map_err(|e| {
                    error(
                        Status::InvalidArgument,
                        format!("D3D12 shared fence query failed: {e}"),
                    )
                })?
                .GetCreationFlags()
        };
        if !flags.contains(D3D12_FENCE_FLAG_SHARED)
            || flags.contains(D3D12_FENCE_FLAG_SHARED_CROSS_ADAPTER)
        {
            return Err(invalid("D3D12 fence must be shared on the same adapter"));
        }
        let value = unsafe { fence.GetCompletedValue() };
        if value == u64::MAX {
            return Err(error(
                Status::Unavailable,
                "D3D12 fence reports device removal while importing",
            ));
        }
        let identity = fence.cast::<windows::core::IUnknown>().map_err(|e| {
            error(
                Status::InvalidArgument,
                format!("D3D12 fence identity query failed: {e}"),
            )
        })?;
        let key = identity.as_raw() as usize;
        let mut state = self.inner.d3d12.lock().unwrap();
        let last_signal = state
            .as_mut()
            .ok_or_else(unavailable)?
            .timelines
            .entry(key)
            .or_insert_with(|| Arc::new(Mutex::new(value)))
            .clone();
        Ok(D3d12Timeline {
            engine: self.clone(),
            fence,
            last_signal,
        })
    }
}

impl super::Render {
    /// Submit imported D3D12 images on this render.
    ///
    /// Each image tuple is `(image, kind, row_order)`. `kind` is `0` for HDR,
    /// `1` for depth, `2` for display RGBA8 and `3` for center-depth. HDR and
    /// center-depth use RGBA float output; depth/center-depth also accept R32F
    /// (the center value is written to `.x`). `row_order` is `0` top-first or
    /// `1` bottom-first; it defaults to `0` in the C record.
    /// `ready`, when present, must be less than `done` on the same fence; the
    /// returned sequence is polled with [`Engine::poll_d3d12_exports`]. Calls
    /// use the engine's ordinary exclusive thread rule and retain imported
    /// wrappers until the sequence retires.
    pub fn export_d3d12(
        &self,
        images: &[(D3d12Image, u32, u32)],
        ready: Option<(&D3d12Timeline, u64)>,
        done: (&D3d12Timeline, u64),
    ) -> Result<u64> {
        let engine = self.engine().clone();
        if images.is_empty()
            || images.len() > 8
            || !Arc::ptr_eq(&engine.inner, &done.0.engine.inner)
        {
            return Err(invalid("Invalid D3D12 export images or done timeline"));
        }
        if done.1 == 0 || done.1 == u64::MAX {
            return Err(invalid("Invalid D3D12 done value"));
        }
        if let Some((r, value)) = ready {
            if !Arc::ptr_eq(&engine.inner, &r.engine.inner) || value == u64::MAX {
                return Err(invalid("Invalid D3D12 ready timeline"));
            }
            if r.fence.as_raw() == done.0.fence.as_raw() && value >= done.1 {
                return Err(invalid(
                    "D3D12 ready value must be less than done on the same timeline",
                ));
            }
        }
        let mut sources = Vec::new();
        let mut destination_ids = HashSet::new();
        for (image, kind, rows) in images {
            if !Arc::ptr_eq(&engine.inner, &image.engine.inner) || *rows > 1 {
                return Err(invalid(
                    "D3D12 image belongs to another engine or has invalid row order",
                ));
            }
            if !destination_ids.insert(image.raw_id) {
                return Err(invalid(
                    "D3D12 export destinations must be distinct resources",
                ));
            }
            let source = match *kind {
                0 => self
                    .get_output_texture(super::OutputKind::Hdr)?
                    .ok_or_else(|| error(Status::InvalidState, "No completed HDR image"))?,
                1 => self
                    .get_aov_texture(super::PixelKind::Depth)?
                    .ok_or_else(|| error(Status::InvalidState, "No completed depth image"))?,
                2 => self
                    .get_output_texture(super::OutputKind::Display)?
                    .ok_or_else(|| error(Status::InvalidState, "No composed display image"))?,
                3 => self
                    .get_aov_texture(super::PixelKind::CenterDepth)?
                    .ok_or_else(|| {
                        error(Status::InvalidState, "No completed center depth image")
                    })?,
                _ => return Err(invalid("Unknown D3D12 output kind")),
            };
            if source.size() != image.texture.size() {
                return Err(invalid("D3D12 export dimensions do not match"));
            }
            let valid = match *kind {
                0 => matches!(
                    image.texture.format(),
                    wgpu::TextureFormat::Rgba32Float | wgpu::TextureFormat::Rgba16Float
                ),
                1 | 3 => matches!(
                    image.texture.format(),
                    wgpu::TextureFormat::R32Float | wgpu::TextureFormat::Rgba32Float
                ),
                2 => image.texture.format() == wgpu::TextureFormat::Rgba8Unorm,
                _ => false,
            };
            if !valid {
                return Err(invalid("D3D12 export format does not match output kind"));
            }
            sources.push(source);
        }
        let mut guard = engine.inner.d3d12.lock().unwrap();
        let state = guard.as_mut().ok_or_else(unavailable)?;
        if state.pending.len() >= 32 {
            return Err(error(Status::Busy, "32 GPU exports are pending"));
        }
        let gpu = &engine.inner.gpu;
        // Complete command encoding and all sequence/resource validation before
        // touching a host fence. A rejected call must not wait or signal it.
        let mut encoder = gpu
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("MuTracer D3D12 output export"),
            });
        for ((image, kind, rows), source) in images.iter().zip(&sources) {
            let format = image.texture.format();
            let key = (format, *kind, *rows == 1);
            let pipeline = state.pipelines.entry(key).or_insert_with(|| {
                let module = gpu
                    .device
                    .create_shader_module(wgpu::ShaderModuleDescriptor {
                        label: Some("D3D12 output conversion"),
                        source: wgpu::ShaderSource::Wgsl(shader(format, *kind, *rows == 1).into()),
                    });
                let layout =
                    gpu.device
                        .create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                            label: None,
                            entries: &[
                                wgpu::BindGroupLayoutEntry {
                                    binding: 0,
                                    visibility: wgpu::ShaderStages::COMPUTE,
                                    ty: wgpu::BindingType::Texture {
                                        sample_type: wgpu::TextureSampleType::Float {
                                            filterable: false,
                                        },
                                        view_dimension: wgpu::TextureViewDimension::D2,
                                        multisampled: false,
                                    },
                                    count: None,
                                },
                                wgpu::BindGroupLayoutEntry {
                                    binding: 1,
                                    visibility: wgpu::ShaderStages::COMPUTE,
                                    ty: wgpu::BindingType::StorageTexture {
                                        access: wgpu::StorageTextureAccess::WriteOnly,
                                        format,
                                        view_dimension: wgpu::TextureViewDimension::D2,
                                    },
                                    count: None,
                                },
                            ],
                        });
                let pl = gpu
                    .device
                    .create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                        label: None,
                        bind_group_layouts: &[Some(&layout)],
                        immediate_size: 0,
                    });
                gpu.device
                    .create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                        label: Some("D3D12 host image export"),
                        layout: Some(&pl),
                        module: &module,
                        entry_point: Some("main"),
                        compilation_options: Default::default(),
                        cache: None,
                    })
            });
            let input = source.create_view(&Default::default());
            let output = image.texture.create_view(&Default::default());
            let group = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: None,
                layout: &pipeline.get_bind_group_layout(0),
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: wgpu::BindingResource::TextureView(&input),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: wgpu::BindingResource::TextureView(&output),
                    },
                ],
            });
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                ..Default::default()
            });
            pass.set_pipeline(pipeline);
            pass.set_bind_group(0, &group, &[]);
            pass.dispatch_workgroups(source.width().div_ceil(8), source.height().div_ceil(8), 1);
        }
        // DX12 PRESENT maps to native COMMON. Keep the exported resource in
        // COMMON for host copies and for the next export's tracked state.
        encoder.transition_resources(
            std::iter::empty(),
            images.iter().map(|(image, _, _)| wgpu::TextureTransition {
                texture: &image.texture,
                selector: None,
                state: wgpu::TextureUses::PRESENT,
            }),
        );
        let command = encoder.finish();
        let sequence = state
            .sequence
            .checked_add(1)
            .ok_or_else(|| error(Status::Error, "GPU sequence exhausted"))?;
        reserve_timeline_value(&done.0.last_signal, done.1)?;
        let complete = Arc::new(AtomicBool::new(false));
        let flag = complete.clone();
        let mut pending = Pending {
            sequence,
            complete,
            done: done.0.fence.clone(),
            value: done.1,
            failed: false,
            _images: images.iter().map(|(i, _, _)| i.texture.clone()).collect(),
            _sources: sources,
            _ready: ready.map(|(r, _)| r.fence.clone()),
        };
        let mut submitted = false;
        let result = gpu.queue.exclusive_submit(|queue| -> Result<()> {
            let hal = unsafe { gpu.device.as_hal::<Dx12>() }.ok_or_else(unavailable)?;
            if let Some((r, value)) = ready {
                unsafe { hal.raw_queue().Wait(&r.fence, value) }.map_err(|e| {
                    error(Status::Unavailable, format!("D3D12 queue wait failed: {e}"))
                })?;
            }
            queue.submit([command]);
            submitted = true;
            queue.on_submitted_work_done(move || {
                flag.store(true, Ordering::Release);
            });
            unsafe { hal.raw_queue().Signal(&done.0.fence, done.1) }.map_err(|e| {
                error(
                    Status::Unavailable,
                    format!("D3D12 queue signal failed: {e}"),
                )
            })?;
            Ok(())
        });
        if let Err(error) = result {
            if submitted {
                // The command is in flight but the completion signal is unknown;
                // retain all resources and never credit this sequence as done.
                pending.failed = true;
                state.sequence = sequence;
                state.pending.push(pending);
            }
            return Err(error);
        }
        state.sequence = sequence;
        state.pending.push(pending);
        Ok(sequence)
    }
}

impl Engine {
    /// Poll a D3D12 export sequence. `sequence == 0` means the latest engine
    /// sequence. `Ok(false)` means not complete; device loss, including a
    /// fence value of `UINT64_MAX`, is [`Status::Unavailable`] and never
    /// credits completion.
    pub fn poll_d3d12_exports(&self, sequence: u64) -> Result<bool> {
        self.poll_device();
        if let Some(reason) = self.inner.gpu.loss.reason().map(str::to_owned) {
            if let Ok(mut guard) = self.inner.d3d12.lock() {
                if let Some(state) = guard.as_mut() {
                    state.pending.clear();
                }
            }
            return Err(error(
                Status::Unavailable,
                format!("D3D12 device lost while polling export fence: {reason}"),
            ));
        }
        self.check_device()?;
        let hal = unsafe { self.inner.gpu.device.as_hal::<Dx12>() }.ok_or_else(unavailable)?;
        unsafe { hal.raw_device().GetDeviceRemovedReason() }.map_err(|e| {
            self.inner
                .gpu
                .loss
                .notify(format!("D3D12 device removed while polling export: {e}"));
            error(
                Status::Unavailable,
                format!("D3D12 device removed; export outcome is unknown: {e}"),
            )
        })?;
        let mut guard = self.inner.d3d12.lock().unwrap();
        let state = guard.as_mut().ok_or_else(unavailable)?;
        if sequence > state.sequence {
            return Err(invalid("Unknown D3D12 GPU export sequence"));
        }
        while let Some(work) = state.pending.first() {
            if work.failed {
                if !work.complete.load(Ordering::Acquire) {
                    return Err(error(
                        Status::Unavailable,
                        "D3D12 export signal failed; export outcome is unknown",
                    ));
                }
                state.pending.remove(0);
                return Err(error(
                    Status::Unavailable,
                    "D3D12 export signal failed; export outcome is unknown",
                ));
            }
            if !work.complete.load(Ordering::Acquire) {
                break;
            }
            let completed = unsafe { work.done.GetCompletedValue() };
            if completed == u64::MAX {
                self.inner
                    .gpu
                    .loss
                    .notify("D3D12 fence returned UINT64_MAX while polling export");
            }
            if !fence_completed(completed, work.value)? {
                break;
            }
            state.completed = work.sequence;
            state.pending.remove(0);
        }
        Ok(state.completed
            >= if sequence == 0 {
                state.sequence
            } else {
                sequence
            })
    }
}

#[cfg(test)]
mod tests {
    use super::{fence_completed, reserve_timeline_value};
    use std::sync::{Arc, Mutex};

    #[test]
    fn removed_fence_value_is_not_completion() {
        assert!(fence_completed(9, 8).unwrap());
        assert!(!fence_completed(7, 8).unwrap());
        assert!(fence_completed(u64::MAX, 8).is_err());
    }

    #[test]
    fn duplicate_import_wrappers_share_signal_reservation() {
        let canonical = Arc::new(Mutex::new(0));
        let second_wrapper = canonical.clone();
        assert!(reserve_timeline_value(&canonical, 1).is_ok());
        assert!(reserve_timeline_value(&second_wrapper, 1).is_err());
        assert!(reserve_timeline_value(&second_wrapper, 2).is_ok());
    }
}

#[cfg(all(test, target_os = "windows"))]
mod gpu_tests {
    use super::*;
    use crate::api::{
        Backend, ConvergeOptions, EngineOptions, PixelKind, Render, RenderSettings, RenderSize,
    };
    use crate::scene_api::{Environment, Geometry, Mesh, OpenPbrMaterial, Scene};
    use glam::{Mat4, Vec3};
    use std::ffi::c_void;
    use std::mem::ManuallyDrop;
    use std::time::Instant;
    use wgpu::hal::api::Dx12;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::Graphics::Direct3D12::*;
    use windows::Win32::Graphics::Dxgi::Common::*;

    unsafe fn shared_texture(
        device: &ID3D12Device,
        format: DXGI_FORMAT,
    ) -> (ID3D12Resource, HANDLE) {
        let heap = D3D12_HEAP_PROPERTIES {
            Type: D3D12_HEAP_TYPE_DEFAULT,
            ..Default::default()
        };
        let desc = D3D12_RESOURCE_DESC {
            Dimension: D3D12_RESOURCE_DIMENSION_TEXTURE2D,
            Width: 8,
            Height: 6,
            DepthOrArraySize: 1,
            MipLevels: 1,
            Format: format,
            SampleDesc: DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0,
            },
            Layout: D3D12_TEXTURE_LAYOUT_UNKNOWN,
            Flags: D3D12_RESOURCE_FLAG_ALLOW_UNORDERED_ACCESS,
            ..Default::default()
        };
        let mut resource = None;
        unsafe {
            device
                .CreateCommittedResource::<ID3D12Resource>(
                    &heap,
                    D3D12_HEAP_FLAG_SHARED,
                    &desc,
                    D3D12_RESOURCE_STATE_COMMON,
                    None,
                    &mut resource,
                )
                .unwrap();
        }
        let resource = resource.unwrap();
        let handle = unsafe {
            device
                .CreateSharedHandle(&resource, None, 0x10000000, PCWSTR::null())
                .unwrap()
        };
        (resource, handle)
    }

    unsafe fn copy_texture_readback(
        device: &ID3D12Device,
        queue: &ID3D12CommandQueue,
        source: &ID3D12Resource,
        bytes: u64,
    ) -> Vec<f32> {
        // D3D12 texture rows are padded to D3D12_TEXTURE_DATA_PITCH_ALIGNMENT;
        // CopyResource(texture, buffer) is not a valid texture readback.  Use
        // the device's footprint and strip the padding while mapping.
        let source_desc = unsafe { source.GetDesc() };
        let mut footprint = D3D12_PLACED_SUBRESOURCE_FOOTPRINT::default();
        let mut _rows = 0;
        let mut _row_bytes = 0;
        let mut total_bytes = 0;
        unsafe {
            device.GetCopyableFootprints(
                &source_desc,
                0,
                1,
                0,
                Some(&mut footprint),
                Some(&mut _rows),
                Some(&mut _row_bytes),
                Some(&mut total_bytes),
            );
        }
        let heap = D3D12_HEAP_PROPERTIES {
            Type: D3D12_HEAP_TYPE_READBACK,
            ..Default::default()
        };
        let desc = D3D12_RESOURCE_DESC {
            Dimension: D3D12_RESOURCE_DIMENSION_BUFFER,
            Width: total_bytes,
            Height: 1,
            DepthOrArraySize: 1,
            MipLevels: 1,
            Format: DXGI_FORMAT_UNKNOWN,
            SampleDesc: DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0,
            },
            Layout: D3D12_TEXTURE_LAYOUT_ROW_MAJOR,
            ..Default::default()
        };
        let mut readback = None;
        unsafe {
            device
                .CreateCommittedResource::<ID3D12Resource>(
                    &heap,
                    D3D12_HEAP_FLAG_NONE,
                    &desc,
                    D3D12_RESOURCE_STATE_COPY_DEST,
                    None,
                    &mut readback,
                )
                .unwrap();
        }
        let readback = readback.unwrap();
        let allocator: ID3D12CommandAllocator =
            unsafe { device.CreateCommandAllocator(D3D12_COMMAND_LIST_TYPE_DIRECT) }.unwrap();
        let list: ID3D12GraphicsCommandList = unsafe {
            device.CreateCommandList(0, D3D12_COMMAND_LIST_TYPE_DIRECT, &allocator, None)
        }
        .unwrap();
        let mut barrier = D3D12_RESOURCE_BARRIER {
            Type: D3D12_RESOURCE_BARRIER_TYPE_TRANSITION,
            Flags: D3D12_RESOURCE_BARRIER_FLAG_NONE,
            Anonymous: D3D12_RESOURCE_BARRIER_0 {
                Transition: ManuallyDrop::new(D3D12_RESOURCE_TRANSITION_BARRIER {
                    pResource: ManuallyDrop::new(Some(source.clone())),
                    Subresource: D3D12_RESOURCE_BARRIER_ALL_SUBRESOURCES,
                    StateBefore: D3D12_RESOURCE_STATE_UNORDERED_ACCESS,
                    StateAfter: D3D12_RESOURCE_STATE_COPY_SOURCE,
                }),
            },
        };
        unsafe {
            list.ResourceBarrier(std::slice::from_ref(&barrier));
            let mut dst_location = D3D12_TEXTURE_COPY_LOCATION {
                pResource: ManuallyDrop::new(Some(readback.clone())),
                Type: D3D12_TEXTURE_COPY_TYPE_PLACED_FOOTPRINT,
                Anonymous: D3D12_TEXTURE_COPY_LOCATION_0 {
                    PlacedFootprint: footprint,
                },
            };
            let mut src_location = D3D12_TEXTURE_COPY_LOCATION {
                pResource: ManuallyDrop::new(Some(source.clone())),
                Type: D3D12_TEXTURE_COPY_TYPE_SUBRESOURCE_INDEX,
                Anonymous: D3D12_TEXTURE_COPY_LOCATION_0 {
                    SubresourceIndex: 0,
                },
            };
            list.CopyTextureRegion(&dst_location, 0, 0, 0, &src_location, None);
            list.Close().unwrap();
            ManuallyDrop::drop(&mut (*barrier.Anonymous.Transition).pResource);
            ManuallyDrop::drop(&mut dst_location.pResource);
            ManuallyDrop::drop(&mut src_location.pResource);
            queue.ExecuteCommandLists(&[Some(list.cast().unwrap())]);
        }
        let completion: ID3D12Fence =
            unsafe { device.CreateFence(0, D3D12_FENCE_FLAG_NONE) }.unwrap();
        unsafe { queue.Signal(&completion, 1).unwrap() };
        for _ in 0..100_000 {
            if unsafe { completion.GetCompletedValue() } >= 1 {
                break;
            }
            std::thread::yield_now();
        }
        assert_eq!(unsafe { completion.GetCompletedValue() }, 1);
        let mut ptr: *mut c_void = std::ptr::null_mut();
        unsafe {
            readback
                .Map(
                    0,
                    Some(&D3D12_RANGE {
                        Begin: 0,
                        End: total_bytes as usize,
                    }),
                    Some(&mut ptr),
                )
                .unwrap();
        }
        let tight_row_bytes = bytes / u64::from(source_desc.Height);
        let row_pitch = u64::from(footprint.Footprint.RowPitch);
        let values = (0..source_desc.Height)
            .flat_map(|row| unsafe {
                let row_ptr = (ptr as *const u8)
                    .add((footprint.Offset + u64::from(row) * row_pitch) as usize);
                std::slice::from_raw_parts(row_ptr.cast::<f32>(), (tight_row_bytes / 4) as usize)
                    .iter()
                    .copied()
            })
            .collect::<Vec<_>>();
        unsafe {
            readback.Unmap(0, Some(&D3D12_RANGE { Begin: 0, End: 0 }));
        }
        values
    }

    #[test]
    #[ignore = "requires RTX-class D3D12 hardware"]
    fn d3d12_foreign_export_hdr_and_depth_match_readback() {
        let _lock = crate::abi_test_lock();
        // Use the same caller-owned DynamicDxc setup as the production
        // viewer.  The default Engine::on_adapter path intentionally keeps
        // FXC compatibility, but this megakernel is too large for FXC's loop
        // unroller on RTX 4060.
        let mut descriptor = wgpu::InstanceDescriptor {
            backends: wgpu::Backends::DX12,
            ..wgpu::InstanceDescriptor::new_without_display_handle()
        };
        descriptor.backend_options.dx12.shader_compiler = wgpu::Dx12Compiler::DynamicDxc {
            dxc_path: std::env::var("MUTRACER_TEST_DXC")
                .unwrap_or_else(|_| "dxcompiler.dll".into()),
        };
        let instance = wgpu::Instance::new(descriptor);
        let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            ..Default::default()
        }))
        .expect("D3D12 adapter");
        let adapter_info = adapter.get_info();
        println!("D3D12 export adapter: {adapter_info:?}");
        assert!(matches!(
            adapter_info.device_type,
            wgpu::DeviceType::DiscreteGpu | wgpu::DeviceType::IntegratedGpu
        ));
        let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
            required_limits: adapter.limits(),
            ..Default::default()
        }))
        .unwrap();
        let engine = Engine::on_device(
            &adapter,
            &device,
            &queue,
            EngineOptions {
                backend: Backend::Hardware,
            },
            None,
        );
        let mut scene = Scene::new();
        let geometry = scene
            .add_geometry(Geometry::new(
                vec![-1., -1., -2., 1., -1., -2., 0., 1., -2.],
                vec![0, 1, 2],
            ))
            .unwrap();
        let material = scene.add_material(OpenPbrMaterial::default()).unwrap();
        let mut mesh = Mesh::new(geometry, material);
        mesh.transform = Mat4::from_translation(Vec3::new(100., 0., 0.));
        scene.add_mesh(mesh).unwrap();
        scene
            .set_environment(Environment {
                color: [0.25, 0.5, 1., 1.],
                ..Default::default()
            })
            .unwrap();
        engine.set_scene_object(&scene).unwrap();
        engine.update().unwrap();
        let render = Render::new(
            &engine,
            RenderSettings {
                max_samples: 1,
                aovs: PixelKind::Depth.aov_mask(),
                aov_samples: 1,
                size: RenderSize::Fixed {
                    width: 8,
                    height: 6,
                },
                ..Default::default()
            },
        )
        .unwrap();
        render.converge(ConvergeOptions::new(1)).unwrap();
        let cpu_begin = Instant::now();
        let hdr_reference = render.read_pixels(PixelKind::Hdr).unwrap().data;
        let depth_reference = render.read_pixels(PixelKind::Depth).unwrap().data;
        println!(
            "D3D12 CPU read_pixels same scene: {:.3} ms",
            cpu_begin.elapsed().as_secs_f64() * 1000.0
        );
        let hal = unsafe { engine.inner.gpu.device.as_hal::<Dx12>() }.unwrap();
        let device = hal.raw_device().clone();
        let queue = hal.raw_queue().clone();
        let (hdr_resource, hdr_handle) =
            unsafe { shared_texture(&device, DXGI_FORMAT_R32G32B32A32_FLOAT) };
        let (depth_resource, depth_handle) =
            unsafe { shared_texture(&device, DXGI_FORMAT_R32_FLOAT) };
        let fence: ID3D12Fence = unsafe { device.CreateFence(0, D3D12_FENCE_FLAG_SHARED) }.unwrap();
        let fence_handle = unsafe {
            device
                .CreateSharedHandle(&fence, None, 0x10000000, PCWSTR::null())
                .unwrap()
        };
        let hdr = unsafe {
            engine
                .import_d3d12_image(hdr_handle, DXGI_FORMAT_R32G32B32A32_FLOAT.0 as u32, 8, 6)
                .unwrap()
        };
        let depth = unsafe {
            engine
                .import_d3d12_image(depth_handle, DXGI_FORMAT_R32_FLOAT.0 as u32, 8, 6)
                .unwrap()
        };
        let done = unsafe { engine.import_d3d12_timeline(fence_handle) }.unwrap();
        let export_begin = Instant::now();
        let sequence = render
            .export_d3d12(
                &[(hdr.clone(), 0, 0), (depth.clone(), 1, 0)],
                None,
                (&done, 1),
            )
            .unwrap();
        for _ in 0..5000 {
            if engine.poll_d3d12_exports(sequence).unwrap() {
                break;
            }
            std::thread::yield_now();
        }
        assert_eq!(unsafe { fence.GetCompletedValue() }, 1);
        assert!(engine.poll_d3d12_exports(sequence).unwrap());
        println!(
            "D3D12 export submit+fence: {:.3} ms",
            export_begin.elapsed().as_secs_f64() * 1000.0
        );
        assert_eq!(hdr_reference.len(), 8 * 6 * 4);
        assert_eq!(depth_reference.len(), 8 * 6 * 4);
        let hdr_exported =
            unsafe { copy_texture_readback(&device, &queue, &hdr_resource, (8 * 6 * 16) as u64) };
        let depth_exported =
            unsafe { copy_texture_readback(&device, &queue, &depth_resource, (8 * 6 * 16) as u64) };
        assert_eq!(hdr_exported, hdr_reference);
        assert_eq!(depth_exported, depth_reference);
        // The imported resources are kept alive through polling and host
        // readback, then all borrowed wrappers and handles are released in
        // host order.
        drop(hdr);
        drop(depth);
        drop(done);
        unsafe {
            CloseHandle(hdr_handle).unwrap();
            CloseHandle(depth_handle).unwrap();
            CloseHandle(fence_handle).unwrap();
        }
        drop(hdr_resource);
        drop(depth_resource);
        drop(fence);
        drop(queue);
    }
}

fn shader(format: wgpu::TextureFormat, kind: u32, flip: bool) -> String {
    let output = match format {
        wgpu::TextureFormat::Rgba32Float => "rgba32float",
        wgpu::TextureFormat::Rgba16Float => "rgba16float",
        wgpu::TextureFormat::R32Float => "r32float",
        _ => "rgba8unorm",
    };
    let convert = if kind == 1 || kind == 3 {
        if format == wgpu::TextureFormat::R32Float {
            "vec4f(v.x,0,0,1)"
        } else {
            "vec4f(v.x,0,0,v.y)"
        }
    } else {
        "v"
    };
    format!(
        "@group(0) @binding(0) var input: texture_2d<f32>;\n@group(0) @binding(1) var output: texture_storage_2d<{output},write>;\n@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id: vec3u) {{ let size=textureDimensions(output); if(any(id.xy>=size)){{return;}} let src=vec2u(id.x,{}); let v=textureLoad(input,vec2i(src),0); textureStore(output,vec2i(id.xy),{}); }}",
        if flip { "size.y-1u-id.y" } else { "id.y" },
        convert
    )
}
