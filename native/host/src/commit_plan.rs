//! Maps a descriptor sync to the retained incremental update paths. Anything a
//! path cannot express exactly falls back to full preparation (`None`).
use crate::layout::{
    batch as bt, camera as cam, geometry as g, header as h, light as l, material as mat, mesh as m,
    texture as t,
};
use crate::scene::SceneSync;

#[derive(Debug, PartialEq)]
pub(crate) enum Step {
    Geometry(Vec<u8>),
    Transform(Vec<u8>),
    Material(Vec<u8>),
    Light(Vec<u8>),
    Environment(Vec<u8>),
    Camera(Vec<u8>),
    /// Whole analytic light list; carries the full descriptor.
    LightList(Vec<u8>),
    /// Colors of every instance in one batch: `[1, mesh, count, 0]` then RGB.
    InstanceColors(Vec<u8>),
    /// Material table and atlas repack; carries the full descriptor.
    Atlas(Vec<u8>),
}

struct Words<'a>(&'a [u8]);
impl Words<'_> {
    fn len(&self) -> usize {
        self.0.len() / 4
    }
    fn u(&self, i: usize) -> usize {
        u32::from_le_bytes(self.0[i * 4..i * 4 + 4].try_into().unwrap()) as usize
    }
    fn span(&self, offset: usize, count: usize) -> Option<&[u8]> {
        self.0.get(offset * 4..(offset + count) * 4)
    }
}
fn record(words: &[u32]) -> Vec<u8> {
    bytemuck::cast_slice(words).to_vec()
}
/// Same referenced content (offsets may differ); both absent counts as equal.
fn same_span(a: &Words, ao: usize, b: &Words, bo: usize, count: usize) -> Option<bool> {
    if (ao == 0) != (bo == 0) {
        return Some(false);
    }
    if ao == 0 {
        return Some(true);
    }
    Some(a.span(ao, count)? == b.span(bo, count)?)
}

/// Whether texture `index` has the same record and pixels in both descriptors.
fn texture_unchanged(a: &Words, b: &Words, index: usize) -> Option<bool> {
    let (ao, bo) = (
        a.u(h::TEXTURE_OFFSET) + index * t::WORDS,
        b.u(h::TEXTURE_OFFSET) + index * t::WORDS,
    );
    if (0..t::WORDS).any(|k| k != t::PIXELS && a.u(ao + k) != b.u(bo + k)) {
        return Some(false);
    }
    let texels =
        b.u(bo + t::WIDTH) * b.u(bo + t::HEIGHT) * if b.u(bo + t::STORAGE) == 0 { 1 } else { 4 };
    same_span(a, a.u(ao + t::PIXELS), b, b.u(bo + t::PIXELS), texels)
}

/// Whether a material map, texture-valued material property or light uses
/// texture `index` (packed into the atlas).
fn atlas_texture(w: &Words, index: usize) -> Option<bool> {
    for i in 0..w.u(h::MATERIAL_COUNT) {
        let o = w.u(h::MATERIAL_OFFSET) + i * mat::WORDS;
        if (mat::MAP..=mat::EMISSIVE_MAP).any(|k| w.u(o + k) == index) {
            return Some(true);
        }
        let extensions = w.u(o + mat::EXTENSION_OFFSET);
        for e in 0..w.u(o + mat::EXTENSION_COUNT) {
            let at = extensions + e * crate::layout::extension::WORDS;
            w.span(at, crate::layout::extension::WORDS)?;
            let kind = crate::material_properties::MATERIAL_PROPERTIES
                .get(w.u(at + crate::layout::extension::ID))
                .map(|&(kind, _)| kind);
            if kind == Some(TEXTURE_PROPERTY) && w.u(at + crate::layout::extension::X) == index {
                return Some(true);
            }
        }
    }
    Some(
        (0..w.u(h::LIGHT_COUNT))
            .any(|i| w.u(w.u(h::LIGHT_OFFSET) + i * l::WORDS + l::TEXTURE) == index + 1),
    )
}

/// Material property kind of texture references (see material_properties.rs).
const TEXTURE_PROPERTY: u8 = 5;
/// `MT_MAT_DISPLACEMENT_MAP` in mutracer-material-properties.h.
const DISPLACEMENT_MAP_PROPERTY: usize = 59;

