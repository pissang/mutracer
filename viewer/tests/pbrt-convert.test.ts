import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
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
  it('routes material bump to normals and retains shape displacement', async () => {
    const { root, scene } = await load('WorldBegin Texture "h" "float" "checkerboard" Material "diffuse" "texture displacement" "h" Shape "sphere" Shape "sphere" "texture displacement" "h"');
    const meshes = root.children.filter(o=>(o as THREE.Mesh).isMesh) as THREE.Mesh<THREE.BufferGeometry, THREE.MeshPhysicalMaterial>[];
    expect(meshes[0].material.normalMap).not.toBeNull(); expect(meshes[0].material.displacementMap).toBeNull();
    expect(meshes[1].material.normalMap).not.toBeNull(); expect(meshes[1].material.displacementMap).not.toBeNull();
    expect(scene.warnings.some(w=>w.code==='bump')).toBe(true);
  });
  it('preserves outside absorption by reversing the boundary, including reflected transforms', async () => {
    for (const transform of ['', 'Scale -1 1 1']) {
      const prefix = 'WorldBegin MakeNamedMedium "m" "string type" "homogeneous" "rgb sigma_a" [.1 .2 .5] "rgb sigma_s" [0 0 0] Material "dielectric" ' + transform;
      const a = await load(prefix + ' MediumInterface "m" "" Shape "sphere"');
      const b = await load(prefix + ' MediumInterface "" "m" ReverseOrientation Shape "sphere"');
      const mesh = (root: THREE.Group) => root.children.find(o=>(o as THREE.Mesh).isMesh) as THREE.Mesh<THREE.BufferGeometry,THREE.MeshPhysicalMaterial>;
      const ma = mesh(a.root), mb = mesh(b.root);
      expect(mb.geometry.index!.array).toEqual(ma.geometry.index!.array);
      expect(mb.geometry.attributes.normal.array).toEqual(ma.geometry.attributes.normal.array);
      const source = new THREE.Scene(); source.add(b.root);
      const packed = packMaterialParams([fromTHREEScene(source).meshes[0].materials[0]]);
      [.1,.2,.5].forEach((v,i)=>expect(packed.mediumExtinction[0][i]).toBeCloseTo(v,5));
    }
  });
  it('exchanges only thick dielectric IOR across medium-side reversal', async () => {
    for (const outside of [false, true]) for (const reverse of [false, true]) for (const reflected of [false, true]) {
      const { root } = await load(`WorldBegin MakeNamedMedium "m" "string type" "homogeneous"
        ${reflected ? 'Scale -1 1 1 CoordinateSystem "reflected" Identity CoordSysTransform "reflected"' : ''}
        ${reverse ? 'ReverseOrientation' : ''} MediumInterface ${outside ? '"" "m"' : '"m" ""'}
        Material "dielectric" "float eta" 1.5 Shape "trianglemesh"
        "point3 P" [0 0 0 1 0 0 0 1 0] "normal N" [0 0 1 0 0 1 0 0 1] "integer indices" [0 1 2]`);
      const mesh = root.children.find(o => (o as THREE.Mesh).isMesh) as THREE.Mesh<THREE.BufferGeometry, THREE.MeshPhysicalMaterial>;
      const g = mesh.geometry, p = g.attributes.position, indices = g.index!;
      const a = new THREE.Vector3().fromBufferAttribute(p, indices.getX(0));
      const b = new THREE.Vector3().fromBufferAttribute(p, indices.getX(1)).sub(a);
      const c = new THREE.Vector3().fromBufferAttribute(p, indices.getX(2)).sub(a);
      expect(Math.sign(b.cross(c).z)).toBe(reverse !== outside ? 1 : -1);
      expect(Math.sign(g.attributes.normal.getZ(0))).toBe(reverse !== outside ? 1 : -1);
      const source = new THREE.Scene(); source.add(root);
      expect(packMaterialParams([fromTHREEScene(source).meshes[0].materials[0]]).ior[0]).toBeCloseTo(outside ? 2 / 3 : 1.5, 10);
    }
  });
  it('keeps thin dielectric eta independent of orientation and warns for reversed coats', async () => {
    for (const type of ['thindielectric', 'coateddiffuse', 'coatedconductor']) {
      const { root, scene } = await load(`WorldBegin MakeNamedMedium "m" "string type" "homogeneous"
        MediumInterface "" "m" Material "${type}" "float eta" 1.5 Shape "sphere"`);
      const m = (root.children.find(o => (o as THREE.Mesh).isMesh) as THREE.Mesh).material as THREE.MeshPhysicalMaterial;
      if (type === 'thindielectric') { expect(m.ior).toBe(1.5); expect(scene.warnings.some(w => w.code === 'ior-orientation')).toBe(false); }
      else { expect(m.userData.pbrtComparable).toBe(false); expect(scene.warnings.some(w => w.code === 'ior-orientation')).toBe(true); }
    }
  });
  it.each(['thindielectric', 'diffusetransmission'])('warns when %s drops an interior medium', async type => {
    const { root, scene } = await load(`WorldBegin MakeNamedMedium "m" "string type" "homogeneous"
      "rgb sigma_a" [.1 .2 .5] "rgb sigma_s" [0 0 0]
      MediumInterface "m" "" Material "${type}" Shape "sphere"`);
    const m = (root.children.find(o => (o as THREE.Mesh).isMesh) as THREE.Mesh).material as THREE.Material;
    expect(m.userData.pbrtComparable).toBe(false);
    expect(scene.warnings).toContainEqual(expect.objectContaining({ code: 'thin-medium', statement: 'Shape', file: 'main.pbrt', handling: expect.stringContaining('skipped') }));
    const source = new THREE.Scene(); source.add(root);
    const packed = packMaterialParams([fromTHREEScene(source).meshes[0].materials[0]]);
    expect(packed.mediumType[0]).toBe(0);
    expect(packed.mediumExtinction[0]).toEqual([0, 0, 0]);
  });
  it('warns that reciprocal spectral dispersion retains an approximate Abbe mapping', async () => {
    const { root, scene } = await load('WorldBegin MakeNamedMedium "m" "string type" "homogeneous" MediumInterface "" "m" Material "dielectric" "spectrum eta" "glass-BK7" Shape "sphere"');
    const m = (root.children.find(o => (o as THREE.Mesh).isMesh) as THREE.Mesh).material as THREE.MeshPhysicalMaterial;
    expect(m.ior).toBeLessThan(1); expect(m.userData.mutracerOpenPBR.transmissionDispersionAbbeNumber).toBeGreaterThan(1);
    expect(m.userData.pbrtComparable).toBe(false); expect(scene.warnings.some(w => w.code === 'ior-dispersion')).toBe(true);
  });
  it('separates medium variants and warns when two non-camera media meet', async () => {
    const { root, scene } = await load('WorldBegin MakeNamedMedium "a" "string type" "homogeneous" MakeNamedMedium "b" "string type" "homogeneous" Material "dielectric" MediumInterface "a" "" Shape "sphere" MediumInterface "" "b" Shape "sphere" MediumInterface "a" "b" Shape "sphere"');
    const meshes = root.children.filter(o=>(o as THREE.Mesh).isMesh) as THREE.Mesh[];
    expect(meshes[0].material).not.toBe(meshes[1].material);
    expect(scene.warnings.some(w=>w.code==='medium-interface' && w.statement==='Shape')).toBe(true);
  });
  it.each(['conductor', 'coatedconductor'])('round trips both GGX axes for %s through OpenPBR', async type => {
    for (const [au,av] of [[.1,.4],[.4,.1],[.001,.8],[.2,.2],[0,0]]) {
      const params = (prefix: string) => `"float ${prefix}uroughness" ${au} "float ${prefix}vroughness" ${av}`;
      const { root } = await load(`WorldBegin Material "${type}" "bool remaproughness" false ${params(type==='coatedconductor'?'conductor.':'')} ${type==='coatedconductor'?params('interface.'):''} Shape "sphere"`);
      const m = (root.children.find(o=>(o as THREE.Mesh).isMesh) as THREE.Mesh).material as THREE.Material;
      const open = m.userData.mutracerOpenPBR;
      for(const layer of type==='coatedconductor'?['specular','coat']:['specular']) {
        const r = open[layer+'Roughness'], a = open[layer+'Anisotropy'], angle = open[layer+'AnisotropyRotation'];
        const at = r*r*Math.sqrt(2/(1+(1-a)**2)), ab = (1-a)*at;
        const recovered = angle===0?[at,ab]:[ab,at];
        expect(recovered[0]).toBeCloseTo(au,10); expect(recovered[1]).toBeCloseTo(av,10);
      }
    }
  });
  it.each([['interface', 'homogeneous'], ['', 'homogeneous'], ['interface', 'uniformgrid'], ['', 'uniformgrid']])('marks %s/%s interior boundaries incomparable with a structured warning', async (type, mediumType) => {
    const { root, scene } = await load(`WorldBegin MakeNamedMedium "m" "string type" "${mediumType}" MediumInterface "m" "" Material "${type}" Shape "sphere"`);
    const m = (root.children.find(o=>(o as THREE.Mesh).isMesh) as THREE.Mesh).material as THREE.Material;
    expect(m.userData.pbrtComparable).toBe(false);
    expect(root.userData.pbrtComparable).toBe(false);
    expect(scene.warnings).toContainEqual(expect.objectContaining({ code:'medium-shadow',statement:'Shape',file:'main.pbrt',handling:expect.stringContaining('point and area') }));
  });
  it('excludes the interior-homogeneous scene including its indirect shadow regions', async () => {
    const { root } = await load(await readFile(new URL('../../tests/fixtures/pbrt/interior-homogeneous.pbrt', import.meta.url), 'utf8'));
    expect(root.userData.pbrtComparable).toBe(false);
    const materials: THREE.Material[] = [];
    root.traverse(o => { if ((o as THREE.Mesh).isMesh) materials.push((o as THREE.Mesh).material as THREE.Material); });
    expect(materials.some(m => m.userData.pbrtComparable === true)).toBe(true);
    expect(materials.some(m => m.userData.pbrtComparable === false)).toBe(true);
  });
  it('keeps the zero-rotation anisotropy tangent on dpdu', async () => {
    const {root}=await load('WorldBegin Material "conductor" "float uroughness" .4 "float vroughness" .1 "bool remaproughness" false Shape "trianglemesh" "point3 P" [0 0 0 1 0 0 0 1 0] "point2 uv" [0 0 1 0 0 1]');
    const g=(root.children.find(o=>(o as THREE.Mesh).isMesh) as THREE.Mesh).geometry;
    expect(g.attributes.tangent.getX(0)).toBeCloseTo(1);expect(g.attributes.tangent.getY(0)).toBeCloseTo(0);
  });
  it('ignores non-PBRT exposuretime and white balance with warnings', async () => {
    const { settings, scene } = await load('Film "rgb" "float iso" 200 "float exposuretime" 20 "float whitebalance" 5500 Camera "perspective" "float shutteropen" .25 "float shutterclose" .75 WorldBegin Shape "sphere"');
    expect(settings.exposure).toBe(1);
    expect(scene.warnings).toContainEqual(expect.objectContaining({ handling:'Parameter exposuretime ignored' }));
    expect(scene.warnings).toContainEqual(expect.objectContaining({ handling:'White balance ignored' }));
  });
  it('reads diffuse transmittance and its default reflectance', async () => {
    const { root } = await load('WorldBegin Material "diffusetransmission" "rgb transmittance" [.2 .4 .8] Shape "sphere"');
    const m=(root.children.find(o=>(o as THREE.Mesh).isMesh) as THREE.Mesh).material as THREE.MeshPhysicalMaterial;
    expect(m.color.toArray()).toEqual([.25,.25,.25]);expect(m.transmission).toBe(.8);
    expect(m.userData.mutracerOpenPBR.transmissionColor).toEqual([.25,.5,1]);
  });
  it('face-forwards triangle winding to authored normals after orientation and reflection', async () => {
    for(const orientation of ['', 'ReverseOrientation', 'Scale -1 1 1', 'Scale -1 1 1 ReverseOrientation']) {
      const {root}=await load('WorldBegin '+orientation+' Shape "trianglemesh" "point3 P" [0 0 0 1 0 0 0 1 0] "normal N" [0 0 -1 0 0 -1 0 0 -1]');
      const g=(root.children.find(o=>(o as THREE.Mesh).isMesh) as THREE.Mesh).geometry;
      const p=g.attributes.position,n=g.attributes.normal,i=g.index!;
      const a=new THREE.Vector3().fromBufferAttribute(p,i.getX(0)),b=new THREE.Vector3().fromBufferAttribute(p,i.getX(1)),c=new THREE.Vector3().fromBufferAttribute(p,i.getX(2));
      expect(b.sub(a).cross(c.sub(a)).dot(new THREE.Vector3().fromBufferAttribute(n,0))).toBeGreaterThan(0);
    }
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
  it('warns when authored subsurface mean free paths reach the existing medium floor', async () => {
    const { scene } = await load('WorldBegin Material "subsurface" "rgb reflectance" [.5 .3 .2] "rgb mfp" [.0013 .00095 .00067] Shape "sphere"');
    expect(scene.warnings.some(w => w.handling.includes('below 0.001 scene units'))).toBe(true);
  });
  it('preserves interior homogeneous scattering, including zero absorption and high extinction', async () => {
    const { root } = await load('WorldBegin MakeNamedMedium "fog" "string type" "homogeneous" "rgb sigma_a" [0 .3 .4] "rgb sigma_s" [1 2 3] "float scale" 5 MediumInterface "fog" "" Material "interface" Shape "sphere"');
    const source = new THREE.Scene(); source.add(root);
    const params = packMaterialParams([fromTHREEScene(source).meshes[0].materials[0]]);
    [5,11.5,17].forEach((v,i)=>expect(params.mediumExtinction[0][i]).toBeCloseTo(v,5));
    [5,10,15].forEach((v,i)=>expect(params.mediumScattering[0][i]).toBeCloseTo(v,5));
  });
  it.each([['thindielectric',1],['diffusetransmission',.25]] as const)('retains %s transmission and thin-wall state through Three.js', async (type, weight) => {
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
  it.each(['conductor','coatedconductor'])('loads %s optical constants from SPD files and keeps layer roughness independent', async type => {
    const prefix = type === 'coatedconductor' ? 'conductor.' : '';
    const text = `WorldBegin Material "${type}" "spectrum ${prefix}eta" "eta.spd" "spectrum ${prefix}k" "k.spd" "float ${prefix}roughness" .002 "float interface.roughness" .02 "float interface.eta" 1.4 Shape "sphere"`;
    const reads: string[] = [], resolver = { async read(path: string) { reads.push(path); return new TextEncoder().encode(path==='eta.spd'?'400 1\n700 1\n':path==='k.spd'?'400 2\n700 2\n':text).buffer; } };
    const scene = await buildScene('main.pbrt',resolver), model = await convert(scene,resolver);
    const source = new THREE.Scene(); source.add(model.root);
    const m = fromTHREEScene(source).meshes[0].materials[0], expected = conductor([360,1,830,1],[360,2,830,2]);
    expected.base.forEach((v,i)=>expect(m.baseColor[i]).toBeCloseTo(v,6));
    expect(m.specularRoughness).toBeCloseTo(roughness(.002));
    expect(reads).toContain('eta.spd'); expect(reads).toContain('k.spd');
    if(type==='coatedconductor'){expect(m.coatRoughness).toBeCloseTo(roughness(.02));expect(m.coatIor).toBe(1.4);}
  });
  it('loads dielectric IOR and dispersion from an SPD file', async () => {
    const text = 'WorldBegin Material "dielectric" "spectrum eta" "glass.spd" Shape "sphere"';
    const resolver = { async read(path: string) { return new TextEncoder().encode(path==='glass.spd'?'486.13 1.52\n587.56 1.51\n656.27 1.50\n':text).buffer; } };
    const scene = await buildScene('main.pbrt',resolver), model = await convert(scene,resolver);
    const source = new THREE.Scene(); source.add(model.root);
    const m = fromTHREEScene(source).meshes[0].materials[0]; expect(m.specularIor).toBeCloseTo(1.51);expect(m.transmissionDispersionAbbeNumber).toBeCloseTo(25.5);
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

describe('PBRT target backend path limits', () => {
  it.each([['webgpu', 50], ['webgl', 20]] as const)('reports maxdepth truncation for %s', async (backend, limit) => {
    const resolver = {read: async () => new TextEncoder().encode('Integrator "path" "integer maxdepth" [100]\nWorldBegin Shape "sphere"').buffer};
    const scene = await buildScene('deep.pbrt', resolver);
    const model = await convert(scene, resolver, undefined, undefined, undefined, backend);
    expect(model.settings.bounces).toBe(limit);
    expect(scene.warnings).toContainEqual(expect.objectContaining({code: 'path-depth', file: 'deep.pbrt', line: 1, statement: 'Integrator', handling: expect.stringContaining(`depth ${limit}`)}));
    expect(model.root.userData.pbrtComparable).toBe(false);
  });
  it.each([['webgpu', 50], ['webgl', 20]] as const)('accepts the %s boundary without a truncation warning', async (backend, limit) => {
    const resolver = {read: async () => new TextEncoder().encode(`Integrator "path" "integer maxdepth" [${limit}] WorldBegin Shape "sphere"`).buffer};
    const scene = await buildScene('boundary.pbrt', resolver);
    const model = await convert(scene, resolver, undefined, undefined, undefined, backend);
    expect(model.settings.bounces).toBe(limit);
    expect(scene.warnings.some(w => w.code === 'path-depth')).toBe(false);
    expect(model.root.userData.pbrtComparable).toBe(true);
  });
});
