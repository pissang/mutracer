import { describe, expect, it } from 'vitest';
import schedule from '../fixtures/display-schedule.json';
import {
  makeTileRender,
  makeTileRenderWithPredict
} from '../../src/renderer/TileRender';

describe('WebGL tile rendering', () => {
  it('starts 720p as a single tile on a modern device', () => {
    const gl = {
      MAX_RENDERBUFFER_SIZE: 0x84e8,
      getParameter: () => 16384
    } as unknown as WebGL2RenderingContext;
    const tileRender = makeTileRender(gl);
    tileRender.setSize(1280, 720);

    const tile = tileRender.nextTile(16);
    expect(tile.columns * tile.rows).toBe(1);
  });

  it('does not use a scene-update stall as the first tile measurement after reset', () => {
    const gl = {
      MAX_RENDERBUFFER_SIZE: 0x84e8,
      getParameter: () => 16384
    } as unknown as WebGL2RenderingContext;
    const renderers = [makeTileRender(gl), makeTileRender(gl)];
    for (const tiles of renderers) {
      tiles.setSize(1280, 720);
      const first = tiles.nextTile(0);
      for (let i = 0; i < first.columns * first.rows; i++) {
        tiles.nextTile(21);
      }
      tiles.reset();
    }
    expect(renderers[0].nextTile(5000)).toEqual(renderers[1].nextTile(0));
  });

  it('ignores unavailable update-frame timings and still adapts to valid slow tiles', () => {
    const tiles = makeTileRender();
    tiles.setSize(3840, 2160);
    const first = tiles.nextTile();
    const count = first.columns * first.rows;
    // Only one tile has a valid measurement. Its target-length render must
    // not be averaged with the discarded measurements as if they took 0 ms.
    for (let i = 1; i < count; i++) tiles.nextTile();
    const unchanged = tiles.nextTile(21);
    expect(unchanged).toEqual(first);
    for (let i = 1; i < count; i++) tiles.nextTile(2000);
    const slower = tiles.nextTile(2000);
    expect(slower.tileWidth * slower.tileHeight)
      .toBeLessThan(first.tileWidth * first.tileHeight);
  });
});

