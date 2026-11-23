# Render a shot with MuTracer

Create a v1 shot JSON with output duration, objects, lights and a camera.
Use metres, degrees, seconds and linear RGB in a right-handed, Y-up world.
Run `mutracer schema` for fields, defaults and ranges.

```sh
mutracer validate shot.json
mutracer still shot.json --t 0.5 --size 640x360 -o still.png
mutracer preview shot.json -o preview.mp4 --contact-sheet review.png
mutracer render shot.json -o final.mp4 --size 1280x720 --spp 32
```

Check the still for framing and material response. Use a contact sheet to
review motion before rendering the final clip. Use separate output paths for
preview and final renders. Run `mutracer <command> --help` for accepted options
and CLI defaults. Run `mutracer schema` for shot defaults and field limits.

## Authoring

- Turntable. Reference a glTF/GLB asset, give the object a name, set
  `fit: {"height":1}` and animate the camera's orbit azimuth. Set camera target
  to the object name, then adjust orbit distance. A value of 1 fits the bounds.
- Material sweep. Add a sphere and floor and keyframe a material control such
  as `"specularRoughness":{"keys":[[0,0.12],[1,0.6]],"ease":"inOutSine"}`.
- Studio lights. Use a large rect above and to the side for the key, a larger
  disk with lower intensity for fill, and a narrow cylinder behind the object
  for a rim. Aim lights with object-name targets.
- Focus pull. Keyframe `camera.focusDistance` or use an object name to follow
  its bounds. Choose a positive `camera.fStop` to see depth of field.
- glTF clip. Set a glTF object's `animation.clip` to its name and keyframe
  `animation.time` in seconds.
- MaterialX growth. Use a MaterialX asset and keyframe a connected numeric
  interface through `material.inputs`.
- Display. Set `output.display` to a value such as
  `{"toneMapping":"agx","toneMappingExposure":1.2}`.

Use glTF/GLB or binary sidecars for meshes that exceed the inline geometry
limits.

For a procedural scene, use the [Node frontend](../../cli/README.md) or the
[Python API](../python/README.md). They accept the same render and display
settings as [shot JSON](schema/shot.md#output-and-animation).

## Cost, progress and resume

Work scales with pixels × samples × frames and varies with material and light
complexity.

| Settings | Pixel samples per rendered frame |
| --- | ---: |
| 384 × 216, 8 spp | 0.66 million |
| 1280 × 720, 32 spp | 29.5 million |
| 1920 × 1080, 64 spp | 132.7 million |

Use a smaller frame, fewer samples or a short range such as `--frames 10-12`
to estimate runtime. Use `--frames 10` to render just frame 10.
`validate` reports the workload without a GPU. Render progress reports frame
times and an estimate after the second rendered frame.

Rerun with the same shot, assets, effective settings and frame directory to
reuse completed frames after an interruption, including a `--max-minutes`
timeout. The CLI automatically retries GPU failures. Use `--keep-frames` or
change the output path to start a separate render after editing the shot,
assets or settings.

Use `--tracer software` when repeatable frames matter. Apple hardware ray
queries occasionally miss a complete sample, especially while other work
uses the GPU. Software traversal can be slower on large scenes. Changing
the tracer requires a separate frame directory.

The CLI renders with the native GPU driver. macOS and Windows use their system encoders.
On Linux the CLI uses ffmpeg when available and leaves the PNG sequence
when it is absent. To encode separately, run
`mutracer encode path/to/frames --fps 24 -o output.mp4`.

For HDR, render with `--format exr`. Add `--aovs` to capture surface guides
for `mutracer temporal`. Use `mutracer assemble` to join PNG sequences with
optional captions.

Progress and warning events are JSON lines on stdout. Warnings include a code,
JSON pointer when available, message and hint; they do not change the exit code.
Some warnings also appear as readable text on stderr.
Errors go to stderr.
Exit codes are 0 for success, 2 for invalid input, 3 for asset or output
failure, 4 for a budget limit and 5 for a resumable GPU or worker failure.
