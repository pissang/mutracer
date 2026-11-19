use super::{Rate, failure, load_frame};
use crate::error::Result;
use block2::RcBlock;
use image::GenericImageView;
use objc2::{
    Encode, Encoding, RefEncode, class, msg_send,
    rc::{Retained, autoreleasepool},
    runtime::{AnyObject, Bool},
};
use objc2_foundation::{NSDictionary, NSError, NSNumber, NSString, NSURL};
use std::{
    ffi::c_void,
    path::{Path, PathBuf},
    ptr, slice,
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};

#[derive(Clone, Copy)]
#[repr(C)]
struct MediaTime {
    value: i64,
    scale: i32,
    flags: u32,
    epoch: i64,
}

unsafe impl Encode for MediaTime {
    const ENCODING: Encoding = Encoding::Struct(
        "?",
        &[
            Encoding::LongLong,
            Encoding::Int,
            Encoding::UInt,
            Encoding::LongLong,
        ],
    );
}

impl MediaTime {
    fn frame(frame: usize, rate: Rate) -> Self {
        Self {
            value: frame as i64 * i64::from(rate.stride),
            scale: rate.fps as i32,
            flags: 1,
            epoch: 0,
        }
    }
}

#[repr(C)]
struct CvBuffer {
    _opaque: [u8; 0],
}
unsafe impl RefEncode for CvBuffer {
    const ENCODING_REF: Encoding = Encoding::Pointer(&Encoding::Struct("__CVBuffer", &[]));
}

#[link(name = "AVFoundation", kind = "framework")]
unsafe extern "C" {}
#[link(name = "CoreVideo", kind = "framework")]
unsafe extern "C" {
    fn CVPixelBufferCreate(
        allocator: *const c_void,
        width: usize,
        height: usize,
        format: u32,
        attributes: *const c_void,
        buffer: *mut *mut CvBuffer,
    ) -> i32;
    fn CVPixelBufferLockBaseAddress(buffer: *mut CvBuffer, flags: u64) -> i32;
    fn CVPixelBufferUnlockBaseAddress(buffer: *mut CvBuffer, flags: u64) -> i32;
    fn CVPixelBufferGetBaseAddress(buffer: *mut CvBuffer) -> *mut u8;
    fn CVPixelBufferGetBytesPerRow(buffer: *mut CvBuffer) -> usize;
    fn CVPixelBufferRelease(buffer: *mut CvBuffer);
}

struct Pixels(*mut CvBuffer);
impl Drop for Pixels {
    fn drop(&mut self) {
        unsafe { CVPixelBufferRelease(self.0) };
    }
}

impl Pixels {
    fn new(path: &Path, [width, height]: [u32; 2]) -> Result<Self> {
        let frame = load_frame(path)?;
        if frame.dimensions() != (width, height) {
            return Err(failure(format!(
                "{} has a different frame size",
                path.display()
            )));
        }
        let rgba = frame.into_rgba8();
        let mut buffer = ptr::null_mut();
        let width = width as usize;
        let height = height as usize;
        // The freshly created pixel buffer is exclusively owned while its rows
        // are locked. AVFoundation retains it as needed when the frame is appended.
        unsafe {
            let status = CVPixelBufferCreate(
                ptr::null(),
                width,
                height,
                u32::from_be_bytes(*b"BGRA"),
                ptr::null(),
                &mut buffer,
            );
            if status != 0 || buffer.is_null() {
                return Err(failure(format!("CVPixelBufferCreate returned {status}")));
            }
            let pixels = Self(buffer);
            let status = CVPixelBufferLockBaseAddress(buffer, 0);
            if status != 0 {
                return Err(failure(format!(
                    "CVPixelBufferLockBaseAddress returned {status}"
                )));
            }
            let start = CVPixelBufferGetBaseAddress(buffer);
            let stride = CVPixelBufferGetBytesPerRow(buffer);
            for y in 0..height {
                let dest = slice::from_raw_parts_mut(start.add(y * stride), width * 4);
                let src = &rgba.as_raw()[y * width * 4..(y + 1) * width * 4];
                for (dst, src) in dest.chunks_exact_mut(4).zip(src.chunks_exact(4)) {
                    dst.copy_from_slice(&[src[2], src[1], src[0], src[3]]);
                }
            }
            let status = CVPixelBufferUnlockBaseAddress(buffer, 0);
            if status != 0 {
                return Err(failure(format!(
                    "CVPixelBufferUnlockBaseAddress returned {status}"
                )));
            }
            Ok(pixels)
        }
    }
}

