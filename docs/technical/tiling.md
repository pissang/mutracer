# Tile scheduling

A full-frame path-tracing sample can take longer than a display frame and, on slow
scenes, long enough to stall the browser or trigger a GPU timeout. Renders therefore
trace each sample as a grid of tiles, sized so that one tile fits `timeBudgetMs`.
Usage and the related options are in
[sample batching](../progressive-rendering.md#sample-batching); this note explains how
the tile grid is chosen. The code is `src/renderer/TileRender.ts`.

## Two predictors

- **WebGPU with timestamp queries** uses `makeTileRenderWithPredict`, which reads
  the GPU time of each submitted grid.
- **WebGL 2, and WebGPU without timestamp queries,** use `makeTileRender`, adapted
  from ray-tracing-renderer. It adjusts a pixels-per-tile count from wall-clock
  feedback, never below 8192 pixels. WebGL timer queries are not reliable enough to
  replace it; see [WebGL 2 backend](./webgl.md).

The rest of this note describes the WebGPU predictor.

## Prediction

The first sample uses a probe tile shaped like the frame, large enough that dispatch
overhead does not dominate it. Each later measurement scales the tile area by the
ratio of the budget to the measured tile time, limited to 4× (2× per dimension) per
update so the grid converges without jumping from a small probe to a blocking
full-frame tile. Tiles are never narrower than one compute workgroup (8 pixels):
a smaller dispatch occupies the same workgroups and repeats their fixed cost.

The grid is interleaved, so each sample still covers every pixel once. When the
predicted tile exceeds the frame, several samples are traced per frame instead.

## Why area-proportional prediction is not enough

Tile time is not proportional to tile area. A tile pays a fixed cost for dispatch
and for its longest path, and small frames leave most of the GPU idle. On a heavy
scene at a small resolution, 16 tiles can each take more than half the time of the
whole frame. An area-proportional predictor keeps subdividing toward the budget and
multiplies the cost of every sample.

Two rules handle this:

- **Refinement check.** When the predictor subdivides, it compares the next
  measurement with the grid that motivated the change. If the new tile time
  improves by less than half of the area ratio, and still misses the budget by more
  than 10%, the predictor returns to the previous grid and uses its tile size as a
  floor until prediction is invalidated.
- **Unattainable budgets.** From two measurements at sufficiently different tile
  areas, the predictor fits tile time as `fixed + perPixel × area`. If the fixed
  part alone exceeds the budget by more than 10%, no grid can meet it. The predictor then picks the
  fewest tiles that keep a tile below 350 ms (over 5× below a 2 s GPU timeout) and,
  where possible, keep the repeated fixed cost below one fifth of the sample. This
  decision is retained until prediction is invalidated, because refitting on its
  own grids lets path-cost noise alternate between tile counts.

`maxTiles` still caps the grid in both cases. A long tile is a deliberate trade:
fewer updates while interacting, in exchange for not multiplying the cost of
every sample. The guide documents the resulting pauses.

## Measurements

Several samples may be submitted before their timestamps resolve. Each measurement
is matched to the grid it was submitted with and consumed once, so stale results
cannot shrink tiles repeatedly. Scene, view and setting changes invalidate the
prediction (`needsUpdatePredicting`). Photon and light-tracing batches run with the
first and last tile and are timed separately.

## Changing this code

- Scheduling changes must update `tests/fixtures/display-schedule.json` and the
  schedule tests, and pass `npm run test:parity`; see `AGENTS.md`.
- Judge changes by total sample time and by tile time, at both small and normal
  resolutions on a heavy scene. Fixed-seed HDR must stay identical, because tiling
  changes only the order of work.
