---
name: mutracer-video
description: Author, review, and render 3D shots with the native MuTracer video CLI. Use for shot JSON, model turntables, material studies, procedural clips, contact sheets, and captioned cuts.
---

Run `mutracer guide` for commands and `mutracer schema` for supported shot
fields. Use metres, degrees, seconds and linear RGB. Use existing local models
or procedural geometry. Keep geometry and textures in external assets.

1. Write a shot with distinct object names, a camera, light sources and an
   explicit duration. Use named targets and camera orbit for turntables.
   Set `camera.fStop` and `focusDistance` for depth of field. Set
   `output.render` for bounce depth or caustics. Use `toneMapping` and
   `toneMappingExposure` in `output.display` for tone mapping and linear
   exposure. Use OpenPBR names such as `baseColor`, `specularRoughness` and
   `coatWeight`. Name texture slots directly on the material.
2. Run `mutracer validate shot.json`. Fix the reported locations before
   rendering. Check pixel samples and frame count before choosing a budget.
3. Run `mutracer still shot.json --t TIME -o still.png`. Inspect composition
   and lighting at a representative time.
4. Run `mutracer preview shot.json -o preview.mp4 --contact-sheet review.png`.
   Inspect the contact sheet for framing, material changes and motion. Render
   another still when the preview suggests a lighting or geometry problem.
5. Run `mutracer render shot.json -o final.mp4` after the preview is ready.
   Read JSON progress. Rerun the same command to reuse completed frames after
   a device failure. Use a separate frame directory when inputs change.

Use `--frames A-B` for a range and `--max-minutes` to bound rendering time.
For compositing, use `--format exr`. Use `sampleSequence: "frame"` for adjacent
sampling ranges. Add `--aovs` to use the offline temporal filter. Join
approved PNG sequences with `mutracer assemble`.
