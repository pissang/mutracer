import {expect, it, vi} from 'vitest';
import WebGLRayTracePass from '../../src/renderer/WebGLRayTracePass';
import OpenPBRMaterial from '../../src/scene/OpenPBRMaterial';
import MaterialTable from '../../src/renderer/MaterialTable';
import {createSphereGeometry} from '../../src/util/commonGeometry';
import createRayTraceFragmentShader from '../../src/renderer/glsl/rayTrace.frag';
import type {FragmentShader} from '../../src/renderer/shader';

it('requests asynchronous programs and removes volumes bindings on both specialization transitions', () => {
  const setShader = vi.fn(), setUniforms = vi.fn(), setDefines = vi.fn();
  const receiver = {_hasVolumes: false, _mainPass: {setShader, setUniforms, setDefines}};
  const setVolumes = WebGLRayTracePass.prototype.setVolumes.bind(receiver as unknown as WebGLRayTracePass);
  const volumes = [{density: .5, bounds: {min: [-1, -1, -1] as [number, number, number], max: [1, 1, 1] as [number, number, number]}}];
  for (let repeat = 0; repeat < 3; repeat++) {
    setVolumes(volumes);
    const enabled = setShader.mock.lastCall!;
    expect((enabled[0] as FragmentShader).parallelCompile).toBe(true);
    expect(setUniforms.mock.lastCall![0].volumeCount).toBe(1);
    setVolumes(volumes);
    expect(setShader).toHaveBeenCalledTimes(repeat * 2 + 1);
    setVolumes([]);
    const disabled = setShader.mock.lastCall!;
    expect((disabled[0] as FragmentShader).parallelCompile).toBe(true);
    expect(disabled[1]).toEqual(['volumeCount', 'volumeWorldToLocal', 'volumeColorAnisotropy', 'volumeParams', 'volumeNoiseSizeOctaves', 'volumeNoiseOffsetCoverage', 'volumeNoiseParams']);
    expect(disabled[2]).toEqual(['HAS_VOLUMES', 'HAS_VOLUME_NOISE']);
  }
});

it('retains volume support when spectral materials enter and leave the scene', () => {
  const setShader = vi.fn(), setDefines = vi.fn();
  const receiver = {_hasVolumes: true, _hasVolumeNoise: true, _spectral: false,
    _mainPass: {setShader}, _tracePasses: [{setDefines}], _bevelSamples: 4};
  const update = (WebGLRayTracePass.prototype as any)._updateMaterialConstants.bind(receiver);
  const table = {defines: {}, setToPass: vi.fn()} as unknown as MaterialTable;
  const geometry = createSphereGeometry(4, 2);
  update([new OpenPBRMaterial({transmissionDispersionScale: 1})], table, geometry);
  const spectral = setShader.mock.lastCall![0] as FragmentShader;
  expect(spectral.parallelCompile).toBe(true);
  expect(spectral.defines.HAS_VOLUMES).toBe(true);
  expect(spectral.defines.HAS_VOLUME_NOISE).toBe(true);
  update([new OpenPBRMaterial({transmissionDispersionScale: 1})], table, geometry);
  expect(setShader).toHaveBeenCalledTimes(1);
  update([new OpenPBRMaterial()], table, geometry);
  const ordinary = setShader.mock.lastCall![0] as FragmentShader;
  expect(ordinary.main).toBe(createRayTraceFragmentShader({hasVolumes: true, hasVolumeNoise: true}).main);
  expect(setShader).toHaveBeenCalledTimes(2);
});
