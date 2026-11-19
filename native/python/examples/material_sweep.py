import sys
from pathlib import Path

from mutracer import Camera, Keys, Light, Mesh, Output, Shot

directory = Path(sys.argv[1])
directory.mkdir(parents=True, exist_ok=True)
shot = Shot(
    Output(duration=1, fps=24),
    [Mesh("subject", shape="sphere", position=[0, 0.5, 0], material={
        "color": [0.45, 0.21, 0.065],
        "metalness": 0.9,
        "roughness": Keys.bake(1, 24, lambda t: 0.12 + 0.54 * t * t),
    }), Mesh("ground", shape="plane", size=8, material={"roughness": 0.65})],
    Camera.orbit("subject", azimuth=26, elevation=12, distance=1.13, fov=35),
    lights=[Light("rect", [1.5, 1.8, 1.7], "subject", size=[1.2, 1.6], intensity=14),
            Light("disk", [-1.4, 1.5, -0.75], "subject", radius=0.5, intensity=9)],
    environment={"color": [0.025, 0.035, 0.05]},
)
shot.save(directory / "shot.json")
shot.validate()
shot.preview(directory / "preview.mp4", progress=print)
