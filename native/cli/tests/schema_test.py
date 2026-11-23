"""Run with python3 -m unittest discover -s native/cli/tests -p '*_test.py'."""
import json
from pathlib import Path
import struct
import unittest

from jsonschema import Draft202012Validator

CLI = Path(__file__).resolve().parents[1]
FIXTURES = CLI / "tests" / "fixtures"


class ShotSchemaTest(unittest.TestCase):
    def setUp(self):
        schema = json.loads((CLI / "schema" / "mutracer-shot-v1.json").read_text())
        Draft202012Validator.check_schema(schema)
        self.validator = Draft202012Validator(schema)

    def test_examples(self):
        for file in sorted((CLI / "examples").glob("*.json")):
            with self.subTest(file=file.name):
                self.validator.validate(json.loads(file.read_text()))

    def test_temporal_shot(self):
        shot = json.loads((CLI / "examples" / "turntable.json").read_text())
        output = shot["output"]
        output.update(denoise="temporal", sampleSequence="frame", temporal={"cuts": [0, {"time": 0.5}]})
        self.validator.validate(shot)
        for key, value in [("mode", "interactive"), ("postRadius", 4), ("cuts", [-1])]:
            with self.subTest(key=key):
                original = output["temporal"]
                output["temporal"] = {key: value}
                self.assertFalse(self.validator.is_valid(shot))
                output["temporal"] = original
        output["sampleSequence"] = "fixed"
        self.assertFalse(self.validator.is_valid(shot))

    def test_bad_keys_and_alignment(self):
        for name, path in [
            ("unknown-key.json", ("output",)),
            ("bad-sidecar.json", ("objects", 0, "geometry", "positions")),
        ]:
            with self.subTest(name=name):
                errors = list(self.validator.iter_errors(json.loads((FIXTURES / name).read_text())))
                self.assertEqual([tuple(e.absolute_path) for e in errors], [path])

    def test_sidecar_types_shapes_and_offsets(self):
        shot = json.loads((FIXTURES / "sidecar-shot.json").read_text())
        self.validator.validate(shot)
        data = (FIXTURES / "triangle.bin").read_bytes()
        mesh = shot["objects"][0]["geometry"]
        self.assertEqual(struct.unpack_from("<9f", data, mesh["positions"].get("offset", 0)),
                         (-1, -1, 0, 1, -1, 0, 0, 1, 0))
        self.assertEqual(struct.unpack_from("<3I", data, mesh["indices"]["offset"]), (0, 1, 2))
        offset = shot["assets"]["copies"]["instances"]["offset"]
        self.assertEqual(struct.unpack_from("<16f", data, offset),
                         tuple(int(i % 5 == 0) for i in range(16)))
        self.assertEqual(offset + 64, len(data))
