use crate::{
    encode::{self, Rate},
    error::{Error, Result},
    progress,
};
use ab_glyph::{Font, FontArc, ScaleFont};
use image::{DynamicImage, ImageFormat, Rgba, RgbaImage};
use mutracer_native::api::{self, PixelKind};
use serde::Deserialize;
use serde_json::json;
use std::{
    fs::{self, File},
    io::{self, BufReader, Cursor, Read, Write},
    path::{Path, PathBuf},
};

pub const AOV_MASK: u32 = 32 | 512 | 1024;
const GUIDE_MAGIC: &[u8; 4] = b"MTA1";
const GUIDE_WORDS: u64 = 7;

fn issue(error: impl std::fmt::Display) -> Error {
    encode::failure(error.to_string())
}

pub fn hdr(render: &api::Render) -> Result<Vec<u8>> {
    let hdr = render
        .read_pixels(PixelKind::Denoised)
        .map_err(|e| Error::gpu(e.to_string()))?;
    encode_hdr(hdr)
}
pub fn encode_hdr(hdr: api::Image) -> Result<Vec<u8>> {
    let frame = image::Rgba32FImage::from_raw(hdr.width, hdr.height, hdr.data)
        .ok_or_else(|| Error::gpu("Native HDR data size differs from dimensions"))?;
    let mut output = Cursor::new(Vec::new());
    DynamicImage::ImageRgba32F(frame)
        .write_to(&mut output, ImageFormat::OpenExr)
        .map_err(issue)?;
    Ok(output.into_inner())
}

fn guide_header(file: &mut impl Read) -> io::Result<[u32; 2]> {
    let mut header = [0u8; 12];
    file.read_exact(&mut header)?;
    if &header[..4] != GUIDE_MAGIC {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Invalid AOV guide header",
        ));
    }
    Ok([
        u32::from_le_bytes(header[4..8].try_into().unwrap()),
        u32::from_le_bytes(header[8..12].try_into().unwrap()),
    ])
}

pub fn guide_valid(path: &Path, size: [u32; 2]) -> bool {
    File::open(path).ok().is_some_and(|mut file| {
        let length = file.metadata().ok().map(|m| m.len());
        length == Some(12 + u64::from(size[0]) * u64::from(size[1]) * 4 * GUIDE_WORDS)
            && guide_header(&mut file).ok() == Some(size)
    })
}

pub fn capture_guide(render: &api::Render) -> Result<impl FnOnce(&Path) -> Result<()> + use<>> {
    let read = |kind| {
        render
            .read_pixels(kind)
            .map_err(|e| Error::gpu(e.to_string()))
    };
    let normal = read(PixelKind::CenterNormal)?;
    let depth = read(PixelKind::CenterDepth)?;
    let ids = read(PixelKind::Id)?
        .id_data
        .ok_or_else(|| Error::gpu("Native ID AOV has no integer pixels"))?;
    let size = [normal.width, normal.height];
    if size != [depth.width, depth.height]
        || normal.data.len() != depth.data.len()
        || normal.data.len() != ids.len()
    {
        return Err(Error::gpu("AOV guide dimensions differ"));
    }
    Ok(move |path: &Path| {
        encode::atomic_bytes(path, |file| {
            let mut out = io::BufWriter::new(file);
            out.write_all(GUIDE_MAGIC)?;
            for value in size {
                out.write_all(&value.to_le_bytes())?;
            }
            for ((normal, depth), id) in normal
                .data
                .chunks_exact(4)
                .zip(depth.data.chunks_exact(4))
                .zip(ids.chunks_exact(4))
            {
                for &n in &normal[..3] {
                    out.write_all(&n.to_le_bytes())?;
                }
                out.write_all(&depth[0].to_le_bytes())?;
                for &index in &id[..3] {
                    out.write_all(&index.to_le_bytes())?;
                }
            }
            out.flush()
        })
        .map_err(issue)
    })
}

