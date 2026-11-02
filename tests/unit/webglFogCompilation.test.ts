import {expect, it, vi} from 'vitest';
import WebGLRayTracePass from '../../src/renderer/WebGLRayTracePass';
import type {FragmentShader} from '../../src/renderer/shader';

it('requests asynchronous programs and removes fog bindings on both specialization transitions', () => {
  const setShader = vi.fn(), setUniforms = vi.fn(), setDefines = vi.fn();
  const receiver = {_hasFog: false, _mainPass: {setShader, setUniforms, setDefines}};
  const setFog = WebGLRayTracePass.prototype.setFog.bind(receiver as unknown as WebGLRayTracePass);
  const fog = [{density: .5, bounds: {min: [-1, -1, -1] as [number, number, number], max: [1, 1, 1] as [number, number, number]}}];
  for (let repeat = 0; repeat < 3; repeat++) {
    setFog(fog);
    const enabled = setShader.mock.lastCall!;
    expect((enabled[0] as FragmentShader).parallelCompile).toBe(true);
    expect(setUniforms.mock.lastCall![0].fogCount).toBe(1);
    setFog(fog);
    expect(setShader).toHaveBeenCalledTimes(repeat * 2 + 1);
    setFog([]);
    const disabled = setShader.mock.lastCall!;
    expect((disabled[0] as FragmentShader).parallelCompile).toBe(true);
    expect(disabled[1]).toEqual(['fogCount', 'fogWorldToLocal', 'fogColorAnisotropy', 'fogParams']);
    expect(disabled[2]).toEqual(['HAS_FOG']);
  }
});
