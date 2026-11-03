// Portions adapted from ray-tracing-renderer@0.10.15
// (https://github.com/hoverinc/ray-tracing-renderer).
// Copyright (c) 2019 HOVER, MIT license; see LICENSES/RayTracingRenderer-MIT.txt.

import { clamp } from './util.js';

// TileRender is based on the concept of a compute shader's work group.

// Path tracing the scene can be very slow (<1 fps).
// This overworks the GPU and tends to lock up the OS, making it unresponsive.

// To fix this, we can split the screen into smaller tiles, and sample the scene one tile at a time
// The tile size is set such that each tile takes approximately a constant amount of time to render.

// Since the render time of a tile is dependent on the device, we find the desired tile dimensions by measuring
// the time it takes to render an arbitrarily-set tile size and adjusting the size according to the benchmark.

export function makeTileRender(gl?: WebGL2RenderingContext) {
  let desiredMsPerTile = 21;
  let maxNumTiles = Infinity;

  let currentTile = -1;
  let numTiles = 1;
  let numSamples = 1;

  let tileWidth: number;
  let tileHeight: number;

  let columns: number;
  let rows: number;

  let width = 0;
  let height = 0;

  let totalElapsedMs = 0;
  let timedTiles = 0;

  // initial number of pixels per rendered tile
  // based on correlation between system performance and max supported render buffer size
  // adjusted dynamically according to system performance
  let pixelsPerTile = gl ? pixelsPerTileEstimate(gl) : 600000;

  function reset() {
    currentTile = -1;
    totalElapsedMs = 0;
    timedTiles = 0;
  }

  function setSize(w: number, h: number) {
    width = w;
    height = h;
    reset();
    calcTileDimensions();
  }

  function calcTileDimensions() {
    const maxWidth = 3000;
    const aspectRatio = width / height;

    // quantize the width of the tile so that it evenly divides the entire window
    tileWidth = Math.ceil(
      maxWidth /
        Math.max(
          Math.round(maxWidth / Math.sqrt(pixelsPerTile * aspectRatio)),
          1
        )
    );
    tileHeight = Math.ceil(tileWidth / aspectRatio);

    if (tileWidth > width && tileHeight > height) {
      columns = 1;
      rows = 1;
      numTiles = 1;

      numSamples =
        Math.round(tileWidth / width) * Math.round(tileHeight / height);
    } else {
      numSamples = 1;

      columns = Math.ceil(width / tileWidth);
      rows = Math.ceil(height / tileHeight);
      numTiles = columns * rows;
    }

    if (numTiles > maxNumTiles) {
      // TODO maxNumTiles is not exact value.
      numTiles = maxNumTiles;
      columns = Math.ceil(Math.sqrt(numTiles));
      rows = Math.ceil(numTiles / columns);
      numTiles = columns * rows;
      tileWidth = Math.ceil(width / columns);
      tileHeight = Math.ceil(height / rows);
    }
  }

  function updatePixelsPerTile() {
    const msPerTile = totalElapsedMs / timedTiles;

    const error = desiredMsPerTile - msPerTile;

    // tweak to find balance. higher = faster convergence, lower = less fluctuations to microstutters
    const strength = 5000;

    // sqrt prevents massive fluctuations in pixelsPerTile for the occasional stutter
    pixelsPerTile += strength * Math.sign(error) * Math.sqrt(Math.abs(error));
    pixelsPerTile = Math.max(pixelsPerTile, 8192);
  }

  function nextTile(elapsedFrameMs?: number) {
    // The supplied time belongs to the previous tile. After a reset it may
    // instead describe scene preparation, compilation, or the previous view.
    if (
      currentTile >= 0 && elapsedFrameMs != null &&
      Number.isFinite(elapsedFrameMs) && elapsedFrameMs > 0
    ) {
      totalElapsedMs += elapsedFrameMs;
      timedTiles++;
    }
    currentTile++;

    if (currentTile % numTiles === 0) {
      if (timedTiles) {
        updatePixelsPerTile();
        calcTileDimensions();
      }

      totalElapsedMs = 0;
      timedTiles = 0;
      currentTile = 0;
    }

    const isLastTile = currentTile === numTiles - 1;

    const x = currentTile % columns;
    const y = Math.floor(currentTile / columns) % rows;

    return {
      xIndex: x,
      yIndex: y,
      columns,
      rows,
      x: x * tileWidth,
      y: y * tileHeight,
      tileWidth,
      tileHeight,
      isFirstTile: currentTile === 0,
      isLastTile,
      samplesPerFrame: numSamples
    };
  }

  return {
    nextTile,
    reset,
    setSize,
    setMaxTiles(maxTiles: number) {
      maxNumTiles = maxTiles;
    },
    setDesiredMsPerTile(time: number) {
      desiredMsPerTile = time;
    },
    getDesiredMsPerTile() {
      return desiredMsPerTile;
    }
  };
}

