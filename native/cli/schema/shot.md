# MuTracer shot v1

A shot is a UTF-8 JSON file. Set `version` to `1` and give the shot an
`output.duration`, at least one object and a camera. Use metres, degrees and
seconds in a right-handed, Y-up world. Cameras and lights point along local
−Z. Color triples use linear RGB and can exceed 1.

See the [JSON Schema](mutracer-shot-v1.json) for fields and individual ranges.
The [material sweep](../examples/material-sweep.json) uses procedural geometry.
The [turntable](../examples/turntable.json) frames a glTF asset.

## Output and animation

Output defaults are 1280 × 720, 24 fps, 32 samples per pixel, fixed seed
12345, OIDN and AgX at 0 EV. Duration excludes its endpoint. Frame indices
start at 0 and frame `i` evaluates the shot at `i / fps` seconds. The frame
count is `ceil(duration × fps)`. With `seed: "frame"`, the seed is
`seedValue + i` modulo 2³². `sampleSequenceOffset` starts at 0. An explicit
offset selects a different sample range and produces a separate result.

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
channel selects a named clip and explicit clip time in seconds. A renderer
reports unsupported declared features before rendering.

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
