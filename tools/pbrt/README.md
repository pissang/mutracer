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
the PBRT executable selected by `PBRT_BIN`.
`--webgl` selects WebGL 2; `--out <directory>` chooses the report destination.
`--width N --height N` overrides the scaled Film dimensions. Comparisons use the
whole frame; Film crop windows and pixel bounds are ignored in both renders.
The tool writes raw linear HDR, a PBRT EXR, region metrics and a preview ordered
PBRT, MuTracer, then absolute difference amplified 10 times. Approximate material
pixels are reported separately. Metrics alone do not establish noise equivalence.

`--noise` also renders PBRT seeds 0/1 and MuTracer sample blocks `[0,N)` and
`[N,2N)` for noise estimates. MuTracer's blocks share a Sobol scramble; they are
disjoint, not independent Monte Carlo replicas.
The reference pixel filter is set to a box of radius 0.5. Before comparison,
reference RGB is divided by `(iso / 100) * (shutterclose - shutteropen)`.
MuTracer's raw HDR excludes display exposure; the viewer applies the imported
exposure only to presentation. This normalization does not remove differences
from an approximated sensor response. Numerical reports use rendered EXRs,
not the scene repository's preview images.

`--reuse-reference` reuses EXRs when input modification times, dimensions and spp
match, saving CPU rendering time while testing importer changes. Use a fresh
output directory after changing the reference renderer or comparison settings.
`--timeout <milliseconds>` limits each browser render (default 300000).
`--load-only` skips PBRT and HDR comparison for unsupported-feature smoke tests.
The two MuTracer runs use separate browser processes, so large scenes do not need two
copies to coexist in browser memory.

## Supported features

| PBRT input | Imported behavior and limits |
| --- | --- |
| Include / Import, transforms, attribute blocks, named resources | Relative to the main scene; Import state stays isolated. Motion blur uses the start transform with a warning. |
| trianglemesh / plymesh / bilinearmesh | Meshes; PLY supports gzip, ASCII/binary, quad triangulation and common UV names. |
| sphere / disk / cylinder | Tessellated geometry; sphere emitters retain visible emissive geometry. |
| ObjectBegin / ObjectInstance | Shared instanced geometry, including mirrored instances. |
| loopsubdiv / curve | Loop subdivision with area-weighted normals / skipped with a warning. |
| perspective / orthographic | Film aspect ratio, ISO and camera shutter exposure, and short-edge field of view; Film exposuretime and whitebalance are warned and ignored; other cameras approximate perspective. Custom screenwindow is warned and ignored. |
| diffuse / conductor / dielectric / thindielectric | OpenPBR base, metal, transmission and thin-wall mapping; named metal and glass spectra are supported. Outside-medium reversal reciprocates thick dielectric IOR; thin-wall IOR stays unchanged. Reciprocal dispersion retains an approximate Abbe mapping with a warning. |
| coateddiffuse / coatedconductor / subsurface / diffusetransmission | Approximate OpenPBR layers, including separate conductor/interface roughness and named subsurface coefficients; reversed coats or coat IOR below 1 are unsupported and warned; diffuse transmission defaults to reflectance/transmittance 0.25 and uses mean transmittance for its thin-wall approximation. |
| mix / hair / measured / interface | Dominant constant-weight branch / diffuse fallback / diffuse fallback / transmissive medium boundary. |
| imagemap | PNG/JPEG, EXR, TGA and TIFF; encoding, invert, scale, UV scale/offset and repeat/clamp. Black wrap approximates clamp. |
| constant / scale / constant checkerboard | Supported; other procedural textures use a warned constant approximation. Anisotropic roughness textures currently use 0.5. |
| point / spot / distant / diffuse area / infinite | Existing MuTracer lights and emissive meshes; equal-area environments use solid-angle supersampling with total-energy preservation. Portals are ignored with a warning. |
| goniometric / projection | Skipped with a warning. |
| homogeneous | Inside or outside material medium (outside reverses the boundary). Two media use inside only, with a warning. Scenes with a camera medium cannot be opened. |
| uniformgrid / rgbgrid / nanovdb / cloud | Skipped with a warning. |
| normalmap / alpha | Normal map and material opacity variants. Material bump is baked to UV-space normals; shape displacement keeps the height-field approximation. |

`maxdepth` is clamped to 50 on WebGPU or 20 on WebGL, with a structured
`path-depth` warning that reports the depth used. Scenes exceeding that limit
are excluded from strict PBRT comparison; raw metrics are still written.
Transparent paths can reach the
[path-event limit](../../docs/api.md#render) before the requested scattering depth.

Approximations are excluded from strict material-region comparisons. Indirect
light can still pass through an approximate material before reaching a comparable
region; the primary-surface mask cannot separate those paths. The two-run noise
estimate does not by itself establish matching renderer behavior.
Material bump changes shading only; its appearance on curved surfaces and at
different texture scales is approximate, with a warning.
When normalmap is also present, it takes precedence and bump is warned and ignored.
Interface or empty-material boundaries with an interior medium are excluded
from strict comparison: MuTracer shadow rays block point and area direct light
at these boundaries. Import emits a warning. Scenes containing these boundaries
are excluded as a whole because their shadows and indirect light can affect
other surfaces; reports retain measurements with `not-comparable` status.
Open or inconsistently oriented medium boundaries and detected camera/interface
medium mismatches also produce warnings and exclude the whole scene from strict
comparison.
Ordinary surfaces are double-sided. One-sided emitters also hide their back faces
from primary rays; this visibility limitation is reported as a warning.
Subsurface mean free paths below 0.001 scene units are limited by the existing
OpenPBR medium; this can change fine-scale skin scattering and is warned about.
Thin-walled materials cannot retain interior absorption or scattering media;
import warns and excludes these surfaces from strict comparison.
Absorbing gemstones can still differ in color from PBRT, and rough colored
metals can appear too bright.
Optical constants accept named spectra or SPD files. Spatial optical-constant
maps and coat roughness maps use warned mean-value approximations.

The viewer asks before downloading 1 GB or more, up to its 1 GiB encoded-input
limit (about 1.074 GB). Larger inputs and unknown total sizes are rejected before
binary downloads. The memory estimate is eight times input size, capped at 8 GiB.
This is an estimate; available browser and GPU memory can impose a lower limit.
Local folders with multiple scenes open the first entry containing `WorldBegin`
in path order. Open an individual scene and its dependencies to choose another.
Standalone code export is unavailable for PBRT scenes; use the viewer or the
comparison tool to render them.

With `--noise`, the report separates whole-frame HDR RMSE from regional mean
bias divided by its standard error. Regional tests exclude ID discontinuities
expanded by one pixel and flag channels above six standard errors. Either test
can report mismatch (exit code 2); approximate regions do not fail these checks.
The estimates assume independent pixel errors, so mismatches still need diagnosis.
Without `--noise`, noise agreement remains unassessed.
