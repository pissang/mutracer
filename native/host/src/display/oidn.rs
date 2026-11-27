//! Browser-style OIDN input composition and display-linear presentation.
use super::{Display, Settings, effects::Effects, image};
use crate::{Result, postprocess};

pub(super) struct Filter {
    composed: wgpu::Texture,
    albedo: wgpu::Texture,
    encode: wgpu::ComputePipeline,
    collect: wgpu::ComputePipeline,
    hdr_encode: std::sync::OnceLock<wgpu::ComputePipeline>,
    pub(super) result: Option<(wgpu::Buffer, Settings)>,
}
impl Filter {
    fn new(display: &Display) -> Result<Self> {
        let device = &display.gpu.device;
        let source = &postprocess::sources()?.oidn_display;
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("OIDN display transfer"),
            source: wgpu::ShaderSource::Wgsl(source.as_str().into()),
        });
        Ok(Self {
            composed: image(device, display.size, wgpu::TextureFormat::Rgba32Float),
            albedo: image(device, display.size, wgpu::TextureFormat::Rgba32Float),
            encode: device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: Some("OIDN display transfer"),
                layout: None,
                module: &module,
                entry_point: Some("present"),
                compilation_options: Default::default(),
                cache: None,
            }),
            collect: device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: Some("Collect OIDN display-linear output"),
                layout: None,
                module: &module,
                entry_point: Some("collect"),
                compilation_options: Default::default(),
                cache: None,
            }),
            hdr_encode: Default::default(),
            result: None,
        })
    }
    pub(super) fn present(
        &self,
        display: &Display,
        settings: &Settings,
        premultiply: bool,
        target: &wgpu::Texture,
    ) -> bool {
        let Some((pixels, key)) = &self.result else {
            return false;
        };
        if settings != key || !display.using_denoised || !matches!(settings.output, 0 | 3) {
            return false;
        }
        let device = &display.gpu.device;
        let params = super::effects::uniform(
            device,
            &[
                display.size[0],
                display.size[1],
                if target.format() == wgpu::TextureFormat::Rgba16Float {
                    u32::from(premultiply)
                } else {
                    0
                },
                u32::from(settings.preserve_alpha) | (u32::from(premultiply) << 1),
            ],
        );
        let hdr = target.format() == wgpu::TextureFormat::Rgba16Float;
        let pipeline = if hdr {
            self.hdr_encode.get_or_init(|| super::hdr_transfer(device))
        } else {
            &self.encode
        };
        let view = target.create_view(&Default::default());
        let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("OIDN display bindings"),
            layout: &pipeline.get_bind_group_layout(0),
            entries: &[
                wgpu::BindGroupEntry {
                    binding: if hdr { 1 } else { 0 },
                    resource: pixels.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: if hdr { 2 } else { 1 },
                    resource: wgpu::BindingResource::TextureView(&view),
                },
                wgpu::BindGroupEntry {
                    binding: if hdr { 0 } else { 2 },
                    resource: params.as_entire_binding(),
                },
            ],
        });
        let mut encoder = device.create_command_encoder(&Default::default());
        {
            let mut pass = encoder.begin_compute_pass(&Default::default());
            pass.set_pipeline(pipeline);
            pass.set_bind_group(0, &group, &[]);
            pass.dispatch_workgroups(display.size[0].div_ceil(8), display.size[1].div_ceil(8), 1);
        }
        display.gpu.queue.submit([encoder.finish()]);
        true
    }
}
impl Display {
    pub(crate) fn oidn_display_inputs(
        &mut self,
        settings: &Settings,
    ) -> Result<[wgpu::Texture; 2]> {
        if self.oidn.is_none() {
            self.oidn = Some(Filter::new(self)?);
        }
        let sources = &postprocess::sources()?.oidn_composition;
        // Progressive filtering always snapshots raw composition, never its previous output.
        let shown = self.using_denoised;
        self.using_denoised = false;
        let mut effects = self.effects.lock().unwrap_or_else(|e| e.into_inner());
        let effects = effects.get_or_insert_with(|| Effects::new(&self.gpu.device));
        effects.prepare_composition(&self.gpu.device, sources, false);
        let filter = self.oidn.as_ref().unwrap();
        effects.compose(self, settings, false, &filter.composed);
        effects.compose_guide(self, settings, &filter.albedo);
        self.using_denoised = shown;
        Ok([filter.composed.clone(), filter.albedo.clone()])
    }
    pub(crate) fn compose_oidn_output(
        &mut self,
        settings: &Settings,
        preview: &wgpu::Buffer,
        target: &wgpu::Buffer,
    ) -> Result<()> {
        if self.oidn.is_none() {
            self.oidn = Some(Filter::new(self)?);
        }
        // The offline frame keeps its capture only for this composition.
        // Use the same coverage and layers without retaining a viewer snapshot.
        let mut resolved = self.gpu.device.create_command_encoder(&Default::default());
        resolved.copy_buffer_to_buffer(preview, 0, &self.linear, 0, self.linear.size());
        self.gpu.queue.submit([resolved.finish()]);
        self.samples = 1;
        self.using_denoised = true;
        self.denoise_revision += 1;
        let filter = self.oidn.as_ref().unwrap();
        let device = &self.gpu.device;
        let mut effects = self.effects.lock().unwrap_or_else(|e| e.into_inner());
        let effects = effects.get_or_insert_with(|| Effects::new(device));
        effects.prepare_composition(device, &postprocess::sources()?.oidn_composition, false);
        effects.compose(self, settings, false, &filter.composed);
        let view = filter.composed.create_view(&Default::default());
        let inputs = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Collect OIDN display-linear output"),
            layout: &filter.collect.get_bind_group_layout(0),
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(&view),
                },
                wgpu::BindGroupEntry {
                    binding: 4,
                    resource: target.as_entire_binding(),
                },
            ],
        });
        let mut encoder = device.create_command_encoder(&Default::default());
        {
            let mut pass = encoder.begin_compute_pass(&Default::default());
            pass.set_pipeline(&filter.collect);
            pass.set_bind_group(0, &inputs, &[]);
            pass.dispatch_workgroups(self.size[0].div_ceil(8), self.size[1].div_ceil(8), 1);
        }
        self.gpu.queue.submit([encoder.finish()]);
        Ok(())
    }
    pub(crate) fn upload_display_oidn(
        &mut self,
        pixels: &wgpu::Buffer,
        settings: Settings,
    ) -> Result<()> {
        if self.oidn.is_none() {
            self.oidn = Some(Filter::new(self)?);
        }
        self.oidn.as_mut().unwrap().result = Some((pixels.clone(), settings));
        self.using_denoised = true;
        self.denoise_revision += 1;
        self.image_revision += 1;
        Ok(())
    }
    pub(crate) fn oidn_normal(&self) -> &wgpu::Buffer {
        &self.normal
    }
}
