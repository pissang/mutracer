import Camera from '../../src/scene/Camera.js';
import {aovInstanceOrder, packAovScene} from '../../src/renderer/aovScene.js';
import {CommittedScene} from '../../src/renderer/committedScene.js';
import {SceneChangeDetector} from '../../src/renderer/sceneChangeDetector.js';
import {describe, expect, it} from 'vitest';
import {AovHistory, AOV_KINDS, AOV_LAYOUT, aovMask, validateAovId, type AovFrameSnapshot} from '../../src/renderer/aov.js';
import Mesh from '../../src/scene/Mesh.js';
import OpenPBRMaterial from '../../src/scene/OpenPBRMaterial.js';
import {createPlaneGeometry} from '../../src/util/commonGeometry.js';
import {HEADER} from '../../native/src/layout.js';

describe('AOV contract', () => {
  it('uses disjoint flags, bounded packed records and descriptor extension words', () => {
    expect(aovMask(AOV_KINDS.slice(0, 7))).toBe(127);
    expect(aovMask(['diffuseColor', 'specularColor'])).toBe(384);
    expect(aovMask(['diffuseAlbedo', 'specularColor'])).toBe(264);
    expect(() => aovMask(['diffuseAlbedo', 'diffuseColor'])).toThrow(RangeError);
    expect(() => aovMask(['specularAlbedo', 'specularColor'])).toThrow(RangeError);
    expect(aovMask(['id', 'id', 'motion'])).toBe(96);
    expect(AOV_LAYOUT.accumulatedBytes).toBe(16 * Float32Array.BYTES_PER_ELEMENT);
    expect(AOV_LAYOUT.centerBytes).toBe(8 * Uint32Array.BYTES_PER_ELEMENT);
    expect([HEADER.MESH_AOV_IDS, HEADER.MATERIAL_AOV_IDS, HEADER.WORDS]).toEqual([24, 25, 32]);
    expect(() => aovMask(['missing' as never])).toThrow();
  });
  it('keeps linear hardware instances in source order without a software TLAS', () => {
    expect(Array.from(aovInstanceOrder({buffer:new ArrayBuffer(0),maxDepth:0,instancesBuffer:new ArrayBuffer(3*160)}))).toEqual([0,1,2]);
  });
  it('packs a resident-tail prefix with the same identities, offsets and camera history as a full scene', () => {
    const material = new OpenPBRMaterial({aovId: 0x800001ff}), camera = new Camera({projection: 'perspective'});
    const source = {instances: [], instanceBindings: [], materials: [material], geometries: [], blases: []};
    const tlas = {buffer: new ArrayBuffer(0), maxDepth: 0};
    const history = new AovHistory(), primitives = new Uint32Array([0xffffffff, 19, 7]);
    for (let frame = 0; frame < 2; frame++) {
      const full = packAovScene(source, tlas, camera, 48, 32, history, primitives);
      const prefix = packAovScene(source, tlas, camera, 48, 32, history, primitives, false);
      expect(prefix.words.length).toBe(full.words[17]);
      expect(prefix.words).toEqual(full.words.slice(0, prefix.words.length));
      expect(prefix.frame).toEqual(full.frame);
      const joined = new Uint32Array(prefix.words.length + primitives.length);
      joined.set(prefix.words); joined.set(primitives, prefix.words.length);
      expect(joined).toEqual(full.words);
      history.accept(full.frame); camera.transform[12] += .25;
    }
  });
  it('allocates distinct IDs across meshes and materials and accepts explicit zero', () => {
    const m = new OpenPBRMaterial();
    const mesh = new Mesh(createPlaneGeometry(), m);
    const other = new OpenPBRMaterial({aovId: 0});
    expect(mesh.aovId).not.toBe(m.aovId);
    expect(other.aovId).toBe(0);
    expect(validateAovId(0)).toBe(0);
    for (const id of [-1, 1.5, NaN, 0xffffffff, 0x100000000]) expect(() => validateAovId(id)).toThrow();
  });
  it('preserves stable identities through committed mirrors and detects ID edits', () => {
    const material = new OpenPBRMaterial(), mesh = new Mesh(createPlaneGeometry(), material);
    const scene = {meshes: [mesh], lights: []}, detector = new SceneChangeDetector(), committed = new CommittedScene();
    const first = committed.capture(scene, detector.detect(scene)); detector.commit();
    expect(first.meshes[0].aovId).toBe(mesh.aovId);
    expect(first.meshes[0].materials[0].aovId).toBe(material.aovId);
    mesh.aovId = 101; material.aovId = 202;
    const changes = detector.detect(scene);
    expect(changes.meshes).toBe('full'); expect(changes.materials).toEqual([material]);
    committed.capture(scene, changes); detector.commit();
    expect(first.meshes[0].aovId).toBe(101); expect(first.meshes[0].materials[0].aovId).toBe(202);
  });
  it('validates mesh ID assignments without changing the last accepted identity', () => {
    const mesh = new Mesh(createPlaneGeometry(), new OpenPBRMaterial());
    for (const id of [0, 0x800001ff, 0xfffffffe]) {
      mesh.aovId = id;
      expect(mesh.aovId).toBe(id);
      for (const invalid of [-1, 1.5, NaN, Infinity, 0xffffffff, 0x100000000]) {
        expect(() => { mesh.aovId = invalid; }).toThrow(RangeError);
        expect(mesh.aovId).toBe(id);
      }
    }
  });
  it('owns history snapshots and matches rigid motion by stable identity', () => {
    const history = new AovHistory();
    const frame: AovFrameSnapshot = {width: 32, height: 16, projection: 'p', viewProjection: new Float32Array(16),
      instances: [{object: 9, instance: 0, topology: 1, vertices: 1, transform: new Float32Array(16)}]};
    expect(history.previous(frame)).toBeUndefined();
    history.accept(frame);
    frame.instances[0].transform[12] = 3;
    expect(history.match(frame, frame.instances[0])?.transform[12]).toBe(0);
    expect(history.match(frame, {...frame.instances[0], object: 10})).toBeUndefined();
    expect(history.match(frame, {...frame.instances[0], vertices: 2})).toBeUndefined();
    expect(history.match(frame, {...frame.instances[0], topology: 2})).toBeUndefined();
    for (const changed of [{width: 33}, {height: 17}, {projection: 'o'}]) expect(history.previous({...frame, ...changed})).toBeUndefined();
    history.clear();
    expect(history.previous(frame)).toBeUndefined();
  });
});
