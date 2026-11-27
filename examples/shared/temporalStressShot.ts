// Procedural indoor shot for temporal-denoising stress tests. Every animated
// value is a pure function of time, so a frame index reproduces its scene.
// The module has no runtime imports: the browser example passes the bundled
// package and the Node CLI shot module passes its own copy (Node strips the
// types), so both render the same scene.
import type * as MuTracer from '@meimu/mutracer';

type MT = typeof MuTracer;
type V3 = [number, number, number];
type M4 = number[];

/** Shot timing in seconds. `cut` starts the second camera setup. */
export const temporalStressTiming = {
  duration: 10, fps: 24, cut: 5.8,
  segments: {
    mirrorStill: [0, 1.5], slowPan: [1.5, 3.5], whipPan: [3.5, 4], dolly: [4, 5.8],
    orbit: [5.8, 8.2], focusPull: [8.2, 10]
  }
} as const;

export interface TemporalStressShot {
  scene: MuTracer.Scene;
  camera: MuTracer.Camera;
  /** Number of frames in the shot. */
  frameCount: number;
  /** Frame index that begins after the camera cut. */
  cutFrame: number;
  /** Poses the scene at `t` seconds. Depth of field applies in the focus-pull segment. */
  setTime(t: number, options?: {depthOfField?: boolean}): void;
}

// ---------------------------------------------------------------- math

const clamp = (x: number, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const smooth = (a: number, b: number, t: number) => { const x = clamp((t - a) / (b - a)); return x * x * x * (x * (x * 6 - 15) + 10); };
const mix = (a: number, b: number, x: number) => a + (b - a) * x;
const mix3 = (a: V3, b: V3, x: number): V3 => [mix(a[0], b[0], x), mix(a[1], b[1], x), mix(a[2], b[2], x)];
const rad = (degrees: number) => degrees * Math.PI / 180;

function mul(a: M4, b: M4): M4 {
  const out = new Array<number>(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let sum = 0;
    for (let k = 0; k < 4; k++) sum += a[k * 4 + r] * b[c * 4 + k];
    out[c * 4 + r] = sum;
  }
  return out;
}
const translate = ([x, y, z]: V3): M4 => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
const scale = ([x, y, z]: V3): M4 => [x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1];
const rotX = (a: number): M4 => { const c = Math.cos(a), s = Math.sin(a); return [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]; };
const rotY = (a: number): M4 => { const c = Math.cos(a), s = Math.sin(a); return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]; };
const rotZ = (a: number): M4 => { const c = Math.cos(a), s = Math.sin(a); return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; };
const chain = (...matrices: M4[]) => matrices.reduce(mul);

function rng(seed: number) {
  return () => {
    seed = seed + 0x6d2b79f5 | 0;
    let x = Math.imul(seed ^ seed >>> 15, 1 | seed);
    x = x + Math.imul(x ^ x >>> 7, 61 | x) ^ x;
    return ((x ^ x >>> 14) >>> 0) / 4294967296;
  };
}

function hsv(h: number, s: number, v: number): V3 {
  const f = (n: number) => { const k = (n + h * 6) % 6; return v - v * s * clamp(Math.min(k, 4 - k)); };
  return [f(5), f(3), f(1)];
}

// ---------------------------------------------------------------- geometry

interface Raw { p: number[]; n: number[]; uv: number[]; i: number[] }
const empty = (): Raw => ({p: [], n: [], uv: [], i: []});

