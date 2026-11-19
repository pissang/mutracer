use crate::{
    error::{Error, Result, escape},
    shot::{self, Asset, Data, Dtype, Sidecar},
};
use glam::Mat4;
use mutracer_native::scene_api::{Geometry, Scene, Texture, TexturePixels};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{self, File},
    io::{BufReader, Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::Arc,
};

#[derive(Debug, Serialize)]
pub struct Fingerprint {
    pub file: PathBuf,
    pub bytes: u64,
    pub sha256: String,
}

pub fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub fn decode_image_bytes(bytes: &[u8], hdr: bool) -> Result<image::DynamicImage> {
    use std::io::Cursor;
    let open = || image::ImageReader::new(Cursor::new(bytes)).with_guessed_format();
    let (w, h) = open()
        .map_err(|e| Error::asset("/bytes", e.to_string()))?
        .into_dimensions()
        .map_err(|e| Error::asset("/bytes", e.to_string()))?;
    let pixel_limit = if hdr {
        4_194_304
    } else {
        512 * 1024 * 1024 / 4
    };
    if w > 16384 || h > 16384 || u64::from(w) * u64::from(h) > pixel_limit {
        return Err(Error::budget("Image exceeds stream texture limits"));
    }
    open()
        .map_err(|e| Error::asset("/bytes", e.to_string()))?
        .decode()
        .map_err(|e| Error::asset("/bytes", e.to_string()))
}

pub enum Loaded {
    Gltf(Box<Scene>),
    Hdr(Texture),
    Image(Texture),
    MaterialX,
    Instances(Arc<[Mat4]>),
}

pub struct Assets {
    base: PathBuf,
    fingerprints: BTreeMap<PathBuf, Fingerprint>,
    pub loaded: BTreeMap<String, Loaded>,
    geometry_bytes: u64,
    texture_bytes: u64,
}

impl Assets {
    pub fn load(shot: &shot::Shot, base: &Path) -> Result<Self> {
        let mut this = Self {
            base: base.into(),
            fingerprints: BTreeMap::new(),
            loaded: BTreeMap::new(),
            geometry_bytes: 0,
            texture_bytes: 0,
        };
        for (name, asset) in &shot.assets {
            let pointer = format!("/assets/{}", escape(name));
            let loaded = match asset {
                Asset::Gltf(a) => {
                    let p = format!("{pointer}/gltf");
                    let file = this.file(&a.gltf, &p)?;
                    this.gltf_dependencies(&file, &p)?;
                    let imported =
                        Scene::import_gltf(&file).map_err(|e| Error::asset(&p, e.to_string()))?;
                    for warning in imported.warnings {
                        eprintln!("{}: {warning}", file.display());
                    }
                    Loaded::Gltf(Box::new(imported.scene))
                }
                Asset::Hdr(a) => {
                    Loaded::Hdr(this.image(&a.hdr, &format!("{pointer}/hdr"), true)?)
                }
                Asset::Image(a) => {
                    Loaded::Image(this.image(&a.image, &format!("{pointer}/image"), false)?)
                }
                Asset::MaterialX(a) => {
                    this.file(&a.materialx, &format!("{pointer}/materialx"))?;
                    Loaded::MaterialX
                }
                Asset::InstanceFile(a) => Loaded::Instances(this.instances(
                    &Sidecar {
                        file: a.instances.clone(),
                        dtype: Dtype::F32,
                        shape: vec![a.count, 16],
                        offset: 0,
                    },
                    &format!("{pointer}/instances"),
                )?),
                Asset::InstanceView(a) => Loaded::Instances(
                    this.instances(&a.instances, &format!("{pointer}/instances"))?,
                ),
            };
            this.loaded.insert(name.clone(), loaded);
        }
        Ok(this)
    }

    pub fn fingerprints(&self) -> impl Iterator<Item = &Fingerprint> {
        self.fingerprints.values()
    }

