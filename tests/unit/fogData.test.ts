import {describe, expect, it, vi} from 'vitest';
import {MAX_FOG_VOLUMES, type SceneFog} from '../../src/scene/SceneFog.js';
import {packFog} from '../../src/renderer/fogData.js';
import {SceneChangeDetector} from '../../src/renderer/sceneChangeDetector.js';
import {CommittedScene} from '../../src/renderer/committedScene.js';
import {makeRayTraceUniform} from '../../src/renderer/wgpuSceneUniform.js';
import {makeShaderDataDefinitions} from 'webgpu-utils';
import rayTraceCore from '../../src/renderer/wgsl/chunks/rayTraceCore.wgsl.js';
const volume = (): SceneFog => ({density: .2, bounds: {min: [-1, -2, -3], max: [1, 2, 3]}});
describe('fog scene contract', () => {
  it('resolves defaults, normalized shape, and GPU layout', () => {
    const packed = packFog([volume()]);
    expect(packed.count).toBe(1);
    expect(Array.from(packed.data.slice(16, 24))).toEqual([1, 1, 1, 0, Math.fround(.2), 0, -2, 0]);
    vi.stubGlobal('GPUShaderStage', {VERTEX: 1, FRAGMENT: 2, COMPUTE: 4});
    const uniform = makeRayTraceUniform();
    const definition = makeShaderDataDefinitions(rayTraceCore({hasFog: true})).structs.RayTraceUniform;
    expect(definition.fields.fogCount.offset).toBe(uniform.views.fogCount.byteOffset);
    expect(definition.fields.fogVolumes.offset).toBe(uniform.views.fogVolumes.byteOffset);
    expect(definition.size).toBe(uniform.buffer.byteLength);
    expect(makeShaderDataDefinitions(rayTraceCore({})).structs.RayTraceUniform.size).toBe(320);
  });
  it('computes lowest world Y of transformed boxes and ellipsoids', () => {
    const f = volume(); f.transform = [1, 1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 0, 0, 10, 0, 1];
    expect(packFog([f]).data[22]).toBe(4);
    f.shape = 'ellipsoid';
    expect(packFog([f]).data[22]).toBeCloseTo(10 - Math.sqrt(14));
  });
  it('rejects invalid inputs and enforces capacity', () => {
    for (const patch of [{density: -1}, {density: NaN}, {anisotropy: 1}, {heightFalloff: -1}, {baseHeight: Infinity}, {color: [1, 2, 0]}, {shape: 'sphere'}, {bounds: {min: [0, 0, 0], max: [0, 1, 1]}}, {transform: new Array(16).fill(0)}]) {
      expect(() => packFog([{...volume(), ...patch} as SceneFog])).toThrow(RangeError);
    }
    expect(packFog(Array.from({length: MAX_FOG_VOLUMES}, volume)).count).toBe(8);
    expect(() => packFog(Array.from({length: 9}, volume))).toThrow(RangeError);
  });
  it('tracks in-place edits and isolates committed snapshots', () => {
    const detector = new SceneChangeDetector(), snapshot = new CommittedScene();
    const scene = {meshes: [], lights: [], fog: [] as SceneFog[]};
    snapshot.capture(scene, detector.detect(scene)); detector.commit();
    scene.fog.push(volume());
    let change = detector.detect(scene);
    expect(change.fogStructure).toBe(true);
    snapshot.capture(scene, change); detector.commit();
    scene.fog[0].bounds.min[0] = -3;
    expect(snapshot.capture(scene, {...change, fog: false}).fog![0].bounds.min[0]).toBe(-1);
    change = detector.detect(scene);
    expect(change.fog).toBe(true); expect(change.fogStructure).toBe(false);
    detector.commit(); scene.fog.push(volume());
    expect(detector.detect(scene).fogStructure).toBe(false); detector.commit();
    scene.fog.length = 0;
    expect(detector.detect(scene).fogStructure).toBe(true);
  });
});