describe('predictive tile rendering', () => {
  it('keeps slow compute tiles at least one workgroup wide and covers every pixel once', () => {
    const row = schedule.browserWebGpuTilePrediction;
    const tiles = makeTileRenderWithPredict(row.minimumTileSize);
    tiles.setSize(row.width, row.height); tiles.setDesiredMsPerTile(21);
    for (let sample = 0; sample < 12; sample++) {
      const first = tiles.nextTile();
      expect(first.columns).toBeLessThanOrEqual(row.maximumColumns);
      expect(first.rows).toBeLessThanOrEqual(row.maximumRows);
      const visits = new Uint8Array(row.width * row.height);
      for (let i = 0; i < first.columns * first.rows; i++) {
        const tile = i === 0 ? first : tiles.nextTile();
        for (let y = tile.yIndex; y < row.height; y += tile.rows) {
          for (let x = tile.xIndex; x < row.width; x += tile.columns) visits[y * row.width + x]++;
        }
      }
      expect(visits.every(count => count === 1)).toBe(true);
      // Effective refinements keep reducing time, but the requested budget
      // would need footprints smaller than the compute workgroup.
      tiles.setLastTraceTime(32000 / (first.columns * first.rows));
    }
    expect(tiles.nextTile()).toMatchObject({
      columns: row.maximumColumns, rows: row.maximumRows,
      tileWidth: row.minimumTileSize, tileHeight: row.minimumTileSize
    });
    const tiny = makeTileRenderWithPredict(row.minimumTileSize);
    tiny.setSize(3, 2); tiny.setDesiredMsPerTile(21); tiny.setLastTraceTime(200);
    expect(tiny.nextTile()).toMatchObject({columns: 1, rows: 1});
  });
  it('rolls back ineffective refinements and retains the limit until invalidation', () => {
    const row = schedule.browserWebGpuTilePrediction;
    const tiles = makeTileRenderWithPredict(row.minimumTileSize);
    tiles.setSize(row.width, row.height); tiles.setDesiredMsPerTile(row.targetMs);
    const counts: number[] = [];
    for (let sample = 0; sample < 24; sample++) {
      const tile = completeSample(tiles); counts.push(tile.columns * tile.rows);
      tiles.setLastTraceTime(80);
    }
    expect(Math.max(...counts)).toBe(4);
    expect(counts.slice(2)).toEqual(Array(22).fill(1));
    tiles.reset(); expect(completeSample(tiles).columns).toBe(1);
    tiles.needsUpdatePredicting(); completeSample(tiles);
    tiles.setLastTraceTime(80);
    expect(completeSample(tiles).columns).toBe(2);
  });

  it.each([-0.1, 0.1])('chooses the fixed-cost grid on either side of the legacy improvement threshold (%s ms)', offset => {
    const row = schedule.browserWebGpuTilePrediction;
    const tiles = makeTileRenderWithPredict(row.minimumTileSize);
    tiles.setSize(row.width, row.height); tiles.setDesiredMsPerTile(row.targetMs);
    completeSample(tiles); tiles.setLastTraceTime(80);
    const refined = completeSample(tiles);
    const threshold = 80 * (1 - (1 - 1 / (refined.columns * refined.rows)) * row.minimumProportionalImprovement);
    tiles.setLastTraceTime(threshold + offset);
    const next = completeSample(tiles);
    expect(next.columns * next.rows).toBe(1);
  });

  it('accepts a refinement that fits the schedule budget tolerance despite a high fixed cost', () => {
    const row = schedule.browserWebGpuTilePrediction;
    const tiles = makeTileRenderWithPredict(row.minimumTileSize);
    tiles.setSize(4096, 4096); tiles.setDesiredMsPerTile(row.targetMs);
    completeSample(tiles); tiles.setLastTraceTime(24);
    const refined = completeSample(tiles);
    expect(refined.columns).toBe(9);
    tiles.setLastTraceTime(row.targetMs * row.budgetTolerance);
    expect(completeSample(tiles).columns).toBe(9);
  });

  it.each([0, 5])('converges with fixed overhead %s plus an area-dependent cost', overhead => {
    const tiles = makeTileRenderWithPredict(8);
    tiles.setSize(1024, 1024); tiles.setDesiredMsPerTile(21);
    // Analytic target: 16 tiles when overhead=0; 21 tiles when overhead=5.
    const counts: number[] = [];
    for (let sample = 0; sample < 40; sample++) {
      const tile = completeSample(tiles), count = tile.columns * tile.rows;
      counts.push(count); tiles.setLastTraceTime(overhead + 336 / count);
    }
    const count = counts.at(-1)!;
    expect(overhead + 336 / count).toBeGreaterThanOrEqual(21 * .75);
    expect(overhead + 336 / count).toBeLessThanOrEqual(21 * 1.25);
    // Keep the existing grid quantization: the nearest coarse square grids
    // bracket the analytic target rather than forcing a finer grid each time.
    const optimum = 336 / (21 - overhead);
    expect(Math.abs(count - optimum) / optimum).toBeLessThanOrEqual(.25);
    expect(new Set(counts.slice(-8)).size).toBe(1);
  });

  it.each([[32, 32], [256, 256], [1024, 768]])('bounds unattainable affine work at %s × %s', (width, height) => {
    const row = schedule.browserWebGpuTilePrediction.unattainableBudget;
    const tiles = makeTileRenderWithPredict(8);
    tiles.setSize(width, height); tiles.setDesiredMsPerTile(21);
    const counts: number[] = [];
    for (let sample = 0; sample < 32; sample++) {
      const tile = completeSample(tiles), count = tile.columns * tile.rows;
      counts.push(count); tiles.setLastTraceTime(row.fixedMs + row.msPerPixel * width * height / count);
    }
    const optimum = Math.max(1, Math.ceil(row.msPerPixel * width * height / (row.maximumTileMs - row.fixedMs)));
    expect(counts.at(-1)).toBe(optimum);
    expect(new Set(counts.slice(-16)).size).toBe(1);
    if (width === row.width) expect(counts.slice(0, row.sampleCounts.length)).toEqual(row.sampleCounts);
  });

  it('prioritizes the hard ceiling when the fixed-cost share conflicts', () => {
    const tiles = makeTileRenderWithPredict(8);
    tiles.setSize(1024, 1024); tiles.setDesiredMsPerTile(21);
    let count = 0;
    for (let sample = 0; sample < 16; sample++) {
      const tile = completeSample(tiles); count = tile.columns * tile.rows;
      tiles.setLastTraceTime(150 + 336 / count);
    }
    expect(count).toBe(2);
    expect(150 + 336 / count).toBeLessThanOrEqual(schedule.browserWebGpuTilePrediction.unattainableBudget.maximumTileMs);
    expect(count * 150 / (count * 150 + 336)).toBeGreaterThan(.2);
  });

  it('avoids unbounded subdivision when the fixed cost alone exceeds the ceiling', () => {
    const tiles = makeTileRenderWithPredict(8);
    tiles.setSize(1024, 1024); tiles.setDesiredMsPerTile(21);
    for (let sample = 0; sample < 16; sample++) {
      const tile = completeSample(tiles), count = tile.columns * tile.rows;
      tiles.setLastTraceTime(400 + 336 / count);
    }
    expect(completeSample(tiles).columns * completeSample(tiles).rows).toBe(1);
  });

  it.each([0, 5, 20])('preserves the legacy grid sequence below budget (fixed %s ms)', fixed => {
    const tiles = makeTileRenderWithPredict(8);
    tiles.setSize(1024, 1024); tiles.setDesiredMsPerTile(21);
    const counts: number[] = [];
    for (let sample = 0; sample < 12; sample++) {
      const tile = completeSample(tiles), count = tile.columns * tile.rows;
      counts.push(count); tiles.setLastTraceTime(fixed + 336 / count);
    }
    expect(counts).toEqual(fixed === 20 ? [4, 16, 36, 49, 36, 36, 36, 36, 36, 36, 36, 36]
      : [4, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16]);
  });

  it.each([[100, 100, 4], [100, 200, 4], [100, 10, 9]])('uses legacy feedback for invalid estimates (%s, %s)', (firstMs, secondMs, expected) => {
    const tiles = makeTileRenderWithPredict(8);
    tiles.setSize(1024, 1024); tiles.setDesiredMsPerTile(21);
    expect(completeSample(tiles).columns).toBe(2);
    tiles.setLastTraceTime(firstMs);
    const singlePoint = completeSample(tiles);
    expect(singlePoint.columns * singlePoint.rows).toBe(16);
    tiles.setLastTraceTime(secondMs);
    const next = completeSample(tiles);
    expect(next.columns * next.rows).toBe(expected);
  });

  it('rejects an extrapolation from nearly equal areas', () => {
    const tiles = makeTileRenderWithPredict(8);
    tiles.setSize(8192, 8192); tiles.setDesiredMsPerTile(21);
    completeSample(tiles); tiles.setLastTraceTime(24);
    const nearby = completeSample(tiles);
    expect(nearby.columns).toBe(17);
    tiles.setLastTraceTime(23.9);
    expect(completeSample(tiles).columns).toBe(16);
  });

  function learnedFixedCost() {
    const tiles = makeTileRenderWithPredict(8);
    tiles.setSize(32, 32); tiles.setDesiredMsPerTile(21);
    for (let sample = 0; sample < 3; sample++) {
      const tile = completeSample(tiles);
      tiles.setLastTraceTime(50 + 10 / (tile.columns * tile.rows));
    }
    expect(completeSample(tiles).columns).toBe(1);
    return tiles;
  }

  it.each(['size', 'maximum', 'budget', 'explicit'] as const)('clears affine evidence on %s invalidation', invalidation => {
    const tiles = learnedFixedCost();
    if (invalidation === 'size') tiles.setSize(64, 64);
    if (invalidation === 'maximum') tiles.setMaxTiles(2);
    if (invalidation === 'budget') tiles.setDesiredMsPerTile(22);
    if (invalidation === 'explicit') tiles.needsUpdatePredicting();
    tiles.reset(); completeSample(tiles); tiles.setLastTraceTime(80);
    const next = completeSample(tiles);
    expect(next.columns * next.rows).toBe(invalidation === 'maximum' ? 2 : invalidation === 'budget' ? 16 : 4);
  });

  it('retains the learned decision through accumulation resets and timing noise', () => {
    const tiles = learnedFixedCost();
    for (const time of [48, 60, 53, 57, 49, 58]) {
      tiles.reset(); tiles.setSize(32, 32); tiles.setMaxTiles(Infinity); tiles.setDesiredMsPerTile(21);
      tiles.setLastTraceTime(time);
      expect(completeSample(tiles)).toMatchObject({columns: 1, rows: 1, samplesPerFrame: 1});
    }
  });

  it('keeps a stable coarse grid instead of alternating above and below the budget', () => {
    const tiles = makeTileRenderWithPredict(8);
    tiles.setSize(1024, 768); tiles.setDesiredMsPerTile(21);
    const counts: number[] = [];
    for (let sample = 0; sample < 24; sample++) {
      const tile = completeSample(tiles), count = tile.columns * tile.rows;
      counts.push(count); tiles.setLastTraceTime(26 / count);
    }
    expect(counts.slice(-16)).toEqual(Array(16).fill(1));
  });

  it('ignores delayed timestamps from a superseded grid', () => {
    const tiles = makeTileRenderWithPredict(8);
    tiles.setSize(1024, 1024); tiles.setDesiredMsPerTile(21);
    const initial = completeSample(tiles);
    tiles.setLastTraceTime(80, initial.columns, initial.rows);
    const refined = completeSample(tiles);
    expect(refined.columns).toBeGreaterThan(initial.columns);
    tiles.setLastTraceTime(80, initial.columns, initial.rows);
    expect(completeSample(tiles)).toEqual(refined);
    tiles.setLastTraceTime(80, refined.columns, refined.rows);
    expect(completeSample(tiles)).toEqual(initial);
  });

  it('uses a representative 4K probe instead of a 64x64 cold start', () => {
    const tileRender = makeTileRenderWithPredict();
    tileRender.setSize(3840, 2160);
    tileRender.setDesiredMsPerTile(21);
    tileRender.needsUpdatePredicting();

    const probe = tileRender.nextTile();
    expect(probe.tileWidth * probe.tileHeight).toBeGreaterThan(200000);
    expect(probe.columns * probe.rows).toBeLessThan(64);

    // A typical probe result should immediately produce a practical first
    // sample rather than needing several samples to grow out of tiny tiles.
    tileRender.setLastTraceTime(4);
    tileRender.reset();
    const firstSample = tileRender.nextTile();
    expect(firstSample.columns * firstSample.rows).toBeLessThan(16);
  });

  it('caps the sample grid rather than the number of refine submissions', () => {
    const tiles = makeTileRenderWithPredict();
    tiles.setSize(1920, 1080); tiles.setDesiredMsPerTile(21); tiles.setMaxTiles(2);
    const first = tiles.nextTile();
    // Rectangular rounding of a two-tile limit produces 2 columns by 1 row.
    expect(first.columns * first.rows).toBe(2);
    expect(first.isLastTile).toBe(false); expect(tiles.nextTile().isLastTile).toBe(true);
    expect(tiles.nextTile().isFirstTile).toBe(true);
    tiles.setMaxTiles(1); tiles.reset();
    const whole = tiles.nextTile(); expect(whole.isLastTile).toBe(true);
    expect([whole.tileWidth, whole.tileHeight]).toEqual([1920, 1080]);
  });
  it('drops old timing averages when requesting a fresh prediction', () => {
    const renderers = [makeTileRenderWithPredict(), makeTileRenderWithPredict()];
    for (const tiles of renderers) {
      tiles.setSize(3840, 2160);
      tiles.setDesiredMsPerTile(21);
      tiles.nextTile();
    }
    renderers[0].setLastTraceTime(5000);
    for (const tiles of renderers) {
      tiles.reset();
      tiles.needsUpdatePredicting();
    }
    expect(renderers[0].nextTile()).toEqual(renderers[1].nextTile());
  });

  function completeSample(tiles: ReturnType<typeof makeTileRenderWithPredict>) {
    const first = tiles.nextTile();
    const count = first.columns * first.rows;
    expect(count).toBeLessThan(100000);
    for (let i = 1; i < count; i++) {
      const tile = tiles.nextTile();
      expect([tile.columns, tile.rows]).toEqual([first.columns, first.rows]);
      expect(tile.isLastTile).toBe(i === count - 1);
    }
    return first;
  }

  function warmedPredictor() {
    const tiles = makeTileRenderWithPredict();
    tiles.setSize(1920, 1080);
    tiles.setDesiredMsPerTile(21);
    completeSample(tiles);
    for (let i = 0; i < 3; i++) {
      tiles.setLastTraceTime(5);
      completeSample(tiles);
    }
    return tiles;
  }

  it('keeps a batch grid stable until another GPU measurement arrives', () => {
    const tiles = warmedPredictor();
    tiles.setLastTraceTime(200);
    const first = completeSample(tiles);
    for (let sample = 1; sample < 8; sample++) {
      // Restoring unchanged target settings must not replay old feedback.
      tiles.setSize(1920, 1080);
      tiles.setDesiredMsPerTile(21);
      tiles.setMaxTiles(Infinity);
      const next = completeSample(tiles);
      expect([next.columns, next.rows]).toEqual([first.columns, first.rows]);
    }
    tiles.setLastTraceTime(200 / (first.columns * first.rows));
    const measured = completeSample(tiles);
    expect(measured.columns * measured.rows).toBeGreaterThan(first.columns * first.rows);
  });

  it('retains a valid grid across accumulation resets without new timings', () => {
    const tiles = warmedPredictor();
    tiles.setLastTraceTime(200);
    const first = completeSample(tiles);
    for (let reset = 0; reset < 3; reset++) {
      tiles.reset();
      const next = completeSample(tiles);
      expect([next.columns, next.rows]).toEqual([first.columns, first.rows]);
    }
  });

  it('recomputes the grid when size or execution limits change', () => {
    const tiles = warmedPredictor();
    tiles.setLastTraceTime(200);
    completeSample(tiles);
    tiles.setMaxTiles(1);
    expect(completeSample(tiles).columns).toBe(1);
    tiles.setSize(1280, 720);
    tiles.reset();
    const resized = completeSample(tiles);
    expect([resized.tileWidth, resized.tileHeight]).toEqual([1280, 720]);
    tiles.setMaxTiles(Infinity);
    tiles.setDesiredMsPerTile(1);
    const budget = completeSample(tiles);
    expect(budget.columns * budget.rows).toBeGreaterThan(1);
  });

});
