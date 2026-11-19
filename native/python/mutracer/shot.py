from __future__ import annotations

from dataclasses import asdict, dataclass, field
import json
import math
from pathlib import Path
from typing import Any, Callable
import os
import tempfile

from .runner import invoke


@dataclass(frozen=True)
class Keys:
    """Values sampled at strictly increasing times, in seconds."""

    keys: tuple
    ease: Any = "linear"

    def __post_init__(self):
        if not self.keys:
            raise ValueError("A key track needs at least one key.")
        previous = -1
        for time, _ in self.keys:
            if not math.isfinite(time) or not 0 <= time or time <= previous:
                raise ValueError("Key times must be finite, nonnegative and strictly increasing.")
            previous = time

    @classmethod
    def bake(cls, duration: float, fps: int, sample: Callable[[float], Any], ease="linear") -> Keys:
        """Sample a callback at frame times and the endpoint."""
        if not math.isfinite(duration) or duration <= 0 or not 1 <= fps <= 240:
            raise ValueError("Expected positive duration and FPS from 1 to 240.")
        count = math.ceil(duration * fps)
        if count >= 100_000:
            raise ValueError("A baked track has room for at most 100000 keys including its endpoint.")
        times = [index / fps for index in range(count) if index / fps < duration]
        times.append(duration)
        return cls(tuple((time, sample(time)) for time in times), ease)


@dataclass(frozen=True)
class Gltf:
    gltf: str | Path


@dataclass(frozen=True)
class Hdr:
    hdr: str | Path


@dataclass(frozen=True)
class Image:
    image: str | Path


@dataclass(frozen=True)
class MaterialX:
    materialx: str | Path


def _write_array(directory: Path, name: str, array, dtype: str) -> dict:
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / name
    with tempfile.NamedTemporaryFile(dir=directory, prefix=f".{name}.", delete=False) as output:
        temporary = Path(output.name)
        try:
            output.write(memoryview(array).cast("B"))
            output.close()
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)
    return {"file": path.resolve(), "dtype": dtype, "shape": list(array.shape)}


@dataclass(frozen=True)
class Instances:
    instances: dict

    @classmethod
    def from_numpy(cls, directory: str | Path, transforms, *, filename="instances.bin") -> Instances:
        """Write row/column indexed (N, 4, 4) matrices, or packed (N, 16) columns."""
        import numpy as np

        matrices = np.asarray(transforms)
        if matrices.ndim == 3 and matrices.shape[1:] == (4, 4):
            matrices = matrices.transpose(0, 2, 1).reshape(-1, 16)
        if matrices.ndim != 2 or matrices.shape[1] != 16 or not 1 <= len(matrices) <= 16_777_216:
            raise ValueError("Expected an (N, 4, 4) or (N, 16) instance array.")
        matrices = np.ascontiguousarray(matrices, dtype="<f4")
        if not np.isfinite(matrices).all() or not (matrices[:, [3, 7, 11, 15]] == [0, 0, 0, 1]).all():
            raise ValueError("Instance matrices must be finite and affine.")
        return cls(_write_array(Path(directory), filename, matrices, "f32"))


@dataclass
class Mesh:
    name: str
    asset: str | None = None
    shape: str | None = None
    geometry: dict | None = None
    size: float | None = None
    fit: dict | None = None
    position: Any = None
    rotation: Any = None
    scale: Any = None
    material: dict | None = None
    instances: str | None = None
    animation: dict | None = None

    @classmethod
    def from_numpy(cls, name: str, directory: str | Path, positions, indices, *,
                   normals=None, uv=None, file_prefix="mesh", **fields) -> Mesh:
        """Save a single indexed mesh as little-endian position and index sidecars."""
        import numpy as np

        directory = Path(directory)
        vertices = np.ascontiguousarray(positions, dtype="<f4")
        if vertices.ndim != 2 or vertices.shape[1] != 3 or not 3 <= len(vertices) <= 4_000_000:
            raise ValueError("Positions must have shape (N, 3) for 3 to 4000000 vertices.")
        if not np.isfinite(vertices).all():
            raise ValueError("Positions must be finite.")
        triangles = np.asarray(indices)
        if triangles.ndim == 2 and triangles.shape[1] == 3:
            triangles = triangles.reshape(-1)
        if (triangles.ndim != 1 or not 3 <= len(triangles) <= 12_000_000
                or len(triangles) % 3 or not np.issubdtype(triangles.dtype, np.integer)
                or triangles.min() < 0 or triangles.max() >= len(vertices)):
            raise ValueError("Indices must be in-range integer triangle triples.")
        channels = {"positions": (vertices, "f32"),
                    "indices": (np.ascontiguousarray(triangles, dtype="<u4"), "u32")}
        for label, values, arity in (("normals", normals, 3), ("uv", uv, 2)):
            if values is not None:
                values = np.ascontiguousarray(values, dtype="<f4")
                if values.shape != (len(vertices), arity) or not np.isfinite(values).all():
                    raise ValueError(f"{label} must have one finite {arity}-component row per vertex.")
                channels[label] = (values, "f32")
        geometry = {label: _write_array(directory, f"{file_prefix}-{label}.bin", values, dtype)
                    for label, (values, dtype) in channels.items()}
        return cls(name, geometry=geometry, **fields)


