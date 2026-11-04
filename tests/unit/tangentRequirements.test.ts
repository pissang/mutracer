import {expect, it} from 'vitest';
import Geometry, {Attribute} from '../../src/scene/Geometry.js';
import Mesh from '../../src/scene/Mesh.js';
import OpenPBRMaterial from '../../src/scene/OpenPBRMaterial.js';
import Texture from '../../src/scene/Texture.js';
import {ensureMeshGeometryAttributes} from '../../src/renderer/prepareMeshBVH.js';
import {SceneChangeDetector} from '../../src/renderer/sceneChangeDetector.js';
import {materialNeedsVertexTangents} from '../../src/renderer/tangentRequirements.js';

function geometry() {
  return new Geometry({position:new Attribute(new Float32Array([0,0,0, 1,0,0, 0,1,0]),3),
    uv:new Attribute(new Float32Array([0,0, 1,0, 0,1]),2)});
}
it('generates tangents when a material switch adds the first consumer, before change detection', () => {
  const source = geometry(), material = new OpenPBRMaterial(), mesh = new Mesh(source, material);
  const detector = new SceneChangeDetector(), scene = {meshes:[mesh], lights:[]};
  ensureMeshGeometryAttributes(scene.meshes);
  expect(source.tangent).toBeUndefined();
  detector.detect(scene); detector.commit();
  material.specularRoughnessAnisotropy = .5;
  ensureMeshGeometryAttributes(scene.meshes);
  expect(source.tangent!.array).toEqual(new Float32Array([1,0,0, 1,0,0, 1,0,0]));
  expect(detector.detect(scene).meshes).toBe('full');
  const generated = source.tangent;
  material.specularRoughnessAnisotropy = 0;
  ensureMeshGeometryAttributes(scene.meshes);
  expect(source.tangent).toBe(generated);
});
it('unions shared-geometry and multiple-material requirements and preserves authored tangents', () => {
  const source = geometry(), ordinary = new OpenPBRMaterial(), coat = new OpenPBRMaterial();
  coat.coatRoughnessAnisotropy = .5;
  ensureMeshGeometryAttributes([new Mesh(source, ordinary),new Mesh(source, [ordinary,coat])]);
  expect(source.tangent).toBeDefined();
  const authored = new Attribute(new Float32Array([0,1,0,1, 0,1,0,1, 0,1,0,1]),4);
  source.tangent = authored;
  ensureMeshGeometryAttributes([new Mesh(source, coat)]);
  expect(source.tangent).toBe(authored);
});
it('uses UV differentials for base normal maps and vertex frames for active coat normal maps', () => {
  const material = new OpenPBRMaterial();
  const map = new Texture({width:1,height:1,data:new Uint8Array([128,128,255,255])});
  material.normalMap = map;
  expect(materialNeedsVertexTangents(material)).toBe(false);
  material.coatNormalMap = map;
  expect(materialNeedsVertexTangents(material)).toBe(false);
  material.coatWeight = 1;
  expect(materialNeedsVertexTangents(material)).toBe(true);
});
