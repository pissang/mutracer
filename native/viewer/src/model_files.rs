//! Resolve a folder to a stable model entry point without moving its resources.
use anyhow::{Context, Result};
use std::path::{Path, PathBuf};

pub fn is_model(path: &Path) -> bool {
    path.extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("glb") || ext.eq_ignore_ascii_case("gltf"))
}

// Model::load runs on the existing import worker for both drops and Open folder.
pub fn resolve(path: &Path) -> Result<PathBuf> {
    if !path.is_dir() {
        return Ok(path.to_owned());
    }
    let mut folders = vec![path.to_owned()];
    let mut models = Vec::new();
    while let Some(folder) = folders.pop() {
        for entry in std::fs::read_dir(&folder)
            .with_context(|| format!("Could not scan model folder {}", folder.display()))?
        {
            let entry = entry?;
            let kind = entry.file_type()?;
            // Do not follow directory symlinks: a package may contain parent links.
            if kind.is_dir() {
                folders.push(entry.path());
            } else if kind.is_file() && is_model(&entry.path()) {
                models.push(entry.path());
            }
        }
    }
    let glb = |p: &PathBuf| {
        p.extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("glb"))
    };
    models.sort_by(|a, b| glb(b).cmp(&glb(a)).then_with(|| a.cmp(b)));
    models
        .into_iter()
        .next()
        .with_context(|| format!("No .gltf or .glb file found in folder {}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    struct Folder(PathBuf);
    impl Folder {
        fn new() -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let p = std::env::temp_dir().join(format!(
                "mutracer-model-folder-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir(&p).unwrap();
            Self(p)
        }
        fn file(&self, name: &str) -> PathBuf {
            let p = self.0.join(name);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(&p, []).unwrap();
            p
        }
    }
    impl Drop for Folder {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn nested_model_keeps_its_resource_base_and_case_insensitive_extension() {
        let f = Folder::new();
        f.file("assets/mesh.bin");
        f.file("textures/albedo.png");
        let model = f.file("package/model/Scene.GLTF");
        assert_eq!(resolve(&f.0).unwrap(), model);
        assert_eq!(resolve(&model).unwrap(), model);
    }
    #[test]
    fn glb_is_preferred_then_relative_path_order_is_stable() {
        let f = Folder::new();
        f.file("scene.gltf");
        f.file("z/scene.glb");
        let first = f.file("a/scene.GLB");
        assert_eq!(resolve(&f.0).unwrap(), first);
    }
    #[test]
    fn directories_named_like_models_are_searched_instead_of_loaded_as_files() {
        let f = Folder::new();
        let model = f.file("named.glb/nested/scene.gltf");
        assert_eq!(resolve(&f.0.join("named.glb")).unwrap(), model);
    }
    #[test]
    fn a_folder_without_a_model_reports_the_missing_entry_point() {
        let f = Folder::new();
        f.file("textures/a.png");
        assert!(
            resolve(&f.0)
                .unwrap_err()
                .to_string()
                .contains("No .gltf or .glb file found")
        );
    }
    #[cfg(unix)]
    #[test]
    fn directory_symlink_cycles_are_not_followed() {
        let f = Folder::new();
        let model = f.file("scene.gltf");
        std::os::unix::fs::symlink(&f.0, f.0.join("parent")).unwrap();
        assert_eq!(resolve(&f.0).unwrap(), model);
    }
}