/// Whether a material uses texture `index` as its displacement map.
fn displacement_texture(w: &Words, index: usize) -> Option<bool> {
    for i in 0..w.u(h::MATERIAL_COUNT) {
        let o = w.u(h::MATERIAL_OFFSET) + i * mat::WORDS;
        let extensions = w.u(o + mat::EXTENSION_OFFSET);
        for e in 0..w.u(o + mat::EXTENSION_COUNT) {
            let at = extensions + e * crate::layout::extension::WORDS;
            w.span(at, crate::layout::extension::WORDS)?;
            if w.u(at + crate::layout::extension::ID) == DISPLACEMENT_MAP_PROPERTY
                && w.u(at + crate::layout::extension::X) == index
            {
                return Some(true);
            }
        }
    }
    Some(false)
}

/// Whether a changed texture is a displacement map in either descriptor. Height
/// maps shape the displaced acceleration structures, so the scene sync prepares
/// these meshes again, as the browser library does.
pub(crate) fn displacement_map_changed(previous: &[u8], next: &[u8]) -> bool {
    let (a, b) = (Words(previous), Words(next));
    let changed = || -> Option<bool> {
        let (textures, _) = changed_textures(&a, &b)?;
        for index in textures {
            if displacement_texture(&a, index)? || displacement_texture(&b, index)? {
                return Some(true);
            }
        }
        Some(false)
    };
    changed().unwrap_or(false)
}

/// Changed textures, and whether any of them is packed into the atlas.
/// Environment and background maps travel with the environment step.
fn changed_textures(a: &Words, b: &Words) -> Option<(Vec<usize>, bool)> {
    if a.u(h::TEXTURE_COUNT) != b.u(h::TEXTURE_COUNT) {
        return None;
    }
    let (mut changed, mut atlas) = (Vec::new(), false);
    for i in 0..b.u(h::TEXTURE_COUNT) {
        if !texture_unchanged(a, b, i)? {
            atlas |= atlas_texture(a, i)? || atlas_texture(b, i)?;
            changed.push(i);
        }
    }
    Some((changed, atlas))
}

/// Whether geometry `index` has the same record and attribute contents.
fn geometry_unchanged(a: &Words, b: &Words, index: usize) -> Option<bool> {
    let (ao, bo) = (
        a.u(h::GEOMETRY_OFFSET) + index * g::WORDS,
        b.u(h::GEOMETRY_OFFSET) + index * g::WORDS,
    );
    let (vertices, indices) = (b.u(bo + g::VERTEX_COUNT), b.u(bo + g::INDEX_COUNT));
    let spans = [
        (g::POSITION, vertices * 3),
        (g::INDICES, indices),
        (g::NORMAL, vertices * 3),
        (g::UV, vertices * 2),
        (g::UV1, vertices * 2),
        (g::COLOR, vertices * 3),
        (g::TANGENT, vertices * 4),
        (g::MATERIAL_INDEX, vertices),
    ];
    if (0..g::WORDS).any(|k| spans.iter().all(|&(f, _)| f != k) && a.u(ao + k) != b.u(bo + k)) {
        return Some(false);
    }
    for (field, count) in spans {
        if !same_span(a, a.u(ao + field), b, b.u(bo + field), count)? {
            return Some(false);
        }
    }
    Some(true)
}

/// One byte per geometry, then per texture: 1 when its record and data are
/// unchanged. Empty when the counts differ (no hints apply).
pub(crate) fn unchanged_records(previous: &[u8], next: &[u8]) -> Vec<u8> {
    let (a, b) = (Words(previous), Words(next));
    if a.len() < h::WORDS
        || b.len() < h::WORDS
        || a.u(h::GEOMETRY_COUNT) != b.u(h::GEOMETRY_COUNT)
        || a.u(h::TEXTURE_COUNT) != b.u(h::TEXTURE_COUNT)
    {
        return Vec::new();
    }
    let geometries = (0..b.u(h::GEOMETRY_COUNT)).map(|i| geometry_unchanged(&a, &b, i));
    let textures = (0..b.u(h::TEXTURE_COUNT)).map(|i| texture_unchanged(&a, &b, i));
    geometries
        .chain(textures)
        .map(|same| u8::from(same == Some(true)))
        .collect()
}

