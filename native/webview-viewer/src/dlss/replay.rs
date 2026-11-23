//! Freeze the inputs of one offscreen target and replay the production NGX passes.
use super::{Dlss, SpecularGuide, Target};
use anyhow::{Context, Result, ensure};
use mutracer_native::api::TemporalGuide as Guide;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    time::Duration,
};

pub(super) const GUIDE_KINDS: [Guide; 7] = [
    Guide::NoisyColor,
    Guide::DiffuseAlbedo,
    Guide::SpecularAlbedo,
    Guide::NormalRoughness,
    Guide::LinearDepth,
    Guide::Motion,
    Guide::Validity,
];
const GUIDE_FORMATS: [wgpu::TextureFormat; 8] = [
    wgpu::TextureFormat::Rgba32Float,
    wgpu::TextureFormat::Rgba32Float,
    wgpu::TextureFormat::Rgba32Float,
    wgpu::TextureFormat::Rgba32Float,
    wgpu::TextureFormat::R32Float,
    wgpu::TextureFormat::Rg32Float,
    wgpu::TextureFormat::R32Uint,
    wgpu::TextureFormat::Rgba32Float, // Optional specular reflection record.
];
const CAPTURE_VERSION: u32 = 1;

#[derive(Clone, Copy, Deserialize, Serialize)]
pub(super) struct FrameParameters {
    pub reset: bool,
    pub stationary: bool,
    pub orthographic: bool,
    pub jitter: [f32; 2],
    pub delta_ms: f32,
    pub view: [f32; 16],
    pub projection: [f32; 16],
    pub projection_inverse: [f32; 16],
    pub view_inverse: [f32; 16],
    pub previous_view_projection: [f32; 16],
}
pub(super) struct Evaluation<'a> {
    pub params: &'a FrameParameters,
    pub inputs: [&'a wgpu::Texture; GUIDE_KINDS.len()],
    pub specular: Option<&'a wgpu::Texture>,
    pub color: &'a wgpu::Buffer,
    pub albedo: &'a wgpu::Buffer,
}

#[derive(Deserialize, Serialize)]
struct Manifest {
    version: u32,
    input_size: [u32; 2],
    output_size: [u32; 2],
    frames: u64,
    adapter: serde_json::Value,
}
#[derive(Deserialize, Serialize)]
struct FrameHeader {
    params: FrameParameters,
    specular: bool,
}
#[derive(Clone, Copy)]
struct Region {
    offset: u64,
    size: u64,
}
impl Region {
    fn read(self, data: &[u8]) -> &[u8] {
        &data[self.offset as usize..(self.offset + self.size) as usize]
    }
}
struct Layout {
    guides: Vec<(Region, u32)>,
    color: Region,
    albedo: Region,
    output: Region,
    bytes: u64,
}
impl Layout {
    fn new(input_size: [u32; 2], output_size: [u32; 2], specular: bool) -> Self {
        let mut bytes = 0;
        let mut region = |size| {
            let offset = bytes;
            bytes += size;
            Region { offset, size }
        };
        let guides = GUIDE_FORMATS[..GUIDE_KINDS.len() + usize::from(specular)]
            .iter()
            .map(|format| {
                let row = input_size[0] * format.block_copy_size(None).unwrap();
                let align = wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;
                let stride = row.div_ceil(align) * align;
                (region(u64::from(stride) * u64::from(input_size[1])), stride)
            })
            .collect();
        let color = region(rgba_bytes(input_size));
        let albedo = region(rgba_bytes(input_size));
        let output = region(rgba_bytes(output_size));
        Self {
            guides,
            color,
            albedo,
            output,
            bytes,
        }
    }
}
fn rgba_bytes([width, height]: [u32; 2]) -> u64 {
    u64::from(width) * u64::from(height) * 16
}

