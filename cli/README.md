# MuTracer CLI for Node

Run Three.js shot modules with Node 22 or newer and render through the
[native MuTracer CLI](../native/cli/README.md). For a source checkout, build the
Node package and set `MUTRACER_BIN` to the native executable.

```sh
npm --prefix cli run build
node cli/dist/main.mjs validate cli/examples/gltf-animation.js
node cli/dist/main.mjs preview cli/examples/material-sweep.js -o preview.mp4 --contact-sheet review.png
node cli/dist/main.mjs render cli/examples/gltf-animation.js -o final.mp4
```

A shot module exports `output` with a positive `duration` in seconds,
`setup({THREE, load, mutracer, rng})` returning a Three.js `{scene, camera}`,
and `frame({t, frame, scene, camera})`. For every frame, assign properties
from time or frame index. The CLI checks that revisiting a time produces the
same scene. For a glTF clip, use an `AnimationMixer` with `setTime(t)`.

`load.gltf`, `load.texture` and `load.hdr` accept paths relative to the module
or local file URLs. glTF buffers and encoded textures can be embedded or
external. Draco and Basis/KTX2 textures are unsupported. Use Three.js standard,
physical or basic materials. Untextured Lambert and Phong materials use an
approximate OpenPBR conversion. Toon and custom shaders are rejected with the
scene location. Use a data texture or a solid color for the background.

Preview uses 384 × 216, 8 spp and every second frame. Frames stay beside the
video or under `--keep-frames`, and rerunning with the same inputs reuses them.
See the [native CLI guide](../native/cli/guide.md) for the output and cost rules.

The glTF animation example includes a procedural CC0 1.0 asset. The turntable
uses the repository's procedurally generated CC0 1.0 chess model.