function getPredictResult(
  width: number,
  height: number,
  lastTraceTime: number,
  expectFrameTime: number,
  tilePixels: number[],
  maxNumTiles: number,
  minimumTileSize: number,
  minimumPredictionSize: number[]
) {
  const maxTileSize = [width, height];
  const rawCount = lastTraceTime > 0 ? expectFrameTime / lastTraceTime : 1;
  // GPU cost is not perfectly linear with tile area: tiny probes include fixed
  // dispatch overhead, while very large tiles can hit cache and divergence
  // cliffs. Limit each update to 2x per dimension so prediction converges in a
  // few samples without jumping from the probe straight to a blocking 4K tile.
  const count = clamp(rawCount, 0.25, 4);

  const wScale = Math.sqrt(count);
  const hScale = count / wScale;

  let newTileWidth = Math.ceil(wScale * tilePixels[0]);
  let newTileHeight = Math.ceil(hScale * tilePixels[1]);

  let samplesPerFrame = 1;
  if (newTileWidth > maxTileSize[0] * 2) {
    samplesPerFrame *= Math.floor(newTileWidth / maxTileSize[0]);
  }
  newTileWidth = Math.min(newTileWidth, maxTileSize[0]);
  if (newTileHeight > maxTileSize[1] * 2) {
    samplesPerFrame *= Math.floor(newTileHeight / maxTileSize[1]);
  }
  newTileHeight = Math.min(newTileHeight, maxTileSize[1]);

  // A compute dispatch still occupies a whole workgroup when fewer lanes
  // are active. Splitting below that footprint repeats the fixed kernel cost
  // and can make timestamp feedback progressively slow down a tiny render.
  newTileWidth = Math.max(newTileWidth,
    Math.min(width, Math.max(minimumTileSize, minimumPredictionSize[0])));
  newTileHeight = Math.max(newTileHeight,
    Math.min(height, Math.max(minimumTileSize, minimumPredictionSize[1])));

  let newColumns = Math.round(width / newTileWidth);
  let newRows = Math.round(height / newTileHeight);

  newTileWidth = Math.ceil(width / newColumns);
  newTileHeight = Math.ceil(height / newRows);

  let newNumTiles = newRows * newColumns;

  if (newNumTiles > maxNumTiles) {
    newNumTiles = maxNumTiles;
    newColumns = Math.ceil(Math.sqrt(newNumTiles));
    newRows = Math.ceil(newNumTiles / newColumns);
    newNumTiles = newColumns * newRows;
    newTileWidth = Math.ceil(width / newColumns);
    newTileHeight = Math.ceil(height / newRows);
  }

  return {
    tileWidth: newTileWidth,
    tileHeight: newTileHeight,
    columns: newColumns,
    rows: newRows,
    numTiles: newNumTiles,
    samplesPerFrame
  };
}

// A 64x64 probe is dominated by dispatch and timestamp overhead on modern
// GPUs. At 4K it also leads to an extremely conservative first prediction.
// Use a still-small but representative amount of work, shaped like the frame.
const initialProbePixels = 262144;

function getInitialProbeSize(width: number, height: number) {
  const aspectRatio = width > 0 && height > 0 ? width / height : 1;
  return [
    Math.min(width, Math.max(1, Math.round(Math.sqrt(initialProbePixels * aspectRatio)))),
    Math.min(height, Math.max(1, Math.round(Math.sqrt(initialProbePixels / aspectRatio))))
  ];
}

// Keep repeated kernel/longest-path cost below one fifth of the sample where
// possible. If that conflicts with responsiveness, prioritize the tile ceiling.
const maximumFixedCostShare = 0.2;
// A throughput-oriented ceiling still leaves over 5x margin below a 2s TDR.
// This is a prediction, not a guarantee for unusually expensive sample paths.
const maximumUnattainableTileMs = 350;
const unattainableBudgetTolerance = 1.1;
// Nearby grids amplify timestamp noise when extrapolating to zero pixels.
const minimumAffineAreaChange = 0.2;

