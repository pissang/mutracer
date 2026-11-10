//! Same-device D3D12 resource and fence imports.
#![cfg(target_os = "windows")]
use super::{Engine, Result, Status, error};
use std::collections::HashMap;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use wgpu::hal::api::Dx12;
use windows::Win32::Foundation::HANDLE;
use windows::Win32::Graphics::Direct3D12::{
    D3D12_FENCE_FLAG_SHARED, D3D12_FENCE_FLAG_SHARED_CROSS_ADAPTER, D3D12_HEAP_FLAG_SHARED,
    D3D12_HEAP_FLAG_SHARED_CROSS_ADAPTER, D3D12_HEAP_FLAGS, D3D12_HEAP_PROPERTIES,
    D3D12_HEAP_TYPE_DEFAULT, D3D12_RESOURCE_DIMENSION_TEXTURE2D,
    D3D12_RESOURCE_FLAG_ALLOW_UNORDERED_ACCESS, ID3D12Fence, ID3D12Fence1, ID3D12Resource,
};
use windows::Win32::Graphics::Dxgi::Common::{
    DXGI_FORMAT, DXGI_FORMAT_R8G8B8A8_UNORM, DXGI_FORMAT_R16G16B16A16_FLOAT, DXGI_FORMAT_R32_FLOAT,
    DXGI_FORMAT_R32G32B32A32_FLOAT,
};
use windows::core::Interface;

fn invalid(message: &str) -> super::Error {
    error(Status::InvalidArgument, message)
}
fn unavailable() -> super::Error {
    error(Status::Unavailable, "D3D12 GPU export is unavailable")
}

#[derive(Clone)]
pub struct D3d12Image {
    pub(super) engine: Engine,
    pub(super) texture: wgpu::Texture,
    pub(super) raw_id: usize,
}
#[derive(Clone)]
pub struct D3d12Timeline {
    pub(super) engine: Engine,
    pub(super) fence: ID3D12Fence,
    pub(super) last_signal: Arc<Mutex<u64>>,
}

pub struct State {
    pub(super) sequence: u64,
    pub(super) completed: u64,
    pending: Vec<Pending>,
    pub(super) pipelines: HashMap<(wgpu::TextureFormat, u32, bool), wgpu::ComputePipeline>,
}
struct Pending {
    sequence: u64,
    complete: Arc<AtomicBool>,
    done: D3d12Timeline,
    value: u64,
    failed: bool,
    _images: Vec<wgpu::Texture>,
    _sources: Vec<wgpu::Texture>,
    _ready: Option<D3d12Timeline>,
}
impl State {
    pub(super) fn new() -> Self {
        Self {
            sequence: 0,
            completed: 0,
            pending: vec![],
            pipelines: HashMap::new(),
        }
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
        Ok(D3d12Timeline {
            engine: self.clone(),
            fence,
            last_signal: Arc::new(Mutex::new(value)),
        })
    }
}

impl super::Render {
    pub(super) fn export_d3d12(
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
        }
        let mut sources = Vec::new();
        for (image, kind, rows) in images {
            if !Arc::ptr_eq(&engine.inner, &image.engine.inner) || *rows > 1 {
                return Err(invalid(
                    "D3D12 image belongs to another engine or has invalid row order",
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
        let mut last = done.0.last_signal.lock().unwrap();
        if done.1 <= *last {
            return Err(invalid("D3D12 done values must strictly increase"));
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
                let layout = gpu.device.create_bind_group_layout(
                    &wgpu::BindGroupLayoutDescriptor {
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
                    },
                );
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
        let command = encoder.finish();
        let sequence = state
            .sequence
            .checked_add(1)
            .ok_or_else(|| error(Status::Error, "GPU sequence exhausted"))?;
        let complete = Arc::new(AtomicBool::new(false));
        let flag = complete.clone();
        let mut pending = Pending {
            sequence,
            complete,
            done: done.0.clone(),
            value: done.1,
            failed: false,
            _images: images.iter().map(|(i, _, _)| i.texture.clone()).collect(),
            _sources: sources,
            _ready: ready.map(|(r, _)| r.clone()),
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
                error(Status::Unavailable, format!("D3D12 queue signal failed: {e}"))
            })?;
            Ok(())
        });
        if let Err(error) = result {
            if submitted {
                // The command is in flight but the completion signal is unknown;
                // retain all resources and never credit this sequence as done.
                pending.failed = true;
                *last = done.1;
                state.sequence = sequence;
                state.pending.push(pending);
            }
            return Err(error);
        }
        *last = done.1;
        state.sequence = sequence;
        state.pending.push(pending);
        Ok(sequence)
    }
}

impl Engine {
    pub(super) fn poll_d3d12_exports(&self, sequence: u64) -> Result<bool> {
        self.poll_device();
        self.check_device()?;
        let hal = unsafe { self.inner.gpu.device.as_hal::<Dx12>() }.ok_or_else(unavailable)?;
        unsafe { hal.raw_device().GetDeviceRemovedReason() }.map_err(|e| {
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
            let completed = unsafe { work.done.fence.GetCompletedValue() };
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
    use super::fence_completed;

    #[test]
    fn removed_fence_value_is_not_completion() {
        assert!(fence_completed(9, 8).unwrap());
        assert!(!fence_completed(7, 8).unwrap());
        assert!(fence_completed(u64::MAX, 8).is_err());
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
        "vec4f(v.x,0,0,v.y)"
    } else {
        "v"
    };
    format!(
        "@group(0) @binding(0) var input: texture_2d<f32>;\n@group(0) @binding(1) var output: texture_storage_2d<{output},write>;\n@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id: vec3u) {{ let size=textureDimensions(output); if(any(id.xy>=size)){{return;}} let src=vec2u(id.x,{}); let v=textureLoad(input,vec2i(src),0); textureStore(output,vec2i(id.xy),{}); }}",
        if flip { "size.y-1u-id.y" } else { "id.y" },
        convert
    )
}
