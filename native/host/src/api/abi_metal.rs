//! C records/dispatch for platform-neutral GPU export and native Metal imports.
use super::*;
#[repr(C)]
struct DeviceDesc {
    struct_size: u32,
    reserved: u32,
    next: *const c_void,
    device: *mut c_void,
    queue: *mut c_void,
}
#[repr(C)]
struct ImageDesc {
    struct_size: u32,
    reserved: u32,
    next: *const c_void,
    texture: *mut c_void,
}
#[repr(C)]
struct TimelineDesc {
    struct_size: u32,
    reserved: u32,
    next: *const c_void,
    event: *mut c_void,
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
struct ExportDesc {
    struct_size: u32,
    image_count: u32,
    next: *const c_void,
    images: *const ExportImage,
    ready: u64,
    ready_value: u64,
    done: u64,
    done_value: u64,
}
#[cfg(not(target_os = "macos"))]
fn unavailable() -> Error {
    error(
        Status::Unavailable,
        "Metal GPU export is unavailable on this platform",
    )
}
macro_rules! metal {
    ($body:expr) => {{
        #[cfg(target_os = "macos")]
        {
            $body
        }
        #[cfg(not(target_os = "macos"))]
        {
            Err(unavailable())
        }
    }};
}
#[cfg(target_os = "macos")]
use super::super::metal::{MetalExportImage, MetalOutput, MetalRowOrder};
#[cfg(target_os = "macos")]
fn extensions(next: *const c_void, reserved: u32) -> Result<()> {
    if !next.is_null() || reserved != 0 {
        return Err(invalid("Unsupported GPU record extension/reserved field"));
    }
    Ok(())
}
#[cfg(target_os = "macos")]
pub(super) fn check_destroy(engine: &Engine) -> Result<()> {
    if engine.inner.metal.lock().unwrap().is_none() || engine.inner.gpu.loss.reason().is_some() {
        return Ok(());
    }
    if !engine.poll_metal_exports(0)? {
        return Err(error(
            Status::Busy,
            "GPU exports pending; signal ready and poll before destroying engine",
        ));
    }
    Ok(())
}
#[cfg(not(target_os = "macos"))]
pub(super) fn check_destroy(_: &Engine) -> Result<()> {
    Ok(())
}

#[unsafe(no_mangle)]
unsafe extern "C" fn mt_engine_create_metal(
    desc: *const DeviceDesc,
    options: *const MtEngineOptions,
    output: *mut u64,
    error_out: *mut c_char,
    capacity: usize,
) -> i32 {
    call(error_out, capacity, || {
        if output.is_null() {
            return Err(invalid("Null engine output"));
        }
        unsafe {
            output.write(0);
        }
        metal!({
            let desc = unsafe { record(desc)? };
            extensions(desc.next, desc.reserved)?;
            let options = if options.is_null() {
                EngineOptions::default()
            } else {
                EngineOptions {
                    backend: backend_from(unsafe { record(options)? }.backend)?,
                }
            };
            let engine = unsafe { Engine::on_metal(desc.device, desc.queue, options)? };
            unsafe {
                output.write(register_engine(engine, None)?);
            }
            Ok(())
        })
    })
}
#[unsafe(no_mangle)]
unsafe extern "C" fn mt_engine_import_metal_image(
    owner: u64,
    desc: *const ImageDesc,
    output: *mut u64,
    error_out: *mut c_char,
    capacity: usize,
) -> i32 {
    call(error_out, capacity, || {
        if output.is_null() {
            return Err(invalid("Null image output"));
        }
        unsafe {
            output.write(0);
        }
        metal!({
            let desc = unsafe { record(desc)? };
            extensions(desc.next, desc.reserved)?;
            let image = unsafe { engine_of(owner)?.import_metal_image(desc.texture)? };
            unsafe {
                output.write(insert(Object::GpuImage {
                    engine: owner,
                    image,
                })?);
            }
            Ok(())
        })
    })
}
#[unsafe(no_mangle)]
unsafe extern "C" fn mt_engine_import_metal_timeline(
    owner: u64,
    desc: *const TimelineDesc,
    output: *mut u64,
    error_out: *mut c_char,
    capacity: usize,
) -> i32 {
    call(error_out, capacity, || {
        if output.is_null() {
            return Err(invalid("Null timeline output"));
        }
        unsafe {
            output.write(0);
        }
        metal!({
            let desc = unsafe { record(desc)? };
            extensions(desc.next, desc.reserved)?;
            let timeline = unsafe { engine_of(owner)?.import_metal_timeline(desc.event)? };
            unsafe {
                output.write(insert(Object::GpuTimeline {
                    engine: owner,
                    timeline,
                })?);
            }
            Ok(())
        })
    })
}
#[unsafe(no_mangle)]
unsafe extern "C" fn mt_render_export_gpu(
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
        unsafe {
            sequence.write(0);
        }
        metal!({
            let desc = unsafe { record(desc)? };
            extensions(desc.next, 0)?;
            if !(1..=8).contains(&desc.image_count)
                || desc.images.is_null()
                || (desc.ready == 0 && desc.ready_value != 0)
            {
                return Err(invalid("Invalid GPU export count/pointer/ready value"));
            }
            let render = render_of(render)?;
            let input =
                unsafe { std::slice::from_raw_parts(desc.images, desc.image_count as usize) };
            let mut images = Vec::new();
            let mut kinds = Vec::new();
            for item in input {
                let item = unsafe { record(item)? };
                extensions(item.next, item.reserved)?;
                images.push(registry(|r| match r.objects.get(&item.image) {
                    Some(Object::GpuImage { image, .. }) => Ok(image.clone()),
                    _ => Err(invalid_handle()),
                })?);
                kinds.push((
                    MetalOutput::from_abi(item.kind)?,
                    match item.row_order {
                        0 => MetalRowOrder::TopFirst,
                        1 => MetalRowOrder::BottomFirst,
                        _ => return Err(invalid("Unknown GPU row order")),
                    },
                ));
            }
            let timeline = |handle| {
                registry(|r| match r.objects.get(&handle) {
                    Some(Object::GpuTimeline { timeline, .. }) => Ok(timeline.clone()),
                    _ => Err(invalid_handle()),
                })
            };
            let ready = if desc.ready != 0 {
                Some(timeline(desc.ready)?)
            } else {
                None
            };
            let done = timeline(desc.done)?;
            let exports: Vec<_> = images
                .iter()
                .zip(kinds)
                .map(|(image, (kind, rows))| MetalExportImage { image, kind, rows })
                .collect();
            let id = render.export_metal(
                &exports,
                ready.as_ref().map(|r| (r, desc.ready_value)),
                (&done, desc.done_value),
            )?;
            unsafe {
                sequence.write(id);
            }
            Ok(())
        })
    })
}
#[unsafe(no_mangle)]
unsafe extern "C" fn mt_engine_gpu_poll(
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
        unsafe {
            complete.write(0);
        }
        metal!({
            let value = engine_of(engine)?.poll_metal_exports(sequence)?;
            unsafe {
                complete.write(value as u32);
            }
            Ok(())
        })
    })
}
fn destroy(handle: u64, image: bool) -> Result<()> {
    metal!({
        let owner = registry(|r| match r.objects.get(&handle) {
            Some(Object::GpuImage { engine, .. }) if image => Ok(*engine),
            Some(Object::GpuTimeline { engine, .. }) if !image => Ok(*engine),
            _ => Err(invalid_handle()),
        })?;
        engine_of(owner)?;
        let removed = registry(|r| Ok(r.objects.remove(&handle)))?;
        drop(removed);
        Ok(())
    })
}
#[unsafe(no_mangle)]
extern "C" fn mt_gpu_image_destroy(image: u64, error_out: *mut c_char, capacity: usize) -> i32 {
    call(error_out, capacity, || destroy(image, true))
}
#[unsafe(no_mangle)]
extern "C" fn mt_gpu_timeline_destroy(
    timeline: u64,
    error_out: *mut c_char,
    capacity: usize,
) -> i32 {
    call(error_out, capacity, || destroy(timeline, false))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn records_match_c_headers() {
        assert_eq!(std::mem::size_of::<DeviceDesc>(), 32);
        assert_eq!(std::mem::size_of::<ImageDesc>(), 24);
        assert_eq!(std::mem::size_of::<TimelineDesc>(), 24);
        assert_eq!(std::mem::size_of::<ExportImage>(), 32);
        assert_eq!(std::mem::size_of::<ExportDesc>(), 56);
    }
    #[test]
    fn null_outputs_are_rejected_without_native_access() {
        let status = unsafe {
            mt_engine_create_metal(
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                0,
            )
        };
        assert_eq!(status, Status::InvalidArgument as i32);
        let mut id = 999;
        let status =
            unsafe { mt_render_export_gpu(0, std::ptr::null(), &mut id, std::ptr::null_mut(), 0) };
        assert_ne!(status, 0);
        assert_eq!(id, 0);
    }
}
