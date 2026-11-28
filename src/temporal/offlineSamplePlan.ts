import type Render from '../Render.js';
import {AOV_LAYOUT} from '../renderer/aov.js';
import type {OfflineSampleTiles} from '../renderer/OfflineAdaptiveSampling.js';

export const offlineSampleTileSize = 4;
const rankingTileSize = 8;
export const offlineSampleCap = 8;

type Geometry = Awaited<ReturnType<Render['_readOfflineGeometry']>> & {material?: Float32Array};

interface VirtualLinks {
  previous: Int32Array;
  next: Int32Array;
  previousConfidence: Float32Array;
  nextConfidence: Float32Array;
}

interface OpticalSupport {
  surfaceScale: Float32Array;
  reflectionShare: Float32Array;
  virtual?: VirtualLinks;
}

interface Links {
  // Indexed on the top-first geometry grid, with -1 marking an invalid link.
  previous: Int32Array;
  next: Int32Array;
  previousReflection: Float32Array;
  nextReflection: Float32Array;
  optical?: OpticalSupport;
}

export async function captureOfflineGeometry(render: Render, stopped: () => boolean, predictReflection = false): Promise<Geometry | undefined> {
  const deadline = performance.now() + 120_000;
  render._restartAovs();
  for (;;) {
    if (stopped()) return;
    const status = render.refine('id');
    if (status === 'finished') {
      const geometry = await render._readOfflineGeometry();
      if (!predictReflection) return geometry;
      const {data: material} = await render.readPixels('roughness');
      return {...geometry, material};
    }
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
    const current: Links = {previous: new Int32Array(n).fill(-1), next: new Int32Array(n).fill(-1),
      previousReflection: new Float32Array(n), nextReflection: new Float32Array(n)};
    if (frame.material) current.optical = readOpticalSupport(frame, frame.material, width, height);
    const earlier = this.links.at(-1), last = this.last;
    if (earlier && last && !cut) {
      const {words, values, stride, rows, left, top} = frame;
      const pixels = stride * rows, oldPixels = last.stride * last.rows;
      const lanes = AOV_LAYOUT.centerBytes / 4;
      const inverseError = new Float32Array(n).fill(Infinity);
      const currentVirtual = current.optical?.virtual, earlierVirtual = earlier.optical?.virtual;
      const virtualError = currentVirtual && earlierVirtual ? new Float32Array(n).fill(Infinity) : undefined;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const i = y * width + x;
          const src = ((rows - 1 - (y + top)) * stride + x + left) * lanes;
          if (!(values[src + 7] > 0)) continue;
          if (virtualError && currentVirtual && earlierVirtual && current.optical!.reflectionShare[i] > 0) {
            const tap = virtualLink(frame, last, width, height, x, y, src, src + pixels * lanes);
            if (tap) {
              currentVirtual.previous[i] = tap.index;
              currentVirtual.previousConfidence[i] = tap.confidence;
              if (tap.error < virtualError[tap.index]) {
                virtualError[tap.index] = tap.error;
                earlierVirtual.next[tap.index] = i;
                earlierVirtual.nextConfidence[tap.index] = tap.confidence;
              }
            }
          }
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

  /** `observeSupport` receives each frame's predicted effective history per tile, for diagnostics. */
  samplePlans(width: number, height: number, base: number, average: number, radius: number, minEffectiveSamples: number,
    observeSupport?: (frame: number, support: Float32Array) => void) {
    const {width: columns, height: rows} = this;
    const step = offlineSampleTileSize;
    if (columns !== Math.ceil(width / step) || rows !== Math.ceil(height / step)) throw new Error('Geometry does not match the final tile grid.');
    const area = Uint32Array.from({length: columns * rows}, (_, i) =>
      Math.min(step, width - (i % columns) * step) * Math.min(step, height - Math.floor(i / columns) * step));
    const groupStep = rankingTileSize / step;
    return this.links.map(({optical}, frame) => {
      const targets = new Uint32Array(area.length).fill(base);
      const support = new Float32Array(area.length);
      for (let i = 0; i < support.length; i++) {
        if (optical) {
          support[i] = this.opticalSupport(frame, i, radius, optical);
          continue;
        }
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
      observeSupport?.(frame, support);
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
      return {width, height, tileSize: step, baseSamples: base, targets, average: base + extra / count, belowMinimum: belowMinimum / count} satisfies
        OfflineSampleTiles & {average: number; belowMinimum: number};
    });
  }
  private opticalSupport(frame: number, i: number, radius: number, optical: OpticalSupport) {
    const surfaceRadius = (radius + 1) * optical.surfaceScale[i] - 1;
    const share = optical.reflectionShare[i];
    let sum = 1, squared = 1, reflectedSum = 1, reflectedSquared = 1;
    for (const past of [true, false]) {
      let surface = i, image = share > 0 && optical.virtual ? i : -1;
      let geometricReflection = 1, virtualConfidence = 1;
      for (let d = 1; d <= radius; d++) {
        const links = this.links[frame + (past ? 1 - d : d - 1)];
        if (!links || (surface < 0 && image < 0)) break;
        let surfaceWeight = 0, virtualWeight = 0;
        if (surface >= 0 && d <= surfaceRadius) {
          const next = (past ? links.previous : links.next)[surface];
          if (next >= 0) {
            geometricReflection = Math.min(geometricReflection, (past ? links.previousReflection : links.nextReflection)[surface]);
            surfaceWeight = 1 - d / (surfaceRadius + 1);
          }
          surface = next;
        } else surface = -1;
        const virtual = links.optical?.virtual;
        if (image >= 0 && virtual) {
          const next = (past ? virtual.previous : virtual.next)[image];
          if (next >= 0) {
            virtualConfidence = Math.min(virtualConfidence, (past ? virtual.previousConfidence : virtual.nextConfidence)[image]);
            virtualWeight = (1 - d / (radius + 1)) * virtualConfidence;
          }
          image = next;
        } else image = -1;
        const reflectedWeight = Math.max(surfaceWeight * geometricReflection, virtualWeight);
        sum += surfaceWeight;
        squared += surfaceWeight * surfaceWeight;
        reflectedSum += reflectedWeight;
        reflectedSquared += reflectedWeight * reflectedWeight;
      }
    }
    // Combine the inverse effective sample counts in proportion to each lobe.
    return 1 / ((1 - share) * squared / (sum * sum) + share * reflectedSquared / (reflectedSum * reflectedSum));
  }
}

function readOpticalSupport(frame: Geometry, material: Float32Array, width: number, height: number): OpticalSupport {
  const {stride, rows, top, left, values} = frame;
  const lanes = AOV_LAYOUT.centerBytes / 4;
  const primary = stride * rows * lanes;
  const reflections = values.length === 3 * primary;
  const n = width * height;
  const surfaceScale = new Float32Array(n);
  const reflectionShare = new Float32Array(n);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const base = ((rows - 1 - y - top) * stride + x + left) * lanes;
      const roughness = material[i * 4], metalness = material[i * 4 + 1];
      surfaceScale[i] = metalness > .10 ? smooth(.05, .24, roughness) : 1;
      if (!reflections) continue;
      const record = values[base + primary + 7] - 1;
      const gloss = (record > 0 ? record >>> 8 : 0) / 255;
      reflectionShare[i] = metalness > .10 ? metalness : gloss;
    }
  }
  const virtual = reflections ? {previous: new Int32Array(n).fill(-1), next: new Int32Array(n).fill(-1),
    previousConfidence: new Float32Array(n), nextConfidence: new Float32Array(n)} : undefined;
  return {surfaceScale, reflectionShare, virtual};
}

function virtualLink(frame: Geometry, last: Geometry, width: number, height: number, x: number, y: number, src: number, a: number) {
  const lanes = AOV_LAYOUT.centerBytes / 4;
  const primary = frame.stride * frame.rows * lanes;
  const record = a + primary;
  const distance = frame.values[record + 2];
  if (!distance) return;
  const {values, words} = frame;
  const qx = x + values[record + 4], qy = y + values[record + 5];
  const px = Math.round(qx), py = Math.round(qy);
  if (px < 0 || py < 0 || px >= width || py >= height) return;
  const dest = ((last.rows - 1 - py - last.top) * last.stride + px + last.left) * lanes;
  if (!sameSurface(frame, src, last, dest)) return;
  const lastPrimary = last.stride * last.rows * lanes;
  const b = dest + lastPrimary, oldRecord = b + lastPrimary;
  if (words[record] !== last.words[oldRecord] || words[record + 1] !== last.words[oldRecord + 1]) return;
  const oldDistance = last.values[oldRecord + 2];
  if (!oldDistance || (distance < 0) !== (oldDistance < 0)) return;
  const distanceError = Math.abs(distance - oldDistance) / Math.max(Math.abs(distance), Math.abs(oldDistance));
  if (distanceError >= .35 || Math.abs(values[src + 7] - last.values[b + 3]) > .05 * values[src + 7]) return;
  const depth = values[a + 3];
  const ray = frame.direction ?? [values[a + 4] - frame.eye[0], values[a + 5] - frame.eye[1], values[a + 6] - frame.eye[2]];
  const cosine = Math.max(0, -(ray[0]*values[a] + ray[1]*values[a + 1] + ray[2]*values[a + 2]) / Math.hypot(...ray));
  const focal = frame.focalLength * offlineSampleTileSize;
  const dx = qx - x - values[src + 4], dy = qy - y - values[src + 5];
  const parallax = Math.hypot(dx, dy);
  const kx = normalDerivative(frame, src, primary, 1, x > 0, x + 1 < width);
  const ky = normalDerivative(frame, src, primary, -frame.stride, y > 0, y + 1 < height);
  const far = distance < 0;
  const opticalDepth = far ? depth : distance * depth / (distance + depth);
  const scale = 2 * cosine * opticalDepth;
  const u = scale * (parallax > 0 ? (kx * dx * dx + ky * dy * dy) / (parallax * parallax) : 0);
  const apertureU = scale * (Math.abs(kx) > Math.abs(ky) ? kx : ky);
  if (1 + u < .25 || 1 + apertureU < .25) return;
  const aperture = focal * frame.apertureRadius * (1/depth - (far ? 0 : 1/(depth + distance)));
  const predictedError = offlineSampleTileSize * parallax * Math.abs(u/(1+u)) + aperture * Math.abs(apertureU/(1+apertureU));
  const trust = 1 - smooth(.1, .5, predictedError);
  if (!trust) return;
  const roughness = frame.material![(y * width + x) * 4];
  const normal = values[a]*last.values[b] + values[a+1]*last.values[b+1] + values[a+2]*last.values[b+2];
  const lobe = Math.max(.04, 2 * roughness * roughness);
  const normalWeight = 1 - smooth(lobe, 2*lobe + .01, Math.acos(Math.max(-1, Math.min(1, normal))));
  const dominant = 1 + ((1-roughness)**2 * (.5+.5*cosine) - 1) * smooth(0, .25, roughness);
  const confidence = trust * normalWeight * dominant * (1-smooth(.08, .35, distanceError));
  if (!(confidence > 0)) return;
  return {index: py * width + px, confidence, error: (qx-px)**2 + (qy-py)**2};
}

function sameSurface(frame: Geometry, a: number, last: Geometry, b: number) {
  return frame.words[a] === last.words[b] && frame.words[a+1] === last.words[b+1] && frame.words[a+2] === last.words[b+2];
}

function normalDerivative(frame: Geometry, at: number, primary: number, step: number, hasBefore: boolean, hasAfter: boolean) {
  const lanes = AOV_LAYOUT.centerBytes / 4;
  const lo = at - step * lanes, hi = at + step * lanes;
  const a = (hasBefore && sameSurface(frame, lo, frame, at) ? lo : at) + primary;
  const b = (hasAfter && sameSurface(frame, hi, frame, at) ? hi : at) + primary;
  const {values: v} = frame;
  const x = v[b+4] - v[a+4], y = v[b+5] - v[a+5], z = v[b+6] - v[a+6];
  return ((v[b]-v[a])*x + (v[b+1]-v[a+1])*y + (v[b+2]-v[a+2])*z) / Math.max(1e-12, x*x + y*y + z*z);
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
