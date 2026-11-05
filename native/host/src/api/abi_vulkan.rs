//! Native Vulkan ownership stays with the host; wgpu owns only its wrappers.
#![cfg_attr(
    not(any(target_os = "linux", target_os = "windows", feature = "vulkan-interop")),
    allow(unused_variables, unused_imports, dead_code)
)]
use super::*;
use ash::vk;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
type Retired = extern "C" fn(*mut c_void);

#[repr(C)]
pub struct HostDesc {
    struct_size: u32,
    api_version: u32,
    instance: vk::Instance,
    physical_device: vk::PhysicalDevice,
    get_proc: Option<vk::PFN_vkGetInstanceProcAddr>,
    instance_extensions: *const *const c_char,
    instance_extension_count: usize,
    retired: Option<Retired>,
    retired_user: *mut c_void,
}
#[repr(C)]
pub struct DeviceDesc {
    struct_size: u32,
    queue_family: u32,
    queue_index: u32,
    reserved: u32,
    device: vk::Device,
    retired: Option<Retired>,
    retired_user: *mut c_void,
}
#[repr(C)]
pub struct Requirements {
    struct_size: u32,
    queue_flags: u32,
    features: *const vk::PhysicalDeviceFeatures,
    features_next: *const c_void,
    extensions: *const *const c_char,
    extension_count: usize,
    hardware_ray_query: u32,
    reserved: u32,
}
#[repr(C)]
pub struct DeviceInfo {
    struct_size: u32,
    api_version: u32,
    queue_family: u32,
    queue_index: u32,
    instance: vk::Instance,
    physical_device: vk::PhysicalDevice,
    device: vk::Device,
    queue: vk::Queue,
    get_proc: Option<vk::PFN_vkGetInstanceProcAddr>,
}
#[repr(C)]
pub struct ImageInfo {
    struct_size: u32,
    format: u32,
    width: u32,
    height: u32,
    image: vk::Image,
    lease: u64,
    layout: u32,
    reserved: u32,
}
#[repr(C)]
pub struct PassContext {
    struct_size: u32,
    format: u32,
    width: u32,
    height: u32,
    device: vk::Device,
    commands: vk::CommandBuffer,
    input: vk::Image,
    output: vk::Image,
}
type Callback = extern "C" fn(*const PassContext, *mut c_void) -> i32;
fn unavailable() -> Error {
    error(
        Status::Unavailable,
        "Vulkan interop is not available in this build/device",
    )
}
static NEXT: AtomicU64 = AtomicU64::new(1);
fn next() -> u64 {
    NEXT.fetch_add(1, Ordering::Relaxed)
}

