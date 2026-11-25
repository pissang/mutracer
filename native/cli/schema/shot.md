# MuTracer shot v1

A shot is a UTF-8 JSON file. Set `version` to `1` and give the shot an
`output.duration`, at least one object and a camera. Use metres, degrees and
seconds in a right-handed, Y-up world. Cameras and lights point along local
−Z. Color triples use linear RGB and can exceed 1.

See the [JSON Schema](mutracer-shot-v1.json) for fields and individual ranges.
The [CLI guide](../guide.md#authoring) shows how to author procedural shots and
turntables.

## Output and animation

Output defaults are 1280 × 720, 24 fps, 32 samples per pixel, fixed seed
12345, OIDN, the hardware tracer and AgX with a linear exposure of 1.
Frames are numbered from 0. Frame `i` evaluates the shot at `i / fps` seconds, and
`ceil(duration × fps)` frames are produced. Duration excludes its endpoint.

Set `output.render` for bounce depth, caustics, clamping, sampling pattern,
direct-light candidates, dispersion, bevel and alpha blending. An omitted
`bounces` retains the video CLI default of 6. Set `bounces: 3` to match the
browser's default. `directLightCandidates` defaults to `"auto"`, which selects
1, 4 or 8 from the lights sampled in each frame. Set an integer from 1 to 16
to fix the count.

`seed: "frame"` uses `seedValue + i` modulo 2³². With
`sampleSequence: "frame"`, frame `i` uses `sampleSequenceOffset + i × spp`
at the effective samples per pixel. Both modes default to `"fixed"`, and
the base offset defaults to 0. Sample indices must fit in an unsigned 32-bit
integer. To keep the sampling ranges used by another renderer, match its
frame index, seed, sample count and offset.

Set `output.display.toneMapping` and `toneMappingExposure` to use the browser
tone-mapping name and a nonnegative linear exposure multiplier. A multiplier
of 2 doubles the exposure. The schema marks compatible older spellings as
deprecated, and `validate` reports the replacement for each one.

Use `denoise: "none"` for raw frames and `"oidn"` for the bundled Standard
model. To use `"cleanAuxLarge"`, put `rt_hdr_calb_cnrm_large.tza`,
`rt_alb_large.tza` and `rt_nrm_large.tza` in one directory and set
`MUTRACER_OIDN_WEIGHTS` to it. The three files are available in
[oidn-weights 2.3.0-1](https://cdn.jsdelivr.net/npm/oidn-weights@2.3.0-1/).
Large takes more time and GPU memory because it filters the guides first.

For an animation, set `output.denoise` to `"temporal"` and `sampleSequence` to
`"frame"`. Use `render` at stride 1. Temporal uses the Large weights above
when available. Otherwise it uses bundled weights and reports warning `W3`.

| `output.temporal` option | Behavior |
| --- | --- |
| `mode` | `"offline"` (default). |
| `historyRadius` | Number of neighbors on each side, 0–32, or an adaptive range such as the default `{"min":8,"max":16}`. |
| `postRadius` | Stabilization radius, 0–3. Default 3. |
| `stabilizeSparkle` | Suppress isolated flashes. Default true. Set false when `postRadius` is 0. |
| `accumulateGuides` | Default `false`. See [offline OIDN guide accumulation](../../docs/denoising.md#offline-animation). |
| `historyInvalidation` | `"auto"` (default) reacts to scene and material changes. Choose `"manual"` when supplying shot boundaries yourself. |
| `cuts` | Frame indices or `{"time": seconds}` entries. Each begins a new segment at the first frame at or after the cut. Default empty. |
| `memoryBudget` | Maximum estimated temporal GPU bytes. Smaller budgets reduce the history and stabilization radii. A budget below the minimum plan fails. |

Output starts after the effective history and post radii in future frames
(default 19). The worker finishes the tail with the available neighbors.
A temporal EXR contains the stabilized display-linear result.

An animatable value can be a constant or a channel such as
`{"keys":[[0,0.2],[1,0.65]],"ease":"inOutSine"}`. Use strictly increasing
times in `[0, duration]` and the same value shape at every key. A channel holds
the first and last values before and after its keys. Easing applies per
interval. `step` holds the earlier key until the next key's exact time.
`{"bezier":[x1,y1,x2,y2]}` maps normalized time through a cubic curve from
(0, 0) to (1, 1). The four control coordinates must be in [0, 1].

Rotation channels accept XYZ Euler angles or XYZW quaternions for the whole
channel. Euler matrices use `Rx · Ry · Rz` and angles interpolate component-wise.
Quaternions are normalized and follow shortest-arc spherical interpolation.
A zero quaternion is invalid. Object transforms apply scale, then rotation,
then translation.

## Objects, framing and lights

Give each object a unique `name` and one source, either an asset name pointing
to glTF/GLB, a primitive `shape`, or indexed `geometry`. The plane lies in XZ
with +Y normal. Box and sphere are centered at the origin. `size` is the plane
width, cube edge or sphere diameter and defaults to 1 metre. A glTF
`fit.height` scales its loaded bounds uniformly to that height, centers the
footprint on the origin and sets the base at Y = 0 before the object's
transform. An `instances` asset adds matrices in object space.

A camera or light target can be a point, a point channel or an object name.
A named target updates to the center of that object's current bounds. Camera
orbits around a named object use its bounding sphere and the smaller of the
horizontal and vertical fields of view. `distance: 1` fits that sphere in the
frame. For a point target, distance is in metres. Orbit azimuth starts at +Z
and moves toward +X. Positive elevation moves toward +Y. Positions and targets
must define a nonzero direction. The camera defaults to vertical FOV 45°.

Set `fStop` for depth of field, `focusDistance` in metres and `sensorHeight`
in millimetres. Defaults are 0 (pinhole), 10 and 24. Each numeric field can
be keyframed. `focusDistance` can also name an object. Each frame focuses on
the plane through its current bounds center, perpendicular to the viewing
direction. Keep the focus object in front of the camera.

Light properties are in scene units. Rect sizes give full width and height,
disk and sphere sizes use radius, and cylinders use radius and full length.
Spot lights take a full cone angle in degrees. Choose a nonnegative intensity
and linear RGB tint. Omitted intensity and color
are 1 and white. The environment defaults to black. A map lights the scene and supplies the
background unless a solid color is specified. A color alone supplies both
constant illumination and the background. Intensity scales ambient light and
map backgrounds. Rotation affects environment maps.

## Assets and limits

File references are relative to the shot's directory. glTF dependencies are
relative to the glTF itself. Use local files. An object material overrides glTF
materials when specified, otherwise imported materials are retained. Texture
maps reference `image` assets. A material `asset` references a MaterialX
document and `inputs` names its exposed numeric interfaces. A glTF animation
channel selects a named clip and explicit clip time in seconds. Clip time clamps to the clip's range. A glTF clip and a separate instance
sidecar cannot be combined on one object.

The built-in `catalog:animated-card` glTF is a procedural CC0 sample. A
render using it records its attribution in `credits.txt` alongside the frames.

Use OpenPBR property names such as `baseColor`, `specularRoughness` and
`transmissionScatter`. Numeric values are animatable. Set a texture slot
such as `map`, `normalMap` or `fuzzColorMap` to the name of an image asset.
Supply each property once. See the
[material schema](mutracer-shot-v1.json#/$defs/material) for all properties and
[OpenPBR material options](../../../docs/materials.md) for their
effects.

MaterialX selects the first surface in a local UTF-8 `.mtlx` file. It accepts
OpenPBR, Standard Surface, glTF PBR and USD Preview Surface inputs supported
by the [material graph](../../../docs/materialx.md). Use `graph/input` to
disambiguate a named input. Unsupported shaders, nodes and inputs produce
validation errors (exit code 2) with their material and XML locations.
File reads and invalid UTF-8 produce asset errors (exit code 3). Use a shot
`displacementMap` for displacement.

Inline positions, normals and UVs are arrays of triples or pairs. Indices
are a flat list of zero-based triangle indices. Use inline geometry for up
to 10,000 vertices and 30,000 indices, or [binary sidecars](sidecars.md) or
glTF for larger meshes. Normals and UVs must match the position count.

Unknown keys, duplicate object names, invalid references and values outside
their ranges are validation errors. The CLI reports a JSON pointer and a
correction when available. Schema validation covers JSON structure. Asset
decoding, reference types, key order, effective camera placement and total
pixel and memory limits are checked separately. Output is limited to
16,777,216 pixels and 8,192 pixels per edge. See the
[native scene limits](../../docs/scene-format.md#limits) for geometry and textures.
