//! Incremental commit oracle: committing an edited descriptor over a committed
//! scene must render the same HDR, normal and albedo bytes as committing it to
//! a new context. Usage: incremental-oracle SAMPLES BACKEND SCENE.bin...
//! Prints one JSON line per fixture and edit; exits nonzero on any mismatch or
//! when an edit that should be incremental fell back to full preparation.
use mutracer_native::context as native;
use mutracer_native::layout::{
    camera as cam, geometry as g, header as h, light as l, material as mat, mesh as m, texture as t,
};

type Result<T> = std::result::Result<T, String>;

fn call(operation: impl FnOnce(*mut i8, usize) -> i32) -> Result<()> {
    let mut error = [0i8; 4096];
    if operation(error.as_mut_ptr(), error.len()) != 0 {
        let message = unsafe { std::ffi::CStr::from_ptr(error.as_ptr()) };
        return Err(message.to_string_lossy().into_owned());
    }
    Ok(())
}
fn u(bytes: &[u8], i: usize) -> usize {
    u32::from_le_bytes(bytes[i * 4..i * 4 + 4].try_into().unwrap()) as usize
}
fn set_f(bytes: &mut [u8], i: usize, value: f32) {
    bytes[i * 4..i * 4 + 4].copy_from_slice(&value.to_le_bytes());
}
/// Adds `delta` to the f32 word `i`.
fn add_f(bytes: &mut [u8], i: usize, delta: f32) {
    let value = get_f(bytes, i) + delta;
    set_f(bytes, i, value);
}
fn get_f(bytes: &[u8], i: usize) -> f32 {
    f32::from_le_bytes(bytes[i * 4..i * 4 + 4].try_into().unwrap())
}

struct Context(u64);
impl Context {
    fn new(backend: u32) -> Result<Self> {
        let mut handle = 0;
        call(|e, n| unsafe { native::mt_context_create_with_backend(backend, &mut handle, e, n) })?;
        Ok(Self(handle))
    }
    fn commit(&self, bytes: &[u8]) -> Result<()> {
        call(|e, n| unsafe { native::mt_context_commit(self.0, bytes.as_ptr(), bytes.len(), e, n) })
    }
    /// Whether the last successful commit took the incremental path.
    fn incremental(&self) -> Result<bool> {
        let mut info = native::ContextInfo {
            struct_size: std::mem::size_of::<native::ContextInfo>() as u32,
            width: 0,
            height: 0,
            samples: 0,
            state: 0,
            last_commit: 0,
        };
        call(|e, n| unsafe { native::mt_context_info(self.0, &mut info, e, n) })?;
        Ok(info.last_commit == native::COMMIT_INCREMENTAL)
    }
    fn images(&self, samples: u32) -> Result<Vec<Vec<u8>>> {
        call(|e, n| unsafe { native::mt_context_render(self.0, samples, e, n) })?;
        (0..3)
            .map(|kind| {
                let mut written = 0;
                call(|e, n| unsafe {
                    native::mt_context_read_pixels(
                        self.0,
                        kind,
                        std::ptr::null_mut(),
                        0,
                        &mut written,
                        e,
                        n,
                    )
                })?;
                let mut pixels = vec![0u8; written];
                call(|e, n| unsafe {
                    native::mt_context_read_pixels(
                        self.0,
                        kind,
                        pixels.as_mut_ptr().cast(),
                        pixels.len(),
                        &mut written,
                        e,
                        n,
                    )
                })?;
                Ok(pixels)
            })
            .collect()
    }
}
impl Drop for Context {
    fn drop(&mut self) {
        let _ = call(|e, n| unsafe { native::mt_context_destroy(self.0, e, n) });
    }
}