#[cfg(any(target_os = "linux", target_os = "windows", feature = "vulkan-interop"))]
mod platform {
    use super::*;
    use ash::vk::Handle;
    use wgpu::hal::api::Vulkan;
    struct Retirement {
        callback: Retired,
        user: User,
    }
    // Opaque user memory is only forwarded to the one foreign retirement callback.
    // The C contract keeps it valid and permits that callback on any thread.
    unsafe impl Sync for Retirement {}
    impl Retirement {
        fn notify(&self) {
            (self.callback)(self.user.0);
        }
    }
    struct Plan {
        _instance: wgpu::Instance,
        adapter: wgpu::Adapter,
        raw_instance: ash::Instance,
        physical_device: vk::PhysicalDevice,
        options: EngineOptions,
        features: wgpu::Features,
        limits: wgpu::Limits,
        _physical_features: Box<wgpu::hal::vulkan::PhysicalDeviceFeatures>,
        extensions: Vec<&'static CStr>,
        names: Vec<*const c_char>,
    }
    // Pointers address immutable static names and the plan's stable Box; access is
    // serialized by PLANS. Borrowed requirement chains are read-only to the host.
    unsafe impl Send for Plan {}
    static PLANS: std::sync::LazyLock<Mutex<HashMap<u64, Plan>>> =
        std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));
    struct Lease {
        owner: u64,
        engine: Engine,
        texture: Option<wgpu::Texture>,
        thread: Option<std::thread::ThreadId>,
        gate: Arc<crate::submission::SubmissionGate>,
    }
    static LEASES: std::sync::LazyLock<Mutex<HashMap<u64, Lease>>> =
        std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));
    struct Pass {
        owner: u64,
        _subscription: PostProcessSubscription,
    }
    static PASSES: std::sync::LazyLock<Mutex<HashMap<u64, Pass>>> =
        std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));
    fn entry(get_proc: Option<vk::PFN_vkGetInstanceProcAddr>) -> Result<ash::Entry> {
        let get_instance_proc_addr =
            get_proc.ok_or_else(|| invalid("Null vkGetInstanceProcAddr"))?;
        Ok(unsafe {
            ash::Entry::from_static_fn(ash::StaticFn {
                get_instance_proc_addr,
            })
        })
    }
    fn extensions(entry: &ash::Entry, version: u32) -> Result<Vec<&'static CStr>> {
        if version < vk::API_VERSION_1_1 {
            return Err(invalid("Vulkan 1.1 or later is required"));
        }
        wgpu::hal::vulkan::Instance::desired_extensions(
            entry,
            version,
            wgpu::InstanceFlags::empty(),
        )
        .map_err(|e| error(Status::Unavailable, e.to_string()))
    }
    pub(super) fn check_engine_ref(engine: &Engine) -> Result<()> {
        if LEASES
            .lock()
            .unwrap()
            .values()
            .any(|l| Arc::ptr_eq(&l.engine.inner, &engine.inner))
        {
            return Err(error(
                Status::InvalidState,
                "Release the Vulkan image lease before using this engine",
            ));
        }
        Ok(())
    }
    pub(super) fn check_engine(owner: u64) -> Result<()> {
        if LEASES.lock().unwrap().values().any(|l| l.owner == owner) {
            return Err(error(
                Status::InvalidState,
                "Release the Vulkan image lease before using this engine",
            ));
        }
        Ok(())
    }
    pub(super) fn engine_destroyed(owner: u64) {
        let removed: Vec<_> = {
            let mut passes = PASSES.lock().unwrap();
            let map = &mut *passes;
            let ids: Vec<_> = map
                .iter()
                .filter(|(_, p)| p.owner == owner)
                .map(|(&id, _)| id)
                .collect();
            ids.into_iter().filter_map(|id| map.remove(&id)).collect()
        };
        drop(removed);
    }
    pub(super) unsafe fn instance_extensions(
        get_proc: Option<vk::PFN_vkGetInstanceProcAddr>,
        version: u32,
        output: *mut *const c_char,
        capacity: usize,
        required: *mut usize,
    ) -> Result<()> {
        if required.is_null() || output.is_null() && capacity != 0 {
            return Err(invalid("Invalid extension output"));
        }
        let extensions = extensions(&entry(get_proc)?, version)?;
        unsafe { required.write(extensions.len()) };
        if output.is_null() && capacity == 0 {
            return Ok(());
        }
        if capacity < extensions.len() {
            return Err(error(
                Status::BufferTooSmall,
                "Extension array is too small",
            ));
        }
        for (i, name) in extensions.iter().enumerate() {
            unsafe { output.add(i).write(name.as_ptr()) };
        }
        Ok(())
    }
    pub(super) unsafe fn plan_create(
        host: *const HostDesc,
        options: *const MtEngineOptions,
        output: *mut u64,
        requirements: *mut Requirements,
    ) -> Result<()> {
        let host = unsafe { record(host)? };
        let options = unsafe { record(options)? };
        if output.is_null()
            || requirements.is_null()
            || host.instance.is_null()
            || host.physical_device.is_null()
            || host.instance_extension_count > 256
            || host.instance_extension_count > 0 && host.instance_extensions.is_null()
        {
            return Err(invalid("Invalid Vulkan host/output"));
        }
        let retired = Retirement {
            callback: host
                .retired
                .ok_or_else(|| invalid("Instance retirement callback is required"))?,
            user: User(host.retired_user),
        };
        let armed = Arc::new(AtomicBool::new(false));
        let notify = armed.clone();
        let entry = entry(host.get_proc)?;
        let required = extensions(&entry, host.api_version)?;
        let names = if host.instance_extension_count == 0 {
            &[][..]
        } else {
            unsafe {
                std::slice::from_raw_parts(host.instance_extensions, host.instance_extension_count)
            }
        };
        let mut enabled = Vec::new();
        for name in names {
            if name.is_null() {
                return Err(invalid("Null instance extension name"));
            }
            enabled.push(unsafe { CStr::from_ptr(*name) });
        }
        if required.iter().any(|name| !enabled.contains(name)) {
            return Err(invalid(
                "Host instance is missing required Vulkan extensions",
            ));
        }
        let raw = unsafe { ash::Instance::load(entry.static_fn(), host.instance) };
        if !unsafe { raw.enumerate_physical_devices() }
            .map_err(|e| error(Status::Unavailable, e.to_string()))?
            .contains(&host.physical_device)
        {
            return Err(invalid(
                "Physical device does not belong to the host instance",
            ));
        }
        let hal = unsafe {
            wgpu::hal::vulkan::Instance::from_raw(
                entry,
                raw.clone(),
                host.api_version,
                0,
                None,
                required,
                wgpu::InstanceFlags::empty(),
                wgpu::MemoryBudgetThresholds::default(),
                false,
                Some(Box::new(move || {
                    if notify.load(Ordering::Acquire) {
                        retired.notify();
                    }
                })),
            )
        }
        .map_err(|e| error(Status::Unavailable, e.to_string()))?;
        let exposed = hal
            .expose_adapter(host.physical_device)
            .ok_or_else(unavailable)?;
        let instance = unsafe { wgpu::Instance::from_hal::<Vulkan>(hal) };
        let adapter = unsafe { instance.create_adapter_from_hal::<Vulkan>(exposed) };
        let backend = backend_from(options.backend)?;
        let features = crate::oidn_webgpu::required_features()
            | if adapter
                .features()
                .contains(crate::INDEPENDENT_TEXTURE_FEATURES)
            {
                crate::INDEPENDENT_TEXTURE_FEATURES
            } else {
                wgpu::Features::empty()
            }
            | if backend == Backend::Hardware
                && adapter
                    .features()
                    .contains(wgpu::Features::EXPERIMENTAL_RAY_QUERY)
            {
                wgpu::Features::EXPERIMENTAL_RAY_QUERY
            } else {
                wgpu::Features::empty()
            };
        if !adapter.features().contains(features) {
            return Err(unavailable());
        }
        let (extensions, mut physical_features) = {
            let hal = unsafe { adapter.as_hal::<Vulkan>() }.ok_or_else(unavailable)?;
            let extensions = hal.required_device_extensions(features);
            let physical_features = Box::new(hal.physical_device_features(&extensions, features));
            (extensions, physical_features)
        };
        let create = physical_features.add_to_device_create(vk::DeviceCreateInfo::default());
        let (core, chain) = (create.p_enabled_features, create.p_next);
        let names = extensions.iter().map(|e| e.as_ptr()).collect::<Vec<_>>();
        let plan = Plan {
            limits: {
                let mut limits = adapter.limits();
                limits.max_buffer_size = limits.max_buffer_size.min(u32::MAX as u64);
                limits
            },
            _instance: instance,
            adapter,
            raw_instance: raw,
            physical_device: host.physical_device,
            options: EngineOptions { backend },
            features,
            _physical_features: physical_features,
            extensions,
            names,
        };
        let req = Requirements {
            struct_size: std::mem::size_of::<Requirements>() as u32,
            queue_flags: (vk::QueueFlags::GRAPHICS | vk::QueueFlags::COMPUTE).as_raw(),
            features: core,
            features_next: chain,
            extensions: plan.names.as_ptr(),
            extension_count: plan.names.len(),
            hardware_ray_query: u32::from(
                features.contains(wgpu::Features::EXPERIMENTAL_RAY_QUERY),
            ),
            reserved: 0,
        };
        let id = next();
        PLANS.lock().unwrap().insert(id, plan);
        armed.store(true, Ordering::Release);
        unsafe {
            output.write(id);
            requirements.write(req);
        }
        Ok(())
    }
    pub(super) fn plan_destroy(plan: u64) -> Result<()> {
        let removed = PLANS
            .lock()
            .unwrap()
            .remove(&plan)
            .ok_or_else(invalid_handle)?;
        drop(removed);
        Ok(())
    }
    pub(super) unsafe fn create_engine(
        plan: u64,
        desc: *const DeviceDesc,
        output: *mut u64,
    ) -> Result<()> {
        let desc = unsafe { record(desc)? };
        let (device, family, index) = (desc.device, desc.queue_family, desc.queue_index);
        let retired = Retirement {
            callback: desc
                .retired
                .ok_or_else(|| invalid("Device retirement callback is required"))?,
            user: User(desc.retired_user),
        };
        let armed = Arc::new(AtomicBool::new(false));
        let notify = armed.clone();
        if device.is_null() || output.is_null() || desc.reserved != 0 {
            return Err(invalid("Null Vulkan device/output"));
        }
        let (adapter, raw, features, limits, options, extensions, physical) = {
            let plans = PLANS.lock().unwrap();
            let p = plans.get(&plan).ok_or_else(invalid_handle)?;
            (
                p.adapter.clone(),
                p.raw_instance.clone(),
                p.features,
                p.limits.clone(),
                p.options.clone(),
                p.extensions.clone(),
                p.physical_device,
            )
        };
        let queues = unsafe { raw.get_physical_device_queue_family_properties(physical) };
        let required = vk::QueueFlags::GRAPHICS | vk::QueueFlags::COMPUTE;
        if !queues
            .get(family as usize)
            .is_some_and(|q| q.queue_flags.contains(required) && index < q.queue_count)
        {
            return Err(invalid(
                "Vulkan queue family/index must support graphics and compute",
            ));
        }
        let hal_device = {
            let hal = unsafe { adapter.as_hal::<Vulkan>() }.ok_or_else(unavailable)?;
            let device = unsafe { ash::Device::load(raw.fp_v1_0(), device) };
            unsafe {
                hal.device_from_raw(
                    device,
                    Some(Box::new(move || {
                        if notify.load(Ordering::Acquire) {
                            retired.notify();
                        }
                    })),
                    &extensions,
                    features,
                    &limits,
                    &wgpu::MemoryHints::default(),
                    family,
                    index,
                )
            }
            .map_err(|e| error(Status::Unavailable, e.to_string()))?
        };
        let (device, queue) = unsafe {
            adapter.create_device_from_hal::<Vulkan>(
                hal_device,
                &wgpu::DeviceDescriptor {
                    label: Some("MuTracer host Vulkan device"),
                    required_features: features,
                    required_limits: limits,
                    experimental_features: if features
                        .contains(wgpu::Features::EXPERIMENTAL_RAY_QUERY)
                    {
                        wgpu::ExperimentalFeatures::enabled()
                    } else {
                        wgpu::ExperimentalFeatures::disabled()
                    },
                    ..Default::default()
                },
            )
        }
        .map_err(|e| error(Status::Unavailable, e.to_string()))?;
        let engine = Engine::on_device(
            &adapter,
            &device,
            &queue,
            options,
            Some(Arc::new(Default::default())),
        );
        let loss = engine.device_loss_notifier();
        device.set_device_lost_callback(move |reason, message| {
            loss.notify(format!("{reason:?}: {message}"))
        });
        let handle = register_engine(engine, None)?;
        armed.store(true, Ordering::Release);
        unsafe { output.write(handle) };
        Ok(())
    }
    pub(super) fn device_info(engine: &Engine) -> Result<DeviceInfo> {
        let hal = unsafe { engine.inner.gpu.device.as_hal::<Vulkan>() }.ok_or_else(unavailable)?;
        let instance = hal.shared_instance();
        Ok(DeviceInfo {
            struct_size: std::mem::size_of::<DeviceInfo>() as u32,
            api_version: instance.instance_api_version(),
            queue_family: hal.queue_family_index(),
            queue_index: hal.queue_index(),
            instance: instance.raw_instance().handle(),
            physical_device: hal.raw_physical_device(),
            device: hal.raw_device().handle(),
            queue: hal.raw_queue(),
            get_proc: Some(instance.entry().static_fn().get_instance_proc_addr),
        })
    }
    fn format(format: wgpu::TextureFormat) -> Result<vk::Format> {
        Ok(match format {
            wgpu::TextureFormat::Rgba32Float => vk::Format::R32G32B32A32_SFLOAT,
            wgpu::TextureFormat::Rgba8Unorm => vk::Format::R8G8B8A8_UNORM,
            wgpu::TextureFormat::Rgba16Float => vk::Format::R16G16B16A16_SFLOAT,
            _ => return Err(unavailable()),
        })
    }
    fn owner_thread(owner: u64) -> Result<Option<std::thread::ThreadId>> {
        registry(|r| match r.objects.get(&owner) {
            Some(Object::Engine(e)) => Ok(e.window.as_ref().map(|(_, thread)| *thread)),
            _ => Err(invalid_handle()),
        })
    }
    pub(super) fn acquire_queue(owner: u64) -> Result<u64> {
        let engine = engine_of(owner)?;
        device_info(&engine)?;
        let thread = owner_thread(owner)?;
        let gate = engine.inner.gpu.queue.gate().ok_or_else(unavailable)?;
        let id = next();
        gate.pause();
        LEASES.lock().unwrap().insert(
            id,
            Lease {
                owner,
                engine,
                texture: None,
                thread,
                gate,
            },
        );
        Ok(id)
    }
    pub(super) fn acquire(render: u64, kind: u32) -> Result<ImageInfo> {
        let view = render_of(render)?;
        let owner = registry(|r| match r.objects.get(&render) {
            Some(Object::Render(r)) => Ok(r.engine),
            _ => Err(invalid_handle()),
        })?;
        let engine = engine_of(owner)?;
        device_info(&engine)?;
        let kind = match kind {
            0 => OutputKind::Hdr,
            1 => OutputKind::Display,
            _ => return Err(invalid("Unknown Vulkan image kind")),
        };
        let texture = view
            .get_output_texture(kind)?
            .ok_or_else(|| error(Status::InvalidState, "No completed output image"))?;
        let image = unsafe { texture.as_hal::<Vulkan>() }
            .ok_or_else(unavailable)
            .map(|h| unsafe { h.raw_handle() })?;
        let mut encoder = engine
            .inner
            .gpu
            .device
            .create_command_encoder(&Default::default());
        encoder.transition_resources(
            std::iter::empty(),
            std::iter::once(wgpu::TextureTransition {
                texture: &texture,
                selector: None,
                state: wgpu::TextureUses::RESOURCE,
            }),
        );
        engine.inner.gpu.queue.submit([encoder.finish()]);
        let gate = engine.inner.gpu.queue.gate().ok_or_else(unavailable)?;
        let info = ImageInfo {
            struct_size: std::mem::size_of::<ImageInfo>() as u32,
            format: format(texture.format())?.as_raw() as u32,
            width: texture.width(),
            height: texture.height(),
            image,
            lease: next(),
            layout: vk::ImageLayout::SHADER_READ_ONLY_OPTIMAL.as_raw() as u32,
            reserved: 0,
        };
        let thread = owner_thread(owner)?;
        gate.pause();
        LEASES.lock().unwrap().insert(
            info.lease,
            Lease {
                owner,
                engine,
                texture: Some(texture),
                thread,
                gate,
            },
        );
        Ok(info)
    }
    pub(super) fn release(lease: u64) -> Result<()> {
        let thread = LEASES
            .lock()
            .unwrap()
            .get(&lease)
            .map(|l| l.thread)
            .ok_or_else(invalid_handle)?;
        if thread.is_some_and(|t| t != std::thread::current().id()) {
            return Err(error(
                Status::InvalidState,
                "Window image/queue lease must be released on its creating thread",
            ));
        }
        let lease = LEASES
            .lock()
            .unwrap()
            .remove(&lease)
            .ok_or_else(invalid_handle)?;
        // Foreign submissions have returned on the CPU. The next ordered library
        // submission marks the borrowed texture live beyond all those GPU reads.
        lease.gate.resume();
        let gpu = &lease.engine.inner.gpu;
        gpu.loss
            .check()
            .map_err(|e| error(Status::ContextFailed, e.to_string()))?;
        let Some(texture) = lease.texture else {
            return Ok(());
        };
        let mut encoder = gpu.device.create_command_encoder(&Default::default());
        encoder.transition_resources(
            std::iter::empty(),
            std::iter::once(wgpu::TextureTransition {
                texture: &texture,
                selector: None,
                state: wgpu::TextureUses::RESOURCE,
            }),
        );
        gpu.queue.submit([encoder.finish()]);
        // The submission tracker owns this texture through the retirement fence.
        Ok(())
    }
    fn invoke(callback: Callback, user: User, args: &PassContext) -> i32 {
        callback(args, user.0)
    }
    pub(super) fn add_pass(display: u64, mode: u32, callback: Callback, user: User) -> Result<u64> {
        let view = display_of(display)?;
        device_info(&view.engine)?;
        let owner = registry(|r| match r.objects.get(&display) {
            Some(Object::Display { engine }) => Ok(*engine),
            _ => Err(invalid_handle()),
        })?;
        let pass = move |context: PostProcessContext<'_>| -> Result<()> {
            // Initialize through wgpu so later passes cannot zero an externally
            // written texture under its lazy-initialization rules.
            {
                let target = context.output.create_view(&Default::default());
                let _clear = context
                    .encoder
                    .begin_render_pass(&wgpu::RenderPassDescriptor {
                        color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                            view: &target,
                            depth_slice: None,
                            resolve_target: None,
                            ops: wgpu::Operations {
                                load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                                store: wgpu::StoreOp::Store,
                            },
                        })],
                        ..Default::default()
                    });
            }
            context.encoder.transition_resources(
                std::iter::empty(),
                [
                    wgpu::TextureTransition {
                        texture: context.input,
                        selector: None,
                        state: wgpu::TextureUses::RESOURCE,
                    },
                    wgpu::TextureTransition {
                        texture: context.output,
                        selector: None,
                        state: wgpu::TextureUses::STORAGE_WRITE_ONLY,
                    },
                ]
                .into_iter(),
            );
            let raw_device = unsafe { context.device.as_hal::<Vulkan>() }
                .ok_or_else(unavailable)?
                .raw_device()
                .clone();
            let device = raw_device.handle();
            let input = unsafe { context.input.as_hal::<Vulkan>() }
                .ok_or_else(unavailable)
                .map(|h| unsafe { h.raw_handle() })?;
            let output = unsafe { context.output.as_hal::<Vulkan>() }
                .ok_or_else(unavailable)
                .map(|h| unsafe { h.raw_handle() })?;
            let format = format(context.output.format())?.as_raw() as u32;
            // wgpu 30 forbids mixing its regular and raw APIs on one encoder.
            // Flush preparation into the deferred chain, then record native work
            // in a dedicated raw encoder. Failure discards the entire chain.
            let before = std::mem::replace(
                context.encoder,
                context.device.create_command_encoder(&Default::default()),
            );
            context.commands.push(before.finish());
            let mut native = context.device.create_command_encoder(&Default::default());
            let status = unsafe {
                native.as_hal_mut::<Vulkan, _, _>(|encoder| {
                    let encoder = encoder.ok_or_else(unavailable)?;
                    let args = PassContext {
                        struct_size: std::mem::size_of::<PassContext>() as u32,
                        format,
                        width: context.output.width(),
                        height: context.output.height(),
                        device,
                        commands: encoder.raw_handle(),
                        input,
                        output,
                    };
                    let memory = [vk::MemoryBarrier::default()
                        .src_access_mask(vk::AccessFlags::MEMORY_WRITE)
                        .dst_access_mask(
                            vk::AccessFlags::MEMORY_READ | vk::AccessFlags::MEMORY_WRITE,
                        )];
                    raw_device.cmd_pipeline_barrier(
                        args.commands,
                        vk::PipelineStageFlags::ALL_COMMANDS,
                        vk::PipelineStageFlags::ALL_COMMANDS,
                        vk::DependencyFlags::empty(),
                        &memory,
                        &[],
                        &[],
                    );
                    let status = invoke(callback, user, &args);
                    raw_device.cmd_pipeline_barrier(
                        args.commands,
                        vk::PipelineStageFlags::ALL_COMMANDS,
                        vk::PipelineStageFlags::ALL_COMMANDS,
                        vk::DependencyFlags::empty(),
                        &memory,
                        &[],
                        &[],
                    );
                    Ok::<_, Error>(status)
                })
            }?;
            if status != 0 {
                return Err(error(
                    Status::Error,
                    format!("Vulkan post-process failed with status {status}"),
                ));
            }
            context.commands.push(native.finish());
            Ok(())
        };
        let subscription = match mode {
            0 => view.add_post_process(pass)?,
            1 => view.add_hdr_post_process(pass)?,
            _ => return Err(invalid("Unknown Vulkan pass mode")),
        };
        let id = next();
        PASSES.lock().unwrap().insert(
            id,
            Pass {
                owner,
                _subscription: subscription,
            },
        );
        Ok(id)
    }
    pub(super) fn remove_pass(id: u64) -> Result<()> {
        let owner = PASSES
            .lock()
            .unwrap()
            .get(&id)
            .map(|p| p.owner)
            .ok_or_else(invalid_handle)?;
        engine_of(owner)?;
        let removed = PASSES
            .lock()
            .unwrap()
            .remove(&id)
            .ok_or_else(invalid_handle)?;
        drop(removed);
        Ok(())
    }
}