/// Like [`unchanged_records`], comparing only geometries `changes` lists; the
/// scene object's delta guarantees every other record is identical.
pub(crate) fn unchanged_records_with(
    previous: &[u8],
    next: &[u8],
    changes: &crate::scene_api::Changes,
) -> Vec<u8> {
    let (a, b) = (Words(previous), Words(next));
    if a.len() < h::WORDS || b.len() < h::WORDS {
        return Vec::new();
    }
    (0..b.u(h::GEOMETRY_COUNT))
        .map(|i| !changes.geometries.contains(&i) || geometry_unchanged(&a, &b, i) == Some(true))
        .chain((0..b.u(h::TEXTURE_COUNT)).map(|_| true))
        .map(u8::from)
        .collect()
}
/// Appends one byte per material, then per mesh, to sync hints from
/// [`unchanged_records`]: 1 when `changes` leaves that record identical.
pub(crate) fn extend_object_hints(
    unchanged: &mut Vec<u8>,
    next: &[u8],
    changes: &crate::scene_api::Changes,
) {
    let b = Words(next);
    if unchanged.len() != b.u(h::GEOMETRY_COUNT) + b.u(h::TEXTURE_COUNT) {
        return;
    }
    unchanged
        .extend((0..b.u(h::MATERIAL_COUNT)).map(|i| u8::from(!changes.materials.contains(&i))));
    unchanged.extend((0..b.u(h::MESH_COUNT)).map(|i| u8::from(!changes.meshes.contains(&i))));
}

fn geometry_step(a: &Words, b: &Words, index: usize) -> Option<Step> {
    let (ao, bo) = (
        a.u(h::GEOMETRY_OFFSET) + index * g::WORDS,
        b.u(h::GEOMETRY_OFFSET) + index * g::WORDS,
    );
    let vertices = b.u(bo + g::VERTEX_COUNT);
    if a.u(ao + g::VERTEX_COUNT) != vertices || a.u(ao + g::INDEX_COUNT) != b.u(bo + g::INDEX_COUNT)
    {
        return None;
    }
    // The retained path replaces positions, normals and authored tangents only.
    for (field, count) in [
        (g::INDICES, b.u(bo + g::INDEX_COUNT)),
        (g::UV, vertices * 2),
        (g::UV1, vertices * 2),
        (g::COLOR, vertices * 3),
        (g::MATERIAL_INDEX, vertices),
    ] {
        if !same_span(a, a.u(ao + field), b, b.u(bo + field), count)? {
            return None;
        }
    }
    if (a.u(ao + g::NORMAL) == 0) != (b.u(bo + g::NORMAL) == 0)
        || (a.u(ao + g::TANGENT) == 0) != (b.u(bo + g::TANGENT) == 0)
    {
        return None;
    }
    let normals = b.u(bo + g::NORMAL) != 0;
    let tangents = b.u(bo + g::TANGENT) != 0;
    let mut bytes = record(&[
        1,
        index as u32,
        vertices as u32,
        u32::from(normals) | u32::from(tangents) << 1,
    ]);
    bytes.extend_from_slice(b.span(b.u(bo + g::POSITION), vertices * 3)?);
    if normals {
        bytes.extend_from_slice(b.span(b.u(bo + g::NORMAL), vertices * 3)?);
    }
    if tangents {
        bytes.extend_from_slice(b.span(b.u(bo + g::TANGENT), vertices * 4)?);
    }
    Some(Step::Geometry(bytes))
}

/// Above this many changed instances in one batch, full preparation is cheaper
/// than one retained transform update (and TLAS refit) per instance.
const MAX_INSTANCE_STEPS: usize = 64;

