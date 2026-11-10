#![cfg(target_os = "windows")]
use super::*;
use std::ffi::c_void;
use windows::Win32::Foundation::HANDLE;

#[repr(C)]
pub struct ImageDesc { struct_size: u32, reserved: u32, next: *const c_void, resource_handle: *mut c_void, format: u32, width: u32, height: u32, reserved2: u32 }
#[repr(C)]
pub struct TimelineDesc { struct_size: u32, reserved: u32, next: *const c_void, fence_handle: *mut c_void }
fn extensions(next: *const c_void, reserved: u32) -> Result<()> { if !next.is_null() || reserved != 0 { Err(invalid("Unsupported D3D12 GPU record extension/reserved field")) } else { Ok(()) } }
pub(super) unsafe fn import_image(owner: u64, desc: *const ImageDesc, output: *mut u64) -> Result<()> { let desc = unsafe { record(desc)? }; if output.is_null() || desc.struct_size as usize != std::mem::size_of::<ImageDesc>() || desc.reserved2 != 0 { return Err(invalid("Invalid D3D12 image record/output")); } extensions(desc.next, desc.reserved)?; let image = unsafe { engine_of(owner)?.import_d3d12_image(HANDLE(desc.resource_handle), desc.format, desc.width, desc.height)? }; unsafe { output.write(insert(Object::D3d12GpuImage { engine: owner, image })?) }; Ok(()) }
pub(super) unsafe fn import_timeline(owner: u64, desc: *const TimelineDesc, output: *mut u64) -> Result<()> { let desc = unsafe { record(desc)? }; if output.is_null() || desc.struct_size as usize != std::mem::size_of::<TimelineDesc>() { return Err(invalid("Invalid D3D12 timeline record/output")); } extensions(desc.next, desc.reserved)?; let timeline = unsafe { engine_of(owner)?.import_d3d12_timeline(HANDLE(desc.fence_handle))? }; unsafe { output.write(insert(Object::D3d12GpuTimeline { engine: owner, timeline })?) }; Ok(()) }
#[unsafe(no_mangle)] pub unsafe extern "C" fn mt_engine_import_d3d12_image(owner: u64, desc: *const ImageDesc, output: *mut u64, error_out: *mut c_char, capacity: usize) -> i32 { call(error_out, capacity, || unsafe { import_image(owner, desc, output) }) }
#[unsafe(no_mangle)] pub unsafe extern "C" fn mt_engine_import_d3d12_timeline(owner: u64, desc: *const TimelineDesc, output: *mut u64, error_out: *mut c_char, capacity: usize) -> i32 { call(error_out, capacity, || unsafe { import_timeline(owner, desc, output) }) }
