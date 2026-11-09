//! Studio presets share their data and placement convention with the web viewer.
use glam::{DMat4, DVec3, Vec3};
use mutracer_native::layout::light as wire;
use mutracer_native::viewer_math::{studio_ambient, studio_panel};
use std::sync::OnceLock;

fn placed_panel(args: [f64; 14]) -> [f64; 15] {
    // Camera-only descriptor updates reuse the rig without waiting on the AOT
    // scene queue. Bound the cache while sliders visit new lighting settings.
    thread_local! {
        static PANELS: std::cell::RefCell<Vec<([u64; 14], [f64; 15])>> = const { std::cell::RefCell::new(Vec::new()) };
    }
    let key = args.map(f64::to_bits);
    if let Some(value) =
        PANELS.with(|c| c.borrow().iter().find(|(k, _)| *k == key).map(|(_, v)| *v))
    {
        return value;
    }
    let value = studio_panel(args);
    PANELS.with(|c| {
        let mut c = c.borrow_mut();
        if c.len() == 64 {
            c.remove(0);
        }
        c.push((key, value));
    });
    value
}

pub struct Preset {
    pub name: String,
    pub tag: String,
    lights: Vec<Panel>,
}
struct Panel {
    azimuth: f64,
    elevation: f64,
    distance: f64,
    width: f64,
    height: f64,
    power: f64,
}
pub fn presets() -> &'static [Preset] {
    static PRESETS: OnceLock<Vec<Preset>> = OnceLock::new();
    PRESETS.get_or_init(|| {
        let data: serde_json::Value = serde_json::from_str(include_str!(
            "../../../viewer/src/engine/studio-presets.json"
        ))
        .expect("Built-in studio preset data");
        data.as_array()
            .unwrap()
            .iter()
            .map(|p| Preset {
                name: p["name"].as_str().unwrap().into(),
                tag: p["tag"].as_str().unwrap().into(),
                lights: p["lights"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|l| Panel {
                        azimuth: l["azimuth"].as_f64().unwrap(),
                        elevation: l["elevation"].as_f64().unwrap(),
                        distance: l["distance"].as_f64().unwrap(),
                        width: l["width"].as_f64().unwrap(),
                        height: l["height"].as_f64().unwrap(),
                        power: l["power"].as_f64().unwrap(),
                    })
                    .collect(),
            })
            .collect()
    })
}
#[derive(Clone, PartialEq)]
pub struct Studio {
    pub enabled: bool,
    pub preset: usize,
    pub intensity: f32,
    pub rotation: f32,
    pub size: f32,
    pub ambient: f32,
    pub ambient_color: [f32; 3],
}
impl Default for Studio {
    fn default() -> Self {
        Self {
            enabled: false,
            preset: 0,
            intensity: 1.,
            rotation: 0.,
            size: 1.,
            ambient: 0.1,
            ambient_color: [1.; 3],
        }
    }
}
impl Studio {
    pub fn records(&self, center: Vec3, radius: f32, ground_y: f32) -> Vec<[u32; wire::WORDS]> {
        if !self.enabled {
            return vec![];
        }
        presets()[self.preset]
            .lights
            .iter()
            .map(|panel| {
                let p = placed_panel([
                    center.x as f64,
                    center.y as f64,
                    center.z as f64,
                    radius as f64,
                    panel.azimuth,
                    panel.elevation,
                    panel.distance,
                    panel.width,
                    panel.height,
                    panel.power,
                    self.intensity as f64,
                    self.rotation as f64,
                    self.size as f64,
                    ground_y as f64,
                ]);
                let transform = DMat4::from_cols(
                    DVec3::new(p[3], p[4], p[5]).extend(0.),
                    DVec3::new(p[6], p[7], p[8]).extend(0.),
                    DVec3::new(p[9], p[10], p[11]).extend(0.),
                    DVec3::new(p[12], p[13], p[14]).extend(1.),
                )
                .as_mat4();
                let (width, height, radiance) = (p[0], p[1], p[2]);
                let mut record = [0; wire::WORDS];
                record[wire::COLOR..wire::COLOR + 3].fill(1f32.to_bits());
                record[wire::INTENSITY] = (radiance as f32).to_bits();
                record[wire::SIZE] = (width as f32).to_bits();
                record[wire::HEIGHT_OR_INNER] = (height as f32).to_bits();
                record[wire::SPREAD_OR_OUTER] = 1f32.to_bits();
                for (i, v) in transform.to_cols_array().iter().enumerate() {
                    record[wire::TRANSFORM + i] = v.to_bits();
                }
                record
            })
            .collect()
    }
    pub fn same_ambient(&self, other: &Self) -> bool {
        self.ambient.to_bits() == other.ambient.to_bits()
            && self.ambient_color.map(f32::to_bits) == other.ambient_color.map(f32::to_bits)
    }
    pub fn pixels(&self) -> (u32, u32, Vec<f32>) {
        let mut pixels = Vec::with_capacity(64 * 32 * 4);
        static AMBIENT: OnceLock<Vec<f32>> = OnceLock::new();
        for &value in AMBIENT.get_or_init(studio_ambient) {
            for _ in 0..64 {
                pixels.extend(self.ambient_color.map(|c| value * self.ambient * c));
                pixels.push(1.);
            }
        }
        (64, 32, pixels)
    }
}
