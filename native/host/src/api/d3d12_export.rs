//! Same-device D3D12 resource and fence imports.
#![cfg(target_os = "windows")]
use super::{Engine, Result, Status, error};
use std::sync::{Arc, Mutex};
use windows::Win32::Foundation::HANDLE;
use windows::Win32::Graphics::Direct3D12::{ID3D12Fence, ID3D12Resource};
use windows::core::Interface;
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT, DXGI_FORMAT_R16G16B16A16_FLOAT, DXGI_FORMAT_R32_FLOAT, DXGI_FORMAT_R32G32B32A32_FLOAT, DXGI_FORMAT_R8G8B8A8_UNORM};
use wgpu::hal::api::Dx12;

fn invalid(message: &str) -> super::Error { error(Status::InvalidArgument, message) }
fn unavailable() -> super::Error { error(Status::Unavailable, "D3D12 GPU export is unavailable") }

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

fn format(value: u32) -> Result<wgpu::TextureFormat> {
    match DXGI_FORMAT(value as i32) {
        DXGI_FORMAT_R32G32B32A32_FLOAT => Ok(wgpu::TextureFormat::Rgba32Float),
        DXGI_FORMAT_R16G16B16A16_FLOAT => Ok(wgpu::TextureFormat::Rgba16Float),
        DXGI_FORMAT_R32_FLOAT => Ok(wgpu::TextureFormat::R32Float),
        DXGI_FORMAT_R8G8B8A8_UNORM => Ok(wgpu::TextureFormat::Rgba8Unorm),
        _ => Err(unavailable()),
    }
}

impl Engine {
    /// Open a host NT-shared D3D12 texture on this engine's raw device.
    pub unsafe fn import_d3d12_image(&self, handle: HANDLE, format_value: u32, width: u32, height: u32) -> Result<D3d12Image> {
        self.check_device()?;
        if handle.0.is_null() || width == 0 || height == 0 { return Err(invalid("Null D3D12 resource handle or invalid dimensions")); }
        let format = format(format_value)?;
        let hal = unsafe { self.inner.gpu.device.as_hal::<Dx12>() }.ok_or_else(unavailable)?;
        let mut resource: Option<ID3D12Resource> = None;
        unsafe { hal.raw_device().OpenSharedHandle(handle, &mut resource) }.map_err(|e| error(Status::InvalidArgument, format!("D3D12 OpenSharedHandle(resource) failed: {e}")))?;
        let resource = resource.ok_or_else(|| invalid("D3D12 shared resource returned null"))?;
        let raw_id = resource.as_raw() as usize;
        let size = wgpu::Extent3d { width, height, depth_or_array_layers: 1 };
        let raw = unsafe { wgpu::hal::dx12::Device::texture_from_raw(resource, format, wgpu::TextureDimension::D2, size, 1, 1) };
        let texture = unsafe { self.inner.gpu.device.create_texture_from_hal::<Dx12>(raw, &wgpu::TextureDescriptor { label: Some("MuTracer imported D3D12 image"), size, mip_level_count: 1, sample_count: 1, dimension: wgpu::TextureDimension::D2, format, usage: wgpu::TextureUsages::STORAGE_BINDING | wgpu::TextureUsages::TEXTURE_BINDING, view_formats: &[] }, wgpu::TextureUses::UNINITIALIZED) };
        Ok(D3d12Image { engine: self.clone(), texture, raw_id })
    }

    /// Open a host NT-shared fence. The fence remains owned by the host.
    pub unsafe fn import_d3d12_timeline(&self, handle: HANDLE) -> Result<D3d12Timeline> {
        self.check_device()?;
        if handle.0.is_null() { return Err(invalid("Null D3D12 fence handle")); }
        let hal = unsafe { self.inner.gpu.device.as_hal::<Dx12>() }.ok_or_else(unavailable)?;
        let mut fence: Option<ID3D12Fence> = None;
        unsafe { hal.raw_device().OpenSharedHandle(handle, &mut fence) }.map_err(|e| error(Status::InvalidArgument, format!("D3D12 OpenSharedHandle(fence) failed: {e}")))?;
        let fence = fence.ok_or_else(|| invalid("D3D12 shared fence returned null"))?;
        let value = unsafe { fence.GetCompletedValue() };
        Ok(D3d12Timeline { engine: self.clone(), fence, last_signal: Arc::new(Mutex::new(value)) })
    }
}