#[derive(Clone, Copy)]
struct Guide {
    normal: [f32; 3],
    depth: f32,
    identity: [u32; 3],
}
impl Guide {
    fn matches(self, neighbor: Self) -> bool {
        if self.identity[0] == u32::MAX
            || self.identity != neighbor.identity
            || !self.depth.is_finite()
            || !neighbor.depth.is_finite()
            || self.depth <= 0.
            || neighbor.depth <= 0.
        {
            return false;
        }
        (self.depth - neighbor.depth).abs() <= (self.depth * 0.01).max(0.001)
            && self
                .normal
                .into_iter()
                .zip(neighbor.normal)
                .map(|(a, b)| a * b)
                .sum::<f32>()
                >= 0.99
    }
}

struct HdrFrame {
    image: image::Rgba32FImage,
    guides: Vec<Guide>,
}

fn read_hdr(path: &Path) -> Result<HdrFrame> {
    let image = encode::load_frame(path)?.into_rgba32f();
    let size = [image.width(), image.height()];
    crate::shot::check_size(size)?;
    let sidecar = path.with_extension("aov");
    if !guide_valid(&sidecar, size) {
        return Err(Error::asset(
            "/frames",
            format!("Missing or invalid guide {}", sidecar.display()),
        ));
    }
    let mut input = BufReader::new(File::open(sidecar).map_err(issue)?);
    guide_header(&mut input).map_err(issue)?;
    let mut guides = Vec::with_capacity(image.len() / 4);
    for _ in 0..image.len() / 4 {
        let mut bytes = [0; 4 * GUIDE_WORDS as usize];
        input.read_exact(&mut bytes).map_err(issue)?;
        let word = |i: usize| u32::from_le_bytes(bytes[4 * i..4 * i + 4].try_into().unwrap());
        guides.push(Guide {
            normal: std::array::from_fn(|i| f32::from_bits(word(i))),
            depth: f32::from_bits(word(3)),
            identity: std::array::from_fn(|i| word(4 + i)),
        });
    }
    Ok(HdrFrame { image, guides })
}

fn filtered(
    current: &HdrFrame,
    before: Option<&HdrFrame>,
    after: Option<&HdrFrame>,
) -> Result<image::Rgba32FImage> {
    let neighbors = [before, after];
    if neighbors
        .iter()
        .flatten()
        .any(|other| other.image.dimensions() != current.image.dimensions())
    {
        return Err(issue("EXR frame dimensions change within the sequence"));
    }
    let mut output = current.image.clone();
    for (i, pixel) in output.pixels_mut().enumerate() {
        let mut divisor = 1.;
        let original = pixel.0;
        for frame in neighbors.iter().flatten() {
            if current.guides[i].matches(frame.guides[i]) {
                let other = &frame.image.as_raw()[i * 4..i * 4 + 4];
                if other.iter().all(|x| x.is_finite()) && (other[3] - original[3]).abs() < 1e-3 {
                    for c in 0..3 {
                        pixel.0[c] += other[c] * 0.25;
                    }
                    divisor += 0.25;
                }
            }
        }
        for c in 0..3 {
            pixel.0[c] /= divisor;
        }
    }
    Ok(output)
}

fn save_image(path: &Path, image: &DynamicImage, format: ImageFormat) -> Result<()> {
    encode::atomic_bytes(path, |file| {
        image.write_to(file, format).map_err(io::Error::other)
    })
    .map_err(issue)
}

