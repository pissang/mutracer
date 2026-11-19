use super::{Rate, failure, load_frame};
use crate::error::Result;
use image::{GenericImageView, RgbaImage};
use std::{
    os::windows::ffi::OsStrExt,
    path::{Path, PathBuf},
    ptr,
};
use windows::{
    Win32::{
        Media::MediaFoundation::*,
        System::Com::{COINIT_MULTITHREADED, CoInitializeEx, CoUninitialize},
    },
    core::{GUID, PCWSTR},
};

struct Com;
impl Drop for Com {
    fn drop(&mut self) {
        unsafe { CoUninitialize() };
    }
}

struct Foundation;
impl Drop for Foundation {
    fn drop(&mut self) {
        let _ = unsafe { MFShutdown() };
    }
}

fn mf(error: windows::core::Error) -> crate::error::Error {
    failure(format!("Media Foundation: {error}"))
}

fn media_type(
    format: &GUID,
    [width, height]: [u32; 2],
    rate: Rate,
) -> windows::core::Result<IMFMediaType> {
    let pair = |a, b| (u64::from(a) << 32) | u64::from(b);
    // The sink and source use identical frame timing and color metadata.
    unsafe {
        let ty = MFCreateMediaType()?;
        ty.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
        ty.SetGUID(&MF_MT_SUBTYPE, format)?;
        ty.SetUINT64(&MF_MT_FRAME_SIZE, pair(width, height))?;
        ty.SetUINT64(&MF_MT_FRAME_RATE, pair(rate.fps, rate.stride))?;
        ty.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, pair(1u32, 1u32))?;
        ty.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)?;
        ty.SetUINT32(&MF_MT_VIDEO_PRIMARIES, MFVideoPrimaries_BT709.0 as u32)?;
        ty.SetUINT32(&MF_MT_YUV_MATRIX, MFVideoTransferMatrix_BT709.0 as u32)?;
        ty.SetUINT32(&MF_MT_VIDEO_NOMINAL_RANGE, MFNominalRange_16_235.0 as u32)?;
        ty.SetUINT32(&MF_MT_TRANSFER_FUNCTION, MFVideoTransFunc_709.0 as u32)?;
        Ok(ty)
    }
}

fn nv12(frame: &RgbaImage, dest: &mut [u8]) {
    let (width, height) = (frame.width() as usize, frame.height() as usize);
    let (y_plane, uv_plane) = dest.split_at_mut(width * height);
    for y in (0..height).step_by(2) {
        for x in (0..width).step_by(2) {
            let mut cb = 0.;
            let mut cr = 0.;
            for row in y..y + 2 {
                for col in x..x + 2 {
                    let channels = frame.get_pixel(col as u32, row as u32).0;
                    let [r, g, b, _] = channels.map(|n| f32::from(n) / 255.);
                    let l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
                    y_plane[row * width + col] = (16. + 219. * l).round().clamp(16., 235.) as u8;
                    cb += (b - l) / 1.8556;
                    cr += (r - l) / 1.5748;
                }
            }
            let uv = y / 2 * width + x;
            uv_plane[uv] = (128. + 56. * cb).round().clamp(16., 240.) as u8;
            uv_plane[uv + 1] = (128. + 56. * cr).round().clamp(16., 240.) as u8;
        }
    }
}

pub fn encode(frames: &[PathBuf], path: &Path, size: [u32; 2], rate: Rate) -> Result<()> {
    let [width, height] = size;
    let bytes = u64::from(width) * u64::from(height) * 3 / 2;
    let bytes = u32::try_from(bytes)
        .map_err(|_| failure("Video frame exceeds the Media Foundation buffer limit"))?;
    let name: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let stamp =
        |frame: usize| (frame as i64 * 10_000_000 * i64::from(rate.stride)) / i64::from(rate.fps);
    // All COM interfaces remain on the initialized encoding thread.
    unsafe {
        CoInitializeEx(None, COINIT_MULTITHREADED)
            .ok()
            .map_err(mf)?;
        let _com = Com;
        MFStartup(MF_VERSION, MFSTARTUP_FULL).map_err(mf)?;
        let _foundation = Foundation;
        let mut attrs = None;
        MFCreateAttributes(&mut attrs, 2).map_err(mf)?;
        let attrs =
            attrs.ok_or_else(|| failure("Media Foundation returned no writer attributes"))?;
        attrs
            .SetUINT32(&MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, 1)
            .map_err(mf)?;
        attrs
            .SetUINT32(&MF_SINK_WRITER_DISABLE_THROTTLING, 1)
            .map_err(mf)?;

        let writer =
            MFCreateSinkWriterFromURL(PCWSTR(name.as_ptr()), None::<&IMFByteStream>, &attrs)
                .map_err(mf)?;
        let out = media_type(&MFVideoFormat_H264, size, rate).map_err(mf)?;
        let rate_bits = (u64::from(width) * u64::from(height) * u64::from(rate.fps) * 12
            / (100 * u64::from(rate.stride)))
        .clamp(300_000, 80_000_000) as u32;
        out.SetUINT32(&MF_MT_AVG_BITRATE, rate_bits).map_err(mf)?;
        let stream = writer.AddStream(&out).map_err(mf)?;
        let input = media_type(&MFVideoFormat_NV12, size, rate).map_err(mf)?;
        input.SetUINT32(&MF_MT_DEFAULT_STRIDE, width).map_err(mf)?;
        input.SetUINT32(&MF_MT_SAMPLE_SIZE, bytes).map_err(mf)?;
        input.SetUINT32(&MF_MT_FIXED_SIZE_SAMPLES, 1).map_err(mf)?;
        writer
            .SetInputMediaType(stream, &input, None::<&IMFAttributes>)
            .map_err(mf)?;
        writer.BeginWriting().map_err(mf)?;

        for (frame, path) in frames.iter().enumerate() {
            let image = load_frame(path)?;
            if image.dimensions() != (width, height) {
                return Err(failure(format!(
                    "{} has a different frame size",
                    path.display()
                )));
            }
            let rgba = image.into_rgba8();
            let buffer = MFCreateMemoryBuffer(bytes).map_err(mf)?;
            let mut base = ptr::null_mut();
            buffer.Lock(&mut base, None, None).map_err(mf)?;
            if base.is_null() {
                let _ = buffer.Unlock();
                return Err(failure("Media Foundation returned a null pixel buffer"));
            }
            nv12(&rgba, std::slice::from_raw_parts_mut(base, bytes as usize));
            buffer.Unlock().map_err(mf)?;
            buffer.SetCurrentLength(bytes).map_err(mf)?;
            let sample = MFCreateSample().map_err(mf)?;
            sample.AddBuffer(&buffer).map_err(mf)?;
            sample.SetSampleTime(stamp(frame)).map_err(mf)?;
            sample
                .SetSampleDuration(stamp(frame + 1) - stamp(frame))
                .map_err(mf)?;
            writer.WriteSample(stream, &sample).map_err(mf)?;
        }
        writer.Finalize().map_err(mf)
    }
}
