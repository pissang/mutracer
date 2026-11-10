//! C ABI records for same-device Vulkan GPU exports.
use super::*;
use ash::vk;
use std::ffi::c_void;

#[repr(C)]
pub struct ImageDesc {
    struct_size: u32,
    reserved: u32,
    next: *const c_void,
    image: vk::Image,
    format: vk::Format,
    width: u32,
    height: u32,
    initial_layout: u32,
}
#[repr(C)]
pub struct TimelineDesc {
    struct_size: u32,
    reserved: u32,
    next: *const c_void,
    semaphore: vk::Semaphore,
}

fn extensions(next: *const c_void, reserved: u32) -> Result<()> {
    if !next.is_null() || reserved != 0 {
        return Err(invalid("Unsupported Vulkan GPU record extension/reserved field"));
    }
    Ok(())
}

pub(super) unsafe fn import_image(
    owner: u64,
    desc: *const ImageDesc,
    output: *mut u64,
) -> Result<()> {
    let desc = unsafe { record(desc)? };
    if desc.struct_size as usize != std::mem::size_of::<ImageDesc>() || output.is_null() {
        return Err(invalid("Invalid Vulkan image record/output"));
    }
    extensions(desc.next, desc.reserved)?;
    let image = unsafe {
        engine_of(owner)?.import_vulkan_image(
            desc.image,
            desc.format,
            desc.width,
            desc.height,
            vk::ImageLayout::from_raw(desc.initial_layout as i32),
        )?
    };
    unsafe { output.write(insert(Object::VulkanGpuImage { engine: owner, image })?) };
    Ok(())
}

pub(super) unsafe fn import_timeline(
    owner: u64,
    desc: *const TimelineDesc,
    output: *mut u64,
) -> Result<()> {
    let desc = unsafe { record(desc)? };
    if desc.struct_size as usize != std::mem::size_of::<TimelineDesc>() || output.is_null() {
        return Err(invalid("Invalid Vulkan timeline record/output"));
    }
    extensions(desc.next, desc.reserved)?;
    let timeline = unsafe { engine_of(owner)?.import_vulkan_timeline(desc.semaphore)? };
    unsafe { output.write(insert(Object::VulkanGpuTimeline { engine: owner, timeline })?) };
    Ok(())
}

pub(super) fn image(handle: u64) -> Result<super::vulkan_export::VulkanImage> {
    registry(|r| match r.objects.get(&handle) {
        Some(Object::VulkanGpuImage { image, .. }) => Ok(image.clone()),
        _ => Err(invalid_handle()),
    })
}
pub(super) fn timeline(handle: u64) -> Result<super::vulkan_export::VulkanTimeline> {
    registry(|r| match r.objects.get(&handle) {
        Some(Object::VulkanGpuTimeline { timeline, .. }) => Ok(timeline.clone()),
        _ => Err(invalid_handle()),
    })
}
pub(super) fn destroy(handle: u64, image: bool) -> Result<()> {
    let owner = registry(|r| match r.objects.get(&handle) {
        Some(Object::VulkanGpuImage { engine, .. }) if image => Ok(*engine),
        Some(Object::VulkanGpuTimeline { engine, .. }) if !image => Ok(*engine),
        _ => Err(invalid_handle()),
    })?;
    engine_of(owner)?;
    drop(registry(|r| Ok(r.objects.remove(&handle)))?);
    Ok(())
}

