# Copyright 2026 MuTracer contributors. SPDX-License-Identifier: MIT
"""Run inside Blender 5.2: --python background.py -- --addon-root DIR --output DIR."""
import argparse
from array import array
import json
from pathlib import Path
import sys
import time

import addon_utils
import bpy
from mathutils import Vector

parser = argparse.ArgumentParser()
parser.add_argument("--addon-root", type=Path, required=True)
parser.add_argument("--output", type=Path, required=True)
parser.add_argument("--scene", choices=("fixture", "procedural"))
parser.add_argument("--samples", type=int, default=64)
parser.add_argument("--export-method", choices=("HYDRA", "USD"), default="HYDRA")
args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:])
args.output.mkdir(parents=True, exist_ok=True)
sys.path.insert(0, str(args.addon_root))

# Test Blender's actual add-on lifecycle, RNA registration and persistent scene settings.
for cycle in range(2):
    module = addon_utils.enable("mutracer_blender", default_set=False)
    assert module and hasattr(bpy.types.Scene, "mutracer")
    assert bpy.types.RenderEngine.bl_rna_get_subclass_py("MUTRACER") is module.MuTracerEngine
    assert "MUTRACER" in bpy.types.RENDER_PT_format.COMPAT_ENGINES
    scene = bpy.context.scene
    if cycle == 0:
        assert scene.mutracer.samples == 64 and scene.mutracer.bounces == 3
    else:
        assert scene.mutracer.samples == 17 and scene.mutracer.bounces == 6
    scene.mutracer.samples = 17
    scene.mutracer.viewport_samples = 5
    scene.mutracer.bounces = 6
    scene.mutracer.resolution_scale = 0.5
    scene.mutracer.refresh_rate = 0
    scene.mutracer.backend = "0"
    final = module.render_settings(scene, "FINAL")
    preview = module.render_settings(scene, "PREVIEW")
    viewport = module.render_settings(scene, "VIEWPORT")
    assert final["convergedSamplesPerPixel"] == 17 and final["maxBounces"] == 6
    assert preview == final and viewport["convergedSamplesPerPixel"] == 5
    assert "aovToken:Combined" not in viewport and final["aovToken:Combined"] == "color"
    assert final["forceCpuOutput"] == 1 and final["resolutionScale"] == 0.5
    assert final["displayRefreshRate"] == 0 and final["backend"] == 0
    scene.render.engine = "MUTRACER"
    scene.render.engine = "BLENDER_WORKBENCH"
    addon_utils.disable("mutracer_blender", default_set=False)
    assert not hasattr(bpy.types.Scene, "mutracer")
    assert "MUTRACER" not in bpy.types.RENDER_PT_format.COMPAT_ENGINES
    assert bpy.types.RenderEngine.bl_rna_get_subclass_py("MUTRACER") is None
    # Scene settings survive disabling and re-enabling the add-on.
print("MUTRACER_LIFECYCLE_OK", flush=True)
if not args.scene:
    (args.output / "lifecycle.json").write_text(json.dumps({"passed": True, "cycles": 2}))