fn writer_error(writer: &AnyObject, fallback: &str) -> crate::error::Error {
    let error: Option<Retained<NSError>> = unsafe { msg_send![writer, error] };
    failure(error.map_or_else(
        || fallback.to_owned(),
        |err| err.localizedDescription().to_string(),
    ))
}

pub fn encode(frames: &[PathBuf], path: &Path, size: [u32; 2], rate: Rate) -> Result<()> {
    autoreleasepool(|_| {
        let path = path
            .to_str()
            .ok_or_else(|| failure("MP4 output path must be UTF-8"))?;
        let url = NSURL::fileURLWithPath_isDirectory(&NSString::from_str(path), false);
        let [width, height] = size;
        let width_number = NSNumber::new_u32(width);
        let height_number = NSNumber::new_u32(height);
        let ns = NSString::from_str;
        let codec = ns("avc1");
        let settings = NSDictionary::<NSString, AnyObject>::from_slices(
            &[
                &*ns("AVVideoCodecKey"),
                &*ns("AVVideoWidthKey"),
                &*ns("AVVideoHeightKey"),
            ],
            &[
                codec.as_ref(),
                width_number.as_ref(),
                height_number.as_ref(),
            ],
        );
        // The AVFoundation classes are supplied by the linked system framework.
        // Objective-C retained return values and NSError writeback are managed by objc2.
        unsafe {
            let writer: std::result::Result<Retained<AnyObject>, Retained<NSError>> = msg_send![class!(AVAssetWriter), assetWriterWithURL: &*url, fileType: &*ns("public.mpeg-4"), error: _];
            let writer = writer.map_err(|e| failure(e.localizedDescription().to_string()))?;
            let input: Retained<AnyObject> = msg_send![class!(AVAssetWriterInput),
                assetWriterInputWithMediaType: &*ns("vide"), outputSettings: &*settings];
            let adaptor: Retained<AnyObject> = msg_send![class!(AVAssetWriterInputPixelBufferAdaptor),
                assetWriterInputPixelBufferAdaptorWithAssetWriterInput: &*input,
                sourcePixelBufferAttributes: ptr::null::<NSDictionary<NSString, AnyObject>>()];
            let can_add: Bool = msg_send![&*writer, canAddInput: &*input];
            if !can_add.as_bool() {
                return Err(writer_error(&writer, "Cannot add an H.264 video track"));
            }
            let (): () = msg_send![&*writer, addInput: &*input];
            let started: Bool = msg_send![&*writer, startWriting];
            if !started.as_bool() {
                return Err(writer_error(&writer, "Cannot start AVAssetWriter"));
            }
            let (): () = msg_send![&*writer, startSessionAtSourceTime: MediaTime::frame(0, rate)];
            let writing = (|| {
                for (i, path) in frames.iter().enumerate() {
                    let deadline = Instant::now() + Duration::from_secs(30);
                    loop {
                        let ready: Bool = msg_send![&*input, isReadyForMoreMediaData];
                        if ready.as_bool() {
                            break;
                        }
                        let status: isize = msg_send![&*writer, status];
                        if status != 1 || Instant::now() > deadline {
                            return Err(writer_error(&writer, "Encoder stopped accepting frames"));
                        }
                        thread::sleep(Duration::from_millis(2));
                    }
                    autoreleasepool(|_| {
                        let pixels = Pixels::new(path, size)?;
                        let ok: Bool = msg_send![&*adaptor, appendPixelBuffer: pixels.0, withPresentationTime: MediaTime::frame(i, rate)];
                        if !ok.as_bool() {
                            return Err(writer_error(&writer, "Cannot append frame"));
                        }
                        Ok(())
                    })?;
                }
                Ok(())
            })();
            if let Err(error) = writing {
                let (): () = msg_send![&*writer, cancelWriting];
                return Err(error);
            }
            let (): () =
                msg_send![&*writer, endSessionAtSourceTime: MediaTime::frame(frames.len(), rate)];
            let (): () = msg_send![&*input, markAsFinished];
            let (tx, rx) = mpsc::channel();
            let completion = RcBlock::new(move || {
                let _ = tx.send(());
            });
            let (): () = msg_send![&*writer, finishWritingWithCompletionHandler: &*completion];
            if rx.recv_timeout(Duration::from_secs(60)).is_err() {
                return Err(failure("AVAssetWriter did not finish"));
            }
            let status: isize = msg_send![&*writer, status];
            if status != 2 {
                return Err(writer_error(&writer, "AVAssetWriter did not complete"));
            }
            Ok(())
        }
    })
}
