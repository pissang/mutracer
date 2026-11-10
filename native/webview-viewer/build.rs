use std::{
    env, fs,
    path::{Path, PathBuf},
};
fn main() {
    println!("cargo:rerun-if-env-changed=MUTRACER_WEBVIEW_ASSETS");
    let root = PathBuf::from(
        env::var_os("MUTRACER_WEBVIEW_ASSETS")
            .expect("Run node native/scripts/webview-viewer-build.mjs to build embedded UI assets"),
    );
    fn collect(root: &Path, dir: &Path, entries: &mut Vec<String>) {
        println!("cargo:rerun-if-changed={}", dir.display());
        for item in fs::read_dir(dir).unwrap() {
            let path = item.unwrap().path();
            if path.is_dir() {
                collect(root, &path, entries);
                continue;
            }
            if path.extension().and_then(|s| s.to_str()) != Some("gz") {
                continue;
            }
            let name = path
                .strip_prefix(root)
                .unwrap()
                .to_str()
                .unwrap()
                .replace('\\', "/");
            let name = name.strip_suffix(".gz").unwrap();
            let mime = match Path::new(name).extension().and_then(|s| s.to_str()) {
                Some("html") => "text/html; charset=utf-8",
                Some("js") => "text/javascript",
                Some("css") => "text/css",
                Some("svg") => "image/svg+xml",
                Some("webp") => "image/webp",
                Some("png") => "image/png",
                _ => "application/octet-stream",
            };
            entries.push(format!(
                "{name:?} => Some(({mime:?}, include_bytes!({:?}))),",
                path.canonicalize().unwrap()
            ));
        }
    }
    let mut entries = vec![];
    collect(&root, &root, &mut entries);
    entries.sort();
    assert!(
        entries.iter().any(|s| s.starts_with("\"index.html\"")),
        "Missing frontend index.html.gz"
    );
    fs::write(PathBuf::from(env::var_os("OUT_DIR").unwrap()).join("assets.rs"), format!("fn embedded(path: &str) -> Option<(&'static str, &'static [u8])> {{ match path {{ {} _ => None }} }}", entries.join("\n"))).unwrap();
}
