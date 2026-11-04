//! Scene construction with checked, generational handles. Arrays are shared; edits
//! take effect when the scene is passed to `Engine::set_scene_object` and updated.
mod encoder;
mod picking;
mod types;
pub use picking::{Ray, RaycastHit, RaycastOptions, ScenePicker};
#[cfg(feature = "viewer-support")]
#[doc(hidden)]
pub mod viewer_support;
use crate::api::{self, Camera, CommitKind, Result, Status};
use crate::layout::{header as h, light as l, mesh as m};
use glam::{Mat4, Vec3};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
};
pub use types::{Geometry, MaterialLayers};

static NEXT_AOV: AtomicU64 = AtomicU64::new(1);
fn next_aov() -> u32 {
    let id = NEXT_AOV.fetch_add(1, Ordering::Relaxed);
    assert!(id < u32::MAX as u64, "AOV ID space exhausted");
    id as u32
}
static NEXT_SCENE: AtomicU64 = AtomicU64::new(1);
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
struct Key {
    aov: u32,
    owner: u64,
    index: u32,
    generation: u32,
}
macro_rules! ids { ($($id:ident),*) => {$ (
    /// Scene-scoped handle. It becomes invalid when its resource is removed, and
    /// other scenes reject it.
    #[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
    pub struct $id(Key);
    impl $id { /// Stable AOV identity, retained across descriptor publications.
        pub fn aov_id(self)->u32 {self.0.aov}
    }
)*}; }
ids!(GeometryId, MaterialId, TextureId, MeshId, LightId);
#[derive(Clone)]
struct Slot<T> {
    aov: u32,
    generation: u32,
    value: Option<T>,
}
struct Arena<T> {
    slots: Vec<Slot<T>>,
    // Preserve lowest-slot reuse and iteration order without rescanning every
    // occupied slot on each insertion during a large import.
    free: BTreeSet<usize>,
    owner: u64,
}
impl<T> Arena<T> {
    fn new(owner: u64) -> Self {
        Self {
            slots: Vec::new(),
            free: BTreeSet::new(),
            owner,
        }
    }
    fn add(&mut self, value: T) -> Key {
        if let Some(i) = self.free.pop_first() {
            let s = &mut self.slots[i];
            s.value = Some(value);
            s.aov = next_aov();
            return Key {
                aov: s.aov,
                owner: self.owner,
                index: i as u32,
                generation: s.generation,
            };
        }
        let k = Key {
            aov: next_aov(),
            owner: self.owner,
            index: self.slots.len() as u32,
            generation: 1,
        };
        self.slots.push(Slot {
            aov: k.aov,
            generation: 1,
            value: Some(value),
        });
        k
    }
    fn get(&self, k: Key) -> Result<&T> {
        self.slots
            .get(k.index as usize)
            .filter(|s| k.owner == self.owner && s.generation == k.generation)
            .and_then(|s| s.value.as_ref())
            .ok_or_else(invalid_handle)
    }
    fn get_mut(&mut self, k: Key) -> Result<&mut T> {
        self.slots
            .get_mut(k.index as usize)
            .filter(|s| k.owner == self.owner && s.generation == k.generation)
            .and_then(|s| s.value.as_mut())
            .ok_or_else(invalid_handle)
    }
    fn remove(&mut self, k: Key) -> Result<T> {
        self.get(k)?;
        let s = &mut self.slots[k.index as usize];
        let v = s.value.take().unwrap();
        s.generation = s.generation.saturating_add(1);
        if s.generation < u32::MAX {
            self.free.insert(k.index as usize);
        }
        Ok(v)
    }
    fn iter(&self) -> impl Iterator<Item = (Key, &T)> {
        self.slots.iter().enumerate().filter_map(|(i, s)| {
            s.value.as_ref().map(|v| {
                (
                    Key {
                        aov: s.aov,
                        owner: self.owner,
                        index: i as u32,
                        generation: s.generation,
                    },
                    v,
                )
            })
        })
    }
}
fn invalid_handle() -> api::Error {
    api::error(
        Status::InvalidHandle,
        "Invalid, deleted or foreign scene handle",
    )
}
fn invalid(message: &str) -> api::Error {
    api::error(Status::InvalidArgument, message)
}

