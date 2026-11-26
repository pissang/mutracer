import type Render from '../Render.js';
import {AOV_LAYOUT} from '../renderer/aov.js';
import type {OfflineSampleTiles} from '../renderer/OfflineAdaptiveSampling.js';

export const offlineSampleTileSize = 4;
const rankingTileSize = 8;
export const offlineSampleCap = 8;

type Geometry = Awaited<ReturnType<Render['_readOfflineGeometry']>>;

interface Links {
  // Indexed on the top-first geometry grid, with -1 marking an invalid link.
  previous: Int32Array;
  next: Int32Array;
  previousReflection: Float32Array;
  nextReflection: Float32Array;
}

export async function captureOfflineGeometry(render: Render, stopped: () => boolean) {
  const deadline = performance.now() + 120_000;
  render._restartAovs();
  for (;;) {
    if (stopped()) return;
    const status = render.refine('id');
    if (status === 'finished') return render._readOfflineGeometry();
    if (status === 'error') throw render.engine.lastError ?? new Error('Offline geometry capture failed.');
    if (performance.now() > deadline) throw new Error('Timed out preparing offline geometry.');
    await new Promise(resolve => setTimeout(resolve, 0));
  }
}

export class OfflineGeometryHistory {
  private readonly links: Links[] = [];
  private last?: Geometry;

  constructor(readonly width: number, readonly height: number) {}

  add(frame: Geometry, cut = false) {
    const {width, height} = this;
    const n = width * height;
    const current = {previous: new Int32Array(n).fill(-1), next: new Int32Array(n).fill(-1),
      previousReflection: new Float32Array(n), nextReflection: new Float32Array(n)};
    const earlier = this.links.at(-1), last = this.last;
    if (earlier && last && !cut) {
      const {words, values, stride, rows, left, top} = frame;
      const pixels = stride * rows, oldPixels = last.stride * last.rows;
      const lanes = AOV_LAYOUT.centerBytes / 4;
      const inverseError = new Float32Array(n).fill(Infinity);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const i = y * width + x;
          const src = ((rows - 1 - (y + top)) * stride + x + left) * lanes;
          if (!(values[src + 7] > 0)) continue;
          const oldX = x + values[src + 4], oldY = y + values[src + 5];
          const px = Math.round(oldX), py = Math.round(oldY);
          if (px < 0 || py < 0 || px >= width || py >= height) continue;
          const j = py * width + px;
          const dest = ((last.rows - 1 - (py + last.top)) * last.stride + px + last.left) * lanes;
          if (words[src] !== last.words[dest] || words[src + 1] !== last.words[dest + 1] ||
            words[src + 2] !== last.words[dest + 2]) continue;
          const a = src + pixels * lanes, b = dest + oldPixels * lanes;
          const normal = values[a] * last.values[b] + values[a + 1] * last.values[b + 1] + values[a + 2] * last.values[b + 2];
          if (normal < .95 || Math.abs(values[src + 7] - last.values[b + 3]) > .04 * values[src + 7]) continue;
          const confidence = reflectedAgreement(frame, last, a, b);
          current.previous[i] = j;
          current.previousReflection[i] = confidence;
          const error = (oldX - px) ** 2 + (oldY - py) ** 2;
          if (error < inverseError[j]) {
            inverseError[j] = error;
            earlier.next[j] = i;
            earlier.nextReflection[j] = confidence;
          }
        }
      }
    }
    this.links.push(current);
    this.last = frame;
  }

  samplePlans(width: number, height: number, base: number, average: number, radius: number, minEffectiveSamples: number) {
    const {width: columns, height: rows} = this;
    const step = offlineSampleTileSize;
    if (columns !== Math.ceil(width / step) || rows !== Math.ceil(height / step)) throw new Error('Geometry does not match the final tile grid.');
    const area = Uint32Array.from({length: columns * rows}, (_, i) =>
      Math.min(step, width - (i % columns) * step) * Math.min(step, height - Math.floor(i / columns) * step));
    const groupStep = rankingTileSize / step;
    return this.links.map((_, frame) => {
      const targets = new Uint32Array(area.length).fill(base);
      const support = new Float32Array(area.length);
      for (let i = 0; i < support.length; i++) {
        let sum = 1, squared = 1, reflectedSum = 1, reflectedSquared = 1;
        for (const past of [true, false]) {
          let k = i, reflected = 1;
          for (let d = 1; d <= radius; d++) {
            const links = this.links[frame + (past ? 1 - d : d - 1)];
            if (!links) break;
            const landing = (past ? links.previous : links.next)[k];
            if (landing < 0) break;
            reflected = Math.min(reflected, (past ? links.previousReflection : links.nextReflection)[k]);
            k = landing;
            const weight = (radius + 1 - d) / (radius + 1);
            const reflectionWeight = weight * reflected;
            sum += weight;
            squared += weight * weight;
            reflectedSum += reflectionWeight;
            reflectedSquared += reflectionWeight * reflectionWeight;
          }
        }
        support[i] = Math.min(sum * sum / squared, reflectedSum * reflectedSum / reflectedSquared);
      }
      const increments: {pixels: number[]; samples: number; benefit: number}[] = [];
      for (let y = 0; y < rows; y += groupStep) {
        for (let x = 0; x < columns; x += groupStep) {
          const cells: number[] = [];
          for (let yy = y; yy < Math.min(rows, y + groupStep); yy++) {
            for (let xx = x; xx < Math.min(columns, x + groupStep); xx++) cells.push(yy * columns + xx);
          }
          const mean = cells.reduce((sum, i) => sum + support[i], 0) / cells.length;
          // Use the within-tile variation of geometric support as the priority proxy.
          const variance = .25 + cells.reduce((sum, i) => sum + ((support[i] - mean) / mean) ** 2, 0) / cells.length;
          for (let samples = base; samples < offlineSampleCap; samples++) {
            const pixels = cells.filter(i => support[i] * samples < minEffectiveSamples);
            if (pixels.length) increments.push({pixels, samples, benefit: variance /
              (Math.min(...pixels.map(i => support[i])) * samples * (samples + 1))});
          }
        }
      }
      increments.sort((a, b) => b.benefit - a.benefit);
      const count = width * height;
      let remaining = Math.max(0, Math.round((average - base) * count)), extra = 0, belowMinimum = 0;
      for (const {pixels, samples} of increments) {
        for (const i of pixels) {
          if (targets[i] !== samples || area[i] > remaining) continue;
          targets[i]++;
          remaining -= area[i];
          extra += area[i];
        }
        if (!remaining) break;
      }
      for (let i = 0; i < targets.length; i++) {
        if (support[i] * targets[i] < minEffectiveSamples) belowMinimum += area[i];
      }
      return {width, height, tileSize: step, targets, average: base + extra / count, belowMinimum: belowMinimum / count} satisfies
        OfflineSampleTiles & {average: number; belowMinimum: number};
    });
  }
}