    fn file(&mut self, path: &Path, pointer: &str) -> Result<PathBuf> {
        let name = path.to_str().unwrap_or("");
        if name.is_empty()
            || name.chars().count() > 4096
            || name.contains('\0')
            || name.contains("://")
        {
            return Err(Error::asset(
                pointer,
                "Expected a local file path of 1 to 4096 characters",
            ));
        }
        let file = self.base.join(path);
        self.hash_file(&file, pointer)
    }

    fn hash_file(&mut self, file: &Path, pointer: &str) -> Result<PathBuf> {
        let canonical = file
            .canonicalize()
            .map_err(|e| Error::asset(pointer, format!("{}: {e}", file.display())))?;
        if !self.fingerprints.contains_key(&canonical) {
            let metadata =
                fs::metadata(&canonical).map_err(|e| Error::asset(pointer, e.to_string()))?;
            if !metadata.is_file() {
                return Err(Error::asset(
                    pointer,
                    format!("{} is not a regular file", canonical.display()),
                ));
            }
            let mut input = BufReader::new(
                File::open(&canonical).map_err(|e| Error::asset(pointer, e.to_string()))?,
            );
            let mut hash = Sha256::new();
            let bytes = std::io::copy(&mut input, &mut hash)
                .map_err(|e| Error::asset(pointer, e.to_string()))?;
            if bytes != metadata.len() {
                return Err(Error::asset(pointer, "File size changed during validation"));
            }
            self.fingerprints.insert(
                canonical.clone(),
                Fingerprint {
                    file: canonical.clone(),
                    bytes,
                    sha256: format!("{:x}", hash.finalize()),
                },
            );
        }
        // Preserve the spelling of the asset path. A glTF symlink can have its
        // external resources relative to the directory used to open it.
        Ok(file.into())
    }

    fn gltf_dependencies(&mut self, file: &Path, pointer: &str) -> Result<()> {
        let mut reader =
            BufReader::new(File::open(file).map_err(|e| Error::asset(pointer, e.to_string()))?);
        let mut header = [0; 20];
        reader
            .read_exact(&mut header)
            .map_err(|e| Error::asset(pointer, e.to_string()))?;
        let mut bytes = vec![];
        if &header[..4] == b"glTF" {
            let json_len = u32::from_le_bytes(header[12..16].try_into().unwrap()) as u64;
            if &header[16..] != b"JSON" || json_len > shot::MAX_SHOT_BYTES {
                return Err(Error::asset(
                    pointer,
                    "GLB requires a JSON chunk of at most 32 MiB",
                ));
            }
            reader
                .take(json_len)
                .read_to_end(&mut bytes)
                .map_err(|e| Error::asset(pointer, e.to_string()))?;
            if bytes.len() as u64 != json_len {
                return Err(Error::asset(pointer, "Truncated GLB JSON chunk"));
            }
        } else {
            reader
                .seek(SeekFrom::Start(0))
                .map_err(|e| Error::asset(pointer, e.to_string()))?;
            reader
                .take(shot::MAX_SHOT_BYTES + 1)
                .read_to_end(&mut bytes)
                .map_err(|e| Error::asset(pointer, e.to_string()))?;
            if bytes.len() as u64 > shot::MAX_SHOT_BYTES {
                return Err(Error::asset(pointer, "glTF JSON exceeds 32 MiB"));
            }
        }
        let json: serde_json::Value =
            serde_json::from_slice(&bytes).map_err(|e| Error::asset(pointer, e.to_string()))?;
        for kind in ["buffers", "images"] {
            for entry in json[kind].as_array().into_iter().flatten() {
                if let Some(uri) = entry["uri"]
                    .as_str()
                    .filter(|uri| !uri.starts_with("data:"))
                {
                    let path = percent_encoding::percent_decode_str(uri)
                        .decode_utf8()
                        .map_err(|e| Error::asset(pointer, e.to_string()))?;
                    if path.contains("://") {
                        return Err(Error::asset(pointer, "glTF dependencies must be local"));
                    }
                    self.hash_file(
                        &file.parent().unwrap_or(Path::new(".")).join(&*path),
                        pointer,
                    )?;
                }
            }
        }
        Ok(())
    }