#[repr(C)]
struct ExportImage {
    struct_size: u32,
    kind: u32,
    next: *const c_void,
    image: u64,
    row_order: u32,
    reserved: u32,
}
#[repr(C)]
pub struct ExportDesc {
    struct_size: u32,
    image_count: u32,
    next: *const c_void,
    images: *const ExportImage,
    ready: u64,
    ready_value: u64,
    done: u64,
    done_value: u64,
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_render_export_gpu(
    render: u64,
    desc: *const ExportDesc,
    sequence: *mut u64,
    error_out: *mut c_char,
    capacity: usize,
) -> i32 {
    call(error_out, capacity, || {
        if sequence.is_null() {
            return Err(invalid("Null sequence output"));
        }
        unsafe { sequence.write(0) };
        let desc = unsafe { record(desc)? };
        if desc.struct_size as usize != std::mem::size_of::<ExportDesc>() || !(1..=8).contains(&desc.image_count) || desc.images.is_null() || desc.done == 0 || desc.done_value == 0 || desc.done_value == u64::MAX || (desc.ready == 0 && desc.ready_value != 0) {
            return Err(invalid("Invalid Vulkan GPU export record"));
        }
        if !desc.next.is_null() { return Err(invalid("Unsupported Vulkan GPU export extension")); }
        let entries = unsafe { std::slice::from_raw_parts(desc.images, desc.image_count as usize) };
        let mut vk_images = Vec::with_capacity(entries.len());
        #[cfg(target_os = "windows")]
        let mut dx_images = Vec::with_capacity(entries.len());
        let mut mode = 0u8;
        for item in entries {
            if item.struct_size as usize != std::mem::size_of::<ExportImage>() || !item.next.is_null() || item.reserved != 0 { return Err(invalid("Invalid Vulkan export image record")); }
            if let Ok(value) = image(item.image) {
                if mode == 2 { return Err(invalid("Cannot mix Vulkan and D3D12 export images")); }
                mode = 1; vk_images.push((value, item.kind, item.row_order));
            } else {
                #[cfg(target_os = "windows")]
                {
                    let value = super::d3d12_export_abi::image(item.image)?;
                    if mode == 1 { return Err(invalid("Cannot mix Vulkan and D3D12 export images")); }
                    mode = 2; dx_images.push((value, item.kind, item.row_order));
                }
                #[cfg(not(target_os = "windows"))]
                return Err(invalid("Unknown Vulkan image handle"));
            }
        }
        let id = if mode == 1 {
            let ready = if desc.ready == 0 { None } else { Some((timeline(desc.ready)?, desc.ready_value)) };
            let done = timeline(desc.done)?;
            render_of(render)?.export_vulkan(&vk_images, ready.as_ref().map(|(t, v)| (t, *v)), (&done, desc.done_value))?
        } else if mode == 2 {
            #[cfg(target_os = "windows")]
            {
                let ready = if desc.ready == 0 { None } else { Some((super::d3d12_export_abi::timeline(desc.ready)?, desc.ready_value)) };
                let done = super::d3d12_export_abi::timeline(desc.done)?;
                render_of(render)?.export_d3d12(&dx_images, ready.as_ref().map(|(t, v)| (t, *v)), (&done, desc.done_value))?
            }
            #[cfg(not(target_os = "windows"))]
            return Err(invalid("D3D12 export is unavailable on this platform"));
        } else { return Err(invalid("No export images")); };
        unsafe { sequence.write(id) };
        Ok(())
    })
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_engine_gpu_poll(
    engine: u64,
    sequence: u64,
    complete: *mut u32,
    error_out: *mut c_char,
    capacity: usize,
) -> i32 {
    call(error_out, capacity, || {
        if complete.is_null() {
            return Err(invalid("Null completion output"));
        }
        unsafe { complete.write(0) };
        #[cfg(target_os = "windows")]
        let value = if engine_of(engine)?.is_d3d12() { engine_of(engine)?.poll_d3d12_exports(sequence)? } else { engine_of(engine)?.poll_vulkan_exports(sequence)? };
        #[cfg(not(target_os = "windows"))]
        let value = engine_of(engine)?.poll_vulkan_exports(sequence)?;
        unsafe { complete.write(value as u32) };
        Ok(())
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn mt_gpu_image_destroy(image: u64, error_out: *mut c_char, capacity: usize) -> i32 {
    call(error_out, capacity, || destroy(image, true))
}

#[unsafe(no_mangle)]
pub extern "C" fn mt_gpu_timeline_destroy(timeline: u64, error_out: *mut c_char, capacity: usize) -> i32 {
    call(error_out, capacity, || destroy(timeline, false))
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_engine_import_vulkan_image(
    owner: u64,
    desc: *const ImageDesc,
    output: *mut u64,
    error_out: *mut c_char,
    capacity: usize,
) -> i32 {
    call(error_out, capacity, || unsafe { import_image(owner, desc, output) })
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_engine_import_vulkan_timeline(
    owner: u64,
    desc: *const TimelineDesc,
    output: *mut u64,
    error_out: *mut c_char,
    capacity: usize,
) -> i32 {
    call(error_out, capacity, || unsafe { import_timeline(owner, desc, output) })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn records_match_header() {
        assert_eq!(std::mem::size_of::<ImageDesc>(), 40);
        assert_eq!(std::mem::size_of::<TimelineDesc>(), 24);
    }
}
