//! Validated raw scene boundary. Only returned AOT bytes are retained by Rust.
use super::*;
mod geometry_kernels;
use crate::layout::{
    WORD_BYTES, batch as b, camera as cam, extension as ext, geometry as g, header as h, kind,
    light as l, material as mat, mesh as m, packet_entry as pe, packet_header as ph,
    resource as res, sampler, texture as t,
};
unsafe extern "C" {
    fn mt_core_geometry_kernel_hints(
        input: *const u8,
        length: usize,
        token: u32,
        output: *mut *const u8,
        size: *mut usize,
    );
    fn mt_core_scene_configure(
        input: *const u8,
        length: usize,
        token: u32,
        output: *mut *const u8,
        size: *mut usize,
    );

    fn mt_core_native_hardware_scene(
        input: *const u8,
        length: usize,
        token: u32,
        output: *mut *const u8,
        size: *mut usize,
    );
    fn mt_core_native_scene_begin(
        input: *const u8,
        length: usize,
        token: u32,
        output: *mut *const u8,
        size: *mut usize,
    );
    fn mt_core_native_scene_blas(
        input: *const u8,
        length: usize,
        token: u32,
        output: *mut *const u8,
        size: *mut usize,
    );
    fn mt_core_native_scene_finish(
        input: *const u8,
        length: usize,
        token: u32,
        output: *mut *const u8,
        size: *mut usize,
    );
    fn mt_core_scene_release(token: u32, output: *mut *const u8, size: *mut usize);
    fn mt_core_scene_sync(
        input: *const u8,
        length: usize,
        token: u32,
        output: *mut *const u8,
        size: *mut usize,
    );
    fn mt_core_scene_sync_hints(
        input: *const u8,
        length: usize,
        token: u32,
        output: *mut *const u8,
        size: *mut usize,
    );
    fn mt_core_scene_accept_sync(token: u32, output: *mut *const u8, size: *mut usize);
    fn mt_core_scene_release_sync(token: u32, output: *mut *const u8, size: *mut usize);
    fn mt_core_scene_light_list(
        input: *const u8,
        length: usize,
        token: u32,
        output: *mut *const u8,
        size: *mut usize,
    );
    fn mt_core_scene_instance_colors(
        input: *const u8,
        length: usize,
        token: u32,
        output: *mut *const u8,
        size: *mut usize,
    );
    fn mt_core_scene_atlas(
        input: *const u8,
        length: usize,
        token: u32,
        output: *mut *const u8,
        size: *mut usize,
    );
    fn mt_core_scene_material(
        input: *const u8,
        length: usize,
        token: u32,
        output: *mut *const u8,
        size: *mut usize,
    );
    fn mt_core_native_geometry_begin(
        input: *const u8,
        length: usize,
        token: u32,
        output: *mut *const u8,
        size: *mut usize,
    );
    fn mt_core_native_geometry_finish(
        input: *const u8,
        length: usize,
        token: u32,
        output: *mut *const u8,
        size: *mut usize,
    );
    fn mt_core_scene_accept_geometry(token: u32, output: *mut *const u8, size: *mut usize);
    fn mt_core_native_transform_begin(
        input: *const u8,
        length: usize,
        token: u32,
        output: *mut *const u8,
        size: *mut usize,
    );
    fn mt_core_native_transform_finish(
        input: *const u8,
        length: usize,
        token: u32,
        output: *mut *const u8,
        size: *mut usize,
    );
    fn mt_core_scene_accept_transform(token: u32, output: *mut *const u8, size: *mut usize);
    fn mt_core_scene_accept_lighting(token: u32, output: *mut *const u8, size: *mut usize);
    fn mt_core_scene_light(
        input: *const u8,
        length: usize,
        token: u32,
        output: *mut *const u8,
        size: *mut usize,
    );
    fn mt_core_scene_environment(
        input: *const u8,
        length: usize,
        token: u32,
        output: *mut *const u8,
        size: *mut usize,
    );
    fn mt_core_scene_aov(
        input: *const u8,
        length: usize,
        token: u32,
        output: *mut *const u8,
        size: *mut usize,
    );
    fn mt_core_scene_target(
        input: *const u8,
        length: usize,
        token: u32,
        output: *mut *const u8,
        size: *mut usize,
    );
    fn mt_core_scene_camera(
        input: *const u8,
        length: usize,
        width: u32,
        height: u32,
        output: *mut *const u8,
        size: *mut usize,
    );
}
pub(crate) const MAX_BYTES: usize = 512 * 1024 * 1024;
const MAX_PREPARED_BYTES: usize = 1024 * 1024 * 1024;

