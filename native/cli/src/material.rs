use crate::{
    error::{Error, Result, escape},
    shot::{Channel, MaterialValue, finite},
};
use mutracer_native::scene_api::OpenPbrMaterial;
use serde::Deserialize;
use serde_json::Value;
use std::{collections::BTreeMap, sync::OnceLock};

#[derive(Deserialize)]
struct Property {
    id: u32,
    key: String,
    #[serde(rename = "type")]
    kind: Kind,
    supported: bool,
    #[serde(default)]
    values: Vec<String>,
    #[serde(default, rename = "shotAliases")]
    aliases: Vec<String>,
    #[serde(rename = "shotName")]
    shot_name: Option<String>,
    #[serde(default, rename = "shotMapAliases")]
    map_aliases: Vec<String>,
    #[serde(rename = "shotRange")]
    shot_range: Option<ScalarRange>,
}

#[derive(Clone, Copy, Deserialize)]
struct ScalarRange {
    min: Option<f32>,
    max: Option<f32>,
}

impl ScalarRange {
    fn contains(self, value: f32) -> bool {
        value.is_finite()
            && self.min.is_none_or(|min| value >= min)
            && self.max.is_none_or(|max| value <= max)
    }
}

#[derive(Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Kind {
    Float,
    Vec2,
    Color,
    Bool,
    Enum,
    Texture,
}

fn properties() -> &'static [Property] {
    static PROPERTIES: OnceLock<Vec<Property>> = OnceLock::new();
    PROPERTIES.get_or_init(|| {
        serde_json::from_str(include_str!("../../schemas/material-properties.json"))
            .expect("native material property contract")
    })
}

impl Property {
    fn shot_name(&self) -> &str {
        self.shot_name.as_deref().unwrap_or(&self.key)
    }

    fn shot_aliases(&self) -> impl Iterator<Item = &str> {
        let storage_alias = self.shot_name.as_ref().map(|_| self.key.as_str());
        storage_alias
            .into_iter()
            .chain(self.aliases.iter().map(String::as_str))
    }
}

fn property(key: &str, in_maps: bool) -> Option<&'static Property> {
    properties().iter().find(|p| {
        p.supported
            && if in_maps {
                p.kind == Kind::Texture
                    && (p.key == key || p.map_aliases.iter().any(|alias| alias == key))
            } else {
                p.shot_name() == key || p.shot_aliases().any(|alias| alias == key)
            }
    })
}

pub fn deprecated_fields(material: &Value, pointer: &str, warnings: &mut Vec<(String, String)>) {
    let Some(fields) = material.as_object() else {
        return;
    };
    for key in fields.keys() {
        if let Some(p) = property(key, false).filter(|p| p.shot_name() != key) {
            warnings.push((
                format!("{pointer}/{}", escape(key)),
                format!("Use {}.", p.shot_name()),
            ));
        }
    }
    if let Some(maps) = fields.get("maps").and_then(Value::as_object) {
        if maps.is_empty() {
            warnings.push((
                format!("{pointer}/maps"),
                "Set texture slots directly on the material.".into(),
            ));
        }
        for key in maps.keys() {
            if let Some(p) = property(key, true) {
                warnings.push((
                    format!("{pointer}/maps/{}", escape(key)),
                    format!("Use {} directly on the material.", p.key),
                ));
            }
        }
    }
}

pub fn numeric_property(key: &str) -> Option<(u32, &'static str)> {
    let p = property(key, false)?;
    let ty = match p.kind {
        Kind::Float => "float",
        Kind::Vec2 => "vector2",
        Kind::Color => "color3",
        Kind::Bool => "boolean",
        _ => return None,
    };
    Some((p.id, ty))
}

pub fn editable(key: &str) -> bool {
    property(key, false).is_some_and(|p| p.kind != Kind::Texture)
}

enum Setting {
    Float(Channel<f32>),
    Vec2(Channel<[f32; 2]>),
    Color(Channel<[f32; 3]>),
    Uint(u32),
}

#[derive(Default, Deserialize)]
pub struct Material {
    pub asset: Option<String>,
    pub inputs: Option<BTreeMap<String, Channel<MaterialValue>>>,
    #[serde(default)]
    maps: BTreeMap<String, Value>,
    #[serde(flatten)]
    fields: BTreeMap<String, Value>,
    #[serde(skip)]
    settings: BTreeMap<u32, Setting>,
    #[serde(skip)]
    pub textures: BTreeMap<u32, (String, String)>,
}

