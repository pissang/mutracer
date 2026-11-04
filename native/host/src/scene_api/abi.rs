//! C scene handles. The registry owns scenes; an engine owns immutable snapshots.
use super::*;
use std::{
    collections::HashMap,
    ffi::{CStr, c_char, c_void},
    mem::size_of,
};
#[repr(C)]
#[derive(Clone, Copy)]
pub struct GeometryDesc {
    struct_size: u32,
    vertex_count: u32,
    index_count: u32,
    reserved: u32,
    positions: *const f32,
    indices: *const u32,
    normals: *const f32,
    uv: *const f32,
    uv1: *const f32,
    colors: *const f32,
    tangents: *const f32,
    material_indices: *const u32,
}
#[repr(C)]
#[derive(Clone, Copy)]
pub struct MaterialDesc {
    struct_size: u32,
    double_sided: u32,
    color: [f32; 3],
    roughness: f32,
    metalness: f32,
    opacity: f32,
    transmission: f32,
    ior: f32,
    emission: [f32; 3],
    emission_strength: f32,
    thin_walled: u32,
    alpha_mode: u32,
    alpha_cutoff: f32,
    normal_scale: f32,
    unlit: u32,
    reserved: u32,
}
#[repr(C)]
#[derive(Clone, Copy)]
pub struct TextureDesc {
    struct_size: u32,
    storage: u32,
    width: u32,
    height: u32,
    uv_channel: u32,
    flip_y: u32,
    wrap_s: u32,
    wrap_t: u32,
    scale: [f32; 2],
    offset: [f32; 2],
    pixels: *const c_void,
    pixel_bytes: usize,
}
#[repr(C)]
#[derive(Clone, Copy)]
pub struct MeshDesc {
    struct_size: u32,
    reserved: u32,
    geometry: u64,
    material: u64,
    world_matrix: [f32; 16],
    materials: *const u64,
    material_count: usize,
}
#[repr(C)]
#[derive(Clone, Copy)]
pub struct InstancesDesc {
    struct_size: u32,
    count: u32,
    transforms: *const f32,
    colors: *const f32,
}
#[repr(C)]
#[derive(Clone, Copy)]
pub struct LightDesc {
    struct_size: u32,
    kind: u32,
    color: [f32; 3],
    intensity: f32,
    size: f32,
    height: f32,
    spread: f32,
    reserved: u32,
    world_matrix: [f32; 16],
    texture: u64,
    ies: *const c_void,
    ies_bytes: usize,
}
#[repr(C)]
#[derive(Clone, Copy)]
pub struct EnvironmentDesc {
    struct_size: u32,
    reserved: u32,
    environment: u64,
    background: u64,
    color: [f32; 4],
}
#[repr(C)]
#[derive(Clone, Copy)]
pub struct EnvironmentSettingsDesc {
    struct_size: u32,
    reserved: u32,
    intensity: f32,
    rotation: f32,
    background_intensity: f32,
    background_rotation: f32,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
enum Resource {
    Geometry(GeometryId),
    Material(MaterialId),
    Texture(TextureId),
    Mesh(MeshId),
    Light(LightId),
}
struct Entry {
    scene: Scene,
    resources: HashMap<u64, Resource>,
    names: HashMap<(u32, String), Vec<u64>>,
}
static SCENES: std::sync::LazyLock<Mutex<HashMap<u64, Arc<Mutex<Entry>>>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));
static NEXT: AtomicU64 = AtomicU64::new(1);
fn next() -> u64 {
    NEXT.fetch_add(1, Ordering::Relaxed)
}
fn register(entry: Entry) -> u64 {
    let id = next();
    SCENES
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(id, Arc::new(Mutex::new(entry)));
    id
}
fn with_scene<T>(id: u64, f: impl FnOnce(&mut Entry) -> Result<T>) -> Result<T> {
    let entry = SCENES
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&id)
        .cloned()
        .ok_or_else(invalid_handle)?;
    let mut entry = entry.try_lock().map_err(|e| match e {
        std::sync::TryLockError::WouldBlock => api::error(Status::Busy, "Scene is in use"),
        std::sync::TryLockError::Poisoned(_) => api::error(
            Status::ContextFailed,
            "Scene panicked; destroy and recreate it",
        ),
    })?;
    f(&mut entry)
}
fn call(error: *mut c_char, capacity: usize, f: impl FnOnce() -> Result<()>) -> i32 {
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f))
        .unwrap_or_else(|_| Err(api::error(Status::Error, "Scene call panicked")));
    match result {
        Ok(()) => crate::status::write(error, capacity, Status::Ok, ""),
        Err(e) => crate::status::write(error, capacity, e.status, &e.message),
    }
}
unsafe fn record<'a, T>(p: *const T) -> Result<&'a T> {
    if p.is_null() {
        return Err(invalid("Null descriptor"));
    }
    if unsafe { *p.cast::<u32>() } as usize != size_of::<T>() {
        return Err(invalid("Unsupported struct_size"));
    }
    Ok(unsafe { &*p })
}
unsafe fn output<T>(p: *mut T, value: T) -> Result<()> {
    if p.is_null() {
        return Err(invalid("Null output"));
    }
    unsafe { p.write(value) };
    Ok(())
}
unsafe fn input<'a, T>(p: *const T, n: usize) -> Result<&'a [T]> {
    if n == 0 {
        return Ok(&[]);
    }
    if p.is_null() || n > isize::MAX as usize / size_of::<T>() {
        return Err(invalid("Null or oversized array"));
    }
    Ok(unsafe { std::slice::from_raw_parts(p, n) })
}
unsafe fn text<'a>(p: *const c_char) -> Result<&'a str> {
    if p.is_null() {
        return Err(invalid("Null string"));
    }
    unsafe { CStr::from_ptr(p) }
        .to_str()
        .map_err(|_| invalid("Expected UTF-8"))
}
macro_rules! defaults {($($fn:ident,$ty:ty,$value:expr);*$(;)?)=>{$(#[unsafe(no_mangle)]pub unsafe extern "C" fn $fn(out:*mut $ty)->i32 {call(std::ptr::null_mut(),0,||unsafe{output(out,$value)})})*};}
#[path = "abi_picking.rs"]
mod picking;
defaults! {
 mt_scene_geometry_desc_default,GeometryDesc,GeometryDesc{struct_size:size_of::<GeometryDesc>() as u32,vertex_count:0,index_count:0,reserved:0,positions:std::ptr::null(),indices:std::ptr::null(),normals:std::ptr::null(),uv:std::ptr::null(),uv1:std::ptr::null(),colors:std::ptr::null(),tangents:std::ptr::null(),material_indices:std::ptr::null()};
 mt_scene_material_desc_default,MaterialDesc,MaterialDesc{struct_size:80,double_sided:0,color:[0.8;3],roughness:0.3,metalness:0.,opacity:1.,transmission:0.,ior:1.5,emission:[1.;3],emission_strength:0.,thin_walled:0,alpha_mode:0,alpha_cutoff:0.5,normal_scale:1.,unlit:0,reserved:0};
 mt_scene_texture_desc_default,TextureDesc,TextureDesc{struct_size:size_of::<TextureDesc>() as u32,storage:0,width:0,height:0,uv_channel:0,flip_y:0,wrap_s:0,wrap_t:0,scale:[1.;2],offset:[0.;2],pixels:std::ptr::null(),pixel_bytes:0};
 mt_scene_mesh_desc_default,MeshDesc,MeshDesc{struct_size:size_of::<MeshDesc>() as u32,reserved:0,geometry:0,material:0,world_matrix:Mat4::IDENTITY.to_cols_array(),materials:std::ptr::null(),material_count:0};
 mt_scene_instances_desc_default,InstancesDesc,InstancesDesc{struct_size:size_of::<InstancesDesc>() as u32,count:0,transforms:std::ptr::null(),colors:std::ptr::null()};
 mt_scene_light_desc_default,LightDesc,LightDesc{struct_size:size_of::<LightDesc>() as u32,kind:0,color:[1.;3],intensity:1.,size:1.,height:1.,spread:1.,reserved:0,world_matrix:Mat4::IDENTITY.to_cols_array(),texture:0,ies:std::ptr::null(),ies_bytes:0};
 mt_scene_environment_settings_default,EnvironmentSettingsDesc,EnvironmentSettingsDesc{struct_size:24,reserved:0,intensity:1.,rotation:0.,background_intensity:1.,background_rotation:0.};
 mt_scene_environment_desc_default,EnvironmentDesc,EnvironmentDesc{struct_size:40,reserved:0,environment:0,background:0,color:[0.,0.,0.,1.]};
}
macro_rules! resource_access {($($method:ident,$variant:ident,$ty:ty);*)=>{$(impl Entry {fn $method(&self,id:u64)->Result<$ty>{match self.resources.get(&id){Some(Resource::$variant(v))=>Ok(*v),_=>Err(invalid_handle())}}})*};}
resource_access! {geometry,Geometry,GeometryId;material,Material,MaterialId;texture,Texture,TextureId;mesh,Mesh,MeshId;light,Light,LightId}
impl Entry {
    fn insert(&mut self, r: Resource) -> u64 {
        let id = next();
        match r {
            Resource::Mesh(key) => {
                self.scene.aov_handles.insert(key.0, id as u32);
            }
            Resource::Material(key) => {
                self.scene.aov_handles.insert(key.0, id as u32);
            }
            _ => {}
        }
        self.resources.insert(id, r);
        id
    }
    fn texture_option(&self, id: u64) -> Result<Option<TextureId>> {
        if id == 0 {
            Ok(None)
        } else {
            self.texture(id).map(Some)
        }
    }
}
unsafe fn geometry(p: *const GeometryDesc) -> Result<Geometry> {
    let d = unsafe { record(p) }?;
    if d.reserved != 0 || d.vertex_count > 16_777_216 || d.index_count > 50_331_648 {
        return Err(invalid("Invalid geometry limits/reserved"));
    }
    let n = d.vertex_count as usize;
    let mut g = Geometry::new(unsafe { input(d.positions, n * 3) }?, unsafe {
        input(d.indices, d.index_count as usize)
    }?);
    for (out, pointer, stride) in [
        (&mut g.normals, d.normals, 3),
        (&mut g.uv[0], d.uv, 2),
        (&mut g.colors, d.colors, 3),
        (&mut g.tangents, d.tangents, 4),
    ] {
        if !pointer.is_null() {
            *out = unsafe { input(pointer, n * stride) }?.into();
        }
    }
    if !d.uv1.is_null() {
        g.uv[1] = unsafe { input(d.uv1, n * 2) }?.into();
    }
    if !d.material_indices.is_null() {
        g.material_indices = unsafe { input(d.material_indices, n) }?.into();
    }
    Ok(g)
}
unsafe fn texture(p: *const TextureDesc) -> Result<Texture> {
    let d = unsafe { record(p) }?;
    let pixel_count = u64::from(d.width) * u64::from(d.height);
    if pixel_count > 67_108_864
        || d.width > 16384
        || d.height > 16384
        || d.storage > 1
        || d.flip_y > 1
        || d.uv_channel > 1
        || d.wrap_s > 2
        || d.wrap_t > 2
        || d.pixel_bytes as u64 != pixel_count * if d.storage == 0 { 4 } else { 16 }
    {
        return Err(invalid("Invalid texture description"));
    }
    let bytes = unsafe { input(d.pixels.cast::<u8>(), d.pixel_bytes) }?;
    let pixels = if d.storage == 0 {
        TexturePixels::Rgba8(bytes.into())
    } else {
        TexturePixels::Rgba32F(bytemuck::pod_collect_to_vec::<u8, f32>(bytes).into())
    };
    Ok(Texture {
        pixels,
        width: d.width,
        height: d.height,
        uv: d.uv_channel,
        scale: d.scale,
        offset: d.offset,
        wrap: [d.wrap_s, d.wrap_t],
        flip_y: d.flip_y != 0,
    })
}
unsafe fn mesh(e: &Entry, p: *const MeshDesc) -> Result<Mesh> {
    let d = unsafe { record(p) }?;
    if d.reserved != 0 || d.material_count > 16_777_216 {
        return Err(invalid("Invalid mesh description"));
    }
    let mut m = Mesh::new(e.geometry(d.geometry)?, e.material(d.material)?);
    m.transform = Mat4::from_cols_array(&d.world_matrix);
    m.materials = unsafe { input(d.materials, d.material_count) }?
        .iter()
        .map(|id| e.material(*id))
        .collect::<Result<_>>()?;
    Ok(m)
}
unsafe fn instances(p: *const InstancesDesc) -> Result<Instances> {
    let d = unsafe { record(p) }?;
    if d.count > 16_777_216 {
        return Err(invalid("Too many instances"));
    }
    let transforms = unsafe { input(d.transforms, d.count as usize * 16) }?
        .chunks_exact(16)
        .map(|m| Mat4::from_cols_array(m.try_into().unwrap()))
        .collect::<Vec<_>>()
        .into();
    let colors = if d.colors.is_null() {
        None
    } else {
        Some(unsafe { input(d.colors, d.count as usize * 3) }?.into())
    };
    Ok(Instances { transforms, colors })
}
unsafe fn light(e: &Entry, p: *const LightDesc) -> Result<Light> {
    let d = unsafe { record(p) }?;
    if d.reserved != 0 || d.ies_bytes > 16 * 1024 * 1024 {
        return Err(invalid("Invalid light description"));
    }
    let color = d.color;
    let intensity = d.intensity;
    let transform = Mat4::from_cols_array(&d.world_matrix);
    Ok(match d.kind {
        0 => Light::Rect {
            color,
            intensity,
            width: d.size,
            height: d.height,
            spread: d.spread,
            transform,
            texture: e.texture_option(d.texture)?,
        },
        1 => Light::Sphere {
            color,
            intensity,
            radius: d.size,
            transform,
        },
        2 => Light::Directional {
            color,
            intensity,
            transform,
        },
        3 => Light::Spot {
            color,
            intensity,
            inner: d.height,
            outer: d.spread,
            transform,
            ies: unsafe { input(d.ies.cast::<u8>(), d.ies_bytes) }?.into(),
        },
        _ => return Err(invalid("Unknown light type")),
    })
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_scene_create(out: *mut u64, error: *mut c_char, cap: usize) -> i32 {
    call(error, cap, || {
        if out.is_null() {
            return Err(invalid("Null output"));
        }
        let id = register(Entry {
            scene: Scene::new(),
            resources: HashMap::new(),
            names: HashMap::new(),
        });
        unsafe { output(out, id) }
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn mt_scene_destroy(scene: u64, error: *mut c_char, cap: usize) -> i32 {
    call(error, cap, || {
        let entry = SCENES
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&scene)
            .cloned()
            .ok_or_else(invalid_handle)?;
        // A caught panic fails the builder, but its owned resources must remain
        // destroyable. Never read or mutate a poisoned candidate again.
        let _guard = match entry.try_lock() {
            Ok(guard) => guard,
            Err(std::sync::TryLockError::Poisoned(poison)) => poison.into_inner(),
            Err(std::sync::TryLockError::WouldBlock) => {
                return Err(api::error(Status::Busy, "Scene is in use"));
            }
        };
        SCENES
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&scene)
            .ok_or_else(invalid_handle)?;
        Ok(())
    })
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_scene_add_geometry(
    scene: u64,
    desc: *const GeometryDesc,
    out: *mut u64,
    error: *mut c_char,
    cap: usize,
) -> i32 {
    call(error, cap, || {
        if out.is_null() {
            return Err(invalid("Null output"));
        }
        let g = unsafe { geometry(desc) }?;
        with_scene(scene, |e| {
            let id = e.scene.add_geometry(g)?;
            let h = e.insert(Resource::Geometry(id));
            unsafe { output(out, h) }
        })
    })
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_scene_set_geometry(
    scene: u64,
    id: u64,
    desc: *const GeometryDesc,
    error: *mut c_char,
    cap: usize,
) -> i32 {
    call(error, cap, || {
        let g = unsafe { geometry(desc) }?;
        with_scene(scene, |e| {
            let id = e.geometry(id)?;
            *e.scene.geometry_mut(id)? = g;
            Ok(())
        })
    })
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_scene_add_material(
    scene: u64,
    desc: *const MaterialDesc,
    out: *mut u64,
    error: *mut c_char,
    cap: usize,
) -> i32 {
    call(error, cap, || {
        if out.is_null() {
            return Err(invalid("Null output"));
        }
        let d = unsafe { record(desc) }?;
        if d.reserved != 0
            || d.double_sided > 1
            || d.thin_walled > 1
            || d.unlit > 1
            || d.alpha_mode > 3
        {
            return Err(invalid("Invalid material description"));
        }
        let mut m = OpenPbrMaterial::default();
        let v = &mut m.values;
        v.color = d.color;
        v.roughness = d.roughness;
        v.metalness = d.metalness;
        v.opacity = d.opacity;
        v.transmission = d.transmission;
        v.ior = d.ior;
        v.emission = d.emission;
        v.emission_strength = d.emission_strength;
        v.layers.thin_walled = d.thin_walled != 0;
        v.double_sided = d.double_sided != 0;
        v.alpha_mode = d.alpha_mode;
        v.alpha_cutoff = d.alpha_cutoff;
        v.normal_scale = d.normal_scale;
        v.unlit = d.unlit != 0;
        with_scene(scene, |e| {
            let id = e.scene.add_material(m)?;
            let h = e.insert(Resource::Material(id));
            unsafe { output(out, h) }
        })
    })
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_scene_add_texture(
    scene: u64,
    desc: *const TextureDesc,
    out: *mut u64,
    error: *mut c_char,
    cap: usize,
) -> i32 {
    call(error, cap, || {
        if out.is_null() {
            return Err(invalid("Null output"));
        }
        let t = unsafe { texture(desc) }?;
        with_scene(scene, |e| {
            let id = e.scene.add_texture(t)?;
            let h = e.insert(Resource::Texture(id));
            unsafe { output(out, h) }
        })
    })
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_scene_set_texture(
    scene: u64,
    id: u64,
    desc: *const TextureDesc,
    error: *mut c_char,
    cap: usize,
) -> i32 {
    call(error, cap, || {
        let t = unsafe { texture(desc) }?;
        with_scene(scene, |e| {
            let id = e.texture(id)?;
            *e.scene.texture_mut(id)? = t;
            Ok(())
        })
    })
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_scene_add_mesh(
    scene: u64,
    desc: *const MeshDesc,
    out: *mut u64,
    error: *mut c_char,
    cap: usize,
) -> i32 {
    call(error, cap, || {
        if out.is_null() {
            return Err(invalid("Null output"));
        }
        with_scene(scene, |e| {
            let m = unsafe { mesh(e, desc) }?;
            let id = e.scene.add_mesh(m)?;
            let h = e.insert(Resource::Mesh(id));
            unsafe { output(out, h) }
        })
    })
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_scene_set_mesh(
    scene: u64,
    id: u64,
    desc: *const MeshDesc,
    error: *mut c_char,
    cap: usize,
) -> i32 {
    call(error, cap, || {
        with_scene(scene, |e| {
            let id = e.mesh(id)?;
            let m = unsafe { mesh(e, desc) }?;
            *e.scene.mesh_mut(id)? = m;
            Ok(())
        })
    })
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_scene_add_instances(
    scene: u64,
    desc: *const MeshDesc,
    inst: *const InstancesDesc,
    out: *mut u64,
    error: *mut c_char,
    cap: usize,
) -> i32 {
    call(error, cap, || {
        if out.is_null() {
            return Err(invalid("Null output"));
        }
        with_scene(scene, |e| {
            let mut m = unsafe { mesh(e, desc) }?;
            m.instances = Some(unsafe { instances(inst) }?);
            let id = e.scene.add_mesh(m)?;
            let h = e.insert(Resource::Mesh(id));
            unsafe { output(out, h) }
        })
    })
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_scene_set_instances(
    scene: u64,
    id: u64,
    desc: *const InstancesDesc,
    error: *mut c_char,
    cap: usize,
) -> i32 {
    call(error, cap, || {
        let inst = if desc.is_null() {
            None
        } else {
            Some(unsafe { instances(desc) }?)
        };
        with_scene(scene, |e| {
            let id = e.mesh(id)?;
            e.scene.mesh_mut(id)?.instances = inst;
            Ok(())
        })
    })
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_scene_set_mesh_transform(
    scene: u64,
    id: u64,
    matrix: *const f32,
    error: *mut c_char,
    cap: usize,
) -> i32 {
    call(error, cap, || {
        let m = Mat4::from_cols_array(unsafe { input(matrix, 16) }?.try_into().unwrap());
        with_scene(scene, |e| {
            let id = e.mesh(id)?;
            e.scene.mesh_mut(id)?.transform = m;
            Ok(())
        })
    })
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_scene_add_light(
    scene: u64,
    desc: *const LightDesc,
    out: *mut u64,
    error: *mut c_char,
    cap: usize,
) -> i32 {
    call(error, cap, || {
        if out.is_null() {
            return Err(invalid("Null output"));
        }
        with_scene(scene, |e| {
            let l = unsafe { light(e, desc) }?;
            let id = e.scene.add_light(l)?;
            let h = e.insert(Resource::Light(id));
            unsafe { output(out, h) }
        })
    })
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_scene_set_light(
    scene: u64,
    id: u64,
    desc: *const LightDesc,
    error: *mut c_char,
    cap: usize,
) -> i32 {
    call(error, cap, || {
        with_scene(scene, |e| {
            let id = e.light(id)?;
            let light = unsafe { light(e, desc) }?;
            *e.scene.light_mut(id)? = light;
            Ok(())
        })
    })
}
macro_rules! remove {($($fn:ident,$get:ident,$rm:ident);*)=>{$(#[unsafe(no_mangle)]pub extern "C" fn $fn(scene:u64,id:u64,error:*mut c_char,cap:usize)->i32 {call(error,cap,||with_scene(scene,|e|{let k=e.$get(id)?;e.scene.$rm(k)?;e.resources.remove(&id);Ok(())}))})*};}
remove! {mt_scene_remove_geometry,geometry,remove_geometry;mt_scene_remove_material,material,remove_material;mt_scene_remove_texture,texture,remove_texture;mt_scene_remove_mesh,mesh,remove_mesh;mt_scene_remove_light,light,remove_light}
#[unsafe(no_mangle)]
pub extern "C" fn mt_scene_material_set_float(
    scene: u64,
    id: u64,
    property: u32,
    x: f32,
    y: f32,
    z: f32,
    error: *mut c_char,
    cap: usize,
) -> i32 {
    call(error, cap, || {
        with_scene(scene, |e| {
            let id = e.material(id)?;
            e.scene.material_mut(id)?.set_float(property, [x, y, z])
        })
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn mt_scene_material_set_uint(
    scene: u64,
    id: u64,
    property: u32,
    value: u32,
    error: *mut c_char,
    cap: usize,
) -> i32 {
    call(error, cap, || {
        with_scene(scene, |e| {
            let id = e.material(id)?;
            e.scene.material_mut(id)?.set_uint(property, value)
        })
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn mt_scene_material_set_texture(
    scene: u64,
    id: u64,
    property: u32,
    texture: u64,
    error: *mut c_char,
    cap: usize,
) -> i32 {
    call(error, cap, || {
        with_scene(scene, |e| {
            let id = e.material(id)?;
            let t = e.texture_option(texture)?;
            e.scene.material_mut(id)?.set_texture(property, t)
        })
    })
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_scene_set_environment(
    scene: u64,
    desc: *const EnvironmentDesc,
    error: *mut c_char,
    cap: usize,
) -> i32 {
    call(error, cap, || {
        let d = unsafe { record(desc) }?;
        if d.reserved != 0 {
            return Err(invalid("Reserved must be zero"));
        }
        with_scene(scene, |e| {
            let env = Environment {
                texture: e.texture_option(d.environment)?,
                background: e.texture_option(d.background)?,
                color: d.color,
            };
            e.scene.set_environment(env)
        })
    })
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_scene_set_environment_settings(
    scene: u64,
    desc: *const EnvironmentSettingsDesc,
    error: *mut c_char,
    cap: usize,
) -> i32 {
    call(error, cap, || {
        let d = unsafe { record(desc) }?;
        if d.reserved != 0 {
            return Err(invalid("Reserved must be zero"));
        }
        with_scene(scene, |e| {
            e.scene.set_environment_settings(EnvironmentSettings {
                intensity: d.intensity,
                rotation: d.rotation,
                background_intensity: d.background_intensity,
                background_rotation: d.background_rotation,
            })
        })
    })
}
#[repr(C)]
#[derive(Clone, Copy)]
pub struct GroundedBackgroundDesc {
    struct_size: u32,
    height: f32,
    radius: f32,
    ground_height: f32,
    center: [f32; 2],
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_scene_grounded_background_default(
    out: *mut GroundedBackgroundDesc,
) -> i32 {
    call(std::ptr::null_mut(), 0, || unsafe {
        output(
            out,
            GroundedBackgroundDesc {
                struct_size: 24,
                height: 1.6,
                radius: 32.,
                ground_height: 0.,
                center: [0.; 2],
            },
        )
    })
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_scene_set_grounded_background(
    scene: u64,
    desc: *const GroundedBackgroundDesc,
    error: *mut c_char,
    cap: usize,
) -> i32 {
    call(error, cap, || {
        let value = if desc.is_null() {
            None
        } else {
            let d = unsafe { record(desc)? };
            Some(GroundedBackground {
                height: d.height,
                radius: d.radius,
                ground_height: d.ground_height,
                center: d.center,
            })
        };
        with_scene(scene, |e| e.scene.set_grounded_background(value))
    })
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_scene_set_default_camera(
    scene: u64,
    camera: *const Camera,
    error: *mut c_char,
    cap: usize,
) -> i32 {
    call(error, cap, || {
        with_scene(scene, |e| {
            e.scene.set_default_camera(if camera.is_null() {
                None
            } else {
                Some(unsafe { *camera })
            });
            Ok(())
        })
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn mt_engine_set_scene_object(
    engine: u64,
    scene: u64,
    error: *mut c_char,
    cap: usize,
) -> i32 {
    call(error, cap, || {
        let engine = api::abi::engine_of(engine)?;
        with_scene(scene, |e| engine.set_scene_object(&e.scene))
    })
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_scene_encode(
    scene: u64,
    out: *mut c_void,
    out_bytes: usize,
    written: *mut usize,
    error: *mut c_char,
    cap: usize,
) -> i32 {
    call(error, cap, || {
        if written.is_null() {
            return Err(invalid("Null written"));
        }
        with_scene(scene, |e| {
            let bytes = e.scene.descriptor()?;
            unsafe { written.write(bytes.len()) };
            if out.is_null() && out_bytes == 0 {
                return Ok(());
            }
            if out.is_null() {
                return Err(invalid("Null output"));
            }
            if out_bytes < bytes.len() {
                return Err(api::error(
                    Status::BufferTooSmall,
                    "Descriptor output is too small",
                ));
            }
            unsafe { std::ptr::copy_nonoverlapping(bytes.as_ptr(), out.cast::<u8>(), bytes.len()) };
            Ok(())
        })
    })
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_scene_pending_commit_kind(
    scene: u64,
    out: *mut u32,
    error: *mut c_char,
    cap: usize,
) -> i32 {
    call(error, cap, || {
        with_scene(scene, |e| unsafe {
            output(
                out,
                match e.scene.pending_commit_kind()? {
                    CommitKind::Full => 1,
                    CommitKind::Incremental => 2,
                },
            )
        })
    })
}
#[cfg(feature = "gltf")]
fn imported(import: gltf::ImportedScene) -> Entry {
    let mut e = Entry {
        scene: import.scene,
        resources: HashMap::new(),
        names: HashMap::new(),
    };
    let mut reverse: HashMap<(u32, Key), u64> = HashMap::new();
    let resources: Vec<_> = e
        .scene
        .geometries
        .iter()
        .map(|(k, _)| (1, k, Resource::Geometry(GeometryId(k))))
        .chain(
            e.scene
                .materials
                .iter()
                .map(|(k, _)| (2, k, Resource::Material(MaterialId(k)))),
        )
        .chain(
            e.scene
                .textures
                .iter()
                .map(|(k, _)| (3, k, Resource::Texture(TextureId(k)))),
        )
        .chain(
            e.scene
                .meshes
                .iter()
                .map(|(k, _)| (4, k, Resource::Mesh(MeshId(k)))),
        )
        .collect();
    for (kind, key, r) in resources {
        let id = e.insert(r);
        reverse.insert((kind, key), id);
    }
    for (name, ids) in import.names.geometries {
        e.names.insert(
            (1, name),
            ids.iter().map(|id| reverse[&(1, id.0)]).collect(),
        );
    }
    for (name, ids) in import.names.materials {
        e.names.insert(
            (2, name),
            ids.iter().map(|id| reverse[&(2, id.0)]).collect(),
        );
    }
    for (name, ids) in import.names.meshes {
        e.names.insert(
            (4, name),
            ids.iter().map(|id| reverse[&(4, id.0)]).collect(),
        );
    }
    for (name, ids) in import.names.nodes {
        e.names.insert(
            (6, name),
            ids.iter().map(|id| reverse[&(4, id.0)]).collect(),
        );
    }
    e
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_scene_import_gltf(
    path: *const c_char,
    out: *mut u64,
    error: *mut c_char,
    cap: usize,
) -> i32 {
    call(error, cap, || {
        if out.is_null() {
            return Err(invalid("Null output"));
        }
        #[cfg(feature = "gltf")]
        {
            let path = unsafe { text(path) }?;
            let import = Scene::import_gltf(path)?;
            unsafe { output(out, register(imported(import))) }
        }
        #[cfg(not(feature = "gltf"))]
        {
            let _ = path;
            Err(api::error(
                Status::Unavailable,
                "Library was built without gltf",
            ))
        }
    })
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_scene_import_gltf_bytes(
    bytes: *const c_void,
    len: usize,
    base: *const c_char,
    out: *mut u64,
    error: *mut c_char,
    cap: usize,
) -> i32 {
    call(error, cap, || {
        if out.is_null() {
            return Err(invalid("Null output"));
        }
        #[cfg(feature = "gltf")]
        {
            crate::memory_budget::check(len, "Model file").map_err(|e| invalid(&e.to_string()))?;
            let bytes = unsafe { input(bytes.cast::<u8>(), len) }?;
            let base = if base.is_null() {
                None
            } else {
                Some(std::path::Path::new(unsafe { text(base) }?))
            };
            let import = Scene::import_gltf_bytes(bytes, base)?;
            unsafe { output(out, register(imported(import))) }
        }
        #[cfg(not(feature = "gltf"))]
        {
            let _ = (bytes, len, base);
            Err(api::error(
                Status::Unavailable,
                "Library was built without gltf",
            ))
        }
    })
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_scene_find(
    scene: u64,
    kind: u32,
    name: *const c_char,
    occurrence: usize,
    out: *mut u64,
    error: *mut c_char,
    cap: usize,
) -> i32 {
    call(error, cap, || {
        let name = unsafe { text(name) }?;
        with_scene(scene, |e| {
            let id = *e
                .names
                .get(&(kind, name.to_string()))
                .and_then(|ids| ids.get(occurrence))
                .filter(|id| e.resources.contains_key(id))
                .ok_or_else(|| invalid("Unknown name or occurrence"))?;
            unsafe { output(out, id) }
        })
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn failed_scene_rejects_use_and_remains_destroyable() {
        let mut s = 0;
        assert_eq!(
            unsafe { mt_scene_create(&mut s, std::ptr::null_mut(), 0) },
            0
        );
        assert_eq!(
            call(std::ptr::null_mut(), 0, || with_scene(s, |_| panic!(
                "injected scene failure"
            ))),
            Status::Error as i32
        );
        assert_eq!(
            call(std::ptr::null_mut(), 0, || with_scene(s, |_| Ok(()))),
            Status::ContextFailed as i32
        );
        assert_eq!(mt_scene_destroy(s, std::ptr::null_mut(), 0), 0);
        assert_eq!(
            mt_scene_destroy(s, std::ptr::null_mut(), 0),
            Status::InvalidHandle as i32
        );
    }
    #[test]
    fn c_defaults_records_and_handle_lifetimes() {
        unsafe {
            let mut s = 0;
            assert_eq!(mt_scene_create(&mut s, std::ptr::null_mut(), 0), 0);
            let mut d = std::mem::MaybeUninit::<MaterialDesc>::uninit();
            assert_eq!(mt_scene_material_desc_default(d.as_mut_ptr()), 0);
            let mut d = d.assume_init();
            assert_eq!(size_of::<MaterialDesc>(), 80);
            assert_eq!(d.roughness, 0.3);
            let mut m = 0;
            d.struct_size -= 4;
            assert_eq!(
                mt_scene_add_material(s, &d, &mut m, std::ptr::null_mut(), 0),
                Status::InvalidArgument as i32
            );
            d.struct_size += 4;
            assert_eq!(
                mt_scene_add_material(s, &d, &mut m, std::ptr::null_mut(), 0),
                0
            );
            assert_eq!(
                mt_scene_material_set_float(s, m, 7, 0.6, 0., 0., std::ptr::null_mut(), 0),
                0
            );
            assert_eq!(
                mt_scene_material_set_uint(s, m, 7, 1, std::ptr::null_mut(), 0),
                Status::InvalidArgument as i32
            );
            let mut other = 0;
            mt_scene_create(&mut other, std::ptr::null_mut(), 0);
            assert_eq!(
                mt_scene_material_set_uint(other, m, 37, 1, std::ptr::null_mut(), 0),
                Status::InvalidHandle as i32
            );
            assert_eq!(mt_scene_remove_material(s, m, std::ptr::null_mut(), 0), 0);
            assert_eq!(
                mt_scene_material_set_float(s, m, 7, 0.5, 0., 0., std::ptr::null_mut(), 0),
                Status::InvalidHandle as i32
            );
            assert_eq!(mt_scene_destroy(s, std::ptr::null_mut(), 0), 0);
            assert_eq!(
                mt_scene_destroy(s, std::ptr::null_mut(), 0),
                Status::InvalidHandle as i32
            );
            mt_scene_destroy(other, std::ptr::null_mut(), 0);
        }
    }
}

#[cfg(all(test, not(feature = "gltf")))]
mod unavailable_tests {
    use super::*;
    #[test]
    fn imports_without_gltf_return_unavailable() {
        let mut scene = 0;
        let mut error = [0i8; 256];
        for status in [
            unsafe {
                mt_scene_import_gltf(
                    std::ptr::null(),
                    &mut scene,
                    error.as_mut_ptr(),
                    error.len(),
                )
            },
            unsafe {
                mt_scene_import_gltf_bytes(
                    std::ptr::null(),
                    0,
                    std::ptr::null(),
                    &mut scene,
                    error.as_mut_ptr(),
                    error.len(),
                )
            },
        ] {
            assert_eq!(status, Status::Unavailable as i32);
            assert!(
                unsafe { CStr::from_ptr(error.as_ptr()) }
                    .to_str()
                    .unwrap()
                    .contains("without gltf")
            );
        }
    }
}
