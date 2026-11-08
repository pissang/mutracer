use super::*;

// A slow BLAS and a tiny BLAS exercise mixed build durations. Both instances
// must be traversable on the first query; this does not reproduce the known
// intermittent whole-dispatch miss reliably.
#[test]
#[ignore = "requires a real GPU; run npm run native:ci:gpu"]
fn large_and_small_blas_complete_before_tlas_encoding() {
    let _test = crate::abi_test_lock();
    let gpu = crate::GpuDevice::with_backend(1).expect("GPU validation requires a working device");
    assert!(gpu.hardware_ray_query, "GPU validation requires HWRT");
    let triangles = 512 * 512;
    let mut positions = Vec::<f32>::with_capacity(triangles * 9);
    for y in 0..512 {
        for x in 0..512 {
            let x = 100. + x as f32;
            let y = y as f32;
            positions.extend_from_slice(&[x, y, 0., x + 0.8, y, 0., x, y + 0.8, 0.]);
        }
    }
    let bytes = |v: &[f32]| v.iter().flat_map(|v| v.to_le_bytes()).collect::<Vec<_>>();
    let indices = |count: usize| {
        (0..count as u32)
            .flat_map(|v| v.to_le_bytes())
            .collect::<Vec<_>>()
    };
    let assets = HashMap::from([
        (AssetId::Diagnostic(100), bytes(&positions)),
        (AssetId::Diagnostic(101), indices(triangles * 3)),
        (
            AssetId::Diagnostic(102),
            bytes(&[0., 0., 0., 0.8, 0., 0., 0., 0.8, 0.]),
        ),
        (AssetId::Diagnostic(103), indices(3)),
        (AssetId::Diagnostic(104), vec![0; 32]),
    ]);
    let transform = [1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0.];
    let capture = Capture {
        eligible: true,
        authoritative: true,
        indexed: false,
        reason: None,
        shader: None,
        geometries: vec![
            Geometry {
                positions: AssetId::Diagnostic(100),
                indices: Some(AssetId::Diagnostic(101)),
                vertex_count: (triangles * 3) as u32,
                index_count: Some((triangles * 3) as u32),
                vertex_stride: 12,
                ..Default::default()
            },
            Geometry {
                positions: AssetId::Diagnostic(102),
                indices: Some(AssetId::Diagnostic(103)),
                vertex_count: 3,
                index_count: Some(3),
                vertex_stride: 12,
                ..Default::default()
            },
        ],
        instances: vec![
            Instance {
                geometry: 0,
                custom_index: 7,
                transform,
            },
            Instance {
                geometry: 1,
                custom_index: 11,
                transform,
            },
        ],
        triangle_map: Some(AssetId::Diagnostic(104)),
    };
    let shader = gpu.device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label:Some("Mixed BLAS completion regression"),
        source:wgpu::ShaderSource::Wgsl(r#"enable wgpu_ray_query;
@group(0) @binding(0) var scene: acceleration_structure;
@group(0) @binding(1) var<storage, read_write> output: array<vec4u>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u) {
 var q:ray_query;
 let x = select(0.25,100.25,id.x<64u);
 rayQueryInitialize(&q,scene,RayDesc(0u,255u,0.001,10.0,vec3f(x,0.25,3.0),vec3f(0.0,0.0,-1.0)));
 while rayQueryProceed(&q) { let c=rayQueryGetCandidateIntersection(&q); if(c.kind==RAY_QUERY_INTERSECTION_TRIANGLE){rayQueryConfirmIntersection(&q);} }
 let h=rayQueryGetCommittedIntersection(&q);
 output[id.x]=vec4u(h.kind,h.instance_custom_data,bitcast<u32>(h.t),h.primitive_index);
}"#.into()),
    });
    let pipeline = gpu
        .device
        .create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: None,
            layout: None,
            module: &shader,
            entry_point: Some("main"),
            compilation_options: Default::default(),
            cache: None,
        });
    for iteration in 0..8 {
        let resources = prepare(&gpu.device, &gpu.queue, &capture, &assets, None).unwrap();
        let output = gpu
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("Mixed BLAS hit sentinel"),
                contents: &vec![255; 128 * 16],
                usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
            });
        let group = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: None,
            layout: &pipeline.get_bind_group_layout(0),
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: resources.tlas.as_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: output.as_entire_binding(),
                },
            ],
        });
        let mut encoder = gpu.device.create_command_encoder(&Default::default());
        {
            let mut pass = encoder.begin_compute_pass(&Default::default());
            pass.set_pipeline(&pipeline);
            pass.set_bind_group(0, &group, &[]);
            pass.dispatch_workgroups(2, 1, 1);
        }
        gpu.queue.submit([encoder.finish()]);
        let hits = crate::hit_diagnostics::read_raw(&gpu, &output).unwrap();
        for (i, hit) in hits.chunks_exact(16).enumerate() {
            let values: [u32; 4] = std::array::from_fn(|k| {
                u32::from_le_bytes(hit[k * 4..k * 4 + 4].try_into().unwrap())
            });
            assert_eq!(
                [values[0], values[1], values[3]],
                [1, if i < 64 { 7 } else { 11 }, 0],
                "iteration={iteration}, ray={i}"
            );
            // Keep hit identity exact while allowing ray-query distance rounding.
            let distance = f32::from_bits(values[2]);
            assert!(
                (distance - 3.).abs() <= 1e-6,
                "iteration={iteration}, ray={i}, distance={distance:?}"
            );
        }
    }
}
