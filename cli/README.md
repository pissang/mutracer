# MuTracer CLI for Node

Run Three.js shot modules with Node 22 or newer and render through the
[native MuTracer CLI](../native/cli/README.md). For a source checkout, build the
Node package and set `MUTRACER_BIN` to the native executable.

```sh
npm --prefix cli run build
node cli/dist/main.mjs render cli/examples/indoor.js -o indoor.mp4 --size 640x360 --spp 8
node cli/dist/main.mjs validate cli/examples/gltf-animation.js
node cli/dist/main.mjs preview cli/examples/material-sweep.js -o preview.mp4 --contact-sheet review.png
node cli/dist/main.mjs render cli/examples/gltf-animation.js -o final.mp4
```

A shot module exports `output` with a positive `duration` in seconds,
`setup({THREE, load, mutracer, rng})` returning a Three.js `{scene, camera}`,
and `frame({t, frame, scene, camera})`. For every frame, assign properties
from time or frame index. The CLI checks that revisiting a time produces the
same scene. For a glTF clip, use an `AnimationMixer` with `setTime(t)`.
For a directly authored MuTracer scene, return `scene: {meshes, lights}`
with a MuTracer or Three.js camera.

Set `output.render`, `output.display`, `output.denoise` and
`output.sampleSequence` using the
[shot output fields](../native/cli/schema/shot.md#output-and-animation).
For example, use `display: {toneMapping: "agx", toneMappingExposure: 1.2}`
for AgX at 1.2 times the linear exposure.
For a Three.js camera, assign `camera.userData.mutracerLens` in `setup()`
or update it in `frame()`. Use `{fStop: 3.5, focusDistance: 2.1, sensorHeight: 24}`
or set `focusDistance` to the name of a visible object in the Three.js scene.

`load.gltf`, `load.texture` and `load.hdr` accept paths relative to the module
or local file URLs. glTF buffers and encoded textures can be embedded or
external. Draco and Basis/KTX2 textures are unsupported. Use Three.js standard,
physical or basic materials. Untextured Lambert and Phong materials use an
approximate OpenPBR conversion. Toon and custom shaders are rejected with the
scene location.

Use `load.pixels(width, height, rgba, options)` to make a texture from RGBA
`Uint8Array`, `Uint8ClampedArray` or `Float32Array` pixels in row-major order.
Bytes default to sRGB and floats to linear. Set `colorSpace: "linear"` for
data maps or `environment: true` for an equirectangular texture with linear
float pixels. For the background, use a solid color or a data texture.

Attach a MaterialX surface with
`material.userData.mutracerMaterialX = await load.materialX("./surface.mtlx")`.
For inline XML use `load.materialX({source: xml})`; referenced images resolve
relative to the shot module. The MaterialX surface can be applied to
standard, physical, basic or supported Lambert/Phong materials. For
animated graph inputs, edit the returned `graph` in `frame()`. Use a
`displacementMap` on the Three.js material for displacement.

For a linear HDR still, use `still --format exr -o frame.exr`.
Preview uses 384 × 216, 8 spp and every second frame. Frames stay beside the
video or under `--keep-frames`, and rerunning with the same inputs reuses them.
See the [native CLI guide](../native/cli/guide.md) for the output and cost rules.

The glTF animation example includes a procedural CC0 1.0 asset. The turntable
uses the repository's procedurally generated CC0 1.0 chess model.