pub(super) struct Capture(PathBuf);
pub(super) struct PendingCapture {
    header: Vec<u8>,
    readback: wgpu::Buffer,
}
impl Capture {
    pub(super) fn new(path: impl Into<PathBuf>) -> Result<Self> {
        let path = path.into();
        new_directory(&path)?;
        Ok(Self(path))
    }
    pub(super) fn record(
        &self,
        device: &wgpu::Device,
        target: &Target,
        evaluation: &Evaluation<'_>,
        result: &wgpu::Buffer,
        commands: &mut Vec<wgpu::CommandBuffer>,
    ) -> Result<PendingCapture> {
        let specular = evaluation.specular.is_some();
        let header = serde_json::to_vec(&FrameHeader {
            params: *evaluation.params,
            specular,
        })?;
        let layout = Layout::new(target.size, target.output_size, specular);
        ensure!(
            layout.bytes <= device.limits().max_buffer_size,
            "DLSS capture exceeds GPU buffer limit"
        );
        let readback = readback(device, layout.bytes);
        let mut copy = device.create_command_encoder(&Default::default());
        for (guide, (region, stride)) in evaluation
            .inputs
            .into_iter()
            .chain(evaluation.specular)
            .zip(layout.guides)
        {
            copy.copy_texture_to_buffer(
                guide.as_image_copy(),
                wgpu::TexelCopyBufferInfo {
                    buffer: &readback,
                    layout: wgpu::TexelCopyBufferLayout {
                        offset: region.offset,
                        bytes_per_row: Some(stride),
                        rows_per_image: None,
                    },
                },
                guide.size(),
            );
        }
        for (buffer, region) in [
            (evaluation.color, layout.color),
            (evaluation.albedo, layout.albedo),
            (result, layout.output),
        ] {
            copy.copy_buffer_to_buffer(buffer, 0, &readback, region.offset, region.size);
        }
        commands.push(copy.finish());
        Ok(PendingCapture { header, readback })
    }
    pub(super) fn save(
        &self,
        device: &wgpu::Device,
        index: u64,
        pending: PendingCapture,
    ) -> Result<()> {
        save_readback(
            device,
            &pending.readback,
            &frame_path(&self.0, index, "bin"),
        )?;
        fs::write(frame_path(&self.0, index, "json"), pending.header)?;
        Ok(())
    }
    pub(super) fn finish(
        &self,
        filter: &Dlss,
        input_size: [u32; 2],
        output_size: [u32; 2],
        frames: u64,
    ) -> Result<()> {
        fs::write(
            self.0.join("capture.json"),
            serde_json::to_vec_pretty(&Manifest {
                version: CAPTURE_VERSION,
                input_size,
                output_size,
                frames,
                adapter: configuration(filter),
            })?,
        )?;
        Ok(())
    }
}

fn frame_path(dir: &Path, index: u64, extension: &str) -> PathBuf {
    dir.join(format!("{index:04}.{extension}"))
}
fn new_directory(dir: &Path) -> Result<()> {
    fs::create_dir_all(dir)?;
    ensure!(
        dir.read_dir()?.next().is_none(),
        "Expected an empty directory at {}",
        dir.display()
    );
    Ok(())
}
fn readback(device: &wgpu::Device, size: u64) -> wgpu::Buffer {
    device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("NGX replay readback"),
        size,
        usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    })
}
fn map_read(device: &wgpu::Device, buffer: &wgpu::Buffer) -> Result<()> {
    let (send, receive) = std::sync::mpsc::channel();
    buffer.map_async(wgpu::MapMode::Read, .., move |result| {
        let _ = send.send(result);
    });
    device.poll(wgpu::PollType::Wait {
        submission_index: None,
        timeout: Some(Duration::from_secs(30)),
    })?;
    receive.recv_timeout(Duration::from_secs(1))??;
    Ok(())
}
fn save_readback(device: &wgpu::Device, buffer: &wgpu::Buffer, path: &Path) -> Result<()> {
    map_read(device, buffer)?;
    let result = fs::write(path, &*buffer.get_mapped_range(..)?);
    buffer.unmap();
    result.with_context(|| format!("Writing {}", path.display()))
}

fn configuration(filter: &Dlss) -> serde_json::Value {
    let gpu = filter.runtime.gpu.adapter.get_info();
    serde_json::json!({
        "sdk": super::SDK_VERSION,
        "device": gpu.name,
        "driver": gpu.driver_info,
        "preset": filter.preset,
        "materialMapping": filter.material_guide.as_ref().map(|g| format!("{:?}", g.mapping)),
        "specular": format!("{:?}", filter.optical.as_ref().map_or(SpecularGuide::Off, |g| g.kind)),
        "inputSamples": filter.input_samples,
    })
}

pub fn run(input: &Path, output: &Path) -> Result<()> {
    let manifest: Manifest = serde_json::from_slice(&fs::read(input.join("capture.json"))?)?;
    ensure!(
        manifest.version == CAPTURE_VERSION,
        "Unsupported DLSS capture version"
    );
    ensure!(manifest.frames > 0, "Empty DLSS capture");
    new_directory(output)?;
    let exe = std::env::current_exe()?;
    let filter = Dlss::new(exe.parent().context("App directory")?)?;
    let (_, _, device, queue) = filter.device();
    let size = manifest.input_size;
    let output_size = manifest.output_size;
    let limits = device.limits();
    ensure!(
        valid_extents(size, output_size, &limits),
        "Unsupported DLSS capture extents"
    );
    let (target, create) = filter.target(size, output_size, 0)?;
    queue.submit([create]);
    let mut comparisons = Vec::new();
    for index in 0..manifest.frames {
        comparisons.push(
            replay_frame(input, output, index, &filter, &target)
                .with_context(|| format!("Replaying DLSS frame {index}"))?,
        );
    }
    fs::write(
        output.join("replay.json"),
        serde_json::to_vec_pretty(&serde_json::json!({
            "size": size, "outputSize": output_size,
            "captureAdapter": manifest.adapter, "replayAdapter": configuration(&filter), "frames": comparisons,
        }))?,
    )?;
    Ok(())
}

