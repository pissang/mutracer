"""Optional OpenUSD to shot-v1 importer."""
from __future__ import annotations

import argparse
from array import array
from hashlib import sha256
import json
from math import atan, degrees, isfinite, pi, radians, sin
import os
from pathlib import Path
import sys

from .stream import _atomic_bytes


class Located(ValueError):
    def __init__(self, path, message):
        super().__init__(message)
        self.path = str(path)


def relative(path, base):
    try:
        return Path(os.path.relpath(path, base)).as_posix()
    except ValueError:
        return Path(path).as_posix()


def packed(code, values):
    result = array(code, values)
    if sys.byteorder != "little":
        result.byteswap()
    return result.tobytes()


def triangulate(points, path):
    if len(points) == 3:
        return [(0, 1, 2)]
    # Project onto the largest component of the polygon normal, then clip ears.
    # This retains author winding and also handles concave polygon faces.
    normal = [0., 0., 0.]
    for a, b in zip(points, points[1:] + points[:1]):
        for k in range(3):
            i, j = (k + 1) % 3, (k + 2) % 3
            normal[k] += (a[i] - b[i]) * (a[j] + b[j])
    skip = max(range(3), key=lambda axis: abs(normal[axis]))
    coordinates = [(point[(skip + 1) % 3], point[(skip + 2) % 3]) for point in points]

    def cross(a, b, c):
        a, b, c = coordinates[a], coordinates[b], coordinates[c]
        return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])

    orientation = 1 if normal[skip] > 0 else -1
    loop = list(range(len(points)))
    triangles = []
    while len(loop) > 3:
        for i, b in enumerate(loop):
            a, c = loop[i - 1], loop[(i + 1) % len(loop)]
            if orientation * cross(a, b, c) <= 0:
                continue
            if any(all(orientation * cross(x, y, k) >= 0 for x, y in [(a, b), (b, c), (c, a)])
                   for k in loop if k not in (a, b, c)):
                continue
            triangles.append((a, b, c))
            loop.pop(i)
            break
        else:
            raise Located(path, "Polygon is degenerate, self-intersecting or has no triangulable ear.")
    triangles.append(tuple(loop))
    return triangles


