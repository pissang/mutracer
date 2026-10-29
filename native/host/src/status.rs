//! C status codes; values and meanings are specified in mutracer-status.h.
use std::ffi::c_char;

/// Mirrors `MT_ABI_VERSION`.
pub const ABI_VERSION: u32 = 10;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(i32)]
pub enum Status {
    Ok = 0,
    Error = 1,
    InvalidArgument = 2,
    InvalidHandle = 3,
    Busy = 4,
    InvalidState = 5,
    FullCommitRequired = 6,
    Cancelled = 7,
    BufferTooSmall = 8,
    ContextFailed = 9,
    Unavailable = 10,
    Timeout = 11,
}

pub(crate) const FULL_COMMIT_PREFIX: &str = "Full scene commit required:";

/// An error with an explicit C status. Plain errors map through `classify`.
#[derive(Debug)]
pub struct StatusError {
    pub status: Status,
    pub message: String,
}
impl std::fmt::Display for StatusError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for StatusError {}

pub(crate) fn fail(status: Status, message: impl Into<String>) -> Box<dyn std::error::Error> {
    Box::new(StatusError {
        status,
        message: message.into(),
    })
}
/// Explicit statuses win; the documented full-commit prefix is recognized
/// wherever it was produced; everything else is `fallback`.
pub(crate) fn classify(error: &(dyn std::error::Error + 'static), fallback: Status) -> Status {
    if let Some(error) = error.downcast_ref::<StatusError>() {
        error.status
    } else if error.to_string().starts_with(FULL_COMMIT_PREFIX) {
        Status::FullCommitRequired
    } else {
        fallback
    }
}
pub(crate) fn fail_anyhow(status: Status, message: impl Into<String>) -> anyhow::Error {
    anyhow::Error::new(StatusError {
        status,
        message: message.into(),
    })
}
/// Marks unclassified validation/preparation failures as rejected input.
pub(crate) fn rejected(error: Box<dyn std::error::Error>) -> Box<dyn std::error::Error> {
    if error.downcast_ref::<StatusError>().is_none()
        && !error.to_string().starts_with(FULL_COMMIT_PREFIX)
    {
        fail(Status::InvalidArgument, error.to_string())
    } else {
        error
    }
}
/// Copy a truncated NUL-terminated UTF-8 message and return the status code.
pub(crate) fn write(error: *mut c_char, capacity: usize, status: Status, message: &str) -> i32 {
    if !error.is_null() && capacity > 0 {
        fill(
            unsafe { std::slice::from_raw_parts_mut(error, capacity) },
            message,
        );
    }
    status as i32
}

/// Copy UTF-8 into a bounded C string without changing bytes past its terminator.
pub(crate) fn fill(buffer: &mut [c_char], text: &str) {
    let count = text.floor_char_boundary(buffer.len().saturating_sub(1));
    for (slot, byte) in buffer.iter_mut().zip(text.as_bytes()[..count].iter()) {
        *slot = *byte as c_char;
    }
    if let Some(end) = buffer.get_mut(count) {
        *end = 0;
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn mt_abi_version() -> u32 {
    ABI_VERSION
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounded_c_strings_preserve_utf8_terminators_and_unused_bytes() {
        let text = "A中🙂Z";
        for (capacity, expected) in [
            (0, ""),
            (1, ""),
            (2, "A"),
            (3, "A"),
            (4, "A"),
            (5, "A中"),
            (8, "A中"),
            (9, "A中🙂"),
            (10, text),
            (12, text),
        ] {
            let mut buffer = [0x55 as c_char; 12];
            assert_eq!(
                write(buffer.as_mut_ptr(), capacity, Status::Busy, text),
                Status::Busy as i32
            );
            if capacity > 0 {
                assert_eq!(
                    unsafe { std::ffi::CStr::from_ptr(buffer.as_ptr()) }
                        .to_str()
                        .unwrap(),
                    expected
                );
                assert!(
                    buffer[expected.len() + 1..]
                        .iter()
                        .all(|&byte| byte == 0x55)
                );
            } else {
                assert_eq!(buffer, [0x55; 12]);
            }
        }
        assert_eq!(
            write(std::ptr::null_mut(), 12, Status::Cancelled, text),
            Status::Cancelled as i32
        );
        fill(&mut [], text);
    }
    // The C header is the public contract; keep Rust values identical to it.
    #[test]
    fn header_status_codes_and_abi_version_match() {
        let header = include_str!("../../include/mutracer-status.h");
        let value = |name: &str| -> i64 {
            let line = header
                .lines()
                .find(|line| line.trim_start().starts_with(&format!("{name} ")))
                .unwrap_or_else(|| panic!("{name} missing from mutracer-status.h"));
            let digits: String = line
                .split_once(name)
                .unwrap()
                .1
                .chars()
                .filter(char::is_ascii_digit)
                .collect();
            digits.parse().unwrap()
        };
        for (name, status) in [
            ("MT_OK", Status::Ok),
            ("MT_ERROR", Status::Error),
            ("MT_ERROR_INVALID_ARGUMENT", Status::InvalidArgument),
            ("MT_ERROR_INVALID_HANDLE", Status::InvalidHandle),
            ("MT_ERROR_BUSY", Status::Busy),
            ("MT_ERROR_INVALID_STATE", Status::InvalidState),
            ("MT_ERROR_FULL_COMMIT_REQUIRED", Status::FullCommitRequired),
            ("MT_ERROR_CANCELLED", Status::Cancelled),
            ("MT_ERROR_BUFFER_TOO_SMALL", Status::BufferTooSmall),
            ("MT_ERROR_CONTEXT_FAILED", Status::ContextFailed),
            ("MT_ERROR_UNAVAILABLE", Status::Unavailable),
            ("MT_ERROR_TIMEOUT", Status::Timeout),
        ] {
            assert_eq!(value(name), status as i64, "{name}");
        }
        for (name, kind) in [
            ("MT_COMMIT_NONE", crate::context::COMMIT_NONE),
            ("MT_COMMIT_FULL", crate::context::COMMIT_FULL),
            ("MT_COMMIT_INCREMENTAL", crate::context::COMMIT_INCREMENTAL),
        ] {
            assert_eq!(value(name), kind as i64, "{name}");
        }
        assert_eq!(value("#define MT_ABI_VERSION"), ABI_VERSION as i64);
        assert_eq!(ABI_VERSION, 10);
        assert_eq!(mt_abi_version(), ABI_VERSION);
    }
    #[test]
    fn classification_prefers_explicit_status_then_full_commit_prefix() {
        let explicit = fail(Status::Busy, "Full scene commit required: but busy");
        assert_eq!(classify(explicit.as_ref(), Status::Error), Status::Busy);
        let prefixed: Box<dyn std::error::Error> = "Full scene commit required: shape".into();
        assert_eq!(
            classify(prefixed.as_ref(), Status::Error),
            Status::FullCommitRequired
        );
        assert_eq!(
            classify(rejected(prefixed).as_ref(), Status::Error),
            Status::FullCommitRequired
        );
        let plain: Box<dyn std::error::Error> = "bad offset".into();
        assert_eq!(classify(plain.as_ref(), Status::Error), Status::Error);
        assert_eq!(
            classify(rejected(plain).as_ref(), Status::Error),
            Status::InvalidArgument
        );
    }
}
