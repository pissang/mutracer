# Temporal denoising

Use `TemporalDenoiser` to reduce flicker across rendered animation frames.
It requires WebGPU. Offline mode uses earlier and later frames for higher
quality. Interactive mode uses earlier frames with zero frame latency.

## Render an animation

Attach the denoiser before rendering the first frame. After each scene update,
converge the render, push the frame and consume the finished frames. Flush to
finish the last frames with the history available at the end of the shot.

```ts
import { Render } from '@meimu/mutracer';
import { TemporalDenoiser, type TemporalFrame } from '@meimu/mutracer/temporal';

const render = new Render(engine, { width: 1280, height: 720, maxSamples: 32 });
const temporal = new TemporalDenoiser(engine);
const detach = temporal.attach(render);

async function save(frame: TemporalFrame) {
  const png = await engine.display.toBlob(frame);
  await writeFrame(frame.index, png);
}

try {
  for (let i = 0; i < frameCount; i++) {
    animate(i);
    engine.update();
    await render.converge({ samples: 32, sampleSequenceOffset: i * 32 });
    await temporal.push(render);
    for await (const frame of temporal.drain()) await save(frame);
  }
  for await (const frame of temporal.flush()) await save(frame);
} finally {
  detach();
  temporal.dispose();
  render.dispose();
}
```

Use `engine.display.present(frame)` to preview the result. A frame is valid
until its iterator advances. Await export or copy its pixels inside the
loop.

Use a different `sampleSequenceOffset` on each frame so that history can average
independent noise. The example advances by its samples-per-frame count.

## Options

| Option | Default | Effect |
| --- | --- | --- |
| `mode` | `'offline'` | `'offline'` uses a symmetric window. `'interactive'` uses a past-only window. |
| `historyRadius` | Offline `{ min: 8, max: 16 }`. Interactive `17`. | Number of neighboring frames in each available direction, from 0 to 32. Use an adaptive `{ min, max }` in offline mode. |
| `postRadius` | `3` | Radius of post stabilization, from 0 to 3. Set to 0 with `stabilizeSparkle: false` to disable post stabilization. |
| `stabilizeSparkle` | `true` | Suppresses one-frame bright impulses while preserving persistent highlights. |
| `denoiser` | OIDN `cleanAuxLarge` | Spatial filter applied to the accumulated frame. Accepts OIDN options, a custom denoiser, or `null`. |
| `reflectionMotion` | `false` | Follows virtual-image motion on flat reflectors and reduces sliding reflection trails on smooth, opaque nonmetals in the offline window. |
| `accumulateGuides` | `false` | Averages OIDN albedo and normal guides across the offline window when the history radius is positive to reduce flicker. |
| `historyInvalidation` | `'auto'` | Splits history on detected cuts, background, visibility and scene membership changes. Material edits invalidate history on affected surfaces. Light edits can reduce offline history locally and split interactive history. `'manual'` uses explicit cuts and frame gaps. |
| `memoryBudget` | Full plan | GPU bytes for temporal history and scratch. A smaller budget can reduce the effective radii in `plan`. |

Smooth metals blend in more surface history as roughness increases. Near
mirrors use mostly the current frame. With `reflectionMotion` enabled, moving
highlights on smooth, opaque nonmetals may retain more noise as trails are
suppressed.

The default offline latency is 19 frames. Inspect `latency` and, after the
first `push`, `plan` for the effective radii and GPU byte estimate.
The default offline plan budgets about 2.86 GB at 720p and 6.43 GB at
1080p. At 720p with a maximum history radius of 16, setting
`accumulateGuides: true` adds about 265 MB. At the same size and radius,
`reflectionMotion: true` adds about 789 MB, including its render inputs.
Other renderer and OIDN allocations are additional.

## Limits and workflows

- Use `cut()` at known shot boundaries. Output waiting in the queue remains
  drainable. Skipped AOV frames also create a boundary. Use `flush()` before
  starting a shot at a new resolution.
- `push()` requires a converged attached render with surface outputs at
  render resolution. Keep draining its finished frames. After device loss,
  create a new temporal denoiser.
- `reflectionMotion` requires 10 storage buffers per shader stage, or 11 with
  bindless textures. Glass reflections can fall back to surface motion.
  Transmission uses surface motion.
- `frame.readPixels('denoised')` returns final RGBA float32 pixels in the
  spatial denoiser's color representation. `frame.readPixels('accumulated')`
  returns the windowed linear HDR before the spatial filter.
- History needs valid correspondence across the frames it traverses. Surfaces
  that become hidden can have fewer usable samples and retain more noise.
- Moving shadows, reflections and refraction can leave trails. Use per-frame
  OIDN on `Render` for the sharpest edges, or reduce `historyRadius` to limit
  trails. For a known abrupt lighting change, call `cut()` at the boundary
  to prevent any reuse across it.
