//! glTF inputs -> existing OpenPBR inputs, shared by SDK import and the viewer.
//! Contracts: https://github.com/KhronosGroup/glTF/tree/main/extensions/2.0/Khronos
//! No glTF shading code is copied here; the shared MuTracer material slots already
//! implement the glTF channel conventions (linear data; sRGB color textures).
use super::model::Model;
use crate::scene_api::encoder::Material;
use anyhow::{Context, Result, ensure};
use serde_json::Value;
use std::collections::BTreeMap;

pub(super) const EXTENSIONS: &[&str] = &[
    "KHR_materials_clearcoat",
    "KHR_materials_sheen",
    "KHR_materials_specular",
    "KHR_materials_volume",
    "KHR_materials_iridescence",
    "KHR_materials_anisotropy",
    "KHR_materials_dispersion",
];
type Properties = BTreeMap<u32, [u32; 3]>;
type Transform = ([f32; 2], [f32; 2], f32, Option<u32>);
fn number(v: &Value, key: &str, default: f32, min: f32, max: f32) -> Result<f32> {
    let Some(value) = v.get(key) else {
        return Ok(default);
    };
    let value = value
        .as_f64()
        .with_context(|| format!("{key} must be a number"))?;
    ensure!(
        value.is_finite() && value >= min as f64 && value <= max as f64,
        "{key} is out of range"
    );
    Ok(value as f32)
}
fn vector<const N: usize>(
    v: &Value,
    key: &str,
    default: [f32; N],
    min: f32,
    max: f32,
) -> Result<[f32; N]> {
    let Some(value) = v.get(key) else {
        return Ok(default);
    };
    let array = value
        .as_array()
        .with_context(|| format!("{key} must be an array"))?;
    ensure!(array.len() == N, "{key} must have {N} components");
    let mut output = default;
    for i in 0..N {
        let n = array[i]
            .as_f64()
            .with_context(|| format!("Invalid {key} component"))?;
        ensure!(
            n.is_finite() && n >= min as f64 && n <= max as f64,
            "{key} is out of range"
        );
        output[i] = n as f32;
    }
    Ok(output)
}
fn coord(v: &Value, key: &str) -> Result<Option<u32>> {
    v.get(key)
        .map(|n| {
            n.as_u64()
                .filter(|n| *n <= 1)
                .map(|n| n as u32)
                .with_context(|| format!("{key} must select TEXCOORD_0 or TEXCOORD_1"))
        })
        .transpose()
}
fn texture_info<'a>(
    v: &Value,
    doc: &'a gltf::Document,
) -> Result<(gltf::Texture<'a>, u32, Option<Transform>)> {
    ensure!(v.is_object(), "Texture info must be an object");
    let index = v["index"]
        .as_u64()
        .and_then(|i| usize::try_from(i).ok())
        .context("Invalid texture index")?;
    let texture = doc
        .textures()
        .nth(index)
        .context("Texture index is out of range")?;
    let transform = v["extensions"]
        .get("KHR_texture_transform")
        .map(|t| {
            ensure!(t.is_object(), "KHR_texture_transform must be an object");
            Ok::<_, anyhow::Error>((
                vector(t, "offset", [0.; 2], -f32::MAX, f32::MAX)?,
                vector(t, "scale", [1.; 2], -f32::MAX, f32::MAX)?,
                number(t, "rotation", 0., -f32::MAX, f32::MAX)?,
                coord(t, "texCoord")?,
            ))
        })
        .transpose()?;
    Ok((texture, coord(v, "texCoord")?.unwrap_or(0), transform))
}
impl Model {
    pub(super) fn add_json_map(
        &mut self,
        v: &Value,
        doc: &gltf::Document,
        images: &[super::decode::DecodedImage],
        rgba: &[std::sync::Arc<[u8]>],
    ) -> Result<u32> {
        let (texture, uv, transform) = texture_info(v, doc)?;
        self.add_map(texture, uv, transform, images, rgba)
    }
}
fn scalar(p: &mut Properties, id: u32, value: f32) {
    p.insert(id, [value.to_bits(), 0, 0]);
}
fn enum_value(p: &mut Properties, id: u32, value: u32) {
    p.insert(id, [value, 0, 0]);
}