// Invertibility is independent of scene units. A fixed determinant threshold
// rejects valid millimetre/small-unit glTFs such as Khronos ToyCar.
pub(crate) fn invertible_affine(matrix: &[f32; 16]) -> bool {
    if !matrix.iter().all(|v| v.is_finite())
        || [3, 7, 11].iter().any(|i| matrix[*i] != 0.)
        || matrix[15] != 1.
    {
        return false;
    }
    let column =
        |i: usize| glam::DVec3::new(matrix[i] as f64, matrix[i + 1] as f64, matrix[i + 2] as f64);
    let (a, b, c) = (column(0), column(4), column(8));
    let scale = a.length() * b.length() * c.length();
    scale > 0.
        && a.dot(b.cross(c)).abs() / scale >= 1e-12
        && glam::Mat4::from_cols_array(matrix).inverse().is_finite()
}
struct Words<'a>(&'a [u8]);
impl Words<'_> {
    fn len(&self) -> usize {
        self.0.len() / 4
    }
    fn u(&self, i: usize) -> usize {
        u32::from_le_bytes(self.0[i * 4..i * 4 + 4].try_into().unwrap()) as usize
    }
    fn f(&self, i: usize) -> f32 {
        f32::from_bits(self.u(i) as u32)
    }
    fn span(&self, off: usize, count: usize) -> Result<()> {
        if off < h::WORDS || off > self.len() || count > self.len() - off {
            return Err("Scene span is out of bounds".into());
        }
        Ok(())
    }
    fn finite(&self, off: usize, count: usize) -> Result<()> {
        if !(off..off + count).all(|i| self.f(i).is_finite()) {
            return Err("Scene contains non-finite values".into());
        }
        Ok(())
    }
    fn affine(&self, off: usize) -> Result<()> {
        self.finite(off, 16)?;
        let matrix = std::array::from_fn(|i| self.f(off + i));
        if !invertible_affine(&matrix) {
            return Err("Scene requires invertible affine transforms".into());
        }
        Ok(())
    }
    fn reserved(&self, off: usize, count: usize) -> Result<()> {
        if (off..off + count).any(|i| self.u(i) != 0) {
            return Err("Unknown scene descriptor fields".into());
        }
        Ok(())
    }
}
pub(super) fn validate(bytes: &[u8]) -> Result<()> {
    validate_changed(bytes, &[])
}
/// Like `validate`, but skips per-element scans of geometries and textures
/// marked unchanged (`commit_plan::unchanged_records`) against a descriptor
/// that already passed validation; spans and references are still checked.
pub(super) fn validate_changed(bytes: &[u8], unchanged: &[u8]) -> Result<()> {
    if bytes.len() < h::WORDS * WORD_BYTES || bytes.len() > MAX_BYTES || bytes.len() % 4 != 0 {
        return Err("Invalid scene byte length".into());
    }
    let w = Words(bytes);
    if w.u(h::VERSION) != layout::version::SCENE || w.u(h::LENGTH) != w.len() {
        return Err("Scene descriptor version/length mismatch".into());
    }
    if !crate::image_limits::valid([w.u(h::WIDTH) as u32, w.u(h::HEIGHT) as u32]) {
        return Err("Scene image dimensions exceed probe limits".into());
    }
    if w.u(h::GEOMETRY_COUNT) == 0
        || w.u(h::GEOMETRY_COUNT) > 4096
        || w.u(h::MESH_COUNT) == 0
        || w.u(h::MESH_COUNT) > 65536
        || w.u(h::MATERIAL_COUNT) == 0
        || w.u(h::MATERIAL_COUNT) > 65536
        || w.u(h::LIGHT_COUNT) > 64
        || w.u(h::TEXTURE_COUNT) > 256
    {
        return Err("Scene count exceeds probe limits; empty scenes are pending".into());
    }
    for (count, offset, stride) in [
        (h::GEOMETRY_COUNT, h::GEOMETRY_OFFSET, g::WORDS),
        (h::MESH_COUNT, h::MESH_OFFSET, m::WORDS),
        (h::MATERIAL_COUNT, h::MATERIAL_OFFSET, mat::WORDS),
        (h::LIGHT_COUNT, h::LIGHT_OFFSET, l::WORDS),
        (h::TEXTURE_COUNT, h::TEXTURE_OFFSET, t::WORDS),
    ] {
        w.span(w.u(offset), w.u(count) * stride)?;
    }
    w.reserved(h::RESERVED, 1)?;

    w.reserved(h::RESERVED_END, h::WORDS - h::RESERVED_END)?;
    if w.u(h::GROUNDED_BACKGROUND) != 0 {
        let at = w.u(h::GROUNDED_BACKGROUND);
        w.span(at, 6)?;
        w.finite(at, 5)?;
        w.reserved(at + 5, 1)?;
        if w.f(at) <= 0. || w.f(at + 1) <= w.f(at) {
            return Err("Invalid grounded background dimensions".into());
        }
    }
    if w.u(h::ENVIRONMENT_SETTINGS) != 0 {
        let at = w.u(h::ENVIRONMENT_SETTINGS);
        w.span(at, 4)?;
        w.finite(at, 4)?;
        if w.f(at) < 0. || w.f(at + 2) < 0. {
            return Err("Environment intensity must be nonnegative".into());
        }
    }
    for (field, count) in [
        (h::MESH_AOV_IDS, h::MESH_COUNT),
        (h::MATERIAL_AOV_IDS, h::MATERIAL_COUNT),
    ] {
        let offset = w.u(field);
        if offset != 0 {
            w.span(offset, w.u(count))?;
            let mut ids = std::collections::HashSet::new();
            for i in 0..w.u(count) {
                let id = w.u(offset + i);
                if id == u32::MAX as usize || !ids.insert(id) {
                    return Err("AOV IDs must be unique and cannot equal UINT32_MAX".into());
                }
            }
        }
    }
    if w.u(h::BATCH_OFFSET) != 0 {
        w.span(w.u(h::BATCH_OFFSET), w.u(h::MESH_COUNT) * b::WORDS)?;
    }
    if w.u(h::QUALITY_FLAGS) & !7 != 0
        || w.u(h::QUALITY_FLAGS) & 4 != 0 && w.u(h::BACKGROUND_TEXTURE) != 0
    {
        return Err("Unknown/incompatible scene quality flags".into());
    }
    for field in [h::ENVIRONMENT_TEXTURE, h::BACKGROUND_TEXTURE] {
        let reference = w.u(field);
        if reference > w.u(h::TEXTURE_COUNT) {
            return Err("Environment/background texture reference is out of range".into());
        }
        if reference != 0
            && w.u(w.u(h::TEXTURE_OFFSET) + (reference - 1) * t::WORDS + t::STORAGE) != 1
        {
            return Err("Environment/background requires linear RGBA32F".into());
        }
    }

    w.finite(h::BACKGROUND_COLOR, 4)?;
    let mut geometry_words = 0usize;
    let mut geometry_costs = Vec::new();
    for i in 0..w.u(h::GEOMETRY_COUNT) {
        let o = w.u(h::GEOMETRY_OFFSET) + i * g::WORDS;
        let v = w.u(o + g::VERTEX_COUNT);
        let n = w.u(o + g::INDEX_COUNT);
        if v == 0 || n == 0 || n % 3 != 0 || v > 4_000_000 || n > 12_000_000 {
            return Err("Invalid geometry counts".into());
        }
        geometry_words += v * 32 + n * 24;
        geometry_costs.push(v * 32 + n * 24);
        if geometry_words > MAX_PREPARED_BYTES / 4 {
            return Err("Prepared geometry exceeds probe budget".into());
        }
        let scan = unchanged.get(i) != Some(&1);
        w.span(w.u(o + g::POSITION), v * 3)?;
        if scan {
            w.finite(w.u(o + g::POSITION), v * 3)?;
        }
        w.span(w.u(o + g::INDICES), n)?;
        if scan && (0..n).any(|k| w.u(w.u(o + g::INDICES) + k) >= v) {
            return Err("Geometry index is out of range".into());
        }
        for (field, stride) in [
            (g::NORMAL, 3),
            (g::UV, 2),
            (g::UV1, 2),
            (g::COLOR, 3),
            (g::TANGENT, 4),
        ] {
            if w.u(o + field) != 0 {
                w.span(w.u(o + field), v * stride)?;
                if scan {
                    w.finite(w.u(o + field), v * stride)?;
                }
            }
        }
        if w.u(o + g::MATERIAL_INDEX) != 0 {
            w.span(w.u(o + g::MATERIAL_INDEX), v)?;
        }
        w.reserved(o + g::RESERVED, 2)?;
    }
    let mut expanded_instances = 0usize;
    for i in 0..w.u(h::MESH_COUNT) {
        let o = w.u(h::MESH_OFFSET) + i * m::WORDS;
        if w.u(o + m::GEOMETRY) >= w.u(h::GEOMETRY_COUNT)
            || w.u(o + m::MATERIAL) >= w.u(h::MATERIAL_COUNT)
        {
            return Err("Mesh geometry/material reference is out of range".into());
        }
        let material_count;

        material_count = w.u(o + m::MATERIAL_COUNT).max(1);
        if w.u(o + m::MATERIAL_COUNT) > 65536
            || w.u(o + m::MATERIAL_COUNT) == 0 && w.u(o + m::MATERIAL_TABLE) != 0
        {
            return Err("Invalid mesh material table".into());
        }
        if w.u(o + m::MATERIAL_COUNT) != 0 {
            w.span(w.u(o + m::MATERIAL_TABLE), w.u(o + m::MATERIAL_COUNT))?;
            if (0..w.u(o + m::MATERIAL_COUNT))
                .any(|k| w.u(w.u(o + m::MATERIAL_TABLE) + k) >= w.u(h::MATERIAL_COUNT))
            {
                return Err("Mesh material table reference is out of range".into());
            }
        }

        let geometry = w.u(h::GEOMETRY_OFFSET) + w.u(o + m::GEOMETRY) * g::WORDS;
        if w.u(geometry + g::MATERIAL_INDEX) != 0 {
            if (0..w.u(geometry + g::VERTEX_COUNT))
                .any(|k| w.u(w.u(geometry + g::MATERIAL_INDEX) + k) >= material_count)
            {
                return Err("Vertex material index is out of range".into());
            }
            geometry_words += geometry_costs[w.u(o + m::GEOMETRY)];
            if geometry_words > MAX_PREPARED_BYTES / 4 {
                return Err("Multi-material geometry expansion exceeds probe budget".into());
            }
        }
        let mut instance_count = 1;
        if w.u(h::BATCH_OFFSET) != 0 {
            let io = w.u(h::BATCH_OFFSET) + i * b::WORDS;
            w.reserved(io + b::RESERVED, 1)?;
            if w.u(io + b::COUNT) == u32::MAX as usize {
                w.reserved(io + b::TRANSFORMS, 2)?;
            } else {
                instance_count = w.u(io + b::COUNT);
                if instance_count > 65536 {
                    return Err("Too many batch instances".into());
                }
                if instance_count == 0 {
                    w.reserved(io + b::TRANSFORMS, 2)?;
                } else {
                    w.span(w.u(io + b::TRANSFORMS), instance_count * 16)?;
                    for k in 0..instance_count {
                        w.affine(w.u(io + b::TRANSFORMS) + k * 16)?;
                    }
                    if w.u(io + b::COLORS) != 0 {
                        w.span(w.u(io + b::COLORS), instance_count * 3)?;
                        w.finite(w.u(io + b::COLORS), instance_count * 3)?;
                    }
                }
            }
        }
        expanded_instances += instance_count;
        if expanded_instances > 65536 {
            return Err("Expanded instance count exceeds probe limit".into());
        }
        w.affine(o + m::TRANSFORM)?;
    }
    let mut displacement = Vec::new();
    for i in 0..w.u(h::MATERIAL_COUNT) {
        let mut disp = (u32::MAX as usize, 0.1f32, 0usize, 1f32, 0.01f32, 0f32);
        let o = w.u(h::MATERIAL_OFFSET) + i * mat::WORDS;
        w.finite(o + mat::BASE_COLOR, mat::THIN_WALLED - mat::BASE_COLOR)?;
        if [
            mat::ROUGHNESS,
            mat::METALNESS,
            mat::TRANSMISSION,
            mat::COAT_WEIGHT,
            mat::COAT_ROUGHNESS,
            mat::OPACITY,
        ]
        .iter()
        .any(|&k| !(0.0..=1.0).contains(&w.f(o + k)))
            || w.f(o + mat::IOR) < 1.0
            || w.u(o + mat::THIN_WALLED) > 1
            || [
                mat::BASE_COLOR,
                mat::BASE_COLOR + 1,
                mat::BASE_COLOR + 2,
                mat::EMISSION_COLOR,
                mat::EMISSION_COLOR + 1,
                mat::EMISSION_COLOR + 2,
                mat::EMISSION_LUMINANCE,
            ]
            .iter()
            .any(|&k| w.f(o + k) < 0.0)
        {
            return Err("Invalid material values".into());
        }
        for k in mat::MAP..mat::EXTENSION_COUNT {
            if w.u(o + k) != 0xffffffff && w.u(o + k) >= w.u(h::TEXTURE_COUNT) {
                return Err("Material texture reference is out of range".into());
            }
        }

        w.reserved(o + mat::RESERVED, 3)?;
        let count = w.u(o + mat::EXTENSION_COUNT);
        let offset = w.u(o + mat::EXTENSION_OFFSET);
        if count >= material_properties::MATERIAL_PROPERTIES.len() || count == 0 && offset != 0 {
            return Err("Invalid material extension count/offset".into());
        }
        if count != 0 {
            w.span(offset, count * ext::WORDS)?;
        }
        let mut seen = vec![false; material_properties::MATERIAL_PROPERTIES.len()];
        for i in 0..count {
            let entry = offset + i * ext::WORDS;
            let id = w.u(entry + ext::ID);
            let &(kind, variants) = material_properties::MATERIAL_PROPERTIES
                .get(id)
                .ok_or("Unknown material property ID")?;
            if kind == 6 || seen[id] {
                return Err("Unsupported or duplicate material property".into());
            }
            seen[id] = true;
            match id {
                57 => disp.2 = w.u(entry + ext::X),
                58 => disp.3 = w.f(entry + ext::X),
                59 => disp.0 = w.u(entry + ext::X),
                60 => disp.1 = w.f(entry + ext::X),
                61 => disp.4 = w.f(entry + ext::X),
                76 => disp.5 = w.f(entry + ext::X),
                _ => {}
            }
            let components = if kind == 1 {
                3
            } else if kind == 2 {
                2
            } else {
                1
            };
            w.reserved(entry + ext::X + components, 3 - components)?;
            if kind <= 2 {
                w.finite(entry + ext::X, components)?;
            } else if kind == 3 && w.u(entry + ext::X) > 1
                || kind == 4 && w.u(entry + ext::X) >= variants as usize
            {
                return Err("Invalid material boolean/enum".into());
            } else if kind == 5
                && w.u(entry + ext::X) != u32::MAX as usize
                && w.u(entry + ext::X) >= w.u(h::TEXTURE_COUNT)
            {
                return Err("Material extension texture reference is out of range".into());
            }
        }

        if disp.4 <= 0.0 {
            return Err("Displacement step size must be positive".into());
        }
        displacement.push(disp);
    }
    // Bound projective copies and numeric coordinate loops before entering AOT.
    for i in 0..w.u(h::MESH_COUNT) {
        let mesh = w.u(h::MESH_OFFSET) + i * m::WORDS;
        let material = if w.u(mesh + m::MATERIAL_COUNT) > 0 {
            w.u(w.u(mesh + m::MATERIAL_TABLE))
        } else {
            w.u(mesh + m::MATERIAL)
        };
        let (texture, scale, projection, uv_scale, _, bias) = displacement[material];
        if texture == u32::MAX as usize || (scale.abs() <= 1e-6 && bias == 0.) {
            continue;
        }
        if uv_scale.abs() > 1_000_000.0 {
            return Err("Displacement projection scale exceeds the preparation limit".into());
        }
        let geo = w.u(h::GEOMETRY_OFFSET) + w.u(mesh + m::GEOMETRY) * g::WORDS;
        let tex = w.u(h::TEXTURE_OFFSET) + texture * t::WORDS;
        let width = w.u(tex + t::WIDTH);
        if width == 0 || !width.is_power_of_two() || width != w.u(tex + t::HEIGHT) {
            return Err("Displacement requires a square power-of-two texture".into());
        }
        if projection == 0 && w.u(geo + g::UV) == 0 {
            return Err("UV displacement requires UV coordinates".into());
        }
        for (offset, count) in [
            (w.u(geo + g::POSITION), w.u(geo + g::VERTEX_COUNT) * 3),
            (w.u(geo + g::UV), w.u(geo + g::VERTEX_COUNT) * 2),
        ] {
            if offset != 0
                && (0..count)
                    .any(|k| (w.f(offset + k) as f64 * uv_scale as f64).abs() > 1_000_000.0)
            {
                return Err("Displacement coordinates exceed the preparation limit".into());
            }
        }
        if projection != 0 {
            geometry_words += geometry_costs[w.u(mesh + m::GEOMETRY)];
            if geometry_words > MAX_PREPARED_BYTES / 4 {
                return Err("Displaced geometry expansion exceeds probe budget".into());
            }
        }
    }
    let mut pixels = 0;
    for i in 0..w.u(h::TEXTURE_COUNT) {
        let o = w.u(h::TEXTURE_OFFSET) + i * t::WORDS;
        let width = w.u(o + t::WIDTH);
        let height = w.u(o + t::HEIGHT);
        if width == 0
            || height == 0
            || width > 4096
            || height > 4096
            || w.u(o + t::STORAGE) > 1
            || w.u(o + t::FLIP_Y) > 1
            || w.u(o + t::UV_CHANNEL) > 1
            || w.u(o + t::WRAP_S) > 2
            || w.u(o + t::WRAP_T) > 2
        {
            return Err("Invalid raw texture descriptor".into());
        }
        pixels += width * height;
        if pixels > 16_777_216 {
            return Err("Raw textures exceed probe budget".into());
        }
        let count = width * height * if w.u(o + t::STORAGE) == 0 { 1 } else { 4 };
        w.span(w.u(o + t::PIXELS), count)?;
        let scan = unchanged.get(w.u(h::GEOMETRY_COUNT) + i) != Some(&1);
        if scan && w.u(o + t::STORAGE) == 1 {
            w.finite(w.u(o + t::PIXELS), count)?;
        }
        w.finite(o + t::UV_SCALE, 4)?;
    }
    for i in 0..w.u(h::LIGHT_COUNT) {
        let o = w.u(h::LIGHT_OFFSET) + i * l::WORDS;
        validate_light(&w, o)?;

        w.reserved(o + l::RESERVED, 1)?;
        let reference = w.u(o + l::TEXTURE);
        if reference > w.u(h::TEXTURE_COUNT) || reference != 0 && w.u(o + l::TYPE) != 0 {
            return Err("Rectangular light texture reference/type is invalid".into());
        }
        let (offset, length) = (w.u(o + l::IES_OFFSET), w.u(o + l::IES_BYTES));
        if length == 0 {
            if offset != 0 {
                return Err("Empty IES source has an offset".into());
            }
        } else {
            if w.u(o + l::TYPE) != 3 || length > 16384 {
                return Err("IES source requires a spot light and at most 16 KiB".into());
            }
            w.span(offset, length.div_ceil(4))?;
            std::str::from_utf8(&bytes[offset * 4..offset * 4 + length])?;
        }
    }
    let o = w.u(h::CAMERA_OFFSET);
    w.span(o, cam::WORDS)?;
    validate_camera(&w, o)
}
fn validate_light(w: &Words<'_>, o: usize) -> Result<()> {
    if w.u(o + l::TYPE) > 3 {
        return Err("Unsupported analytic light type".into());
    }
    w.finite(o + l::COLOR, 7)?;
    if (1..=5).any(|k| w.f(o + k) < 0.0) {
        return Err("Negative light color/intensity/size".into());
    }
    if w.u(o + l::TYPE) == 0
        && (w.f(o + l::SIZE) <= 0.0
            || w.f(o + l::HEIGHT_OR_INNER) <= 0.0
            || !(0.0..=1.0).contains(&w.f(o + l::SPREAD_OR_OUTER)))
    {
        return Err("Invalid rectangular light".into());
    }
    if w.u(o + l::TYPE) == 3
        && (w.f(o + l::HEIGHT_OR_INNER) < 0.0
            || w.f(o + l::HEIGHT_OR_INNER) > w.f(o + l::SPREAD_OR_OUTER)
            || w.f(o + l::SPREAD_OR_OUTER) <= 0.0
            || w.f(o + l::SPREAD_OR_OUTER) >= 90.0)
    {
        return Err("Invalid spot light angles".into());
    }
    w.affine(o + l::TRANSFORM)
}
fn validate_camera(w: &Words<'_>, o: usize) -> Result<()> {
    w.finite(o + cam::FOV, 12)?;
    if w.u(o + cam::PROJECTION) > 1
        || w.f(o + cam::NEAR) <= 0.0
        || w.f(o + cam::FAR) <= w.f(o + cam::NEAR)
        || w.f(o + cam::ZOOM) <= 0.0
        || w.f(o + cam::F_STOP) < 0.0
        || w.f(o + cam::FOCUS_DISTANCE) <= 0.0
        || w.f(o + cam::SENSOR_HEIGHT) <= 0.0
        || w.f(o + cam::METERS_PER_UNIT) <= 0.0
    {
        return Err("Invalid camera lens".into());
    }
    if w.u(o + cam::PROJECTION) == 0 && !(w.f(o + cam::FOV) > 0.0 && w.f(o + cam::FOV) < 180.0)
        || w.u(o + cam::PROJECTION) == 1
            && (w.f(o + cam::LEFT) >= w.f(o + cam::RIGHT)
                || w.f(o + cam::BOTTOM) >= w.f(o + cam::TOP))
    {
        return Err("Invalid camera projection".into());
    }
    w.reserved(o + cam::RESERVED, 3)?;
    w.affine(o + cam::TRANSFORM)?;
    Ok(())
}
pub(super) fn prepare_camera(bytes: &[u8], width: u32, height: u32) -> Result<Vec<u8>> {
    let bytes = bytes.to_vec();
    let width = width;
    let height = height;
    runtime::call(move || prepare_camera_inner(&bytes, width, height))
}
fn prepare_camera_inner(bytes: &[u8], width: u32, height: u32) -> Result<Vec<u8>> {
    if bytes.len() != cam::WORDS * WORD_BYTES {
        return Err("Camera descriptor must contain exactly 128 bytes".into());
    }
    validate_camera(&Words(bytes), 0)?;
    let mut pointer = std::ptr::null();
    let mut size = 0;
    let packed = unsafe {
        mt_core_scene_camera(
            bytes.as_ptr(),
            bytes.len(),
            width,
            height,
            &mut pointer,
            &mut size,
        );
        let result = copy_core_result(pointer, size, 144);
        mt_core_reset();
        mt_core_collect();
        result?
    };
    if !packed
        .chunks_exact(4)
        .all(|b| f32::from_le_bytes(b.try_into().unwrap()).is_finite())
    {
        return Err("Camera produces non-finite GPU parameters".into());
    }
    Ok(packed)
}
// RAII lifetime matches the committed native scene, including failed candidates.
// Every AOT arena reset/collection leaves these explicitly rooted TS objects alive.
#[derive(Clone)]
pub(super) struct PreparedState(Arc<PreparedData>);
impl std::ops::Deref for PreparedState {
    type Target = PreparedData;
    fn deref(&self) -> &PreparedData {
        &self.0
    }
}
pub(super) struct PreparedData {
    token: u32,
    pub(super) settings: settings::RenderSettings,
    indexed: bool,
    material_count: usize,
    light_count: std::sync::atomic::AtomicUsize,
    authoritative_shader: Vec<u8>,
    authoritative_indices: Vec<u8>,
    authoritative_as_indices: Vec<u8>,
    authoritative_bounds: Vec<u8>,
    /// Whether the TS sync state mirrors the committed descriptor.
    synced: std::sync::atomic::AtomicBool,
}
impl Drop for PreparedData {
    fn drop(&mut self) {
        let token = self.token;
        runtime::enqueue(move || {
            let mut pointer = std::ptr::null();
            let mut size = 0;
            unsafe {
                init_core();
                mt_core_scene_release(token, &mut pointer, &mut size);
                mt_core_reset();
                mt_core_collect();
            }
        });
    }
}
/// Target-owned uniforms; `shader` is a pattern/bevel-sample variant of the scene shader.
pub(super) struct TargetPacket {
    pub camera: Vec<u8>,
    pub trace: Vec<u8>,
    /// Prepared before GPU publication so it never waits for AOT under REGISTRY.
    pub frames: Vec<[u8; 16]>,
    pub shader: Option<String>,
    pub caustics: Option<crate::caustics::Packet>,
}
// Buffer records have zero dimensions; texture records carry their exact extent.
pub(super) struct LightingUpdates {
    resources: Vec<(usize, u64, u32, u32, Vec<u8>)>,
    pub native_layout: Option<hardware::NativeLayout>,
    pub hardware_positions: Option<Vec<u8>>,
    pub hardware_writes: Vec<(usize, u64, Vec<u8>)>,
    pub changed_blases: Option<Vec<usize>>,
}
impl std::ops::Deref for LightingUpdates {
    type Target = [(usize, u64, u32, u32, Vec<u8>)];
    fn deref(&self) -> &Self::Target {
        &self.resources
    }
}
impl<'a> IntoIterator for &'a LightingUpdates {
    type Item = &'a (usize, u64, u32, u32, Vec<u8>);
    type IntoIter = std::slice::Iter<'a, (usize, u64, u32, u32, Vec<u8>)>;
    fn into_iter(self) -> Self::IntoIter {
        self.resources.iter()
    }
}
/// Change packet from the descriptor sync; see native/src/scene-sync.ts.
pub(super) struct SceneSync {
    pub meshes: u32,
    pub lights: bool,
    pub background: bool,
    pub camera: bool,
    pub resolution: bool,
    pub quality: bool,
    pub transforms: Vec<usize>,
    pub colors: Vec<usize>,
    pub geometries: Vec<usize>,
    pub materials: Vec<usize>,
}
impl SceneSync {
    fn parse(packet: &[u8]) -> Result<Self> {
        let w = Words(packet);
        if packet.len() < 44 || packet.len() % 4 != 0 || w.u(0) != 1 || w.u(1) > 2 {
            return Err("Invalid native scene sync packet".into());
        }
        let mut at = 7;
        let list = |at: &mut usize| -> Result<Vec<usize>> {
            let count = if *at < w.len() { w.u(*at) } else { usize::MAX };
            if count > w.len() - *at - 1 {
                return Err("Invalid native scene sync list".into());
            }
            let items = (0..count).map(|i| w.u(*at + 1 + i)).collect();
            *at += 1 + count;
            Ok(items)
        };
        let transforms = list(&mut at)?;
        let colors = list(&mut at)?;
        let geometries = list(&mut at)?;
        let materials = list(&mut at)?;
        Ok(Self {
            meshes: w.u(1) as u32,
            lights: w.u(2) != 0,
            background: w.u(3) != 0,
            camera: w.u(4) != 0,
            resolution: w.u(5) != 0,
            quality: w.u(6) != 0,
            transforms,
            colors,
            geometries,
            materials,
        })
    }
}
impl PreparedState {
    /// Diffs `next` against the synced descriptor; the first call syncs `previous`.
    /// `unchanged` (see `commit_plan::unchanged_records`) lets the sync skip
    /// comparing records the host found identical to `previous`.
    pub(super) fn sync(
        &self,
        previous: Arc<Vec<u8>>,
        next: Arc<Vec<u8>>,
        unchanged: Vec<u8>,
    ) -> Result<SceneSync> {
        let state = self.clone();
        runtime::call(move || {
            if !state.synced.load(std::sync::atomic::Ordering::Acquire) {
                state.sync_step(&previous)?;
                state.accept_sync_inner()?;
                state
                    .synced
                    .store(true, std::sync::atomic::Ordering::Release);
            }
            if !unchanged.is_empty() {
                let mut pointer = std::ptr::null();
                let mut size = 0;
                unsafe {
                    mt_core_scene_sync_hints(
                        unchanged.as_ptr(),
                        unchanged.len(),
                        state.token,
                        &mut pointer,
                        &mut size,
                    );
                }
                let packet = unsafe {
                    let result = copy_core_result(pointer, size, 16);
                    mt_core_collect();
                    result?
                };
                if packet[..4] != 1u32.to_le_bytes() {
                    return Err("Native sync hints rejected".into());
                }
            }
            SceneSync::parse(&state.sync_step(&next)?)
        })
    }
    fn sync_step(&self, bytes: &[u8]) -> Result<Vec<u8>> {
        let mut pointer = std::ptr::null();
        let mut size = 0;
        unsafe {
            mt_core_scene_sync(
                bytes.as_ptr(),
                bytes.len(),
                self.token,
                &mut pointer,
                &mut size,
            );
        }
        if pointer.is_null() || size < 16 || size > MAX_PREPARED_BYTES {
            return Err("Invalid AOT scene sync result".into());
        }
        let packet = unsafe {
            let result = copy_core_result(pointer, size, size);
            mt_core_collect();
            result?
        };
        exception_packet(&packet)?;
        Ok(packet)
    }
    /// Drops the sync state after an abandoned incremental commit; the next sync rebuilds it.
    pub(super) fn reset_sync(&self) -> Result<()> {
        let state = self.clone();
        runtime::call(move || {
            let mut pointer = std::ptr::null();
            let mut size = 0;
            unsafe {
                mt_core_scene_release_sync(state.token, &mut pointer, &mut size);
                let result = copy_core_result(pointer, size, 16);
                mt_core_collect();
                result?;
            }
            state
                .synced
                .store(false, std::sync::atomic::Ordering::Release);
            Ok(())
        })
    }
    /// Accepts the last sync once its changes have been applied.
    pub(super) fn accept_sync(&self) -> Result<()> {
        let state = self.clone();
        runtime::call(move || state.accept_sync_inner())
    }
    fn accept_sync_inner(&self) -> Result<()> {
        let mut pointer = std::ptr::null();
        let mut size = 0;
        unsafe {
            mt_core_scene_accept_sync(self.token, &mut pointer, &mut size);
        }
        let packet = unsafe {
            let result = copy_core_result(pointer, size, 16);
            mt_core_collect();
            result?
        };
        if packet[..4] != 1u32.to_le_bytes() {
            return Err("Native scene sync acceptance failed".into());
        }
        Ok(())
    }
    fn native_update(
        &self,
        begin: NativeStep,
        finish: NativeStep,
        bytes: &[u8],
        ids: &[usize],
    ) -> Result<LightingUpdates> {
        let requests = native_step(begin, bytes, self.token)?;
        if Words(&requests).u(ph::VERSION) == crate::layout::version::RESOURCE_WRITES {
            return lighting_packet(&requests, ids);
        }
        let tlas = if self.indexed {
            requests.clone()
        } else {
            tinybvh::jobs(&requests, true)?
        };
        let mut pointer = std::ptr::null();
        let mut size = 0;
        unsafe {
            finish(
                tlas.as_ptr(),
                tlas.len(),
                self.token,
                &mut pointer,
                &mut size,
            );
        }
        lighting_result(pointer, size, ids)
    }

