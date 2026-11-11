# Copyright 2026 MuTracer contributors. SPDX-License-Identifier: MIT
"""MuTracer's independently authored Blender Hydra adapter."""
from pathlib import Path
import ctypes
import os
import sys

import bpy
from bpy.props import EnumProperty, FloatProperty, IntProperty, PointerProperty

bl_info = {
    "name": "MuTracer",
    "author": "MuTracer contributors",
    "version": (0, 1, 0),
    "blender": (5, 2, 0),
    "location": "Properties > Render",
    "description": "Progressive path tracing through the MuTracer Hydra delegate",
    "category": "Render",
}


def _update_settings(self, context):
    self.id_data.update_tag()
    if context.screen:
        for area in context.screen.areas:
            if area.type == "VIEW_3D":
                area.tag_redraw()


class MuTracerSettings(bpy.types.PropertyGroup):
    samples: IntProperty(name="Samples", default=64, min=1, max=16384, update=_update_settings)
    viewport_samples: IntProperty(name="Viewport Samples", default=64, min=1, max=16384, update=_update_settings)
    bounces: IntProperty(name="Bounces", default=3, min=1, max=20, update=_update_settings)
    backend: EnumProperty(
        name="Backend",
        items=(("1", "Hardware Ray Queries", "Use hardware ray queries when available"),
               ("0", "Software BVH", "Traverse the BVH in compute shaders")),
        default="1", update=_update_settings,
    )
    resolution_scale: FloatProperty(name="Resolution Scale", default=1.0, min=0.1, max=1.0, update=_update_settings)
    refresh_rate: IntProperty(name="Refresh Rate", description="Output refresh cap in Hz; zero publishes every sample",
                              default=30, min=0, max=1000, update=_update_settings)


def render_settings(scene, engine_type):
    settings = scene.mutracer
    result = {
        "convergedSamplesPerPixel": settings.viewport_samples if engine_type == "VIEWPORT" else settings.samples,
        "maxBounces": settings.bounces,
        "backend": int(settings.backend),
        "resolutionScale": settings.resolution_scale,
        "displayRefreshRate": settings.refresh_rate,
        # Blender 5.2 consumes CPU render buffers, including in its Metal viewport.
        "forceCpuOutput": 1,
    }
    if engine_type != "VIEWPORT":
        result["aovToken:Combined"] = "color"
    return result


class MuTracerEngine(bpy.types.HydraRenderEngine):
    bl_idname = "MUTRACER"
    bl_label = "MuTracer"
    bl_delegate_id = "HdMuTracerRendererPlugin"
    bl_use_materialx = True
    # Blender's OpenGL GPU task renders directly to its framebuffer and omits
    # Hydra render-buffer bindings. Request its CPU-buffer task on Windows;
    # MuTracer still renders on its own GPU, including hardware ray tracing.
    bl_use_gpu_context = sys.platform != "win32"
    bl_use_preview = False

    def update(self, data, depsgraph):
        self._mutracer_scene = depsgraph.scene_eval
        super().update(data, depsgraph)

    def view_update(self, context, depsgraph):
        self._mutracer_scene = depsgraph.scene_eval
        super().view_update(context, depsgraph)

    def get_render_settings(self, engine_type):
        return render_settings(self._mutracer_scene, engine_type)

    def update_render_passes(self, scene, render_layer):
        self.register_pass(scene, render_layer, "Combined", 4, "RGBA", "COLOR")


class MuTracerRenderPanel(bpy.types.Panel):
    bl_label = "MuTracer"
    bl_idname = "MUTRACER_PT_render"
    bl_space_type = "PROPERTIES"
    bl_region_type = "WINDOW"
    bl_context = "render"

    @classmethod
    def poll(cls, context):
        return context.scene.render.engine == "MUTRACER"

    def draw(self, context):
        layout = self.layout
        layout.use_property_split = True
        settings = context.scene.mutracer
        for name in ("samples", "viewport_samples", "bounces", "backend", "resolution_scale", "refresh_rate"):
            layout.prop(settings, name)


_CLASSES = (MuTracerSettings, MuTracerEngine, MuTracerRenderPanel)
# Reuse Blender's panels through their compatibility API, without copying UI code.
_PANEL_NAMES = (
    "RENDER_PT_format", "RENDER_PT_frame_range", "RENDER_PT_output",
    "RENDER_PT_output_color_management", "RENDER_PT_post_processing",
    "DATA_PT_context_camera", "DATA_PT_lens", "DATA_PT_camera",
    "DATA_PT_camera_dof", "DATA_PT_camera_dof_aperture",
    "DATA_PT_context_light", "DATA_PT_EEVEE_light", "DATA_PT_spot",
    "EEVEE_MATERIAL_PT_context_material", "EEVEE_MATERIAL_PT_surface",
)
_enabled_panels = []
# USD keeps plugins resident until process exit, so keep their DLL search
# directories alive across add-on disable/re-enable as well.
_dll_directories = {}
_native_libraries = {}


def register():
    if bpy.app.version[:2] != (5, 2):
        raise RuntimeError("This MuTracer package supports Blender 5.2")
    bpy.utils.expose_bundled_modules()
    from pxr import Plug
    resources = Path(__file__).parent / "plugin" / "hdMuTracer" / "resources"
    if not (resources / "plugInfo.json").is_file():
        raise RuntimeError("MuTracer's native plugin is missing; install the packaged add-on zip")
    if os.name == "nt":
        directory = str(resources.parent.resolve())
        if directory not in _dll_directories:
            _dll_directories[directory] = os.add_dll_directory(directory)
        # USD uses the legacy Windows loader. Preload the sibling SDK by its
        # absolute path so its lookup does not depend on the process directory.
        if directory not in _native_libraries:
            _native_libraries[directory] = ctypes.WinDLL(str(resources.parent / "mutracer.dll"))
    Plug.Registry().RegisterPlugins(str(resources))
    plugin = Plug.Registry().GetPluginWithName("hdMuTracer")
    if not plugin or not plugin.Load():
        raise RuntimeError("MuTracer's native plugin could not load")
    for cls in _CLASSES:
        bpy.utils.register_class(cls)
    bpy.types.Scene.mutracer = PointerProperty(type=MuTracerSettings)
    for name in _PANEL_NAMES:
        panel = getattr(bpy.types, name, None)
        engines = getattr(panel, "COMPAT_ENGINES", None)
        if engines is not None and "MUTRACER" not in engines:
            engines.add("MUTRACER")
            _enabled_panels.append(panel)


def unregister():
    for panel in _enabled_panels:
        panel.COMPAT_ENGINES.discard("MUTRACER")
    _enabled_panels.clear()
    del bpy.types.Scene.mutracer
    for cls in reversed(_CLASSES):
        bpy.utils.unregister_class(cls)
    # USD cannot unload native plugins. Disabling removes the Blender interface;
    # the library remains resident until Blender exits.