class Importer:
    def __init__(self, stage, output, modules):
        self.stage, self.output = stage, output
        self.Gf, self.Usd, self.Geom, self.Lux, self.Shade = modules
        self.assets = {}
        self.payloads = {}
        self.prims = list(stage.Traverse())
        for name in ("upAxis", "metersPerUnit"):
            if not stage.HasAuthoredMetadata(name):
                raise Located("/", f"Author stage {name} metadata explicitly.")
        axis = self.Geom.GetStageUpAxis(stage)
        units = self.Geom.GetStageMetersPerUnit(stage)
        if axis not in ("Y", "Z") or not isfinite(units) or units <= 0:
            raise Located("/", "Expected Y or Z up and a positive metersPerUnit.")
        self.units = units
        self.to_world = self.Gf.Matrix4d(1).SetScale(units)
        if axis == "Z":
            self.to_world *= self.Gf.Matrix4d(1).SetRotate(self.Gf.Rotation(self.Gf.Vec3d(1, 0, 0), -90))
        self.fps = int(round(stage.GetFramesPerSecond()))
        self.tcps = stage.GetTimeCodesPerSecond()
        if not 1 <= self.fps <= 240 or not isfinite(self.tcps) or self.tcps <= 0:
            raise Located("/", "Expected a frame rate from 1 to 240 and positive timeCodesPerSecond.")
        self.start = stage.GetStartTimeCode()
        self.end = stage.GetEndTimeCode()
        if self.end < self.start:
            raise Located("/", "endTimeCode precedes startTimeCode.")
        self.first = self.Usd.TimeCode(self.start)
        self.duration = (self.end - self.start) / self.tcps + 1 / self.fps
        self.xform_caches = {}

    def lint(self, prim):
        path = prim.GetPath()
        xform = self.Geom.Xformable(prim)
        if xform:
            order = list(xform.GetXformOpOrderAttr().Get() or [])
            attrs = {str(attr.GetName()) for attr in prim.GetAuthoredAttributes()
                     if str(attr.GetName()).startswith("xformOp:")}
            ordered = {name.removeprefix("!invert!") for name in order if name != "!resetXformStack!"}
            if attrs - ordered:
                raise Located(path, f"xformOpOrder omits {', '.join(sorted(attrs - ordered))}.")
            if any(not prim.HasAttribute(name) for name in ordered):
                raise Located(path, "xformOpOrder references a nonexistent transform operation.")
        bound = [rel for rel in prim.GetAuthoredRelationships()
                 if str(rel.GetName()).startswith("material:binding")]
        if bound and not prim.HasAPI(self.Shade.MaterialBindingAPI):
            raise Located(path, "Apply MaterialBindingAPI before authoring a material:binding relationship.")
        for rel in bound:
            if rel.GetName() == "material:binding":
                for target in rel.GetTargets():
                    if not self.Shade.Material(self.stage.GetPrimAtPath(target)):
                        raise Located(path, f"Invalid material binding target {target}.")
        imageable = self.Geom.Imageable(prim)
        if imageable and imageable.GetVisibilityAttr().GetNumTimeSamples():
            raise Located(path, "Time-varying visibility cannot be represented in shot v1.")

    def times(self, attrs=(), prim=None):
        times = set()
        for attribute in attrs:
            times.update(attribute.GetTimeSamples())
        while prim and not prim.IsPseudoRoot():
            xform = self.Geom.Xformable(prim)
            if xform:
                times.update(xform.GetTimeSamples())
                if xform.GetResetXformStack():
                    break
            prim = prim.GetParent()
        return sorted({self.start, self.end} | {t for t in times if self.start <= t <= self.end})

    def channel(self, times, sample):
        keys = [[(t - self.start) / self.tcps, sample(self.Usd.TimeCode(t))] for t in times]
        first = keys[0][1]
        return first if all(value == first for _, value in keys) else {"keys": keys}

    def matrix(self, prim, time):
        if time.GetValue() not in self.xform_caches:
            if len(self.xform_caches) >= 16:
                del self.xform_caches[next(iter(self.xform_caches))]
            self.xform_caches[time.GetValue()] = self.Geom.XformCache(time)
        return self.xform_caches[time.GetValue()].GetLocalToWorldTransform(prim) * self.to_world

    def transform(self, prim, time):
        matrix = self.matrix(prim, time)
        transform = self.Gf.Transform(matrix)
        scale = list(transform.GetScale())
        if any(value <= 0 or not isfinite(value) for value in scale):
            raise Located(prim.GetPath(), "Expected invertible, non-reflected scaling.")
        quat = transform.GetRotation().GetQuat()
        rotation = [*quat.GetImaginary(), quat.GetReal()]
        translation = list(transform.GetTranslation())
        expected = (self.Gf.Matrix4d(1).SetScale(self.Gf.Vec3d(*scale))
                    * self.Gf.Matrix4d(1).SetRotate(transform.GetRotation())
                    * self.Gf.Matrix4d(1).SetTranslate(self.Gf.Vec3d(*translation)))
        if not self.Gf.IsClose(matrix, expected, 1e-6):
            raise Located(prim.GetPath(), "Shear or a non-axis-aligned scale cannot be represented as shot TRS.")
        return translation, rotation, scale

    def pose(self, prim, time):
        matrix = self.matrix(prim, time)
        eye = matrix.ExtractTranslation()
        forward = matrix.TransformDir(self.Gf.Vec3d(0, 0, -1)).GetNormalized()
        return list(eye), list(eye + forward)

    def material(self, prim):
        material, _ = self.Shade.MaterialBindingAPI(prim).ComputeBoundMaterial()
        if not material:
            return {}
        mtlx = material.GetSurfaceOutput("mtlx")
        if mtlx and mtlx.HasConnectedSource():
            shader, _, _ = material.ComputeSurfaceSource("mtlx")
            path = shader.GetSourceAsset("mtlx") if shader else None
            if path and path.resolvedPath:
                name = str(material.GetPath())
                self.assets[name] = {"materialx": relative(path.resolvedPath, self.output.parent)}
                return {"asset": name}
            raise Located(material.GetPath(), "MaterialX requires a local, resolved sourceAsset document.")
        shader, _, _ = material.ComputeSurfaceSource()
        shader_id = str(shader.GetIdAttr().Get()) if shader else ""
        if shader_id in ("open_pbr_surface", "ND_open_pbr_surface_surfaceshader"):
            return self.open_pbr(shader)
        if shader_id != "UsdPreviewSurface":
            raise Located(material.GetPath(), "Expected OpenPBR, UsdPreviewSurface or a MaterialX sourceAsset.")
        result = {}
        properties = {
            "diffuseColor": "color", "roughness": "roughness", "metallic": "metalness",
            "ior": "ior", "opacity": "opacity", "clearcoat": "coat",
            "clearcoatRoughness": "coatRoughness", "emissiveColor": "emissionColor",
            "opacityThreshold": "alphaCutoff",
        }
        for key, target in properties.items():
            port = shader.GetInput(key)
            if not port:
                continue
            if port.HasConnectedSource():
                raise Located(port.GetAttr().GetPath(), "Connected PreviewSurface inputs require a MaterialX asset.")
            attr = port.GetAttr()
            def value(time):
                sampled = attr.Get(time)
                return list(sampled) if key in ("diffuseColor", "emissiveColor") else sampled
            result[target] = self.channel(self.times([attr]), value)
        if "emissionColor" in result:
            result["emissionStrength"] = 1
        if shader.GetInput("useSpecularWorkflow") and shader.GetInput("useSpecularWorkflow").Get(self.first):
            raise Located(shader.GetPath(), "PreviewSurface specular workflow is unsupported.")
        return result

    def open_pbr(self, shader):
        weights = {"base", "specular", "transmission", "subsurface", "coat", "fuzz", "thin_film"}
        lengths = {"transmission_depth", "subsurface_radius"}
        result = {}
        for port in shader.GetInputs():
            name = str(port.GetBaseName())
            if port.HasConnectedSource():
                raise Located(port.GetAttr().GetPath(), "Connected OpenPBR inputs require a MaterialX sourceAsset.")
            attr = port.GetAttr()
            if not attr.HasAuthoredValueOpinion():
                continue
            parts = (name + "_weight" if name in weights else name).split("_")
            field = parts[0] + "".join(part.title() for part in parts[1:])

            def sample(t):
                value = attr.Get(t)
                if isinstance(value, (int, float, bool)):
                    return value * self.units if name in lengths else value
                if isinstance(value, (self.Gf.Vec2f, self.Gf.Vec3f, self.Gf.Vec2d, self.Gf.Vec3d)):
                    return list(value)
                raise Located(attr.GetPath(), "Use an OpenPBR numeric constant or a MaterialX sourceAsset.")

            value = self.channel(self.times([attr]), sample)
            if isinstance(value, dict) and isinstance(value["keys"][0][1], bool):
                raise Located(attr.GetPath(), "Time-varying OpenPBR booleans require separate shots.")
            result[field] = value
        return result

    def mesh(self, prim, index):
        path = prim.GetPath()
        mesh = self.Geom.Mesh(prim)
        if mesh.GetSubdivisionSchemeAttr().Get(self.first) not in ("none", ""):
            raise Located(path, "Set subdivisionScheme to none or export a tessellated mesh.")
        if self.Geom.Subset.GetGeomSubsets(mesh):
            raise Located(path, "Material subsets require separate mesh prims.")
        attrs = [mesh.GetPointsAttr(), mesh.GetFaceVertexCountsAttr(), mesh.GetFaceVertexIndicesAttr(),
                 mesh.GetNormalsAttr(), mesh.GetHoleIndicesAttr()]
        if any(attr.GetNumTimeSamples() > 1 for attr in attrs):
            raise Located(path, "Animated mesh buffers are unsupported. Move vertices with a glTF clip or animate transforms.")
        points, counts, indices, normals, holes = [attr.Get(self.first) for attr in attrs]
        holes = set(holes or ())
        if not points or not counts or not indices or sum(counts) != len(indices):
            raise Located(path, "Missing or inconsistent mesh topology.")
        primvar = self.Geom.PrimvarsAPI(prim).FindPrimvarWithInheritance("st")
        uv = primvar.ComputeFlattened(self.first) if primvar else None
        if primvar and primvar.GetAttr().GetNumTimeSamples() > 1:
            raise Located(path.AppendProperty("primvars:st"), "Animated UVs are unsupported.")
        normal_interpolation = mesh.GetNormalsInterpolation()
        uv_interpolation = primvar.GetInterpolation() if primvar else None
        def access(interpolation, point, face, corner):
            return {"constant": 0, "uniform": face, "varying": point,
                    "vertex": point, "faceVarying": corner}[interpolation]
        data = {"positions": [], "indices": []}
        if normals:
            data["normals"] = []
        if uv:
            data["uv"] = []
        keys = {}
        cursor = 0
        for face, count in enumerate(counts):
            corners = list(indices[cursor:cursor + count])
            if count < 3 or any(not 0 <= vertex < len(points) for vertex in corners):
                raise Located(path, f"Face {face} contains invalid vertices.")
            if face not in holes:
                triangles = triangulate([points[i] for i in corners], path)
                for triangle in triangles:
                    if mesh.GetOrientationAttr().Get(self.first) == "leftHanded":
                        triangle = triangle[::-1]
                    for local in triangle:
                        point = corners[local]
                        try:
                            n = access(normal_interpolation, point, face, cursor + local) if normals else -1
                            u = access(uv_interpolation, point, face, cursor + local) if uv else -1
                            tag = (point, n, u)
                            if tag not in keys:
                                keys[tag] = len(keys)
                                data["positions"].extend(points[point])
                                if normals:
                                    data["normals"].extend(normals[n])
                                if uv:
                                    data["uv"].extend(uv[u])
                        except (KeyError, IndexError) as error:
                            raise Located(path, f"Invalid normal or UV interpolation at face {face}.") from error
                        data["indices"].append(keys[tag])
            cursor += count
        if not 3 <= len(keys) <= 4_000_000 or not 3 <= len(data["indices"]) <= 12_000_000:
            raise Located(path, "Converted geometry exceeds the vertex or index limits.")
        payload = b"".join(packed("I" if key == "indices" else "f", values) for key, values in data.items())
        digest = sha256(payload).hexdigest()[:20]
        sidecar = self.output.with_suffix(".data") / f"mesh-{index:04d}-{digest}.bin"
        self.payloads[sidecar] = payload
        geometry = {}
        offset = 0
        for key, values in data.items():
            shape = [len(values)] if key == "indices" else [len(keys), 2 if key == "uv" else 3]
            geometry[key] = {"file": relative(sidecar, self.output.parent),
                             "dtype": "u32" if key == "indices" else "f32", "shape": shape, "offset": offset}
            offset += len(values) * 4
        timeline = self.times(prim=prim)
        transforms = {t: self.transform(prim, self.Usd.TimeCode(t)) for t in timeline}
        return {"name": str(path), "geometry": geometry, "material": self.material(prim),
                **{name: self.channel(timeline, lambda time: transforms[time.GetValue()][i])
                   for i, name in enumerate(("position", "rotation", "scale"))}}

    def camera(self, prim):
        camera = self.Geom.Camera(prim)
        projected = camera.GetProjectionAttr()
        aperture, focal = camera.GetVerticalApertureAttr(), camera.GetFocalLengthAttr()
        horizontal_aperture = camera.GetHorizontalApertureAttr()
        f_stop, focus = camera.GetFStopAttr(), camera.GetFocusDistanceAttr()
        horizontal, vertical = camera.GetHorizontalApertureOffsetAttr(), camera.GetVerticalApertureOffsetAttr()
        path = prim.GetPath()
        def fov(time):
            if projected.Get(time) != "perspective" or horizontal.Get(time) or vertical.Get(time):
                raise Located(path, "Only centered perspective cameras can be imported.")
            if min(focal.Get(time), aperture.Get(time), horizontal_aperture.Get(time)) <= 0:
                raise Located(path, "Camera aperture and focal length must be positive.")
            return degrees(2 * atan(aperture.Get(time) / (2 * focal.Get(time))))
        timeline = self.times([projected, aperture, horizontal_aperture, focal, horizontal, vertical], prim)
        lens_times = self.times([aperture, f_stop, focus])
        record = {"fov": self.channel(timeline, fov),
                  "position": self.channel(timeline, lambda t: self.pose(prim, t)[0]),
                  "target": self.channel(timeline, lambda t: self.pose(prim, t)[1]),
                  "sensorHeight": self.channel(lens_times, lambda t: aperture.Get(t) * self.units * 100)}
        if f_stop.HasAuthoredValueOpinion():
            def aperture_stop(t):
                value = f_stop.Get(t)
                if not isfinite(value) or value < 0:
                    raise Located(f_stop.GetPath(), "Use a finite, nonnegative fStop.")
                return value
            record["fStop"] = self.channel(lens_times, aperture_stop)
        if focus.HasAuthoredValueOpinion():
            def focus_metres(t):
                distance = focus.Get(t) * self.units
                if distance == 0 and not f_stop.Get(t):
                    return 10
                if not isfinite(distance) or distance <= 0:
                    raise Located(focus.GetPath(), "Use a positive focusDistance.")
                return distance
            record["focusDistance"] = self.channel(lens_times, focus_metres)
        return record

    def light(self, prim):
        kind = str(prim.GetTypeName())
        path = prim.GetPath()
        api = self.Lux.LightAPI(prim)
        intensity, exposure, color = api.GetIntensityAttr(), api.GetExposureAttr(), api.GetColorAttr()
        normalized = api.GetNormalizeAttr()
        if api.GetEnableColorTemperatureAttr().Get(self.first):
            raise Located(path, "Bake color temperature into color before import.")
        if kind == "DomeLight":
            dome = self.Lux.DomeLight(prim)
            texture = dome.GetTextureFileAttr().Get(self.first)
            if not texture or not texture.resolvedPath:
                raise Located(path, "The dome needs a local resolved HDR environment.")
            self.assets[str(path)] = {"hdr": relative(texture.resolvedPath, self.output.parent)}
            return None, {"map": str(path), "intensity": self.channel(self.times([intensity,exposure]),
                     lambda t: intensity.Get(t) * 2 ** exposure.Get(t))}
        types = {"RectLight":"rect","SphereLight":"sphere","DiskLight":"disk",
                 "CylinderLight":"cylinder","DistantLight":"directional"}
        if kind not in types:
            raise Located(path, f"Unsupported light type {kind}.")
        if kind in ("RectLight","SphereLight") and any(normalized.Get(self.Usd.TimeCode(t)) for t in self.times([normalized])):
            raise Located(path.AppendProperty("inputs:normalize"), f"Disable normalize for {kind}; it uses radiance units.")
        shading = self.Lux.ShapingAPI(prim)
        if prim.HasAPI(self.Lux.ShapingAPI) and shading.GetShapingConeAngleAttr().Get(self.first) < 90:
            raise Located(path, "Shaped UsdLux emitters require authoring a spot in the resulting shot.")
        radius = prim.GetAttribute("inputs:radius")
        length = prim.GetAttribute("inputs:length")
        width = prim.GetAttribute("inputs:width")
        height = prim.GetAttribute("inputs:height")
        angle = prim.GetAttribute("inputs:angle")
        attrs = [a for a in (intensity, exposure, color, normalized, radius, length, width, height, angle) if a]
        timeline = self.times(attrs, prim)
        def power(t):
            value = intensity.Get(t) * 2 ** exposure.Get(t)
            norm = normalized.Get(t)
            if kind == "DiskLight" and norm:
                value /= pi * radius.Get(t) ** 2
            elif kind == "CylinderLight" and norm:
                value /= 2 * pi * radius.Get(t) * length.Get(t)
            elif kind == "DistantLight" and not norm:
                half = min(pi, max(0., radians(angle.Get(t)) / 2))
                s2 = sin(half) ** 2
                if half > 0:
                    value *= pi * (s2 if half <= pi / 2 else 2 - s2)
            return value
        record = {"type":types[kind], "position":self.channel(timeline,lambda t:self.pose(prim,t)[0]),
                  "target":self.channel(timeline,lambda t:self.pose(prim,t)[1]),
                  "intensity":self.channel(timeline,power), "color":self.channel(timeline,lambda t:list(color.Get(t)))}
        if radius:
            record["radius"] = self.channel(timeline,lambda t:radius.Get(t)*self.units)
        if length:
            record["length"] = self.channel(timeline,lambda t:length.Get(t)*self.units)
        if width and height:
            record["size"] = self.channel(timeline,lambda t:[width.Get(t)*self.units,height.Get(t)*self.units])
        return record, None

    def convert(self, selected):
        for prim in self.prims:
            self.lint(prim)
        objects, lights, cameras = [], [], []
        environment = None
        for prim in self.prims:
            imageable = self.Geom.Imageable(prim)
            if imageable and imageable.ComputeVisibility(self.first) == "invisible":
                continue
            if prim.IsA(self.Geom.Mesh):
                objects.append(self.mesh(prim, len(objects)))
            elif prim.IsA(self.Geom.Camera):
                cameras.append(prim)
            elif prim.HasAPI(self.Lux.LightAPI):
                light, dome = self.light(prim)
                if light:
                    lights.append(light)
                if dome and environment:
                    raise Located(prim.GetPath(), "Only one environment dome is supported.")
                environment = dome or environment
        if selected:
            cameras = [prim for prim in cameras if str(prim.GetPath()) == selected]
        if len(cameras) != 1:
            raise Located(selected or "/", "Select exactly one visible camera with --camera /Prim/Path.")
        if not objects:
            raise Located("/", "No renderable Mesh prims remain after import.")
        result = {"version":1,"output":{"duration":self.duration,"fps":self.fps},
                  "assets":self.assets,"objects":objects,"lights":lights,"camera":self.camera(cameras[0])}
        if environment:
            result["environment"] = environment
        return result


