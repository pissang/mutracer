# MuTracer for Python

Author native video shots on Python 3.10 or newer. Set `MUTRACER_BIN` to the
[native CLI built from this checkout](../cli/README.md#build-the-cli-from-source) and install the package with
`python -m pip install native/python`.

```python
from mutracer import Camera, Keys, Light, Mesh, Output, Shot

shot = Shot(
    Output(duration=1, fps=24, render={"bounces": 6},
           display={"toneMappingExposure": 1.2}, sample_sequence="frame"),
    [Mesh("subject", shape="sphere", material={
        "baseMetalness": 0.9,
        "specularRoughness": Keys(((0, 0.15), (1, 0.55)), ease="inOutSine"),
    })],
    Camera.orbit("subject", azimuth=25, elevation=10, f_stop=4, focus_distance="subject"),
    lights=[Light("rect", [2, 2, 2], "subject", size=[1, 1], intensity=12)],
)
shot.save("shot.json")
shot.validate()
shot.preview("preview.mp4", contact_sheet="preview.png")
shot.render("output.mp4", size=(1280, 720), spp=32)
```

Call `Keys.bake(duration, fps, sample)` for motion described by a function of
time. It samples each frame and the endpoint and writes the resulting track
to the shot. Install the optional `numpy` extra to write mesh and instance
arrays through `Mesh.from_numpy` and `Instances.from_numpy`. These methods
write little-endian binary sidecars. Use the camelCase
[shot fields](../cli/schema/shot.md) in material, render and display
dictionaries. `toneMappingExposure` is a linear multiplier. The `Camera` constructor and `Camera.orbit()` also accept
`sensor_height` in millimetres. Lens scalars accept `Keys`.

Pass `progress=callback` to receive each decoded JSON progress event. A failed
command raises `RenderError` with the CLI exit code and stderr. See the
[CLI guide](../cli/guide.md) for defaults, frame reuse and exit codes.

## Procedural frames

Use `shot.render_stream("output.mp4", callback)` with a callback that returns
absolute changes to existing channels. For example, if object 0 has a
`rotation` value, this callback rotates it steadily:

```python
def turn(time, frame):
    return {"/objects/0/rotation": [0, 90 * time, 0]}

shot.render_stream("output.mp4", turn, size=[1280, 720], spp=32)
```

The callback receives seconds and a zero-based frame index. Stream keyword
arguments follow the [stdio settings](../cli/schema/stdio.md), for example
`render={"bounces": 8}` and `sampleSequence="frame"`. Use `Session.check()`
to validate these settings without rendering. Reusing a frame
requires the same callback values, input files and render settings. The
callback runs for reused frames so changes can carry forward.

## Optional OpenUSD import

Install the `usd` extra or use a Python with OpenUSD's `pxr` bindings. Set
`MUTRACER_PYTHON` when the bindings are installed in another Python.

```sh
mutracer import-usd scene.usda --lint
mutracer import-usd scene.usda --camera /Camera -o shot.json
mutracer validate shot.json
```

The importer writes a shot and binary mesh sidecars. It supports polygon
meshes, UVs, sampled transforms, perspective cameras with lens settings,
UsdLux emitters, OpenPBR and PreviewSurface constants, and local MaterialX
source assets. It converts Y-up
or Z-up coordinates using the authored `metersPerUnit` and samples animated
properties in the stage's authored time range. Tessellate subdivision meshes
and split material subsets before import. Animated vertex buffers, shear,
orthographic cameras and textured PreviewSurface node networks are unsupported.
