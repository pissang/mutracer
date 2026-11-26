import {describe, expect, it} from 'vitest';
import {OfflineGeometryHistory} from '../../src/temporal/offlineSamplePlan.js';

type Frame = Parameters<OfflineGeometryHistory['add']>[0];

function geometry(includeOptics: boolean, reflectionMotion: boolean): Frame {
  const values = new Float32Array(reflectionMotion ? 48 : 32);
  const words = new Uint32Array(values.buffer);
  for (let i = 0; i < 2; i++) {
    const surface = i * 8, primary = surface + 16;
    words[surface] = i + 1;
    values[surface + 7] = 2;
    values[primary + 2] = 1;
    values[primary + 3] = 2;
    values[primary + 4] = i;
    values[primary + 6] = -2;
    values[primary + 7] = 1;
    if (reflectionMotion) {
      const reflected = primary + 16;
      words[reflected] = 3;
      values[reflected + 2] = 4;
    }
  }
  return {values, words, stride: 2, rows: 1, left: 0, top: 0,
    eye: [0, 0, 0], direction: undefined, focalLength: 100, apertureRadius: 0,
    material: includeOptics ? new Float32Array([.04, 1, 0, 1, .5, 0, 0, 1]) : undefined};
}

function targets(includeOptics: boolean, reflectionMotion = false) {
  const history = new OfflineGeometryHistory(2, 1);
  for (let i = 0; i < 5; i++) history.add(geometry(includeOptics, reflectionMotion));
  return [...history.samplePlans(8, 4, 3, 3.9, 2, 10)[2].targets];
}

describe('offline sample prediction', () => {
  it('spends extra samples where the metal surface window rejects valid geometry', () => {
    expect(targets(false)).toEqual([3, 3]);
    expect(targets(true)).toEqual([4, 3]);
  });

  it('keeps the base count on metal with a valid planar virtual image', () => {
    expect(targets(true, true)).toEqual([3, 3]);
  });
});
