//! Only the viewer's fixed public GPUOpen API is reachable through this
//! protocol route. Model downloads and parsing remain in the shared frontend.
use super::*;
use std::io::Read;
pub fn response(path: &str) -> wry::http::Response<Cow<'static, [u8]>> {
    let result = (|| -> Result<(String, Vec<u8>)> {
        ensure!(path.starts_with("/api/gpuopen/"), "Unknown catalog path");
        let url = format!(
            "https://api.matlib.gpuopen.com/api/{}",
            path.strip_prefix("/api/gpuopen/").unwrap()
        );
        let config = ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(120)))
            .build();
        let agent: ureq::Agent = config.into();
        let mut response = agent.get(&url).call()?;
        let kind = response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("application/octet-stream")
            .to_owned();
        let mut bytes = Vec::new();
        response.body_mut().as_reader().read_to_end(&mut bytes)?;
        Ok((kind, bytes))
    })();
    match result {
        Ok((kind, bytes)) => wry::http::Response::builder()
            .header("Content-Type", kind)
            .body(Cow::Owned(bytes))
            .unwrap(),
        Err(error) => wry::http::Response::builder()
            .status(502)
            .body(Cow::Owned(error.to_string().into_bytes()))
            .unwrap(),
    }
}