function append(target: Raw, source: Raw, m?: M4) {
  const base = target.p.length / 3;
  for (let v = 0; v < source.p.length; v += 3) {
    const [x, y, z] = [source.p[v], source.p[v + 1], source.p[v + 2]];
    const [nx, ny, nz] = [source.n[v], source.n[v + 1], source.n[v + 2]];
    if (!m) { target.p.push(x, y, z); target.n.push(nx, ny, nz); continue; }
    target.p.push(m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]);
    // Rigid transforms with positive scale: the inverse transpose is the
    // rotation scaled by 1/s², so renormalising the scaled normal suffices.
    const sx = m[0] * m[0] + m[1] * m[1] + m[2] * m[2], sy = m[4] * m[4] + m[5] * m[5] + m[6] * m[6], sz = m[8] * m[8] + m[9] * m[9] + m[10] * m[10];
    const ax = nx / sx, ay = ny / sy, az = nz / sz;
    const tx = m[0] * ax + m[4] * ay + m[8] * az, ty = m[1] * ax + m[5] * ay + m[9] * az, tz = m[2] * ax + m[6] * ay + m[10] * az;
    const length = Math.hypot(tx, ty, tz) || 1;
    target.n.push(tx / length, ty / length, tz / length);
  }
  target.uv.push(...source.uv);
  for (const index of source.i) target.i.push(base + index);
  return target;
}

/** Box centered at the origin; UVs are in metres so one texture scale fits every box. */
function box(w: number, h: number, d: number): Raw {
  const half = [w / 2, h / 2, d / 2];
  const faces: [V3, V3, V3][] = [
    [[1, 0, 0], [0, 0, -1], [0, 1, 0]], [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
    [[0, 1, 0], [1, 0, 0], [0, 0, -1]], [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [-1, 0, 0], [0, 1, 0]]
  ];
  const raw = empty();
  const dot = (a: V3) => Math.abs(a[0] * half[0] + a[1] * half[1] + a[2] * half[2]);
  for (const [n, u, v] of faces) {
    const hu = dot(u), hv = dot(v), base = raw.p.length / 3;
    for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      for (let k = 0; k < 3; k++) raw.p.push(n[k] * half[k] + su * hu * u[k] + sv * hv * v[k]);
      raw.n.push(...n);
      raw.uv.push((su + 1) * hu, (sv + 1) * hv);
    }
    raw.i.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return raw;
}

/**
 * Surface of revolution around +Y from a profile of [radius, height] points.
 * Repeat a point to make a hard edge there.
 */
function lathe(profile: [number, number][], segments = 64): Raw {
  const raw = empty();
  let length = 0;
  for (let j = 0; j < profile.length; j++) {
    const [r, y] = profile[j];
    const prev = profile[Math.max(j - 1, 0)], next = profile[Math.min(j + 1, profile.length - 1)];
    const same = (a: [number, number]) => a[0] === r && a[1] === y;
    const from = same(prev) ? profile[j] : prev, to = same(next) ? profile[j] : next;
    let dr = to[0] - from[0], dy = to[1] - from[1];
    const tangent = Math.hypot(dr, dy) || 1; dr /= tangent; dy /= tangent;
    if (j > 0) length += Math.hypot(r - prev[0], y - prev[1]);
    for (let k = 0; k <= segments; k++) {
      const a = 2 * Math.PI * k / segments, c = Math.cos(a), s = Math.sin(a);
      raw.p.push(r * c, y, r * s);
      raw.n.push(dy * c, -dr, dy * s);
      raw.uv.push(k / segments, length);
    }
  }
  const row = segments + 1;
  for (let j = 0; j + 1 < profile.length; j++) for (let k = 0; k < segments; k++) {
    const a = j * row + k, b = a + row;
    raw.i.push(a, b, b + 1, a, b + 1, a + 1);
  }
  return raw;
}

const cylinder = (radius: number, height: number, segments = 24) =>
  lathe([[0, 0], [radius, 0], [radius, 0], [radius, height], [radius, height], [0, height]], segments);

function sphere(radius: number, segments = 48): Raw {
  const profile: [number, number][] = [];
  for (let j = 0; j <= segments / 2; j++) {
    const a = Math.PI * j / (segments / 2);
    profile.push([radius * Math.sin(a), -radius * Math.cos(a)]);
  }
  return lathe(profile, segments);
}

/** Flat pointed leaf in the XY plane, tip along +Y, two-sided by duplication. */
function leaf(length: number, width: number): Raw {
  const raw = empty();
  const steps = 6;
  for (let j = 0; j <= steps; j++) {
    const v = j / steps, half = width * Math.sin(Math.PI * v) * (1 - .3 * v) / 2, bend = .15 * length * v * v;
    for (const side of [-1, 0, 1]) {
      raw.p.push(side * half, v * length, -bend + (side === 0 ? .004 : 0));
      raw.n.push(0, .15 * v, 1);
      raw.uv.push((side + 1) / 2, v);
    }
  }
  for (let j = 0; j < steps; j++) for (let k = 0; k < 2; k++) {
    const a = j * 3 + k, b = a + 3;
    raw.i.push(a, a + 1, b + 1, a, b + 1, b);
  }
  const back = {p: raw.p.slice(), n: raw.n.map(x => -x), uv: raw.uv.slice(), i: [] as number[]};
  for (let t = 0; t < raw.i.length; t += 3) back.i.push(raw.i[t], raw.i[t + 2], raw.i[t + 1]);
  return append(raw, back);
}

// ---------------------------------------------------------------- textures

function pixels(width: number, height: number, color: (x: number, y: number) => V3) {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const [r, g, b] = color(x, y);
    data.set([r, g, b, 255], (y * width + x) * 4);
  }
  return {data, width, height};
}

