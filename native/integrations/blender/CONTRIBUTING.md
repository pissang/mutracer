# Build and check the Blender adapter

Build the [native SDK](../../README.md#build-and-link) first. Use a separate
OpenUSD 26.03 development installation with monolithic libraries, Python-enabled
class layouts, internal namespace `pxrBlender_v26_03`, and Blender's
`pxbctor`/`pxbdtor` constructor sections. Match oneTBB 2022.3 and MaterialX 1.39.4.
The development prefix must include CPython 3.13 headers with the host's
`pyconfig.h` in `include/python3.13`; Blender ships only that configuration file.
Do not overwrite the usdview OpenUSD installation.

```sh
cmake -S native/integrations/hydra -B /absolute/blender-build \
  -DCMAKE_PREFIX_PATH=/absolute/blender-usd-install \
  -DMUTRACER_BLENDER_ROOT=/Applications/Blender.app -DCMAKE_BUILD_TYPE=Release
cmake --build /absolute/blender-build -j 4
cmake --install /absolute/blender-build --prefix /absolute/blender-plugin
python3 native/integrations/blender/package.py /absolute/blender-plugin \
  /absolute/mutracer-blender-5.2-macos-arm64.zip
```

This mode links the host's `libusd_ms` and `libtbb` directly and packages only
the delegate and SDK library. The plugin uses `@loader_path` for its sibling
SDK and the host executable's resource-library path for USD. Python symbols
used by inline USD converters resolve from Blender's executable; USD references
remain checked at link time. Do not ship the development USD or Python libraries.

Extract the zip to a temporary directory and run:

```sh
blender -b --factory-startup --python-exit-code 1 \
  --python native/integrations/blender/tests/background.py -- \
  --addon-root /absolute/extracted-zip --output /absolute/evidence
```

Add `--scene fixture` for the P0-5 exported cube geometry with reconstructed
Principled inputs, or `--scene procedural` for a textured scene with collection
instances. Each renders 1 and 64 samples and exports USD, EXR, linear float
pixels, timings and a `.blend`. `--export-method USD` selects Blender's alternate
USD scene delegate; the default exercises its live Hydra scene delegate.
Run actual GPU commands under any task-level GPU mutex. The ordinary USD build
continues to run [Hydra ctest](../hydra/CONTRIBUTING.md).

For the viewport, a maintainer needs a visible screen:

1. Install the zip, choose MuTracer, and open a generated `.blend`.
2. Select Rendered shading; verify the image converges and stays correctly
   oriented while orbiting and resizing the view.
3. Change samples, bounces, resolution scale and backend; verify accumulation
   restarts and the controls take effect.
4. Move a light and an instance, edit a material, then switch to and from Solid.
   Verify updates and cancellation recover.
5. Compare the camera view with F12 using the same Blender display transform.
6. Disable and re-enable the add-on, then quit Blender; check for a clean exit.

The Python adapter is independently authored against the public API; Blender
source is interface reference only. Do not copy GPL implementation code here.
