//! Keep C symbols available when their native import backend is unsupported.
#![cfg(not(any(target_os = "windows", target_os = "linux")))]
use super::*;

#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_engine_import_vulkan_image(
    _engine: u64,
    _desc: *const c_void,
    _output: *mut u64,
    error_out: *mut c_char,
    capacity: usize,
) -> i32 {
    call(error_out, capacity, || {
        Err(error(
            Status::Unavailable,
            "Vulkan image export is unavailable",
        ))
    })
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_engine_import_vulkan_timeline(
    _engine: u64,
    _desc: *const c_void,
    _output: *mut u64,
    error_out: *mut c_char,
    capacity: usize,
) -> i32 {
    call(error_out, capacity, || {
        Err(error(
            Status::Unavailable,
            "Vulkan image export is unavailable",
        ))
    })
}

// macOS keeps its Metal dispatcher even with the legacy Vulkan interop feature.
#[cfg(not(target_os = "macos"))]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_render_export_gpu(
    _render: u64,
    _desc: *const c_void,
    sequence: *mut u64,
    error_out: *mut c_char,
    capacity: usize,
) -> i32 {
    call(error_out, capacity, || {
        if !sequence.is_null() {
            unsafe { sequence.write(0) };
        }
        Err(error(
            Status::Unavailable,
            "GPU image export is unavailable",
        ))
    })
}

#[cfg(not(target_os = "macos"))]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_engine_gpu_poll(
    _engine: u64,
    _sequence: u64,
    complete: *mut u32,
    error_out: *mut c_char,
    capacity: usize,
) -> i32 {
    call(error_out, capacity, || {
        if !complete.is_null() {
            unsafe { complete.write(0) };
        }
        Err(error(
            Status::Unavailable,
            "GPU image export is unavailable",
        ))
    })
}

#[cfg(not(target_os = "macos"))]
#[unsafe(no_mangle)]
pub extern "C" fn mt_gpu_image_destroy(
    _image: u64,
    error_out: *mut c_char,
    capacity: usize,
) -> i32 {
    call(error_out, capacity, || {
        Err(error(
            Status::Unavailable,
            "GPU image export is unavailable",
        ))
    })
}

#[cfg(not(target_os = "macos"))]
#[unsafe(no_mangle)]
pub extern "C" fn mt_gpu_timeline_destroy(
    _timeline: u64,
    error_out: *mut c_char,
    capacity: usize,
) -> i32 {
    call(error_out, capacity, || {
        Err(error(
            Status::Unavailable,
            "GPU image export is unavailable",
        ))
    })
}
