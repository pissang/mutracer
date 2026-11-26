import type {OfflineSampleTiles} from '../renderer/OfflineAdaptiveSampling.js';

interface PilotWindow {
  width: number;
  height: number;
  // Weighted RGB sum and support, then weighted squared luminance and squared support.
  sum: Float32Array;
  moments: Float32Array;
}

export function allocateOfflineSampleTiles(pilot: PilotWindow, average: number, tileSize = 8,
  minEffectiveSamples = 6, maxSamples = 8): OfflineSampleTiles & {average: number; belowMinimum: number} {
  const {width, height, sum, moments} = pilot;
  const columns = Math.ceil(width / tileSize);
  const rows = Math.ceil(height / tileSize);
  const tiles = columns * rows;
  const area = new Uint32Array(tiles);
  const support = new Float32Array(tiles);
  const noise = new Float32Array(tiles);
  const targets = new Uint32Array(tiles).fill(1);
  for (let y = 0; y < height; y++) {
    const tileRow = Math.floor(y / tileSize) * columns;
    for (let x = 0; x < width; x++) {
      const pixel = y * width + x;
      const tile = tileRow + Math.floor(x / tileSize);
      const i = pixel * 4;
      const weight = Math.max(1, sum[i + 3]);
      const mean = (.2126 * sum[i] + .7152 * sum[i + 1] + .0722 * sum[i + 2]) / weight;
      const squaredWeights = moments[pixel * 2 + 1];
      const degreesOfFreedom = 1 - squaredWeights / (weight * weight);
      const variance = Math.max(0, moments[pixel * 2] / weight - mean * mean);
      // One surviving sample cannot estimate variance. The support floor
      // still gives these pixels priority if the pilot does not see a glint.
      const relative = degreesOfFreedom > .05 ? variance / (degreesOfFreedom * (.01 + mean * mean)) : 1;
      support[tile] += 1 / weight;
      noise[tile] += Math.min(16, relative);
      area[tile]++;
    }
  }

  const increments: {tile: number; current: number; deficit: boolean; benefit: number}[] = [];
  for (let tile = 0; tile < tiles; tile++) {
    const harmonicSupport = area[tile] / support[tile];
    const variance = .25 + noise[tile] / area[tile];
    for (let current = 1; current < maxSamples; current++) {
      increments.push({tile, current, deficit: harmonicSupport * current < minEffectiveSamples,
        benefit: variance / (harmonicSupport * current * (current + 1))});
    }
  }
  increments.sort((a, b) => Number(b.deficit) - Number(a.deficit) || b.benefit - a.benefit || a.tile - b.tile);
  let remaining = Math.max(0, Math.round(average * width * height) - width * height);
  let spent = width * height;
  for (const {tile, current} of increments) {
    if (area[tile] > remaining || targets[tile] !== current) continue;
    targets[tile]++;
    remaining -= area[tile];
    spent += area[tile];
    if (remaining === 0) break;
  }
  let belowMinimum = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const target = targets[Math.floor(y / tileSize) * columns + Math.floor(x / tileSize)];
      if (target * sum[(y * width + x) * 4 + 3] < minEffectiveSamples) belowMinimum++;
    }
  }
  return {width, height, tileSize, targets, average: spent / (width * height), belowMinimum: belowMinimum / (width * height)};
}
