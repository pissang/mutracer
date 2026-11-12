import * as THREE from 'three';
import type { LoadedModel } from './loadModel';

/** A profile vertex in the (radius, height) half-plane with its outward normal. */
interface ProfilePoint { r: number; y: number; nr: number; ny: number }
/** `fillet` rounds a corner; without it the vertex is a sample of a smooth curve. */
interface Knot { r: number; y: number; fillet?: number }

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
/** Longest edge along a profile and around the equator, so displacement has vertices to move. */
const MAX_EDGE = 0.025;

/**
 * Expands knots into a profile running counter-clockwise around the solid, so
 * that the outward normal is on the right of the direction of travel. Corners
 * become tangent arcs with exact normals and straight runs are subdivided;
 * nothing is left as a hard edge, which displacement would tear. An open
 * profile starts and ends on the axis; a `loop` is a ring's cross-section and
 * repeats its first point at the end.
 */
export function buildProfile(knots: Knot[], loop = false): ProfilePoint[] {
  const points: (Omit<ProfilePoint, 'nr' | 'ny'> & { nr?: number; ny?: number })[] = [];
  const knot = (i: number) => loop ? knots[(i + knots.length) % knots.length] : knots[i];
  knots.forEach((corner, i) => {
    const prev = knot(i - 1), next = knot(i + 1);
    if (!corner.fillet || !prev || !next) return void points.push({ r: corner.r, y: corner.y });
    const inLength = Math.hypot(corner.r - prev.r, corner.y - prev.y), outLength = Math.hypot(next.r - corner.r, next.y - corner.y);
    const inDir = [(corner.r - prev.r) / inLength, (corner.y - prev.y) / inLength];
    const outDir = [(next.r - corner.r) / outLength, (next.y - corner.y) / outLength];
    // Left turns are convex: the arc's centre lies inside the solid.
    const turn = Math.atan2(inDir[0] * outDir[1] - inDir[1] * outDir[0], inDir[0] * outDir[0] + inDir[1] * outDir[1]);
    const reach = corner.fillet * Math.tan(Math.abs(turn) / 2);
    if (reach > Math.min(inLength, outLength)) throw new Error('Fillet does not fit its corner');
    const side = Math.sign(turn);
    const normal = [inDir[1], -inDir[0]];
    const centre = [corner.r - inDir[0] * reach - side * corner.fillet * normal[0], corner.y - inDir[1] * reach - side * corner.fillet * normal[1]];
    const steps = Math.max(3, Math.ceil(Math.abs(turn) / (10 * DEG)));
    for (let step = 0; step <= steps; step++) {
      const angle = (turn * step) / steps, cos = Math.cos(angle), sin = Math.sin(angle);
      const nr = normal[0] * cos - normal[1] * sin, ny = normal[0] * sin + normal[1] * cos;
      points.push({ r: centre[0] + side * corner.fillet * nr, y: centre[1] + side * corner.fillet * ny, nr, ny });
    }
  });
  const count = points.length;
  const edgeNormal = (a: number, b: number) => {
    const from = points[(a + count) % count], to = points[b % count];
    const dr = to.r - from.r, dy = to.y - from.y, length = Math.hypot(dr, dy);
    return [dy / length, -dr / length];
  };
  const resolved = points.map((point, i): ProfilePoint => {
    if (point.nr !== undefined) return point as ProfilePoint;
    const end = !loop && (i === 0 || i === count - 1);
    const before = loop || i > 0 ? edgeNormal(i - 1, i) : edgeNormal(i, i + 1);
    const after = loop || i < count - 1 ? edgeNormal(i, i + 1) : before;
    // An open profile's ends sit on the axis, where the surface is level.
    const nr = end ? 0 : before[0] + after[0], ny = before[1] + after[1], length = Math.hypot(nr, ny);
    return { r: point.r, y: point.y, nr: nr / length, ny: ny / length };
  });
  if (loop) resolved.push(resolved[0]);
  const profile: ProfilePoint[] = [];
  resolved.forEach((point, i) => {
    const next = resolved[i + 1];
    profile.push(point);
    if (!next) return;
    const pieces = Math.ceil(Math.hypot(next.r - point.r, next.y - point.y) / MAX_EDGE);
    for (let piece = 1; piece < pieces; piece++) {
      const t = piece / pieces;
      const nr = point.nr + (next.nr - point.nr) * t, ny = point.ny + (next.ny - point.ny) * t, length = Math.hypot(nr, ny);
      profile.push({ r: point.r + (next.r - point.r) * t, y: point.y + (next.y - point.y) * t, nr: nr / length, ny: ny / length });
    }
  });
  return profile;
}

