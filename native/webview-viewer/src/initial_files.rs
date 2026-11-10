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
    let document: Value = if bytes.starts_with(b"glTF") {
        let length = u32::from_le_bytes(
            bytes
                .get(12..16)
                .context("Truncated GLB header")?
                .try_into()?,
        ) as usize;
        serde_json::from_slice(
            bytes
                .get(20..20usize.checked_add(length).context("GLB length overflow")?)
                .context("Truncated GLB JSON")?,
        )?
    } else {
        serde_json::from_slice(&bytes)?
    };
    let mut files = vec![json!({"path":name,"blob":mailbox.lock().unwrap().put(bytes)})];
    {
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

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cli_glb_stages_external_resources_once() {
        let root = std::env::temp_dir().join(format!("mutracer-cli-glb-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let document = br#"{"asset":{"version":"2.0"},"buffers":[{"uri":"external%20file.bin"}],"images":[{"uri":"external%20file.bin"}]}"#;
        let mut glb = b"glTF".to_vec();
        glb.extend(2u32.to_le_bytes());
        glb.extend(((20 + document.len()) as u32).to_le_bytes());
        glb.extend((document.len() as u32).to_le_bytes());
        glb.extend(0x4e4f534au32.to_le_bytes());
        glb.extend(document);
        std::fs::write(root.join("model.glb"), &glb).unwrap();
        std::fs::write(root.join("external file.bin"), [7, 8, 9]).unwrap();
        let store = binary::Shared::default();
        let result = stage(&root.join("model.glb"), &store).unwrap();
        let files = result["files"].as_array().unwrap();
        assert_eq!(files.len(), 2);
        assert_eq!(files[1]["path"], "external file.bin");
        assert_eq!(
            store
                .lock()
                .unwrap()
                .take(files[0]["blob"].as_str().unwrap())
                .unwrap(),
            glb
        );
        assert_eq!(
            store
                .lock()
                .unwrap()
                .take(files[1]["blob"].as_str().unwrap())
                .unwrap(),
            vec![7, 8, 9]
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}
