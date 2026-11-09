//! A same-device identity filter through the public custom-denoiser API.
//! Run with a version-4 raw scene descriptor; the final readback is an explicit
//! diagnostic export, not part of filtering or presentation.
use mutracer_native::api::{
    CancelToken, ConvergeOptions, CustomDenoiser, DenoiseInput, DenoiseInputMode, DenoiseOutput,
    DenoiseSchedule, Engine, EngineOptions, PixelKind, Render, RenderSettings,
};
use std::sync::Arc;

struct Identity;
impl CustomDenoiser for Identity {
    fn input_mode(&self) -> DenoiseInputMode {
        DenoiseInputMode::ResidentGpu
    }
    fn denoise(&self, input: DenoiseInput, _: CancelToken) -> Result<DenoiseOutput, String> {
        let frame = input.resident.ok_or("Missing resident GPU inputs")?;
        let color = frame.buffers.color.clone();
        // An SDK adapter can record its native work in separate encoders here.
        // Submit all producer/SDK/consumer buffers through the same frame API.
        frame.submit([], color).map(DenoiseOutput::Resident)
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path = std::env::args()
        .nth(1)
        .ok_or("Expected a raw scene descriptor path")?;
    let scene = std::fs::read(path)?;
    let engine = Engine::new(EngineOptions::default())?;
    engine.display().set_size(256, 192)?;
    engine.set_scene(&scene)?;
    engine.update()?;
    let render = Render::new(&engine, RenderSettings::default())?;
    render.set_custom_denoiser(Some(Arc::new(Identity)), DenoiseSchedule::Converged)?;
    render.converge(ConvergeOptions::new(4))?;
    engine.display().present(&render)?;
    let image = render.read_pixels(PixelKind::Denoised)?;
    println!(
        "{}x{} GPU identity result, {} finite floats",
        image.width,
        image.height,
        image.data.len()
    );
    Ok(())
}