/** Samples of `radius(latitude)` around a centre on the axis; `step` is in degrees and may vary with latitude. */
function ballArc(centre: number, from: number, to: number, radius: (latitude: number) => number, step: (latitude: number) => number = () => 1): Knot[] {
  const knots: Knot[] = [];
  const direction = Math.sign(to - from);
  // The poles lie exactly on the axis.
  const at = (latitude: number): Knot => {
    const r = radius(latitude) * Math.cos(latitude);
    return { r: r < 1e-9 ? 0 : r, y: centre + radius(latitude) * Math.sin(latitude) };
  };
  for (let latitude = from;;) {
    knots.push(at(latitude));
    const stride = Math.min(step(latitude), step(latitude + direction * DEG)) * DEG;
    // The last step stretches so that no sliver is left before the end.
    if ((to - latitude) * direction < 1.6 * stride) break;
    latitude += direction * stride;
  }
  knots.push(at(to));
  return knots;
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

interface RevolveOptions {
  /** Columns around the axis; by default as many as keep the widest edge short. */
  columns?: number;
  /** Offset along the normal at an azimuth and profile position, for detail that does not revolve. */
  relief?: (azimuth: number, r: number, y: number) => number;
}

/**
 * Revolves a profile around Y. UVs follow the sphere convention the samples
 * are tuned for: U is the azimuth over a full turn and V is the distance along
 * the profile over a half turn of a unit sphere.
 */
function revolve(profile: ProfilePoint[], { columns = Math.ceil(TAU * Math.max(...profile.map((p) => p.r)) / MAX_EDGE), relief }: RevolveOptions = {}): THREE.BufferGeometry {
  const rows = profile.length, stride = columns + 1;
  const positions = new Float32Array(rows * stride * 3), normals = new Float32Array(rows * stride * 3), uvs = new Float32Array(rows * stride * 2);
  const indices: number[] = [];
  let length = 0;
  profile.forEach((point, row) => {
    if (row > 0) length += Math.hypot(point.r - profile[row - 1].r, point.y - profile[row - 1].y);
    for (let column = 0; column <= columns; column++) {
      // The seam repeats the first column's positions exactly, with U = 1.
      const angle = (TAU * (column % columns)) / columns, sin = Math.sin(angle), cos = Math.cos(angle);
      const offset = relief && point.r > 0 ? relief(angle, point.r, point.y) : 0;
      const r = point.r + point.nr * offset, i = row * stride + column;
      positions.set([r * sin, point.y + point.ny * offset, r * cos], i * 3);
      normals.set([point.nr * sin, point.ny, point.nr * cos], i * 3);
      uvs.set([column / columns, length / Math.PI], i * 2);
    }
  });
  if (relief) {
    // Relief bends the surface away from the profile's normals: take them from the grid.
    const at = (row: number, column: number) => new THREE.Vector3().fromArray(positions, (row * stride + (column + columns) % columns) * 3);
    for (let row = 1; row < rows - 1; row++) {
      for (let column = 0; column <= columns; column++) {
        const around = at(row, column + 1).sub(at(row, column - 1)), along = at(row + 1, column).sub(at(row - 1, column));
        around.cross(along).normalize().toArray(normals, (row * stride + column) * 3);
      }
    }
  }
  for (let row = 0; row < rows - 1; row++) {
    for (let column = 0; column < columns; column++) {
      const a = row * stride + column, b = a + stride;
      if (profile[row].r > 0) indices.push(a, a + 1, b);
      if (profile[row + 1].r > 0) indices.push(a + 1, b + 1, b);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  return geometry;
}

const BASE = { radius: 1.38, height: 0.08 };
/** The parts rest on each other across a hair of air instead of sharing a face. */
const GAP = 0.002;
const SHELL = { outer: 1, inner: 0.86 };
/** Height of the ball's centre: it sits 0.04 deep in the cradle's socket. */
const BALL_Y = BASE.height + GAP + 0.04 + SHELL.outer;
/** The shell's axis runs through its port, up and to the right of the default view. */
const PORT_AXIS = new THREE.Vector3(Math.cos(40 * DEG) * Math.sin(66 * DEG), Math.sin(40 * DEG), Math.cos(40 * DEG) * Math.cos(66 * DEG));
const VIEW = new THREE.Vector3(2.4, 1.3, 6.1).normalize();

/**
 * The shell's outside by latitude from its own axis. Below the bezel it is a
 * plain sphere with one fine line; the bezel carries a fluted band and two
 * grooves, then rises into the collar around the port.
 */
const PORT = 47 * DEG;
const FLUTES = { from: 27 * DEG, to: 35.5 * DEG, count: 48, depth: 0.024 };
const GROOVES = { latitudes: [38.2 * DEG, 40.2 * DEG], halfWidth: 0.55 * DEG, depth: 0.014 };
const LINE = { latitude: 14 * DEG, halfWidth: 0.5 * DEG, depth: 0.012 };
function shellRadius(latitude: number) {
  let radius = SHELL.outer + 0.03 * smoothstep(23 * DEG, 24.5 * DEG, latitude) + 0.025 * smoothstep(42 * DEG, 44 * DEG, latitude);
  for (const groove of GROOVES.latitudes) radius -= GROOVES.depth * (1 - smoothstep(0.4, 1, Math.abs(latitude - groove) / GROOVES.halfWidth));
  return radius - LINE.depth * (1 - smoothstep(0.4, 1, Math.abs(latitude - LINE.latitude) / LINE.halfWidth));
}
/** Rows are fine where the radius changes quickly; the flutes only vary around the axis. */
const shellStep = (latitude: number) => {
  const degrees = latitude / DEG;
  return degrees > 22.5 && degrees < 28.2 || degrees > 34.3 && degrees < 44.5 || Math.abs(latitude - LINE.latitude) < LINE.halfWidth ? 0.15 : 1;
};
function flutes(azimuth: number, r: number, y: number) {
  // Only the outside is fluted.
  if (Math.hypot(r, y) < SHELL.outer) return 0;
  const latitude = Math.atan2(y, r);
  const band = smoothstep(FLUTES.from, FLUTES.from + DEG, latitude) * (1 - smoothstep(FLUTES.to - DEG, FLUTES.to, latitude));
  return band ? -FLUTES.depth * band * (0.5 - 0.5 * Math.cos(FLUTES.count * azimuth)) : 0;
}

/** A hollow ball open at a round port, with a full-round lip joining its two sides. */
function shellGeometry() {
  const collar = shellRadius(PORT), lip = (collar - SHELL.inner) / 2, middle = SHELL.inner + lip;
  const rim: Knot[] = [];
  for (let angle = 10 * DEG; angle < 179 * DEG; angle += 10 * DEG) {
    const reach = middle + lip * Math.cos(angle), latitude = PORT + (lip * Math.sin(angle)) / middle;
    rim.push({ r: reach * Math.cos(latitude), y: reach * Math.sin(latitude) });
  }
  const profile = buildProfile([
    ...ballArc(0, -90 * DEG, PORT, shellRadius, shellStep), ...rim, ...ballArc(0, PORT, -90 * DEG, () => SHELL.inner, () => 1.6)
  ]);
  const geometry = revolve(profile, { columns: 432, relief: flutes });
  // Turn the UV seam away from the default view before tilting the port into place.
  const tilt = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), PORT_AXIS);
  const hidden = VIEW.clone().negate().applyQuaternion(tilt.clone().invert());
  const turn = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(hidden.x, hidden.z));
  return geometry.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(0, BALL_Y, 0), tilt.multiply(turn), new THREE.Vector3(1, 1, 1)));
}