else:
    module = addon_utils.enable("mutracer_blender", default_set=False)
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    fixtures = Path(__file__).resolve().parents[2] / "hydra" / "tests"

    def material(name, color, roughness=0.42, metal=0.0, coat=0.0, emission=0.0, textured=False):
        mat = bpy.data.materials.new(name)
        mat.use_nodes = True
        shader = mat.node_tree.nodes.get("Principled BSDF")
        shader.inputs["Base Color"].default_value = (*color, 1)
        shader.inputs["Roughness"].default_value = roughness
        shader.inputs["Metallic"].default_value = metal
        shader.inputs["Coat Weight"].default_value = coat
        shader.inputs["Emission Color"].default_value = (*color, 1)
        shader.inputs["Emission Strength"].default_value = emission
        if textured:
            tex = mat.node_tree.nodes.new("ShaderNodeTexImage")
            tex.image = bpy.data.images.load(str(fixtures / "base-color.png"))
            mat.node_tree.links.new(tex.outputs["Color"], shader.inputs["Base Color"])
        return mat

    textured = material("Textured", (1, 1, 1), roughness=0.35, textured=True)
    constant = material("Constant", (0.2, 0.4, 0.6), metal=0.25)
    coat = material("CoatEmission", (0.1, 0.2, 0.3), roughness=0.5, coat=0.65, emission=3)
    if args.scene == "fixture":
        # Reuse the P0-5 exported geometry, rebuilding its Principled inputs:
        # Blender's USD importer does not round-trip its MaterialX shader graph.
        bpy.ops.wm.usd_import(filepath=str(fixtures / "blender-materialx.usda"), import_materials=False)
        for obj in bpy.context.scene.objects:
            if obj.type == "MESH":
                obj.data.materials.clear()
                imported_materials = {"Cube_002": textured, "Cube_003": coat, "Cube_001": constant}
                assert obj.name in imported_materials, obj.name
                obj.data.materials.append(imported_materials[obj.name])
        target = Vector((2.5, 0, 0))
    else:
        bpy.ops.mesh.primitive_cube_add(location=(-1.3, 0, 0.8), scale=(0.75, 0.75, 0.75))
        bpy.context.object.data.materials.append(textured)
        bpy.ops.mesh.primitive_uv_sphere_add(segments=24, ring_count=12, location=(1.1, 0, 0.8), radius=0.8)
        sphere = bpy.context.object
        sphere.data.materials.append(constant)
        for polygon in sphere.data.polygons:
            polygon.use_smooth = True
        collection = bpy.data.collections.new("Prototype")
        bpy.ops.mesh.primitive_cube_add(size=0.5)
        prototype = bpy.context.object
        prototype.data.materials.append(coat)
        for owner in list(prototype.users_collection):
            owner.objects.unlink(prototype)
        collection.objects.link(prototype)
        for i in range(3):
            instance = bpy.data.objects.new(f"Instance{i}", None)
            instance.instance_type = "COLLECTION"
            instance.instance_collection = collection
            instance.location = (i - 1, 1.8, 0.4)
            bpy.context.collection.objects.link(instance)
        target = Vector((0, 0.4, 0.7))
    for obj in bpy.context.scene.objects:
        if obj.type == "MESH" and obj.data.uv_layers:
            obj.data.uv_layers.active.name = "st"
    bpy.ops.mesh.primitive_plane_add(size=16, location=(target.x, 0, -1.05 if args.scene == "fixture" else 0))
    bpy.context.object.data.materials.append(material("Floor", (0.4, 0.4, 0.4), roughness=0.7))
    bpy.ops.object.light_add(type="AREA", location=target + Vector((1, -3, 6)))
    light = bpy.context.object
    light.name = "Key"
    light.data.energy = 700
    light.data.shape = "RECTANGLE"
    light.data.size = 4
    light.data.size_y = 3
    light.rotation_euler = (target - light.location).to_track_quat("-Z", "Y").to_euler()
    bpy.ops.object.camera_add(location=target + Vector((7, -10, 6)))
    camera = bpy.context.object
    camera.name = "Camera"
    camera.rotation_euler = (target - camera.location).to_track_quat("-Z", "Y").to_euler()
    camera.data.lens = 48
    scene = bpy.context.scene
    scene.camera = camera
    scene.render.engine = "MUTRACER"
    scene.hydra.export_method = args.export_method
    scene.render.resolution_x = 256
    scene.render.resolution_y = 256
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = True
    scene.world = None
    scene.render.image_settings.file_format = "OPEN_EXR"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.image_settings.color_depth = "32"
    scene.view_settings.view_transform = "Standard"
    scene.mutracer.refresh_rate = 0
    scene.mutracer.backend = "1"
    scene.mutracer.bounces = 3
    scene.mutracer.resolution_scale = 1.0
    bpy.ops.wm.usd_export(filepath=str(args.output / "scene.usda"),
                          generate_materialx_network=True, export_materials=True,
                          use_instancing=True)
    bpy.ops.wm.save_as_mainfile(filepath=str(args.output / "scene.blend"))
    timings = []
    for samples in (1, args.samples):
        scene.mutracer.samples = samples
        scene.render.filepath = str(args.output / f"blender-{samples}.exr")
        begin = time.perf_counter()
        result = bpy.ops.render.render(write_still=True)
        seconds = time.perf_counter() - begin
        assert result == {"FINISHED"}
        image = bpy.data.images.load(scene.render.filepath, check_existing=False)
        assert tuple(image.size) == (256, 256)
        pixels = array("f", [0]) * (256 * 256 * 4)
        image.pixels.foreach_get(pixels)
        assert max(pixels) > 0 and all(x == x for x in pixels)
        with (args.output / f"blender-{samples}.rgba32f").open("wb") as file:
            pixels.tofile(file)
        timings.append({"samples": samples, "wallSeconds": seconds})
        print("MUTRACER_RENDER", json.dumps(timings[-1]), flush=True)
    (args.output / "timings.json").write_text(json.dumps(timings, indent=2) + "\n")
    scene.render.engine = "BLENDER_WORKBENCH"
    addon_utils.disable("mutracer_blender", default_set=False)
    print("MUTRACER_BACKGROUND_OK", flush=True)