function reflectedAgreement(frame: Geometry, last: Geometry, a: number, b: number) {
  const record = frame.values[a + 7] - 1;
  const roughness = (record & 255) / 255, reflectance = (record >>> 8) / 255;
  if (reflectance <= .005 || roughness >= .15) return 1;
  const [ax, ay, az] = reflectedRay(frame, a);
  const [bx, by, bz] = reflectedRay(last, b);
  const slip = offlineSampleTileSize * frame.focalLength * Math.hypot(ax - bx, ay - by, az - bz);
  const tolerance = Math.max(.15, .12 * offlineSampleTileSize * frame.focalLength * roughness * roughness);
  return 1 - smooth(.005, .035, reflectance) * (1 - smooth(.075, .15, roughness)) *
    smooth(.035, tolerance, slip);
}

function reflectedRay({values, eye, direction}: Geometry, offset: number) {
  const [x,y,z] = direction ?? [values[offset + 4] - eye[0], values[offset + 5] - eye[1], values[offset + 6] - eye[2]];
  const nx = values[offset], ny = values[offset + 1], nz = values[offset + 2];
  const scale = 2 * (x * nx + y * ny + z * nz), length = Math.hypot(x, y, z);
  return [(x - scale * nx) / length, (y - scale * ny) / length, (z - scale * nz) / length] as const;
}

function smooth(min: number, max: number, value: number) {
  const t = Math.min(1, Math.max(0, (value - min) / (max - min)));
  return t * t * (3 - 2 * t);
}