impl Geometry {
    /// Positions are XYZ and indices are triangle triples. Other attributes default absent.
    pub fn new(positions: impl Into<Arc<[f32]>>, indices: impl Into<Arc<[u32]>>) -> Self {
        let positions = positions.into();
        let mut min = Vec3::splat(f32::INFINITY);
        let mut max = Vec3::splat(f32::NEG_INFINITY);
        for p in positions.chunks_exact(3) {
            let p = Vec3::from_slice(p);
            min = min.min(p);
            max = max.max(p);
        }
        Self {
            positions,
            indices: indices.into(),
            min,
            max,
            normals: Arc::from([]),
            uv: [Arc::from([]), Arc::from([])],
            colors: Arc::from([]),
            tangents: Arc::from([]),
            material_indices: Arc::from([]),
        }
    }
}
/// OpenPBR values. Defaults: gray 0.8, roughness 0.3, IOR 1.5, opaque,
/// no emission, transmission, maps or coating; solid surfaces.
#[derive(Clone)]
pub struct OpenPbrMaterial {
    /// Common OpenPBR values. Other properties use [`OpenPbrMaterial::set_float`]
    /// and [`OpenPbrMaterial::set_uint`].
    pub values: encoder::Material,
    /// Texture slots: base color, normal, metallic-roughness, emissive, roughness,
    /// metalness, transmission, thin film and displacement. [`OpenPbrMaterial::set_texture`]
    /// with those property IDs writes the same slots.
    pub textures: [Option<TextureId>; 9],
    /// Frozen material property IDs; values are three raw words (unused words zero).
    pub(crate) properties: BTreeMap<u32, [u32; 3]>,
    pub(crate) texture_properties: BTreeMap<u32, Option<TextureId>>,
}
impl Default for OpenPbrMaterial {
    fn default() -> Self {
        Self {
            values: encoder::Material {
                name: String::new(),
                color: [0.8; 3],
                roughness: 0.3,
                metalness: 0.,
                opacity: 1.,
                transmission: 0.,
                ior: 1.5,
                emission: [1.; 3],
                emission_strength: 0.,
                maps: [u32::MAX; 9],
                alpha_mode: 0,
                alpha_cutoff: 0.5,
                double_sided: false,
                normal_scale: 1.,
                unlit: false,
                layers: MaterialLayers {
                    thin_walled: false,
                    ..MaterialLayers::default()
                },
            },
            textures: [None; 9],
            properties: BTreeMap::from([(73, [0; 3])]),
            texture_properties: BTreeMap::new(),
        }
    }
}
/// Texture pixels are row-major RGBA. Defaults: repeat, UV0, scale 1, offset 0, no flip.
#[derive(Clone)]
pub struct Texture {
    pub pixels: TexturePixels,
    pub width: u32,
    pub height: u32,
    /// UV set, 0 or 1.
    pub uv: u32,
    /// UV scale; a negative value flips an axis and zero samples a constant coordinate.
    pub scale: [f32; 2],
    pub offset: [f32; 2],
    /// S and T wrap modes: 0 repeat, 1 clamp to edge, 2 mirrored repeat.
    pub wrap: [u32; 2],
    pub flip_y: bool,
}
/// Row-major RGBA pixel storage.
#[derive(Clone)]
pub enum TexturePixels {
    /// Four sRGB bytes per pixel.
    Rgba8(Arc<[u8]>),
    /// Four linear floats per pixel; required for environment and background maps.
    Rgba32F(Arc<[f32]>),
}
impl Texture {
    /// An sRGB RGBA8 texture with the default sampling.
    pub fn rgba8(width: u32, height: u32, pixels: impl Into<Arc<[u8]>>) -> Self {
        Self {
            width,
            height,
            pixels: TexturePixels::Rgba8(pixels.into()),
            uv: 0,
            scale: [1.; 2],
            offset: [0.; 2],
            wrap: [0; 2],
            flip_y: false,
        }
    }
}
/// Local instance matrices and optional RGB multipliers; default colors are white.
#[derive(Clone, Default, PartialEq)]
pub struct Instances {
    pub transforms: Arc<[Mat4]>,
    pub colors: Option<Arc<[f32]>>,
}
/// Geometry placed with a material and a world matrix, optionally instanced.
#[derive(Clone)]
pub struct Mesh {
    pub geometry: GeometryId,
    /// Material used when `materials` is empty.
    pub material: MaterialId,
    /// Material table selected by the geometry's per-vertex material indices.
    pub materials: Vec<MaterialId>,
    /// Column-major local-to-world matrix.
    pub transform: Mat4,
    /// Local instance matrices inside `transform`; `None` for an ordinary mesh.
    pub instances: Option<Instances>,
}
impl Mesh {
    /// One ordinary mesh, identity world matrix, no per-vertex material table.
    pub fn new(geometry: GeometryId, material: MaterialId) -> Self {
        Self {
            geometry,
            material,
            materials: vec![],
            transform: Mat4::IDENTITY,
            instances: None,
        }
    }
}
/// Analytic light with a linear RGB color. Rectangular, spot and directional
/// lights emit along the local -Z axis of `transform`.
#[derive(Clone)]
pub enum Light {
    /// `width` × `height` rectangle with `spread` and an optional texture.
    Rect {
        color: [f32; 3],
        intensity: f32,
        width: f32,
        height: f32,
        spread: f32,
        transform: Mat4,
        texture: Option<TextureId>,
    },
    /// Sphere of `radius`.
    Sphere {
        color: [f32; 3],
        intensity: f32,
        radius: f32,
        transform: Mat4,
    },
    /// Parallel light.
    Directional {
        color: [f32; 3],
        intensity: f32,
        transform: Mat4,
    },
    /// Cone with `inner` and `outer` angles in degrees; `ies` is LM-63 profile
    /// text, empty for none.
    Spot {
        color: [f32; 3],
        intensity: f32,
        inner: f32,
        outer: f32,
        transform: Mat4,
        ies: Arc<[u8]>,
    },
}
/// Environment/background map handles; None disables each map. Default black,
/// opaque background and no environment. Maps use their linear pixel values.
#[derive(Clone)]
pub struct Environment {
    pub texture: Option<TextureId>,
    pub background: Option<TextureId>,
    pub color: [f32; 4],
}
impl Default for Environment {
    fn default() -> Self {
        Self {
            texture: None,
            background: None,
            color: [0., 0., 0., 1.],
        }
    }
}

