use std::{borrow::Cow, io::Read};
include!(concat!(env!("OUT_DIR"), "/assets.rs"));
pub fn response(path: &str) -> wry::http::Response<Cow<'static, [u8]>> {
    let name = path.trim_start_matches('/');
    let name = if name.is_empty() { "index.html" } else { name };
    let mut response = wry::http::Response::builder()
        .header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; connect-src 'self' https:; font-src 'self'; object-src 'none'; frame-src 'none'")
        .header("X-Content-Type-Options", "nosniff");
    if let Some((mime, gzip)) = embedded(name) {
        let mut bytes = Vec::new();
        if flate2::read::GzDecoder::new(gzip)
            .read_to_end(&mut bytes)
            .is_ok()
        {
            response = response.header("Content-Type", mime);
            return response.body(Cow::Owned(bytes)).unwrap();
        }
        return response
            .status(500)
            .body(Cow::Borrowed(&b"Invalid embedded asset"[..]))
            .unwrap();
    }
    response
        .status(404)
        .body(Cow::Borrowed(&b"Not found"[..]))
        .unwrap()
}