pub(super) fn apply(
    model: &mut Model,
    m: &mut Material,
    raw: &Value,
    doc: &gltf::Document,
    images: &[super::decode::DecodedImage],
    rgba: &[std::sync::Arc<[u8]>],
) -> Result<Properties> {
    let mut properties = Properties::new();
    let extensions = &raw["extensions"];
    let mut bind = |p: &mut Properties, ext: &Value, name: &str, id: u32| -> Result<()> {
        if let Some(info) = ext.get(name) {
            let texture = model
                .add_json_map(info, doc, images, rgba)
                .with_context(|| name.to_owned())?;
            enum_value(p, id, texture);
        }
        Ok(())
    };
    if let Some(transmission) = extensions.get("KHR_materials_transmission") {
        bind(&mut properties, transmission, "transmissionTexture", 49)?;
    }
    for &name in EXTENSIONS {
        let Some(e) = extensions.get(name) else {
            continue;
        };
        ensure!(e.is_object(), "{name} must be an object");
        let result: Result<()> = (|| {
            let l = &mut m.layers;
            match name {
                "KHR_materials_clearcoat" => {
                    l.coat_weight = number(e, "clearcoatFactor", 0., 0., 1.)?;
                    l.coat_roughness = number(e, "clearcoatRoughnessFactor", 0., 0., 1.)?;
                    l.coat_ior = 1.5;
                    scalar(&mut properties, 30, 0.); // glTF has no internal-reflection coat darkening.
                    for (key, id) in [
                        ("clearcoatTexture", 64),
                        ("clearcoatRoughnessTexture", 65),
                        ("clearcoatNormalTexture", 74),
                    ] {
                        bind(&mut properties, e, key, id)?;
                    }
                    if let Some(normal) = e.get("clearcoatNormalTexture") {
                        let scale = number(normal, "scale", 1., -f32::MAX, f32::MAX)?;
                        properties.insert(75, [scale.to_bits(), scale.to_bits(), 0]);
                    }
                }
                "KHR_materials_sheen" => {
                    l.fuzz_weight = 1.;
                    l.fuzz_color = vector(e, "sheenColorFactor", [0.; 3], 0., 1.)?;
                    l.fuzz_roughness = number(e, "sheenRoughnessFactor", 0., 0., 1.)?;
                    bind(&mut properties, e, "sheenColorTexture", 66)?;
                    bind(&mut properties, e, "sheenRoughnessTexture", 67)?;
                }
                "KHR_materials_specular" => {
                    let weight = number(e, "specularFactor", 1., 0., 1.)?;
                    let color = vector(e, "specularColorFactor", [1.; 3], 0., f32::MAX)?;
                    // Match fromTHREE: glTF scales only dielectrics; OpenPBR also
                    // scales metals. A constant fully metallic surface must keep
                    // its specular defaults and ignore these dielectric textures.
                    if m.metalness == 1. && m.maps[2] == u32::MAX {
                        for key in ["specularTexture", "specularColorTexture"] {
                            if let Some(info) = e.get(key) {
                                texture_info(info, doc)?;
                            }
                        }
                    } else {
                        l.specular_weight = weight;
                        l.specular_color = color;
                        bind(&mut properties, e, "specularTexture", 68)?;
                        bind(&mut properties, e, "specularColorTexture", 69)?;
                    }
                }
                "KHR_materials_volume" => {
                    l.thin_walled = number(e, "thicknessFactor", 0., 0., f32::MAX)? == 0.;
                    l.transmission_color = vector(e, "attenuationColor", [1.; 3], 0., 1.)?;
                    l.transmission_depth =
                        number(e, "attenuationDistance", 0., f32::MIN_POSITIVE, f32::MAX)?;
                    // The volume contract explicitly asks ray tracers to use actual
                    // path lengths instead of the rasterizer's baked thickness map.
                    if let Some(info) = e.get("thicknessTexture") {
                        texture_info(info, doc)?;
                    }
                }
                "KHR_materials_iridescence" => {
                    l.film_weight = number(e, "iridescenceFactor", 0., 0., 1.)?;
                    l.film_ior = number(e, "iridescenceIor", 1.3, 1., f32::MAX)?.min(2.5);
                    l.film_thickness =
                        (number(e, "iridescenceThicknessMaximum", 400., 0., f32::MAX)? / 1000.)
                            .min(20.);
                    let minimum = (number(e, "iridescenceThicknessMinimum", 100., 0., f32::MAX)?
                        / 1000.)
                        .min(20.);
                    bind(&mut properties, e, "iridescenceThicknessTexture", 50)?;
                    scalar(&mut properties, 62, minimum);
                    enum_value(&mut properties, 63, 1);
                    // OpenPBR currently exposes a scalar film weight, as fromTHREE
                    // does; do not silently claim support for its separate weight map.
                    if let Some(info) = e.get("iridescenceTexture") {
                        texture_info(info, doc)?;
                    }
                }
                "KHR_materials_anisotropy" => {
                    l.anisotropy = number(e, "anisotropyStrength", 0., 0., 1.)?;
                    scalar(
                        &mut properties,
                        71,
                        number(e, "anisotropyRotation", 0., -f32::MAX, f32::MAX)?,
                    );
                    enum_value(&mut properties, 73, 1);
                    bind(&mut properties, e, "anisotropyTexture", 70)?;
                }
                "KHR_materials_dispersion" => {
                    l.dispersion = number(e, "dispersion", 0., 0., f32::MAX)?.min(1.);
                }
                _ => unreachable!(),
            }
            Ok(())
        })();
        result.with_context(|| name.to_owned())?;
    }
    // Drop the mutable map-loader borrow before reporting optional approximations.
    drop(bind);
    if extensions["KHR_materials_iridescence"]
        .get("iridescenceTexture")
        .is_some()
    {
        model.warnings.push("Iridescence strength textures are ignored; using iridescenceFactor. Thickness textures are supported.".into());
    }
    for (id, slot) in [(49, 6), (50, 7)] {
        if let Some(value) = properties.remove(&id) {
            m.maps[slot] = value[0];
        }
    }
    Ok(properties)
}