    fn image(&mut self, path: &Path, pointer: &str, hdr: bool) -> Result<Texture> {
        let file = self.file(path, pointer)?;
        let open = || image::ImageReader::open(&file)?.with_guessed_format();
        let (width, height) = open()
            .map_err(|e| Error::asset(pointer, e.to_string()))?
            .into_dimensions()
            .map_err(|e| Error::asset(pointer, e.to_string()))?;
        let pixels = u64::from(width) * u64::from(height);
        if width > 16384 || height > 16384 || hdr && pixels > 4_194_304 {
            return Err(Error::at(
                3,
                pointer,
                "Image exceeds native texture limits",
                "Downsize the image before importing it.",
            ));
        }
        if !hdr {
            self.texture_bytes += pixels * 4;
            if self.texture_bytes > shot::MAX_TEXTURE_BYTES {
                return Err(Error::budget("Material images exceed 3 GiB decoded"));
            }
        }
        let decoded = open()
            .map_err(|e| Error::asset(pointer, e.to_string()))?
            .decode()
            .map_err(|e| Error::asset(pointer, e.to_string()))?;
        if hdr {
            let mut texture = Texture::rgba8(width, height, Vec::new());
            texture.pixels = TexturePixels::Rgba32F(decoded.into_rgba32f().into_raw().into());
            Ok(texture)
        } else {
            Ok(Texture::rgba8(
                width,
                height,
                decoded.into_rgba8().into_raw(),
            ))
        }
    }

    fn words(
        &mut self,
        view: &Sidecar,
        dtype: Dtype,
        tail: &[u32],
        min: u32,
        max: u32,
        pointer: &str,
    ) -> Result<Vec<[u8; 4]>> {
        if view.dtype != dtype
            || view.shape.get(1..) != Some(tail)
            || view.shape.first().is_none_or(|n| *n < min || *n > max)
            || view.offset % 4 != 0
            || view.offset > 9_007_199_254_740_991
        {
            return Err(Error::validation(
                pointer,
                "Invalid sidecar dtype, shape or byte offset",
                "Use the sidecar layout for this field and an offset divisible by four.",
            ));
        }
        let count = view.shape.iter().map(|n| u64::from(*n)).product::<u64>();
        let path = self.file(&view.file, pointer)?;
        let mut file =
            BufReader::new(File::open(&path).map_err(|e| Error::asset(pointer, e.to_string()))?);
        let len = file
            .get_ref()
            .metadata()
            .map_err(|e| Error::asset(pointer, e.to_string()))?
            .len();
        if view.offset + count * 4 > len {
            return Err(Error::asset(
                pointer,
                format!(
                    "Sidecar view ends at byte {}, beyond the {len}-byte file",
                    view.offset + count * 4
                ),
            ));
        }
        self.geometry_budget(count * 4)?;
        file.seek(SeekFrom::Start(view.offset))
            .map_err(|e| Error::asset(pointer, e.to_string()))?;
        let mut bytes = vec![0; count as usize * 4];
        file.read_exact(&mut bytes)
            .map_err(|e| Error::asset(pointer, e.to_string()))?;
        Ok(bytes
            .chunks_exact(4)
            .map(|bytes| bytes.try_into().unwrap())
            .collect())
    }

    fn geometry_budget(&mut self, bytes: u64) -> Result<()> {
        self.geometry_bytes = self.geometry_bytes.saturating_add(bytes);
        if self.geometry_bytes > shot::MAX_GEOMETRY_BYTES {
            return Err(Error::budget("Geometry exceeds 8 GiB"));
        }
        Ok(())
    }

