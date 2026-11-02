import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildScene } from '../../tools/pbrt/scene';
import { convert } from '../../tools/pbrt/convert';
import { conductor, conductorFresnel, metalTint, glass, namedSpectrum, roughness, verticalFov } from '../../tools/pbrt/spectrum';
import { parsePLY } from '../../tools/pbrt/geometry';
import { fromTHREEScene } from '../../src/util/fromTHREE';
import { packMaterialParams } from '../../src/renderer/materialParams';
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
  it('preserves PBRT per-triangle UV defaults when a mapped mesh has no UVs', async () => {
    const { root } = await load('WorldBegin Texture "t" "spectrum" "checkerboard" Material "diffuse" "texture reflectance" "t" Shape "trianglemesh" "point3 P" [0 0 0 1 0 0 1 1 0 0 1 0] "integer indices" [0 1 2 0 2 3]');
    const mesh = root.children.find(o => (o as THREE.Mesh).isMesh) as THREE.Mesh;
    expect(mesh.geometry.attributes.position.count).toBe(6); expect(Array.from(mesh.geometry.attributes.uv.array)).toEqual([0,0,1,0,1,1,0,0,1,0,1,1]);
  });
  it('converts physical edge reflectance to the OpenPBR F82 tint', () => {
    const base = [.7,.5,.1], edge = [.8,.7,.4], tint = metalTint(base,edge);
    tint.forEach((v,i)=>expect(v*(base[i]+(1-base[i])*Math.pow(6/7,5))).toBeCloseTo(edge[i],12));
    expect(conductorFresnel(1,2*Math.sqrt(.7/.3),1)).toBeCloseTo(.7,12);
  });
  it('retains ordinary surfaces when primary rays hit their back faces', async () => {
    const { root } = await load('WorldBegin Material "diffuse" Shape "trianglemesh" "point3 P" [-1 -1 0 1 -1 0 0 1 0]');
    root.updateMatrixWorld(true);
    for (const z of [-2, 2]) {
      const ray = new THREE.Raycaster(new THREE.Vector3(0,0,z), new THREE.Vector3(0,0,-Math.sign(z)));
      expect(ray.intersectObject(root, true)).toHaveLength(1);
    }
  });
  it('preserves both polar UV endpoints at the disk seam', async () => {
    const { root } = await load('WorldBegin Shape "disk" "float innerradius" .2');
    const mesh = root.children.find(o => (o as THREE.Mesh).isMesh) as THREE.Mesh;
    const p = mesh.geometry.attributes.position, uv = mesh.geometry.attributes.uv;
    const first = new THREE.Vector3().fromBufferAttribute(p, 0), seam = new THREE.Vector3().fromBufferAttribute(p, 128);
    expect(first.distanceTo(seam)).toBeLessThan(1e-6);
    expect(uv.getX(0)).toBe(0); expect(uv.getX(128)).toBe(1);
    expect(uv.getY(0)).toBeCloseTo(1); expect(uv.getY(129)).toBeCloseTo(0);
  });
  it('preserves named subsurface extinction and scattering through the existing OpenPBR packer', async () => {
    const { root } = await load('WorldBegin Material "subsurface" "string name" "Skin1" "float scale" 50 "float eta" 1.5 Shape "sphere"');
    const source = new THREE.Scene(); source.add(root);
    const converted = fromTHREEScene(source), params = packMaterialParams([converted.meshes[0].materials[0]]);
    [(.032+.74)*50,(.17+.88)*50,(.48+1.01)*50].forEach((v,i)=>expect(params.mediumExtinction[0][i]).toBeCloseTo(v,4));
    [.74*50,.88*50,1.01*50].forEach((v,i)=>expect(params.mediumScattering[0][i]).toBeCloseTo(v,4));
  });
  it('preserves interior homogeneous scattering, including zero absorption and high extinction', async () => {
    const { root } = await load('WorldBegin MakeNamedMedium "fog" "string type" "homogeneous" "rgb sigma_a" [0 .3 .4] "rgb sigma_s" [1 2 3] "float scale" 5 MediumInterface "fog" "" Material "interface" Shape "sphere"');
    const source = new THREE.Scene(); source.add(root);
    const params = packMaterialParams([fromTHREEScene(source).meshes[0].materials[0]]);
    [5,11.5,17].forEach((v,i)=>expect(params.mediumExtinction[0][i]).toBeCloseTo(v,5));
    [5,10,15].forEach((v,i)=>expect(params.mediumScattering[0][i]).toBeCloseTo(v,5));
  });
  it.each([['thindielectric',1],['diffusetransmission',.5]] as const)('retains %s transmission and thin-wall state through Three.js', async (type, weight) => {
    const { root } = await load(`WorldBegin Material "${type}" Shape "sphere"`);
    const source = new THREE.Scene(); source.add(root);
    const material = fromTHREEScene(source).meshes[0].materials[0];
    expect(material.transmissionWeight).toBe(weight);
    expect(material.thinWalled).toBe(true);
  });
  it('keeps shape displacement variants independent', async () => {
    const { root } = await load('WorldBegin Texture "a" "float" "checkerboard" "float tex1" 0 "float tex2" 1 Texture "b" "float" "checkerboard" "float tex1" .2 "float tex2" .8 Shape "sphere" "texture displacement" "a" Shape "sphere" "texture displacement" "b"');
    const meshes = root.children.filter(o => (o as THREE.Mesh).isMesh) as THREE.Mesh<THREE.BufferGeometry, THREE.MeshPhysicalMaterial>[];
    expect(meshes[0].material).not.toBe(meshes[1].material);
    expect(meshes[0].material.displacementMap!.image.data[0]).not.toBe(meshes[1].material.displacementMap!.image.data[0]);
  });
  it.each(['"float amount" .75', '"texture amount" "weight"'])('excludes a dominant diffuse mix branch from strict comparisons (%s)', async amount => {
    const { root, scene } = await load(`WorldBegin Texture "weight" "float" "constant" "float value" .75 MakeNamedMaterial "a" "string type" "diffuse" "rgb reflectance" [1 0 0] MakeNamedMaterial "b" "string type" "diffuse" "rgb reflectance" [0 0 1] Material "mix" "string materials" ["a" "b"] ${amount} Shape "sphere"`);
    const mesh = root.children.find(o => (o as THREE.Mesh).isMesh) as THREE.Mesh<THREE.BufferGeometry, THREE.MeshPhysicalMaterial>;
    expect(mesh.material.color.toArray()).toEqual([0,0,1]);
    expect(mesh.material.userData.pbrtComparable).toBe(false);
    expect(scene.warnings.some(w => w.handling.includes('larger weight'))).toBe(true);
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
  it('mirrors textured instances after generated per-triangle UVs remove their index', async () => {
    const { root } = await load('WorldBegin Texture "t" "spectrum" "checkerboard" Material "diffuse" "texture reflectance" "t" ObjectBegin "a" Scale -1 1 1 Shape "trianglemesh" "point3 P" [0 0 0 1 0 0 0 1 0] ObjectEnd Scale -1 1 1 ObjectInstance "a"');
    const mesh = root.children.find(o => (o as THREE.InstancedMesh).isInstancedMesh) as THREE.InstancedMesh;
    expect(mesh.geometry.index!.count).toBe(3);
    expect(Array.from(mesh.geometry.attributes.uv.array)).toEqual([0,0,1,0,1,1]);
    expect(new THREE.Box3().setFromObject(root).max.x).toBeCloseTo(1);
  });
});