impl Material {
    pub fn check(&mut self, duration: f64, pointer: &str) -> Result<()> {
        let mut seen = BTreeMap::new();
        for (fields, in_maps) in [(&self.fields, false), (&self.maps, true)] {
            for (name, raw) in fields {
                let path = if in_maps {
                    format!("{pointer}/maps/{}", escape(name))
                } else {
                    format!("{pointer}/{}", escape(name))
                };
                let p = property(name, in_maps)
                    .filter(|p| !in_maps || p.kind == Kind::Texture)
                    .ok_or_else(|| {
                        Error::validation(
                            &path,
                            format!("Unknown OpenPBR field {name:?}"),
                            "Use a property or texture slot listed by mutracer schema.",
                        )
                    })?;
                if let Some(previous) = seen.insert(p.id, path.clone()) {
                    return Err(Error::validation(
                        &path,
                        format!("The same property was already supplied at {previous}"),
                        format!("Set {} once.", p.shot_name()),
                    ));
                }
                let wrong_type = || {
                    Error::validation(
                        &path,
                        "Invalid material property value",
                        "Use the type and range shown by mutracer schema.",
                    )
                };
                let setting = match p.kind {
                    Kind::Float => {
                        let ch: Channel<f32> =
                            serde_json::from_value(raw.clone()).map_err(|_| wrong_type())?;
                        let range = p.shot_range.expect("shared shot float range");
                        ch.check(&path, duration, "a number in the property's range", |v| {
                            range.contains(v)
                        })?;
                        Setting::Float(ch)
                    }
                    Kind::Vec2 => {
                        let ch: Channel<[f32; 2]> =
                            serde_json::from_value(raw.clone()).map_err(|_| wrong_type())?;
                        ch.check(&path, duration, "two finite numbers", finite)?;
                        Setting::Vec2(ch)
                    }
                    Kind::Color => {
                        let ch: Channel<[f32; 3]> =
                            serde_json::from_value(raw.clone()).map_err(|_| wrong_type())?;
                        ch.check(&path, duration, "nonnegative linear RGB", |rgb| {
                            rgb.into_iter().all(|v| v.is_finite() && v >= 0.)
                        })?;
                        Setting::Color(ch)
                    }
                    Kind::Bool => Setting::Uint(u32::from(raw.as_bool().ok_or_else(wrong_type)?)),
                    Kind::Enum => {
                        let value = raw.as_str().ok_or_else(wrong_type)?;
                        let index =
                            p.values
                                .iter()
                                .position(|item| item == value)
                                .ok_or_else(|| {
                                    Error::validation(
                                        &path,
                                        format!("Unknown {} value {value:?}", p.key),
                                        format!("Use {}.", p.values.join(", ")),
                                    )
                                })?;
                        Setting::Uint(index as u32)
                    }
                    Kind::Texture => {
                        let asset = raw
                            .as_str()
                            .filter(|name| crate::shot::valid_name(name))
                            .ok_or_else(wrong_type)?;
                        self.textures.insert(p.id, (path, asset.to_owned()));
                        continue;
                    }
                };
                self.settings.insert(p.id, setting);
            }
        }
        self.fields.clear();
        self.maps.clear();
        Ok(())
    }

    pub fn has_layered_shading(&self) -> bool {
        ["transmissionWeight", "coatWeight"].into_iter().any(|key| {
            let p = property(key, false).expect("OpenPBR lobe weight");
            self.settings.contains_key(&p.id)
        })
    }

