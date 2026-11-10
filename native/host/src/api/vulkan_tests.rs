use super::*;
use crate::scene_api::{Environment, Geometry, Mesh, OpenPbrMaterial, Scene};
use glam::{Mat4, Vec3};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Instant;
extern "C" fn retired(user: *mut c_void) {
    unsafe { &*user.cast::<AtomicU32>() }.fetch_add(1, Ordering::Relaxed);
}
fn ok(code: i32, message: &[c_char]) {
    assert_eq!(
        code,
        0,
        "{}",
        unsafe { CStr::from_ptr(message.as_ptr()) }.to_string_lossy()
    );
}
struct Filter {
    device: ash::Device,
    calls: AtomicU32,
    fail: AtomicU32,
}
extern "C" fn clear_pass(context: *const PassContext, user: *mut c_void) -> i32 {
    let context = unsafe { &*context };
    let filter = unsafe { &*user.cast::<Filter>() };
    filter.calls.fetch_add(1, Ordering::Relaxed);
    if filter.fail.load(Ordering::Relaxed) != 0 {
        return Status::Error as i32;
    }
    assert_eq!(context.format, vk::Format::R8G8B8A8_UNORM.as_raw() as u32);
    unsafe {
        filter.device.cmd_clear_color_image(
            context.commands,
            context.output,
            vk::ImageLayout::GENERAL,
            &vk::ClearColorValue {
                float32: [0.25, 0.5, 0.75, 1.],
            },
            &[vk::ImageSubresourceRange {
                aspect_mask: vk::ImageAspectFlags::COLOR,
                base_mip_level: 0,
                level_count: 1,
                base_array_layer: 0,
                layer_count: 1,
            }],
        );
    }
    0
}
#[test]
#[ignore = "requires a real Vulkan GPU (macOS: vulkan-interop feature + MUTRACER_TEST_VULKAN_LIBRARY)"]
fn external_vulkan_device_images_and_native_post_process() {
    let _lock = crate::abi_test_lock();
    let instance_retired = Box::new(AtomicU32::new(0));
    let device_retired = Box::new(AtomicU32::new(0));
    let entry = unsafe {
        match std::env::var_os("MUTRACER_TEST_VULKAN_LIBRARY") {
            Some(path) => ash::Entry::load_from(path),
            None => ash::Entry::load(),
        }
        .expect("Vulkan driver")
    };
    let version = unsafe { entry.try_enumerate_instance_version() }
        .unwrap()
        .unwrap_or(vk::API_VERSION_1_0)
        .min(vk::API_VERSION_1_3);
    let mut error = [0; 2048];
    let get_proc = Some(entry.static_fn().get_instance_proc_addr);
    let mut count = 0;
    ok(
        unsafe {
            mt_vk_instance_extensions(
                get_proc,
                version,
                std::ptr::null_mut(),
                0,
                &mut count,
                error.as_mut_ptr(),
                error.len(),
            )
        },
        &error,
    );
    let mut extensions = vec![std::ptr::null(); count];
    ok(
        unsafe {
            mt_vk_instance_extensions(
                get_proc,
                version,
                extensions.as_mut_ptr(),
                extensions.len(),
                &mut count,
                error.as_mut_ptr(),
                error.len(),
            )
        },
        &error,
    );
    let app = vk::ApplicationInfo::default().api_version(version);
    let portable = extensions
        .iter()
        .any(|p| unsafe { CStr::from_ptr(*p) } == ash::khr::portability_enumeration::NAME);
    let instance = unsafe {
        entry.create_instance(
            &vk::InstanceCreateInfo::default()
                .application_info(&app)
                .enabled_extension_names(&extensions)
                .flags(if portable {
                    vk::InstanceCreateFlags::ENUMERATE_PORTABILITY_KHR
                } else {
                    vk::InstanceCreateFlags::empty()
                }),
            None,
        )
    }
    .unwrap();
    let physical_devices = unsafe { instance.enumerate_physical_devices() }.unwrap();
    let has_graphics_compute_queue = |p: vk::PhysicalDevice| {
        unsafe { instance.get_physical_device_queue_family_properties(p) }
            .iter()
            .any(|q| {
                q.queue_count >= 2
                    && q.queue_flags
                        .contains(vk::QueueFlags::GRAPHICS | vk::QueueFlags::COMPUTE)
            })
    };
    let physical = physical_devices
        .iter()
        .copied()
        .find(|p| {
            unsafe { instance.get_physical_device_properties(*p) }.device_type
                == vk::PhysicalDeviceType::DISCRETE_GPU
                && has_graphics_compute_queue(*p)
        })
        .or_else(|| {
            physical_devices.iter().copied().find(|p| {
                matches!(
                    unsafe { instance.get_physical_device_properties(*p) }.device_type,
                    vk::PhysicalDeviceType::DISCRETE_GPU | vk::PhysicalDeviceType::INTEGRATED_GPU
                ) && has_graphics_compute_queue(*p)
            })
        })
        .expect("hardware Vulkan adapter with two graphics/compute queues");
    let properties = unsafe { instance.get_physical_device_properties(physical) };
    println!(
        "Vulkan host: {}",
        unsafe { CStr::from_ptr(properties.device_name.as_ptr()) }.to_string_lossy()
    );
    let queues = unsafe { instance.get_physical_device_queue_family_properties(physical) };
    let family = queues
        .iter()
        .position(|q| {
            q.queue_flags
                .contains(vk::QueueFlags::GRAPHICS | vk::QueueFlags::COMPUTE)
        })
        .unwrap() as u32;
    assert!(queues[family as usize].queue_count >= 2);
    let host = HostDesc {
        struct_size: 64,
        api_version: version,
        instance: instance.handle(),
        physical_device: physical,
        get_proc,
        instance_extensions: extensions.as_ptr(),
        instance_extension_count: extensions.len(),
        retired: Some(retired),
        retired_user: (&*instance_retired as *const AtomicU32).cast_mut().cast(),
    };
    let options = MtEngineOptions {
        struct_size: 8,
        backend: 0,
    };
    let mut plan = 0;
    let mut requirements = std::mem::MaybeUninit::uninit();
    ok(
        unsafe {
            mt_vk_device_plan_create(
                &host,
                &options,
                &mut plan,
                requirements.as_mut_ptr(),
                error.as_mut_ptr(),
                error.len(),
            )
        },
        &error,
    );
    let requirements: Requirements = unsafe { requirements.assume_init() };
    let priorities = [1., 1.];
    let mut queue_infos = [vk::DeviceQueueCreateInfo::default()
        .queue_family_index(family)
        .queue_priorities(&priorities)];
    queue_infos[0].queue_count = 2;
    let names = unsafe {
        std::slice::from_raw_parts(requirements.extensions, requirements.extension_count)
    };
    let mut create = vk::DeviceCreateInfo::default()
        .queue_create_infos(&queue_infos)
        .enabled_extension_names(names);
    create.p_enabled_features = requirements.features;
    create.p_next = requirements.features_next;
    let device = unsafe { instance.create_device(physical, &create, None) }.unwrap();
    let mut imported = DeviceDesc {
        struct_size: 40,
        queue_family: u32::MAX,
        queue_index: 1,
        reserved: 0,
        device: device.handle(),
        retired: Some(retired),
        retired_user: (&*device_retired as *const AtomicU32).cast_mut().cast(),
    };
    let mut handle = 0;
    assert_eq!(
        unsafe {
            mt_engine_create_vulkan(
                plan,
                &imported,
                &mut handle,
                error.as_mut_ptr(),
                error.len(),
            )
        },
        Status::InvalidArgument as i32
    );
    imported.queue_family = family;
    ok(
        unsafe {
            mt_engine_create_vulkan(
                plan,
                &imported,
                &mut handle,
                error.as_mut_ptr(),
                error.len(),
            )
        },
        &error,
    );
    ok(
        mt_vk_device_plan_destroy(plan, error.as_mut_ptr(), error.len()),
        &error,
    );
    assert_eq!(
        mt_vk_device_plan_destroy(plan, error.as_mut_ptr(), error.len()),
        Status::InvalidHandle as i32
    );
    assert_eq!(instance_retired.load(Ordering::Relaxed), 0);
    assert_eq!(device_retired.load(Ordering::Relaxed), 0);
    let engine = engine_of(handle).unwrap();
    let mut info = std::mem::MaybeUninit::uninit();
    ok(
        unsafe {
            mt_engine_vulkan_info(handle, info.as_mut_ptr(), error.as_mut_ptr(), error.len())
        },
        &error,
    );
    let info: DeviceInfo = unsafe { info.assume_init() };
    assert_eq!(info.device, device.handle());
    assert_eq!(info.instance, instance.handle());
    assert_eq!(info.physical_device, physical);
    assert_eq!(info.queue_family, family);
    let host_queue = unsafe { device.get_device_queue(family, 0) };
    assert_ne!(host_queue, info.queue);
    println!("Vulkan two-queue export: library queue index=1, host queue index=0");
    let mut queue_lease = 0;
    ok(
        unsafe {
            mt_engine_vulkan_acquire_queue(
                handle,
                &mut queue_lease,
                error.as_mut_ptr(),
                error.len(),
            )
        },
        &error,
    );
    assert!(engine_of(handle).is_err());
    ok(
        mt_vk_lease_release(queue_lease, error.as_mut_ptr(), error.len()),
        &error,
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
    let render = Arc::new(
        Render::new(
            &engine,
            RenderSettings {
                max_samples: 1,
                aovs: PixelKind::Depth.aov_mask() | PixelKind::Id.aov_mask(),
                aov_samples: 1,
                size: RenderSize::Fixed {
                    width: 8,
                    height: 6,
                },
                ..Default::default()
            },
        )
        .unwrap(),
    );
    let render_handle = register_render(handle, render.clone(), None).unwrap();
    let mut empty = std::mem::MaybeUninit::uninit();
    assert_eq!(
        unsafe {
            mt_render_vulkan_acquire_image(
                render_handle,
                0,
                empty.as_mut_ptr(),
                error.as_mut_ptr(),
                error.len(),
            )
        },
        Status::InvalidState as i32
    );
    render.converge(ConvergeOptions::new(1)).unwrap();
    let cpu_begin = Instant::now();
    let cpu_hdr_reference = render.read_pixels(PixelKind::Hdr).unwrap().data;
    let cpu_depth_reference = render.read_pixels(PixelKind::Depth).unwrap().data;
    println!(
        "Vulkan CPU read_pixels same scene: {:.3} ms",
        cpu_begin.elapsed().as_secs_f64() * 1000.0
    );

    // Exercise the new foreign-image export path on the imported device. The
    // target is host-owned and the done semaphore is a real Vulkan timeline;
    // only the host queue performs the independent copy/readback below.
    let memory = unsafe { instance.get_physical_device_memory_properties(physical) };
    let export_image = unsafe {
        device
            .create_image(
                &vk::ImageCreateInfo::default()
                    .image_type(vk::ImageType::TYPE_2D)
                    .format(vk::Format::R32G32B32A32_SFLOAT)
                    .extent(vk::Extent3D {
                        width: 8,
                        height: 6,
                        depth: 1,
                    })
                    .mip_levels(1)
                    .array_layers(1)
                    .samples(vk::SampleCountFlags::TYPE_1)
                    .tiling(vk::ImageTiling::OPTIMAL)
                    .usage(
                        vk::ImageUsageFlags::STORAGE
                            | vk::ImageUsageFlags::SAMPLED
                            | vk::ImageUsageFlags::TRANSFER_SRC,
                    )
                    .sharing_mode(vk::SharingMode::EXCLUSIVE)
                    .initial_layout(vk::ImageLayout::UNDEFINED),
                None,
            )
            .unwrap()
    };
    let depth_image = unsafe {
        device
            .create_image(
                &vk::ImageCreateInfo::default()
                    .image_type(vk::ImageType::TYPE_2D)
                    .format(vk::Format::R32_SFLOAT)
                    .extent(vk::Extent3D {
                        width: 8,
                        height: 6,
                        depth: 1,
                    })
                    .mip_levels(1)
                    .array_layers(1)
                    .samples(vk::SampleCountFlags::TYPE_1)
                    .tiling(vk::ImageTiling::OPTIMAL)
                    .usage(
                        vk::ImageUsageFlags::STORAGE
                            | vk::ImageUsageFlags::SAMPLED
                            | vk::ImageUsageFlags::TRANSFER_SRC,
                    )
                    .sharing_mode(vk::SharingMode::EXCLUSIVE)
                    .initial_layout(vk::ImageLayout::UNDEFINED),
                None,
            )
            .unwrap()
    };
    let export_requirements = unsafe { device.get_image_memory_requirements(export_image) };
    let export_memory_type = memory
        .memory_types_as_slice()
        .iter()
        .enumerate()
        .position(|(i, t)| {
            export_requirements.memory_type_bits & (1 << i) != 0
                && t.property_flags
                    .contains(vk::MemoryPropertyFlags::DEVICE_LOCAL)
        })
        .unwrap() as u32;
    let export_memory = unsafe {
        device
            .allocate_memory(
                &vk::MemoryAllocateInfo::default()
                    .allocation_size(export_requirements.size)
                    .memory_type_index(export_memory_type),
                None,
            )
            .unwrap()
    };
    unsafe { device.bind_image_memory(export_image, export_memory, 0) }.unwrap();
    let depth_requirements = unsafe { device.get_image_memory_requirements(depth_image) };
    let depth_memory_type = memory
        .memory_types_as_slice()
        .iter()
        .enumerate()
        .position(|(i, t)| {
            depth_requirements.memory_type_bits & (1 << i) != 0
                && t.property_flags
                    .contains(vk::MemoryPropertyFlags::DEVICE_LOCAL)
        })
        .unwrap() as u32;
    let depth_memory = unsafe {
        device
            .allocate_memory(
                &vk::MemoryAllocateInfo::default()
                    .allocation_size(depth_requirements.size)
                    .memory_type_index(depth_memory_type),
                None,
            )
            .unwrap()
    };
    unsafe { device.bind_image_memory(depth_image, depth_memory, 0) }.unwrap();
    let mut timeline_info = vk::SemaphoreTypeCreateInfo::default()
        .semaphore_type(vk::SemaphoreType::TIMELINE)
        .initial_value(0);
    let export_ready = unsafe {
        device
            .create_semaphore(
                &vk::SemaphoreCreateInfo::default().push_next(&mut timeline_info),
                None,
            )
            .unwrap()
    };
    let mut done_timeline_info = vk::SemaphoreTypeCreateInfo::default()
        .semaphore_type(vk::SemaphoreType::TIMELINE)
        .initial_value(0);
    let export_done = unsafe {
        device
            .create_semaphore(
                &vk::SemaphoreCreateInfo::default().push_next(&mut done_timeline_info),
                None,
            )
            .unwrap()
    };
    let imported_export = unsafe {
        engine
            .import_vulkan_image(
                export_image,
                vk::Format::R32G32B32A32_SFLOAT,
                8,
                6,
                vk::ImageLayout::UNDEFINED,
            )
            .unwrap()
    };
    let imported_depth = unsafe {
        engine
            .import_vulkan_image(
                depth_image,
                vk::Format::R32_SFLOAT,
                8,
                6,
                vk::ImageLayout::UNDEFINED,
            )
            .unwrap()
    };
    let imported_ready = unsafe { engine.import_vulkan_timeline(export_ready) }.unwrap();
    let imported_done = unsafe { engine.import_vulkan_timeline(export_done) }.unwrap();
    let imported_done_duplicate = unsafe { engine.import_vulkan_timeline(export_done) }.unwrap();
    // A second wrapper for the same native semaphore must share the canonical
    // reservation state: reusing value 1 is rejected before any queue submit.
    assert!(render
        .export_vulkan(
            &[(imported_export.clone(), 0, 0)],
            None,
            (&imported_done_duplicate, 1),
        )
        .is_err());
    let export_begin = Instant::now();
    let export_sequence = render
        .export_vulkan(
            &[
                (imported_export.clone(), 0, 0),
                (imported_depth.clone(), 1, 0),
            ],
            None,
            (&imported_done, 1),
        )
        .unwrap();
    let wait_info = vk::SemaphoreWaitInfo::default()
        .semaphores(std::slice::from_ref(&export_done))
        .values(&[1]);
    unsafe { device.wait_semaphores(&wait_info, u64::MAX) }.unwrap();
    assert!(engine.poll_vulkan_exports(export_sequence).unwrap());
    println!(
        "Vulkan export submit+timeline: {:.3} ms",
        export_begin.elapsed().as_secs_f64() * 1000.0
    );
    let exported_reference = cpu_hdr_reference;
    let exported_depth_reference = cpu_depth_reference;
    let export_buffer = unsafe {
        device
            .create_buffer(
                &vk::BufferCreateInfo::default()
                    .size((8 * 6 * 16) as u64)
                    .usage(vk::BufferUsageFlags::TRANSFER_DST)
                    .sharing_mode(vk::SharingMode::EXCLUSIVE),
                None,
            )
            .unwrap()
    };
    let export_buffer_requirements =
        unsafe { device.get_buffer_memory_requirements(export_buffer) };
    let export_buffer_type = memory
        .memory_types_as_slice()
        .iter()
        .enumerate()
        .position(|(i, t)| {
            export_buffer_requirements.memory_type_bits & (1 << i) != 0
                && t.property_flags.contains(
                    vk::MemoryPropertyFlags::HOST_VISIBLE | vk::MemoryPropertyFlags::HOST_COHERENT,
                )
        })
        .unwrap() as u32;
    let export_buffer_memory = unsafe {
        device
            .allocate_memory(
                &vk::MemoryAllocateInfo::default()
                    .allocation_size(export_buffer_requirements.size)
                    .memory_type_index(export_buffer_type),
                None,
            )
            .unwrap()
    };
    unsafe { device.bind_buffer_memory(export_buffer, export_buffer_memory, 0) }.unwrap();
    let export_pool = unsafe {
        device
            .create_command_pool(
                &vk::CommandPoolCreateInfo::default().queue_family_index(family),
                None,
            )
            .unwrap()
    };
    let export_range = vk::ImageSubresourceRange {
        aspect_mask: vk::ImageAspectFlags::COLOR,
        base_mip_level: 0,
        level_count: 1,
        base_array_layer: 0,
        layer_count: 1,
    };
    let export_command = unsafe {
        device
            .allocate_command_buffers(
                &vk::CommandBufferAllocateInfo::default()
                    .command_pool(export_pool)
                    .level(vk::CommandBufferLevel::PRIMARY)
                    .command_buffer_count(1),
            )
            .unwrap()[0]
    };
    unsafe {
        device
            .begin_command_buffer(export_command, &vk::CommandBufferBeginInfo::default())
            .unwrap();
        device.cmd_pipeline_barrier(
            export_command,
            vk::PipelineStageFlags::ALL_COMMANDS,
            vk::PipelineStageFlags::TRANSFER,
            vk::DependencyFlags::empty(),
            &[],
            &[],
            &[vk::ImageMemoryBarrier::default()
                .image(export_image)
                .subresource_range(export_range)
                .old_layout(vk::ImageLayout::GENERAL)
                .new_layout(vk::ImageLayout::TRANSFER_SRC_OPTIMAL)
                .src_queue_family_index(vk::QUEUE_FAMILY_IGNORED)
                .dst_queue_family_index(vk::QUEUE_FAMILY_IGNORED)
                .src_access_mask(vk::AccessFlags::SHADER_WRITE)
                .dst_access_mask(vk::AccessFlags::TRANSFER_READ)],
        );
        device.cmd_copy_image_to_buffer(
            export_command,
            export_image,
            vk::ImageLayout::TRANSFER_SRC_OPTIMAL,
            export_buffer,
            &[vk::BufferImageCopy::default()
                .image_subresource(vk::ImageSubresourceLayers {
                    aspect_mask: vk::ImageAspectFlags::COLOR,
                    mip_level: 0,
                    base_array_layer: 0,
                    layer_count: 1,
                })
                .image_extent(vk::Extent3D {
                    width: 8,
                    height: 6,
                    depth: 1,
                })],
        );
        device.cmd_pipeline_barrier(
            export_command,
            vk::PipelineStageFlags::TRANSFER,
            vk::PipelineStageFlags::ALL_COMMANDS,
            vk::DependencyFlags::empty(),
            &[],
            &[],
            &[vk::ImageMemoryBarrier::default()
                .image(export_image)
                .subresource_range(export_range)
                .old_layout(vk::ImageLayout::TRANSFER_SRC_OPTIMAL)
                .new_layout(vk::ImageLayout::GENERAL)
                .src_queue_family_index(vk::QUEUE_FAMILY_IGNORED)
                .dst_queue_family_index(vk::QUEUE_FAMILY_IGNORED)
                .src_access_mask(vk::AccessFlags::TRANSFER_READ)
                .dst_access_mask(vk::AccessFlags::SHADER_WRITE)],
        );
        device.end_command_buffer(export_command).unwrap();
        let wait_values = [1_u64];
        let signal_values = [2_u64];
        let mut timeline_submit = vk::TimelineSemaphoreSubmitInfo::default()
            .wait_semaphore_values(&wait_values)
            .signal_semaphore_values(&signal_values);
        let host_commands = [export_command];
        let submit = vk::SubmitInfo::default()
            .command_buffers(&host_commands)
            .wait_semaphores(std::slice::from_ref(&export_done))
            .wait_dst_stage_mask(&[vk::PipelineStageFlags::TRANSFER])
            .signal_semaphores(std::slice::from_ref(&export_ready))
            .push_next(&mut timeline_submit);
        let host_fence = device
            .create_fence(&vk::FenceCreateInfo::default(), None)
            .unwrap();
        device
            .queue_submit(host_queue, &[submit], host_fence)
            .unwrap();
        device
            .wait_for_fences(&[host_fence], true, 10_000_000_000)
            .unwrap();
        device.destroy_fence(host_fence, None);
    }
    println!("Vulkan two-queue host copy: queue0 returned GENERAL and signaled ready=2");
    // Reuse the same imported image and both timelines for a second accepted
    // export only after queue0 has published ready=2; this is the actual
    // cross-queue hand-off rather than a CPU-side signal.
    let export_sequence2 = render
        .export_vulkan(
            &[(imported_depth.clone(), 1, 0)],
            Some((&imported_ready, 2)),
            (&imported_done, 2),
        )
        .unwrap();
    println!("Vulkan two-queue export: accepted ready=2 done=2");
    let wait_info2 = vk::SemaphoreWaitInfo::default()
        .semaphores(std::slice::from_ref(&export_done))
        .values(&[2]);
    unsafe { device.wait_semaphores(&wait_info2, u64::MAX) }.unwrap();
    assert!(engine.poll_vulkan_exports(export_sequence2).unwrap());
    let export_mapped = unsafe {
        device
            .map_memory(
                export_buffer_memory,
                0,
                vk::WHOLE_SIZE,
                vk::MemoryMapFlags::empty(),
            )
            .unwrap()
    };
    let exported_pixels = unsafe {
        std::slice::from_raw_parts(export_mapped.cast::<f32>(), exported_reference.len())
    };
    assert_eq!(exported_pixels, exported_reference.as_slice());
    unsafe {
        device.unmap_memory(export_buffer_memory);
    }
    // The depth AOV uses a single-channel R32_SFLOAT storage image.  Read it
    // back through the host queue as well, so the test covers the format
    // conversion path independently of the four-channel HDR image.
    let depth_command = unsafe {
        device
            .allocate_command_buffers(
                &vk::CommandBufferAllocateInfo::default()
                    .command_pool(export_pool)
                    .level(vk::CommandBufferLevel::PRIMARY)
                    .command_buffer_count(1),
            )
            .unwrap()[0]
    };
    unsafe {
        device
            .begin_command_buffer(depth_command, &vk::CommandBufferBeginInfo::default())
            .unwrap();
        device.cmd_pipeline_barrier(
            depth_command,
            vk::PipelineStageFlags::ALL_COMMANDS,
            vk::PipelineStageFlags::TRANSFER,
            vk::DependencyFlags::empty(),
            &[],
            &[],
            &[vk::ImageMemoryBarrier::default()
                .image(depth_image)
                .subresource_range(export_range)
                .old_layout(vk::ImageLayout::GENERAL)
                .new_layout(vk::ImageLayout::TRANSFER_SRC_OPTIMAL)
                .src_queue_family_index(vk::QUEUE_FAMILY_IGNORED)
                .dst_queue_family_index(vk::QUEUE_FAMILY_IGNORED)
                .src_access_mask(vk::AccessFlags::SHADER_WRITE)
                .dst_access_mask(vk::AccessFlags::TRANSFER_READ)],
        );
        device.cmd_copy_image_to_buffer(
            depth_command,
            depth_image,
            vk::ImageLayout::TRANSFER_SRC_OPTIMAL,
            export_buffer,
            &[vk::BufferImageCopy::default()
                .image_subresource(vk::ImageSubresourceLayers {
                    aspect_mask: vk::ImageAspectFlags::COLOR,
                    mip_level: 0,
                    base_array_layer: 0,
                    layer_count: 1,
                })
                .image_extent(vk::Extent3D {
                    width: 8,
                    height: 6,
                    depth: 1,
                })],
        );
        device.cmd_pipeline_barrier(
            depth_command,
            vk::PipelineStageFlags::TRANSFER,
            vk::PipelineStageFlags::ALL_COMMANDS,
            vk::DependencyFlags::empty(),
            &[],
            &[],
            &[vk::ImageMemoryBarrier::default()
                .image(depth_image)
                .subresource_range(export_range)
                .old_layout(vk::ImageLayout::TRANSFER_SRC_OPTIMAL)
                .new_layout(vk::ImageLayout::GENERAL)
                .src_queue_family_index(vk::QUEUE_FAMILY_IGNORED)
                .dst_queue_family_index(vk::QUEUE_FAMILY_IGNORED)
                .src_access_mask(vk::AccessFlags::TRANSFER_READ)
                .dst_access_mask(vk::AccessFlags::SHADER_WRITE)],
        );
        device.end_command_buffer(depth_command).unwrap();
        let depth_fence = device
            .create_fence(&vk::FenceCreateInfo::default(), None)
            .unwrap();
        device
            .queue_submit(
                host_queue,
                &[vk::SubmitInfo::default().command_buffers(&[depth_command])],
                depth_fence,
            )
            .unwrap();
        device
            .wait_for_fences(&[depth_fence], true, 10_000_000_000)
            .unwrap();
        device.destroy_fence(depth_fence, None);
    }
    let depth_mapped = unsafe {
        device
            .map_memory(
                export_buffer_memory,
                0,
                vk::WHOLE_SIZE,
                vk::MemoryMapFlags::empty(),
            )
            .unwrap()
    };
    let exported_depth = unsafe { std::slice::from_raw_parts(depth_mapped.cast::<f32>(), 8 * 6) };
    for (index, value) in exported_depth.iter().enumerate() {
        assert_eq!(*value, exported_depth_reference[index * 4]);
    }
    unsafe {
        device.unmap_memory(export_buffer_memory);
        device.destroy_command_pool(export_pool, None);
        device.destroy_buffer(export_buffer, None);
        device.free_memory(export_buffer_memory, None);
        device.destroy_semaphore(export_ready, None);
        device.destroy_semaphore(export_done, None);
        device.destroy_image(export_image, None);
        device.free_memory(export_memory, None);
        device.destroy_image(depth_image, None);
        device.free_memory(depth_memory, None);
    }
    drop(imported_export);
    drop(imported_depth);
    drop(imported_ready);
    drop(imported_done);
    drop(imported_done_duplicate);
    let before = engine.inner.gpu.queue.readback_count();
    let mut image = std::mem::MaybeUninit::uninit();
    ok(
        unsafe {
            mt_render_vulkan_acquire_image(
                render_handle,
                0,
                image.as_mut_ptr(),
                error.as_mut_ptr(),
                error.len(),
            )
        },
        &error,
    );
    let image: ImageInfo = unsafe { image.assume_init() };
    assert_eq!([image.width, image.height], [8, 6]);
    assert_eq!(
        image.format,
        vk::Format::R32G32B32A32_SFLOAT.as_raw() as u32
    );
    assert_eq!(
        unsafe { mt_engine_destroy(handle, error.as_mut_ptr(), error.len()) },
        Status::InvalidState as i32
    );
    assert_eq!(
        unsafe { mt_render_restart(render_handle, error.as_mut_ptr(), error.len()) },
        Status::InvalidState as i32
    );
    let mut written = usize::MAX;
    // MT_IMAGE_ID readback must obey the same submission exclusion as beauty.
    assert_eq!(
        unsafe {
            mt_render_read_pixels(
                render_handle,
                9,
                std::ptr::null_mut(),
                0,
                &mut written,
                error.as_mut_ptr(),
                error.len(),
            )
        },
        Status::InvalidState as i32
    );
    assert_eq!(written, usize::MAX);
    let mut other = std::mem::MaybeUninit::uninit();
    assert_eq!(
        unsafe {
            mt_render_vulkan_acquire_image(
                render_handle,
                0,
                other.as_mut_ptr(),
                error.as_mut_ptr(),
                error.len(),
            )
        },
        Status::InvalidState as i32
    );
    // Host consumes the borrowed image with its own Vulkan command buffer.
    let buffer = unsafe {
        device.create_buffer(
            &vk::BufferCreateInfo::default()
                .size(8 * 6 * 16)
                .usage(vk::BufferUsageFlags::TRANSFER_DST),
            None,
        )
    }
    .unwrap();
    let mem_req = unsafe { device.get_buffer_memory_requirements(buffer) };
    let memory_type = memory
        .memory_types_as_slice()
        .iter()
        .enumerate()
        .position(|(i, t)| {
            mem_req.memory_type_bits & (1 << i) != 0
                && t.property_flags.contains(
                    vk::MemoryPropertyFlags::HOST_VISIBLE | vk::MemoryPropertyFlags::HOST_COHERENT,
                )
        })
        .unwrap() as u32;
    let allocation = unsafe {
        device.allocate_memory(
            &vk::MemoryAllocateInfo::default()
                .allocation_size(mem_req.size)
                .memory_type_index(memory_type),
            None,
        )
    }
    .unwrap();
    unsafe { device.bind_buffer_memory(buffer, allocation, 0) }.unwrap();
    let pool = unsafe {
        device.create_command_pool(
            &vk::CommandPoolCreateInfo::default().queue_family_index(family),
            None,
        )
    }
    .unwrap();
    let command = unsafe {
        device.allocate_command_buffers(
            &vk::CommandBufferAllocateInfo::default()
                .command_pool(pool)
                .level(vk::CommandBufferLevel::PRIMARY)
                .command_buffer_count(1),
        )
    }
    .unwrap()[0];
    let range = vk::ImageSubresourceRange {
        aspect_mask: vk::ImageAspectFlags::COLOR,
        base_mip_level: 0,
        level_count: 1,
        base_array_layer: 0,
        layer_count: 1,
    };
    unsafe {
        device
            .begin_command_buffer(command, &vk::CommandBufferBeginInfo::default())
            .unwrap();
        device.cmd_pipeline_barrier(
            command,
            vk::PipelineStageFlags::ALL_COMMANDS,
            vk::PipelineStageFlags::TRANSFER,
            vk::DependencyFlags::empty(),
            &[],
            &[],
            &[vk::ImageMemoryBarrier::default()
                .image(image.image)
                .subresource_range(range)
                .old_layout(vk::ImageLayout::SHADER_READ_ONLY_OPTIMAL)
                .new_layout(vk::ImageLayout::TRANSFER_SRC_OPTIMAL)
                .src_queue_family_index(vk::QUEUE_FAMILY_IGNORED)
                .dst_queue_family_index(vk::QUEUE_FAMILY_IGNORED)
                .src_access_mask(vk::AccessFlags::MEMORY_WRITE)
                .dst_access_mask(vk::AccessFlags::TRANSFER_READ)],
        );
        device.cmd_copy_image_to_buffer(
            command,
            image.image,
            vk::ImageLayout::TRANSFER_SRC_OPTIMAL,
            buffer,
            &[vk::BufferImageCopy::default()
                .image_subresource(vk::ImageSubresourceLayers {
                    aspect_mask: vk::ImageAspectFlags::COLOR,
                    mip_level: 0,
                    base_array_layer: 0,
                    layer_count: 1,
                })
                .image_extent(vk::Extent3D {
                    width: 8,
                    height: 6,
                    depth: 1,
                })],
        );
        device.cmd_pipeline_barrier(
            command,
            vk::PipelineStageFlags::TRANSFER,
            vk::PipelineStageFlags::ALL_COMMANDS,
            vk::DependencyFlags::empty(),
            &[],
            &[],
            &[vk::ImageMemoryBarrier::default()
                .image(image.image)
                .subresource_range(range)
                .old_layout(vk::ImageLayout::TRANSFER_SRC_OPTIMAL)
                .new_layout(vk::ImageLayout::SHADER_READ_ONLY_OPTIMAL)
                .src_queue_family_index(vk::QUEUE_FAMILY_IGNORED)
                .dst_queue_family_index(vk::QUEUE_FAMILY_IGNORED)
                .src_access_mask(vk::AccessFlags::TRANSFER_READ)
                .dst_access_mask(vk::AccessFlags::SHADER_READ)],
        );
        device.end_command_buffer(command).unwrap();
        device
            .queue_submit(
                info.queue,
                &[vk::SubmitInfo::default().command_buffers(&[command])],
                vk::Fence::null(),
            )
            .unwrap();
    }
    ok(
        mt_vk_lease_release(image.lease, error.as_mut_ptr(), error.len()),
        &error,
    );
    assert_eq!(
        mt_vk_lease_release(image.lease, error.as_mut_ptr(), error.len()),
        Status::InvalidHandle as i32
    );
    assert_eq!(engine.inner.gpu.queue.readback_count(), before);
    let ids = render.read_pixels(PixelKind::Id).unwrap();
    assert!(ids.id_data.unwrap().iter().all(|v| *v == u32::MAX));
    assert!(render
        .read_pixels(PixelKind::Depth)
        .unwrap()
        .data
        .iter()
        .all(|v| *v == 0.));
    render
        .set_settings(RenderSettings {
            max_samples: 1,
            size: RenderSize::Fixed {
                width: 16,
                height: 12,
            },
            ..Default::default()
        })
        .unwrap();
    render.converge(ConvergeOptions::new(1)).unwrap();
    unsafe { device.queue_wait_idle(info.queue) }.unwrap();
    let data =
        unsafe { device.map_memory(allocation, 0, vk::WHOLE_SIZE, vk::MemoryMapFlags::empty()) }
            .unwrap();
    for pixel in
        unsafe { std::slice::from_raw_parts(data.cast::<f32>(), 8 * 6 * 4) }.chunks_exact(4)
    {
        assert_eq!(pixel, &[0.25, 0.5, 1., 1.]);
    }
    unsafe {
        device.unmap_memory(allocation);
        device.destroy_buffer(buffer, None);
        device.free_memory(allocation, None);
        device.destroy_command_pool(pool, None);
    }
    let mut display = 0;
    ok(
        unsafe { mt_engine_display(handle, &mut display, error.as_mut_ptr(), error.len()) },
        &error,
    );
    let filter = Box::new(Filter {
        device: device.clone(),
        calls: AtomicU32::new(0),
        fail: AtomicU32::new(0),
    });
    let mut pass = 0;
    ok(
        unsafe {
            mt_display_add_vulkan_post_process(
                display,
                0,
                Some(clear_pass),
                (&*filter as *const Filter).cast_mut().cast(),
                &mut pass,
                error.as_mut_ptr(),
                error.len(),
            )
        },
        &error,
    );
    let identity = engine
        .display()
        .add_post_process(|ctx| {
            ctx.encoder.copy_texture_to_texture(
                ctx.input.as_image_copy(),
                ctx.output.as_image_copy(),
                ctx.input.size(),
            );
            Ok(())
        })
        .unwrap();
    engine.display().present(&render).unwrap();
    let output = engine.display().read_rgba8(&render).unwrap().2;
    for pixel in output.chunks_exact(4) {
        assert_eq!(pixel, &[64, 128, 191, 255]);
    }
    assert_eq!(filter.calls.load(Ordering::Relaxed), 2);
    identity.remove();
    // Callback failure keeps the original composition rather than stale output.
    filter.fail.store(1, Ordering::Relaxed);
    engine.display().present(&render).unwrap();
    let fallback = engine.display().read_rgba8(&render).unwrap().2;
    assert_ne!(output, fallback);
    ok(
        mt_vk_post_process_remove(pass, error.as_mut_ptr(), error.len()),
        &error,
    );
    assert_eq!(
        mt_vk_post_process_remove(pass, error.as_mut_ptr(), error.len()),
        Status::InvalidHandle as i32
    );
    // Release immediately before destruction, with no intervening CPU readback
    // or poll; retirement must not depend on a callback retaining the texture.
    let mut final_image = std::mem::MaybeUninit::uninit();
    ok(
        unsafe {
            mt_render_vulkan_acquire_image(
                render_handle,
                0,
                final_image.as_mut_ptr(),
                error.as_mut_ptr(),
                error.len(),
            )
        },
        &error,
    );
    let final_image: ImageInfo = unsafe { final_image.assume_init() };
    ok(
        mt_vk_lease_release(final_image.lease, error.as_mut_ptr(), error.len()),
        &error,
    );
    ok(
        unsafe { mt_engine_destroy(handle, error.as_mut_ptr(), error.len()) },
        &error,
    );
    assert_eq!(device_retired.load(Ordering::Relaxed), 0);
    drop(render);
    drop(engine);
    drop(filter);
    assert_eq!(device_retired.load(Ordering::Relaxed), 1);
    assert_eq!(instance_retired.load(Ordering::Relaxed), 1);
    // MuTracer never destroys the host's device or instance.
    unsafe {
        device.device_wait_idle().unwrap();
        device.destroy_device(None);
        instance.destroy_instance(None);
    }
}
