//! Authored camera and lighting metadata, kept in the imported model's world
//! space. Environment reprojection matches viewer/src/engine/modelLighting.ts.
use anyhow::{Context, Result, ensure};
use glam::{Mat4, Quat, Vec3};
use mutracer_native_probe::layout::light as wire;
use serde_json::Value;
use std::{collections::HashMap, path::Path, sync::Arc};

#[derive(Clone, Default)]
pub struct Scene {
    pub cameras: Vec<View>,
    pub hidden: std::collections::HashSet<usize>,
    pub nodes: Arc<Vec<crate::scene_tree::Node>>,
    pub lights: Vec<[u32; wire::WORDS]>,
    pub environment: Option<Arc<image::Rgb32FImage>>,
    /// An independent HDR selected with the model, separate from authored lighting.
    pub dropped_environment: Option<(Arc<image::Rgb32FImage>, String)>,
    pub available: bool,
    pub authored: bool,
    pub preset: Option<Value>,
}
#[derive(Clone)]
pub struct View {
    pub name: String,
    pub matrix: Mat4,
    pub fov: f32,
    pub half_height: Option<f32>,
}
impl View {
    pub fn apply(&self, camera: &mut crate::renderer::Camera, center: Vec3) {
        let eye = self.matrix.w_axis.truncate();
        let forward = -self.matrix.z_axis.truncate().normalize();
        let depth = (center - eye).dot(forward);
        let distance = if depth > 1e-4 {
            depth
        } else {
            center.distance(eye).max(1e-3)
        };
        camera.set_view(eye, eye + forward * distance);
        camera.up = self.matrix.y_axis.truncate().normalize();
        // Forward/up alone cannot represent a reflected glTF camera basis.
        camera.mirrored = self.matrix.determinant() < 0.;
        camera.fov = self.fov;
        camera.orthographic = self.half_height.is_some();
        if let Some(height) = self.half_height {
            camera.fov = (2. * (height / distance).atan()).to_degrees();
        }
    }
}
pub fn vector(value: &Value) -> Option<Vec3> {
    let v = value.as_array()?;
    if v.len() != 3 {
        return None;
    }
    let v = Vec3::new(
        v[0].as_f64()? as f32,
        v[1].as_f64()? as f32,
        v[2].as_f64()? as f32,
    );
    v.is_finite().then_some(v)
}
fn matrix(value: &Value) -> Option<Mat4> {
    let array = value.as_array()?;
    if array.len() != 16 {
        return None;
    }
    let mut values = [0.; 16];
    for (i, v) in array.iter().enumerate() {
        values[i] = v.as_f64()? as f32;
    }
    let m = Mat4::from_cols_array(&values);
    m.is_finite().then_some(m)
}
fn local(node: &Value) -> Mat4 {
    if let Some(m) = matrix(&node["matrix"]) {
        return m;
    }
    let q = node["rotation"]
        .as_array()
        .filter(|v| v.len() == 4)
        .map(|v| {
            Quat::from_xyzw(
                v[0].as_f64().unwrap_or(0.) as f32,
                v[1].as_f64().unwrap_or(0.) as f32,
                v[2].as_f64().unwrap_or(0.) as f32,
                v[3].as_f64().unwrap_or(1.) as f32,
            )
            .normalize()
        })
        .unwrap_or(Quat::IDENTITY);
    Mat4::from_scale_rotation_translation(
        vector(&node["scale"]).unwrap_or(Vec3::ONE),
        q,
        vector(&node["translation"]).unwrap_or(Vec3::ZERO),
    )
}
fn light(kind: u32, color: Vec3, intensity: f32, transform: Mat4) -> [u32; wire::WORDS] {
    let mut record = [0; wire::WORDS];
    record[wire::TYPE] = kind;
    for (i, v) in color.to_array().iter().enumerate() {
        record[wire::COLOR + i] = v.to_bits();
    }
    record[wire::INTENSITY] = intensity.to_bits();
    for (i, v) in transform.to_cols_array().iter().enumerate() {
        record[wire::TRANSFORM + i] = v.to_bits();
    }
    record
}
impl Scene {
    pub fn load(
        json: &Value,
        path: &Path,
        model: &mut mutracer_native_probe::scene_api::viewer_support::Model,
    ) -> Result<Self> {
        let mut result = Self::default();
        result.nodes = Arc::new(crate::scene_tree::from_gltf(json, model));
        let nodes = json["nodes"].as_array().context("glTF has no nodes")?;
        fn visit(
            index: usize,
            parent: Mat4,
            nodes: &[Value],
            json: &Value,
            out: &mut Scene,
            depth: usize,
        ) -> Result<()> {
            ensure!(depth < 512, "Scene metadata hierarchy is too deep");
            let n = nodes.get(index).context("Invalid scene node")?;
            let world = parent * local(n);
            if let Some(i) = n["camera"].as_u64() {
                Arc::make_mut(&mut out.nodes)[index].camera = Some(out.cameras.len());
                let c = &json["cameras"][i as usize];
                let ortho = c["type"] == "orthographic";
                let fov = (c["perspective"]["yfov"]
                    .as_f64()
                    .unwrap_or(35f64.to_radians()) as f32)
                    .to_degrees();
                let half = ortho.then(|| c["orthographic"]["ymag"].as_f64().unwrap_or(1.) as f32);
                out.cameras.push(View {
                    name: n["name"]
                        .as_str()
                        .or(c["name"].as_str())
                        .unwrap_or("Camera")
                        .into(),
                    matrix: world,
                    fov,
                    half_height: half,
                });
            }
            if let Some(i) = n["extensions"]["KHR_lights_punctual"]["light"].as_u64() {
                let l = &json["extensions"]["KHR_lights_punctual"]["lights"][i as usize];
                let kind = match l["type"].as_str() {
                    Some("directional") => 2,
                    Some("spot") => 3,
                    _ => 1,
                };
                let color = vector(&l["color"]).unwrap_or(Vec3::ONE);
                let intensity = l["intensity"].as_f64().unwrap_or(1.) as f32;
                let mut record = light(kind, color, intensity, world);
                if kind == 1 {
                    record[wire::SIZE] = 0.25f32.to_bits();
                }
                if kind == 3 {
                    record[wire::HEIGHT_OR_INNER] =
                        (l["spot"]["innerConeAngle"].as_f64().unwrap_or(0.) as f32).to_bits();
                    record[wire::SPREAD_OR_OUTER] = (l["spot"]["outerConeAngle"]
                        .as_f64()
                        .unwrap_or(std::f64::consts::FRAC_PI_4)
                        as f32)
                        .to_bits();
                }
                if color.max_element() > 0. && intensity > 0. {
                    out.available = true;
                }
                out.lights.push(record);
            }
            for child in n["children"].as_array().into_iter().flatten() {
                visit(
                    child.as_u64().context("Invalid child")? as usize,
                    world,
                    nodes,
                    json,
                    out,
                    depth + 1,
                )?;
            }
            Ok(())
        }
        let scene = json["scene"].as_u64().unwrap_or(0) as usize;
        for n in json["scenes"][scene]["nodes"]
            .as_array()
            .into_iter()
            .flatten()
        {
            visit(
                n.as_u64().context("Invalid scene node")? as usize,
                Mat4::IDENTITY,
                nodes,
                json,
                &mut result,
                0,
            )?;
        }
        let pbrt = &json["extras"]["pbrt"];
        result.authored = !pbrt.is_null() || result.available;
        let emissive = model
            .materials
            .iter()
            .any(|m| m.emission_strength > 0. && m.emission.iter().any(|c| *c > 0.));
        result.available |= !pbrt.is_null() && emissive;
        let directory = path.parent().unwrap_or(Path::new("."));
        let resources: HashMap<String, String> = std::fs::read(directory.join("resources.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        if let Ok(bytes) = std::fs::read(directory.join("warnings.json")) {
            if let Ok(warnings) = serde_json::from_slice::<Vec<String>>(&bytes) {
                model.warnings.extend(warnings);
            }
        }
        for entry in pbrt["light_sources"].as_array().into_iter().flatten() {
            if entry["gltf"] != "metadata_only" {
                continue;
            }
            let transform = matrix(&entry["pbrt_transform"]).unwrap_or(Mat4::IDENTITY);
            let radiance = vector(&entry["radiance_rgb"]).filter(|v| v.min_element() >= 0.);
            match entry["pbrt"].as_str() {
                Some("distant") => {
                    if let (Some(from), Some(to), Some(color)) =
                        (vector(&entry["from"]), vector(&entry["to"]), radiance)
                    {
                        let from = transform.transform_point3(from);
                        let to = transform.transform_point3(to);
                        if from.distance_squared(to) > 1e-12 {
                            let direction = (to - from).normalize();
                            let up = if direction.dot(Vec3::Y).abs() > 0.999 {
                                Vec3::X
                            } else {
                                Vec3::Y
                            };
                            let matrix = Mat4::look_at_rh(from, to, up).inverse();
                            result.lights.push(light(2, color, 1., matrix));
                            result.available |= color.max_element() > 0.;
                        }
                    }
                }
                Some("infinite") => {
                    let loaded: Result<image::Rgb32FImage> = (|| {
                        if let Some(source) = entry["source"].as_str() {
                            let original = format!("../source/{source}");
                            // Match the browser's URL resolution before filesystem access.
                            // `source/../bistro` must work even if `source` does not exist.
                            let base = url::Url::from_file_path(std::path::absolute(path)?)
                                .ok()
                                .context("Invalid model file path")?;
                            let local = base
                                .join(
                                    resources
                                        .get(&original)
                                        .map(String::as_str)
                                        .unwrap_or(&original),
                                )?
                                .to_file_path()
                                .ok()
                                .context("Scene environment must be a local file")?;
                            let image = if source.to_lowercase().ends_with(".pfm") {
                                parse_pfm(&std::fs::read(local)?)?
                            } else {
                                image::ImageReader::open(local)?
                                    .with_guessed_format()?
                                    .decode()?
                                    .into_rgb32f()
                            };
                            ensure!(
                                image.width() as u64 * image.height() as u64 <= 16_777_216,
                                "Scene environment exceeds 16M pixels"
                            );
                            let mut image = reproject(
                                &image,
                                transform,
                                source.to_lowercase().contains("equiarea"),
                            );
                            let gain = radiance.unwrap_or(Vec3::ONE);
                            for p in image.pixels_mut() {
                                for c in 0..3 {
                                    p.0[c] *= gain[c];
                                }
                            }
                            Ok(image)
                        } else {
                            Ok(image::Rgb32FImage::from_pixel(
                                1,
                                1,
                                image::Rgb(
                                    radiance.context("Missing environment radiance")?.to_array(),
                                ),
                            ))
                        }
                    })();
                    match loaded {
                        Ok(image) => {
                            ensure!(
                                image
                                    .pixels()
                                    .all(|p| p.0.iter().all(|c| c.is_finite() && *c >= 0.)),
                                "Invalid scene environment pixels"
                            );
                            result.available |= image.pixels().any(|p| p.0.iter().any(|v| *v > 0.));
                            result.environment = Some(Arc::new(
                                if let Some(previous) = result.environment.take() {
                                    combine(&previous, &image)
                                } else {
                                    image
                                },
                            ));
                        }
                        Err(error) => {
                            if !model
                                .warnings
                                .iter()
                                .any(|warning| warning.starts_with("Scene environment:"))
                            {
                                model.warnings.push(format!("Scene environment: {error:#}"));
                            }
                        }
                    }
                }
                _ => {}
            }
        }
        Ok(result)
    }
}
fn combine(a: &image::Rgb32FImage, b: &image::Rgb32FImage) -> image::Rgb32FImage {
    let (w, h) = (a.width().max(b.width()), a.height().max(b.height()));
    image::Rgb32FImage::from_fn(w, h, |x, y| {
        let a = a.get_pixel(x * a.width() / w, y * a.height() / h).0;
        let b = b.get_pixel(x * b.width() / w, y * b.height() / h).0;
        image::Rgb(std::array::from_fn(|c| a[c] + b[c]))
    })
}
pub fn parse_pfm(bytes: &[u8]) -> Result<image::Rgb32FImage> {
    let mut offset = 0;
    let mut line = || -> Result<&str> {
        loop {
            let end = bytes[offset..]
                .iter()
                .position(|c| *c == b'\n')
                .context("Incomplete PFM header")?
                + offset;
            let text = std::str::from_utf8(&bytes[offset..end])?.trim();
            offset = end + 1;
            if !text.is_empty() && !text.starts_with('#') {
                return Ok(text);
            }
        }
    };
    let format = line()?;
    let channels = match format {
        "PF" => 3,
        "Pf" => 1,
        _ => 0,
    };
    let size: Vec<u32> = line()?
        .split_whitespace()
        .map(str::parse)
        .collect::<std::result::Result<_, _>>()?;
    let scale: f32 = line()?.parse()?;
    ensure!(
        channels > 0
            && size.len() == 2
            && size[0] > 0
            && size[1] > 0
            && scale.is_finite()
            && scale != 0.,
        "Invalid PFM header"
    );
    let (w, h) = (size[0], size[1]);
    ensure!(
        w as u64 * h as u64 <= 16_777_216
            && w as u64 * h as u64 * channels as u64 * 4 == (bytes.len() - offset) as u64,
        "Invalid PFM pixels"
    );
    Ok(image::Rgb32FImage::from_fn(w, h, |x, y| {
        image::Rgb(std::array::from_fn(|c| {
            let at = offset
                + (((h - 1 - y) * w + x) as usize * channels + if channels == 1 { 0 } else { c })
                    * 4;
            let word = bytes[at..at + 4].try_into().unwrap();
            (if scale < 0. {
                f32::from_le_bytes(word)
            } else {
                f32::from_be_bytes(word)
            }) * scale.abs()
        }))
    }))
}
pub fn reproject(
    source: &image::Rgb32FImage,
    transform: Mat4,
    equal_area: bool,
) -> image::Rgb32FImage {
    let width = (source.width() * if equal_area { 2 } else { 1 }).clamp(4, 2048);
    let height = width / 2;
    let inverse = transform.inverse();
    image::Rgb32FImage::from_fn(width, height, |x, y| {
        let theta = (y as f32 + 0.5) / height as f32 * std::f32::consts::PI;
        let phi = (x as f32 + 0.5) / width as f32 * std::f32::consts::TAU;
        let d = inverse
            .transform_vector3(Vec3::new(
                -theta.sin() * phi.cos(),
                theta.cos(),
                -theta.sin() * phi.sin(),
            ))
            .normalize();
        let (u, v) = if equal_area {
            let r = (1. - d.z.abs()).max(0.).sqrt();
            let a = d.y.abs().atan2(d.x.abs()) * 2. / std::f32::consts::PI;
            let (mut sx, mut sy) = (r * (1. - a), r * a);
            if d.z < 0. {
                (sx, sy) = (1. - sy, 1. - sx);
            }
            ((d.x.signum() * sx + 1.) / 2., (d.y.signum() * sy + 1.) / 2.)
        } else {
            (
                (d.y.atan2(d.x) / std::f32::consts::TAU).rem_euclid(1.),
                d.z.clamp(-1., 1.).acos() / std::f32::consts::PI,
            )
        };
        let (px, py) = (
            u * source.width() as f32 - 0.5,
            v * source.height() as f32 - 0.5,
        );
        let (ix, iy) = (px.floor() as i32, py.floor() as i32);
        let (fx, fy) = (px - px.floor(), py - py.floor());
        let mut color = [0.; 3];
        for dy in 0..2 {
            for dx in 0..2 {
                let xx = if equal_area {
                    (ix + dx).clamp(0, source.width() as i32 - 1)
                } else {
                    (ix + dx).rem_euclid(source.width() as i32)
                };
                let yy = (iy + dy).clamp(0, source.height() as i32 - 1);
                let weight =
                    if dx == 1 { fx } else { 1. - fx } * if dy == 1 { fy } else { 1. - fy };
                let p = source.get_pixel(xx as u32, yy as u32);
                for c in 0..3 {
                    color[c] += p.0[c] * weight;
                }
            }
        }
        image::Rgb(color)
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    fn scene_with_environment_source(
        folder: &crate::model_files::tests::Folder,
        source: &str,
    ) -> (Scene, Vec<String>) {
        let path = folder.model("bistro/bistro.glb");
        let mut model =
            mutracer_native_probe::scene_api::viewer_support::Model::load(&path).unwrap();
        let mut json = crate::examples::model_json(&std::fs::read(&path).unwrap()).unwrap();
        json["extras"] = serde_json::json!({"pbrt":{"light_sources":[{
            "gltf":"metadata_only","pbrt":"infinite","source":source,
            "pbrt_transform":[-1,0,0,0,0,0,-1,0,0,1,0,0,0,0,0,1]
        }]}});
        let scene = Scene::load(&json, &path, &mut model).unwrap();
        (scene, model.warnings)
    }
    #[test]
    fn environment_source_normalizes_parent_segments_before_reading_like_web() {
        let folder = crate::model_files::tests::Folder::new();
        folder.hdr("bistro/environment.hdr", [128, 80, 32, 130]);
        assert!(!folder.0.join("source").exists());
        let (scene, warnings) = scene_with_environment_source(&folder, "../bistro/environment.hdr");
        assert!(
            !warnings.iter().any(|w| w.starts_with("Scene environment:")),
            "{warnings:?}"
        );
        let image = scene
            .environment
            .expect("Bistro's companion HDR must load without an intermediate source directory");
        assert_eq!(image.dimensions(), (4, 2));
        assert!(scene.available && scene.authored);
        for pixel in image.pixels() {
            for (actual, expected) in pixel.0.into_iter().zip([2., 1.25, 0.5]) {
                assert!((actual - expected).abs() < 1e-6);
            }
        }
    }
    #[test]
    fn cached_environment_paths_keep_mapping_and_url_decoding() {
        let folder = crate::model_files::tests::Folder::new();
        folder.hdr("bistro/cache/environment light.HDR", [32, 64, 128, 130]);
        let source = "original.hdr";
        let mapping =
            serde_json::json!({"../source/original.hdr":"cache/absent/../environment%20light.HDR"});
        std::fs::write(
            folder.0.join("bistro/resources.json"),
            serde_json::to_vec(&mapping).unwrap(),
        )
        .unwrap();
        let (scene, warnings) = scene_with_environment_source(&folder, source);
        assert!(
            !warnings.iter().any(|w| w.starts_with("Scene environment:")),
            "{warnings:?}"
        );
        let image = scene.environment.unwrap();
        assert_eq!(image.dimensions(), (4, 2));
        assert!((image.get_pixel(0, 0).0[2] - 2.).abs() < 1e-6);
        let (missing, warnings) = scene_with_environment_source(&folder, "actually-missing.hdr");
        assert!(missing.environment.is_none());
        assert!(warnings.iter().any(|w| w.starts_with("Scene environment:")));
    }
    #[test]
    fn pfm_rows_endianness_and_scale() {
        for little in [true, false] {
            let mut data =
                format!("PF\n# test\n1 2\n{}\n", if little { -2 } else { 2 }).into_bytes();
            for v in [1f32, 2., 3., 4., 5., 6.] {
                data.extend(if little {
                    v.to_le_bytes()
                } else {
                    v.to_be_bytes()
                });
            }
            let image = parse_pfm(&data).unwrap();
            assert_eq!(image.get_pixel(0, 0).0, [8., 10., 12.]);
            assert_eq!(image.get_pixel(0, 1).0, [2., 4., 6.]);
            data.pop();
            assert!(parse_pfm(&data).is_err());
        }
    }
    #[test]
    fn cameras_and_lights_follow_active_hierarchy_and_pbrt_transform() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("assets/sample.glb");
        let mut model =
            mutracer_native_probe::scene_api::viewer_support::Model::load(&path).unwrap();
        let json = serde_json::json!({"scene":0,"scenes":[{"nodes":[0]}],"nodes":[{"translation":[2,3,4],"children":[1]},{"camera":0,"translation":[1,0,0]},{"camera":0}],"cameras":[{"perspective":{"yfov":0.5}}],"extras":{"pbrt":{"light_sources":[{"gltf":"metadata_only","pbrt":"distant","radiance_rgb":[8,4,2],"from":[1,0,0],"to":[0,0,0]},{"gltf":"metadata_only","pbrt":"infinite","radiance_rgb":[0.3,0.2,0.1]}]}}});
        let scene = Scene::load(&json, &path, &mut model).unwrap();
        assert_eq!(scene.cameras.len(), 1);
        assert_eq!(
            scene.cameras[0].matrix.w_axis.truncate(),
            Vec3::new(3., 3., 4.)
        );
        assert_eq!(scene.lights.len(), 1);
        assert!(scene.available);
        assert_eq!(
            scene.environment.unwrap().get_pixel(0, 0).0,
            [0.3, 0.2, 0.1]
        );
    }
    #[test]
    fn reprojection_preserves_constant_radiance() {
        let image = image::Rgb32FImage::from_pixel(16, 8, image::Rgb([3., 2., 1.]));
        for equal in [false, true] {
            let result = reproject(&image, Mat4::from_rotation_x(0.7), equal);
            assert!(result.pixels().all(|p| {
                p.0.iter()
                    .zip([3., 2., 1.])
                    .all(|(a, b)| (*a - b).abs() < 1e-5)
            }));
        }
    }
    #[test]
    fn authored_camera_preserves_right_axis_and_navigation_handedness() {
        use crate::renderer::Camera;
        use mutracer_native_probe::layout::camera as c;
        fn world(camera: &Camera) -> Mat4 {
            let bytes = camera.bytes([120, 80]);
            let values: Vec<f32> = bytes[c::TRANSFORM * 4..]
                .chunks_exact(4)
                .map(|b| f32::from_le_bytes(b.try_into().unwrap()))
                .collect();
            Mat4::from_cols_slice(&values)
        }
        for reflected in [false, true] {
            for orthographic in [false, true] {
                let matrix = Mat4::from_scale_rotation_translation(
                    Vec3::new(if reflected { -1. } else { 1. }, 1., 1.),
                    Quat::from_euler(glam::EulerRot::YXZ, 0.6, 0.2, 0.3),
                    Vec3::new(2., 3., 5.),
                );
                let view = View {
                    name: "Imported".into(),
                    matrix,
                    fov: 45.,
                    half_height: orthographic.then_some(2.),
                };
                let mut camera = Camera::fit(Vec3::ZERO, 2.);
                view.apply(&mut camera, Vec3::ZERO);
                let packed = world(&camera);
                for (actual, expected) in [
                    (packed.x_axis, matrix.x_axis),
                    (packed.y_axis, matrix.y_axis),
                    (packed.z_axis, matrix.z_axis),
                ] {
                    assert!(
                        actual
                            .truncate()
                            .normalize()
                            .distance(expected.truncate().normalize())
                            < 1e-5,
                        "Imported camera axis changed: reflected={reflected}, orthographic={orthographic}"
                    );
                }
                let (_, right_ray) = camera.ray([0.75, 0.5], 1.5);
                let (_, center_ray) = camera.ray([0.5, 0.5], 1.5);
                if !orthographic {
                    assert!((right_ray - center_ray).dot(matrix.x_axis.truncate()) > 0.);
                }
                let (center_origin, center_direction) = camera.ray([0.5, 0.5], 1.5);
                let (upper_origin, upper_direction) = camera.ray([0.5, 0.25], 1.5);
                let upper_offset = if orthographic {
                    upper_origin - center_origin
                } else {
                    upper_direction - center_direction
                };
                assert!(upper_offset.dot(matrix.y_axis.truncate()) > 0.);
                camera.orbit([2., 1.]);
                assert_eq!(world(&camera).determinant().is_sign_negative(), reflected);
                let right = world(&camera).x_axis.truncate();
                let target = camera.target;
                camera.pan([2., 0.]);
                assert!((camera.target - target).dot(right) < 0.);
            }
        }
    }
    #[test]
    #[ignore = "requires a real GPU"]
    fn gpu_reflected_camera_image_picking_and_depth_match_source_basis() {
        use crate::renderer::Camera;
        use mutracer_native_probe::{
            api,
            layout::camera as c,
            scene_api::{Geometry, Mesh, OpenPbrMaterial, Scene as RenderScene},
        };
        let mut scene = RenderScene::new();
        for (x, color, z) in [(-1., [1., 0., 0.], 0.5), (1., [0., 0., 1.], 0.)] {
            let geometry = scene
                .add_geometry(Geometry::new(
                    vec![
                        x - 0.8,
                        -1.,
                        z,
                        x + 0.8,
                        -1.,
                        z,
                        x + 0.8,
                        1.,
                        z,
                        x - 0.8,
                        1.,
                        z,
                    ],
                    vec![0, 1, 2, 0, 2, 3],
                ))
                .unwrap();
            let mut material = OpenPbrMaterial::default();
            material.values.color = color;
            material.values.unlit = true;
            material.values.emission = color;
            material.values.emission_strength = 1.;
            let material = scene.add_material(material).unwrap();
            scene.add_mesh(Mesh::new(geometry, material)).unwrap();
        }
        scene.set_indexed_aov_ids(&[0, 1]).unwrap();
        let descriptor = scene.descriptor().unwrap();
        let matrix = Mat4::from_scale_rotation_translation(
            Vec3::new(-1., 1., 1.),
            Quat::IDENTITY,
            Vec3::new(0., 0., 3.),
        );
        for backend in [api::Backend::Software, api::Backend::Hardware] {
            let engine = api::Engine::new(api::EngineOptions { backend }).unwrap();
            engine.display().set_size(48, 32).unwrap();
            engine.set_scene(&descriptor).unwrap();
            let render = api::Render::new(
                &engine,
                api::RenderSettings {
                    max_samples: 8,
                    size: api::RenderSize::Fixed {
                        width: 48,
                        height: 32,
                    },
                    ..Default::default()
                },
            )
            .unwrap();
            for orthographic in [false, true] {
                let view = View {
                    name: "Reflected".into(),
                    matrix,
                    fov: 60.,
                    half_height: orthographic.then_some(1.7),
                };
                let mut camera = Camera::fit(Vec3::ZERO, 2.);
                view.apply(&mut camera, Vec3::ZERO);
                let bytes = camera.bytes([48, 32]);
                let f: Vec<f32> = bytes
                    .chunks_exact(4)
                    .map(|b| f32::from_le_bytes(b.try_into().unwrap()))
                    .collect();
                let actual = api::Camera {
                    projection: u32::from(orthographic),
                    fov: camera.fov,
                    left: f[c::LEFT],
                    right: f[c::RIGHT],
                    bottom: f[c::BOTTOM],
                    top: f[c::TOP],
                    world_matrix: f[c::TRANSFORM..].try_into().unwrap(),
                    ..Default::default()
                };
                let expected = api::Camera {
                    world_matrix: matrix.to_cols_array(),
                    ..actual
                };
                engine.set_camera(Some(actual)).unwrap();
                engine.update().unwrap();
                render.converge(api::ConvergeOptions::new(8)).unwrap();
                let image = render.read_pixels(api::PixelKind::Hdr).unwrap();
                for (x, object) in [(0.25, 1), (0.75, 0)] {
                    assert!(
                        matches!(engine.pick_surface(x,0.5).unwrap(),api::SurfacePick::Hit(hit) if hit.object==object)
                    );
                    let depths = engine
                        .read_depth_samples(api::DepthSampleArea {
                            x,
                            y: 0.5,
                            size: 0.,
                        })
                        .unwrap()
                        .unwrap();
                    let expected_depth = if object == 1 { 3. } else { 2.5 };
                    assert!(depths.iter().all(|d| (*d - expected_depth).abs() < 1e-5));
                }
                engine.set_camera(Some(expected)).unwrap();
                engine.update().unwrap();
                render.converge(api::ConvergeOptions::new(8)).unwrap();
                assert_eq!(
                    image,
                    render.read_pixels(api::PixelKind::Hdr).unwrap(),
                    "Reflected view differs from original matrix"
                );
                let left = (16 * 48 + 12) * 4;
                let right = (16 * 48 + 36) * 4;
                assert!(
                    image.data[left + 2] > image.data[left]
                        && image.data[right] > image.data[right + 2],
                    "Asymmetric scene was mirrored"
                );
            }
        }
    }
}
