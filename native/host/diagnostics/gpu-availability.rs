//! Report the adapter without rendering; explicit GPU validation requires hardware.
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    let instance =
        wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle_from_env());
    match pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::HighPerformance,
        force_fallback_adapter: args.iter().any(|arg| arg == "--force-fallback"),
        ..Default::default()
    })) {
        Ok(adapter) => {
            let info = adapter.get_info();
            let hardware = matches!(
                info.device_type,
                wgpu::DeviceType::IntegratedGpu
                    | wgpu::DeviceType::DiscreteGpu
                    | wgpu::DeviceType::VirtualGpu
            );
            let ray_query = adapter
                .features()
                .contains(wgpu::Features::EXPERIMENTAL_RAY_QUERY);
            if args.iter().any(|arg| arg == "--require-hardware") && !hardware {
                return Err(format!(
                    "Real GPU required; found software/unknown adapter: {} ({:?})",
                    info.name, info.device_type
                )
                .into());
            }
            if args.iter().any(|arg| arg == "--require-ray-query") && !ray_query {
                return Err("Full GPU validation requires hardware ray-query support".into());
            }
            // CPU CI records which software adapter the runner exposes without
            // creating a device or submitting GPU work.
            if !args.iter().any(|arg| arg == "--adapter-only") {
                let (device, queue) =
                    pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
                        required_limits: adapter.limits(),
                        ..Default::default()
                    }))?;
                queue.submit([]);
                device.poll(wgpu::PollType::Wait {
                    submission_index: None,
                    timeout: Some(std::time::Duration::from_secs(30)),
                })?;
            }
            println!(
                "{}",
                serde_json::json!({"available":true,"hardware":hardware,"adapter":info.name,"deviceType":format!("{:?}",info.device_type),"backend":format!("{:?}",info.backend),"rayQuery":ray_query})
            );
        }
        Err(wgpu::RequestAdapterError::NotFound { .. }) => {
            if args.iter().any(|arg| arg == "--require-hardware") {
                return Err("Real GPU required; no adapter found".into());
            }
            println!("{{\"available\":false,\"reason\":\"no adapter\"}}")
        }
        Err(error) => return Err(error.into()),
    }
    Ok(())
}
