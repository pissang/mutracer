//! glTF/GLB import with local resources, meshopt, quantized attributes and WebP.
#[cfg_attr(not(feature = "viewer-support"), allow(dead_code))]
mod animation;
mod decode;
#[cfg(test)]
mod material_tests;
mod materials;
const SUPPORTED_EXTENSIONS: &[&str] = &[
    "KHR_materials_ior",
    "KHR_materials_transmission",
    "KHR_materials_emissive_strength",
    "KHR_materials_unlit",
    "KHR_materials_clearcoat",
    "KHR_materials_sheen",
    "KHR_materials_specular",
    "KHR_materials_volume",
    "KHR_materials_iridescence",
    "KHR_materials_anisotropy",
    "KHR_materials_dispersion",
    "KHR_texture_transform",
    "EXT_meshopt_compression",
    "KHR_mesh_quantization",
    "EXT_texture_webp",
    "EXT_mesh_gpu_instancing",
];
#[cfg_attr(not(feature = "viewer-support"), allow(dead_code))]
mod model;
use super::*;
#[cfg(feature = "viewer-support")]
pub use animation::{Animation, Clip};
use anyhow::Context;
#[doc(hidden)]
pub use model::Model;
use std::{collections::BTreeMap, path::Path};

// One classification boundary for Rust import and the C wrappers.
fn import_error(error: anyhow::Error) -> api::Error {
    api::error(Status::InvalidArgument, format!("{error:#}"))
}
/// Duplicate names map to all matching objects, in document traversal order.
#[derive(Default)]
pub struct Names {
    pub nodes: BTreeMap<String, Vec<MeshId>>,
    pub meshes: BTreeMap<String, Vec<MeshId>>,
    pub geometries: BTreeMap<String, Vec<GeometryId>>,
    pub materials: BTreeMap<String, Vec<MaterialId>>,
}
/// Result of a glTF import.
pub struct ImportedScene {
    pub scene: Scene,
    /// Handles by node, mesh, geometry and material name.
    pub names: Names,
    /// Non-fatal issues, such as unsupported optional extensions.
    pub warnings: Vec<String>,
}
impl Scene {
    /// Imports a local glTF/GLB and its local or embedded resources. The default
    /// scene (otherwise the first scene) and initial paused animation pose are used.
    /// Each file and the combined source/decoded buffers default to an 8192 MiB admission
    /// budget, configurable with MUTRACER_NATIVE_MEMORY_BUDGET_MIB (positive integer).
    /// Peak memory can be several times larger. GPU limits also apply at commit.
    /// Import failures return InvalidArgument with the complete cause chain.
    pub fn import_gltf(path: impl AsRef<Path>) -> api::Result<ImportedScene> {
        Model::load(path.as_ref())
            .and_then(import)
            .context("Importing glTF scene")
            .map_err(import_error)
    }
    /// Imports bytes; base_directory resolves external URIs. Without it, all
    /// resources must be embedded. Same limits, errors and extension support as path import.
    pub fn import_gltf_bytes(
        bytes: &[u8],
        base_directory: Option<&Path>,
    ) -> api::Result<ImportedScene> {
        let base = base_directory.map(|p| p.join("memory.gltf"));
        Model::load_bytes(bytes, base.as_deref())
            .and_then(import)
            .context("Importing glTF scene")
            .map_err(import_error)
    }
}
fn import(model: Model) -> anyhow::Result<ImportedScene> {
    let env = encoder::Environment {
        enabled: false,
        width: 0,
        height: 0,
        pixels: Arc::from([]),
        background: false,
        background_color: [0.; 3],
        background_alpha: 1.,
    };
    let scene = Scene::from_indexed(
        &encoder::SceneData {
            properties: &model.properties,
            geometries: &model.geometries,
            materials: &model.materials,
            textures: &model.textures,
            meshes: &model.meshes,
            lights: vec![],
            ies: vec![],
        },
        &env,
    )?;
    let mut names = Names::default();
    let materials: Vec<_> = scene.materials.iter().map(|(k, _)| MaterialId(k)).collect();
    let geometries: Vec<_> = scene
        .geometries
        .iter()
        .map(|(k, _)| GeometryId(k))
        .collect();
    for (m, id) in model.materials.iter().zip(materials) {
        names.materials.entry(m.name.clone()).or_default().push(id);
    }
    for (i, (m, (k, _))) in model.meshes.iter().zip(scene.meshes.iter()).enumerate() {
        let id = MeshId(k);
        names
            .meshes
            .entry(model.mesh_names[i].clone())
            .or_default()
            .push(id);
        let node = model.node_names[i].clone();
        names.nodes.entry(node).or_default().push(id);
        let list = names.geometries.entry(m.name.clone()).or_default();
        let g = geometries[m.geometry];
        if !list.contains(&g) {
            list.push(g);
        }
    }
    Ok(ImportedScene {
        scene,
        names,
        warnings: model.warnings,
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn path_and_bytes_have_identical_descriptors_and_names() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../viewer/assets/sample.glb");
        let a = Scene::import_gltf(&path).unwrap();
        let b = Scene::import_gltf_bytes(&std::fs::read(&path).unwrap(), None).unwrap();
        let canonical = |scene: &Scene| {
            let bytes = scene.descriptor().unwrap();
            let mut words: Vec<_> = bytes
                .chunks_exact(4)
                .map(|b| u32::from_le_bytes(b.try_into().unwrap()))
                .collect();
            for (offset, count) in [
                (h::MESH_AOV_IDS, h::MESH_COUNT),
                (h::MATERIAL_AOV_IDS, h::MATERIAL_COUNT),
            ] {
                let at = words[offset] as usize;
                for i in 0..words[count] as usize {
                    words[at + i] = i as u32;
                }
            }
            words
        };
        assert_eq!(canonical(&a.scene), canonical(&b.scene));
        assert_eq!(
            a.names.materials.keys().collect::<Vec<_>>(),
            b.names.materials.keys().collect::<Vec<_>>()
        );
        assert!(!a.names.meshes.is_empty());
    }
    #[test]
    #[ignore = "requires a real GPU; run separately"]
    fn large_imported_texture_keeps_its_size_and_renders() {
        use crate::api::{
            Backend, ConvergeOptions, Engine, EngineOptions, PixelKind, Render, RenderSettings,
            RenderSize,
        };
        let mut png = Vec::new();
        image::RgbaImage::from_fn(2048, 1024, |x, _| image::Rgba([(x / 8) as u8, 0, 0, 255]))
            .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .unwrap();
        let mut bytes: Vec<u8> = [
            -1f32, -1., 0., 1., -1., 0., 0., 1., 0., 0., 0., 1., 0., 0.5, 1.,
        ]
        .iter()
        .flat_map(|v| v.to_le_bytes())
        .collect();
        bytes.extend(&png);
        let path = super::decode::tests::model_file(
            serde_json::json!({
                "bufferViews":[{"buffer":0,"byteLength":36},{"buffer":0,"byteOffset":36,"byteLength":24},
                    {"buffer":0,"byteOffset":60,"byteLength":png.len()}],
                "accessors":[{"bufferView":0,"componentType":5126,"type":"VEC3","count":3,"min":[-1,-1,0],"max":[1,1,0]},
                    {"bufferView":1,"componentType":5126,"type":"VEC2","count":3}],
                "images":[{"bufferView":2,"mimeType":"image/png"}],"textures":[{"source":0}],
                "materials":[{"name":"textured","pbrMetallicRoughness":{"baseColorTexture":{"index":0}}}],
                "meshes":[{"primitives":[{"attributes":{"POSITION":0,"TEXCOORD_0":1},"material":0}]}],
                "nodes":[{"mesh":0}],"scenes":[{"nodes":[0]}],"scene":0
            }),
            &bytes,
        );
        let mut imported = Scene::import_gltf(&path).unwrap();
        std::fs::remove_file(path).unwrap();
        assert!(imported.warnings.is_empty(), "{:?}", imported.warnings);
        let material = imported.names.materials["textured"][0];
        let texture = imported.scene.material_mut(material).unwrap().textures[0].unwrap();
        let t = imported.scene.texture_mut(texture).unwrap();
        assert_eq!((t.width, t.height), (2048, 1024));
        let mut camera = crate::api::Camera::default();
        camera.world_matrix[14] = 3.;
        imported.scene.set_default_camera(Some(camera));
        let engine = Engine::new(EngineOptions {
            backend: Backend::Software,
        })
        .unwrap();
        let render = Render::new(
            &engine,
            RenderSettings {
                max_samples: 4,
                size: RenderSize::Fixed {
                    width: 32,
                    height: 24,
                },
                ..Default::default()
            },
        )
        .unwrap();
        engine.set_scene_object(&imported.scene).unwrap();
        engine.update().unwrap();
        render.converge(ConvergeOptions::new(4)).unwrap();
        assert_eq!(engine.last_error(), None);
        let albedo = render.read_pixels(PixelKind::Albedo).unwrap();
        assert!(
            albedo.data.chunks(4).any(|p| p[0] > 0.),
            "texture missing from albedo"
        );
    }
}

#[cfg(test)]
mod error_tests {
    use super::*;
    use crate::scene_api::abi::{mt_scene_import_gltf, mt_scene_import_gltf_bytes};
    use std::ffi::{CStr, CString};

    #[test]
    fn rust_and_c_import_errors_preserve_status_and_causes() {
        let root =
            std::env::temp_dir().join(format!("mutracer-import-errors-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let missing = root.join("missing.glb");
        let rust = Scene::import_gltf(&missing).err().unwrap();
        assert_eq!(rust.status, Status::InvalidArgument);
        assert!(rust.message.contains("Importing glTF scene: "));
        assert!(rust.message.contains("os error"), "{}", rust.message);
        let path = CString::new(missing.to_str().unwrap()).unwrap();
        let mut error = [0i8; 4096];
        let mut scene = 0;
        assert_eq!(
            unsafe {
                mt_scene_import_gltf(path.as_ptr(), &mut scene, error.as_mut_ptr(), error.len())
            },
            Status::InvalidArgument as i32
        );
        assert_eq!(
            unsafe { CStr::from_ptr(error.as_ptr()) }.to_str().unwrap(),
            rust.message
        );
        for (name, bytes, cause) in [
            ("broken.glb", b"glTF\x02\0\0\0".as_slice(), "Loading GLTF/GLB and its buffers/images: "),
            ("required.gltf", br#"{"asset":{"version":"2.0"},"extensionsRequired":["KHR_draco_mesh_compression"]}"#.as_slice(), "Required glTF extension is unsupported"),
            ("limit.gltf", br#"{"asset":{"version":"2.0"},"buffers":[{"byteLength":1099511627776}]}"#.as_slice(), "Model buffers requires"),
        ] {
            let file = root.join(name);
            std::fs::write(&file, bytes).unwrap();
            let from_bytes = Scene::import_gltf_bytes(bytes, None).err().unwrap();
            let from_path = Scene::import_gltf(&file).err().unwrap();
            let cause_chain = Model::load_bytes(bytes, None).err().unwrap();
            assert_eq!(from_bytes.message, format!("Importing glTF scene: {cause_chain:#}"));
            assert_eq!(from_bytes.status, Status::InvalidArgument);
            assert_eq!(from_path.status, Status::InvalidArgument);
            assert!(from_bytes.message.contains(cause), "{}", from_bytes.message);
            assert!(from_bytes.message.starts_with("Importing glTF scene: Loading GLTF/GLB and its buffers/images: "), "{}", from_bytes.message);
            assert_eq!(unsafe { mt_scene_import_gltf_bytes(bytes.as_ptr().cast(), bytes.len(), std::ptr::null(), &mut scene, error.as_mut_ptr(), error.len()) }, Status::InvalidArgument as i32);
            assert_eq!(unsafe { CStr::from_ptr(error.as_ptr()) }.to_str().unwrap(), from_bytes.message);
            let path = CString::new(file.to_str().unwrap()).unwrap();
            assert_eq!(unsafe { mt_scene_import_gltf(path.as_ptr(), &mut scene, error.as_mut_ptr(), error.len()) }, Status::InvalidArgument as i32);
            assert_eq!(unsafe { CStr::from_ptr(error.as_ptr()) }.to_str().unwrap(), from_path.message);
        }
        std::fs::remove_dir_all(root).unwrap();
    }
}
