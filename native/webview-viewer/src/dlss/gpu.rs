use super::ffi;
use anyhow::{Result, ensure};
use ash::vk::{self, Handle};
use std::{ffi::CStr, sync::Arc};
use wgpu::hal::{self, api::Vulkan};

pub struct Gpu {
    pub instance: wgpu::Instance,
    pub adapter: wgpu::Adapter,
    pub device: wgpu::Device,
    pub queue: wgpu::Queue,
    pub raw: ash::Device,
}
pub fn bootstrap(ngx: &ffi::Ngx) -> Result<Gpu> {
    let required = ngx.extensions(false, 0, 0)?;
    let hal_instance = unsafe {
        hal::vulkan::Instance::init_with_callback(
            &hal::InstanceDescriptor {
                name: "MuTracer DLSS RR",
                flags: wgpu::InstanceFlags::VALIDATION | wgpu::InstanceFlags::DEBUG,
                memory_budget_thresholds: Default::default(),
                backend_options: Default::default(),
                telemetry: None,
                display: None,
            },
            Some(Box::new(move |args| {
                // HAL's callback requires static extension names. NGX's list is
                // bounded and this bootstrap runs once per application process.
                for name in required {
                    let name: &'static CStr = Box::leak(name.into_boxed_c_str());
                    if !args.extensions.contains(&name) {
                        args.extensions.push(name);
                    }
                }
            })),
        )
    }?;
    let instance = unsafe { wgpu::Instance::from_hal::<Vulkan>(hal_instance) };
    let adapter = pollster::block_on(instance.enumerate_adapters(wgpu::Backends::VULKAN))
        .into_iter()
        .find(|a| a.get_info().vendor == 0x10de)
        .ok_or_else(|| anyhow::anyhow!("DLSS RR requires an NVIDIA Vulkan adapter"))?;
    let a = unsafe { adapter.as_hal::<Vulkan>() }.unwrap();
    let shared = a.shared_instance();
    let instance_handle = shared.raw_instance().handle().as_raw();
    let physical = a.raw_physical_device().as_raw();
    let support = ngx.support(instance_handle, physical);
    ffi::check(support.result, "NGX feature requirements")?;
    ensure!(
        support.supported == 0,
        "NGX does not support this device (flags 0x{:x})",
        support.supported
    );
    let required = ngx.extensions(true, instance_handle, physical)?;
    let available = unsafe {
        shared
            .raw_instance()
            .enumerate_device_extension_properties(a.raw_physical_device())
    }?;
    for name in &required {
        ensure!(
            available
                .iter()
                .any(|v| unsafe { CStr::from_ptr(v.extension_name.as_ptr()) } == name.as_c_str()),
            "Missing NGX Vulkan extension: {name:?}"
        );
    }
    let descriptor = wgpu::DeviceDescriptor {
        label: Some("MuTracer DLSS RR and egui"),
        required_limits: adapter.limits(),
        required_features: adapter.features()
            & (wgpu::Features::EXPERIMENTAL_RAY_QUERY
                | wgpu::Features::SHADER_F16
                | wgpu::Features::SUBGROUP
                | wgpu::Features::EXPERIMENTAL_COOPERATIVE_MATRIX),
        experimental_features: unsafe { wgpu::ExperimentalFeatures::enabled() },
        ..Default::default()
    };
    let open = unsafe {
        a.open_with_callback(
            descriptor.required_features,
            &descriptor.required_limits,
            &descriptor.memory_hints,
            Some(Box::new(|args| {
                for name in &required {
                    let name: &'static CStr = Box::leak(name.clone().into_boxed_c_str());
                    if !args.extensions.contains(&name) {
                        args.extensions.push(name);
                    }
                }
                // Rebuild the enabled feature chain after merging NGX requirements.
                *args.device_features =
                    a.physical_device_features(args.extensions, descriptor.required_features);
            })),
        )
    }?;
    drop(a);
    let (device, queue) = unsafe { adapter.create_device_from_hal::<Vulkan>(open, &descriptor) }?;
    let raw = {
        let d = unsafe { device.as_hal::<Vulkan>() }.unwrap();
        let raw = d.raw_device().clone();
        let caps = ngx.init(
            instance_handle,
            physical,
            raw.handle().as_raw(),
            d.shared_instance()
                .entry()
                .static_fn()
                .get_instance_proc_addr as *const _,
            d.shared_instance()
                .raw_instance()
                .fp_v1_0()
                .get_device_proc_addr as *const _,
        );
        if !ffi::success(caps.result) || caps.available == 0 || caps.needs_driver != 0 {
            // Shutdown while the Vulkan device is still alive, even when
            // capability discovery failed after successful NGX initialization.
            unsafe {
                (ngx.shutdown)();
            }
        }
        ffi::check(caps.result, "NGX initialization")?;
        ensure!(
            caps.available != 0 && caps.needs_driver == 0,
            "DLSS RR unavailable; driver requirement {}.{} (init 0x{:08x})",
            caps.min_driver_major,
            caps.min_driver_minor,
            caps.feature_init_result
        );
        raw
    };
    device.on_uncaptured_error(Arc::new(|e| eprintln!("DLSS GPU error: {e}")));
    Ok(Gpu {
        instance,
        adapter,
        device,
        queue,
        raw,
    })
}

