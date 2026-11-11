// Included in abi.rs so the public registry stays private.
#[repr(C)]
pub struct MtWindow {
    struct_size: u32,
    kind: u32,
    width: u32,
    height: u32,
    display: *mut c_void,
    window: *mut c_void,
    window_id: u64,
}
unsafe fn window_surface(
    instance: &wgpu::Instance,
    window: &MtWindow,
) -> Result<wgpu::Surface<'static>> {
    use wgpu::rwh::*;
    #[allow(unused_variables)]
    let ptr = || std::ptr::NonNull::new(window.window).ok_or_else(|| invalid("Null native window"));
    let target = match window.kind {
        #[cfg(target_os = "macos")]
        1 => {
            unsafe extern "C" {
                fn pthread_main_np() -> i32;
            }
            if unsafe { pthread_main_np() } == 0 {
                return Err(invalid("AppKit surfaces require the main thread"));
            }
            wgpu::SurfaceTargetUnsafe::RawHandle {
                raw_display_handle: Some(RawDisplayHandle::AppKit(AppKitDisplayHandle::new())),
                raw_window_handle: RawWindowHandle::AppKit(AppKitWindowHandle::new(ptr()?)),
            }
        }
        #[cfg(target_os = "windows")]
        2 => wgpu::SurfaceTargetUnsafe::RawHandle {
            raw_display_handle: Some(RawDisplayHandle::Windows(WindowsDisplayHandle::new())),
            raw_window_handle: RawWindowHandle::Win32(Win32WindowHandle::new(
                std::num::NonZeroIsize::new(window.window as isize)
                    .ok_or_else(|| invalid("Null HWND"))?,
            )),
        },
        #[cfg(target_os = "linux")]
        3 if window.window_id != 0 => wgpu::SurfaceTargetUnsafe::RawHandle {
            raw_display_handle: Some(RawDisplayHandle::Xlib(XlibDisplayHandle::new(
                Some(
                    std::ptr::NonNull::new(window.display)
                        .ok_or_else(|| invalid("Null Xlib display"))?,
                ),
                0,
            ))),
            raw_window_handle: RawWindowHandle::Xlib(XlibWindowHandle::new(
                std::os::raw::c_ulong::try_from(window.window_id)
                    .map_err(|_| invalid("Invalid Xlib window ID"))?,
            )),
        },
        #[cfg(target_os = "linux")]
        4 => wgpu::SurfaceTargetUnsafe::RawHandle {
            raw_display_handle: Some(RawDisplayHandle::Wayland(WaylandDisplayHandle::new(
                std::ptr::NonNull::new(window.display)
                    .ok_or_else(|| invalid("Null Wayland display"))?,
            ))),
            raw_window_handle: RawWindowHandle::Wayland(WaylandWindowHandle::new(ptr()?)),
        },
        _ => {
            return Err(error(
                Status::Unavailable,
                "Window kind is unsupported on this platform",
            ));
        }
    };
    // Host owns the handles until detach/engine destruction, including display.
    unsafe { instance.create_surface_unsafe(target) }
        .map_err(|e| error(Status::Unavailable, e.to_string()))
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_engine_create_for_window(
    options: *const MtEngineOptions,
    window: *const MtWindow,
    output: *mut u64,
    error_out: *mut c_char,
    capacity: usize,
) -> i32 {
    call(error_out, capacity, || unsafe {
        create_window_engine(options, window, None, output)
    })
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_engine_create_for_window_on_adapter(
    options: *const MtEngineOptions,
    window: *const MtWindow,
    adapter_index: u32,
    output: *mut u64,
    error_out: *mut c_char,
    capacity: usize,
) -> i32 {
    call(error_out, capacity, || unsafe {
        create_window_engine(options, window, Some(adapter_index), output)
    })
}
unsafe fn create_window_engine(
    options: *const MtEngineOptions,
    window: *const MtWindow,
    adapter_index: Option<u32>,
    output: *mut u64,
) -> Result<()> {
    let options = unsafe { record(options)? };
    let window = unsafe { record(window)? };
    if output.is_null() {
        return Err(invalid("Null engine output"));
    }
    let backend = backend_from(options.backend)?;
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle_from_env());
    let surface = unsafe { window_surface(&instance, window)? };
    let adapter = if let Some(index) = adapter_index {
        let adapter = selected_adapter(&instance, index)?;
        if !adapter.is_surface_supported(&surface) {
            return Err(error(
                Status::Unavailable,
                "Selected adapter cannot present to this window",
            ));
        }
        adapter
    } else {
        pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            compatible_surface: Some(&surface),
            ..Default::default()
        }))
        .map_err(|e| error(Status::Unavailable, e.to_string()))?
    };
    let gpu = crate::GpuDevice::for_adapter(&adapter, backend.code())
        .map_err(|e| error(Status::Unavailable, e.to_string()))?;
    let engine = Engine::with_gpu(gpu, EngineOptions { backend }, Some(adapter));
    let display = engine.display();
    display.attach_surface(surface, SurfaceOptions::default())?;
    display.resize_surface(window.width, window.height)?;
    let handle = register_engine(engine, Some(instance))?;
    unsafe {
        output.write(handle);
    }
    Ok(())
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_display_attach_window(
    handle: u64,
    window: *const MtWindow,
    error_out: *mut c_char,
    capacity: usize,
) -> i32 {
    call(error_out, capacity, || {
        let window = unsafe { record(window)? };
        let display = display_of(handle)?;
        let instance = registry(|r| {
            let Some(Object::Display { engine }) = r.objects.get(&handle) else {
                return Err(invalid_handle());
            };
            match r.objects.get(engine) {
                Some(Object::Engine(e)) => {
                    e.window.as_ref().map(|(i, _)| i.clone()).ok_or_else(|| {
                        error(
                            Status::InvalidState,
                            "Create the engine with mt_engine_create_for_window",
                        )
                    })
                }
                _ => Err(invalid_handle()),
            }
        })?;
        let max = display
            .engine
            .inner
            .gpu
            .device
            .limits()
            .max_texture_dimension_2d;
        if window.width > max || window.height > max {
            return Err(invalid("Window size exceeds device limits"));
        }
        let surface = unsafe { window_surface(&instance, window)? };
        display.attach_surface(surface, SurfaceOptions::default())?;
        display.resize_surface(window.width, window.height)
    })
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_display_detach_window(
    handle: u64,
    error_out: *mut c_char,
    capacity: usize,
) -> i32 {
    call(error_out, capacity, || {
        drop(display_of(handle)?.detach_surface()?);
        Ok(())
    })
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_display_resize_window(
    handle: u64,
    width: u32,
    height: u32,
    error_out: *mut c_char,
    capacity: usize,
) -> i32 {
    call(error_out, capacity, || {
        display_of(handle)?.resize_surface(width, height)
    })
}
#[repr(C)]
pub struct MtSurfaceInfo {
    struct_size: u32,
    attached: u32,
    width: u32,
    height: u32,
    status: u32,
    hdr_requested: u32,
    hdr_active: u32,
    reserved: u32,
    format: [c_char; 64],
    hdr_unavailable_reason: [c_char; 256],
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_display_surface_info(
    handle: u64,
    output: *mut MtSurfaceInfo,
    error_out: *mut c_char,
    capacity: usize,
) -> i32 {
    call(error_out, capacity, || {
        let info = display_of(handle)?.surface_info();
        let mut record = MtSurfaceInfo {
            struct_size: std::mem::size_of::<MtSurfaceInfo>() as u32,
            attached: 0,
            width: 0,
            height: 0,
            status: 0,
            hdr_requested: 0,
            hdr_active: 0,
            reserved: 0,
            format: [0; 64],
            hdr_unavailable_reason: [0; 256],
        };
        if let Some(info) = info {
            record.attached = 1;
            record.width = info.size[0];
            record.height = info.size[1];
            record.status = match info.status {
                SurfaceStatus::Ready => 0,
                SurfaceStatus::Presented => 1,
                SurfaceStatus::Timeout => 2,
                SurfaceStatus::Occluded => 3,
                SurfaceStatus::Outdated => 4,
                SurfaceStatus::Lost => 5,
                SurfaceStatus::Suspended => 6,
                SurfaceStatus::Error => 7,
            };
            record.hdr_requested = info.hdr_requested as u32;
            record.hdr_active = info.hdr_active as u32;
            fill(&mut record.format, &format!("{:?}", info.format));
            fill(
                &mut record.hdr_unavailable_reason,
                info.hdr_unavailable_reason.as_deref().unwrap_or(""),
            );
        }
        unsafe { write_record(output, record) }
    })
}