/// Camera background projected onto a level floor and surrounding dome.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GroundedBackground {
    /// Capture height above the floor in scene units; finite and positive.
    pub height: f32,
    /// Dome radius in scene units; finite and greater than height.
    pub radius: f32,
    /// Floor Y in scene units. Default usage is 0.
    pub ground_height: f32,
    /// Capture center X/Z in scene units. Default usage is [0, 0].
    pub center: [f32; 2],
}
impl GroundedBackground {
    fn values(self) -> [f32; 6] {
        [
            self.height,
            self.radius,
            self.ground_height,
            self.center[0],
            self.center[1],
            0.,
        ]
    }
    fn encode(value: Option<Self>, words: &mut Vec<u32>) {
        let Some(value) = value else {
            words[h::GROUNDED_BACKGROUND] = 0;
            return;
        };
        let at = if words[h::GROUNDED_BACKGROUND] == 0 {
            let at = words.len();
            words.resize(at + 6, 0);
            words[h::GROUNDED_BACKGROUND] = at as u32;
            at
        } else {
            words[h::GROUNDED_BACKGROUND] as usize
        };
        for (i, v) in value.values().into_iter().enumerate() {
            words[at + i] = v.to_bits();
        }
        words[h::LENGTH] = words.len() as u32;
    }
}
/// Independent environment lighting and visible background controls. Settings
/// persist when map handles change. They do not alter the source texture pixels.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct EnvironmentSettings {
    /// Nonnegative lighting radiance multiplier. Default 1; 0 disables illumination.
    pub intensity: f32,
    /// Environment local-to-world yaw about +Y, in radians. Default 0.
    pub rotation: f32,
    /// Nonnegative background-map radiance multiplier. Default 1; ignored for colors.
    pub background_intensity: f32,
    /// Background-map yaw about +Y, in radians, independent of lighting. Default 0.
    pub background_rotation: f32,
}
impl Default for EnvironmentSettings {
    fn default() -> Self {
        Self {
            intensity: 1.,
            rotation: 0.,
            background_intensity: 1.,
            background_rotation: 0.,
        }
    }
}
impl EnvironmentSettings {
    fn values(self) -> [f32; 4] {
        [
            self.intensity,
            self.rotation,
            self.background_intensity,
            self.background_rotation,
        ]
    }
    fn encode(self, words: &mut Vec<u32>) {
        if self == Self::default() && words[h::ENVIRONMENT_SETTINGS] == 0 {
            return;
        }
        let at = if words[h::ENVIRONMENT_SETTINGS] == 0 {
            let at = words.len();
            words[h::ENVIRONMENT_SETTINGS] = at as u32;
            words.resize(at + 4, 0);
            at
        } else {
            words[h::ENVIRONMENT_SETTINGS] as usize
        };
        for (i, value) in self.values().into_iter().enumerate() {
            words[at + i] = value.to_bits();
        }
        words[h::LENGTH] = words.len() as u32;
    }
}