fn transform_steps(a: &Words, b: &Words, index: usize, steps: &mut Vec<Step>) -> Option<()> {
    let (am, bm) = (
        a.u(h::MESH_OFFSET) + index * m::WORDS,
        b.u(h::MESH_OFFSET) + index * m::WORDS,
    );
    let world = |words: &[u32]| -> Step {
        let mut bytes = record(words);
        bytes.extend_from_slice(b.span(bm + m::TRANSFORM, 16).unwrap_or_default());
        Step::Transform(bytes)
    };
    let batch =
        |w: &Words| (w.u(h::BATCH_OFFSET) != 0).then(|| w.u(h::BATCH_OFFSET) + index * bt::WORDS);
    let instances = batch(b).filter(|&o| b.u(o + bt::COUNT) != u32::MAX as usize);
    if a.span(am + m::TRANSFORM, 16)? != b.span(bm + m::TRANSFORM, 16)? {
        b.span(bm + m::TRANSFORM, 16)?;
        steps.push(world(&[1, index as u32, 0, 0]));
    }
    let Some(bo) = instances else { return Some(()) };
    let ao = batch(a)?;
    let count = b.u(bo + bt::COUNT);
    if a.u(ao + bt::COUNT) != count {
        return None;
    }
    let (at, btr) = (a.u(ao + bt::TRANSFORMS), b.u(bo + bt::TRANSFORMS));
    let mut changed = 0;
    for k in 0..count {
        let next = b.span(btr + k * 16, 16)?;
        if a.span(at + k * 16, 16)? == next {
            continue;
        }
        changed += 1;
        if changed > MAX_INSTANCE_STEPS {
            return None;
        }
        let mut bytes = record(&[1, index as u32, k as u32 + 1, 0]);
        bytes.extend_from_slice(next);
        steps.push(Step::Transform(bytes));
    }
    Some(())
}

/// Joins version-1 transform steps into one version-2 step, so the retained
/// scene refits its acceleration structure and lighting once for all of them.
fn transform_batch(steps: Vec<Step>) -> Step {
    let mut bytes = record(&[2, steps.len() as u32, 0, 0]);
    for step in steps {
        let Step::Transform(single) = step else {
            unreachable!()
        };
        // [1, mesh, local + 1, 0, matrix] -> [mesh, local + 1, 0, 0, matrix]
        bytes.extend_from_slice(&single[4..12]);
        bytes.extend_from_slice(&[0; 8]);
        bytes.extend_from_slice(&single[16..80]);
    }
    Step::Transform(bytes)
}

/// Colors replace values only; adding or removing a batch's colors needs full preparation.
fn instance_color_step(a: &Words, b: &Words, index: usize) -> Option<Step> {
    let batch = |w: &Words| {
        let o = (w.u(h::BATCH_OFFSET) != 0).then(|| w.u(h::BATCH_OFFSET) + index * bt::WORDS)?;
        (w.u(o + bt::COUNT) != u32::MAX as usize && w.u(o + bt::COLORS) != 0).then_some(o)
    };
    let (ao, bo) = (batch(a)?, batch(b)?);
    let count = b.u(bo + bt::COUNT);
    if a.u(ao + bt::COUNT) != count {
        return None;
    }
    let mut bytes = record(&[1, index as u32, count as u32, 0]);
    bytes.extend_from_slice(b.span(b.u(bo + bt::COLORS), count * 3)?);
    Some(Step::InstanceColors(bytes))
}

// Texture references and geometry properties are outside parameter commits.
// Missing extension entries mean defaults, so compare by ID rather than offset
// or extension count: adding the first numeric override is still incremental.
fn material_compatible(a: &Words, b: &Words, index: usize) -> Option<bool> {
    let (ao, bo) = (
        a.u(h::MATERIAL_OFFSET) + index * mat::WORDS,
        b.u(h::MATERIAL_OFFSET) + index * mat::WORDS,
    );
    if a.span(ao + mat::MAP, 4)? != b.span(bo + mat::MAP, 4)? {
        return Some(false);
    }
    let extensions = |w: &Words, o: usize| -> Option<std::collections::BTreeMap<usize, Vec<u8>>> {
        let mut entries = std::collections::BTreeMap::new();
        for i in 0..w.u(o + mat::EXTENSION_COUNT) {
            let at = w.u(o + mat::EXTENSION_OFFSET) + i * crate::layout::extension::WORDS;
            let id = w.u(at);
            // Texture properties, displacement, and UV assignments.
            if crate::material_properties::MATERIAL_PROPERTIES.get(id)?.0 == TEXTURE_PROPERTY
                || matches!(id, 55 | 56 | 57 | 58 | 60 | 61 | 76)
            {
                entries.insert(id, w.span(at, crate::layout::extension::WORDS)?.to_vec());
            }
        }
        Some(entries)
    };
    Some(extensions(a, ao)? == extensions(b, bo)?)
}

