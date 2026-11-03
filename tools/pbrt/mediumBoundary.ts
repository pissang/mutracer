import * as THREE from 'three';

/** Geometry-only checks: split normal/UV vertices are welded for topology,
 * without changing the geometry sent to the renderer. */
export function mediumBoundary(geometry: THREE.BufferGeometry) {
  const p = geometry.attributes.position, normal = geometry.attributes.normal;
  const index = geometry.index;
  const count = index?.count ?? p.count;
  const vertex = (i: number) => index ? index.getX(i) : i;
  const bounds = new THREE.Box3().setFromBufferAttribute(p as THREE.BufferAttribute);
  const origin = bounds.getCenter(new THREE.Vector3());
  const tolerance = Math.max(bounds.getSize(new THREE.Vector3()).length() * 1e-7, 1e-12);
  const positions = new Map<string, number>(), ids: number[] = [];
  for (let i = 0; i < p.count; i++) {
    const key = [p.getX(i), p.getY(i), p.getZ(i)].map((v, c) => Math.round((v - origin.getComponent(c)) / tolerance)).join(',');
    if (!positions.has(key)) positions.set(key, positions.size);
    ids.push(positions.get(key)!);
  }
  const edges = new Map<string, {count: number; direction: number}>();
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const ab = new THREE.Vector3(), ac = new THREE.Vector3(), n = new THREE.Vector3();
  let normalDisagreement = false;
  for (let i = 0; i < count; i += 3) {
    const indices = [vertex(i), vertex(i + 1), vertex(i + 2)], welded = indices.map(v => ids[v]);
    if (new Set(welded).size < 3) continue;
    a.fromBufferAttribute(p, indices[0]); b.fromBufferAttribute(p, indices[1]); c.fromBufferAttribute(p, indices[2]);
    ab.copy(b).sub(a); ac.copy(c).sub(a); n.crossVectors(ab, ac);
    if (n.lengthSq() === 0) continue;
    if (normal) for (const j of indices) {
      if (n.x * normal.getX(j) + n.y * normal.getY(j) + n.z * normal.getZ(j) <= 0) normalDisagreement = true;
    }
    for (let j = 0; j < 3; j++) {
      const u = welded[j], v = welded[(j + 1) % 3], key = u < v ? `${u},${v}` : `${v},${u}`;
      const edge = edges.get(key) ?? {count: 0, direction: 0};
      edge.count++; edge.direction += u < v ? 1 : -1; edges.set(key, edge);
    }
  }
  const closed = edges.size > 0 && [...edges.values()].every(e => e.count === 2);
  const oriented = !normalDisagreement && [...edges.values()].every(e => e.count !== 2 || e.direction === 0);
  return {closed, oriented};
}
