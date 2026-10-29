# Progressive rendering

Use RenderLoop for interactive preview and final rendering; use the first layer
when your application needs explicit selection and frame budgets.

```ts
const sync = new THREESync(engine, {scene: threeScene, camera: threeCamera, controls});
const loop = new RenderLoop(engine, {sync});
loop.start();
```

## Loop policy

Each tick updates syncs and commits engine inputs, then calls select, refines the
selected render and presents it. Active syncs select preview by default. Isolated
edits start final immediately; consecutive changes without explicit sync activity
hold preview for idleMs (default 150 ms). When interaction ends, final starts after
the current preview completes; its fallback remains visible until final completes a sample.
With intermediate denoising enabled, it stays visible until the first filtered final image is ready.
To keep the GPU busy while the view is still, enable [sample batching](#sample-batching) on final.

```ts
loop.select = ({changing}) => changing || slider.dragging ? 'preview' : 'final';
loop.on('status', ({status, previous}) => updateStatus(status));
loop.on('sample', ({samples, frameTimeMs}) => updateSamples(samples));
```

Loop status is previewing when the displayed target is preview, including fallback
presentation and the wait for the first complete final image. Starting to trace
final tiles does not change that status until final is actually presented.
Preview samples never emit loop sample events or count toward loop
samples. Intermediate final filtering reports converging; only terminal filtering
reports denoising. After finishing, unchanged ticks update syncs and the engine
without GPU submissions. Display or render settings edits resume necessary work.

During interaction, the loop finishes the current preview sample before applying
the latest scene/camera edits, keeping previews responsive during continuous input.

start pauses on hidden pages; stop preserves images. Use tick with your own frame
loop, or start, which ignores manual tick calls with one warning. loop.converge
pauses interactive ticks, converges/presents final and resumes if still started.

coalesceSceneUpdates defaults to false. When enabled, preview inference defers
engine commits while syncs keep collecting edits. The last presented image stays
visible until the next filtered preview is ready. Completed inference is presented
before the latest camera/scene is committed together. Interaction ending during
inference waits for that result before final starts. With it disabled, changes
immediately invalidate old inference. Once final is available, unused fallback
inference does not delay it or switch presentation back to preview.
Render.denoising includes intermediate
inference without changing status semantics. Denoising does not enable preview;
preview: false always disables it.

## Explicit frame control

Create one `Engine` for a scene and camera, then one `Render` per output. The
engine owns shared GPU scene data; a render owns its image and complete sample
count. `Display` owns canvas presentation and display settings.

```ts
import { Engine, Render } from '@meimu/mutracer';
const engine = new Engine({ canvas });
engine.scene = scene;
engine.camera = camera;
const preview = new Render(engine, {
  resolutionScale: .5,
  timeBudgetMs: 80,
  adaptiveResolution: { targetFrameMs: 80, minScale: .125 },
  bounces: 2, bevel: false, dispersionWavelengths: 1,
  directLightCandidates: 2,
});
const final = new Render(engine, { fallback: preview });
function frame() {
  engine.update();
  const current = dragging ? preview : final;
  current.refine();
  engine.display.present(current);
  requestAnimationFrame(frame);
}
frame();
```

`engine.update()` is the only external edit detection and commit point. Until
it runs, object edits and scene/camera replacement have no effect on tracing.
Call it once after updating your scene and controls, even when several renders
are refined that frame. See [scene updates](updates.md) for notifications.

## Sample batching

Without batching, each call advances one sample or tile, so a fast GPU can idle
between display frames. With `batchSamples`, sampling works on two levels:

- **Per call.** One `refine()` may submit several samples within an estimated
  `timeBudgetMs` of GPU work, or one longer sample or tile, and returns without waiting for them.
  Without `batchSamples`, a call traces one sample or tile.
- **Between frames.** RenderLoop also refines its final render each time the GPU
  finishes queued work, until the next display frame. It keeps about 4 ms of work
  queued, or one sample or tile if that is longer. Expensive tiled samples can
  continue between display frames when each measured tile fits `timeBudgetMs`;
  longer tiles wait for display frames to bound input delay. Presentation still
  follows the display frame rate.

Batching is off by default. Enable it on the loop's final render with
`final: {batchSamples: true}`, or on a Render you supply. RenderLoop stops
batching while the view is changing.

Prefer RenderLoop for between-frame refilling. For your own loop, the following
example runs refills after presentation, with a 60 Hz frame deadline. Adjust the
frame interval to your application's cadence and update controls before
`engine.update()`. This example uses one render and the final beauty channel; enable
`batchSamples` on `render`.

<!-- own-loop-refill -->
```js
let frameGeneration = 0;
let inputRevision = 0;
let paused = false;
for (const event of ['pointerdown', 'pointermove', 'pointerup', 'wheel', 'keydown', 'input', 'change']) {
  addEventListener(event, () => { inputRevision++; }, {capture: true, passive: true});
}

async function refill(generation, deadline, input) {
  const canContinue = () => generation === frameGeneration && !paused && !document.hidden &&
    performance.now() < deadline && input === inputRevision &&
    engine.display.channel === 'final' && render.batchSamples && render.status === 'converging' &&
    !render.denoising && render.samples > 0 && render.gpuTileTimeMs !== undefined &&
    render.gpuTileTimeMs <= render.timeBudgetMs;
  while (canContinue() && await render.whenReadyToRefine()) {
    // Input or a new frame may arrive during the GPU wait.
    if (!canContinue()) break;
    render.refine(undefined, {targetBatchTimeMs: 4, deferResolve: true});
  }
}

function frame(timestamp) {
  requestAnimationFrame(frame);
  const generation = ++frameGeneration;
  if (paused || document.hidden) return;
  engine.update();
  render.refine();
  engine.display.present(render);
  void refill(generation, timestamp + 1000 / 60, inputRevision);
}
requestAnimationFrame(frame);
```

Stopping while queued sampling can continue leaves the GPU idle before the next
frame. Ignoring a `false` capacity result can spin on immediately resolved
Promises. Ignoring the deadline or pending input can delay the next input's image
behind extra GPU work. Stop refilling during export, custom preview selection or
AOV display as well (set `paused = true` and increment `frameGeneration` before
a pause or export, then clear `paused` to resume);
RenderLoop handles those transitions automatically.

`refine()` continues the remaining tiles of the current sample, including repeated
calls between presentations. `samples` increases only after the whole sample;
presentation keeps the previous complete sample until then. Committed scene or
camera edits discard an unfinished sample and restart against the new inputs.
`maxTiles` caps the sample's tile grid (rounded up to a rectangular grid), so a
smaller value makes larger tiles. It does not cap work per frame or per call;
use `timeBudgetMs` and the between-frame deadline to control queued work.

## Reading and exporting

A fixed-size render does not need to be displayed. Its camera defaults to the
committed engine camera, with automatic aspect based on its target dimensions.
An explicitly supplied camera aspect is preserved.

```ts
const image = new Render(engine, { width: 256, height: 256 });
engine.update();
await image.converge({ samples: 64, sampleSequenceOffset: 0 });
const hdr = await image.readPixels('hdr'); // this image, regardless of other activity
const blob = await engine.display.toBlob(image);
image.dispose();
```

`toBlob` uses the specified render's actual dimensions and the display's
settings. It does not resize or change the display canvas. `converge` accepts a
camera override, copied on entry, without replacing `engine.camera`. If engine
input revisions change during a convergence task, the task rejects. Only that
render rejects `refine()` while convergence is running; other renders remain
usable.

## Options and ownership

- RenderLoop: preview/final selection, syncs, idleMs and coalesceSceneUpdates.
- Engine: backend, scene/camera, BVH preparation and texture atlas budget.
- Display: size, tone mapping, color grading, bloom, HDR output, channel and
  shadow-catcher color/opacity. Editing these does not restart accumulation.
- Render: resolution, samples, path quality, alpha handling, execution budget,
  fallback and denoiser. `transmissiveOutputAlphaMin` belongs to Render because
  it is evaluated along individual paths, so changing it restarts that render.

RenderLoop creates a half-resolution preview with adaptive scale .125–.5,
80 ms budget, 2 bounces, no bevel, one wavelength and two light candidates;
other settings use Render defaults. Pass preview settings, a Render or false.
Preview resolution drops when interaction is slow and recovers gradually when
performance improves. Final resolution stays independent of preview adaptation.
Pass final settings or a Render; newly created finals use preview as fallback.
Supplied Render/Sync objects must belong to this engine. loop.dispose releases
only renders it created; dispose supplied renders, syncs and controls yourself.

The default render scale is 1 and adaptive resolution is disabled. Alternatively,
provide both fixed width and height at construction; fixed dimensions cannot be
changed through `resolutionScale`. `width` and `height` report the actual GPU
image, including WebGPU's 16-pixel alignment. See [API options](api.md).

Keep the display canvas at the viewport's drawing-buffer size and set
`resolutionScale` on each render independently. Lowering final's scale does not
lower preview's scale; resizing the display canvas affects both.

Call `render.setDenoiser({ type: 'jnlm', schedule: 'converged' })` with JNLM or an OIDN
configuration. The schedules are `converged` (default), `progressive` (first
sample, then doubling counts at least 500 ms apart; see [scheduling](./denoising.md#scheduling)),
and `every-sample`. Same-engine
renders share equal filter configurations and OIDN weight downloads. The engine
releases a network when its last render lease is released. OIDN is ignored with
a warning on WebGL; JNLM works on both backends.

## Caveats

A fallback has only one level and must belong to the same engine. If the first
full sample is predicted to exceed the frame budget, `refine` supplies a sample
to a stale fallback before continuing. A current fallback is reused; a fast
final sample does not render the fallback. `present` selects the requested
complete image, then its complete fallback, and otherwise leaves the canvas
unchanged. It never traces.

Sample batching on WebGPU needs GPU timestamps; without them, a call traces one
sample, and between-frame refines are WebGPU-only. A larger `timeBudgetMs`
batches more per call, but an edit made just after waits for that work before its
preview starts. Batching keeps the GPU at full speed until `maxSamples`, which
draws more power than one sample per frame. `stop()` ends between-frame refines
at once, though submitted work still finishes; a manual `tick()` refines between
frames only until the next display frame.

`prepare(nextScene)` performs optional CPU BVH preparation without disturbing
the current GPU scene. Setting `engine.scene` and calling `update` commits a
scene switch for every render. Only one GPU scene resides in an engine.

Dispose renders when no longer needed; `engine.dispose()` releases every render
and shared resource. Initialization and asynchronous filter failures use the
engine's `error` event. `Render.status` is independent for each output; the
first-layer API leaves frame selection and application UI status to the caller.
