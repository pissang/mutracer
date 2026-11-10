//! Stage only resources explicitly referenced by a command-line glTF. Parsing
//! and scene conversion still run through GLTFLoader inside WebEngine.
use super::*;
pub fn stage(path: &std::path::Path, mailbox: &binary::Shared) -> Result<Value> {
    let bytes = std::fs::read(path)?;
    let name = path
        .file_name()
        .context("Model file name")?
        .to_string_lossy()
        .into_owned();
    let mut files = vec![json!({"path":name,"blob":mailbox.lock().unwrap().put(bytes.clone())})];
    if path
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("gltf"))
    {
        let document: Value = serde_json::from_slice(&bytes)?;
        let root = path.parent().unwrap_or(std::path::Path::new("."));
        let mut seen = std::collections::BTreeSet::new();
        for field in ["buffers", "images"] {
            for resource in document[field].as_array().into_iter().flatten() {
                let Some(uri) = resource["uri"].as_str() else {
                    continue;
                };
                if uri.contains(':') || !seen.insert(uri.to_owned()) {
                    continue;
                }
                let decoded = percent_encoding::percent_decode_str(uri)
                    .decode_utf8()?
                    .into_owned();
                files.push(json!({"path":decoded,"blob":mailbox.lock().unwrap().put(std::fs::read(root.join(&decoded)).with_context(||format!("Read glTF resource {uri}"))?)}));
            }
        }
    }
    Ok(json!({"files":files}))
}