/** Builds the shot from the MuTracer module the caller renders with. */
export function createTemporalStressShot(mt: MT): TemporalStressShot {
  const {duration, fps, cut} = temporalStressTiming;
  const meshes: MuTracer.Mesh[] = [];

  const geometry = (raw: Raw) => new mt.Geometry({
    position: new mt.GeometryAttribute(new Float32Array(raw.p), 3),
    normal: new mt.GeometryAttribute(new Float32Array(raw.n), 3),
    uv: new mt.GeometryAttribute(new Float32Array(raw.uv), 2),
    indices: new mt.GeometryAttribute(new Uint32Array(raw.i), 1)
  });
  const add = (raw: Raw, material: MuTracer.OpenPBRMaterial, transform?: M4, name = '') => {
    const mesh = new mt.Mesh(geometry(raw), material);
    mesh.name = name;
    if (transform) for (let k = 0; k < 16; k++) mesh.transform[k] = transform[k];
    meshes.push(mesh);
    return mesh;
  };
  const place = (mesh: MuTracer.Mesh, transform: M4) => { for (let k = 0; k < 16; k++) mesh.transform[k] = transform[k]; };
  const texture = (image: ReturnType<typeof pixels>, metresPerTile: number) => {
    const map = new mt.Texture(image);
    map.uvScale = [1 / metresPerTile, 1 / metresPerTile];
    return map;
  };
  const material = (name: string, params: MuTracer.OpenPBRMaterialParams) =>
    Object.assign(new mt.OpenPBRMaterial(params), {name});

  // Textures: fine periodic detail that shows smearing.
  const wallpaper = texture(pixels(64, 4, x => x < 3 ? [92, 74, 58] : x < 30 ? [214, 200, 172] : x < 34 ? [128, 150, 120] : [196, 210, 186]), .16);
  const tiles = texture(pixels(64, 64, (x, y) => {
    if (x % 32 < 2 || y % 32 < 2) return [70, 66, 60];
    return (x < 32) !== (y < 32) ? [225, 220, 206] : [52, 56, 62];
  }), .6);
  const random = rng(7);
  const grain = Array.from({length: 128}, () => random());
  const wood = texture(pixels(128, 8, x => {
    const g = .75 + .25 * Math.sin(x * .9 + 4 * grain[x]) * grain[(x * 7) % 128];
    return [Math.round(120 * g), Math.round(72 * g), Math.round(40 * g)];
  }), .5);
  const ballStripes = new mt.Texture(pixels(64, 4, x => [[230, 60, 40], [245, 215, 60], [40, 110, 210], [240, 240, 235]][x >> 4] as V3));

  // Materials.
  const plaster = material('Plaster', {baseColor: [.78, .76, .72], specularRoughness: .8});
  const paper = material('Striped wallpaper', {baseColor: [1, 1, 1], map: wallpaper, specularRoughness: .7});
  const floor = material('Ceramic floor tile', {baseColor: [1, 1, 1], map: tiles, specularRoughness: .12});
  const varnish = material('Varnished wood', {baseColor: [1, 1, 1], map: wood, specularRoughness: .45, coatWeight: 1, coatRoughness: .04});
  const darkWood = material('Dark wood', {baseColor: [.16, .09, .05], specularRoughness: .3, coatWeight: .8, coatRoughness: .08});
  const mirror = material('Mirror metal', {baseColor: [.94, .94, .94], baseMetalness: 1, specularRoughness: 0});
  const chrome = material('Chrome', {baseColor: [.9, .9, .92], baseMetalness: 1, specularRoughness: .04});
  const brass = material('Brass', {baseColor: [.95, .72, .38], baseMetalness: 1, specularRoughness: .2});
  const glass = material('Clear glass', {baseColor: [1, 1, 1], transmissionWeight: 1, specularRoughness: 0, specularIor: 1.5});
  const ceramic = material('Glazed ceramic', {baseColor: [.86, .84, .8], specularRoughness: .05});
  const vaseGlaze = material('Vase glaze', {baseColor: [.05, .35, .4], specularRoughness: .15});
  const blindPaint = material('Blind enamel', {baseColor: [.86, .85, .8], specularRoughness: .4});
  const leafGreen = material('Leaves', {baseColor: [.12, .32, .08], specularRoughness: .45});
  const terracotta = material('Terracotta', {baseColor: [.55, .25, .14], specularRoughness: .8});
  const blackPlastic = material('Black plastic', {baseColor: [.03, .03, .035], specularRoughness: .25});
  const wax = material('Candle wax', {baseColor: [.92, .9, .84], specularRoughness: .5, subsurfaceWeight: .6, subsurfaceColor: [.95, .9, .8], subsurfaceRadius: .01});
  const toyPaint = material('Toy enamel', {baseColor: [.85, .12, .1], specularRoughness: .2, coatWeight: 1, coatRoughness: .02});
  const ballPaint = material('Striped ball enamel', {baseColor: [1, 1, 1], map: ballStripes, specularRoughness: .25, coatWeight: 1, coatRoughness: .03});
  const cord = material('Black cord', {baseColor: [.05, .05, .05], specularRoughness: .6});
  // Emitters.
  const bulb = material('Pendant emission', {baseColor: [1, 1, 1], emissionColor: [1, .82, .6], emissionLuminance: 60});
  const shade = material('Lamp shade', {baseColor: [.4, .35, .3], emissionColor: [1, .72, .42], emissionLuminance: 2.5, specularRoughness: .9});
  const led = material('LED emission', {baseColor: [0, 0, 0], emissionColor: [1, 0, 0], emissionLuminance: 3});
  const screen = material('Screen emission', {baseColor: [.02, .02, .02], emissionColor: [.2, .4, 1], emissionLuminance: 3, specularRoughness: .05});
  const flame = material('Flame emission', {baseColor: [0, 0, 0], emissionColor: [1, .55, .18], emissionLuminance: 40});

  // Room: 6 × 2.8 × 5 m, window in the +X wall.
  add(box(6.2, .1, 5.2), floor, translate([0, -.05, 0]), 'floor');
  add(box(6.2, .1, 5.2), plaster, translate([0, 2.85, 0]), 'ceiling');
  add(box(6.2, 2.8, .1), paper, translate([0, 1.4, -2.55]), 'back wall');
  add(box(6.2, 2.8, .1), paper, translate([0, 1.4, 2.55]), 'front wall');
  add(box(.1, 2.8, 5.2), paper, translate([-3.05, 1.4, 0]), 'left wall');
  const windowY = [1, 2.1], windowZ = [-1.1, .2];
  add(box(.1, windowY[0], 5.2), plaster, translate([3.05, windowY[0] / 2, 0]), 'wall below window');
  add(box(.1, 2.8 - windowY[1], 5.2), plaster, translate([3.05, (2.8 + windowY[1]) / 2, 0]), 'wall above window');
  add(box(.1, windowY[1] - windowY[0], windowZ[0] + 2.6), plaster, translate([3.05, 1.55, (windowZ[0] - 2.6) / 2]), 'wall left of window');
  add(box(.1, windowY[1] - windowY[0], 2.6 - windowZ[1]), plaster, translate([3.05, 1.55, (windowZ[1] + 2.6) / 2]), 'wall right of window');
  // Skirting along the back wall.
  add(box(6, .1, .02), darkWood, translate([0, .05, -2.49]), 'skirting');

  // Blinds: thin tilted slats and two cords.
  const blinds = empty();
  for (let k = 0; k < 13; k++) append(blinds, box(.05, .003, windowZ[1] - windowZ[0] - .04), chain(translate([2.93, windowY[0] + .05 + k * .083, (windowZ[0] + windowZ[1]) / 2]), rotZ(rad(-32))));
  for (const z of [-.75, -.15]) append(blinds, cylinder(.0015, windowY[1] - windowY[0], 8), translate([2.93, windowY[0], z]));
  add(blinds, blindPaint, undefined, 'blinds');

  // Mirror on the back wall with a frame.
  add(box(2, 1.8, .02), mirror, translate([-1.3, 1.45, -2.49]), 'mirror');
  const frame = empty();
  for (const [w, h, x, y] of [[2.1, .05, -1.3, .525], [2.1, .05, -1.3, 2.375], [.05, 1.9, -2.325, 1.45], [.05, 1.9, -.275, 1.45]]) append(frame, box(w, h, .04), translate([x, y, -2.48]));
  add(frame, darkWood, undefined, 'mirror frame');

  // Cabinet and screen on the back wall.
  add(box(1.6, .6, .4), darkWood, translate([1.6, .3, -2.3]), 'cabinet');
  add(box(1.26, .76, .04), blackPlastic, translate([1.6, 1.38, -2.46]), 'screen bezel');
  add(box(1.2, .7, .01), screen, translate([1.6, 1.38, -2.435]), 'screen');
  // LED strip along the top of the back and left walls.
  const strip = empty();
  append(strip, box(5.8, .02, .02), translate([0, 2.66, -2.47]));
  append(strip, box(.02, .02, 4.8), translate([-2.97, 2.66, 0]));
  add(strip, led, undefined, 'led');

  // Table with varnished top.
  const tableTop = .77;
  add(box(1.6, .04, .9), varnish, translate([.4, tableTop - .02, -.6]), 'table');
  const legs = empty();
  for (const x of [-.32, 1.12]) for (const z of [-.98, -.22]) append(legs, box(.05, tableTop - .04, .05), translate([x, (tableTop - .04) / 2, z]));
  add(legs, darkWood, undefined, 'table legs');

  // Chair with thin spindles.
  const chair = empty();
  append(chair, box(.42, .03, .4), translate([0, .45, 0]));
  for (const x of [-.19, .19]) for (const z of [-.18, .18]) append(chair, cylinder(.014, .45, 12), translate([x, 0, z]));
  for (const x of [-.19, .19]) append(chair, cylinder(.014, .5, 12), translate([x, .45, .18]));
  append(chair, box(.42, .05, .025), translate([0, .93, .18]));
  for (let k = 0; k < 7; k++) append(chair, cylinder(.005, .45, 8), translate([-.15 + k * .05, .46, .18]));
  add(chair, darkWood, chain(translate([.45, 0, .12]), rotY(rad(8))), 'chair');

  // Table objects.
  const chromeCenter: V3 = [.15, tableTop + .16, -.6];
  add(sphere(.16, 96), chrome, translate(chromeCenter), 'chrome sphere');
  const candlestickBase: V3 = [.75, tableTop, -.75];
  add(lathe([[0, 0], [.075, 0], [.075, 0], [.075, .012], [.06, .02], [.035, .03], [.02, .05], [.013, .08], [.022, .1], [.013, .12],
    [.011, .2], [.02, .23], [.012, .25], [.012, .28], [.034, .285], [.034, .285], [.034, .3], [.034, .3], [.011, .3], [0, .3]], 96), brass, translate(candlestickBase), 'candlestick');
  add(cylinder(.011, .1, 24), wax, translate([candlestickBase[0], tableTop + .3, candlestickBase[2]]), 'candle');
  const glassBase: V3 = [-.25, tableTop, -.5];
  const flameMesh = add(sphere(.008, 16), flame, undefined, 'flame');
  add(lathe([[0, 0], [.04, 0], [.04, 0], [.046, .13], [.046, .13], [.042, .13], [.042, .13], [.036, .014], [.036, .014], [0, .014]], 96), glass, translate(glassBase), 'glass');
  const vaseProfile: [number, number][] = [[0, 0], [.05, 0], [.05, 0], [.075, .06], [.07, .12], [.035, .2], [.03, .24], [.038, .26], [.038, .26], [.03, .26], [.03, .26], [.022, .2], [0, .2]];
  add(lathe(vaseProfile, 64), vaseGlaze, translate([1, tableTop, -.52]), 'vase');
  add(lathe([[0, 0], [.05, 0], [.05, 0], [.1, .04], [.12, .08], [.12, .08], [.11, .08], [.11, .08], [.09, .045], [0, .03]], 64), ceramic, translate([.45, tableTop, -.98]), 'bowl');
  const toy = add(box(.09, .07, .09), toyPaint, undefined, 'toy block');

  // Floor lamp in the back-left corner: emissive shade around a small sphere light.
  const lampBase: V3 = [-2.5, 0, -2];
  const lamp = empty();
  append(lamp, lathe([[0, 0], [.16, 0], [.16, 0], [.16, .02], [.02, .04], [0, .04]], 48));
  append(lamp, cylinder(.012, 1.45, 16));
  add(lamp, blackPlastic, translate(lampBase), 'lamp stand');
  add(lathe([[.2, 0], [.12, .26], [.12, .26], [.115, .26], [.115, .26], [.195, 0]], 64), shade, translate([lampBase[0], 1.36, lampBase[2]]), 'lamp shade');
  const lampLight = new mt.SphereLight({color: [1, .78, .5], intensity: 50, radius: .045});
  lampLight.position = [lampBase[0], 1.5, lampBase[2]];

  // Pendant bulbs above the table; the middle one sways.
  const pendant = (length: number) => {
    const raw = empty();
    append(raw, cylinder(.002, length, 6), translate([0, -length, 0]));
    append(raw, lathe([[0, 0], [.03, 0], [.03, -.03], [0, -.03]], 24), translate([0, -length, 0]));
    return raw;
  };
  const pendants: {mesh: MuTracer.Mesh; bulb: MuTracer.Mesh; pivot: V3; length: number}[] = [];
  for (const [x, length] of [[-.05, .85], [.4, .95], [.85, .8]] as [number, number][]) {
    const pivot: V3 = [x, 2.8, -.6];
    const number = pendants.length + 1;
    const mesh = add(pendant(length), blackPlastic, undefined, `pendant fixture ${number}`);
    const light = add(sphere(.035, 24), bulb, undefined, `pendant bulb ${number}`);
    pendants.push({mesh, bulb: light, pivot, length});
  }

  // Plant in the corner beside the window.
  const plantBase: V3 = [2.5, 0, -1.65];
  add(lathe([[0, 0], [.12, 0], [.12, 0], [.16, .34], [.16, .34], [.145, .34], [.145, .34], [.13, .3], [0, .3]], 48), terracotta, translate(plantBase), 'plant pot');
  const plant = empty();
  const plantRandom = rng(11);
  for (let stem = 0; stem < 5; stem++) {
    const height = .55 + .45 * plantRandom(), lean = .25 * (plantRandom() - .5), yaw = 2 * Math.PI * stem / 5;
    append(plant, cylinder(.004, height, 6), chain(rotY(yaw), rotZ(lean)));
    for (let k = 0; k < 7; k++) {
      const v = .35 + .65 * k / 6, angle = yaw + k * 2.4 + plantRandom();
      const at = chain(rotY(yaw), rotZ(lean), translate([0, v * height, 0]), rotY(angle), rotX(rad(-50 - 25 * plantRandom())));
      append(plant, leaf(.12 + .08 * plantRandom(), .05 + .03 * plantRandom()), at);
    }
  }
  const plantMesh = add(plant, leafGreen, undefined, 'plant');

  // Moving props: a pendulum behind the camera that appears in the mirror,
  // and a ball that rolls through the frame during the slow pan.
  const pendulumPivot: V3 = [-1.15, 2.8, 1.9];
  const pendulumRaw = empty();
  append(pendulumRaw, cylinder(.003, 1.25, 6), translate([0, -1.25, 0]));
  const pendulumCord = add(pendulumRaw, cord, undefined, 'pendulum cord');
  const pendulumBall = add(sphere(.28, 48), ballPaint, undefined, 'pendulum ball');
  const rollRadius = .14;
  const rolling = add(sphere(rollRadius, 48), ballPaint, undefined, 'rolling ball');

  const sun = new mt.DirectionalLight({color: [1, .9, .75], intensity: 14});
  sun.position = [6, 4.2, .5];
  sun.lookAt([2, 1.4, -.4]);
  const sky = new mt.AmbientLight({color: [.55, .7, 1], intensity: .9});

  const camera = new mt.Camera({projection: 'perspective', fov: 50, near: .02, far: 50});
  const scene: MuTracer.Scene = {meshes, lights: [sun, sky, lampLight]};

  const screenColors: V3[] = [[.2, .4, 1], [1, .25, .6], [.25, 1, .4], [1, .6, .15], [.9, .9, 1]];
  const look = (yaw: number, pitch: number): V3 => [Math.sin(rad(yaw)) * Math.cos(rad(pitch)), Math.sin(rad(pitch)), -Math.cos(rad(yaw)) * Math.cos(rad(pitch))];
  const add3 = (a: V3, b: V3, s = 1): V3 => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
  const orbitPose = (azimuth: number): V3 => {
    const r = 1.1, e = rad(18), a = rad(azimuth);
    return [chromeCenter[0] + r * Math.sin(a) * Math.cos(e), chromeCenter[1] + r * Math.sin(e), chromeCenter[2] + r * Math.cos(a) * Math.cos(e)];
  };

  function setCamera(t: number, depthOfField: boolean) {
    let position: V3, target: V3, fov = 50, fStop = 0, focus = 3;
    const p1: V3 = [-1, 1.45, .9], p2: V3 = [-1.4, 1.5, 1.4], p4: V3 = [-1.25, 1.42, -.9];
    if (t < cut) {
      // Mirror view, slow pan to the window, whip back to the mirror, dolly in.
      const yaw = t < 3.5 ? mix(-4, 68, smooth(1.5, 3.5, t)) : mix(68, -3, smooth(3.5, 4, t));
      const pitch = t < 3.5 ? mix(-2, -6, smooth(1.5, 3.5, t)) : mix(-6, -1, smooth(3.5, 4, t));
      position = t < 4 ? mix3(p1, p2, smooth(1.5, 3.5, t)) : mix3(p2, p4, smooth(4, 5.8, t));
      target = add3(position, look(yaw, pitch), 3);
      focus = 3;
    } else {
      // Orbit the chrome sphere, then settle into a close shot with a focus pull.
      const orbit = orbitPose(mix(-50, 70, smooth(cut, 8.2, t) * .5 + clamp((t - cut) / (8.2 - cut)) * .5));
      const close: V3 = [1.1, .98, .1], closeTarget: V3 = [.4, .9, -.62];
      const settle = smooth(8.2, 8.8, t);
      position = mix3(orbit, close, settle);
      target = mix3(chromeCenter, closeTarget, settle);
      fov = mix(50, 30, settle);
      if (depthOfField && t >= 8.2) fStop = 1;
      const direction = add3(target, position, -1), length = Math.hypot(...direction);
      const distance = (p: V3) => ((p[0] - position[0]) * direction[0] + (p[1] - position[1]) * direction[1] + (p[2] - position[2]) * direction[2]) / length;
      const nearFocus = distance([candlestickBase[0], tableTop + .2, candlestickBase[2]]);
      const farFocus = distance([glassBase[0], tableTop + .07, glassBase[2]]);
      focus = mix(nearFocus, farFocus, smooth(8.9, 9.6, t));
    }
    camera.position = position;
    camera.lookAt(target);
    camera.fov = fov;
    camera.fStop = fStop;
    camera.focusDistance = focus;
    camera.sensorHeight = 24;
  }

  function setTime(t: number, options: {depthOfField?: boolean} = {}) {
    setCamera(t, options.depthOfField ?? true);

    // Emitters: screen slides change abruptly, the LED hue drifts, the candle
    // flickers and the lamp dims during the orbit.
    const slide = Math.floor(t / 1.25) % screenColors.length;
    screen.emissionColor = screenColors[slide];
    screen.emissionLuminance = slide === 4 ? 4.5 : 3;
    led.emissionColor = hsv((t / 10) % 1, .85, 1);
    const flicker = .8 + .12 * Math.sin(t * 23) + .08 * Math.sin(t * 37 + 1.3);
    flame.emissionLuminance = 40 * flicker;
    place(flameMesh, chain(translate([candlestickBase[0] + .002 * Math.sin(t * 17), tableTop + .412, candlestickBase[2]]), scale([1, 2.2 + .3 * Math.sin(t * 29), 1])));
    const dim = 1 - .97 * (smooth(7, 7.4, t) - smooth(9, 9.4, t));
    lampLight.intensity = 50 * dim;
    shade.emissionLuminance = 2.5 * dim;

    // Material edits during the orbit: an abrupt glaze color and a roughness ramp.
    vaseGlaze.baseColor = t < 6.5 ? [.05, .35, .4] : [.8, .3, .06];
    ceramic.specularRoughness = mix(.05, .6, smooth(cut, 8.2, t));

    // Rigid motion.
    for (const [k, p] of pendants.entries()) {
      const swing = k === 1 ? rad(9) * Math.sin(2 * Math.PI * t / 2.6) : 0;
      const m = chain(translate(p.pivot), rotX(swing));
      place(p.mesh, m);
      place(p.bulb, chain(m, translate([0, -p.length - .055, 0])));
    }
    const swing = rad(26) * Math.sin(2 * Math.PI * t / 2.2);
    const pendulum = chain(translate(pendulumPivot), rotZ(swing));
    place(pendulumCord, pendulum);
    place(pendulumBall, chain(pendulum, translate([0, -1.53, 0]), rotY(t * 2.4)));
    const rollX = mix(2.7, -2.7, clamp((t - 1.6) / 2));
    place(rolling, chain(translate([rollX, rollRadius, .25]), rotZ((2.7 - rollX) / rollRadius)));
    const toyX = mix(-.35, 1.15, smooth(6.2, 7.8, t));
    place(toy, chain(translate([toyX, tableTop + .035, -.28]), rotY(2.5 * (toyX + .35))));
    place(plantMesh, chain(translate(plantBase), translate([0, .32, 0]), rotZ(rad(1.5) * Math.sin(t * 1.7)), rotX(rad(1) * Math.sin(t * 1.3))));
  }

  const frameCount = Math.ceil(duration * fps);
  setTime(0);
  return {scene, camera, frameCount, cutFrame: Math.ceil(cut * fps), setTime};
}
