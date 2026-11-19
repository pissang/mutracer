use crate::error::{Error, Result};
use image::{DynamicImage, RgbaImage};
use std::{
    fs, io,
    path::{Path, PathBuf},
};

#[cfg(target_os = "macos")]
#[path = "encode_macos.rs"]
mod macos;

#[derive(Clone, Copy)]
pub struct Rate {
    pub fps: u32,
    pub stride: u32,
}

impl Rate {
    fn validate(self) -> Result<()> {
        if !(1..=240).contains(&self.fps) || !(1..=2).contains(&self.stride) {
            return Err(Error::validation(
                "/fps",
                "Expected fps in 1 to 240",
                "Specify a supported frame rate.",
            ));
        }
        Ok(())
    }
}

pub fn failure(message: impl Into<String>) -> Error {
    Error::at(
        3,
        "/output",
        message,
        "Check frame files, encoder availability and output permissions.",
    )
}

pub fn sequence(directory: &Path) -> Result<Vec<PathBuf>> {
    numbered_images(directory, "png")
}

pub fn numbered_images(directory: &Path, extension: &str) -> Result<Vec<PathBuf>> {
    let mut frames = Vec::new();
    for entry in fs::read_dir(directory).map_err(|e| failure(e.to_string()))? {
        let path = entry.map_err(|e| failure(e.to_string()))?.path();
        if path
            .extension()
            .and_then(|s| s.to_str())
            .is_none_or(|s| !s.eq_ignore_ascii_case(extension))
        {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        let suffix = stem.trim_end_matches(|c: char| c.is_ascii_digit());
        if let Ok(index) = stem[suffix.len()..].parse::<u32>() {
            frames.push((index, path));
        }
    }
    frames.sort_unstable_by_key(|(index, _)| *index);
    if frames.is_empty() || frames.windows(2).any(|a| a[0].0 == a[1].0) {
        return Err(failure(format!(
            "Expected numbered {extension} images with unique indices"
        )));
    }
    Ok(frames.into_iter().map(|(_, p)| p).collect())
}

pub fn load_frame(path: &Path) -> Result<DynamicImage> {
    image::ImageReader::open(path)
        .map_err(|e| failure(format!("{}: {e}", path.display())))?
        .decode()
        .map_err(|e| failure(format!("{}: {e}", path.display())))
}

pub fn encode(frames: &[PathBuf], dest: &Path, rate: Rate) -> Result<bool> {
    rate.validate()?;
    let first = frames
        .first()
        .ok_or_else(|| failure("No PNG frames to encode"))?;
    let dimensions = image::ImageReader::open(first)
        .map_err(|e| failure(e.to_string()))?
        .into_dimensions()
        .map_err(|e| failure(e.to_string()))?;
    let size = [dimensions.0, dimensions.1];
    if size.iter().any(|&edge| edge < 2 || edge % 2 != 0) {
        return Err(Error::validation(
            "/output/size",
            "MP4 encoding requires even dimensions of at least 2",
            "Use an even size or request PNG frames.",
        ));
    }
    let absolute = std::path::absolute(dest).map_err(|e| failure(e.to_string()))?;
    let temporary = absolute.with_extension(format!("{}.tmp.mp4", std::process::id()));
    let _ = fs::remove_file(&temporary);
    let result = platform_encode(frames, &temporary, size, rate);
    match result {
        Ok(true) => {
            fs::rename(&temporary, absolute).map_err(|e| failure(e.to_string()))?;
            Ok(true)
        }
        other => {
            let _ = fs::remove_file(temporary);
            other
        }
    }
}

fn platform_encode(frames: &[PathBuf], path: &Path, size: [u32; 2], rate: Rate) -> Result<bool> {
    #[cfg(target_os = "macos")]
    return macos::encode(frames, path, size, rate).map(|()| true);
    #[cfg(not(target_os = "macos"))]
    return ffmpeg(frames, path, size, rate);
}

#[cfg(not(target_os = "macos"))]
fn ffmpeg(frames: &[PathBuf], path: &Path, [width, height]: [u32; 2], rate: Rate) -> Result<bool> {
    use image::GenericImageView;
    use std::{
        io::Write,
        process::{Command, Stdio},
    };
    let mut child = match Command::new("ffmpeg")
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-nostdin",
            "-y",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgba",
            "-video_size",
            &format!("{width}x{height}"),
            "-framerate",
            &format!("{}/{}", rate.fps, rate.stride),
            "-i",
            "pipe:0",
            "-an",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
        ])
        .arg(path)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .spawn()
    {
        Ok(child) => child,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(failure(error.to_string())),
    };
    let mut stdin = child.stdin.take().unwrap();
    let result = (|| {
        for path in frames {
            let frame = load_frame(path)?;
            if frame.dimensions() != (width, height) {
                return Err(failure(format!("{} has a different size", path.display())));
            }
            stdin
                .write_all(&frame.into_rgba8().into_raw())
                .map_err(|e| failure(e.to_string()))?;
        }
        Ok(())
    })();
    drop(stdin);
    if result.is_err() {
        let _ = child.kill();
    }
    let status = child.wait().map_err(|e| failure(e.to_string()))?;
    result?;
    if !status.success() {
        return Err(failure(format!("ffmpeg exited with {status}")));
    }
    Ok(true)
}

pub fn atomic_bytes(
    dest: &Path,
    write: impl FnOnce(&mut fs::File) -> io::Result<()>,
) -> io::Result<()> {
    let temporary = dest.with_extension(format!("{}.tmp", std::process::id()));
    let result = (|| {
        let mut file = fs::File::create(&temporary)?;
        write(&mut file)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, dest)
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

pub fn contact_sheet(frames: &[PathBuf], dest: &Path) -> Result<()> {
    let count = frames.len().min(16);
    if count == 0 {
        return Err(failure("No PNGs for contact sheet"));
    }
    let grid = count.min(4) as u32;
    let [tile_w, tile_h] = [320, 192];
    let mut sheet = RgbaImage::from_pixel(
        grid * tile_w,
        (count as u32).div_ceil(grid) * tile_h,
        image::Rgba([24, 24, 24, 255]),
    );
    for i in 0..count {
        let index = i * (frames.len() - 1) / (count - 1).max(1);
        let frame = load_frame(&frames[index])?
            .thumbnail(tile_w, tile_h)
            .into_rgba8();
        let x = (i as u32 % grid) * tile_w + (tile_w - frame.width()) / 2;
        let y = (i as u32 / grid) * tile_h + (tile_h - frame.height()) / 2;
        image::imageops::overlay(&mut sheet, &frame, i64::from(x), i64::from(y));
    }
    atomic_bytes(dest, |file| {
        sheet
            .write_to(file, image::ImageFormat::Png)
            .map_err(io::Error::other)
    })
    .map_err(|e| failure(e.to_string()))
}
