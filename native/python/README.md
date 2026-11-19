# MuTracer for Python

Author native video shots on Python 3.10 or newer. Set `MUTRACER_BIN` to the
[native CLI built from this checkout](../cli/README.md#build-the-cli-from-source) and install the package with
`python -m pip install native/python`.

```python
from mutracer import Camera, Keys, Light, Mesh, Output, Shot

shot = Shot(
    Output(duration=1, fps=24),
    [Mesh("subject", shape="sphere", material={
        "metalness": 0.9,
        "roughness": Keys(((0, 0.15), (1, 0.55)), ease="inOutSine"),
    })],
    Camera.orbit("subject", azimuth=25, elevation=10),
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
write little-endian binary sidecars.

Pass `progress=callback` to receive each decoded JSON progress event. A failed
command raises `RenderError` with the CLI exit code and stderr. See the
[CLI guide](../cli/guide.md) for defaults, frame reuse and exit codes.
