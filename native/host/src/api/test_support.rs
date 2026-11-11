use super::{Result, Status, error};

/// Status code of an L0 call result.
pub(super) fn status_from(code: i32) -> Status {
    use Status::*;
    [
        Ok,
        Error,
        InvalidArgument,
        InvalidHandle,
        Busy,
        InvalidState,
        FullCommitRequired,
        Cancelled,
        BufferTooSmall,
        ContextFailed,
        Unavailable,
        Timeout,
    ]
    .into_iter()
    .find(|status| *status as i32 == code)
    .unwrap_or(Error)
}
pub(super) fn l0_result(code: i32, message: &[std::ffi::c_char]) -> Result<()> {
    if code == 0 {
        return Ok(());
    }
    let bytes: Vec<u8> = message
        .iter()
        .take_while(|c| **c != 0)
        .map(|c| *c as u8)
        .collect();
    Err(error(
        status_from(code),
        String::from_utf8_lossy(&bytes).into_owned(),
    ))
}
/// Runs one L0 ABI call with an owned error buffer.
pub(super) fn l0(operation: impl FnOnce(*mut std::ffi::c_char, usize) -> i32) -> Result<()> {
    let mut message = [0 as std::ffi::c_char; 1024];
    let code = operation(message.as_mut_ptr(), message.len());
    l0_result(code, &message)
}
/// Blocking callers retry L0 registry contention, which lasts one short operation.
pub(super) fn l0_blocking(
    mut operation: impl FnMut(*mut std::ffi::c_char, usize) -> i32,
) -> Result<()> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
    loop {
        crate::runtime::check_loss().map_err(|e| error(Status::Unavailable, e.to_string()))?;
        match l0(&mut operation) {
            Err(e) if e.status == Status::Busy && std::time::Instant::now() < deadline => {
                std::thread::sleep(std::time::Duration::from_micros(200));
            }
            result => return result,
        }
    }
}
// Capture only existing CPU readbacks; do not insert GPU work or change the
// sample stream while diagnosing strict image comparisons.
pub(super) fn capture_hdr_readback(render: u64, image: &super::Image) {
    let Some(root) = std::env::var_os("MUTRACER_TEST_READBACKS") else {
        return;
    };
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let index = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let root = std::path::PathBuf::from(root);
    std::fs::create_dir_all(&root).expect("Create readback evidence directory");
    // Retain the last comparisons without multiplying 720p readbacks by every
    // parameter in a long matrix. A failed comparison stops with these frames
    // intact; the OpenPBR comparison helper also saves its named failure pairs.
    let stem = format!("readback-{:02}", index % 16);
    let bytes: Vec<u8> = image
        .data
        .iter()
        .flat_map(|value| value.to_le_bytes())
        .collect();
    std::fs::write(root.join(format!("{stem}.rgba32f")), bytes).expect("Write HDR evidence");
    let metadata = serde_json::json!({
        "sequence": index, "render": render, "width": image.width, "height": image.height,
        "format": "RGBA32Float little-endian", "rowOrder": "top-first",
        "test": std::thread::current().name(), "backend": std::env::var("WGPU_BACKEND").ok(),
    });
    std::fs::write(root.join(format!("{stem}.json")), metadata.to_string())
        .expect("Write HDR metadata");
}
