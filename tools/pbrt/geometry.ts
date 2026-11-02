import * as THREE from 'three';
import { subdivideLoop } from './subdivision';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';
import { scalar, vector, type Shape } from './scene';
import { decompress, resolvePath, type Resolver } from './source';

export function parsePLY(bytes: ArrayBuffer): THREE.BufferGeometry {
  const loader = new PLYLoader();
  loader.setPropertyNameMapping({ s: 'u', t: 'v', texture_u: 'u', texture_v: 'v' });
  return loader.parse(bytes);
}
export type PLYDecoder = (bytes: ArrayBuffer) => Promise<THREE.BufferGeometry>;
export async function geometry(shape: Shape, entry: string, resolver: Resolver, decodePLY?: PLYDecoder): Promise<THREE.BufferGeometry | null> {
  const p = shape.params;
  if (shape.type === 'curve') return null;
  if (shape.type === 'plymesh') { const bytes = await decompress(await resolver.read(resolvePath(String(p.filename?.values[0]), entry))); return decodePLY ? decodePLY(bytes) : parsePLY(bytes); }
  if (['trianglemesh', 'bilinearmesh', 'loopsubdiv'].includes(shape.type)) {
    const result = new THREE.BufferGeometry(), positions = vector(p, 'P', []);
    if (!positions.length || positions.length % 3) throw new Error(`${shape.loc.file}:${shape.loc.line}: invalid positions`);
    result.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    const normals = vector(p, 'N', []), uv = vector(p, 'uv', vector(p, 'st', []));
    if (normals.length) result.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    if (uv.length) result.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    let indices = vector(p, 'indices', Array.from({ length: positions.length / 3 }, (_, i) => i));
    if (shape.type === 'bilinearmesh') {
      const triangles: number[] = [];
      for (let i = 0; i < indices.length; i += 4) triangles.push(indices[i], indices[i + 1], indices[i + 2], indices[i + 1], indices[i + 3], indices[i + 2]);
      indices = triangles;
    }
    if (indices.length % 3 || indices.some(i => !Number.isInteger(i) || i < 0 || i >= positions.length / 3)) throw new Error(`${shape.loc.file}:${shape.loc.line}: invalid triangle indices`);
    result.setIndex(indices);
    if (!normals.length) result.computeVertexNormals();
    return shape.type === 'loopsubdiv' ? subdivideLoop(result, scalar(p, 'levels', scalar(p, 'nlevels', 3))) : result;
  }
  const radius = scalar(p, 'radius', 1), phi = THREE.MathUtils.degToRad(scalar(p, 'phimax', 360));
  if (shape.type === 'sphere') {
    const min = scalar(p, 'zmin', -radius), max = scalar(p, 'zmax', radius);
    const thetaStart = Math.acos(THREE.MathUtils.clamp(max / radius, -1, 1)), thetaEnd = Math.acos(THREE.MathUtils.clamp(min / radius, -1, 1));
    return new THREE.SphereGeometry(radius, 192, 96, 0, phi, thetaStart, thetaEnd - thetaStart).rotateX(Math.PI / 2).rotateZ(Math.PI);
  }
  if (shape.type === 'disk') {
    const segments = 128, inner = scalar(p, 'innerradius', 0), g = new THREE.RingGeometry(inner, radius, segments, 1, 0, phi);
    const positions = g.attributes.position, uv = g.attributes.uv;
    for (let i = 0; i < positions.count; i++) {
      const x = positions.getX(i), y = positions.getY(i);
      uv.setXY(i, (i % (segments + 1)) / segments, (radius - Math.hypot(x, y)) / (radius - inner));
    }
    return g.translate(0, 0, scalar(p, 'height', 0));
  }
  if (shape.type === 'cylinder') {
    const min = scalar(p, 'zmin', -1), max = scalar(p, 'zmax', 1);
    return new THREE.CylinderGeometry(radius, radius, max - min, 64, 1, true, 0, phi).rotateX(Math.PI / 2).rotateZ(Math.PI / 2).translate(0, 0, (min + max) / 2);
  }
  return null;
}