    pub(super) fn geometry(&self, bytes: &[u8]) -> Result<LightingUpdates> {
        let state = self.clone();
        let bytes = bytes.to_vec();
        runtime::call(move || state.geometry_inner(&bytes))
    }
    fn geometry_inner(&self, bytes: &[u8]) -> Result<LightingUpdates> {
        if bytes.len() < 16 || bytes.len() > MAX_BYTES || bytes.len() % 4 != 0 {
            return Err("Invalid geometry update length".into());
        }
        let w = Words(bytes);
        let flags = w.u(3);
        let count = w.u(2);
        if w.u(0) != 1 || flags > 3 || count == 0 || count > 4_194_304 {
            return Err("Invalid geometry version/flags/vertex count".into());
        }
        if w.len()
            != 4 + count * (3 + usize::from(flags & 1 != 0) * 3 + usize::from(flags & 2 != 0) * 4)
        {
            return Err("Geometry attribute length mismatch".into());
        }
        w.finite(4, w.len() - 4)?;
        self.native_update(
            mt_core_native_geometry_begin,
            mt_core_native_geometry_finish,
            bytes,
            &[1, 2, 3, 7, 8, 24, 31, 38, 41, 53],
        )
    }
    pub(super) fn accept_geometry(&self) -> Result<()> {
        let state = self.clone();
        runtime::call(move || state.accept_geometry_inner())
    }
    fn accept_geometry_inner(&self) -> Result<()> {
        let mut pointer = std::ptr::null();
        let mut size = 0;
        unsafe {
            mt_core_scene_accept_geometry(self.token, &mut pointer, &mut size);
        }
        let packet = unsafe {
            let result = copy_core_result(pointer, size, 16);
            mt_core_collect();
            result?
        };
        if packet[..4] != 1u32.to_le_bytes() {
            return Err("Native geometry acceptance failed".into());
        }
        Ok(())
    }
    pub(super) fn hardware_geometry(
        &self,
        updates: &LightingUpdates,
    ) -> Result<(hardware::Capture, Assets)> {
        let mut assets: HashMap<_, _> = updates
            .iter()
            .map(|(id, _, _, _, data)| (AssetId::Packet(*id), data.clone()))
            .collect();
        assets.insert(AssetId::Packet(33), self.authoritative_shader.clone());
        assets.insert(AssetId::Packet(35), self.authoritative_indices.clone());
        assets.insert(AssetId::Packet(42), self.authoritative_as_indices.clone());
        if let Some(positions) = &updates.hardware_positions {
            assets.insert(AssetId::Packet(41), positions.clone());
        }
        assets.insert(AssetId::Packet(38), self.authoritative_bounds.clone());
        let layout = updates
            .native_layout
            .as_ref()
            .ok_or("Missing geometry HWRT metadata")?;
        let capture = hardware::capture_from_resources(&mut assets, layout)?;
        Ok((capture, assets))
    }
    pub(super) fn transform(&self, bytes: &[u8]) -> Result<LightingUpdates> {
        let state = self.clone();
        let bytes = bytes.to_vec();
        runtime::call(move || state.transform_inner(&bytes))
    }
    fn transform_inner(&self, bytes: &[u8]) -> Result<LightingUpdates> {
        if bytes.len() != 80 {
            return Err("Transform descriptor must contain exactly 80 bytes".into());
        }
        let w = Words(bytes);
        if w.u(0) != 1 || w.u(3) != 0 {
            return Err("Invalid transform version/reserved fields".into());
        }
        w.affine(4)?;
        self.native_update(
            mt_core_native_transform_begin,
            mt_core_native_transform_finish,
            bytes,
            &[1, 2, 7, 8, 24, 31],
        )
    }
    pub(super) fn accept_transform(&self) -> Result<()> {
        let state = self.clone();
        runtime::call(move || state.accept_transform_inner())
    }
    fn accept_transform_inner(&self) -> Result<()> {
        let mut pointer = std::ptr::null();
        let mut size = 0;
        unsafe {
            mt_core_scene_accept_transform(self.token, &mut pointer, &mut size);
        }
        let packet = unsafe {
            let result = copy_core_result(pointer, size, 16);
            mt_core_collect();
            result?
        };
        if packet[..4] != 1u32.to_le_bytes() {
            return Err("Native transform acceptance failed".into());
        }
        Ok(())
    }
    pub(super) fn environment(&self, bytes: &[u8]) -> Result<LightingUpdates> {
        let state = self.clone();
        let bytes = bytes.to_vec();
        runtime::call(move || state.environment_inner(&bytes))
    }
    fn environment_inner(&self, bytes: &[u8]) -> Result<LightingUpdates> {
        if bytes.len() < 48 || bytes.len() > MAX_BYTES || bytes.len() % 4 != 0 {
            return Err("Invalid environment descriptor length".into());
        }
        let w = Words(bytes);
        if ![1, 2, 3].contains(&w.u(0)) || w.u(3) > 1 || w.u(10) != 0 || w.u(11) != 0 {
            return Err("Invalid environment version/visibility/reserved fields".into());
        }
        let mut pixels = 0;
        for i in [1, 8] {
            let (width, height) = (w.u(i), w.u(i + 1));
            if (width == 0) != (height == 0)
                || width > 16382
                || height > 16382
                || width * height > 4_194_304
            {
                return Err("Environment dimensions exceed limits".into());
            }
            pixels += width * height;
        }
        let header = match w.u(0) {
            3 => 24,
            2 => 16,
            _ => 12,
        };
        if w.len() != header + pixels * 4 {
            return Err("Environment pixel length mismatch".into());
        }
        w.finite(4, 4)?;
        if header >= 16 {
            w.finite(12, 4)?;
            if w.f(12) < 0. || w.f(14) < 0. {
                return Err("Environment intensity must be nonnegative".into());
            }
        }
        if header == 24 {
            w.finite(16, 5)?;
            w.reserved(21, 3)?;
            if w.f(16) < 0. || w.f(16) > 0. && w.f(17) <= w.f(16) {
                return Err("Invalid grounded background dimensions".into());
            }
        }
        w.finite(header, pixels * 4)?;
        if (header..w.len()).any(|i| w.f(i) < 0.) {
            return Err("Environment pixels must be nonnegative".into());
        }
        let mut pointer = std::ptr::null();
        let mut size = 0;
        unsafe {
            mt_core_scene_environment(
                bytes.as_ptr(),
                bytes.len(),
                self.token,
                &mut pointer,
                &mut size,
            );
        }
        lighting_result(pointer, size, &[7, 8, 21, 22, 23, 24])
    }
    pub(super) fn light(&self, bytes: &[u8]) -> Result<LightingUpdates> {
        let state = self.clone();
        let bytes = bytes.to_vec();
        runtime::call(move || state.light_inner(&bytes))
    }
    fn light_inner(&self, bytes: &[u8]) -> Result<LightingUpdates> {
        if bytes.len() != cam::WORDS * WORD_BYTES {
            return Err("Light descriptor must contain exactly 128 bytes".into());
        }
        let w = Words(bytes);
        if w.u(0) != 1 || w.u(1) >= self.light_count.load(std::sync::atomic::Ordering::Acquire) {
            return Err("Invalid light descriptor version/index".into());
        }
        w.reserved(2, 2)?;
        w.reserved(12, 4)?;
        validate_light(&w, 4)?;
        let mut pointer = std::ptr::null();
        let mut size = 0;
        unsafe {
            mt_core_scene_light(
                bytes.as_ptr(),
                bytes.len(),
                self.token,
                &mut pointer,
                &mut size,
            );
        }
        lighting_result(pointer, size, &[7, 8, 24])
    }
    /// Replaces the analytic light list from a validated full descriptor.
    pub(super) fn light_list(&self, bytes: &[u8]) -> Result<LightingUpdates> {
        let state = self.clone();
        let bytes = bytes.to_vec();
        runtime::call(move || {
            let mut pointer = std::ptr::null();
            let mut size = 0;
            unsafe {
                mt_core_scene_light_list(
                    bytes.as_ptr(),
                    bytes.len(),
                    state.token,
                    &mut pointer,
                    &mut size,
                );
            }
            lighting_result(pointer, size, &[7, 8, 24])
        })
    }
    /// Instance color update for one batch: `[1, mesh, count, 0]` then RGB per instance.
    pub(super) fn instance_colors(&self, bytes: &[u8]) -> Result<LightingUpdates> {
        let state = self.clone();
        let bytes = bytes.to_vec();
        runtime::call(move || {
            let w = Words(&bytes);
            if bytes.len() < 16
                || bytes.len() % 4 != 0
                || w.u(0) != 1
                || w.u(3) != 0
                || w.len() != 4 + w.u(2) * 3
            {
                return Err("Invalid instance color update".into());
            }
            w.finite(4, w.len() - 4)?;
            let mut pointer = std::ptr::null();
            let mut size = 0;
            unsafe {
                mt_core_scene_instance_colors(
                    bytes.as_ptr(),
                    bytes.len(),
                    state.token,
                    &mut pointer,
                    &mut size,
                );
            }
            lighting_result(pointer, size, &[1, 2, 7, 8, 24])
        })
    }
    /// Repacks the material table and atlas from the full descriptor's textures.
    pub(super) fn atlas(&self, bytes: &[u8]) -> Result<LightingUpdates> {
        let state = self.clone();
        let bytes = bytes.to_vec();
        runtime::call(move || {
            let mut pointer = std::ptr::null();
            let mut size = 0;
            unsafe {
                mt_core_scene_atlas(
                    bytes.as_ptr(),
                    bytes.len(),
                    state.token,
                    &mut pointer,
                    &mut size,
                );
            }
            lighting_result(pointer, size, &[4, 5, 7, 8, 20, 24])
        })
    }
    /// Records the committed analytic light count for single-light validation.
    pub(super) fn set_light_count(&self, count: usize) {
        self.light_count
            .store(count, std::sync::atomic::Ordering::Release);
    }
    /// Camera and trace uniforms of a render target on this scene, plus the
    /// production shader when the target's sampling pattern or bevel samples differ.
    pub(crate) fn aov_metadata(&self, camera: &[u8], size: [u32; 2]) -> Result<Vec<u32>> {
        let mut input: Vec<u8> = bytemuck::cast_slice(&size).to_vec();
        input.extend_from_slice(camera);
        let state = self.clone();
        let packet = runtime::call(move || native_step(mt_core_scene_aov, &input, state.token))?;
        if packet.len() < 80 || packet.len() % 4 != 0 {
            return Err("Invalid AOV metadata".into());
        }
        Ok(bytemuck::pod_collect_to_vec::<u8, u32>(&packet[16..]))
    }
    pub(super) fn target(
        &self,
        settings: &settings::RenderSettings,
        size: [u32; 2],
        quality: u32,
        alpha_blend_strategy: u32,
        hardware: bool,
        camera: &[u8],
        loss: &crate::device_loss::DeviceLossNotifier,
        frame_inputs: bool,
    ) -> Result<TargetPacket> {
        if camera.len() != cam::WORDS * WORD_BYTES {
            return Err("Camera descriptor must contain exactly 128 bytes".into());
        }
        validate_camera(&Words(camera), 0)?;
        // The descriptor limits of a scene of this size.
        if !crate::image_limits::valid(size) || quality > 3 || alpha_blend_strategy > 1 {
            return Err(fail(
                Status::InvalidArgument,
                "Invalid render target size, quality or alpha strategy",
            ));
        }
        let mut input = settings.wire(if frame_inputs { 31 } else { 15 })?;
        let shader = if hardware {
            res::HWRT_SHADER
        } else {
            res::SOFTWARE_SHADER
        } as u32;
        input.extend_from_slice(bytemuck::cast_slice(&[
            size[0],
            size[1],
            quality,
            shader,
            1,
            alpha_blend_strategy,
            0,
            0,
        ]));
        input.extend_from_slice(camera);
        let state = self.clone();
        let packet = runtime::call_with_loss(loss, move || {
            native_step(mt_core_scene_target, &input, state.token)
        })?;
        if packet.len() < 16 {
            return Err("Invalid native render target header".into());
        }
        let w = Words(&packet);
        let (shader, camera, trace) = (w.u(1), w.u(2), w.u(3));
        let extended = w.u(0) == crate::layout::version::TARGET_PACKET;
        let header = if extended { 32 } else { 16 };
        if packet.len() < header {
            return Err("Invalid native render target header".into());
        }
        let extra = if extended {
            w.u(4) + w.u(5) + w.u(6) + w.u(7)
        } else {
            0
        };
        if camera != 144
            || trace != crate::layout::ray_uniform::BYTES
            || packet.len() != header + camera + trace + shader + extra
        {
            return Err("Invalid native render target packet".into());
        }
        let caustics = if extended {
            let base = header + camera + trace + shader;
            let meta = w.u(4);
            let distribution = w.u(5);
            let lighting = w.u(6);
            let uniform = w.u(7);
            let metadata: crate::caustics::Metadata =
                serde_json::from_slice(&packet[base..base + meta])?;
            if ![1, 2, 4, 8].contains(&metadata.workgroup_size) {
                return Err("Invalid caustic workgroup size".into());
            }
            Some(crate::caustics::Packet {
                metadata,
                distribution: packet[base + meta..base + meta + distribution].to_vec(),
                lighting: packet[base + meta + distribution..base + meta + distribution + lighting]
                    .to_vec(),
                uniform: packet[base + meta + distribution + lighting
                    ..base + meta + distribution + lighting + uniform]
                    .to_vec(),
            })
        } else {
            None
        };
        let camera_bytes = packet[header..header + camera].to_vec();
        if !camera_bytes
            .chunks_exact(4)
            .all(|b| f32::from_le_bytes(b.try_into().unwrap()).is_finite())
        {
            return Err("Camera produces non-finite GPU parameters".into());
        }
        let trace_bytes = packet[header + camera..header + camera + trace].to_vec();
        let word = |at: usize| -> [u8; 4] { trace_bytes[at..at + 4].try_into().unwrap() };
        let seed = u32::from_le_bytes(word(layout::ray_uniform::SEQUENCE_SEED));
        let bounces = i32::from_le_bytes(word(layout::ray_uniform::BOUNCES)) as f32;
        let frames = runtime::frames_with_loss(loss, bounces, seed)?;
        Ok(TargetPacket {
            caustics,
            camera: camera_bytes,
            trace: trace_bytes,
            frames,
            shader: (shader > 0)
                .then(|| {
                    String::from_utf8(
                        packet[header + camera + trace..header + camera + trace + shader].to_vec(),
                    )
                })
                .transpose()?,
        })
    }
    pub(super) fn accept_lighting(&self) -> Result<()> {
        let state = self.clone();
        runtime::call(move || state.accept_lighting_inner())
    }
    fn accept_lighting_inner(&self) -> Result<()> {
        let mut pointer = std::ptr::null();
        let mut size = 0;
        unsafe {
            mt_core_scene_accept_lighting(self.token, &mut pointer, &mut size);
        }
        let packet = unsafe {
            let result = copy_core_result(pointer, size, 16);
            mt_core_collect();
            result?
        };
        if packet[..4] != 1u32.to_le_bytes() {
            return Err("Native lighting acceptance failed".into());
        }
        Ok(())
    }
    pub(super) fn material(&self, bytes: &[u8]) -> Result<Vec<u8>> {
        let state = self.clone();
        let bytes = bytes.to_vec();
        runtime::call(move || state.material_inner(&bytes))
    }
    fn material_inner(&self, bytes: &[u8]) -> Result<Vec<u8>> {
        if bytes.len() != 48 {
            return Err("Material descriptor must contain exactly 48 bytes".into());
        }
        let w = Words(bytes);
        if w.u(0) != 1
            || w.u(1) >= self.material_count
            || w.u(2) != 0
            || w.u(3) != 0
            || w.u(11) != 0
        {
            return Err("Invalid material descriptor version/index/reserved fields".into());
        }
        w.finite(4, 7)?;
        let mut pointer = std::ptr::null();
        let mut size = 0;
        unsafe {
            mt_core_scene_material(
                bytes.as_ptr(),
                bytes.len(),
                self.token,
                &mut pointer,
                &mut size,
            );
        }
        if pointer.is_null() || size < 16 || size > 64 * 1024 * 1024 {
            return Err("Invalid AOT material command".into());
        }
        let packet = unsafe {
            let result = copy_core_result(pointer, size, size);
            mt_core_collect();
            result?
        };
        exception_packet(&packet)?;
        let w = Words(&packet);
        if w.u(0) == 2 {
            let reason = match w.u(1) {
                1 => "Native retained material state is unavailable",
                2 => "Invalid source material reference",
                3 => "Full scene commit required: unused material",
                4 => "Full scene commit required: unlit material affects emission",
                5 => "Full scene commit required: medium shader feature changed",
                _ => "Invalid AOT material rejection",
            };
            return Err(reason.into());
        }
        if w.u(0) != 1
            || w.u(1) != packet.len() - 16
            || w.u(2) != 0
            || w.u(3) != 0
            || packet.len() % 4 != 0
        {
            return Err("Invalid AOT material payload".into());
        }
        w.finite(4, w.len() - 4)?;
        Ok(packet[16..].to_vec())
    }
}
// Decode a caught TS exception without losing its operation code or message.
fn exception_packet(packet: &[u8]) -> Result<()> {
    use layout::error_packet as e;
    let header = e::WORDS * WORD_BYTES;
    if packet.len() < header {
        return Ok(());
    }
    let words = Words(packet);
    if words.u(e::STATUS) != e::REJECTED || words.u(e::TAG) != e::MAGIC {
        return Ok(());
    }
    let length = words.u(e::LENGTH);
    if length > packet.len() - header {
        return Err("Invalid native exception packet length".into());
    }
    let message = std::str::from_utf8(&packet[header..header + length])?;
    if message.starts_with("Full scene commit required:") {
        return Err(format!("{message} (native code {})", words.u(e::CODE)).into());
    }
    Err(format!("Native scene error {}: {message}", words.u(e::CODE)).into())
}