pub fn temporal(source: &Path, output: &Path, png_exposure: Option<f32>) -> Result<()> {
    let frames = encode::numbered_images(source, "exr")?;
    if let Some(ev) = png_exposure {
        if !(-32. ..=32.).contains(&ev) {
            return Err(Error::validation(
                "/png-exposure",
                "Expected -32 to 32 EV",
                "Reduce the exposure multiplier.",
            ));
        }
    }
    fs::create_dir_all(output).map_err(issue)?;
    if source.canonicalize().map_err(issue)? == output.canonicalize().map_err(issue)? {
        return Err(Error::validation(
            "/output",
            "Temporal output must be a separate directory",
            "Choose a new directory for filtered EXRs.",
        ));
    }
    let mut before = None;
    let mut current = read_hdr(&frames[0])?;
    let mut after = frames.get(1).map(|p| read_hdr(p)).transpose()?;
    for (i, path) in frames.iter().enumerate() {
        let result = filtered(&current, before.as_ref(), after.as_ref())?;
        let dest = output.join(path.file_name().unwrap());
        if let Some(ev) = png_exposure {
            let exposure = ev.exp2();
            let srgb = |x: f32| {
                let v = (exposure * x).clamp(0., 1.);
                let y = if v <= 0.0031308 {
                    12.92 * v
                } else {
                    1.055 * v.powf(1. / 2.4) - 0.055
                };
                (255. * y).round() as u8
            };
            let png = RgbaImage::from_fn(result.width(), result.height(), |x, y| {
                let p = result.get_pixel(x, y).0;
                Rgba([
                    srgb(p[0]),
                    srgb(p[1]),
                    srgb(p[2]),
                    (p[3].clamp(0., 1.) * 255.).round() as u8,
                ])
            });
            save_image(
                &dest.with_extension("png"),
                &DynamicImage::ImageRgba8(png),
                ImageFormat::Png,
            )?;
        }
        save_image(
            &dest,
            &DynamicImage::ImageRgba32F(result),
            ImageFormat::OpenExr,
        )?;
        progress(json!({"event":"filtered","frame":i,"path":dest}));
        if let Some(next) = after.take() {
            before = Some(current);
            current = next;
            after = frames.get(i + 2).map(|p| read_hdr(p)).transpose()?;
        }
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Cut {
    fps: u32,
    shots: Vec<Segment>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Segment {
    frames: PathBuf,
    #[serde(default)]
    start: usize,
    count: Option<usize>,
    caption: Option<String>,
}

fn caption_font(path: Option<&Path>) -> Result<FontArc> {
    if let Some(path) = path {
        return FontArc::try_from_vec(fs::read(path).map_err(issue)?).map_err(issue);
    }
    let candidates = [
        "/System/Library/Fonts/SFNS.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "C:\\Windows\\Fonts\\arial.ttf",
    ];
    for path in candidates {
        if let Ok(bytes) = fs::read(path) {
            if let Ok(font) = FontArc::try_from_vec(bytes) {
                return Ok(font);
            }
        }
    }
    Err(Error::validation(
        "/font",
        "No caption font found",
        "Use --font with a local TrueType or OpenType font.",
    ))
}

fn draw_caption(image: &mut RgbaImage, text: &str, font: &FontArc) -> Result<()> {
    let [w, h] = [image.width(), image.height()];
    let px = (h as f32 * 0.04).clamp(11., 48.);
    let inset = (px * 0.9).round() as u32;
    let baseline = h as f32 - inset as f32 - px * 0.25;
    let font = font.as_scaled(px);
    let mut cursor = inset as f32 + px * 0.5;
    let mut glyphs = Vec::new();
    if text.chars().any(|c| c.is_control()) {
        return Err(Error::validation(
            "/caption",
            "Expected a single line of caption text",
            "Remove newlines and control characters.",
        ));
    }
    for c in text.chars() {
        let id = font.glyph_id(c);
        if id.0 == 0 {
            return Err(Error::validation(
                "/caption",
                format!("Font has no glyph for {c:?}"),
                "Choose a font that covers the caption.",
            ));
        }
        glyphs.push(id.with_scale_and_position(px, ab_glyph::point(cursor, baseline)));
        cursor += font.h_advance(id);
    }
    let right = (cursor + px * 0.5).ceil() as u32;
    if right >= w || inset + px.ceil() as u32 >= h {
        return Err(Error::validation(
            "/caption",
            "Caption does not fit within the frame",
            "Shorten the caption or use a larger frame.",
        ));
    }
    let top = (baseline - px).floor().max(0.) as u32;
    for y in top..h - inset / 2 {
        for x in inset..right {
            let p = image.get_pixel_mut(x, y);
            for c in 0..3 {
                p[c] = (f32::from(p[c]) * 0.28) as u8;
            }
        }
    }
    for glyph in glyphs {
        if let Some(outline) = font.outline_glyph(glyph) {
            let rect = outline.px_bounds();
            outline.draw(|x, y, coverage| {
                let x = x as i32 + rect.min.x as i32;
                let y = y as i32 + rect.min.y as i32;
                if x >= 0 && y >= 0 && x < w as i32 && y < h as i32 {
                    let p = image.get_pixel_mut(x as u32, y as u32);
                    for c in 0..3 {
                        p[c] = (f32::from(p[c]) * (1. - coverage) + 255. * coverage).round() as u8;
                    }
                }
            });
        }
    }
    Ok(())
}

pub fn assemble(cut: &Path, output: &Path, font: Option<&Path>) -> Result<()> {
    let data = fs::read(cut).map_err(issue)?;
    if data.len() > 4 * 1024 * 1024 {
        return Err(Error::budget("Cut list exceeds 4 MiB"));
    }
    let edit: Cut = serde_json::from_slice(&data)
        .map_err(|e| Error::validation("", e.to_string(), "Check the cut list fields."))?;
    if edit.shots.is_empty() {
        return Err(Error::validation(
            "/shots",
            "Expected at least one shot",
            "List one or more PNG frame directories.",
        ));
    }
    let fps = edit.fps;
    let font = if edit
        .shots
        .iter()
        .any(|shot| shot.caption.as_ref().is_some_and(|s| !s.is_empty()))
    {
        Some(caption_font(font)?)
    } else {
        None
    };
    let base = cut.parent().unwrap_or(Path::new("."));
    let staging = tempfile::tempdir().map_err(issue)?;
    let mut frames = Vec::new();
    for (i, shot) in edit.shots.into_iter().enumerate() {
        let source = encode::sequence(&base.join(shot.frames))?;
        let length = shot
            .count
            .unwrap_or(source.len().saturating_sub(shot.start));
        let end = shot.start.checked_add(length).unwrap_or(usize::MAX);
        if length == 0 || end > source.len() {
            return Err(Error::validation(
                format!("/shots/{i}"),
                "Shot frame range is empty or outside the sequence",
                "Correct start or count.",
            ));
        }
        if frames.len() + length > crate::shot::MAX_FRAMES as usize {
            return Err(Error::budget("Cut exceeds 100000 frames"));
        }
        for input in &source[shot.start..end] {
            if let Some(text) = shot.caption.as_ref().filter(|s| !s.is_empty()) {
                let mut image = encode::load_frame(input)?.into_rgba8();
                draw_caption(&mut image, text, font.as_ref().unwrap())?;
                let annotated = staging
                    .path()
                    .join(format!("frame_{:06}.png", frames.len()));
                save_image(
                    &annotated,
                    &DynamicImage::ImageRgba8(image),
                    ImageFormat::Png,
                )?;
                frames.push(annotated);
            } else {
                frames.push(input.clone());
            }
        }
    }
    if !encode::encode(&frames, output, Rate { fps, stride: 1 })? {
        return Err(Error::asset(
            "/output",
            "An H.264 encoder is required for assemble",
        ));
    }
    progress(json!({"event":"assembled","path":output,"frames":frames.len()}));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn temporal_filter_blends_matching_surfaces_and_preserves_rejected_pixels_and_alpha() {
        let guide = Guide {
            normal: [0., 0., 1.],
            depth: 2.,
            identity: [11, 0, 5],
        };
        let mut moving = guide;
        moving.depth = 2.1;
        let frame = |a, g| HdrFrame {
            image: image::Rgba32FImage::from_pixel(1, 1, Rgba([a, a, a, 1.])),
            guides: vec![g],
        };
        let current = frame(1., guide);
        let stable = frame(2., guide);
        let moved = frame(4., moving);
        assert_eq!(
            filtered(&current, Some(&stable), Some(&moved))
                .unwrap()
                .get_pixel(0, 0)
                .0,
            [1.2, 1.2, 1.2, 1.]
        );
    }
}
