// MuTracer NGX C ABI. SDK headers stay outside the source distribution.
use anyhow::{Result, ensure};
use std::{
    ffi::{CStr, CString, c_char, c_void},
    path::Path,
};

#[repr(C)]
#[derive(Clone, Copy)]
pub struct Support {
    pub size: u32,
    pub result: u32,
    pub supported: u32,
    pub min_arch: u32,
    pub min_os: [c_char; 256],
}
impl Default for Support {
    fn default() -> Self {
        Self {
            size: std::mem::size_of::<Self>() as u32,
            result: 0,
            supported: 0,
            min_arch: 0,
            min_os: [0; 256],
        }
    }
}
#[repr(C)]
#[derive(Default)]
pub struct Caps {
    pub size: u32,
    pub result: u32,
    pub available: i32,
    pub needs_driver: i32,
    pub min_driver_major: u32,
    pub min_driver_minor: u32,
    pub feature_init_result: i32,
}
#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct Texture {
    pub image: u64,
    pub view: u64,
    pub width: u32,
    pub height: u32,
    pub format: u32,
    pub read_write: u32,
}
pub type Target = *mut c_void;
type Configure = unsafe extern "C" fn(*const c_char, *const u16, *const u16) -> u32;
type Extensions = unsafe extern "C" fn(u32, u64, u64, *mut c_char, u32, *mut u32) -> u32;
type QuerySupport = unsafe extern "C" fn(u64, u64, *mut Support) -> u32;
type Init = unsafe extern "C" fn(u64, u64, u64, *const c_void, *const c_void, *mut Caps) -> u32;
type Create = unsafe extern "C" fn(u64, u32, u32, *mut Target) -> u32;
type Eval = unsafe extern "C" fn(
    Target,
    u64,
    *const Texture,
    u32,
    u32,
    f32,
    f32,
    *const f32,
    *const f32,
    f32,
) -> u32;
type Release = unsafe extern "C" fn(Target) -> u32;
type Shutdown = unsafe extern "C" fn() -> u32;
type LoadedPath = unsafe extern "C" fn(*mut u16, u32) -> u32;
type SetPreset = unsafe extern "C" fn(u32);
pub struct Ngx {
    _lib: libloading::Library,
    extensions: Extensions,
    support: QuerySupport,
    init: Init,
    pub create: Create,
    pub eval: Eval,
    pub release: Release,
    pub shutdown: Shutdown,
    loaded_path: LoadedPath,
    pub set_preset: SetPreset,
}
pub fn success(code: u32) -> bool {
    code & 0xfff00000 != 0xbad00000
}
pub fn check(code: u32, operation: &str) -> Result<()> {
    ensure!(success(code), "{operation} failed: 0x{code:08x}");
    Ok(())
}
impl Ngx {
    pub unsafe fn load(path: &Path, runtime: &Path, logs: &Path, id: &str) -> Result<Self> {
        let lib = unsafe { libloading::Library::new(path) }?;
        let abi = unsafe { lib.get::<unsafe extern "C" fn() -> u32>(b"rr_abi\0") }?;
        ensure!(unsafe { abi() } == 2, "shim ABI mismatch");
        let configure = *unsafe { lib.get::<Configure>(b"rr_configure\0") }?;
        let ngx = Self {
            extensions: *unsafe { lib.get(b"rr_extensions\0") }?,
            support: *unsafe { lib.get(b"rr_support\0") }?,
            init: *unsafe { lib.get(b"rr_init\0") }?,
            create: *unsafe { lib.get(b"rr_create\0") }?,
            eval: *unsafe { lib.get(b"rr_eval\0") }?,
            release: *unsafe { lib.get(b"rr_release\0") }?,
            shutdown: *unsafe { lib.get(b"rr_shutdown\0") }?,
            loaded_path: *unsafe { lib.get(b"rr_loaded_path\0") }?,
            set_preset: *unsafe { lib.get(b"rr_set_preset\0") }?,
            _lib: lib,
        };
        let project = CString::new(id)?;
        let wide = |p: &Path| {
            p.to_string_lossy()
                .encode_utf16()
                .chain([0])
                .collect::<Vec<_>>()
        };
        let runtime = wide(runtime);
        let logs = wide(logs);
        check(
            unsafe { configure(project.as_ptr(), runtime.as_ptr(), logs.as_ptr()) },
            "configure",
        )?;
        Ok(ngx)
    }
    pub fn extensions(&self, device: bool, instance: u64, physical: u64) -> Result<Vec<CString>> {
        let mut data = vec![0i8; 128 * 256];
        let mut n = 0;
        check(
            unsafe {
                (self.extensions)(
                    device as u32,
                    instance,
                    physical,
                    data.as_mut_ptr(),
                    128,
                    &mut n,
                )
            },
            "extensions",
        )?;
        ensure!(n <= 128, "extension count overflow");
        Ok((0..n as usize)
            .map(|i| unsafe { CStr::from_ptr(data[i * 256..].as_ptr()) }.to_owned())
            .collect())
    }
    pub fn support(&self, instance: u64, physical: u64) -> Support {
        let mut out = Support::default();
        unsafe { (self.support)(instance, physical, &mut out) };
        out
    }
    pub fn init(
        &self,
        instance: u64,
        physical: u64,
        device: u64,
        gipa: *const c_void,
        gdpa: *const c_void,
    ) -> Caps {
        let mut out = Caps {
            size: std::mem::size_of::<Caps>() as u32,
            ..Default::default()
        };
        unsafe { (self.init)(instance, physical, device, gipa, gdpa, &mut out) };
        out
    }
    pub fn loaded_path(&self) -> String {
        let mut data = vec![0u16; 32768];
        let n = unsafe { (self.loaded_path)(data.as_mut_ptr(), data.len() as u32) };
        String::from_utf16_lossy(&data[..n as usize])
    }
}