fn lighting_result(pointer: *const u8, size: usize, ids: &[usize]) -> Result<LightingUpdates> {
    if pointer.is_null() || size < 16 || size > MAX_PREPARED_BYTES || size % 4 != 0 {
        return Err("Invalid AOT scene write command".into());
    }
    let packet = unsafe {
        let result = copy_core_result(pointer, size, size);
        mt_core_collect();
        result?
    };
    lighting_packet(&packet, ids)
}
fn lighting_packet(packet: &[u8], ids: &[usize]) -> Result<LightingUpdates> {
    use crate::layout::write_entry as we;
    exception_packet(packet)?;
    let w = Words(packet);
    if w.u(ph::VERSION) == 2 {
        return Err(if w.u(ph::COUNT) == 2 {
            "Full scene commit required: resource shape or shader feature changed"
        } else {
            "Invalid or unavailable retained scene reference"
        }
        .into());
    }
    let count = w.u(ph::COUNT);
    let header_length = (ph::WORDS + count * we::WORDS) * WORD_BYTES;
    if w.u(ph::VERSION) != crate::layout::version::RESOURCE_WRITES || header_length > packet.len() {
        return Err("Invalid AOT scene write resources".into());
    }
    let mut updates = Vec::new();
    let mut native_layout = None;
    let mut hardware_positions = None;
    let mut hardware_writes = Vec::new();
    let mut changed_blases = None;
    for i in 0..count {
        let o = ph::WORDS + i * we::WORDS;
        let (id, length, offset, destination) = (
            w.u(o + we::ID),
            w.u(o + we::LENGTH),
            w.u(o + we::BYTE_OFFSET),
            w.u(o + we::DESTINATION),
        );
        let metadata = matches!(id, 31 | 38 | 41 | 53);
        // Texture destinations are array layers; the atlas is RGBA8 or RGBA16F.
        let texture = !metadata && id >= crate::layout::resource::ATLAS;
        let atlas = id == crate::layout::resource::ATLAS;
        let format = w.u(o + we::FORMAT);
        if !ids.contains(&id)
            || offset < header_length
            || offset % WORD_BYTES != 0
            || (!texture && destination % WORD_BYTES != 0)
            || (id != 31 && length % WORD_BYTES != 0)
            || offset > packet.len()
            || length > packet.len() - offset
            || w.u(o + we::KIND) != if metadata { 3 } else { usize::from(texture) }
            || if atlas {
                format != crate::layout::format::RGBA8_UNORM
                    && format != crate::layout::format::RGBA16_FLOAT
            } else {
                format
                    != if metadata {
                        0
                    } else if id == 22 {
                        4
                    } else if texture {
                        2
                    } else {
                        0
                    }
            }
        {
            return Err("Invalid AOT scene write span/format".into());
        }
        if id == 53 {
            if destination != 0 || changed_blases.is_some() || length == 0 {
                return Err("Invalid changed BLAS list".into());
            }
            changed_blases = Some(
                (offset / WORD_BYTES..(offset + length) / WORD_BYTES)
                    .map(|at| w.u(at))
                    .collect(),
            );
            continue;
        }
        if id == 38 || id == 41 {
            w.finite(offset / WORD_BYTES, length / WORD_BYTES)?;
            hardware_writes.push((
                id,
                destination as u64,
                packet[offset..offset + length].to_vec(),
            ));
            if id == 41 && destination == 0 {
                hardware_positions = Some(packet[offset..offset + length].to_vec());
            }
            continue;
        }
        if id == 31 {
            if destination != 0 {
                return Err("Invalid metadata destination".into());
            }
            native_layout = Some(serde_json::from_slice::<hardware::NativeLayout>(
                &packet[offset..offset + length],
            )?);
            continue;
        }
        if (id >= 7 || id == 3) && !atlas {
            w.finite(offset / WORD_BYTES, length / WORD_BYTES)?;
        }
        if id == 2 {
            if destination % 160 != 0 || length % 160 != 0 {
                return Err("Invalid instance write alignment".into());
            }
            for at in (offset / WORD_BYTES..(offset + length) / WORD_BYTES).step_by(40) {
                w.finite(at + 3, 37)?;
            }
        }
        updates.push((
            id,
            destination as u64,
            w.u(o + we::WIDTH) as u32,
            w.u(o + we::HEIGHT) as u32,
            packet[offset..offset + length].to_vec(),
        ));
    }
    // Full replacements still validate the TLAS graph. Dirty refits preserve its
    // topology and are checked against committed resource bounds before upload.
    if let Some(layout) = &native_layout {
        if let Some((_, _, _, _, data)) =
            updates.iter().find(|record| record.0 == 1 && record.1 == 0)
        {
            let limit = layout.blas_offset * 16;
            if limit > data.len() {
                return Err("Invalid geometry BLAS offset".into());
            }
            let mut stack = if limit == 0 { vec![] } else { vec![0usize] };
            let mut visited = 0;
            let bvh = Words(data);
            while let Some(node) = stack.pop() {
                let at = node * 4;
                visited += 1;
                if at + 8 > limit / 4 || visited > limit / 32 {
                    return Err("Invalid geometry TLAS".into());
                }
                bvh.finite(at, 3)?;
                bvh.finite(at + 4, 3)?;
                let child = bvh.u(at + 3) as u32 as i32;
                if child >= 0 {
                    stack.push(node + 2);
                    stack.push(child as usize);
                }
            }
        }
    }
    Ok(LightingUpdates {
        resources: updates,
        native_layout,
        hardware_positions,
        hardware_writes,
        changed_blases,
    })
}