pub(super) fn check_engine_ref(engine: &Engine) -> Result<()> {
    #[cfg(any(target_os = "linux", target_os = "windows", feature = "vulkan-interop"))]
    return platform::check_engine_ref(engine);
    #[cfg(not(any(target_os = "linux", target_os = "windows", feature = "vulkan-interop")))]
    {
        let _ = engine;
        Ok(())
    }
}
pub(super) fn check_engine(owner: u64) -> Result<()> {
    #[cfg(any(target_os = "linux", target_os = "windows", feature = "vulkan-interop"))]
    return platform::check_engine(owner);
    #[cfg(not(any(target_os = "linux", target_os = "windows", feature = "vulkan-interop")))]
    {
        let _ = owner;
        Ok(())
    }
}
pub(super) fn engine_destroyed(owner: u64) {
    #[cfg(any(target_os = "linux", target_os = "windows", feature = "vulkan-interop"))]
    platform::engine_destroyed(owner);
    #[cfg(not(any(target_os = "linux", target_os = "windows", feature = "vulkan-interop")))]
    let _ = owner;
}
macro_rules! dispatch {
    ($body:expr) => {{
        #[cfg(any(target_os = "linux", target_os = "windows", feature = "vulkan-interop"))]
        {
            $body
        }
        #[cfg(not(any(target_os = "linux", target_os = "windows", feature = "vulkan-interop")))]
        {
            Err(unavailable())
        }
    }};
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_vk_instance_extensions(
    get_proc: Option<vk::PFN_vkGetInstanceProcAddr>,
    version: u32,
    output: *mut *const c_char,
    capacity: usize,
    required: *mut usize,
    error_out: *mut c_char,
    error_capacity: usize,
) -> i32 {
    call(error_out, error_capacity, || {
        dispatch!(unsafe {
            platform::instance_extensions(get_proc, version, output, capacity, required)
        })
    })
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_vk_device_plan_create(
    host: *const HostDesc,
    options: *const MtEngineOptions,
    plan: *mut u64,
    output: *mut Requirements,
    error_out: *mut c_char,
    capacity: usize,
) -> i32 {
    call(error_out, capacity, || {
        dispatch!(unsafe { platform::plan_create(host, options, plan, output) })
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn mt_vk_device_plan_destroy(
    plan: u64,
    error_out: *mut c_char,
    capacity: usize,
) -> i32 {
    call(error_out, capacity, || {
        dispatch!(platform::plan_destroy(plan))
    })
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_engine_create_vulkan(
    plan: u64,
    desc: *const DeviceDesc,
    output: *mut u64,
    error_out: *mut c_char,
    capacity: usize,
) -> i32 {
    call(error_out, capacity, || {
        dispatch!(unsafe { platform::create_engine(plan, desc, output) })
    })
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_engine_vulkan_info(
    engine: u64,
    output: *mut DeviceInfo,
    error_out: *mut c_char,
    capacity: usize,
) -> i32 {
    call(error_out, capacity, || {
        dispatch!({
            if output.is_null() {
                return Err(invalid("Null output"));
            }
            let info = platform::device_info(&engine_of(engine)?)?;
            unsafe { output.write(info) };
            Ok(())
        })
    })
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_engine_vulkan_acquire_queue(
    engine: u64,
    output: *mut u64,
    error_out: *mut c_char,
    capacity: usize,
) -> i32 {
    call(error_out, capacity, || {
        dispatch!({
            if output.is_null() {
                return Err(invalid("Null output"));
            }
            let lease = platform::acquire_queue(engine)?;
            unsafe { output.write(lease) };
            Ok(())
        })
    })
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_render_vulkan_acquire_image(
    render: u64,
    kind: u32,
    output: *mut ImageInfo,
    error_out: *mut c_char,
    capacity: usize,
) -> i32 {
    call(error_out, capacity, || {
        dispatch!({
            if output.is_null() {
                return Err(invalid("Null output"));
            }
            let info = platform::acquire(render, kind)?;
            unsafe { output.write(info) };
            Ok(())
        })
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn mt_vk_lease_release(lease: u64, error_out: *mut c_char, capacity: usize) -> i32 {
    call(error_out, capacity, || dispatch!(platform::release(lease)))
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_display_add_vulkan_post_process(
    display: u64,
    mode: u32,
    callback: Option<Callback>,
    user: *mut c_void,
    output: *mut u64,
    error_out: *mut c_char,
    capacity: usize,
) -> i32 {
    call(error_out, capacity, || {
        dispatch!({
            if output.is_null() {
                return Err(invalid("Null output"));
            }
            let callback = callback.ok_or_else(|| invalid("Null Vulkan pass callback"))?;
            let id = platform::add_pass(display, mode, callback, User(user))?;
            unsafe { output.write(id) };
            Ok(())
        })
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn mt_vk_post_process_remove(
    pass: u64,
    error_out: *mut c_char,
    capacity: usize,
) -> i32 {
    call(error_out, capacity, || {
        dispatch!(platform::remove_pass(pass))
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn c_record_layouts() {
        use std::mem::{offset_of, size_of};
        assert_eq!(size_of::<HostDesc>(), 64);
        assert_eq!(size_of::<DeviceDesc>(), 40);
        assert_eq!(size_of::<Requirements>(), 48);
        assert_eq!(size_of::<DeviceInfo>(), 56);
        assert_eq!(size_of::<ImageInfo>(), 40);
        assert_eq!(size_of::<PassContext>(), 48);
        assert_eq!(offset_of!(Requirements, features), 8);
        assert_eq!(offset_of!(ImageInfo, lease), 24);
    }
}

#[cfg(all(
    test,
    any(target_os = "linux", target_os = "windows", feature = "vulkan-interop")
))]
#[path = "vulkan_tests.rs"]
mod gpu_tests;