fn material_steps(a: &Words, b: &Words, indices: &[usize]) -> Option<Step> {
    // Version 2: count, reserved[2], then (source index, record offset) pairs.
    // Only changed records and their extensions cross the AOT boundary.
    let mut bytes = record(&[2, indices.len() as u32, 0, 0]);
    bytes.resize((4 + indices.len() * 2) * 4, 0);
    for (i, &index) in indices.iter().enumerate() {
        if !material_compatible(a, b, index)? {
            return None;
        }
        let bo = b.u(h::MATERIAL_OFFSET) + index * mat::WORDS;
        let offset = bytes.len() / 4;
        bytes[(4 + i * 2) * 4..(6 + i * 2) * 4]
            .copy_from_slice(&record(&[index as u32, offset as u32]));
        bytes.extend_from_slice(b.span(bo, mat::WORDS)?);
        let count = b.u(bo + mat::EXTENSION_COUNT) * crate::layout::extension::WORDS;
        let ext = if count == 0 { 0 } else { bytes.len() / 4 };
        bytes[(offset + mat::EXTENSION_OFFSET) * 4..(offset + mat::EXTENSION_OFFSET + 1) * 4]
            .copy_from_slice(&(ext as u32).to_le_bytes());
        if count > 0 {
            bytes.extend_from_slice(b.span(b.u(bo + mat::EXTENSION_OFFSET), count)?);
        }
    }
    Some(Step::Material(bytes))
}

/// Sparse changed materials for the cheap shader/transport preflight. Both
/// descriptors have already passed validation; this does not mutate sync state.
/// Only `candidates` are compared when given; every other material record
/// must then be identical.
pub(crate) fn changed_materials_with(
    previous: &[u8],
    next: &[u8],
    candidates: Option<&std::collections::BTreeSet<usize>>,
) -> Option<Vec<u8>> {
    let (a, b) = (Words(previous), Words(next));
    if a.u(h::MATERIAL_COUNT) != b.u(h::MATERIAL_COUNT) {
        return None;
    }
    let mut changed = Vec::new();
    let candidates: Vec<usize> = match candidates {
        Some(c) => c.iter().copied().collect(),
        None => (0..b.u(h::MATERIAL_COUNT)).collect(),
    };
    for index in candidates {
        let (ao, bo) = (
            a.u(h::MATERIAL_OFFSET) + index * mat::WORDS,
            b.u(h::MATERIAL_OFFSET) + index * mat::WORDS,
        );
        let same =
            (0..mat::WORDS).all(|k| k == mat::EXTENSION_OFFSET || a.u(ao + k) == b.u(bo + k));
        if !same
            || !same_span(
                &a,
                a.u(ao + mat::EXTENSION_OFFSET),
                &b,
                b.u(bo + mat::EXTENSION_OFFSET),
                b.u(bo + mat::EXTENSION_COUNT) * crate::layout::extension::WORDS,
            )?
        {
            changed.push(index);
        }
    }
    match material_steps(&a, &b, &changed)? {
        Step::Material(bytes) => Some(bytes),
        _ => unreachable!(),
    }
}

