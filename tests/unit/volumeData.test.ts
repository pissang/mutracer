import {describe, expect, it, vi} from 'vitest';
import {MAX_VOLUMES, type SceneVolume} from '../../src/scene/SceneVolume.js';
import {packVolumes} from '../../src/renderer/volumeData.js';
import {SceneChangeDetector} from '../../src/renderer/sceneChangeDetector.js';
import {CommittedScene} from '../../src/renderer/committedScene.js';
import {makeWebRayTraceUniform as makeRayTraceUniform} from '../../src/renderer/wgpuSceneUniform.js';
import {makeShaderDataDefinitions} from 'webgpu-utils';
import rayTraceCore from '../../src/renderer/wgsl/chunks/rayTraceCore.wgsl.js';
const volume = (): SceneVolume => ({density: .2, bounds: {min: [-1, -2, -3], max: [1, 2, 3]}});
describe('volumes scene contract', () => {
  it('resolves defaults, normalized shape, and GPU layout', () => {
    const packed = packVolumes([volume()]);
    expect(packed.count).toBe(1);
    expect(Array.from(packed.data.slice(16, 24))).toEqual([1, 1, 1, 0, Math.fround(.2), 0, -2, 0]);
    vi.stubGlobal('GPUShaderStage', {VERTEX: 1, FRAGMENT: 2, COMPUTE: 4});
    const uniform = makeRayTraceUniform();
    const definition = makeShaderDataDefinitions(rayTraceCore({hasVolumes: true})).structs.RayTraceUniform;
    expect(definition.fields.volumeCount.offset).toBe(uniform.views.volumeCount.byteOffset);
    expect(definition.fields.volumeRecords.offset).toBe(uniform.views.volumeRecords.byteOffset);
    expect(definition.size).toBe(uniform.buffer.byteLength);
    expect(makeShaderDataDefinitions(rayTraceCore({})).structs.RayTraceUniform.size).toBe(320);
  });
  it('computes lowest world Y of transformed boxes and ellipsoids', () => {
    const f = volume(); f.transform = [1, 1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 0, 0, 10, 0, 1];
    expect(packVolumes([f]).data[22]).toBe(4);
    f.shape = 'ellipsoid';
    expect(packVolumes([f]).data[22]).toBeCloseTo(10 - Math.sqrt(14));
  });
  it('rejects invalid inputs and enforces capacity', () => {
    for (const patch of [{density: -1}, {density: NaN}, {anisotropy: null}, {color: null}, {transform: null}, {anisotropy: 1}, {heightFalloff: -1}, {baseHeight: Infinity}, {color: [1, 2, 0]}, {shape: 'sphere'}, {bounds: {min: [0, 0, 0], max: [0, 1, 1]}}, {transform: new Array(16).fill(0)}]) {
      expect(() => packVolumes([{...volume(), ...patch} as SceneVolume])).toThrow(RangeError);
    }
    expect(packVolumes(Array.from({length: MAX_VOLUMES}, volume)).count).toBe(8);
    expect(() => packVolumes(Array.from({length: 9}, volume))).toThrow(RangeError);
  });
  it('tracks in-place edits and isolates committed snapshots', () => {
    const detector = new SceneChangeDetector(), snapshot = new CommittedScene();
    const scene = {meshes: [], lights: [], volumes: [] as SceneVolume[]};
    snapshot.capture(scene, detector.detect(scene)); detector.commit();
    scene.volumes.push(volume());
    let change = detector.detect(scene);
    expect(change.volumeStructure).toBe(true);
    snapshot.capture(scene, change); detector.commit();
    scene.volumes[0].bounds.min[0] = -3;
    expect(snapshot.capture(scene, {...change, volumes: false}).volumes![0].bounds.min[0]).toBe(-1);
    change = detector.detect(scene);
    expect(change.volumes).toBe(true); expect(change.volumeStructure).toBe(false);
    detector.commit(); scene.volumes.push(volume());
    expect(detector.detect(scene).volumeStructure).toBe(false); detector.commit();
    scene.volumes.length = 0;
    expect(detector.detect(scene).volumeStructure).toBe(true);
  });
});

it('uploads WebGL matrix arrays without scalar conversion', async () => {
  const {WebGLProgramBindings} = await import('../../src/renderer/webgl.js');
  const {FragmentShader, Shader} = await import('../../src/renderer/shader.js');
  const matrices = new Float32Array(128);
  const upload = vi.fn();
  const bindings = new WebGLProgramBindings(new FragmentShader({uniforms: {worldToLocal: Shader.arrayUniform('mat4', 8, matrices)}, main: ''}));
  const gl = {useProgram() {}, getUniformLocation: () => 'location', uniformMatrix4fv: upload};
  bindings.bind({gl, createProgram: () => ({}), isProgramCompiled: () => true} as any);
  expect(upload).toHaveBeenCalledWith('location', false, matrices);
});
