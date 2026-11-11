//! Indexed scene adapters for the native viewer.
pub use super::descriptor::Descriptor;
pub use super::encoder::{Environment, Material, Mesh, SceneData, Texture, material_values};
pub use super::gltf::{Animation, Clip, Model};

// Create the viewer's shared device through the SDK's Metal queue observer too.
// A plain adapter.request_device + Engine::on_device cannot see execution errors.
pub fn request_device(
    adapter: &wgpu::Adapter,
    descriptor: &wgpu::DeviceDescriptor<'_>,
) -> crate::api::Result<(wgpu::Device, wgpu::Queue)> {
    crate::native_completion::request_device(adapter, descriptor)
        .map_err(|e| crate::api::error(crate::api::Status::Unavailable, e.to_string()))
}