function getUnattainableBudgetGrid(
  width: number, height: number, fixedMs: number, msPerPixel: number,
  minimumTileSize: number, maxNumTiles: number, samplesPerFrame: number
) {
  const areaCost = msPerPixel * width * height;
  const maxColumns = Math.max(1, Math.floor(width / minimumTileSize));
  const maxRows = Math.max(1, Math.floor(height / minimumTileSize));
  // If the fixed cost alone exceeds the ceiling, no subdivision can meet it.
  // Avoid multiplying an unavoidable stall by an ever-growing tile count.
  const required = fixedMs < maximumUnattainableTileMs
    ? Math.ceil(areaCost / (maximumUnattainableTileMs - fixedMs)) : 1;
  const minimumTiles = clamp(required, 1, maxColumns * maxRows);
  let fewest: {columns: number; rows: number; count: number} | undefined;
  let withinBoth: typeof fewest;
  const better = (candidate: NonNullable<typeof fewest>, best: typeof fewest) =>
    !best || candidate.count < best.count ||
    (candidate.count === best.count &&
      Math.abs(candidate.columns - candidate.rows) < Math.abs(best.columns - best.rows));
  for (let columns = 1; columns <= Math.min(maxColumns, minimumTiles); columns++) {
    const rows = Math.ceil(minimumTiles / columns);
    if (rows > maxRows) continue;
    const count = columns * rows, candidate = {columns, rows, count};
    if (better(candidate, fewest)) fewest = candidate;
    const tileMs = fixedMs + areaCost / count;
    const fixedShare = count * fixedMs / (count * fixedMs + areaCost);
    if (tileMs <= maximumUnattainableTileMs && fixedShare <= maximumFixedCostShare &&
      better(candidate, withinBoth)) withinBoth = candidate;
  }
  // Fewer tiles also minimize fixed cost. If even the fewest grid that meets
  // the ceiling exceeds the share limit, no grid can satisfy both constraints.
  let {columns, rows, count: numTiles} = (withinBoth ?? fewest)!;
  if (numTiles > maxNumTiles) {
    // Preserve the existing rectangular rounding of the public maxTiles cap.
    numTiles = maxNumTiles;
    columns = Math.ceil(Math.sqrt(numTiles));
    rows = Math.ceil(numTiles / columns);
    numTiles = columns * rows;
  }
  return {columns, rows, numTiles, tileWidth: Math.ceil(width / columns),
    tileHeight: Math.ceil(height / rows), samplesPerFrame};
}