    fn floats<const N: usize>(&mut self, data: &Data<[f32; N]>, pointer: &str) -> Result<Vec<f32>> {
        let values: Vec<_> = match data {
            Data::Inline(rows) => {
                if !(3..=10_000).contains(&rows.len()) {
                    return Err(Error::validation(
                        pointer,
                        "Expected 3 to 10000 inline vertices",
                        "Use a sidecar or glTF for larger meshes.",
                    ));
                }
                self.geometry_budget(rows.len() as u64 * N as u64 * 4)?;
                rows.iter().flatten().copied().collect()
            }
            Data::Binary(view) => self
                .words(view, Dtype::F32, &[N as u32], 3, 4_000_000, pointer)?
                .into_iter()
                .map(f32::from_le_bytes)
                .collect(),
        };
        if values.iter().any(|n| !n.is_finite()) {
            return Err(Error::validation(
                pointer,
                "Expected finite coordinates",
                "Replace NaN and infinity in the geometry.",
            ));
        }
        Ok(values)
    }

    pub fn geometry(&mut self, data: &shot::Geometry, pointer: &str) -> Result<Geometry> {
        let positions = self.floats(&data.positions, &format!("{pointer}/positions"))?;
        let count = positions.len() / 3;
        let ip = format!("{pointer}/indices");
        let indices = match &data.indices {
            Data::Inline(indices) => {
                if indices.len() > 30_000 || indices.iter().any(|&i| i >= 10_000) {
                    return Err(Error::validation(
                        &ip,
                        "Inline index range or count exceeds limits",
                        "Use a u32 sidecar for larger meshes.",
                    ));
                }
                self.geometry_budget(indices.len() as u64 * 4)?;
                indices.clone()
            }
            Data::Binary(view) => self
                .words(view, Dtype::U32, &[], 3, 12_000_000, &ip)?
                .into_iter()
                .map(u32::from_le_bytes)
                .collect(),
        };
        if indices.len() < 3
            || indices.len() % 3 != 0
            || indices.iter().any(|&i| i as usize >= count)
        {
            return Err(Error::validation(
                ip,
                "Expected triangle triples of zero-based in-range indices",
                "Check triangle topology and the number of positions.",
            ));
        }
        let mut geometry = Geometry::new(positions, indices);
        if let Some(data) = &data.normals {
            let p = format!("{pointer}/normals");
            let values = self.floats(data, &p)?;
            if values.len() != count * 3 {
                return Err(Error::validation(
                    p,
                    "Normal count differs from position count",
                    "Use one normal per position.",
                ));
            }
            geometry.normals = values.into();
        }
        if let Some(data) = &data.uv {
            let p = format!("{pointer}/uv");
            let values = self.floats(data, &p)?;
            if values.len() != count * 2 {
                return Err(Error::validation(
                    p,
                    "UV count differs from position count",
                    "Use one UV pair per position.",
                ));
            }
            geometry.uv[0] = values.into();
        }
        Ok(geometry)
    }

    fn instances(&mut self, view: &Sidecar, pointer: &str) -> Result<Arc<[Mat4]>> {
        let words = self.words(view, Dtype::F32, &[16], 1, 16_777_216, pointer)?;
        words
            .chunks_exact(16)
            .enumerate()
            .map(|(i, values)| {
                let array = std::array::from_fn(|k| f32::from_le_bytes(values[k]));
                if !shot::finite(array)
                    || [array[3], array[7], array[11], array[15]] != [0., 0., 0., 1.]
                {
                    return Err(Error::validation(
                        pointer,
                        format!("Instance {i} is not a finite affine matrix"),
                        "Write column-major 4×4 matrices with last row [0, 0, 0, 1].",
                    ));
                }
                let matrix = Mat4::from_cols_array(&array);
                if !matrix.inverse().is_finite() {
                    return Err(Error::validation(
                        pointer,
                        format!("Instance {i} is singular"),
                        "Use nonzero scale on every axis.",
                    ));
                }
                Ok(matrix)
            })
            .collect()
    }
}