#[cfg(test)]
pub(super) fn prepare_retained(
    bytes: &[u8],
    hardware: bool,
) -> Result<(Scene, Assets, PreparedState)> {
    prepare_retained_with_settings(
        bytes,
        hardware,
        u32::from(hardware),
        &settings::RenderSettings::default(),
    )
}
pub(super) fn prepare_retained_with_settings(
    bytes: &[u8],
    hardware: bool,
    backend: u32,
    settings: &settings::RenderSettings,
) -> Result<(Scene, Assets, PreparedState)> {
    let bytes = bytes.to_vec();
    let hardware = hardware;
    let backend = backend;
    let settings = *settings;
    runtime::call(move || {
        prepare_retained_with_settings_inner(&bytes, hardware, backend, &settings)
    })
}
fn prepare_retained_with_settings_inner(
    bytes: &[u8],
    hardware: bool,
    backend: u32,
    settings: &settings::RenderSettings,
) -> Result<(Scene, Assets, PreparedState)> {
    static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(1);
    let token = NEXT
        .fetch_update(
            std::sync::atomic::Ordering::Relaxed,
            std::sync::atomic::Ordering::Relaxed,
            |v| v.checked_add(1),
        )
        .map_err(|_| "Native preparation token space exhausted")?;
    let mut state = PreparedData {
        token,
        settings: *settings,
        indexed: hardware,
        authoritative_shader: Vec::new(),
        authoritative_indices: Vec::new(),
        authoritative_as_indices: Vec::new(),
        authoritative_bounds: Vec::new(),
        synced: std::sync::atomic::AtomicBool::new(false),
        light_count: std::sync::atomic::AtomicUsize::new(if bytes.len() >= 32 {
            Words(bytes).u(7)
        } else {
            0
        }),
        material_count: if bytes.len() >= 28 {
            Words(bytes).u(6)
        } else {
            0
        },
    };
    let (scene, assets) = prepare_impl(
        bytes,
        token,
        hardware,
        false,
        settings,
        if backend == 1 { 2 } else { 1 },
    )?;
    state.authoritative_shader = assets
        .get(&AssetId::Packet(33))
        .cloned()
        .unwrap_or_default();
    state.authoritative_as_indices = assets
        .get(&AssetId::Packet(42))
        .cloned()
        .unwrap_or_default();
    state.authoritative_bounds = assets
        .get(&AssetId::Packet(38))
        .cloned()
        .unwrap_or_default();
    state.authoritative_indices = assets
        .get(&AssetId::Packet(35))
        .ok_or("Missing explicit HWRT indices")?
        .clone();
    Ok((scene, assets, PreparedState(Arc::new(state))))
}
pub(super) fn prepare_hardware(bytes: &[u8]) -> Result<(Scene, Assets)> {
    prepare_diagnostic(bytes, hardware::direct_input_enabled())
}
pub(super) fn prepare_diagnostic(bytes: &[u8], hardware: bool) -> Result<(Scene, Assets)> {
    prepare_impl(
        bytes,
        0,
        hardware,
        true,
        &settings::RenderSettings::default(),
        15,
    )
}
pub(super) fn prepare(bytes: &[u8]) -> Result<(Scene, Assets)> {
    prepare_impl(
        bytes,
        0,
        false,
        false,
        &settings::RenderSettings::default(),
        1,
    )
}
/// Explicit frame-input preparation; ordinary scenes do not generate this PSO.
#[cfg(test)]
pub(super) fn prepare_frame_inputs(
    bytes: &[u8],
    settings: &settings::RenderSettings,
) -> Result<(Scene, Assets)> {
    prepare_impl(bytes, 0, false, false, settings, 17)
}
type NativeStep = unsafe extern "C" fn(*const u8, usize, u32, *mut *const u8, *mut usize);
fn native_step(step: NativeStep, bytes: &[u8], token: u32) -> Result<Vec<u8>> {
    let mut pointer = std::ptr::null();
    let mut size = 0;
    unsafe {
        step(bytes.as_ptr(), bytes.len(), token, &mut pointer, &mut size);
    }
    if pointer.is_null() || size < 16 || size > MAX_PREPARED_BYTES {
        return Err("Invalid native scene construction result".into());
    }
    let packet = unsafe {
        let result = copy_core_result(pointer, size, size);
        mt_core_collect();
        result?
    };
    exception_packet(&packet)?;
    let w = Words(&packet);
    if w.u(0) != 1
        && w.u(0) != crate::layout::version::RESOURCE_WRITES
        && w.u(0) != crate::layout::version::TARGET_PACKET
    {
        return Err(match w.u(1) {
            2 => "Full scene commit required: resource shape or shader feature changed",
            1 | 3 => "Invalid or unavailable retained scene reference",
            _ => "Native scene preparation rejected the scene",
        }
        .into());
    }
    Ok(packet)
}
fn prepare_impl(
    bytes: &[u8],
    token: u32,
    hardware: bool,
    diagnostic: bool,
    settings: &settings::RenderSettings,
    variants: u32,
) -> Result<(Scene, Assets)> {
    prepare_impl_with_kernels(bytes, token, hardware, diagnostic, settings, variants, true)
}
fn prepare_impl_with_kernels(
    bytes: &[u8],
    token: u32,
    hardware: bool,
    diagnostic: bool,
    settings: &settings::RenderSettings,
    variants: u32,
    native_kernels: bool,
) -> Result<(Scene, Assets)> {
    let bytes = bytes.to_vec();
    let token = token;
    let hardware = hardware;
    let diagnostic = diagnostic;
    let settings = *settings;
    let variants = variants;
    let native_kernels = native_kernels;
    runtime::call(move || {
        prepare_impl_with_kernels_inner(
            &bytes,
            token,
            hardware,
            diagnostic,
            &settings,
            variants,
            native_kernels,
        )
    })
}
fn prepare_impl_with_kernels_inner(
    bytes: &[u8],
    token: u32,
    hardware: bool,
    diagnostic: bool,
    settings: &settings::RenderSettings,
    variants: u32,
    native_kernels: bool,
) -> Result<(Scene, Assets)> {
    let profile = std::env::var_os("MUTRACER_NATIVE_PROFILE").is_some_and(|v| v == "1");
    let started = Instant::now();
    validate(bytes)?;
    let validated = Instant::now();
    // The ABI bytes are borrowed only during this call; the AOT decoder copies
    // every retained array. Copy result bytes before reset or collection.
    init_core();
    let configured = native_step(mt_core_scene_configure, &settings.wire(variants)?, token)?;
    if configured[..4] != 1u32.to_le_bytes() {
        return Err("Invalid render settings".into());
    }
    let kernel_start = Instant::now();
    if let Some(hints) = native_kernels
        .then(|| geometry_kernels::packet(bytes, hardware))
        .flatten()
    {
        let accepted = native_step(mt_core_geometry_kernel_hints, &hints, token)?;
        if accepted[..4] != 1u32.to_le_bytes() {
            return Err("Native geometry kernel hints rejected".into());
        }
    }
    if profile {
        native_log!(
            "{}",
            json!({"nativeDataKernelProfile":{"completedWallMs":kernel_start.elapsed().as_secs_f64()*1000.}})
        );
    }
    let work = (|| -> Result<Vec<u8>> {
        if hardware {
            let result = native_step(mt_core_native_hardware_scene, bytes, token)?;
            if profile {
                native_log!(
                    "{}",
                    json!({"nativePreparationProfile": {
                "validateMs": validated.duration_since(started).as_secs_f64()*1000.0,
                "hardwarePrepareComposeMs": validated.elapsed().as_secs_f64()*1000.0,
                "blasMs":0.0,"tlasMs":0.0}})
                );
            }
            return Ok(result);
        }
        let requests = native_step(mt_core_native_scene_begin, bytes, token)?;
        let decoded = Instant::now();
        let blases = tinybvh::jobs_with_ids(&requests, false, diagnostic)?;
        let built = Instant::now();
        let instances = native_step(mt_core_native_scene_blas, &blases, token)?;
        let packed = Instant::now();
        let tlas = tinybvh::jobs(&instances, true)?;
        let top = Instant::now();
        let result = native_step(mt_core_native_scene_finish, &tlas, token)?;
        if profile {
            native_log!(
                "{}",
                json!({"nativePreparationProfile": {
                    "validateMs": validated.duration_since(started).as_secs_f64() * 1000.0,
                    "decodeMs": decoded.duration_since(validated).as_secs_f64() * 1000.0,
                    "blasMs": built.duration_since(decoded).as_secs_f64() * 1000.0,
                    "meshMs": packed.duration_since(built).as_secs_f64() * 1000.0,
                    "tlasMs": top.duration_since(packed).as_secs_f64() * 1000.0,
                    "composeMs": top.elapsed().as_secs_f64() * 1000.0,
                }})
            );
        }
        Ok(result)
    })();
    if work.is_err() {
        let mut pointer = std::ptr::null();
        let mut size = 0;
        unsafe {
            mt_core_scene_release(token, &mut pointer, &mut size);
            mt_core_reset();
            mt_core_collect();
        }
    }
    let packet = work?;
    let w = Words(&packet);
    if w.u(ph::VERSION) == 2 {
        return Err("Native scene preparation rejected the scene".into());
    }
    let count = w.u(ph::COUNT);
    if w.u(ph::VERSION) != 1
        || !(19..=27).contains(&count)
        || packet.len() < (ph::WORDS + count * pe::WORDS) * WORD_BYTES
    {
        return Err("Invalid native resource packet".into());
    }
    let mut assets = HashMap::new();
    let mut buffers = Vec::new();
    let mut textures = Vec::new();
    let mut shader = None;
    let mut native_layout = None;
    for i in 0..count {
        let o = ph::WORDS + i * pe::WORDS;
        let id = w.u(o + pe::ID);
        let kind = w.u(o + pe::KIND);
        let length = w.u(o + pe::LENGTH);
        let offset = w.u(o + pe::BYTE_OFFSET);
        if offset < (ph::WORDS + count * pe::WORDS) * WORD_BYTES
            || offset > packet.len()
            || length > packet.len() - offset
        {
            return Err("Native resource span exceeds packet".into());
        }
        let name = AssetId::Packet(id);
        let mut data = packet[offset..offset + length].to_vec();
        if kind == kind::BUFFER {
            // Runtime storage arrays require one complete element even for empty payloads.
            let minimum = 16;
            data.resize(data.len().max(minimum), 0);
            buffers.push(Buffer {
                id,
                size: data.len() as u64,
                usage: if id <= res::MATERIALS { 140 } else { 72 },
                resource: name.clone(),
            });
        } else if kind == kind::TEXTURE {
            let (width, height, depth) = (
                w.u(o + pe::WIDTH) as u32,
                w.u(o + pe::HEIGHT) as u32,
                w.u(o + pe::LAYERS) as u32,
            );
            let (format, bpp) = crate::layout::texture_format(w.u(o + pe::FORMAT))
                .ok_or("Unknown native texture encoding")?;
            if data.len() != width as usize * height as usize * depth as usize * bpp {
                return Err("Native texture length mismatch".into());
            }
            textures.push(Texture {
                id,
                width,
                height,
                depth,
                format,
                usage: 6,
                writes: vec![TextureWrite {
                    resource: name,
                    origin: wgpu::Origin3d::ZERO,
                    size: wgpu::Extent3d {
                        width,
                        height,
                        depth_or_array_layers: depth,
                    },
                    layout: wgpu::TexelCopyBufferLayout {
                        offset: 0,
                        bytes_per_row: Some(width * bpp as u32),
                        rows_per_image: Some(height),
                    },
                }],
            });
        } else if kind == kind::WGSL {
            if id == res::SOFTWARE_SHADER {
                shader = Some(name);
            } else if id != res::HWRT_SHADER
                && id != res::HIT_SHADER
                && id != res::SOFTWARE_PATH_SHADER
                && id != res::HWRT_PATH_SHADER
                && id != res::SOFTWARE_HIT_SHADER
                && id != res::SOFTWARE_FRAME_SHADER
                && id != res::HWRT_FRAME_SHADER
            {
                return Err("Unknown native shader variant".into());
            }
        } else if kind == kind::METADATA && id == res::METADATA {
            native_layout = Some(serde_json::from_slice::<hardware::NativeLayout>(&data)?);
        } else if kind == kind::METADATA
            && (id == res::INDICES
                || id == res::DISPLACEMENT_BOUNDS
                || id == res::PRIMITIVE_IDS
                || id == res::AS_POSITIONS
                || id == res::AS_INDICES)
            && data.len() % 4 == 0
        {
            // CPU packet payload; uploaded only when HWRT is selected.
        } else {
            return Err("Unknown native resource command".into());
        }
        if assets.insert(name, data).is_some() {
            return Err("Duplicate native resource".into());
        }
    }
    if shader.is_none() && assets.contains_key(&AssetId::Packet(33)) {
        shader = Some(AssetId::Packet(33));
    }
    let shader = shader.ok_or("Missing requested production shader")?;
    let pixels = w.u(ph::WIDTH) * w.u(ph::HEIGHT);
    for id in res::COLOR..=res::SHADOW_CATCHER {
        let size = pixels * if id == res::SHADOW_CATCHER { 48 } else { 16 };
        let name = AssetId::Packet(id);
        assets.insert(name.clone(), vec![0; size]);
        buffers.push(Buffer {
            id,
            size: size as u64,
            usage: 140,
            resource: name,
        });
    }
    let groups = crate::layout::bind_groups();
    Ok((
        Scene {
            width: w.u(ph::WIDTH) as u32,
            height: w.u(ph::HEIGHT) as u32,
            shader,
            native_layout,
            entry_point: "main".into(),
            buffers,
            textures,
            samplers: vec![sampler::MATERIAL],
            bind_groups: groups,
            rt_uniform: res::TRACE_UNIFORM,
            hwrt: None,
        },
        assets,
    ))
}