export function makeTileRenderWithPredict(minimumTileSize = 1) {
  let numTiles = 1;
  let currentTile = -1;
  let lastTraceTime = -1;
  // Several offline samples can be submitted before a timing callback runs.
  // Consume each measurement once so stale feedback cannot repeatedly shrink tiles.
  let timingRevision = 0;
  let appliedTimingRevision = -1;
  let lastFrameTotalTraceTime = 0;
  let lastFrameTraceTimeValidCount = 0;
  let tilePixels = [64, 64];
  let width = 0;
  let height = 0;
  let expectFrameTime = 0;

  // Calcualate
  let tileWidth = 0;
  let tileHeight = 0;
  let samplesPerFrame = 1;
  let columns = 0;
  let rows = 0;

  let maxNumTiles = Infinity;
  // Validate a refinement against the grid that motivated it. A smaller
  // dispatch can retain most of the longest path / fixed kernel cost.
  let refinement: { grid: ReturnType<typeof getPredictResult>; time: number } | undefined;
  let minimumPredictionSize = [0, 0];
  let lastMeasurement: {area: number; time: number} | undefined;
  let unattainableGrid: ReturnType<typeof getPredictResult> | undefined;

  function clearPredictionEvidence() {
    refinement = undefined;
    minimumPredictionSize = [0, 0];
    lastMeasurement = undefined;
    unattainableGrid = undefined;
  }

  function nextTile() {
    currentTile++;
    const avgTileTime =
      lastFrameTraceTimeValidCount > 0
        ? lastFrameTotalTraceTime / lastFrameTraceTimeValidCount
        : lastTraceTime;

    if (currentTile % numTiles === 0) {
      currentTile = 0;
    }

    if (currentTile === 0 && timingRevision !== appliedTimingRevision) {
      appliedTimingRevision = timingRevision;
      const measured = lastFrameTraceTimeValidCount > 0;
      let rollback: typeof refinement;
      if (measured && refinement) {
        const areaRatio = refinement.grid.numTiles / numTiles;
        // Require at least half of the area-proportional improvement, unless
        // the new tile already fits the budget (with 10% timing tolerance).
        if (avgTileTime > expectFrameTime * 1.1 &&
          avgTileTime > refinement.time * (1 - (1 - areaRatio) * 0.5)) {
          rollback = refinement;
          minimumPredictionSize = [rollback.grid.tileWidth, rollback.grid.tileHeight];
        }
        refinement = undefined;
      }
      let result = rollback?.grid ?? getPredictResult(
        width,
        height,
        avgTileTime,
        expectFrameTime,
        lastTraceTime >= 0 ? tilePixels : getInitialProbeSize(width, height),
        maxNumTiles,
        minimumTileSize,
        minimumPredictionSize
      );
      if (measured && columns > 0 && rows > 0 && !unattainableGrid) {
        // Use nominal covered area, rather than ceil-rounded dispatch bounds:
        // the interleaved grid covers every pixel exactly once per sample.
        const point = {area: width * height / numTiles, time: avgTileTime};
        if (lastMeasurement && Math.abs(point.area - lastMeasurement.area) >=
          minimumAffineAreaChange * Math.max(point.area, lastMeasurement.area)) {
          const slope = (point.time - lastMeasurement.time) / (point.area - lastMeasurement.area);
          const fixed = point.time - slope * point.area;
          if (Number.isFinite(slope) && slope > 0 && Number.isFinite(fixed) &&
            fixed >= expectFrameTime * unattainableBudgetTolerance) {
            unattainableGrid = getUnattainableBudgetGrid(width, height, fixed, slope,
              minimumTileSize, maxNumTiles, result.samplesPerFrame);
          }
        }
        lastMeasurement = point;
      }
      if (unattainableGrid) {
        // Retain the decision until explicit invalidation. Re-fitting on its
        // own probe/target grids can alternate counts as path costs fluctuate.
        // Keep the original samplesPerFrame calculation independent of this policy.
        result = {...unattainableGrid, samplesPerFrame: result.samplesPerFrame};
        refinement = undefined;
      }
      if (!unattainableGrid && !rollback && measured && result.numTiles > numTiles) {
        refinement = {
          grid: {tileWidth, tileHeight, columns, rows, numTiles, samplesPerFrame},
          time: avgTileTime
        };
      }

      lastFrameTotalTraceTime = 0;
      lastFrameTraceTimeValidCount = 0;
      tileWidth = result.tileWidth;
      tileHeight = result.tileHeight;
      columns = result.columns;
      rows = result.rows;
      numTiles = result.numTiles;
      samplesPerFrame = result.samplesPerFrame;
    }

    const x = currentTile % columns;
    const y = Math.floor(currentTile / columns) % rows;
    const isLastTile = currentTile === numTiles - 1;

    tilePixels = [tileWidth, tileHeight];

    return {
      xIndex: x,
      yIndex: y,
      columns,
      rows,
      x: x * tileWidth,
      y: y * tileHeight,
      tileWidth,
      tileHeight,
      isFirstTile: currentTile === 0,
      isLastTile,
      samplesPerFrame
    };
  }

  return {
    nextTile,
    reset() {
      currentTile = -1;
    },
    setSize(w: number, h: number) {
      if (width !== w || height !== h) {
        timingRevision++;
        clearPredictionEvidence();
        lastTraceTime = -1;
        lastFrameTotalTraceTime = 0;
        lastFrameTraceTimeValidCount = 0;
      }
      width = w;
      height = h;
    },
    setMaxTiles(maxTiles: number) {
      if (maxNumTiles !== maxTiles) {
        timingRevision++;
        clearPredictionEvidence();
      }
      maxNumTiles = maxTiles;
    },
    setDesiredMsPerTile(time: number) {
      if (expectFrameTime !== time) {
        timingRevision++;
        clearPredictionEvidence();
      }
      expectFrameTime = time;
    },
    needsUpdatePredicting() {
      clearPredictionEvidence();
      timingRevision++;
      lastTraceTime = -1;
      lastFrameTotalTraceTime = 0;
      lastFrameTraceTimeValidCount = 0;
    },
    setLastTraceTime(time: number, timedColumns = columns, timedRows = rows) {
      // A timestamp can arrive after the next sample changed the grid. Only
      // compare measurements of the grid currently being evaluated.
      if (timedColumns !== columns || timedRows !== rows || !Number.isFinite(time) || time <= 0) return;
      timingRevision++;
      lastTraceTime = time;
      lastFrameTraceTimeValidCount++;
      lastFrameTotalTraceTime += time;
    },
    getLastTraceTime() {
      return lastTraceTime;
    },
    getDesiredMsPerTile() {
      return expectFrameTime;
    }
  };
}


function pixelsPerTileEstimate(gl: WebGL2RenderingContext) {
  const maxRenderbufferSize = gl.getParameter(gl.MAX_RENDERBUFFER_SIZE);

  if (maxRenderbufferSize <= 8192) {
    return 200000;
  } else {
    // 16K render targets are common on current desktop/integrated GPUs. The
    // old 400K seed unnecessarily split even 720p into several tiles and took
    // dozens of samples to grow to a full-frame tile.
    return 1000000;
  }
}