fn light_steps(a: &Words, b: &Words, next: &[u8], steps: &mut Vec<Step>) -> Option<()> {
    if a.u(h::ENVIRONMENT_TEXTURE) != b.u(h::ENVIRONMENT_TEXTURE) {
        return None;
    }
    let mut list = a.u(h::LIGHT_COUNT) != b.u(h::LIGHT_COUNT);
    let mut single = Vec::new();
    for i in 0..b.u(h::LIGHT_COUNT).min(a.u(h::LIGHT_COUNT)) {
        let (ao, bo) = (
            a.u(h::LIGHT_OFFSET) + i * l::WORDS,
            b.u(h::LIGHT_OFFSET) + i * l::WORDS,
        );
        let ies = b.u(bo + l::IES_BYTES).div_ceil(4);
        let same_ies = a.u(ao + l::IES_BYTES) == b.u(bo + l::IES_BYTES)
            && same_span(a, a.u(ao + l::IES_OFFSET), b, b.u(bo + l::IES_OFFSET), ies)?;
        if same_ies && (0..l::WORDS).all(|k| k == l::IES_OFFSET || a.u(ao + k) == b.u(bo + k)) {
            continue;
        }
        // Type and attachment changes rebuild the list; the single-light path keeps them.
        if !same_ies
            || a.u(ao + l::TYPE) != b.u(bo + l::TYPE)
            || a.u(ao + l::TEXTURE) != b.u(bo + l::TEXTURE)
        {
            list = true;
            continue;
        }
        let mut words: Vec<u8> = b.span(bo, l::WORDS)?.to_vec();
        words[l::TEXTURE * 4..(l::RESERVED + 1) * 4].fill(0);
        let mut bytes = record(&[1, i as u32, 0, 0]);
        bytes.extend_from_slice(&words);
        single.push(Step::Light(bytes));
    }
    if list {
        steps.push(Step::LightList(next.to_vec()));
    } else {
        steps.extend(single);
    }
    Some(())
}

fn environment_step(a: &Words, b: &Words) -> Option<Step> {
    if a.u(h::ENVIRONMENT_TEXTURE) != b.u(h::ENVIRONMENT_TEXTURE)
        || a.u(h::BACKGROUND_TEXTURE) != b.u(h::BACKGROUND_TEXTURE)
        || (a.u(h::QUALITY_FLAGS) ^ b.u(h::QUALITY_FLAGS)) & 4 != 0
        || (a.u(h::GROUNDED_BACKGROUND) != 0) != (b.u(h::GROUNDED_BACKGROUND) != 0)
    {
        return None;
    }
    let map = |reference: usize| -> Option<(u32, u32, &[u8])> {
        if reference == 0 {
            return Some((0, 0, &[]));
        }
        let to = b.u(h::TEXTURE_OFFSET) + (reference - 1) * t::WORDS;
        if b.u(to + t::STORAGE) != 1 {
            return None;
        }
        let (w, hgt) = (b.u(to + t::WIDTH), b.u(to + t::HEIGHT));
        Some((
            w as u32,
            hgt as u32,
            b.span(b.u(to + t::PIXELS), w * hgt * 4)?,
        ))
    };
    let (ew, eh, environment) = map(b.u(h::ENVIRONMENT_TEXTURE))?;
    let (bw, bh, background) = map(b.u(h::BACKGROUND_TEXTURE))?;
    let mut bytes = record(&[3, ew, eh, u32::from(b.u(h::QUALITY_FLAGS) & 4 != 0)]);
    bytes.extend_from_slice(b.span(h::BACKGROUND_COLOR, 4)?);
    bytes.extend_from_slice(&record(&[bw, bh, 0, 0]));
    let settings = b.u(h::ENVIRONMENT_SETTINGS);
    if settings == 0 {
        bytes.extend_from_slice(&record(&[1f32.to_bits(), 0, 1f32.to_bits(), 0]));
    } else {
        bytes.extend_from_slice(b.span(settings, 4)?);
    }
    let grounded = b.u(h::GROUNDED_BACKGROUND);
    if grounded == 0 {
        bytes.extend_from_slice(&record(&[0; 6]));
    } else {
        bytes.extend_from_slice(b.span(grounded, 6)?);
    }
    bytes.extend_from_slice(&record(&[0; 2]));
    bytes.extend_from_slice(environment);
    bytes.extend_from_slice(background);
    Some(Step::Environment(bytes))
}

