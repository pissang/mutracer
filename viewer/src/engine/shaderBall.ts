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
  /** Moves a profile point at an azimuth, for shapes and detail that do not revolve. */
  warp?: (azimuth: number, point: ProfilePoint) => [r: number, y: number];
}

/**
 * Revolves a profile around Y. UVs follow the sphere convention the samples
 * are tuned for: U is the azimuth over a full turn and V is the distance along
 * the profile over a half turn of a unit sphere.
 */
function revolve(profile: ProfilePoint[], { columns = Math.ceil(TAU * Math.max(...profile.map((p) => p.r)) / MAX_EDGE), warp }: RevolveOptions = {}): THREE.BufferGeometry {
  const rows = profile.length, stride = columns + 1;
  const positions = new Float32Array(rows * stride * 3), normals = new Float32Array(rows * stride * 3), uvs = new Float32Array(rows * stride * 2);
  const indices: number[] = [];
  let length = 0;
  profile.forEach((point, row) => {
    if (row > 0) length += Math.hypot(point.r - profile[row - 1].r, point.y - profile[row - 1].y);
    for (let column = 0; column <= columns; column++) {
      // The seam repeats the first column's positions exactly, with U = 1.
      const angle = (TAU * (column % columns)) / columns, sin = Math.sin(angle), cos = Math.cos(angle);
      const [r, y] = warp ? warp(angle, point) : [point.r, point.y];
      const i = row * stride + column;
      positions.set([r * sin, y, r * cos], i * 3);
      normals.set([point.nr * sin, point.ny, point.nr * cos], i * 3);
      uvs.set([column / columns, length / Math.PI], i * 2);
    }
  });
  if (warp) {
    // A warp bends the surface away from the profile's normals: take them from the grid.
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

/** `material` names the part's material; parts that share a name share the material. */
interface Part { name: string; geometry: THREE.BufferGeometry; material: string }

const BASE_HEIGHT = 0.08;
/** The parts rest on each other across a hair of air instead of sharing a face. */
const GAP = 0.002;
const FLOOR = BASE_HEIGHT + GAP;
/** The dial texture spans this radius. */
const DIAL_RADIUS = 2;

/** A low disc whose top maps the dial by radius; its rim and underside stay plain. */
function baseGeometry(radius: number) {
  const geometry = revolve(buildProfile([
    { r: 0, y: 0 }, { r: radius, y: 0, fillet: 0.006 }, { r: radius, y: BASE_HEIGHT, fillet: 0.02 }, { r: 0, y: BASE_HEIGHT }
  ]), { columns: 192 });
  const position = geometry.getAttribute('position'), normal = geometry.getAttribute('normal'), uv = geometry.getAttribute('uv');
  for (let i = 0; i < uv.count; i++) {
    uv.setY(i, normal.getY(i) > 0.99 ? Math.hypot(position.getX(i), position.getZ(i)) / DIAL_RADIUS : 1);
  }
  return geometry;
}

/** A polar grid, rings every 0.1 and spokes every 15°: a reference for refraction, reflections and scale. */
function dialTexture() {
  const width = 2048, height = 512, data = new Uint8Array(width * height * 4);
  const line = (distance: number, halfWidth: number, pixel: number) => Math.min(1, Math.max(0, 0.5 + (halfWidth - distance) / pixel));
  const periodic = (value: number, period: number) => Math.abs(value - Math.round(value / period) * period);
  for (let row = 0; row < height; row++) {
    const radius = ((row + 0.5) / height) * DIAL_RADIUS, pixel = DIAL_RADIUS / height;
    for (let column = 0; column < width; column++) {
      let shade = 0.2;
      if (row < height - 4) {
        const degrees = ((column + 0.5) / width) * 360;
        const sector = (Math.floor(degrees / 15) + Math.floor(radius / 0.2)) % 2;
        const spokes = radius > 0.3 ? line(periodic(degrees, 15) * radius * DEG, 0.003, (TAU * radius) / width) : 0;
        const rings = Math.max(line(periodic(radius, 0.1), 0.003, pixel), line(periodic(radius, 0.5), 0.007, pixel));
        shade = (sector ? 0.17 : 0.215) + 0.42 * Math.max(spokes, rings);
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

const SHELL = { outer: 1, inner: 0.86 };
/** Height of the ball's centre: it sits 0.04 deep in the cradle's socket. */
const BALL_Y = FLOOR + 0.04 + SHELL.outer;
/** The shell's axis runs through its port, up and to the right of the default view. */
const PORT_AXIS = new THREE.Vector3(Math.cos(40 * DEG) * Math.sin(66 * DEG), Math.sin(40 * DEG), Math.cos(40 * DEG) * Math.cos(66 * DEG));
const VIEW = new THREE.Vector3(2.4, 1.3, 6.1).normalize();

/** The port's edge and one fine parting line, by latitude from the shell's own axis. */
const PORT = 46 * DEG;
const LINE = { latitude: 22 * DEG, halfWidth: 0.5 * DEG, depth: 0.012 };
const shellRadius = (latitude: number) => SHELL.outer - LINE.depth * (1 - smoothstep(0.4, 1, Math.abs(latitude - LINE.latitude) / LINE.halfWidth));

/** A hollow ball open at a round port, with a full-round lip joining its two sides. */
function shellGeometry() {
  const lip = (SHELL.outer - SHELL.inner) / 2, middle = SHELL.inner + lip;
  const rim: Knot[] = [];
  for (let angle = 10 * DEG; angle < 179 * DEG; angle += 10 * DEG) {
    const reach = middle + lip * Math.cos(angle), latitude = PORT + (lip * Math.sin(angle)) / middle;
    rim.push({ r: reach * Math.cos(latitude), y: reach * Math.sin(latitude) });
  }
  const geometry = revolve(buildProfile([
    ...ballArc(0, -90 * DEG, PORT, shellRadius, (latitude) => Math.abs(latitude - LINE.latitude) < LINE.halfWidth ? 0.15 : 1),
    ...rim, ...ballArc(0, PORT, -90 * DEG, () => SHELL.inner, () => 1.6)
  ]));
  // Turn the UV seam away from the default view before tilting the port into place.
  const tilt = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), PORT_AXIS);
  const hidden = VIEW.clone().negate().applyQuaternion(tilt.clone().invert());
  const turn = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(hidden.x, hidden.z));
  return geometry.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(0, BALL_Y, 0), tilt.multiply(turn), new THREE.Vector3(1, 1, 1)));
}

/** A low ring with a sloped face and a socket that seats the ball. */
function cradleProfile() {
  const top = FLOOR + 0.2, socket = SHELL.outer + GAP;
  const edge = Math.asin((top - BALL_Y) / socket), bore = -Math.acos(0.3 / socket);
  return buildProfile([
    { r: 0.86, y: FLOOR, fillet: 0.012 }, { r: 0.66, y: top, fillet: 0.02 },
    { r: socket * Math.cos(edge), y: top, fillet: 0.008 },
    ...ballArc(BALL_Y, edge, bore, () => socket).slice(1, -1),
    { r: 0.3, y: BALL_Y + socket * Math.sin(bore), fillet: 0.01 }, { r: 0.3, y: FLOOR, fillet: 0.01 }
  ], true);
}

/**
 * A hollow ball in a cradle, open at a round port that shows its wall
 * thickness and a core in a second material.
 */
function ball(baseRadius: number, material: string): Part[] {
  return [
    { name: 'Shell', geometry: shellGeometry(), material },
    { name: 'Cradle', geometry: revolve(cradleProfile()), material },
    { name: 'Core', geometry: revolve(buildProfile(ballArc(BALL_Y, -90 * DEG, 90 * DEG, () => 0.62, () => 1.5))), material: 'Core' },
    { name: 'Base', geometry: baseGeometry(baseRadius), material: 'Base' }
  ];
}

/**
 * A cube with crisp, slightly rounded edges, cut into panels: each face has a
 * recessed centre and two channels crossing it. The six faces share one
 * lattice, with lines gathered at every step, so the walls stay steep and the
 * solid stays closed. UVs are planar on each face.
 */
function cube(baseRadius: number, material: string): Part[] {
  const half = 0.6, round = 0.03, wall = 0.004, soften = 0.008;
  // The channels run over the rounded edges, so they stay shallower than the rounding.
  const panel = { edge: 0.4, depth: 0.02 }, channel = { edge: 0.035, depth: 0.026 };
  const marks = [0, half - round, half];
  for (const edge of [channel.edge, panel.edge]) marks.push(edge - wall - soften, edge - wall, edge + wall, edge + wall + soften);
  for (let step = 1; step < 4; step++) marks.push(half - round + round * Math.tan((45 * DEG * step) / 4));
  marks.sort((x, y) => x - y);
  const lines: number[] = [];
  marks.forEach((mark, i) => {
    const pieces = i ? Math.ceil((mark - marks[i - 1]) / 0.02) : 1;
    for (let piece = 1; piece <= pieces; piece++) lines.push(i ? marks[i - 1] + ((mark - marks[i - 1]) * piece) / pieces : 0);
  });
  lines[lines.length - 1] = half;
  const lattice = [...lines.slice(1).reverse().map((value) => -value), ...lines];

  const ramp = (inside: number) => Math.min(1, Math.max(0, inside / (2 * wall) + 0.5));
  /** How far the surface sinks at a point on the cube. */
  const depth = (point: number[]) => {
    const [low, middle] = point.map(Math.abs).sort((x, y) => x - y);
    return Math.max(panel.depth * ramp(panel.edge - middle), channel.depth * ramp(channel.edge - low));
  };
  const positions: number[] = [], normals: number[] = [], uvs: number[] = [], indices: number[] = [];
  const count = lattice.length, inner = half - round;
  for (const axis of [0, 1, 2]) {
    for (const sign of [1, -1]) {
      const [u, v] = sign > 0 ? [(axis + 1) % 3, (axis + 2) % 3] : [(axis + 2) % 3, (axis + 1) % 3];
      const first = positions.length / 3;
      for (let j = 0; j < count; j++) {
        for (let i = 0; i < count; i++) {
          const point = [0, 0, 0];
          point[axis] = sign * half; point[u] = lattice[i]; point[v] = lattice[j];
          // A rounded box: every point sits `round` away from the box shrunk by `round`.
          const core = point.map((value) => Math.min(inner, Math.max(-inner, value)));
          const length = Math.hypot(point[0] - core[0], point[1] - core[1], point[2] - core[2]);
          const out = point.map((value, k) => (value - core[k]) / length), sink = depth(point);
          positions.push(...core.map((value, k) => value + (round - sink) * out[k]));
          // The surface leans towards rising depth along each direction it spans.
          const normal = new THREE.Vector3(...out);
          for (const [k, index] of [[u, i], [v, j]] as const) {
            const before = [...point], after = [...point];
            before[k] = lattice[Math.max(0, index - 1)]; after[k] = lattice[Math.min(count - 1, index + 1)];
            const tangent = new THREE.Vector3().setComponent(k, 1);
            normal.addScaledVector(tangent, (depth(after) - depth(before)) / (after[k] - before[k]));
          }
          normals.push(...normal.normalize().toArray());
          const across = axis === 1 ? point[0] : sign * (axis === 2 ? point[0] : -point[2]);
          uvs.push(0.5 + across / TAU, 0.5 + (axis === 1 ? -sign * point[2] : point[1]) / Math.PI);
        }
      }
      for (let j = 0; j < count - 1; j++) {
        for (let i = 0; i < count - 1; i++) {
          const a = first + j * count + i;
          indices.push(a, a + 1, a + count, a + 1, a + count + 1, a + count);
        }
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.rotateY(28 * DEG).translate(0, FLOOR + half, 0);
  return [{ name: 'Cube', geometry, material }, { name: 'Cube base', geometry: baseGeometry(baseRadius), material: 'Base' }];
}

/**
 * A cloth draped over a ball down to the floor: a thin closed sheet that
 * follows the ball, hangs as a curtain and folds more the further it falls.
 * Its corners reach the floor and its sides stop short of it.
 */
function drape(baseRadius: number, material: string): Part[] {
  const half = 0.012, ball = { radius: 0.5, y: 0.95, to: 62 * DEG }, cloth = { sides: 0.86, corner: 4, turn: 20 * DEG };
  const leave = [ball.radius * Math.sin(ball.to), ball.y + ball.radius * Math.cos(ball.to)];
  const longest = leave[1] - (FLOOR + half + 0.004);
  /** How far each direction hangs, as a share of the corners' fall. */
  const share = (azimuth: number) => cloth.sides * (Math.abs(Math.cos(azimuth)) ** cloth.corner + Math.abs(Math.sin(azimuth)) ** cloth.corner) ** (-1 / cloth.corner);
  /** The cloth leaves the ball along its tangent, turns down into a curtain and spreads on the floor. */
  const flare = (fall: number) => 0.21 * (1 - Math.exp(-fall / 0.4)) + 0.07 * (fall / longest) ** 5;
  const centre: [number, number][] = [];
  for (let angle = 0; angle < ball.to - 1e-9; angle += 2 * DEG) centre.push([ball.radius * Math.sin(angle), ball.y + ball.radius * Math.cos(angle)]);
  const steps = Math.ceil(longest / 0.018);
  for (let step = 0; step <= steps; step++) centre.push([leave[0] + flare((longest * step) / steps), leave[1] - (longest * step) / steps]);
  const inner: Knot[] = [], outer: Knot[] = [];
  let tangent = [1, 0], out = [0, 1];
  centre.forEach(([r, y], i) => {
    const a = centre[Math.max(0, i - 1)], b = centre[Math.min(centre.length - 1, i + 1)], length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    tangent = i === 0 ? [1, 0] : [(b[0] - a[0]) / length, (b[1] - a[1]) / length];
    out = [-tangent[1], tangent[0]];
    inner.push({ r: Math.max(0, r - half * out[0]), y: y - half * out[1] });
    outer.unshift({ r: Math.max(0, r + half * out[0]), y: y + half * out[1] });
  });
  const end = centre[centre.length - 1], lip: Knot[] = [];
  for (let angle = 30 * DEG; angle < 179 * DEG; angle += 30 * DEG) {
    lip.push({ r: end[0] + half * (-Math.cos(angle) * out[0] + Math.sin(angle) * tangent[0]), y: end[1] + half * (-Math.cos(angle) * out[1] + Math.sin(angle) * tangent[1]) });
  }
  // Uneven folds: broad lobes with tight creases between them, drifting in spacing and depth.
  const folds = (azimuth: number) => {
    const drift = azimuth + 0.16 * Math.sin(3 * azimuth + 1) + 0.07 * Math.sin(5 * azimuth + 2.3);
    return (1 - 2 * (0.5 - 0.5 * Math.cos(9 * drift)) ** 1.5) * (0.78 + 0.22 * Math.sin(2 * azimuth + 0.7));
  };
  const geometry = revolve(buildProfile([...inner, ...lip, ...outer]), {
    columns: 480,
    warp: (azimuth, point) => {
      if (point.y >= leave[1]) return [point.r, point.y];
      // The profile hangs as far as a corner; elsewhere the hem rises to where the cloth ends.
      const fall = Math.min(longest, leave[1] - point.y), hang = fall * Math.min(1, share(azimuth - cloth.turn));
      const r = point.r + flare(hang) - flare(fall);
      return [r * (1 + 0.2 * (hang / longest) ** 1.3 * folds(azimuth)), point.y + fall - hang];
    }
  });
  return [{ name: 'Drape', geometry, material }, { name: 'Drape base', geometry: baseGeometry(baseRadius), material: 'Base' }];
}

/** A trefoil knot standing on two lobes: a solid tube that crosses in front of itself. */
function knot(baseRadius: number, material: string): Part[] {
  const tubular = 384, radial = 36, tube = 0.15, stride = radial + 1;
  const geometry = new THREE.TorusKnotGeometry(0.46, tube, tubular, radial, 2, 3);
  const position = geometry.getAttribute('position') as THREE.BufferAttribute, normal = geometry.getAttribute('normal') as THREE.BufferAttribute, uv = geometry.getAttribute('uv');
  // Close both seams exactly, and measure the tube to bring its UVs to the other shapes' density.
  let length = 0;
  const ring = (row: number) => {
    const centre = new THREE.Vector3();
    for (let column = 0; column < radial; column++) centre.add(new THREE.Vector3().fromBufferAttribute(position, row * stride + column));
    return centre.divideScalar(radial);
  };
  for (let row = 0; row <= tubular; row++) {
    if (row > 0) length += ring(row).distanceTo(ring(row - 1));
    for (let column = 0; column <= radial; column++) {
      const i = row * stride + column, twin = (row % tubular) * stride + column % radial;
      position.copyAt(i, position, twin);
      normal.copyAt(i, normal, twin);
    }
  }
  for (let i = 0; i < uv.count; i++) uv.setXY(i, (uv.getX(i) * length) / TAU, uv.getY(i) * 2 * tube);
  geometry.rotateZ(90 * DEG);
  geometry.computeBoundingBox();
  geometry.translate(0, FLOOR - geometry.boundingBox!.min.y, 0);
  return [{ name: 'Knot', geometry, material }, { name: 'Knot base', geometry: baseGeometry(baseRadius), material: 'Base' }];
}

/**
 * Builds the meshes. Every part is a closed solid, so transmission stays
 * consistent, and every mesh keeps the identity transform, so position-based
 * graphs see one object space.
 */
function assemble(name: string, parts: Part[], materialX?: Record<string, string>): LoadedModel {
  const materials = new Map<string, THREE.MeshPhysicalMaterial>();
  const root = new THREE.Group();
  root.name = name;
  for (const part of parts) {
    let material = materials.get(part.material);
    if (!material) {
      material = part.material === 'Core' ? new THREE.MeshPhysicalMaterial({ color: 0xffc35a, metalness: 1, roughness: 0.25 })
        : part.material === 'Base' ? new THREE.MeshPhysicalMaterial({ map: dialTexture(), roughness: 0.45 })
        : new THREE.MeshPhysicalMaterial({ color: 0xd9dadd, roughness: 0.28 });
      material.name = part.material;
      materials.set(part.material, material);
    }
    const mesh = new THREE.Mesh(part.geometry, material);
    mesh.name = part.name;
    root.add(mesh);
  }
  return { name, root, animations: [], materialX, revoke() {} };
}

/** Material test model: a hollow ball with a port and a core. */
export const createShaderBall = (): LoadedModel => assemble('Shader ball', ball(1.38, 'Material'));

/**
 * Material test set: a panelled cube, the shader ball, a draped cloth and a
 * knot, in a shallow arc. Each has its own material and opens with a bundled
 * sample that suits its shape.
 */
export function createMaterialShapes(): LoadedModel {
  const shapes = [
    { radius: 1, parts: cube(1, 'Cube'), forward: 0.5 },
    { radius: 1.18, parts: ball(1.18, 'Ball').map((part) => ({ ...part, name: part.name === 'Shell' ? 'Ball' : `Ball ${part.name.toLowerCase()}` })), forward: 0 },
    { radius: 1.05, parts: drape(1.05, 'Drape'), forward: 0 },
    { radius: 0.95, parts: knot(0.95, 'Knot'), forward: 0.5 }
  ];
  const spacing = 0.08, width = shapes.reduce((sum, shape) => sum + 2 * shape.radius, 0) + spacing * (shapes.length - 1);
  let x = -width / 2;
  return assemble('Material shapes', shapes.flatMap((shape) => {
    x += shape.radius;
    for (const part of shape.parts) part.geometry.translate(x, 0, shape.forward);
    x += shape.radius + spacing;
    return shape.parts;
  }), { Cube: 'hex-panel', Ball: 'car-paint', Drape: 'tartan-velvet', Knot: 'candle-wax' });
}
