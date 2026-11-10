//! Independent execution probe for the pinned wgpu ray-query contracts.
use std::{fs, path::Path, sync::mpsc, time::Duration};
use wgpu::util::DeviceExt;
type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
#[derive(Clone)]
struct Ray {
    values: [f32; 8],
    filter: [u32; 4],
    expected: Option<(f32, u32, u32)>,
    candidates: bool,
    local_front: bool,
    barycentrics: [f32; 2],
}
fn ray(
    x: f32,
    z: f32,
    dz: f32,
    mask: u32,
    flags: u32,
    instance: u32,
    primitive: u32,
    expected: Option<(f32, u32, u32)>,
    candidates: bool,
) -> Ray {
    Ray {
        values: [x, 0., z, 20., 0., 0., dz, mask as f32],
        filter: [flags, instance, primitive, 0],
        expected,
        candidates,
        local_front: dz < 0.,
        barycentrics: [0.25, 0.5],
    }
}
fn main() {
    mutracer_native::logging::stderr();
    if let Err(e) = run() {
        eprintln!("{e}");
        std::process::exit(1);
    }
}
fn run() -> Result<()> {
    let directory = std::env::args()
        .nth(1)
        .ok_or("Usage: ray-query-probe OUTPUT_DIRECTORY")?;
    let directory = Path::new(&directory);
    fs::create_dir_all(directory)?;
    let instance =
        wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle_from_env());
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::HighPerformance,
        ..Default::default()
    }))?;
    let limits = adapter.limits();
    let features = adapter.features();
    if !features.contains(wgpu::Features::EXPERIMENTAL_RAY_QUERY) {
        fs::write(directory.join("result.json"), "{\"supported\":false}")?;
        return Ok(());
    }
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
        required_features: wgpu::Features::EXPERIMENTAL_RAY_QUERY,
        required_limits: limits.clone(),
        experimental_features: unsafe { wgpu::ExperimentalFeatures::enabled() },
        ..Default::default()
    }))?;
    let mut rows = Vec::new();
    for opaque in [true, false] {
        rows.push(triangles(&device, &queue, opaque, directory)?);
    }
    let aabb = procedural(&device, &queue, directory);
    let report = serde_json::json!({"adapter":adapter.get_info().name,"backend":format!("{:?}",adapter.get_info().backend),"supported":true,
  "triangles":rows,"aabb":match aabb {Ok(row)=>row,Err(e)=>serde_json::json!({"supported":false,"error":e.to_string()})},
  "limits":{"maxBlasPrimitiveCount":limits.max_blas_primitive_count,"maxBlasGeometryCount":limits.max_blas_geometry_count,"maxTlasInstanceCount":limits.max_tlas_instance_count},
  "timestampQuery":features.contains(wgpu::Features::TIMESTAMP_QUERY),"encoderTimestamps":features.contains(wgpu::Features::TIMESTAMP_QUERY_INSIDE_ENCODERS),
  "asSizeEstimates":memory_estimates(&device)});
    fs::write(
        directory.join("result.json"),
        serde_json::to_vec_pretty(&report)?,
    )?;
    println!("{report}");
    Ok(())
}
fn triangles(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    opaque: bool,
    directory: &Path,
) -> Result<serde_json::Value> {
    let vertices: [f32; 18] = [
        -1., -1., 0., 1., -1., 0., 0., 1., 0., -1., -1., -1., 1., -1., -1., 0., 1., -1.,
    ];
    let buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("Analytic triangles"),
        contents: &vertices
            .into_iter()
            .flat_map(f32::to_le_bytes)
            .collect::<Vec<_>>(),
        usage: wgpu::BufferUsages::BLAS_INPUT,
    });
    let size = wgpu::BlasTriangleGeometrySizeDescriptor {
        vertex_format: wgpu::VertexFormat::Float32x3,
        vertex_count: 6,
        index_format: None,
        index_count: None,
        flags: if opaque {
            wgpu::AccelerationStructureGeometryFlags::OPAQUE
        } else {
            wgpu::AccelerationStructureGeometryFlags::empty()
        },
    };
    let blas = device.create_blas(
        &wgpu::CreateBlasDescriptor {
            label: Some("Capability BLAS"),
            flags: wgpu::AccelerationStructureFlags::PREFER_FAST_TRACE,
            update_mode: wgpu::AccelerationStructureUpdateMode::Build,
        },
        wgpu::BlasGeometrySizeDescriptors::Triangles {
            descriptors: vec![size.clone()],
        },
    );
    let mut tlas = device.create_tlas(&wgpu::CreateTlasDescriptor {
        label: Some("Affine capability TLAS"),
        max_instances: 4,
        flags: wgpu::AccelerationStructureFlags::PREFER_FAST_TRACE,
        update_mode: wgpu::AccelerationStructureUpdateMode::Build,
    });
    for (i, (transform, custom, mask)) in [
        ([1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0.], 17, 1),
        ([2., 0., 0., 3., 0., 0.5, 0., 0., 0., 0., 3., 0.], 29, 2),
        ([-2., 0., 0., -3., 0., 0.5, 0., 0., 0., 0., 3., 0.], 31, 4),
        ([2., 0.3, 0., 6., 0., 0.5, 0., 0., 0., 0., 3., 0.], 37, 8),
    ]
    .into_iter()
    .enumerate()
    {
        tlas[i] = Some(wgpu::TlasInstance::new(&blas, transform, custom, mask));
    }
    let any = u32::MAX;
    let force = 2;
    let terminate = 4;
    let mut rays = vec![
        ray(0., 2., -1., 1, 0, any, any, Some((2., 17, 0)), !opaque),
        ray(3., 6., -1., 2, 0, any, any, Some((6., 29, 0)), !opaque),
        ray(-3., 6., -1., 4, 0, any, any, Some((6., 31, 0)), !opaque),
        ray(6., 6., -1., 8, 0, any, any, Some((6., 37, 0)), !opaque),
        ray(0., -2., 1., 1, 0, any, any, Some((1., 17, 1)), !opaque),
        ray(10., 2., -1., 255, 0, any, any, None, false),
        ray(0., 2., -1., 1, force, 17, 1, Some((3., 17, 1)), true),
        ray(
            0.,
            2.,
            -1.,
            1,
            force | terminate,
            17,
            1,
            Some((3., 17, 1)),
            true,
        ),
        ray(0., 2., -1., 1, force, 99, any, None, true),
        ray(3., 6., -1., 255, force, 17, any, None, true),
    ];
    let mut clipped = ray(0., 2., -1., 1, 0, any, any, None, false);
    clipped.values[3] = 0.5;
    rays.push(clipped);
    // An off-center point exercises the shear term, rather than just translation.
    let mut sheared = ray(6.075, 6., -1., 8, 0, any, any, Some((6., 37, 0)), !opaque);
    sheared.values[1] = 0.125;
    sheared.barycentrics = [0.1875, 0.625];
    rays.push(sheared);
    rays.push(ray(
        3.,
        6.,
        -0.5,
        2,
        0,
        any,
        any,
        Some((12., 29, 0)),
        !opaque,
    ));
    rays.push(ray(3., 6., -1., 1, 0, any, any, None, false));
    let build = wgpu::BlasBuildEntry {
        blas: &blas,
        geometry: wgpu::BlasGeometries::TriangleGeometries(vec![wgpu::BlasTriangleGeometry {
            size: &size,
            vertex_buffer: &buffer,
            first_vertex: 0,
            vertex_stride: 12,
            index_buffer: None,
            first_index: None,
            transform_buffer: None,
            transform_buffer_offset: None,
        }]),
    };
    let observations = dispatch(device, queue, &tlas, &build, &rays)?;
    let mut front_faces = Vec::new();
    for (i, (values, ray)) in observations.iter().zip(&rays).enumerate() {
        if let Some((t, custom, primitive)) = ray.expected {
            if values[0] != 1.
                || (values[1] - t).abs() > 1e-5
                || values[2] != custom as f32
                || values[3] != primitive as f32
                || (values[4] - ray.barycentrics[0]).abs() > 1e-5
                || (values[5] - ray.barycentrics[1]).abs() > 1e-5
            {
                return Err(format!("Triangle probe {opaque}/{i}: {values:?}").into());
            }
            front_faces.push(serde_json::json!({"ray":i,"hardwareFront":values[6]!=0.,"softwareLocalFront":ray.local_front,"matches":(values[6]!=0.)==ray.local_front}));
            let expected_instance = match custom {
                17 => 0.,
                29 => 1.,
                31 => 2.,
                37 => 3.,
                _ => unreachable!(),
            };
            if values[8] != expected_instance || values[9] != 0. {
                return Err("Incorrect instance/geometry indices".into());
            }
        } else if values[0] != 0. {
            return Err(format!("Unexpected hit {opaque}/{i}: {values:?}").into());
        }
        if ray.candidates && values[7] < 1. {
            return Err("Candidate loop was not entered".into());
        }
    }
    fs::write(
        directory.join(if opaque {
            "opaque.json"
        } else {
            "nonopaque.json"
        }),
        serde_json::to_vec_pretty(&observations)?,
    )?;

    Ok(
        serde_json::json!({"opaque":opaque,"verifiedRays":rays.len(),"terminateOnFirstHit":true,"forceNoOpaqueInstanceFilter":true,"candidateConfirm":true,"frontFaces":front_faces}),
    )
}
fn procedural(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    directory: &Path,
) -> Result<serde_json::Value> {
    let data: [f32; 6] = [-1., -1., -0.1, 1., 1., 0.1];
    let buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: None,
        contents: &data
            .into_iter()
            .flat_map(f32::to_le_bytes)
            .collect::<Vec<_>>(),
        usage: wgpu::BufferUsages::BLAS_INPUT,
    });
    let size = wgpu::BlasAABBGeometrySizeDescriptor {
        primitive_count: 1,
        flags: wgpu::AccelerationStructureGeometryFlags::empty(),
    };
    let blas = device.create_blas(
        &wgpu::CreateBlasDescriptor {
            label: None,
            flags: wgpu::AccelerationStructureFlags::PREFER_FAST_TRACE,
            update_mode: wgpu::AccelerationStructureUpdateMode::Build,
        },
        wgpu::BlasGeometrySizeDescriptors::AABBs {
            descriptors: vec![size.clone()],
        },
    );
    let mut tlas = device.create_tlas(&wgpu::CreateTlasDescriptor {
        label: None,
        max_instances: 1,
        flags: wgpu::AccelerationStructureFlags::PREFER_FAST_TRACE,
        update_mode: wgpu::AccelerationStructureUpdateMode::Build,
    });
    tlas[0] = Some(wgpu::TlasInstance::new(
        &blas,
        [1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0.],
        41,
        255,
    ));
    let build = wgpu::BlasBuildEntry {
        blas: &blas,
        geometry: wgpu::BlasGeometries::AabbGeometries(vec![wgpu::BlasAabbGeometry {
            size: &size,
            stride: 24,
            aabb_buffer: &buffer,
            primitive_offset: 0,
        }]),
    };
    let mut accept = ray(0., 2., -1., 255, 0, u32::MAX, u32::MAX, None, true);
    accept.filter[3] = 2f32.to_bits();
    let reject = ray(0., 2., -1., 255, 0, u32::MAX, u32::MAX, None, true);
    let observations = dispatch(device, queue, &tlas, &build, &[accept, reject])?;
    if observations[0][0] != 2.
        || observations[0][1] != 2.
        || observations[0][2] != 41.
        || observations[0][7] < 1.
        || observations[1][0] != 0.
    {
        return Err(format!("AABB mismatch: {observations:?}").into());
    }
    fs::write(
        directory.join("aabb.json"),
        serde_json::to_vec_pretty(&observations)?,
    )?;
    Ok(serde_json::json!({"supported":true,"candidateGenerate":true,"candidateReject":true}))
}
fn dispatch(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    tlas: &wgpu::Tlas,
    build: &wgpu::BlasBuildEntry<'_>,
    rays: &[Ray],
) -> Result<Vec<Vec<f32>>> {
    let mut bytes = Vec::new();
    for ray in rays {
        bytes.extend(ray.values.into_iter().flat_map(f32::to_le_bytes));
        bytes.extend(ray.filter.into_iter().flat_map(u32::to_le_bytes));
    }
    let inputs = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: None,
        contents: &bytes,
        usage: wgpu::BufferUsages::STORAGE,
    });
    let length = rays.len() as u64 * 48;
    let output = device.create_buffer(&wgpu::BufferDescriptor {
        label: None,
        size: length,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
        mapped_at_creation: false,
    });
    let readback = device.create_buffer(&wgpu::BufferDescriptor {
        label: None,
        size: length,
        usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("Ray-query capability checks"),
        source: wgpu::ShaderSource::Wgsl(include_str!("ray-query-probe.wgsl").into()),
    });
    let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
        label: None,
        layout: None,
        module: &shader,
        entry_point: Some("main"),
        compilation_options: Default::default(),
        cache: None,
    });
    let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: None,
        layout: &pipeline.get_bind_group_layout(0),
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: tlas.as_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: inputs.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 2,
                resource: output.as_entire_binding(),
            },
        ],
    });
    let mut encoder = device.create_command_encoder(&Default::default());
    encoder.build_acceleration_structures([build], std::iter::empty::<&wgpu::Tlas>());
    let submission = queue.submit([encoder.finish()]);
    device.poll(wgpu::PollType::Wait {
        submission_index: Some(submission),
        timeout: Some(Duration::from_secs(30)),
    })?;
    let mut encoder = device.create_command_encoder(&Default::default());
    encoder.build_acceleration_structures(std::iter::empty::<&wgpu::BlasBuildEntry<'_>>(), [tlas]);
    {
        let mut pass = encoder.begin_compute_pass(&Default::default());
        pass.set_pipeline(&pipeline);
        pass.set_bind_group(0, &group, &[]);
        pass.dispatch_workgroups(rays.len() as u32, 1, 1);
    }
    encoder.copy_buffer_to_buffer(&output, 0, &readback, 0, length);
    queue.submit([encoder.finish()]);
    let (tx, rx) = mpsc::channel();
    readback.slice(..).map_async(wgpu::MapMode::Read, move |r| {
        let _ = tx.send(r);
    });
    device.poll(wgpu::PollType::Wait {
        submission_index: None,
        timeout: Some(Duration::from_secs(30)),
    })?;
    rx.recv_timeout(Duration::from_secs(5))??;
    let mapped = readback.slice(..).get_mapped_range()?;
    Ok(mapped
        .chunks_exact(48)
        .map(|row| {
            row.chunks_exact(4)
                .map(|b| f32::from_le_bytes(b.try_into().unwrap()))
                .collect()
        })
        .collect())
}
#[cfg(target_os = "macos")]
fn memory_estimates(device: &wgpu::Device) -> serde_json::Value {
    use wgpu::hal::{
        AccelerationStructureEntries as Entries, AccelerationStructureInstances as Instances,
        AccelerationStructureTriangles as Triangles, Device as _,
        GetAccelerationStructureBuildSizesDescriptor as Desc,
    };
    // Metal's descriptor conversion requires a real buffer even for size queries.
    // Keep it and both HAL guards alive; no AS is built or buffer read here.
    let Some(hal) = (unsafe { device.as_hal::<wgpu::hal::api::Metal>() }) else {
        return serde_json::Value::Null;
    };
    let sizing_buffer = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("AS size-query backing buffer"),
        size: 262267 * 3 * 12,
        usage: wgpu::BufferUsages::BLAS_INPUT,
        mapped_at_creation: false,
    });
    let Some(buffer) = (unsafe { sizing_buffer.as_hal::<wgpu::hal::api::Metal>() }) else {
        return serde_json::Value::Null;
    };
    let flags = wgpu::AccelerationStructureFlags::PREFER_FAST_TRACE;
    let mut rows = Vec::new();
    for count in [1, 4096, 65536, 262267] {
        let geometry: Entries<'_, wgpu::hal::metal::Buffer> = Entries::Triangles(vec![Triangles {
            vertex_buffer: Some(&*buffer),
            vertex_format: wgpu::VertexFormat::Float32x3,
            first_vertex: 0,
            vertex_count: count * 3,
            vertex_stride: 12,
            indices: None,
            transform: None,
            flags: wgpu::AccelerationStructureGeometryFlags::OPAQUE,
        }]);
        let size = unsafe {
            hal.get_acceleration_structure_build_sizes(&Desc {
                entries: &geometry,
                flags,
            })
        };
        rows.push(serde_json::json!({"kind":"blas","primitives":count,"bytes":size.acceleration_structure_size,"buildScratchBytes":size.build_scratch_size,"updateScratchBytes":size.update_scratch_size}));
    }
    for count in [1, 103, 4096] {
        let entries: Entries<'_, wgpu::hal::metal::Buffer> = Entries::Instances(Instances {
            buffer: Some(&*buffer),
            offset: 0,
            count,
        });
        let size = unsafe {
            hal.get_acceleration_structure_build_sizes(&Desc {
                entries: &entries,
                flags,
            })
        };
        rows.push(serde_json::json!({"kind":"tlas","instances":count,"bytes":size.acceleration_structure_size,"buildScratchBytes":size.build_scratch_size}));
    }
    serde_json::json!(rows)
}
#[cfg(not(target_os = "macos"))]
fn memory_estimates(_device: &wgpu::Device) -> serde_json::Value {
    serde_json::Value::Null
}
