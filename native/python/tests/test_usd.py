import json
from pathlib import Path
import struct
import tempfile
import unittest

from mutracer.usd import main, triangulate

try:
    from pxr import Usd
except ImportError:
    Usd = None

FIXTURE = Path(__file__).with_name("fixtures") / "animated-card.usda"


class Triangulation(unittest.TestCase):
    def test_concave_polygon_keeps_the_polygon_area(self):
        points = [(0,0,0),(2,0,0),(2,2,0),(1,1,0),(0,2,0)]
        triangles = triangulate(points, "/Concave")
        self.assertEqual(len(triangles),3)
        double_area = 0
        for i, j, k in triangles:
            a,b,c = points[i],points[j],points[k]
            area = (b[0]-a[0])*(c[1]-a[1]) - (b[1]-a[1])*(c[0]-a[0])
            self.assertGreater(area,0)
            double_area += area
        self.assertEqual(double_area,6)


@unittest.skipUnless(Usd, "optional OpenUSD is unavailable")
class OpenUsdImport(unittest.TestCase):
    def test_converts_z_up_camera_material_and_time_samples(self):
        with tempfile.TemporaryDirectory() as root:
            file = Path(root) / "shot.json"
            self.assertEqual(main([str(FIXTURE), "-o",str(file)]),0)
            shot = json.loads(file.read_text())
            obj = shot["objects"][0]
            self.assertEqual(obj["name"],"/Motion/Card")
            self.assertEqual(obj["position"]["keys"],[[0,[-.3,0,0]],[23/24,[.3,0,0]]])
            self.assertAlmostEqual(obj["material"]["roughness"],.45)
            self.assertAlmostEqual(shot["camera"]["position"][1],1.2)
            self.assertAlmostEqual(shot["camera"]["position"][2],4)
            index = obj["geometry"]["indices"]
            self.assertEqual(struct.unpack_from("<3I",(file.parent / index["file"]).read_bytes(),index["offset"]),(0,1,2))

    def test_bad_bindings_and_local_light_normalization_fail(self):
        text = FIXTURE.read_text()
        invalid_cases = [
            (text.replace('prepend apiSchemas = ["MaterialBindingAPI"]',''), "/Motion/Card", "MaterialBindingAPI"),
            (text.replace("</Paint>","</Missing>"), "/Motion/Card", "/Missing"),
            (text.replace("float inputs:intensity = 12","bool inputs:normalize = true\n    float inputs:intensity = 12"),
             "/Key.inputs:normalize", "Disable normalize"),
        ]
        import contextlib, io
        with tempfile.TemporaryDirectory() as root:
            file = Path(root) / "source.usda"
            for invalid, pointer, message in invalid_cases:
                with self.subTest(pointer=pointer,message=message):
                    file.write_text(invalid)
                    stderr=io.StringIO()
                    with contextlib.redirect_stderr(stderr):
                        self.assertEqual(main([str(file), "--lint"]),2)
                    error=json.loads(stderr.getvalue())
                    self.assertEqual(error["pointer"],pointer)
                    self.assertIn(message,error["message"])