#[derive(Default)]
struct Dirty {
    geometry: BTreeSet<Key>,
    material: BTreeSet<Key>,
    texture: BTreeSet<Key>,
    mesh: BTreeSet<Key>,
    light: BTreeSet<Key>,
    structure: bool,
    environment: bool,
    camera: bool,
}
struct Cache {
    bytes: Arc<Vec<u8>>,
    words: Vec<u32>,
    revision: u64,
    geometries: Vec<Geometry>,
    textures: Vec<encoder::Texture>,
}
/// A flat scene. Handles are scoped to this scene; removing referenced resources
/// returns InvalidHandle until their users are edited or removed.
pub struct Scene {
    aov_handles: std::collections::HashMap<Key, u32>,
    geometries: Arena<Geometry>,
    materials: Arena<OpenPbrMaterial>,
    textures: Arena<Texture>,
    meshes: Arena<Mesh>,
    lights: Arena<Light>,
    environment: Environment,
    environment_settings: EnvironmentSettings,
    grounded_background: Option<GroundedBackground>,
    camera: Option<Camera>,
    dirty: Mutex<Dirty>,
    revision: u64,
    cache: Mutex<Option<Cache>>,
}
impl Default for Scene {
    fn default() -> Self {
        Self::new()
    }
}
impl Scene {
    /// An empty scene with no camera and a black environment.
    pub fn new() -> Self {
        let owner = NEXT_SCENE.fetch_add(1, Ordering::Relaxed);
        Self {
            aov_handles: Default::default(),
            geometries: Arena::new(owner),
            materials: Arena::new(owner),
            textures: Arena::new(owner),
            meshes: Arena::new(owner),
            lights: Arena::new(owner),
            environment: Environment::default(),
            environment_settings: EnvironmentSettings::default(),
            grounded_background: None,
            camera: None,
            dirty: Mutex::new(Dirty {
                structure: true,
                ..Dirty::default()
            }),
            revision: 1,
            cache: Mutex::new(None),
        }
    }
    fn changed(&mut self) {
        self.revision += 1;
    }
    /// Sets the environment map, background map and background color. Map
    /// handles must belong to this scene and use RGBA32F pixels.
    pub fn set_environment(&mut self, environment: Environment) -> Result<()> {
        for id in [environment.texture, environment.background]
            .into_iter()
            .flatten()
        {
            self.textures.get(id.0)?;
        }
        self.environment = environment;
        self.dirty.get_mut().unwrap().environment = true;
        self.changed();
        Ok(())
    }
    /// Projects the visible background map onto a floor/dome, or disables it
    /// with `None` (default). Illumination stays unchanged. Invalid nonfinite or
    /// nonpositive dimensions return `InvalidArgument` without changing the scene.
    pub fn set_grounded_background(&mut self, value: Option<GroundedBackground>) -> Result<()> {
        if value.is_some_and(|v| {
            v.values().iter().any(|n| !n.is_finite()) || v.height <= 0. || v.radius <= v.height
        }) {
            return Err(invalid(
                "Grounded background requires positive height and a larger radius",
            ));
        }
        self.grounded_background = value;
        self.dirty.get_mut().unwrap().environment = true;
        self.changed();
        Ok(())
    }
    /// Changes environment/background-map strength and yaw without replacing maps.
    /// Values must be finite and intensities nonnegative; invalid settings leave
    /// the scene unchanged. Existing maps update incrementally on the next commit.
    pub fn set_environment_settings(&mut self, settings: EnvironmentSettings) -> Result<()> {
        if settings.values().iter().any(|v| !v.is_finite())
            || settings.intensity < 0.
            || settings.background_intensity < 0.
        {
            return Err(invalid(
                "Environment settings must be finite with nonnegative intensity",
            ));
        }
        self.environment_settings = settings;
        self.dirty.get_mut().unwrap().environment = true;
        self.changed();
        Ok(())
    }
    /// Current environment/background controls, initially [`EnvironmentSettings::default`].
    pub fn environment_settings(&self) -> EnvironmentSettings {
        self.environment_settings
    }
    /// Optional fallback camera, default the standard 45 degree perspective camera.
    pub fn set_default_camera(&mut self, camera: Option<Camera>) {
        self.camera = camera;
        self.dirty.get_mut().unwrap().camera = true;
        self.changed();
    }
}
macro_rules! resources {($($name:ident,$add:ident,$get:ident,$edit:ident,$remove:ident,$ty:ty,$id:ident,$dirty:ident);* $(;)?)=>{$(impl Scene {
    #[doc = concat!("Adds a [`", stringify!($ty), "`] and returns its handle. Resources it references must belong to this scene.")]
    pub fn $add(&mut self,value:$ty)->Result<$id> {value.validate_references(self)?;let k=self.$name.add(value);self.dirty.get_mut().unwrap().structure=true;self.changed();Ok($id(k))}
    #[doc = concat!("Borrows a [`", stringify!($ty), "`] by handle.")]
    pub fn $get(&self,id:$id)->Result<&$ty> {self.$name.get(id.0)}
    #[doc = concat!("Mutably borrows a [`", stringify!($ty), "`] and marks it changed for the next snapshot.")]
    pub fn $edit(&mut self,id:$id)->Result<&mut $ty> {self.$name.get(id.0)?;self.dirty.get_mut().unwrap().$dirty.insert(id.0);self.changed();self.$name.get_mut(id.0)}
    #[doc = concat!("Removes a [`", stringify!($ty), "`]; encoding returns InvalidHandle while other resources still reference it.")]
    pub fn $remove(&mut self,id:$id)->Result<()> {self.$name.remove(id.0)?;self.dirty.get_mut().unwrap().structure=true;self.changed();Ok(())}
})*};}
resources! {
 geometries,add_geometry,geometry,geometry_mut,remove_geometry,Geometry,GeometryId,geometry;
 materials,add_material,material,material_mut,remove_material,OpenPbrMaterial,MaterialId,material;
 textures,add_texture,texture,texture_mut,remove_texture,Texture,TextureId,texture;
 meshes,add_mesh,mesh,mesh_mut,remove_mesh,Mesh,MeshId,mesh;
 lights,add_light,light,light_mut,remove_light,Light,LightId,light;
}
struct Resolved {
    geometries: Vec<Geometry>,
    materials: Vec<encoder::Material>,
    textures: Vec<encoder::Texture>,
    meshes: Vec<encoder::Mesh>,
    lights: Vec<[u32; l::WORDS]>,
    ies: Vec<Arc<[u8]>>,
    properties: Vec<BTreeMap<u32, [u32; 3]>>,
    environment: Environment,
    environment_index: u32,
    background_index: u32,
}
fn index<T>(a: &Arena<T>, k: Key) -> Result<usize> {
    a.get(k)?;
    a.iter()
        .position(|(key, _)| key == k)
        .ok_or_else(invalid_handle)
}
impl Scene {
    fn resolve(&self) -> Result<Resolved> {
        for (_, g) in self.geometries.iter() {
            let vertices = g.positions.len() / 3;
            if g.positions.len() % 3 != 0
                || g.indices.len() % 3 != 0
                || [
                    (g.normals.len(), 3),
                    (g.uv[0].len(), 2),
                    (g.uv[1].len(), 2),
                    (g.colors.len(), 3),
                    (g.tangents.len(), 4),
                    (g.material_indices.len(), 1),
                ]
                .iter()
                .any(|&(len, n)| len != 0 && len != vertices * n)
            {
                return Err(invalid("Invalid geometry attribute length"));
            }
        }
        for (_, t) in self.textures.iter() {
            let pixels = match &t.pixels {
                TexturePixels::Rgba8(p) => p.len(),
                TexturePixels::Rgba32F(p) => p.len(),
            };
            if pixels as u64 != u64::from(t.width) * u64::from(t.height) * 4 {
                return Err(invalid("Invalid texture pixel length"));
            }
        }
        for (_, m) in self.meshes.iter() {
            if let Some(i) = &m.instances {
                if i.colors
                    .as_ref()
                    .is_some_and(|c| c.len() != i.transforms.len() * 3)
                {
                    return Err(invalid("Invalid instance color length"));
                }
            }
        }
        let mut r = Resolved {
            geometries: self.geometries.iter().map(|(_, g)| g.clone()).collect(),
            materials: vec![],
            textures: vec![],
            meshes: vec![],
            lights: vec![],
            ies: vec![],
            properties: vec![],
            environment: self.environment.clone(),
            environment_index: 0,
            background_index: 0,
        };
        for (_, t) in self.textures.iter() {
            let (storage, pixels, float_pixels) = match &t.pixels {
                TexturePixels::Rgba8(p) => (0, p.clone(), None),
                TexturePixels::Rgba32F(p) => (1, Arc::from([]), Some(p.clone())),
            };
            r.textures.push(encoder::Texture {
                float_pixels,
                storage,
                flip_y: t.flip_y,
                source: usize::MAX,
                width: t.width,
                height: t.height,
                pixels,
                uv: t.uv,
                scale: t.scale,
                offset: t.offset,
                wrap: t.wrap,
            });
        }
        for (_, material) in self.materials.iter() {
            let mut v = material.values.clone();
            for (slot, id) in material.textures.iter().enumerate() {
                v.maps[slot] = id
                    .map(|id| index(&self.textures, id.0))
                    .transpose()?
                    .map_or(u32::MAX, |i| i as u32);
            }
            r.materials.push(v);
            let mut properties = material.properties.clone();
            for (&id, texture) in &material.texture_properties {
                properties.insert(
                    id,
                    [
                        texture
                            .map(|id| index(&self.textures, id.0))
                            .transpose()?
                            .map_or(u32::MAX, |i| i as u32),
                        0,
                        0,
                    ],
                );
            }
            r.properties.push(properties);
        }
        for (_, mesh) in self.meshes.iter() {
            r.meshes.push(encoder::Mesh {
                name: String::new(),
                geometry: index(&self.geometries, mesh.geometry.0)?,
                material: index(&self.materials, mesh.material.0)?,
                materials: mesh
                    .materials
                    .iter()
                    .map(|id| index(&self.materials, id.0))
                    .collect::<Result<_>>()?,
                transform: mesh.transform,
                instances: mesh.instances.clone(),
            });
        }
        for (_, light) in self.lights.iter() {
            let mut w = [0; l::WORDS];
            let mut ies = Arc::from([]);
            let (kind, color, intensity, transform) = match light {
                Light::Rect {
                    color,
                    intensity,
                    width,
                    height,
                    spread,
                    transform,
                    texture,
                } => {
                    w[l::SIZE] = width.to_bits();
                    w[l::HEIGHT_OR_INNER] = height.to_bits();
                    w[l::SPREAD_OR_OUTER] = spread.to_bits();
                    w[l::TEXTURE] = texture
                        .map(|id| index(&self.textures, id.0))
                        .transpose()?
                        .map_or(0, |i| i as u32 + 1);
                    (0, color, intensity, transform)
                }
                Light::Sphere {
                    color,
                    intensity,
                    radius,
                    transform,
                } => {
                    w[l::SIZE] = radius.to_bits();
                    (1, color, intensity, transform)
                }
                Light::Directional {
                    color,
                    intensity,
                    transform,
                } => (2, color, intensity, transform),
                Light::Spot {
                    color,
                    intensity,
                    inner,
                    outer,
                    transform,
                    ies: profile,
                } => {
                    w[l::HEIGHT_OR_INNER] = inner.to_bits();
                    w[l::SPREAD_OR_OUTER] = outer.to_bits();
                    ies = profile.clone();
                    (3, color, intensity, transform)
                }
            };
            w[l::TYPE] = kind;
            w[l::INTENSITY] = intensity.to_bits();
            for i in 0..3 {
                w[l::COLOR + i] = color[i].to_bits();
            }
            for (i, v) in transform.to_cols_array().iter().enumerate() {
                w[l::TRANSFORM + i] = v.to_bits();
            }
            r.lights.push(w);
            r.ies.push(ies);
        }
        r.environment_index = self
            .environment
            .texture
            .map(|id| index(&self.textures, id.0))
            .transpose()?
            .map_or(0, |i| i as u32 + 1);
        r.background_index = self
            .environment
            .background
            .map(|id| index(&self.textures, id.0))
            .transpose()?
            .map_or(0, |i| i as u32 + 1);
        Ok(r)
    }
    fn next_words(&self, previous: Option<&[u32]>) -> Result<Vec<u32>> {
        let mut words = previous.unwrap_or(&[]).to_vec();
        self.encode_into(&mut words, None)?;
        Ok(words)
    }
    fn write_aov_ids(&self, words: &mut Vec<u32>) {
        for (field, ids) in [
            (
                h::MESH_AOV_IDS,
                self.meshes
                    .iter()
                    .map(|(key, _)| self.aov_handles.get(&key).copied().unwrap_or(key.aov))
                    .collect::<Vec<_>>(),
            ),
            (
                h::MATERIAL_AOV_IDS,
                self.materials
                    .iter()
                    .map(|(key, _)| self.aov_handles.get(&key).copied().unwrap_or(key.aov))
                    .collect::<Vec<_>>(),
            ),
        ] {
            if words[field] == 0 {
                words[field] = words.len() as u32;
                words.resize(words.len() + ids.len(), 0);
            }
            let offset = words[field] as usize;
            words[offset..offset + ids.len()].copy_from_slice(&ids);
        }
        words[h::LENGTH] = words.len() as u32;
    }
    fn encode_into(
        &self,
        words: &mut Vec<u32>,
        previous: Option<(&[Geometry], &[encoder::Texture])>,
    ) -> Result<()> {
        let r = self.resolve()?;
        let camera = self.camera.unwrap_or_default().to_bytes();
        let env = encoder::Environment {
            enabled: false,
            width: 0,
            height: 0,
            pixels: Arc::from([]),
            background: false,
            background_color: [
                r.environment.color[0],
                r.environment.color[1],
                r.environment.color[2],
            ],
            background_alpha: r.environment.color[3],
        };
        let data = encoder::SceneData {
            properties: &r.properties,
            geometries: &r.geometries,
            materials: &r.materials,
            textures: &r.textures,
            meshes: &r.meshes,
            lights: r.lights.clone(),
            ies: r.ies.clone(),
        };
        let count = data
            .word_count(&env)
            .map_err(|e| api::error(Status::InvalidArgument, e.to_string()))?;
        // Camera/environment settings and stable identity tables are appended below.
        let total = count
            .checked_add(r.meshes.len() + r.materials.len() + 22)
            .filter(|n| *n <= u32::MAX as usize)
            .ok_or_else(|| {
                api::error(
                    Status::InvalidArgument,
                    "Scene descriptor word offsets overflow",
                )
            })?;
        crate::memory_budget::check(total * 4, "Scene descriptor")
            .map_err(|e| api::error(Status::InvalidArgument, e.to_string()))?;
        if !data.patch_selected(words, &camera, [1, 1], &env, previous) {
            *words = data.encode(&camera, [1, 1], &env);
        }
        words[h::ENVIRONMENT_TEXTURE] = r.environment_index;
        words[h::BACKGROUND_TEXTURE] = r.background_index;
        self.environment_settings.encode(words);
        GroundedBackground::encode(self.grounded_background, words);
        self.write_aov_ids(words);
        Ok(())
    }
    /// Encodes an immutable snapshot. Repeated calls without edits share one buffer.
    pub fn descriptor(&self) -> Result<Arc<Vec<u8>>> {
        let mut cache = self.cache.lock().unwrap();
        if let Some(c) = &*cache {
            if c.revision == self.revision {
                return Ok(c.bytes.clone());
            }
        }
        let mut words = cache
            .as_mut()
            .map(|c| std::mem::take(&mut c.words))
            .unwrap_or_default();
        if let Err(e) = self.encode_into(
            &mut words,
            cache
                .as_ref()
                .map(|c| (c.geometries.as_slice(), c.textures.as_slice())),
        ) {
            if let Some(c) = cache.as_mut() {
                c.words = bytemuck::pod_collect_to_vec::<u8, u32>(&c.bytes);
            }
            return Err(e);
        }
        let mut bytes = cache
            .as_mut()
            .and_then(|c| Arc::get_mut(&mut c.bytes))
            .map(std::mem::take)
            .unwrap_or_default();
        bytes.clear();
        bytes.extend_from_slice(bytemuck::cast_slice(&words));
        if let Err(e) = crate::scene::validate(&bytes) {
            *cache = None;
            return Err(api::error(Status::InvalidArgument, e.to_string()));
        }
        let r = self.resolve()?;
        let bytes = Arc::new(bytes);
        *cache = Some(Cache {
            bytes: bytes.clone(),
            words,
            revision: self.revision,
            geometries: r.geometries,
            textures: r.textures,
        });
        *self.dirty.lock().unwrap() = Dirty::default();
        Ok(bytes)
    }
    /// Predicts the next descriptor commit using the retained update planner.
    /// Full is returned before the first snapshot; the engine reports the actual result.
    pub fn pending_commit_kind(&self) -> Result<CommitKind> {
        let cache = self.cache.lock().unwrap();
        let Some(c) = &*cache else {
            return Ok(CommitKind::Full);
        };
        if c.revision == self.revision {
            return Ok(CommitKind::Incremental);
        }
        let next = self.next_words(Some(&c.words))?;
        let bytes: Vec<u8> = bytemuck::cast_slice(&next).to_vec();
        crate::scene::validate(&bytes).map_err(|e| invalid(&e.to_string()))?;
        Ok(predict(&c.bytes, &bytes))
    }
}
fn predict(previous: &[u8], next: &[u8]) -> CommitKind {
    let a: Vec<u32> = bytemuck::pod_collect_to_vec::<u8, u32>(previous);
    let b: Vec<u32> = bytemuck::pod_collect_to_vec::<u8, u32>(next);
    if [h::GEOMETRY_COUNT, h::MESH_COUNT, h::MATERIAL_COUNT]
        .iter()
        .any(|&i| a[i] != b[i])
    {
        return CommitKind::Full;
    }
    let n = b[h::MESH_COUNT] as usize;
    let mut structural = false;
    for i in 0..n {
        let ao = a[h::MESH_OFFSET] as usize + i * m::WORDS;
        let bo = b[h::MESH_OFFSET] as usize + i * m::WORDS;
        if a[ao..ao + 4] != b[bo..bo + 4] {
            structural = true;
        }
    }
    let mut colors = Vec::new();
    for i in 0..n {
        let (aa, bb) = (a[h::BATCH_OFFSET] as usize, b[h::BATCH_OFFSET] as usize);
        if (aa == 0) != (bb == 0) {
            structural = true;
            continue;
        }
        if aa != 0 {
            let ao = aa + i * crate::layout::batch::WORDS;
            let bo = bb + i * crate::layout::batch::WORDS;
            if a[ao] != b[bo] {
                structural = true;
                continue;
            }
            if b[bo] != u32::MAX {
                let (ac, bc) = (a[ao + 2] as usize, b[bo + 2] as usize);
                let count = b[bo] as usize * 3;
                if (ac == 0) != (bc == 0) {
                    structural = true;
                } else if ac != 0 && a[ac..ac + count] != b[bc..bc + count] {
                    colors.push(i);
                }
            }
        }
    }
    let sync = crate::scene::SceneSync {
        meshes: if structural { 2 } else { 1 },
        lights: true,
        background: true,
        camera: true,
        resolution: false,
        quality: false,
        transforms: (0..n).collect(),
        colors,
        geometries: (0..b[h::GEOMETRY_COUNT] as usize).collect(),
        materials: (0..b[h::MATERIAL_COUNT] as usize).collect(),
    };
    if !crate::commit_plan::displacement_map_changed(previous, next)
        && crate::commit_plan::plan(previous, next, &sync, true).is_some()
    {
        CommitKind::Incremental
    } else {
        CommitKind::Full
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn arena_reuses_lowest_hole_without_reviving_handles_or_exhausted_slots() {
        let mut arena = Arena::new(17);
        let first = arena.add(10);
        let second = arena.add(20);
        let third = arena.add(30);
        arena.remove(second).unwrap();
        arena.remove(first).unwrap();
        assert!(arena.remove(first).is_err());
        let replacement = arena.add(40);
        assert_eq!(replacement.index, first.index);
        assert_ne!(replacement.aov, first.aov);
        assert!(arena.get(first).is_err());
        assert!(arena.get(second).is_err());
        assert!(
            arena
                .get(Key {
                    owner: 18,
                    ..replacement
                })
                .is_err()
        );
        let exhausted = Key {
            generation: u32::MAX - 1,
            ..third
        };
        arena.slots[third.index as usize].generation = exhausted.generation;
        arena.remove(exhausted).unwrap();
        assert_eq!(arena.add(50).index, second.index);
        assert_eq!(arena.add(60).index, 3);
        assert_eq!(
            arena.iter().map(|(_, v)| *v).collect::<Vec<_>>(),
            [40, 50, 60]
        );
    }
    fn triangle() -> (Scene, MeshId) {
        let mut s = Scene::new();
        let g = s
            .add_geometry(Geometry::new(
                vec![-1., 0., 0., 1., 0., 0., 0., 1., 0.],
                vec![0, 1, 2],
            ))
            .unwrap();
        let m = s.add_material(OpenPbrMaterial::default()).unwrap();
        let mesh = s.add_mesh(Mesh::new(g, m)).unwrap();
        (s, mesh)
    }
    #[test]
    fn handles_are_typed_generational_and_scene_scoped() {
        let (mut s, mesh) = triangle();
        let old = s.mesh(mesh).unwrap().geometry;
        s.remove_geometry(old).unwrap();
        assert_eq!(s.descriptor().unwrap_err().status, Status::InvalidHandle);
        let new = s
            .add_geometry(Geometry::new(vec![0.; 9], vec![0, 1, 2]))
            .unwrap();
        assert_ne!(old, new);
        assert_eq!(s.geometry(old).err().unwrap().status, Status::InvalidHandle);
        let other = Scene::new();
        assert_eq!(
            other.geometry(new).err().unwrap().status,
            Status::InvalidHandle
        );
    }
    #[test]
    fn cached_encoding_and_incremental_edits_match_full_encoder() {
        let (mut s, mesh) = triangle();
        assert_eq!(s.pending_commit_kind().unwrap(), CommitKind::Full);
        let initial = s.descriptor().unwrap();
        assert!(Arc::ptr_eq(&initial, &s.descriptor().unwrap()));
        s.mesh_mut(mesh).unwrap().transform = Mat4::from_translation(Vec3::new(0.2, 0., 0.));
        assert_eq!(s.pending_commit_kind().unwrap(), CommitKind::Incremental);
        let patched = s.descriptor().unwrap();
        let full = s
            .next_words(None)
            .unwrap()
            .iter()
            .flat_map(|w| w.to_le_bytes())
            .collect::<Vec<_>>();
        assert_eq!(*patched, full);
        let g = s.mesh(mesh).unwrap().geometry;
        Arc::make_mut(&mut s.geometry_mut(g).unwrap().positions)[0] -= 0.1;
        assert_eq!(s.pending_commit_kind().unwrap(), CommitKind::Incremental);
        s.descriptor().unwrap();
        let m = s.mesh(mesh).unwrap().material;
        s.material_mut(m).unwrap().values.roughness = 0.7;
        assert_eq!(s.pending_commit_kind().unwrap(), CommitKind::Incremental);
        s.descriptor().unwrap();
        let g = s.geometry_mut(g).unwrap();
        g.indices = vec![2, 1, 0].into();
        assert_eq!(s.pending_commit_kind().unwrap(), CommitKind::Full);
    }
    #[test]
    fn synthetic_records_and_patch_match_full() {
        let (mut s, mesh) = triangle();
        let texture = s.add_texture(Texture::rgba8(1, 1, vec![255; 4])).unwrap();
        let m = s.mesh(mesh).unwrap().material;
        s.material_mut(m).unwrap().textures[0] = Some(texture);
        let hdr = s
            .add_texture(Texture {
                pixels: TexturePixels::Rgba32F(vec![1.; 4].into()),
                ..Texture::rgba8(1, 1, vec![])
            })
            .unwrap();
        s.set_environment(Environment {
            texture: Some(hdr),
            background: Some(hdr),
            ..Environment::default()
        })
        .unwrap();
        let mat2 = s.add_material(OpenPbrMaterial::default()).unwrap();
        s.mesh_mut(mesh).unwrap().materials = vec![m, mat2];
        let geo = s.mesh(mesh).unwrap().geometry;
        s.geometry_mut(geo).unwrap().material_indices = vec![0, 1, 0].into();
        s.geometry_mut(geo).unwrap().uv[0] = vec![0.; 6].into();
        s.mesh_mut(mesh).unwrap().instances = Some(Instances {
            transforms: vec![Mat4::IDENTITY, Mat4::from_translation(Vec3::X)].into(),
            colors: Some(vec![1.; 6].into()),
        });
        for light in [
            Light::Rect {
                color: [1.; 3],
                intensity: 1.,
                width: 1.,
                height: 1.,
                spread: 1.,
                transform: Mat4::IDENTITY,
                texture: Some(texture),
            },
            Light::Sphere {
                color: [1.; 3],
                intensity: 1.,
                radius: 0.5,
                transform: Mat4::IDENTITY,
            },
            Light::Directional {
                color: [1.; 3],
                intensity: 1.,
                transform: Mat4::IDENTITY,
            },
            Light::Spot {
                color: [1.; 3],
                intensity: 1.,
                inner: 10.,
                outer: 30.,
                transform: Mat4::IDENTITY,
                ies: Arc::from([]),
            },
        ] {
            s.add_light(light).unwrap();
        }
        s.descriptor().unwrap();
        s.texture_mut(texture).unwrap().scale = [2., 3.];
        let a = s.descriptor().unwrap();
        let b = s
            .next_words(None)
            .unwrap()
            .iter()
            .flat_map(|w| w.to_le_bytes())
            .collect::<Vec<_>>();
        assert_eq!(*a, b);
    }
}
#[cfg(any(feature = "gltf", feature = "viewer-support"))]
mod descriptor;
#[cfg(test)]
mod gpu_tests;

#[cfg(feature = "gltf")]
mod gltf;
#[cfg(feature = "gltf")]
pub use gltf::{ImportedScene, Names};

mod abi;
impl OpenPbrMaterial {
    /// Sets a float/color/vec2 property by its frozen native property ID. Unused
    /// components must be zero; values must be finite.
    pub fn set_float(&mut self, id: u32, value: [f32; 3]) -> Result<()> {
        let kind = crate::material_properties::MATERIAL_PROPERTIES
            .get(id as usize)
            .map(|v| v.0);
        let count = match kind {
            Some(0) => 1,
            Some(1) => 3,
            Some(2) => 2,
            _ => return Err(invalid("Expected a float, color or vec2 material property")),
        };
        if value.iter().any(|v| !v.is_finite()) || value[count..].iter().any(|v| *v != 0.) {
            return Err(invalid("Invalid material property value"));
        }
        match id {
            2 => self.values.color = value,
            4 => self.values.metalness = value[0],
            7 => self.values.roughness = value[0],
            8 => self.values.ior = value[0],
            10 => self.values.transmission = value[0],
            25 => self.values.layers.coat_weight = value[0],
            27 => self.values.layers.coat_roughness = value[0],
            34 => self.values.emission = value,
            35 => self.values.emission_strength = value[0],
            36 => self.values.opacity = value[0],
            _ => {
                self.properties.insert(id, value.map(f32::to_bits));
            }
        }
        Ok(())
    }
    /// Sets a boolean/enum property. Texture IDs use `set_texture` instead.
    pub fn set_uint(&mut self, id: u32, value: u32) -> Result<()> {
        let (kind, count) = crate::material_properties::MATERIAL_PROPERTIES
            .get(id as usize)
            .copied()
            .ok_or_else(|| invalid("Unknown material property"))?;
        if !((kind == 3 && value <= 1) || (kind == 4 && value < u32::from(count))) {
            return Err(invalid("Invalid boolean/enum material property"));
        }
        if id == 37 {
            self.values.layers.thin_walled = value != 0;
        } else {
            self.properties.insert(id, [value, 0, 0]);
        }
        Ok(())
    }
    /// Sets a texture-valued property with a scene handle; None clears it.
    pub fn set_texture(&mut self, id: u32, texture: Option<TextureId>) -> Result<()> {
        if crate::material_properties::MATERIAL_PROPERTIES
            .get(id as usize)
            .map(|v| v.0)
            != Some(5)
        {
            return Err(invalid("Expected a texture material property"));
        }
        if let Some(slot) = [39, 44, 46, 43, 47, 48, 49, 50, 59]
            .iter()
            .position(|p| *p == id)
        {
            self.textures[slot] = texture;
        } else {
            self.texture_properties.insert(id, texture);
        }
        Ok(())
    }
}
trait References {
    fn validate_references(&self, scene: &Scene) -> Result<()>;
}
impl References for Geometry {
    fn validate_references(&self, _: &Scene) -> Result<()> {
        Ok(())
    }
}
impl References for Texture {
    fn validate_references(&self, _: &Scene) -> Result<()> {
        Ok(())
    }
}
impl References for OpenPbrMaterial {
    fn validate_references(&self, s: &Scene) -> Result<()> {
        for id in self
            .textures
            .iter()
            .copied()
            .chain(self.texture_properties.values().copied())
            .flatten()
        {
            s.textures.get(id.0)?;
        }
        Ok(())
    }
}
impl References for Mesh {
    fn validate_references(&self, s: &Scene) -> Result<()> {
        s.geometries.get(self.geometry.0)?;
        s.materials.get(self.material.0)?;
        for id in &self.materials {
            s.materials.get(id.0)?;
        }
        Ok(())
    }
}
impl References for Light {
    fn validate_references(&self, s: &Scene) -> Result<()> {
        if let Self::Rect {
            texture: Some(id), ..
        } = self
        {
            s.textures.get(id.0)?;
        }
        Ok(())
    }
}
#[cfg(test)]
mod oracle_tests;

#[cfg(test)]
mod commit_kind_tests;