def main(argv=None):
    parser = argparse.ArgumentParser(description="Convert an OpenUSD scene to a native MuTracer shot.")
    parser.add_argument("source", type=Path)
    parser.add_argument("-o","--output", type=Path)
    parser.add_argument("--camera")
    parser.add_argument("--lint", action="store_true")
    args = parser.parse_args(argv)
    if args.output is None and not args.lint:
        parser.error("--output is required unless --lint is given")
    try:
        from pxr import Gf, Usd, UsdGeom, UsdLux, UsdShade
    except ImportError:
        print("OpenUSD pxr is unavailable. Install usd-core for the selected Python.",file=sys.stderr)
        return 3
    try:
        stage = Usd.Stage.Open(str(args.source))
        if not stage:
            raise Located("/", "Could not open the USD stage.")
        output = (args.output or args.source.with_suffix(".json")).resolve()
        importer = Importer(stage,output,(Gf,Usd,UsdGeom,UsdLux,UsdShade))
        shot = importer.convert(args.camera)
        if not args.lint:
            for path,payload in importer.payloads.items():
                path.parent.mkdir(parents=True,exist_ok=True)
                if not path.exists():
                    _atomic_bytes(path,payload)
            _atomic_bytes(output,(json.dumps(shot,allow_nan=False,indent=2)+"\n").encode())
        print(json.dumps({"event":"linted" if args.lint else "imported","objects":len(shot["objects"]),
                          "lights":len(shot["lights"]),"path":str(output)}))
    except Located as error:
        print(json.dumps({"code":2,"pointer":error.path,"message":str(error)}),file=sys.stderr)
        return 2
    except (OSError,RuntimeError,ValueError,ZeroDivisionError) as error:
        print(json.dumps({"code":3,"message":str(error)}),file=sys.stderr)
        return 3
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