@dataclass
class Light:
    type: str
    position: Any
    target: Any
    color: Any = None
    intensity: Any = None
    size: Any = None
    radius: Any = None
    length: Any = None
    angle: Any = None


@dataclass
class Camera:
    target: Any
    position: Any = None
    fov: Any = None
    orbit_parameters: dict | None = None

    @classmethod
    def orbit(cls, target, *, azimuth=0, elevation=0, distance=1.15, fov=None) -> Camera:
        """Orbit a point or a named object."""
        return cls(target, fov=fov, orbit_parameters={"azimuth": azimuth, "elevation": elevation, "distance": distance})


@dataclass
class Output:
    duration: float
    size: tuple[int, int] | None = None
    fps: int | None = None
    spp: int | None = None
    seed: str | None = None
    seed_value: int | None = None
    sample_sequence_offset: int | None = None
    denoise: str | None = None
    display: dict | None = None


def _json_value(value, directory: Path):
    if isinstance(value, Path):
        if value.is_absolute():
            try:
                return Path(os.path.relpath(value, directory)).as_posix()
            except ValueError:
                return value.as_posix()
        return value.as_posix()
    if isinstance(value, dict):
        return {key: _json_value(item, directory)
                for key, item in value.items() if item is not None}
    if isinstance(value, (list, tuple)):
        return [_json_value(item, directory) for item in value]
    return value


@dataclass
class Shot:
    output: Output
    objects: list[Mesh]
    camera: Camera
    assets: dict = field(default_factory=dict)
    lights: list[Light] = field(default_factory=list)
    environment: dict | None = None
    _path: Path | None = field(default=None, init=False, repr=False, compare=False)

    def to_dict(self, directory: str | Path = ".") -> dict:
        raw = asdict(self)
        del raw["_path"]
        raw["output"]["seedValue"] = raw["output"].pop("seed_value")
        raw["output"]["sampleSequenceOffset"] = raw["output"].pop("sample_sequence_offset")
        raw["camera"]["orbit"] = raw["camera"].pop("orbit_parameters")
        return {"version": 1, **_json_value(raw, Path(directory).resolve())}

    def save(self, path: str | Path) -> Path:
        """Write the shot and remember its path for later rendering."""
        path = Path(path).resolve()
        data = json.dumps(self.to_dict(path.parent), allow_nan=False, indent=2) + "\n"
        path.write_text(data, encoding="utf-8")
        self._path = path
        return path

    def _run(self, command: str, output=None, *, progress=None, **options):
        if self._path is None:
            raise ValueError("Call shot.save(path) before invoking the CLI.")
        return invoke(command, self.save(self._path), output, progress, **options)

    def validate(self):
        return self._run("validate")

    def still(self, output, *, t=0, **options):
        return self._run("still", output, t=t, **options)

    def preview(self, output, **options):
        return self._run("preview", output, **options)

    def render(self, output, **options):
        return self._run("render", output, **options)

    def render_stream(self, output, callback, *, keep_frames=None, fps=None, progress=None, **settings):
        """Render callback edits over stdio and encode the resulting PNG sequence.

        The callback receives (time, frame) and returns a mapping from JSON
        pointers to absolute channel values. Values persist until replaced.
        """
        from .stream import render_frames

        if self._path is None:
            raise ValueError("Call shot.save(path) before invoking the CLI.")
        output = Path(output)
        directory = Path(keep_frames) if keep_frames is not None else output.with_name(output.name + ".frames")
        rate, events = render_frames(self.to_dict(self._path.parent), self._path.parent, directory,
                                     callback, settings, fps, progress)
        return events + invoke("encode", directory, output, progress, fps=rate)
