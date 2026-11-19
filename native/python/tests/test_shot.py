import json
import os
from pathlib import Path
import struct
from tempfile import TemporaryDirectory
import unittest

from mutracer import Camera, Instances, Keys, Mesh, Output, Shot


def shot(mesh):
    return Shot(Output(0.25, fps=24), [mesh], Camera("tri", position=[0, 0, 3]))


class ShotTests(unittest.TestCase):
    def test_keys_bake_and_json(self):
        keys = Keys.bake(0.1, 24, lambda time: [time, 0, 0])
        self.assertEqual([k[0] for k in keys.keys], [0, 1 / 24, 2 / 24, 0.1])
        triangle = Mesh("tri", shape="box", position=keys)
        with TemporaryDirectory() as path:
            parsed = json.loads(shot(triangle).save(Path(path) / "shot.json").read_text())
        self.assertEqual(parsed["objects"][0]["position"]["keys"][-1], [0.1, [0.1, 0, 0]])
        with self.assertRaises(ValueError):
            Keys(((0.1, 3), (0.1, 4)))

    def test_numpy_sidecars_roundtrip(self):
        try:
            import numpy as np
        except ImportError:
            self.skipTest("optional NumPy is unavailable")
        with TemporaryDirectory() as tmp:
            base = Path(tmp)
            scene = shot(Mesh.from_numpy("tri", base / "data", [[0, 0, 0], [1, 0, 0], [0, 1, 0]], [[0, 1, 2]], instances="copy"))
            matrix = np.eye(4)
            matrix[0, 3] = 3
            scene.assets["copy"] = Instances.from_numpy(base / "data", [matrix])
            case = json.loads(scene.save(base / "shot.json").read_text())
            vertices = case["objects"][0]["geometry"]["positions"]
            instances = case["assets"]["copy"]["instances"]
            self.assertEqual(vertices["shape"], [3, 3])
            self.assertEqual(vertices["file"], "data/mesh-positions.bin")
            self.assertEqual(struct.unpack("<9f", (base / vertices["file"]).read_bytes()), (0, 0, 0, 1, 0, 0, 0, 1, 0))
            self.assertEqual(struct.unpack("<16f", (base / instances["file"]).read_bytes())[12:16], (3, 0, 0, 1))
            if os.environ.get("MUTRACER_BIN"):
                self.assertEqual(scene.validate()[0]["cost"]["frames"], 6)
