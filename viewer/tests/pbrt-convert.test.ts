import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildScene } from '../../tools/pbrt/scene';
import { convert } from '../../tools/pbrt/convert';
import { conductor, glass, namedSpectrum, roughness, verticalFov } from '../../tools/pbrt/spectrum';
import { parsePLY } from '../../tools/pbrt/geometry';
const load = async (text: string) => {
  const resolver = { async read() { return new TextEncoder().encode(text).buffer; } };
  const scene = await buildScene('main.pbrt', resolver); return { scene, ...(await convert(scene, resolver)) };
};
describe('PBRT conversion semantics', () => {
  it('converts short-edge field of view and PBRT-v4 microfacet alpha', () => {
    expect(verticalFov(60, 2)).toBe(60); expect(verticalFov(60, .5)).toBeCloseTo(98.21321);
    expect(roughness(.0625)).toBe(.5); expect(roughness(.25, false)).toBe(.5);
  });
  it('mirrors the world and camera together and keeps the camera basis right handed', async () => {
    const { root } = await load('LookAt 0 0 -4 0 0 0 0 1 0 Camera "perspective" WorldBegin Shape "sphere"');
    let camera: THREE.Camera | undefined; root.traverse(o => { if ((o as THREE.Camera).isCamera) camera = o as THREE.Camera; });
    expect(camera!.getWorldPosition(new THREE.Vector3()).z).toBe(4);
    expect(camera!.getWorldDirection(new THREE.Vector3()).z).toBe(-1);
    expect(camera!.matrixWorld.determinant()).toBeCloseTo(1);
  });
  it('retains object instances as one InstancedMesh and creates alpha variants', async () => {
    const { root } = await load('WorldBegin ObjectBegin "x" Shape "sphere" ObjectEnd ObjectInstance "x" Translate 2 0 0 ObjectInstance "x" Shape "sphere" "float alpha" .5 Shape "sphere"');
    const meshes = root.children.filter(o => (o as THREE.Mesh).isMesh) as THREE.Mesh[];
    expect((meshes.find(o => (o as THREE.InstancedMesh).isInstancedMesh) as THREE.InstancedMesh).count).toBe(2);
    expect((meshes[0].material as THREE.Material).opacity).toBe(.5);
    expect((meshes[1].material as THREE.Material).opacity).toBe(1);
  });
  it('maps named glass dispersion and conductor normal/edge Fresnel', () => {
    const bk7 = glass(namedSpectrum('glass-BK7')!); expect(bk7.ior).toBeCloseTo(1.5168, 3); expect(bk7.abbe).toBeGreaterThan(60); expect(bk7.abbe).toBeLessThan(66);
    const gold = conductor(namedSpectrum('metal-Au-eta')!, namedSpectrum('metal-Au-k')!);
    expect(gold.base[0]).toBeGreaterThan(gold.base[2]); expect(gold.edge[2]).toBeGreaterThan(gold.base[2]);
  });
  it('triangulates ASCII PLY quads and recognizes texture_u/texture_v', () => {
    const text = 'ply\nformat ascii 1.0\nelement vertex 4\nproperty float x\nproperty float y\nproperty float z\nproperty float texture_u\nproperty float texture_v\nelement face 1\nproperty list uchar int vertex_indices\nend_header\n0 0 0 0 0\n1 0 0 1 0\n1 1 0 1 1\n0 1 0 0 1\n4 0 1 2 3\n';
    const geometry = parsePLY(new TextEncoder().encode(text).buffer); expect(geometry.index!.count).toBe(6); expect(geometry.attributes.uv.count).toBe(4);
  });
});

describe('PBRT transformed surface orientation', () => {
  it.each(['', 'Scale -1 1 1', 'ReverseOrientation'])('keeps emissive geometry normals consistent with triangle winding (%s)', async transform => {
    const { root } = await load(`WorldBegin ${transform} AreaLightSource "diffuse" Shape "disk"`);
    const mesh = root.children.find(o => (o as THREE.Mesh).isMesh) as THREE.Mesh;
    const g = mesh.geometry, p = g.attributes.position, n = g.attributes.normal, indices = g.index!;
    for (let i = 0; i < indices.count; i += 3) {
      const a = new THREE.Vector3().fromBufferAttribute(p, indices.getX(i));
      const b = new THREE.Vector3().fromBufferAttribute(p, indices.getX(i+1));
      const c = new THREE.Vector3().fromBufferAttribute(p, indices.getX(i+2));
      const normal = new THREE.Vector3().fromBufferAttribute(n, indices.getX(i));
      const cross = b.sub(a).cross(c.sub(a)); if (cross.lengthSq() > 1e-12) expect(cross.dot(normal)).toBeGreaterThan(0);
    }
  });
  it('retains mirrored instances with positive instance determinants and matching bounds', async () => {
    const { root } = await load('WorldBegin ObjectBegin "a" Shape "sphere" ObjectEnd ObjectInstance "a" Scale -1 1 1 Translate 3 0 0 ObjectInstance "a"');
    const meshes = root.children.filter(o => (o as THREE.InstancedMesh).isInstancedMesh) as THREE.InstancedMesh[];
    expect(meshes).toHaveLength(2);
    for (const mesh of meshes) { const matrix = new THREE.Matrix4(); mesh.getMatrixAt(0, matrix); expect(matrix.determinant()).toBeGreaterThan(0); }
    const bounds = new THREE.Box3().setFromObject(root); expect(bounds.min.x).toBeCloseTo(-4, 4); expect(bounds.max.x).toBeCloseTo(1, 4);
  });
});