/** A low ring with a sloped face and a socket that seats the ball. */
function cradleProfile() {
  const foot = BASE.height + GAP, top = foot + 0.2, socket = SHELL.outer + GAP;
  const edge = Math.asin((top - BALL_Y) / socket), bore = -Math.acos(0.3 / socket);
  return buildProfile([
    { r: 0.86, y: foot, fillet: 0.012 }, { r: 0.66, y: top, fillet: 0.02 },
    { r: socket * Math.cos(edge), y: top, fillet: 0.008 },
    ...ballArc(BALL_Y, edge, bore, () => socket).slice(1, -1),
    { r: 0.3, y: BALL_Y + socket * Math.sin(bore), fillet: 0.01 }, { r: 0.3, y: foot, fillet: 0.01 }
  ], true);
}

const baseProfile = () => buildProfile([
  { r: 0, y: 0 }, { r: BASE.radius, y: 0, fillet: 0.006 }, { r: BASE.radius, y: BASE.height, fillet: 0.02 }, { r: 0, y: BASE.height }
]);

/** A dial on the base's top: rings every 0.1 and ticks every 5°, a reference for refraction, reflections and scale. */
function baseTexture(profile: ProfilePoint[]) {
  const width = 2048, height = 1024, data = new Uint8Array(width * height * 4);
  // Radius along the top face for each texture row; the side and underside stay plain.
  const radii = new Float32Array(height).fill(-1);
  let length = 0;
  for (let i = 1; i < profile.length; i++) {
    const from = profile[i - 1], to = profile[i], next = length + Math.hypot(to.r - from.r, to.y - from.y);
    if (from.ny > 0.99 && to.ny > 0.99) {
      for (let row = Math.ceil((length / Math.PI) * height - 0.5); (row + 0.5) / height * Math.PI < next; row++) {
        radii[row] = from.r + (to.r - from.r) * (((row + 0.5) / height * Math.PI - length) / (next - length));
      }
    }
    length = next;
  }
  const line = (distance: number, halfWidth: number, pixel: number) => Math.min(1, Math.max(0, 0.5 + (halfWidth - distance) / pixel));
  const periodic = (value: number, period: number) => Math.abs(value - Math.round(value / period) * period);
  for (let row = 0; row < height; row++) {
    const radius = radii[row];
    for (let column = 0; column < width; column++) {
      let shade = 0.2;
      if (radius >= 0) {
        const degrees = ((column + 0.5) / width) * 360, arc = radius * DEG, pixel = Math.PI / height;
        const sector = (Math.floor(degrees / 15) + Math.floor(radius / 0.2)) % 2;
        const ticks = radius > 1.24 && radius < 1.3 ? line(periodic(degrees, 5) * arc, 0.004, (TAU * radius) / width) : 0;
        const spokes = radius > 1.1 && radius < 1.3 ? line(periodic(degrees, 15) * arc, 0.006, (TAU * radius) / width) : 0;
        const rings = Math.max(line(periodic(radius, 0.1), 0.003, pixel), line(periodic(radius, 0.5), 0.007, pixel));
        shade = (sector ? 0.17 : 0.215) + 0.42 * Math.max(ticks, spokes, rings);
      }
      data.set([shade * 255, shade * 258, shade * 268, 255], (row * width + column) * 4);
    }
  }
  const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.magFilter = texture.minFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Material test model. One material covers a hollow ball and the cradle it
 * sits in. The ball is open at a round port that shows its wall thickness and
 * a core in a second material; around the port it carries flutes, grooves and
 * a collar, and the rest is plain curvature. Every part is a closed solid
 * without hard edges, in one object space, so position-based graphs line up
 * across parts and displacement does not tear.
 */
export function createShaderBall(): LoadedModel {
  const material = new THREE.MeshPhysicalMaterial({ color: 0xd9dadd, roughness: 0.28 });
  material.name = 'Material';
  const coreMaterial = new THREE.MeshPhysicalMaterial({ color: 0xffc35a, metalness: 1, roughness: 0.25 });
  coreMaterial.name = 'Core';
  const base = baseProfile();
  const baseMaterial = new THREE.MeshPhysicalMaterial({ map: baseTexture(base), roughness: 0.45 });
  baseMaterial.name = 'Base';

  const root = new THREE.Group();
  root.name = 'Shader ball';
  const add = (name: string, geometry: THREE.BufferGeometry, surface: THREE.Material) => {
    const mesh = new THREE.Mesh(geometry, surface);
    mesh.name = name;
    root.add(mesh);
  };
  add('Shell', shellGeometry(), material);
  add('Cradle', revolve(cradleProfile()), material);
  add('Core', revolve(buildProfile(ballArc(BALL_Y, -90 * DEG, 90 * DEG, () => 0.62, () => 1.5))), coreMaterial);
  add('Base', revolve(base, { columns: 192 }), baseMaterial);
  return { name: 'Shader ball', root, animations: [], revoke() {} };
}
