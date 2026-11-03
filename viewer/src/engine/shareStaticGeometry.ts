import type * as THREE from 'three';
import type {Geometry} from '@meimu/mutracer';

// The viewer owns both scenes. Keep Three's geometry for picking/focus and
// synchronization, but discard identical conversion copies for static meshes.
// Engine.update still makes its independent committed snapshot.
export function shareStaticGeometry(geometry: Geometry, source: THREE.Mesh,
  range: {start: number; count: number; materialIndex?: number}) {
  if ((source as THREE.SkinnedMesh).isSkinnedMesh || Object.values(source.geometry.morphAttributes).some(a => a?.length)) return;
  const materials = Array.isArray(source.material) ? source.material : [source.material];
  if (materials[range.materialIndex ?? 0]?.side === 1) return;
  for (const name of ['position', 'normal', 'uv', 'uv1', 'tangent', 'color'] as const) {
    const original = source.geometry.getAttribute(name), converted = geometry[name];
    if (!original || !converted || (original as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute ||
      original.normalized || !(original.array instanceof Float32Array) ||
      original.itemSize !== converted.itemSize || original.array.length !== converted.array.length) continue;
    converted.array = original.array;
  }
  const index = source.geometry.index;
  // Uint16 sources would add canonical Uint32 caches to both converted and
  // committed geometries; retain the converter's Uint32 indices in that case.
  if (index && geometry.indices.array.length === index.array.length && range.start === 0 && range.count >= index.count &&
    index.array instanceof Uint32Array) {
    geometry.indices.array = index.array;
  }
}
