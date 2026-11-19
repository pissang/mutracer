use serde::Serialize;
use std::fmt;

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, Serialize)]
pub struct Error {
    pub code: u8,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pointer: Option<String>,
    pub message: String,
    pub hint: String,
}

impl Error {
    pub fn at(
        code: u8,
        pointer: impl Into<String>,
        message: impl Into<String>,
        hint: impl Into<String>,
    ) -> Self {
        Self {
            code,
            pointer: Some(pointer.into()),
            message: message.into(),
            hint: hint.into(),
        }
    }
    pub fn validation(
        pointer: impl Into<String>,
        message: impl Into<String>,
        hint: impl Into<String>,
    ) -> Self {
        Self::at(2, pointer, message, hint)
    }
    pub fn asset(pointer: impl Into<String>, message: impl Into<String>) -> Self {
        Self::at(
            3,
            pointer,
            message,
            "Check the asset path, permissions and file format.",
        )
    }
    pub fn budget(message: impl Into<String>) -> Self {
        Self {
            code: 4,
            pointer: None,
            message: message.into(),
            hint: "Reduce dimensions, sample count or frame range, or raise the time budget."
                .into(),
        }
    }
    pub fn gpu(message: impl Into<String>) -> Self {
        Self {
            code: 5,
            pointer: None,
            message: message.into(),
            hint: "Rerun the command to resume completed frames.".into(),
        }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.message)
    }
}

pub fn escape(s: &str) -> String {
    s.replace('~', "~0").replace('/', "~1")
}