/// Raw scene descriptors; paths and all bytes are borrowed for the call.
/// # Safety
/// `input` must be readable for `length` bytes and output/error strings follow
/// mutracer-debug.h. Concurrent blocking probes return a busy error.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mt_probe_render_scene(
    input: *const u8,
    length: usize,
    output: *const c_char,
    samples: u32,
    error: *mut c_char,
    error_capacity: usize,
) -> i32 {
    let result = std::panic::catch_unwind(|| -> Result<()> {
        if input.is_null() || output.is_null() || length > MAX_BYTES {
            return Err(fail(
                Status::InvalidArgument,
                "Null scene input or oversized descriptor",
            ));
        }
        if samples == 0 || samples > 16384 {
            return Err(fail(Status::InvalidArgument, "Samples must be 1..16384"));
        }
        let _entry = ENTRY_LOCK.try_lock().map_err(|error| match error {
            std::sync::TryLockError::WouldBlock => {
                fail(Status::Busy, "Native probe is already active")
            }
            std::sync::TryLockError::Poisoned(_) => "Native probe lock is poisoned".into(),
        })?;
        let bytes = unsafe { std::slice::from_raw_parts(input, length) };
        let output = unsafe { CStr::from_ptr(output) }
            .to_str()
            .map_err(|e| fail(Status::InvalidArgument, format!("Output directory: {e}")))?;
        let (scene, assets) = prepare(bytes).map_err(rejected)?;
        render_scene(
            scene,
            Path::new(output),
            &RenderOptions {
                samples,
                ..Default::default()
            },
            &assets,
        )
    });
    let (status, message) = match result {
        Ok(Ok(())) => (Status::Ok, String::new()),
        Ok(Err(e)) => (classify(e.as_ref(), Status::Error), e.to_string()),
        Err(_) => (Status::Error, "Native scene renderer panicked".into()),
    };
    status::write(error, error_capacity, status, &message)
}