// No nested as_hal guards: texture and view guards share a device lock.
pub fn descriptor(
    adapter: &wgpu::Adapter,
    texture: &wgpu::Texture,
    view: &wgpu::TextureView,
    write: bool,
) -> ffi::Texture {
    let image = {
        let t = unsafe { texture.as_hal::<Vulkan>() }.unwrap();
        unsafe { t.raw_handle() }.as_raw()
    };
    let view = {
        let v = unsafe { view.as_hal::<Vulkan>() }.unwrap();
        unsafe { v.raw_handle() }.as_raw()
    };
    let format = unsafe { adapter.as_hal::<Vulkan>() }
        .unwrap()
        .texture_format_as_raw(texture.format());
    ffi::Texture {
        image,
        view,
        width: texture.width(),
        height: texture.height(),
        format: format.as_raw() as u32,
        read_write: write as u32,
    }
}
pub fn barrier(raw: &ash::Device, cmd: vk::CommandBuffer, image: u64, to_general: bool) {
    let (old, new) = if to_general {
        (
            vk::ImageLayout::SHADER_READ_ONLY_OPTIMAL,
            vk::ImageLayout::GENERAL,
        )
    } else {
        (
            vk::ImageLayout::GENERAL,
            vk::ImageLayout::SHADER_READ_ONLY_OPTIMAL,
        )
    };
    let barrier = vk::ImageMemoryBarrier::default()
        .old_layout(old)
        .new_layout(new)
        .src_access_mask(vk::AccessFlags::SHADER_READ)
        .dst_access_mask(vk::AccessFlags::SHADER_READ)
        .src_queue_family_index(vk::QUEUE_FAMILY_IGNORED)
        .dst_queue_family_index(vk::QUEUE_FAMILY_IGNORED)
        .image(vk::Image::from_raw(image))
        .subresource_range(vk::ImageSubresourceRange {
            aspect_mask: vk::ImageAspectFlags::COLOR,
            base_mip_level: 0,
            level_count: 1,
            base_array_layer: 0,
            layer_count: 1,
        });
    unsafe {
        raw.cmd_pipeline_barrier(
            cmd,
            vk::PipelineStageFlags::ALL_COMMANDS,
            vk::PipelineStageFlags::ALL_COMMANDS,
            vk::DependencyFlags::empty(),
            &[],
            &[],
            &[barrier],
        );
    }
}

pub fn output_barrier(raw: &ash::Device, cmd: vk::CommandBuffer, image: u64) {
    let barrier = vk::ImageMemoryBarrier::default()
        .old_layout(vk::ImageLayout::GENERAL)
        .new_layout(vk::ImageLayout::GENERAL)
        .src_access_mask(vk::AccessFlags::SHADER_WRITE)
        .dst_access_mask(vk::AccessFlags::SHADER_WRITE)
        .src_queue_family_index(vk::QUEUE_FAMILY_IGNORED)
        .dst_queue_family_index(vk::QUEUE_FAMILY_IGNORED)
        .image(vk::Image::from_raw(image))
        .subresource_range(vk::ImageSubresourceRange {
            aspect_mask: vk::ImageAspectFlags::COLOR,
            base_mip_level: 0,
            level_count: 1,
            base_array_layer: 0,
            layer_count: 1,
        });
    // The producer's sentinel clear must finish before NGX overwrites output.
    // A shared GENERAL layout alone does not establish a write-after-write dependency.
    unsafe {
        raw.cmd_pipeline_barrier(
            cmd,
            vk::PipelineStageFlags::COMPUTE_SHADER,
            vk::PipelineStageFlags::ALL_COMMANDS,
            vk::DependencyFlags::empty(),
            &[],
            &[],
            &[barrier],
        );
    }
}
