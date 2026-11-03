import { describe, expect, it } from 'vitest';
import { mat4 } from 'gl-matrix';
import { packCameraUniform } from '../../src/renderer/cameraUniform.js';
import { cameraParameters, materialParameters } from '../../native/src/render-core.js';

describe('shared native/browser camera block', () => {
  const world = new Float32Array(16);
  mat4.targetTo(world, [0, 2.4, 6], [0, .4, -.3], [0, 1, 0]);
  const projection = mat4.perspective(new Float32Array(16), 40 * Math.PI / 180, 1.5, .1, 100);
  const inverse = new Float32Array(16);
  mat4.invert(inverse, projection);
  mat4.mul(inverse, world, inverse);

  it('preserves the original matrix/lens byte layout including zero padding', () => {
    const expected = new Float32Array([...inverse, ...world, .025, 7.5, 0, 0]);
    const actual = packCameraUniform(inverse, world, .025, 7.5);
    expect(new Uint8Array(actual.buffer)).toEqual(new Uint8Array(expected.buffer));
  });

  it('translates in world space and preserves the lens parameters', () => {
    const base = packCameraUniform(inverse, world, .025, 7.5);
    const actual = new Float32Array(cameraParameters(new Uint8Array(base.buffer), .7, .2, -.4).buffer);
    const translated = mat4.clone(world);
    translated[12] += .7; translated[13] += .2; translated[14] -= .4;
    const expectedInverse = new Float32Array(16);
    mat4.invert(expectedInverse, projection);
    mat4.mul(expectedInverse, translated, expectedInverse);
    const expected = packCameraUniform(expectedInverse, new Float32Array(translated), .025, 7.5);
    actual.forEach((value, index) => expect(value).toBeCloseTo(expected[index], 5));
    expect(base[28]).toBe(world[12]);
  });

  it('preserves the material patch values in the wire format', () => {
    const actual = materialParameters(.1, .8, .2, .9);
    expect([...new Float32Array(actual.buffer)]).toEqual([...new Float32Array([.1, .8, .2, .9])]);
  });
});
