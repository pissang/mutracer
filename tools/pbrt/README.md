# PBRT scenes

Run `npm run pbrt:inspect -- <scene.pbrt-or-url>` to list a scene's statements,
materials, textures, lights, shapes and media, plus its unique input resources
and their total download size. Includes are read; binary resources are only
queried for size. An unknown size is reported separately and is not counted as zero
in a complete size estimate. Output images named by `Film` are excluded.

Paths, including those in nested Includes, are relative to the main scene's
directory. Local input must contain every included file. URL input requires
CORS access in the viewer. Inspection does not imply that every reported feature
can be rendered.

The scene catalog uses
[mmp/pbrt-v4-scenes](https://github.com/mmp/pbrt-v4-scenes/tree/30cf4a0346ae5a80a2d7a530a3ef7d0fa4f70572).
Scenes have individual licenses listed in its README. Scene assets are downloaded
at runtime and are not included with MuTracer.

Run `npm run pbrt:compare -- <local-scene.pbrt> --spp 64 --scale 0.25` with
PBRT installed at `~/.codex/tools/pbrt-v4/build/pbrt`, or set `PBRT_BIN`.
`--webgl` selects WebGL 2; `--out <directory>` chooses the report destination.
The tool writes raw linear HDR, a PBRT EXR, region metrics and a preview ordered
PBRT, MuTracer, then absolute difference amplified 10 times. Approximate material
pixels are reported separately. Metrics alone do not establish noise equivalence.

`--noise` also renders independent seed pairs for regional mean-noise estimates.
The reference pixel filter is set to a box of radius 0.5. Film sensor exposure is
removed from the reference HDR before comparison. Numerical reports never use the
scene repository's preview images.

## Supported features

| PBRT input | Imported behavior and limits |
| --- | --- |
| Include / Import, transforms, attribute blocks, named resources | Relative to the main scene; Import state stays isolated. Motion blur uses the start transform with a warning. |
| trianglemesh / plymesh / bilinearmesh | Meshes; PLY supports gzip, ASCII/binary, quad triangulation and common UV names. |
| sphere / disk / cylinder | Tessellated geometry; sphere emitters retain visible emissive geometry. |
| ObjectBegin / ObjectInstance | Shared instanced geometry, including mirrored instances. |
| loopsubdiv / curve | Loop subdivision with area-weighted normals / skipped with a warning. |
| perspective / orthographic | Film aspect ratio and short-edge field of view; other cameras approximate perspective. Custom screenwindow is warned and ignored. |
| diffuse / conductor / dielectric / thindielectric | OpenPBR base, metal, transmission and thin-wall mapping; named metal and glass spectra are supported. |
| coateddiffuse / coatedconductor / subsurface / diffusetransmission | Approximate OpenPBR layers, including named subsurface coefficients. |
| mix / hair / measured / interface | Dominant constant-weight branch / diffuse fallback / diffuse fallback / transmissive medium boundary. |
| imagemap | PNG/JPEG, EXR, TGA and TIFF; encoding, invert, scale, UV scale/offset and repeat/clamp. Black wrap approximates clamp. |
| constant / scale / constant checkerboard | Supported; other procedural textures use a warned constant approximation. Anisotropic roughness textures currently use 0.5. |
| point / spot / distant / diffuse area / infinite | Existing MuTracer lights and emissive meshes; equal-area environments are reprojected. Portals are ignored with a warning. |
| goniometric / projection | Skipped with a warning. |
| homogeneous | Interior material medium, or a bounded exterior volume. Colored exterior extinction is averaged with a warning. |
| uniformgrid / rgbgrid / nanovdb / cloud | Skipped with a warning. |
| normalmap / alpha | Normal map and material opacity variants. Bump and displacement maps use a warned height-field approximation. |

Approximations are excluded from strict material-region comparisons. Indirect
light can still pass through an approximate material before reaching a comparable
region; the primary-surface mask cannot separate those paths. An independent-seed
pair estimates noise but does not by itself establish matching renderer behavior.

The viewer asks before downloading 1 GB or more. It rejects unknown total sizes or
an estimated working set above 8 GiB, using eight times the encoded input size.
This is an estimate; available browser and GPU memory can impose a lower limit.
Local folders with multiple scenes open the first entry containing `WorldBegin`
in path order. Open an individual scene and its dependencies to choose another.

With `--noise`, comparable regions whose HDR RMSE exceeds the independent-seed
noise estimate are reported as mismatches (exit code 2); approximate regions do
not fail this check. The statistical margin assumes independent pixel errors,
so a mismatch needs diagnosis, particularly near geometry edges and indirect
paths through approximate materials. Without `--noise`, the report leaves noise
agreement unassessed.