    pub fn apply(&self, material: &mut OpenPbrMaterial, t: f64) {
        for (&id, value) in &self.settings {
            let result = match value {
                Setting::Float(ch) => material.set_float(id, [ch.at(t), 0., 0.]),
                Setting::Vec2(ch) => {
                    let [x, y] = ch.at(t);
                    material.set_float(id, [x, y, 0.])
                }
                Setting::Color(ch) => material.set_float(id, ch.at(t)),
                Setting::Uint(value) => material.set_uint(id, *value),
            };
            result.expect("validated material property");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shot_schema_covers_supported_properties_and_compatibility_names() {
        use std::collections::BTreeSet;

        let schema: Value = serde_json::from_str(crate::shot::SCHEMA).unwrap();
        let definitions = &schema["$defs"];
        let fields = definitions["material"]["properties"].as_object().unwrap();
        let maps = fields["maps"]["properties"].as_object().unwrap();
        let mut expected_fields = BTreeSet::from(["asset", "inputs", "maps"]);
        let mut expected_maps = BTreeSet::new();
        for p in properties().iter().filter(|p| p.supported) {
            assert!(expected_fields.insert(p.shot_name()));
            let definition = &fields[p.shot_name()];
            match p.kind {
                Kind::Float => {
                    let range = p
                        .shot_range
                        .unwrap_or_else(|| panic!("Missing range for {}", p.key));
                    let reference = definition["$ref"].as_str().unwrap();
                    let channel =
                        &definitions[reference.strip_prefix("#/$defs/").unwrap()]["oneOf"];
                    for scalar in [
                        &channel[0],
                        &channel[1]["properties"]["keys"]["items"]["prefixItems"][1],
                    ] {
                        assert_eq!(scalar["type"], "number", "{}", p.key);
                        assert_eq!(
                            scalar["minimum"].as_f64().map(|v| v as f32),
                            range.min,
                            "{}",
                            p.key
                        );
                        assert_eq!(
                            scalar["maximum"].as_f64().map(|v| v as f32),
                            range.max,
                            "{}",
                            p.key
                        );
                    }
                }
                Kind::Vec2 => assert_eq!(definition["$ref"], "#/$defs/vec2Channel"),
                Kind::Color => assert_eq!(definition["$ref"], "#/$defs/colorChannel"),
                Kind::Bool => assert_eq!(definition["type"], "boolean"),
                Kind::Enum => assert_eq!(definition["enum"], serde_json::json!(p.values)),
                Kind::Texture => {
                    assert_eq!(definition["$ref"], "#/$defs/name");
                    assert!(expected_maps.insert(p.key.as_str()));
                    assert_eq!(maps[&p.key], *definition);
                }
            }
            for alias in p.shot_aliases() {
                assert!(expected_fields.insert(alias));
                let mut compatibility = fields[alias].clone();
                assert_eq!(
                    compatibility.as_object_mut().unwrap().remove("deprecated"),
                    Some(Value::Bool(true))
                );
                assert!(
                    compatibility
                        .as_object_mut()
                        .unwrap()
                        .remove("description")
                        .unwrap()
                        .as_str()
                        .unwrap()
                        .contains(p.shot_name())
                );
                assert_eq!(compatibility, *definition, "{alias}");
            }
            for alias in &p.map_aliases {
                assert!(p.kind == Kind::Texture && expected_maps.insert(alias));
                assert_eq!(maps[alias]["$ref"], "#/$defs/name");
                assert_eq!(maps[alias]["deprecated"], true);
                assert!(
                    maps[alias]["description"]
                        .as_str()
                        .unwrap()
                        .contains(&p.key)
                );
            }
        }
        assert_eq!(
            fields.keys().map(String::as_str).collect::<BTreeSet<_>>(),
            expected_fields
        );
        assert_eq!(
            maps.keys().map(String::as_str).collect::<BTreeSet<_>>(),
            expected_maps
        );
        assert_eq!(fields["maps"]["deprecated"], true);
    }

    #[test]
    fn material_uses_shared_property_ids_and_preserves_aliases() {
        let mut m: Material = serde_json::from_value(serde_json::json!({
            "color": [0.1, 0.2, 0.3],
            "specularRoughness": {"keys": [[0,0.2],[1,0.6]]},
            "transmissionScatter": [0.3, 0.2, 0.1],
            "subsurfaceScatterAnisotropy": -0.6,
            "geometryThinWalled": true,
            "maps": {"fuzzColorMap": "cloth", "opacity": "mask"}
        }))
        .unwrap();
        m.check(1., "/material").unwrap();
        assert!(matches!(m.settings[&13], Setting::Color(_)));
        assert!(matches!(m.settings[&21], Setting::Float(_)));
        assert_eq!(m.textures[&66].1, "cloth");
        assert_eq!(m.textures[&40].1, "mask");
        let mut out = OpenPbrMaterial::default();
        m.apply(&mut out, 0.5);
        assert_eq!(out.values.color, [0.1, 0.2, 0.3]);
        assert!((out.values.roughness - 0.4).abs() < 1e-6);
        assert!(out.values.layers.thin_walled);
        let mut duplicate: Material = serde_json::from_value(serde_json::json!({
            "maps": {"normal": "image"}, "normalMap": "other"
        }))
        .unwrap();
        assert!(duplicate.check(1., "/material").is_err());
    }
}
