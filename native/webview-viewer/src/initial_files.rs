//! Register resources referenced by a host glTF without staging their bytes. Parsing
//! and scene conversion still run through GLTFLoader inside WebEngine.
use super::*;
pub fn stage(path: &std::path::Path, mailbox: &binary::Shared) -> Result<Value> {
    use std::io::{Read, Seek, SeekFrom};
    let path = path.canonicalize()?;
    let name = path
        .file_name()
        .context("Model file name")?
        .to_string_lossy()
        .into_owned();
    let mut file = std::fs::File::open(&path)?;
    let mut header = [0; 20];
    let read = file.read(&mut header)?;
    file.seek(SeekFrom::Start(0))?;
    let document: Value = if read >= 4 && &header[..4] == b"glTF" {
        ensure!(read == 20, "Truncated GLB header");
        let length = u32::from_le_bytes(header[12..16].try_into()?) as u64;
        ensure!(
            length <= file.metadata()?.len().saturating_sub(20),
            "Truncated GLB JSON"
        );
        file.seek(SeekFrom::Start(20))?;
        serde_json::from_reader(file.take(length))?
    } else {
        serde_json::from_reader(file)?
    };
    let record = |path: &std::path::Path, name: &str| -> Result<Value> {
        // glTF URIs use URL-style lexical parent resolution, even if a cancelled
        // path component (for example source/..) does not exist on disk.
        let mut normalized = PathBuf::new();
        for component in path.components() {
            if component == std::path::Component::ParentDir {
                normalized.pop();
            } else {
                normalized.push(component);
            }
        }
        let path = normalized.as_path();
        let metadata = std::fs::metadata(path)?;
        let modified = metadata
            .modified()?
            .duration_since(std::time::UNIX_EPOCH)?
            .as_millis();
        Ok(
            json!({"path":name,"size":metadata.len(),"lastModified":modified as u64,
            "blob":mailbox.lock().unwrap().put_file(path.to_owned())}),
        )
    };
    let mut files = vec![record(&path, &name)?];
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
                files.push(
                    record(&root.join(&decoded), &decoded)
                        .with_context(|| format!("Read glTF resource {uri}"))?,
                );
            }
        }
    }
    // Match WebEngine's optional benchmark scene environment resources.
    for light in document["extras"]["pbrt"]["light_sources"]
        .as_array()
        .into_iter()
        .flatten()
    {
        if light["gltf"] == "metadata_only" && light["pbrt"] == "infinite" {
            if let Some(source) = light["source"].as_str() {
                let name = format!("../source/{source}");
                if let Ok(resource) = record(&path.parent().unwrap().join(&name), &name) {
                    files.push(resource);
                }
            }
        }
    }
    Ok(json!({"hostPath":path,"files":files}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn registers_lazy_files_and_optional_scene_environment() {
        let root = std::env::temp_dir().join(format!("mutracer-lazy-gltf-{}", std::process::id()));
        std::fs::create_dir_all(root.join("model")).unwrap();
        std::fs::create_dir_all(root.join("source")).unwrap();
        let path = root.join("model/scene.gltf");
        std::fs::write(&path, br#"{"asset":{"version":"2.0"},"buffers":[{"uri":"mesh.bin"}],"extras":{"pbrt":{"light_sources":[{"gltf":"metadata_only","pbrt":"infinite","source":"missing/../sky.pfm"}]}}}"#).unwrap();
        std::fs::write(root.join("model/mesh.bin"), [1, 2]).unwrap();
        std::fs::write(root.join("source/sky.pfm"), [9]).unwrap();
        let store = binary::Shared::default();
        let result = stage(&path, &store).unwrap();
        assert_eq!(result["files"].as_array().unwrap().len(), 3);
        assert_eq!(result["files"][1]["size"], 2);
        assert_eq!(result["files"][2]["path"], "../source/missing/../sky.pfm");
        // Registration reads only JSON and metadata; payload bytes are read on GET.
        std::fs::write(root.join("model/mesh.bin"), [3, 4]).unwrap();
        assert_eq!(
            store
                .lock()
                .unwrap()
                .take(result["files"][1]["blob"].as_str().unwrap())
                .unwrap(),
            [3, 4]
        );
        std::fs::remove_dir_all(root).unwrap();
    }
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