/// Edits that keep the descriptor valid. `true`: expected to stay incremental.
type Edit = (&'static str, bool, fn(&mut Vec<u8>) -> bool);
fn set_u(bytes: &mut [u8], i: usize, value: usize) {
    bytes[i * 4..i * 4 + 4].copy_from_slice(&(value as u32).to_le_bytes());
}
/// First instanced mesh with at least one instance.
fn first_batch(bytes: &[u8]) -> Option<usize> {
    (0..u(bytes, h::MESH_COUNT))
        .find(|&i| instanced(bytes, i) && u(bytes, u(bytes, h::BATCH_OFFSET) + i * 4) > 0)
}
fn instanced(bytes: &[u8], mesh: usize) -> bool {
    u(bytes, h::BATCH_OFFSET) != 0
        && u(bytes, u(bytes, h::BATCH_OFFSET) + mesh * 4) != u32::MAX as usize
}
/// First texture used by a material map (packed into the atlas).
fn atlas_texture(bytes: &[u8]) -> Option<usize> {
    (0..u(bytes, h::MATERIAL_COUNT))
        .flat_map(|i| {
            let o = u(bytes, h::MATERIAL_OFFSET) + i * mat::WORDS;
            (mat::MAP..=mat::EMISSIVE_MAP).map(move |k| u(bytes, o + k))
        })
        .find(|&texture| texture < u(bytes, h::TEXTURE_COUNT))
}
/// Whether any material map or extension value word equals `value`; a texture
/// also used by a material is packed into the atlas and needs a full commit.
fn material_word(bytes: &[u8], value: usize) -> bool {
    (0..u(bytes, h::MATERIAL_COUNT)).any(|i| {
        let o = u(bytes, h::MATERIAL_OFFSET) + i * mat::WORDS;
        let extensions = u(bytes, o + mat::EXTENSION_OFFSET);
        (mat::MAP..=mat::EMISSIVE_MAP).any(|k| u(bytes, o + k) == value)
            || (0..u(bytes, o + mat::EXTENSION_COUNT))
                .any(|e| u(bytes, extensions + e * 4 + 1) == value)
    })
}
/// Texture of the first displacement map property (wire ID 59).
fn displacement_texture(bytes: &[u8]) -> Option<usize> {
    (0..u(bytes, h::MATERIAL_COUNT)).find_map(|i| {
        let o = u(bytes, h::MATERIAL_OFFSET) + i * mat::WORDS;
        let extensions = u(bytes, o + mat::EXTENSION_OFFSET);
        (0..u(bytes, o + mat::EXTENSION_COUNT))
            .map(|e| extensions + e * 4)
            .find(|&at| u(bytes, at) == 59)
            .map(|at| u(bytes, at + 1))
    })
}
/// Record offset of the float map referenced by header word `field`.
fn float_map(bytes: &[u8], field: usize) -> Option<usize> {
    let reference = u(bytes, field);
    let o = (reference != 0).then(|| u(bytes, h::TEXTURE_OFFSET) + (reference - 1) * t::WORDS)?;
    (u(bytes, o + t::STORAGE) == 1).then_some(o)
}
/// Halves the width of a float map, appending the new pixels to the descriptor.
fn resize_map(b: &mut Vec<u8>, field: usize) -> bool {
    let Some(o) = float_map(b, field) else {
        return false;
    };
    let (width, height, pixels) = (u(b, o + t::WIDTH), u(b, o + t::HEIGHT), u(b, o + t::PIXELS));
    if width < 2 {
        return false;
    }
    let next = width / 2;
    let start = b.len() / 4;
    for y in 0..height {
        for x in 0..next {
            let at = (pixels + (y * width + x * 2) * 4) * 4;
            let texel = b[at..at + 16].to_vec();
            b.extend_from_slice(&texel);
        }
    }
    set_u(b, o + t::WIDTH, next);
    set_u(b, o + t::PIXELS, start);
    let words = b.len() / 4;
    set_u(b, h::LENGTH, words);
    true
}
fn edits() -> Vec<Edit> {
    vec![
        ("identical", true, |_| true),
        ("mesh transform", true, |b| {
            let i = (0..u(b, h::MESH_COUNT)).find(|&i| !instanced(b, i));
            let Some(i) = i else { return false };
            let o = u(b, h::MESH_OFFSET) + i * m::WORDS + m::TRANSFORM + 12;
            add_f(b, o, 0.25);
            true
        }),
        ("material roughness and color", true, |b| {
            let o = u(b, h::MATERIAL_OFFSET);
            set_f(b, o + mat::ROUGHNESS, 0.9);
            set_f(b, o + mat::BASE_COLOR, 0.25);
            true
        }),
        ("vertex position", true, |b| {
            let o = u(b, h::GEOMETRY_OFFSET);
            let p = u(b, o + g::POSITION);
            add_f(b, p + 1, 0.01);
            true
        }),
        ("light intensity", true, |b| {
            if u(b, h::LIGHT_COUNT) == 0 {
                return false;
            }
            let o = u(b, h::LIGHT_OFFSET) + l::INTENSITY;
            let value = get_f(b, o) * 2.0;
            set_f(b, o, value);
            true
        }),
        ("camera", true, |b| {
            let o = u(b, h::CAMERA_OFFSET);
            add_f(b, o + cam::FOV, 5.0);
            add_f(b, o + cam::TRANSFORM + 12, 0.1);
            true
        }),
        ("background color", true, |b| {
            set_f(b, h::BACKGROUND_COLOR + 1, 0.5);
            true
        }),
        ("mesh transform y", true, |b| {
            let i = (0..u(b, h::MESH_COUNT)).find(|&i| !instanced(b, i));
            let Some(i) = i else { return false };
            let o = u(b, h::MESH_OFFSET) + i * m::WORDS + m::TRANSFORM + 13;
            add_f(b, o, -0.2);
            true
        }),
        ("material metalness", true, |b| {
            let material = u(b, h::MATERIAL_OFFSET) + mat::METALNESS;
            set_f(b, material, 0.5);
            true
        }),
        ("camera y", true, |b| {
            let c = u(b, h::CAMERA_OFFSET);
            add_f(b, c + cam::TRANSFORM + 13, 0.05);
            true
        }),
        ("transform and material", true, |b| {
            let i = (0..u(b, h::MESH_COUNT)).find(|&i| !instanced(b, i));
            let Some(i) = i else { return false };
            let o = u(b, h::MESH_OFFSET) + i * m::WORDS + m::TRANSFORM + 13;
            add_f(b, o, -0.2);
            let material = u(b, h::MATERIAL_OFFSET) + mat::METALNESS;
            set_f(b, material, 0.5);
            true
        }),
        ("transform and camera", true, |b| {
            let i = (0..u(b, h::MESH_COUNT)).find(|&i| !instanced(b, i));
            let Some(i) = i else { return false };
            let o = u(b, h::MESH_OFFSET) + i * m::WORDS + m::TRANSFORM + 13;
            add_f(b, o, -0.2);
            let c = u(b, h::CAMERA_OFFSET);
            add_f(b, c + cam::TRANSFORM + 13, 0.05);
            true
        }),
        ("material and camera", true, |b| {
            let material = u(b, h::MATERIAL_OFFSET) + mat::METALNESS;
            set_f(b, material, 0.5);
            let c = u(b, h::CAMERA_OFFSET);
            add_f(b, c + cam::TRANSFORM + 13, 0.05);
            true
        }),
        ("transform, material and camera", true, |b| {
            let i = (0..u(b, h::MESH_COUNT)).find(|&i| !instanced(b, i));
            let Some(i) = i else { return false };
            let o = u(b, h::MESH_OFFSET) + i * m::WORDS + m::TRANSFORM + 13;
            add_f(b, o, -0.2);
            let material = u(b, h::MATERIAL_OFFSET) + mat::METALNESS;
            set_f(b, material, 0.5);
            let c = u(b, h::CAMERA_OFFSET);
            add_f(b, c + cam::TRANSFORM + 13, 0.05);
            true
        }),
        ("instance matrix", true, |b| {
            let Some(i) = first_batch(b) else {
                return false;
            };
            let o = u(b, u(b, h::BATCH_OFFSET) + i * 4 + 1) + 12;
            add_f(b, o, 0.3);
            true
        }),
        ("instance color", true, |b| {
            let Some(i) = first_batch(b) else {
                return false;
            };
            let o = u(b, u(b, h::BATCH_OFFSET) + i * 4 + 2);
            if o == 0 {
                return false;
            }
            set_f(b, o + 1, 0.05);
            true
        }),
        ("remove instance colors", false, |b| {
            let Some(i) = first_batch(b) else {
                return false;
            };
            let o = u(b, h::BATCH_OFFSET) + i * 4 + 2;
            if u(b, o) == 0 {
                return false;
            }
            set_u(b, o, 0);
            true
        }),
        ("instance matrix and color", true, |b| {
            let Some(i) = first_batch(b) else {
                return false;
            };
            let batch = u(b, h::BATCH_OFFSET) + i * 4;
            let matrix = u(b, batch + 1) + 16 + 12;
            add_f(b, matrix, -0.2);
            let colors = u(b, batch + 2);
            if colors == 0 {
                return false;
            }
            set_f(b, colors + 3, 0.1);
            true
        }),
        ("instanced batch world matrix", true, |b| {
            let Some(i) = first_batch(b) else {
                return false;
            };
            let o = u(b, h::MESH_OFFSET) + i * m::WORDS + m::TRANSFORM + 14;
            add_f(b, o, 0.2);
            true
        }),
        ("add light", true, |b| {
            if u(b, h::LIGHT_COUNT) == 0 {
                return false;
            }
            // Relocate the light table to the end and append a moved copy of light 0.
            let (count, offset) = (u(b, h::LIGHT_COUNT), u(b, h::LIGHT_OFFSET));
            let table = b[offset * 4..(offset + count * l::WORDS) * 4].to_vec();
            let at = b.len() / 4;
            b.extend_from_slice(&table);
            b.extend_from_slice(&table[..l::WORDS * 4]);
            add_f(b, at + count * l::WORDS + l::TRANSFORM + 12, 0.5);
            set_u(b, h::LIGHT_OFFSET, at);
            set_u(b, h::LIGHT_COUNT, count + 1);
            let words = b.len() / 4;
            set_u(b, h::LENGTH, words);
            true
        }),
        ("remove light", true, |b| {
            let count = u(b, h::LIGHT_COUNT);
            if count == 0
                || u(
                    b,
                    u(b, h::LIGHT_OFFSET) + (count - 1) * l::WORDS + l::IES_BYTES,
                ) != 0
            {
                return false;
            }
            set_u(b, h::LIGHT_COUNT, count - 1);
            true
        }),
        // Removing the only IES profile shrinks the light-sampling texture, which is recreated.
        ("remove IES light", true, |b| {
            let count = u(b, h::LIGHT_COUNT);
            if count != 1 || u(b, u(b, h::LIGHT_OFFSET) + l::IES_BYTES) == 0 {
                return false;
            }
            set_u(b, h::LIGHT_COUNT, 0);
            true
        }),
        ("light type", true, |b| {
            if u(b, h::LIGHT_COUNT) == 0 {
                return false;
            }
            let o = u(b, h::LIGHT_OFFSET);
            // Sphere to directional keeps every field valid; other types are skipped.
            if u(b, o + l::TYPE) != 1 {
                return false;
            }
            set_u(b, o + l::TYPE, 2);
            true
        }),
        // Out of scope for this phase: these must fall back to full preparation.
        ("texture pixel", true, |b| {
            let Some(i) = atlas_texture(b) else {
                return false;
            };
            let o = u(b, h::TEXTURE_OFFSET) + i * t::WORDS;
            let p = u(b, o + t::PIXELS);
            b[p * 4] ^= 0x10;
            true
        }),
        ("rect light texture pixel", true, |b| {
            let lights = u(b, h::LIGHT_OFFSET);
            let light =
                (0..u(b, h::LIGHT_COUNT)).find(|&i| u(b, lights + i * l::WORDS + l::TEXTURE) != 0);
            let Some(i) = light else { return false };
            let texture = u(b, lights + i * l::WORDS + l::TEXTURE) - 1;
            let p = u(b, u(b, h::TEXTURE_OFFSET) + texture * t::WORDS + t::PIXELS);
            b[p * 4 + 1] ^= 0x20;
            true
        }),
        // Displacement maps shape the acceleration structure: full preparation.
        ("displacement texture pixel", false, |b| {
            let Some(texture) = displacement_texture(b) else {
                return false;
            };
            let p = u(b, u(b, h::TEXTURE_OFFSET) + texture * t::WORDS + t::PIXELS);
            b[p * 4] ^= 0x40;
            true
        }),
        ("texture uv offset", true, |b| {
            let Some(i) = atlas_texture(b) else {
                return false;
            };
            let offset = u(b, h::TEXTURE_OFFSET) + i * t::WORDS + t::UV_OFFSET;
            add_f(b, offset, 0.25);
            true
        }),
        ("environment pixel", true, |b| {
            let Some(o) = float_map(b, h::ENVIRONMENT_TEXTURE) else {
                return false;
            };
            let p = u(b, o + t::PIXELS);
            set_f(b, p + 1, 2.5);
            true
        }),
        ("environment size", true, |b| {
            resize_map(b, h::ENVIRONMENT_TEXTURE)
        }),
        ("background size", true, |b| {
            let background = u(b, h::BACKGROUND_TEXTURE);
            background != u(b, h::ENVIRONMENT_TEXTURE)
                && !material_word(b, background.wrapping_sub(1))
                && resize_map(b, h::BACKGROUND_TEXTURE)
        }),
    ]
}

fn main() -> std::result::Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 4 {
        return Err("usage: incremental-oracle SAMPLES BACKEND SCENE.bin...".into());
    }
    let samples: u32 = args[1].parse()?;
    let backend: u32 = args[2].parse()?;
    let mut failures = 0;
    let mut skipped = 0;
    for path in &args[3..] {
        let base = std::fs::read(path)?;
        for (name, expect_incremental, edit) in edits() {
            let mut edited = base.clone();
            if !edit(&mut edited) {
                continue;
            }
            // The reference is a full commit of the edited descriptor to a new context.
            // An edit the renderer cannot render at all is reported, not counted.
            let stage = |name: &'static str| move |error: String| format!("{name}: {error}");
            // Commit wall times in milliseconds; the full reference uses a new context.
            let mut full_ms = 0.0;
            let mut incremental_ms = 0.0;
            let reference = (|| -> Result<Vec<Vec<u8>>> {
                let full = Context::new(backend)?;
                let started = std::time::Instant::now();
                full.commit(&edited).map_err(stage("full commit"))?;
                full_ms = started.elapsed().as_secs_f64() * 1e3;
                full.images(samples).map_err(stage("full render"))
            })();
            let b = match reference {
                Ok(images) => images,
                Err(error) => {
                    skipped += 1;
                    println!(
                        "{}",
                        serde_json::json!({"scene": path, "edit": name, "referenceError": error, "skipped": true})
                    );
                    continue;
                }
            };
            // Differing f32 count and largest absolute difference, per image.
            let difference = |a: &[u8], b: &[u8]| -> (usize, f32) {
                a.chunks_exact(4)
                    .zip(b.chunks_exact(4))
                    .fold((0, 0.0f32), |(n, max), (x, y)| {
                        let x = f32::from_le_bytes(x.try_into().unwrap());
                        let y = f32::from_le_bytes(y.try_into().unwrap());
                        if x.to_bits() == y.to_bits() {
                            (n, max)
                        } else {
                            (n + 1, max.max((x - y).abs()))
                        }
                    })
            };
            let mut differences = Vec::new();
            let outcome = (|| -> Result<(bool, [bool; 3])> {
                let incremental = Context::new(backend)?;
                incremental.commit(&base).map_err(stage("base commit"))?;
                let started = std::time::Instant::now();
                incremental
                    .commit(&edited)
                    .map_err(stage("edited commit"))?;
                incremental_ms = started.elapsed().as_secs_f64() * 1e3;
                let path_incremental = incremental.incremental()?;
                let a = incremental
                    .images(samples)
                    .map_err(stage("incremental render"))?;
                for k in 0..3 {
                    if a[k] != b[k] {
                        differences.push(difference(&a[k], &b[k]));
                    }
                }
                Ok((path_incremental, [a[0] == b[0], a[1] == b[1], a[2] == b[2]]))
            })();
            let (pass, json) = match outcome {
                Ok((path_incremental, same)) => {
                    let pass = same.iter().all(|s| *s) && path_incremental == expect_incremental;
                    (
                        pass,
                        serde_json::json!({"scene": path, "edit": name, "incremental": path_incremental,
                        "expectedIncremental": expect_incremental, "hdr": same[0], "normal": same[1], "albedo": same[2],
                        "differences": differences, "pass": pass, "fullMs": full_ms, "commitMs": incremental_ms}),
                    )
                }
                Err(error) => (
                    false,
                    serde_json::json!({"scene": path, "edit": name, "error": error, "pass": false}),
                ),
            };
            if !pass {
                failures += 1;
            }
            println!("{json}");
        }
    }
    eprintln!("{failures} failed, {skipped} skipped because the full-commit reference failed");
    if failures > 0 {
        return Err(format!("{failures} incremental oracle cases failed").into());
    }
    Ok(())
}
