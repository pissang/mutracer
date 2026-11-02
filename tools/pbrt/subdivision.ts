import * as THREE from 'three';
// Loop weights and limit projection follow PBRT-v4@b0bdf461,
// src/pbrt/util/loopsubdiv.cpp (Apache-2.0; LICENSES/pbrt-v4-Apache-2.0.txt).
// Topology and storage are independently implemented for indexed Three meshes.
export function subdivideLoop(input: THREE.BufferGeometry, levels: number): THREE.BufferGeometry {
  if (!Number.isInteger(levels) || levels < 0 || levels > 8) throw new Error('Loop levels must be between 0 and 8');
  let positions = Array.from(input.attributes.position.array as ArrayLike<number>), faces = Array.from(input.index!.array);
  const beta = (n: number) => n === 3 ? 3 / 16 : 3 / (8 * n);
  const topology = () => {
    const neighbors = Array.from({ length: positions.length / 3 }, () => new Set<number>());
    const boundary = neighbors.map(() => new Set<number>());
    const edges = new Map<string, { a: number; b: number; opposite: number[]; index: number }>();
    for (let i = 0; i < faces.length; i += 3) for (let j = 0; j < 3; j++) {
      const a = faces[i + j], b = faces[i + (j + 1) % 3], other = faces[i + (j + 2) % 3];
      neighbors[a].add(b); neighbors[b].add(a);
      const key = `${Math.min(a, b)}:${Math.max(a, b)}`;
      let edge = edges.get(key); if (!edge) { edge = { a, b, opposite: [], index: -1 }; edges.set(key, edge); }
      edge.opposite.push(other); if (edge.opposite.length > 2) throw new Error('Non-manifold Loop edge');
    }
    for (const e of edges.values()) if (e.opposite.length === 1) { boundary[e.a].add(e.b); boundary[e.b].add(e.a); }
    // Some scene control meshes weld several boundary fans at one vertex.
    // PBRT uses the fan containing the last incident face (its startFace).
    const fans = new Map<number, { links: Map<number, Set<number>>; start: number }>();
    boundary.forEach((ring, v) => { if (ring.size > 2) fans.set(v, { links: new Map(), start: -1 }); });
    if (fans.size) {
      for (let i = 0; i < faces.length; i += 3) for (let j = 0; j < 3; j++) {
        const fan = fans.get(faces[i + j]); if (!fan) continue;
        const a = faces[i + (j + 1) % 3], b = faces[i + (j + 2) % 3];
        if (!fan.links.has(a)) fan.links.set(a, new Set()); if (!fan.links.has(b)) fan.links.set(b, new Set());
        fan.links.get(a)!.add(b); fan.links.get(b)!.add(a); fan.start = a;
      }
      for (const [v, fan] of fans) {
        const connected = new Set([fan.start]), queue = [fan.start];
        for (let i = 0; i < queue.length; i++) for (const next of fan.links.get(queue[i]) ?? []) if (!connected.has(next)) { connected.add(next); queue.push(next); }
        neighbors[v] = connected; boundary[v] = new Set([...boundary[v]].filter(n => connected.has(n)));
      }
    }
    return { neighbors, boundary, edges };
  };
  const even = (neighbors: Set<number>[], boundary: Set<number>[], limit = false) => {
    const next = positions.slice();
    for (let v = 0; v < neighbors.length; v++) {
      const ring = [...(boundary[v].size ? boundary[v] : neighbors[v])]; if (!ring.length) continue;
      if (boundary[v].size && ring.length !== 2) throw new Error('Non-manifold Loop boundary');
      const weight = boundary[v].size ? limit ? 1 / 5 : 1 / 8 : limit ? 1 / (ring.length + 3 / (8 * beta(ring.length))) : beta(ring.length);
      for (let c = 0; c < 3; c++) next[v * 3 + c] = positions[v * 3 + c] * (1 - ring.length * weight) + ring.reduce((sum, n) => sum + positions[n * 3 + c] * weight, 0);
    }
    return next;
  };
  for (let level = 0; level < levels; level++) {
    const { neighbors, boundary, edges } = topology();
    if (positions.length / 3 + edges.size > 4_000_000) throw new Error('Loop subdivision exceeds the four-million-vertex memory budget');
    const next = even(neighbors, boundary), triangles: number[] = [];
    for (const edge of edges.values()) {
      edge.index = next.length / 3;
      for (let c = 0; c < 3; c++) next.push(edge.opposite.length === 1 ? (positions[edge.a * 3 + c] + positions[edge.b * 3 + c]) / 2 : (positions[edge.a * 3 + c] + positions[edge.b * 3 + c]) * 3 / 8 + (positions[edge.opposite[0] * 3 + c] + positions[edge.opposite[1] * 3 + c]) / 8);
    }
    const edge = (a: number, b: number) => edges.get(`${Math.min(a, b)}:${Math.max(a, b)}`)!.index;
    for (let i = 0; i < faces.length; i += 3) {
      const [a, b, c] = faces.slice(i, i + 3), ab = edge(a, b), bc = edge(b, c), ca = edge(c, a);
      triangles.push(a, ab, ca, b, bc, ab, c, ca, bc, ab, bc, ca);
    }
    positions = next; faces = triangles;
  }
  const { neighbors, boundary } = topology(); positions = even(neighbors, boundary, true);
  const result = new THREE.BufferGeometry(); result.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3)); result.setIndex(faces); result.computeVertexNormals(); return result;
}