#[cfg(test)]
pub(super) fn small_fixture() -> Vec<u8> {
    let mut words = vec![0u32; 132];
    words[..15].copy_from_slice(&[
        layout::version::SCENE as u32,
        132,
        8,
        8,
        1,
        1,
        1,
        0,
        0,
        32,
        44,
        64,
        88,
        88,
        88,
    ]);
    words[16..20].copy_from_slice(&[0, 0, 0, 1f32.to_bits()]);
    words[32..36].copy_from_slice(&[3, 3, 120, 129]);
    for off in [48, 104] {
        for k in [0, 5, 10, 15] {
            words[off + k] = 1f32.to_bits();
        }
    }
    for (k, x) in [(0, 0.8), (1, 0.8), (2, 0.8), (3, 0.3), (6, 1.5), (13, 1.)] {
        words[64 + k] = (x as f32).to_bits();
    }
    for k in 15..19 {
        words[64 + k] = u32::MAX;
    }
    for (k, x) in [
        (1, 45.),
        (2, 0.1),
        (3, 100.),
        (8, 1.),
        (10, 10.),
        (11, 24.),
        (12, 1.),
    ] {
        words[88 + k] = (x as f32).to_bits();
    }
    for (k, x) in [-1f32, 0., 0., 1., 0., 0., 0., 1., 0.].iter().enumerate() {
        words[120 + k] = x.to_bits();
    }
    words[129..].copy_from_slice(&[0, 1, 2]);
    words.into_iter().flat_map(u32::to_le_bytes).collect()
}
#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    unsafe extern "C" {
        fn mt_core_shader_cache(output: *mut *const u8, size: *mut usize);
    }
    #[test]
    fn aov_id_tables_validate_spans_and_background_sentinel() {
        let original = small_fixture();
        for field in [h::MESH_AOV_IDS, h::MATERIAL_AOV_IDS] {
            let mut bytes = original.clone();
            let offset = (bytes.len() / 4) as u32;
            bytes.extend_from_slice(&42u32.to_le_bytes());
            bytes[field * 4..field * 4 + 4].copy_from_slice(&offset.to_le_bytes());
            let length = (bytes.len() / 4) as u32;
            bytes[4..8].copy_from_slice(&length.to_le_bytes());
            assert!(validate(&bytes).is_ok());
            bytes[offset as usize * 4..].copy_from_slice(&u32::MAX.to_le_bytes());
            assert!(validate(&bytes).is_err());
            bytes[field * 4..field * 4 + 4].copy_from_slice(&length.to_le_bytes());
            assert!(validate(&bytes).is_err());
        }
    }
    fn shader_stats() -> [u32; 3] {
        runtime::run(|| {
            let mut pointer = std::ptr::null();
            let mut size = 0;
            unsafe {
                mt_core_shader_cache(&mut pointer, &mut size);
            }
            let packet = unsafe { copy_core_result(pointer, size, 16).unwrap() };
            std::array::from_fn(|i| {
                u32::from_le_bytes(packet[i * 4..i * 4 + 4].try_into().unwrap())
            })
        })
    }
    #[test]
    fn aot_exception_preserves_configuration_failure_and_full_commit_class() {
        let _test = ABI_TEST_LOCK.lock().unwrap();
        let error = runtime::call(|| native_step(mt_core_scene_configure, &[], 0))
            .unwrap_err()
            .to_string();
        assert!(error.contains("Native scene error 101:"), "{error}");
        assert!(error.contains("Invalid render settings size"), "{error}");
        let message = "Full scene commit required: 数据形状 changed";
        let mut packet: Vec<u8> = [2, 105, message.len() as u32, 0x45525231]
            .into_iter()
            .flat_map(u32::to_le_bytes)
            .collect();
        packet.extend_from_slice(message.as_bytes());
        let error = exception_packet(&packet).unwrap_err().to_string();
        assert!(error.starts_with(message));
        packet[8..12].copy_from_slice(&u32::MAX.to_le_bytes());
        assert!(
            exception_packet(&packet)
                .unwrap_err()
                .to_string()
                .contains("length")
        );
    }
    #[test]
    fn retained_transform_accepts_range_writes_from_the_aot_call_chain() {
        let _test = ABI_TEST_LOCK.lock().unwrap();
        let _entry = ENTRY_LOCK.lock().unwrap();
        for hardware in [false, true] {
            let (_, _, retained) = prepare_retained(&input(), hardware).unwrap();
            for translation in [0.125f32, 0.0] {
                let mut words = [0u32; 20];
                words[0] = 1;
                for index in [0, 5, 10, 15] {
                    words[4 + index] = 1f32.to_bits();
                }
                words[16] = translation.to_bits();
                let bytes: Vec<_> = words.iter().flat_map(|v| v.to_le_bytes()).collect();
                let writes = retained.transform(&bytes).unwrap();
                let (_, offset, _, _, instance) =
                    writes.iter().find(|record| record.0 == 2).unwrap();
                assert_eq!(*offset, 0);
                assert_eq!(instance.len(), 160);
                assert_eq!(
                    f32::from_le_bytes(instance[128..132].try_into().unwrap()),
                    translation
                );
                assert!(writes.iter().all(|record| record.0 == 1 || record.0 == 2));
                retained.accept_transform().unwrap();
            }
        }
    }
    #[test]
    fn generated_software_and_hardware_shaders_compile_for_vulkan_and_dx12() {
        let _test = ABI_TEST_LOCK.lock().unwrap();
        let _entry = ENTRY_LOCK.lock().unwrap();
        for (hardware, bytes) in [false, true]
            .into_iter()
            .flat_map(|hardware| [input(), displacement_input()].map(|bytes| (hardware, bytes)))
        {
            let (scene, assets, _) = prepare_retained(&bytes, hardware).unwrap();
            let source = std::str::from_utf8(&assets[&scene.shader]).unwrap();
            let module = naga::front::wgsl::parse_str(source).unwrap();
            let info = naga::valid::Validator::new(
                naga::valid::ValidationFlags::all(),
                naga::valid::Capabilities::all(),
            )
            .validate(&module)
            .unwrap_or_else(|error| panic!("{}", error.emit_to_string(source)));
            let (module, info) = naga::back::pipeline_constants::process_overrides(
                &module,
                &info,
                Some((naga::ShaderStage::Compute, &scene.entry_point)),
                &Default::default(),
            )
            .unwrap();
            naga::back::spv::write_vec(
                &module,
                &info,
                &naga::back::spv::Options::default(),
                Some(&naga::back::spv::PipelineOptions {
                    shader_stage: naga::ShaderStage::Compute,
                    entry_point: scene.entry_point.clone(),
                }),
            )
            .unwrap();
            let options = naga::back::hlsl::Options {
                shader_model: naga::back::hlsl::ShaderModel::V6_8,
                ..Default::default()
            };
            let pipeline = naga::back::hlsl::PipelineOptions {
                entry_point: Some((naga::ShaderStage::Compute, scene.entry_point.clone())),
            };
            let mut output = String::new();
            let reflection = naga::back::hlsl::Writer::new(&mut output, &options, &pipeline)
                .write(&module, &info, None)
                .unwrap();
            assert!(
                reflection
                    .entry_point_names
                    .iter()
                    .all(|entry| entry.is_ok())
            );
            assert!(!output.is_empty());
        }
    }

    #[test]
    fn production_emits_one_backend_and_reuses_aot_shader_generation() {
        let _test = ABI_TEST_LOCK.lock().unwrap();
        let _entry = ENTRY_LOCK.lock().unwrap();
        runtime::init();
        let settings = settings::RenderSettings {
            seed: 67890,
            bounces: 0,
            direct_light_candidates: 99,
            bevel_samples: 17,
            sampling_pattern: 2,
            ..Default::default()
        };
        for backend in [0, 1] {
            let (scene, assets, retained) =
                prepare_retained_with_settings(&input(), backend == 1, backend, &settings).unwrap();
            let ids = [30, 33, 34, 36, 37, 39]
                .into_iter()
                .filter(|id| assets.contains_key(&AssetId::Packet(*id)))
                .collect::<Vec<_>>();
            assert_eq!(ids, vec![if backend == 0 { 30 } else { 33 }]);
            let uniform = &assets[&AssetId::Packet(7)];
            let word =
                |offset: usize| u32::from_le_bytes(uniform[offset..offset + 4].try_into().unwrap());
            assert_eq!(word(layout::ray_uniform::SEQUENCE_SEED), 67890);
            assert_eq!(word(layout::ray_uniform::BOUNCES), 1);
            assert_eq!(word(layout::ray_uniform::DIRECT_LIGHT_CANDIDATES), 16);
            let first = shader_stats();
            let (again, repeated, _) =
                prepare_retained_with_settings(&input(), backend == 1, backend, &settings).unwrap();
            assert_eq!(assets[&scene.shader], repeated[&again.shader]);
            let second = shader_stats();
            assert_eq!(second[0], first[0]);
            assert_eq!(second[1], first[1] + 1);
            drop(retained);
        }
        let (_, diagnostics) = prepare_diagnostic(&input(), false).unwrap();
        assert!(
            [30, 33, 34, 36, 37, 39]
                .into_iter()
                .all(|id| diagnostics.contains_key(&AssetId::Packet(id)))
        );
    }

    #[test]
    fn camera_rejects_finite_inputs_with_nonfinite_packing_and_recovers() {
        let _test = ABI_TEST_LOCK.lock().unwrap();
        let _entry = ENTRY_LOCK.lock().unwrap();
        runtime::init();
        let scene = input();
        let camera = &scene[88 * 4..120 * 4];
        let expected = prepare_camera(camera, 8, 8).unwrap();
        let mut extreme = camera.to_vec();
        extreme[28 * 4..29 * 4].copy_from_slice(&f32::MAX.to_le_bytes());
        assert!(validate_camera(&Words(&extreme), 0).is_ok());
        assert!(
            prepare_camera(&extreme, 8, 8)
                .unwrap_err()
                .to_string()
                .contains("non-finite")
        );
        assert_eq!(prepare_camera(camera, 8, 8).unwrap(), expected);
    }
    pub(crate) fn input() -> Vec<u8> {
        small_fixture()
    }
    fn change(bytes: &[u8], word: usize, value: u32) -> Vec<u8> {
        let mut result = bytes.to_vec();
        result[word * 4..word * 4 + 4].copy_from_slice(&value.to_le_bytes());
        result
    }
    #[test]
    fn raw_descriptor_validation_preserves_supported_input() {
        assert!(validate(&input()).is_ok());
    }
    #[test]
    fn retired_scene_versions_are_rejected() {
        for version in [1, 2, 3] {
            assert!(validate(&change(&input(), h::VERSION, version)).is_err());
        }
    }
    #[test]
    fn bad_spans_references_numbers_and_unknown_fields_are_recoverable() {
        let bytes = input();
        for (word, value) in [
            (0, 99),
            (1, 1),
            (2, 0),
            (4, 0),
            (7, 65),
            (9, u32::MAX),
            (34, 131),
            (35, 131),
            (44, 1),
            (45, 1),
            (46, 1),
            (48, 0),
            (79, 0),
            (88, 2),
            (89, 0),
            (90, 0),
            (96, 0),
            (101, 1),
            (120, f32::NAN.to_bits()),
            (129, 3),
            (20, 1),
        ] {
            assert!(
                validate(&change(&bytes, word, value)).is_err(),
                "word {word}"
            );
        }
        assert!(validate(&[]).is_err());
        assert!(validate(&bytes[..bytes.len() - 1]).is_err());
    }
    fn extend(mut bytes: Vec<u8>, words: &[u32]) -> Vec<u8> {
        for word in words {
            bytes.extend_from_slice(&word.to_le_bytes());
        }
        let count = (bytes.len() / 4) as u32;
        bytes[4..8].copy_from_slice(&count.to_le_bytes());
        bytes
    }
    #[test]
    fn environment_roles_validate_encoding_references_and_flags() {
        let mut descriptor = vec![0u32; 16];
        descriptor[..4].copy_from_slice(&[1, 1, 1, 144]);
        descriptor[6] = 1f32.to_bits();
        descriptor[7] = 1f32.to_bits();
        descriptor[15] = 1f32.to_bits();
        let mut bytes = extend(input(), &descriptor);
        for (word, value) in [(8, 1), (13, 132), (20, 1), (21, 1)] {
            bytes = change(&bytes, word, value);
        }
        assert!(validate(&bytes).is_ok());
        for (word, value) in [(20, 2), (21, 2), (22, 8), (22, 4), (134, 0), (135, 147)] {
            assert!(
                validate(&change(&bytes, word, value)).is_err(),
                "word {word}"
            );
        }
        assert!(validate(&change(&change(&bytes, 21, 0), 22, 4)).is_ok());
    }
    #[test]
    fn texture_wrap_modes_accept_zero_defaults_and_reject_unknown_values() {
        let bytes = input();
        let offset = bytes.len() / 4;
        let record = [
            1,
            1,
            0,
            (offset + t::WORDS) as u32,
            0,
            0,
            1f32.to_bits(),
            1f32.to_bits(),
            0,
            0,
            0,
            0,
            0xffffffff,
        ];
        let bytes = change(
            &change(&extend(bytes, &record), h::TEXTURE_COUNT, 1),
            h::TEXTURE_OFFSET,
            offset as u32,
        );
        for s in 0..3 {
            for t_mode in 0..3 {
                assert!(
                    validate(&change(
                        &change(&bytes, offset + t::WRAP_S, s),
                        offset + t::WRAP_T,
                        t_mode
                    ))
                    .is_ok()
                );
            }
        }
        for axis in [t::WRAP_S, t::WRAP_T] {
            assert!(validate(&change(&bytes, offset + axis, 3)).is_err());
            assert!(validate(&change(&bytes, offset + axis, u32::MAX)).is_err());
        }
    }

    #[test]
    fn material_extensions_validate_types_uniqueness_and_support() {
        let mut bytes = extend(input(), &[5, 0.6f32.to_bits(), 0, 0]);
        bytes = change(&bytes, 83, 1);
        bytes = change(&bytes, 84, 132);
        assert!(validate(&bytes).is_ok());
        assert!(validate(&change(&change(&bytes, 132, 76), 133, (-0.2f32).to_bits())).is_ok());
        for (word, value) in [
            (132, 0),
            (132, 59),
            (132, 77),
            (133, f32::NAN.to_bits()),
            (134, 1),
            (83, 77),
            (84, 135),
        ] {
            assert!(validate(&change(&bytes, word, value)).is_err());
        }
        for (id, payload) in [(37, 2), (41, 4), (39, 0)] {
            assert!(validate(&change(&change(&bytes, 132, id), 133, payload)).is_err());
        }
        assert!(validate(&change(&change(&bytes, 132, 39), 133, u32::MAX)).is_ok());
        let duplicate = change(&extend(bytes, &[5, 0.2f32.to_bits(), 0, 0]), 83, 2);
        assert!(validate(&duplicate).is_err());
    }
    #[test]
    fn vertex_attributes_and_material_tables_reject_invalid_spans_and_indices() {
        // Three RGB colors, three XYZW tangents, local material IDs and one material table.
        let mut payload = vec![0u32; 25];
        for i in 0..3 {
            payload[9 + i * 4] = 1f32.to_bits();
            payload[12 + i * 4] = 1f32.to_bits();
        }
        let mut bytes = extend(input(), &payload);
        for (word, value) in [(39, 132), (40, 141), (41, 153), (46, 156), (47, 1)] {
            bytes = change(&bytes, word, value);
        }
        assert!(validate(&bytes).is_ok());
        for (word, value) in [
            (39, 156),
            (40, 156),
            (41, 156),
            (153, 1),
            (156, 1),
            (47, 0),
            (132, f32::NAN.to_bits()),
            (144, f32::INFINITY.to_bits()),
        ] {
            assert!(
                validate(&change(&bytes, word, value)).is_err(),
                "word {word}"
            );
        }
    }
    #[test]
    fn batches_validate_transforms_colors_empty_and_ordinary_meshes() {
        let mut payload = vec![0u32; 23];
        payload[..4].copy_from_slice(&[1, 136, 152, 0]);
        for k in [0, 5, 10, 15] {
            payload[4 + k] = 1f32.to_bits();
        }
        payload[20..].fill(1f32.to_bits());
        let bytes = change(&extend(input(), &payload), 23, 132);
        assert!(validate(&bytes).is_ok());
        for (word, value) in [
            (132, 65537),
            (133, 154),
            (134, 154),
            (135, 1),
            (136, 0),
            (139, 1f32.to_bits()),
            (152, f32::NAN.to_bits()),
            (132, 0),
            (132, u32::MAX),
        ] {
            assert!(
                validate(&change(&bytes, word, value)).is_err(),
                "word {word}"
            );
        }
        let no_arrays = change(&change(&bytes, 133, 0), 134, 0);
        assert!(validate(&change(&no_arrays, 132, 0)).is_ok());
        assert!(validate(&change(&no_arrays, 132, u32::MAX)).is_ok());
    }
    fn displacement_input() -> Vec<u8> {
        let mut payload = vec![0u32; 54];
        payload[6..10].copy_from_slice(&[2, 2, 1, 150]);
        payload[12] = 1f32.to_bits();
        payload[13] = 1f32.to_bits();
        payload[34..].copy_from_slice(&[
            59,
            0,
            0,
            0,
            60,
            0.3f32.to_bits(),
            0,
            0,
            61,
            0.01f32.to_bits(),
            0,
            0,
            57,
            0,
            0,
            0,
            58,
            1f32.to_bits(),
            0,
            0,
        ]);
        let mut bytes = extend(input(), &payload);
        for (word, value) in [(8, 1), (13, 138), (37, 132), (83, 5), (84, 166)] {
            bytes = change(&bytes, word, value);
        }
        bytes
    }

    #[test]
    fn displacement_checks_projection_uv_texture_and_numeric_limits() {
        let bytes = displacement_input();
        assert!(validate(&bytes).is_ok());
        for (word, value) in [
            (0, 2),
            (37, 0),
            (138, 3),
            (139, 1),
            (175, 0),
            (179, 4),
            (183, 1e30f32.to_bits()),
            (120, 1e30f32.to_bits()),
        ] {
            assert!(
                validate(&change(&bytes, word, value)).is_err(),
                "word {word}"
            );
        }
        assert!(validate(&change(&change(&bytes, 37, 0), 179, 1)).is_ok());
        let mut zero_coordinates = bytes.clone();
        for word in 120..129 {
            zero_coordinates = change(&zero_coordinates, word, 0);
        }
        assert!(validate(&change(&zero_coordinates, 183, 1e30f32.to_bits())).is_err());
        // Zero amplitude does not require UVs or a square texture.
        assert!(validate(&change(&change(&change(&bytes, 37, 0), 171, 0), 139, 1)).is_ok());
    }
    #[test]
    fn light_extensions_validate_roles_utf8_and_byte_spans() {
        let mut light = vec![0u32; 28];
        light[0] = 3;
        for k in 1..=7 {
            light[k] = 1f32.to_bits();
        }
        light[6] = 20f32.to_bits();
        light[7] = 40f32.to_bits();
        light[9] = 160;
        light[10] = 4;
        for k in [0, 5, 10, 15] {
            light[12 + k] = 1f32.to_bits();
        }
        light.push(u32::from_le_bytes(*b"test"));
        let mut bytes = extend(input(), &light);
        bytes = change(&change(&bytes, 7, 1), 12, 132);
        assert!(validate(&bytes).is_ok()); // Syntax is checked by the original AOT IES parser.
        for (word, value) in [
            (0, 2),
            (140, 1),
            (141, 161),
            (142, 0),
            (142, 16385),
            (143, 1),
            (160, u32::MAX),
        ] {
            assert!(
                validate(&change(&bytes, word, value)).is_err(),
                "word {word}"
            );
        }
    }
}

#[cfg(test)]
mod affine_scale_tests {
    #[test]
    fn invertibility_is_independent_of_uniform_units_and_rejects_degeneracy() {
        for scale in [0.00001, 0.0001, 0.001, 1., 1000., 1e10] {
            let matrix = glam::Mat4::from_scale_rotation_translation(
                glam::Vec3::splat(scale),
                glam::Quat::from_rotation_y(0.7),
                glam::Vec3::new(1., 2., 3.),
            );
            assert!(super::invertible_affine(&matrix.to_cols_array()), "{scale}");
        }
        for scale in [glam::Vec3::ZERO, glam::Vec3::new(1., 0., 1.)] {
            assert!(!super::invertible_affine(
                &glam::Mat4::from_scale(scale).to_cols_array()
            ));
        }
        let mut matrix = glam::Mat4::IDENTITY.to_cols_array();
        matrix[3] = 0.1;
        assert!(!super::invertible_affine(&matrix));
    }
}