fn valid_extents(size: [u32; 2], output_size: [u32; 2], limits: &wgpu::Limits) -> bool {
    !size.contains(&0)
        && [1, 2]
            .into_iter()
            .any(|scale| size.map(|n| n.checked_mul(scale)) == output_size.map(Some))
        && output_size
            .into_iter()
            .all(|side| side <= limits.max_texture_dimension_2d)
        && rgba_bytes(output_size) <= u64::from(limits.max_storage_buffer_binding_size)
}
fn replay_frame(
    input: &Path,
    output: &Path,
    index: u64,
    filter: &Dlss,
    target: &Target,
) -> Result<serde_json::Value> {
    let gpu = &filter.runtime.gpu;
    let device = &gpu.device;
    let queue = &gpu.queue;
    let header: FrameHeader = serde_json::from_slice(&fs::read(frame_path(input, index, "json"))?)?;
    ensure!(
        index != 0 || header.params.reset,
        "First replay frame must reset SDK history"
    );
    let layout = Layout::new(target.size, target.output_size, header.specular);
    ensure!(
        layout.bytes <= device.limits().max_buffer_size,
        "DLSS capture exceeds GPU buffer limit"
    );
    let path = frame_path(input, index, "bin");
    ensure!(
        fs::metadata(&path)?.len() == layout.bytes,
        "Invalid DLSS frame byte count"
    );
    let data = fs::read(path)?;

    let extent = wgpu::Extent3d {
        width: target.size[0],
        height: target.size[1],
        depth_or_array_layers: 1,
    };
    let guides: Vec<_> = layout
        .guides
        .iter()
        .zip(GUIDE_FORMATS)
        .map(|(&(region, stride), format)| {
            let texture = device.create_texture(&wgpu::TextureDescriptor {
                label: Some("NGX replay guide"),
                size: extent,
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format,
                usage: wgpu::TextureUsages::COPY_DST | wgpu::TextureUsages::TEXTURE_BINDING,
                view_formats: &[],
            });
            queue.write_texture(
                texture.as_image_copy(),
                region.read(&data),
                wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(stride),
                    rows_per_image: None,
                },
                extent,
            );
            texture
        })
        .collect();
    let upload = |region: Region| {
        use wgpu::util::DeviceExt;
        device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("NGX replay raw input"),
            contents: region.read(&data),
            usage: wgpu::BufferUsages::STORAGE,
        })
    };
    let evaluation = Evaluation {
        params: &header.params,
        inputs: std::array::from_fn(|i| &guides[i]),
        specular: guides.get(GUIDE_KINDS.len()),
        color: &upload(layout.color),
        albedo: &upload(layout.albedo),
    };
    let scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
    let encoded = filter.encode(target, &evaluation, false)?;
    let result = readback(device, layout.output.size);
    let mut copy = device.create_command_encoder(&Default::default());
    copy.copy_buffer_to_buffer(&encoded.output, 0, &result, 0, layout.output.size);
    queue.submit(encoded.commands.into_iter().chain([copy.finish()]));
    if let Some(error) = pollster::block_on(scope.pop()) {
        anyhow::bail!("{error}");
    }
    map_read(device, &result)?;
    let mapped = result.get_mapped_range(..)?;
    let expected = layout.output.read(&data);
    let different_pixels = expected
        .chunks_exact(16)
        .zip(mapped.chunks_exact(16))
        .filter(|(a, b)| a != b)
        .count();
    fs::write(frame_path(output, index, "rgba32f"), &*mapped)?;
    drop(mapped);
    result.unmap();
    Ok(serde_json::json!({
        "index": index, "reset": header.params.reset,
        "specularGuide": format!("{:?}", encoded.guide), "differentPixels": different_pixels,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replay_accepts_only_supported_nonzero_capture_extents() {
        let limits = wgpu::Limits::default();
        assert!(valid_extents([301, 227], [301, 227], &limits));
        assert!(valid_extents([301, 227], [602, 454], &limits));
        assert!(!valid_extents([0, 227], [0, 227], &limits));
        assert!(!valid_extents([301, 227], [602, 227], &limits));
        assert!(!valid_extents([u32::MAX, u32::MAX], [1, 1], &limits));
    }

    #[test]
    fn frame_layout_keeps_padded_guides_and_scaled_output_separate() {
        let size = [17, 2];
        let layout = Layout::new(size, [34, 4], true);
        assert_eq!(layout.guides.len(), 8);
        assert_eq!(layout.guides[0].1, 512);
        assert_eq!(layout.guides[4].1, 256);
        let mut end = 0;
        for region in layout.guides.iter().map(|&(region, _)| region).chain([
            layout.color,
            layout.albedo,
            layout.output,
        ]) {
            assert_eq!(region.offset, end);
            end += region.size;
        }
        assert_eq!(layout.color.size, 17 * 2 * 16);
        assert_eq!(layout.output.size, 34 * 4 * 16);
        assert_eq!(layout.bytes, end);
        let without_specular = Layout::new(size, [34, 4], false);
        assert_eq!(layout.bytes - without_specular.bytes, 1024);
    }
}