/// Ordered retained updates equivalent to committing `next` over `previous`,
/// or `None` when only full preparation reproduces it. With `scene_only` the
/// header size and bevel/dispersion bits are ignored: they shape only the own
/// target of a scene that renders through linked targets.
#[cfg(test)]
pub(crate) fn plan(
    previous: &[u8],
    next: &[u8],
    sync: &SceneSync,
    scene_only: bool,
) -> Option<Vec<Step>> {
    plan_with(previous, next, sync, scene_only, false)
}
/// Like [`plan`]; `textures_unchanged` asserts that every texture record and
/// its pixels are identical, skipping their comparison.
pub(crate) fn plan_with(
    previous: &[u8],
    next: &[u8],
    sync: &SceneSync,
    scene_only: bool,
    textures_unchanged: bool,
) -> Option<Vec<Step>> {
    let (a, b) = (Words(previous), Words(next));
    if a.len() < h::WORDS
        || b.len() < h::WORDS
        || !scene_only && (sync.resolution || sync.quality)
        || sync.meshes == 2
    {
        return None;
    }
    let (textures, atlas) = if textures_unchanged && a.u(h::TEXTURE_COUNT) == b.u(h::TEXTURE_COUNT)
    {
        (Vec::new(), false)
    } else {
        changed_textures(&a, &b)?
    };
    // The environment map is a light to the sync, so its edits may not set `background`.
    let environment_maps = textures.iter().any(|&i| {
        [h::ENVIRONMENT_TEXTURE, h::BACKGROUND_TEXTURE]
            .iter()
            .any(|&f| b.u(f) == i + 1)
    });
    let mut steps = Vec::new();
    if atlas {
        steps.push(Step::Atlas(next.to_vec()));
    }
    for &index in &sync.geometries {
        if !geometry_unchanged(&a, &b, index)? {
            steps.push(geometry_step(&a, &b, index)?);
        }
    }
    let mut transforms = Vec::new();
    for &index in &sync.transforms {
        transform_steps(&a, &b, index, &mut transforms)?;
    }
    if transforms.len() > 1 {
        steps.push(transform_batch(transforms));
    } else {
        steps.extend(transforms);
    }
    for &index in &sync.colors {
        steps.push(instance_color_step(&a, &b, index)?);
    }
    if !sync.materials.is_empty() {
        steps.push(material_steps(&a, &b, &sync.materials)?);
    }
    if sync.lights {
        light_steps(&a, &b, next, &mut steps)?;
    }
    if sync.background || environment_maps {
        steps.push(environment_step(&a, &b)?);
    }
    if sync.camera {
        steps.push(Step::Camera(
            b.span(b.u(h::CAMERA_OFFSET), cam::WORDS)?.to_vec(),
        ));
    }
    Some(steps)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scene::{tests::input, validate_changed};

    fn word(bytes: &[u8], index: usize) -> usize {
        u32::from_le_bytes(bytes[index * 4..index * 4 + 4].try_into().unwrap()) as usize
    }
    fn set(bytes: &mut [u8], index: usize, value: u32) {
        bytes[index * 4..index * 4 + 4].copy_from_slice(&value.to_le_bytes());
    }
    fn position(bytes: &[u8]) -> usize {
        word(bytes, word(bytes, h::GEOMETRY_OFFSET) + g::POSITION)
    }

    #[test]
    fn unchanged_records_mark_identical_geometry_and_textures() {
        let base = input();
        let (geometries, textures) = (
            word(&base, h::GEOMETRY_COUNT),
            word(&base, h::TEXTURE_COUNT),
        );
        assert_eq!(
            unchanged_records(&base, &base),
            vec![1; geometries + textures]
        );
        let mut moved = base.clone();
        set(&mut moved, position(&base), 0.5f32.to_bits());
        let hints = unchanged_records(&base, &moved);
        assert_eq!(hints[0], 0);
        assert!(hints[1..].iter().all(|&same| same == 1));
        let mut fewer = base.clone();
        set(&mut fewer, h::GEOMETRY_COUNT, geometries as u32 - 1);
        assert!(unchanged_records(&base, &fewer).is_empty());
    }

    #[test]
    fn validation_scans_every_geometry_not_marked_unchanged() {
        let base = input();
        let mut invalid = base.clone();
        set(&mut invalid, position(&base), f32::NAN.to_bits());
        let hints = unchanged_records(&base, &invalid);
        assert_eq!(hints[0], 0);
        assert!(validate_changed(&invalid, &hints).is_err());
        // A hint is trusted: element scans of hinted records are skipped.
        assert!(validate_changed(&invalid, &vec![1; hints.len()]).is_ok());
    }
}
