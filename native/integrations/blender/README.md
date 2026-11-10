# MuTracer for Blender

Experimental MuTracer render engine for **Blender 5.2 on macOS arm64 / Metal**
and **Blender 5.2.1 on Windows x64**.
It renders Principled BSDF materials through Blender's MaterialX/OpenPBR
conversion. It requires a GPU, including for background rendering.

## Use

In Blender, open **Edit → Preferences → Add-ons → Install from Disk**, select
the package for your platform (`mutracer-blender-5.2-macos-arm64.zip` or
`mutracer-blender-5.2-windows-x64.zip`), and enable **MuTracer**.
Choose **MuTracer** as the scene's render engine, set an active camera and lights,
and press **F12**. For a viewport, select **Rendered** shading.

The **Render → MuTracer** panel controls rendering. Scene settings are saved in
`.blend` files and remain when the add-on is disabled and enabled again.
Background rendering uses Blender's normal `-b scene.blend -f 1` command with
the add-on enabled in the Blender profile. Scripts can enable it with
`addon_utils.enable("mutracer_blender")` and select `scene.render.engine = "MUTRACER"`.

## Options

| Scene property (`scene.mutracer`) | Default | Values |
| --- | --- | --- |
| `samples` | 64 | Final render samples, 1–16384 |
| `viewport_samples` | 64 | Viewport samples, 1–16384 |
| `bounces` | 3 | Scattering depth, 1–20 |
| `backend` | `"1"` | `"1"` hardware ray queries with SDK fallback; `"0"` software BVH |
| `resolution_scale` | 1 | 0.1–1; nearest-neighbor enlargement |
| `refresh_rate` | 30 | Output refresh cap in Hz, 1–1000; 0 publishes each changed sample count |

Output is premultiplied linear RGBA in the **Combined** pass. Blender applies
its selected view transform for display; save OpenEXR for linear pixels.

## Caveats

Only Blender 5.2 is supported by this package. The add-on is independently
written under MIT; it uses Blender's public Hydra API and is not part of Blender.
Blender's license applies to Blender itself. Native dependency notices accompany
the package.

Meshes, instances, supported MaterialX graphs, textures, lights and cameras
follow the [Hydra input limits](../hydra/README.md#supported-inputs-and-settings).
Subdivision renders the control cage. Unsupported Blender nodes can be changed
or omitted by Blender's MaterialX conversion before MuTracer receives them.
Default Principled tangent chains currently fall back to material constants
and direct image maps; arbitrary tangent graphs are unsupported.
Blender's live Hydra scene conversion and USD file export can differ in camera,
light units and material conversion; they do not promise pixel equality.
Depth of field is unverified in Blender; its live camera aperture units can
differ from exported USD.

This integration uses CPU render-buffer readback for final images and viewport
output; it does not provide zero-copy display. Windows background rendering is
verified with Blender 5.2.1; Windows viewport presentation remains unverified.
One active view per
delegate is supported. Only Combined is exposed; compositing passes, motion
blur, curves, volumes and multi-view output are unavailable. Material previews
are disabled. The viewport still requires visual verification on a visible
screen; background final rendering does not verify viewport presentation.

Disabling removes the add-on interface, but USD keeps native libraries loaded
until Blender exits. Restart Blender after replacing or rebuilding the package.
