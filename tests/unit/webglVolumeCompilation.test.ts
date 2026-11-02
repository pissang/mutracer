import {expect, it, vi} from 'vitest';
import WebGLRayTracePass from '../../src/renderer/WebGLRayTracePass';
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
