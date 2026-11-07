import { getRectLightArea, getSphereLightArea, getDiskLightArea, getCylinderLightArea } from '../../src/renderer/lightsUtil.js';
import {DiskLight, CylinderLight} from '../../src/main.js';
import { mat4 } from '../../src/math';
import { describe, expect, it } from 'vitest';
import DirectionalLight from '../../src/scene/DirectionalLight';
import RectLight from '../../src/scene/RectLight';
import SphereLight from '../../src/scene/SphereLight';
import { packLightsToBuffer } from '../../src/renderer/lightsUtil';

describe('analytic lights', () => {
  it('computes emitter areas', () => {
    expect(getRectLightArea(new RectLight({size: [2, 4]}))).toBe(8);
    expect(
      getSphereLightArea(Object.assign(new SphereLight({color: undefined, intensity: undefined, radius: 2}), {position: [0, 0, 0]}))
    ).toBeCloseTo(16 * Math.PI);
  });

  it('packs UsdLux-shaped disk and cylinder geometry and normalization', () => {
    const disk = new DiskLight({radius: 2, intensity: 8, normalize: true});
    const cylinder = new CylinderLight({radius: 2, length: 3, intensity: 12, normalize: true, treatAsLine: true});
    expect(getDiskLightArea(disk)).toBeCloseTo(4 * Math.PI);
    expect(getCylinderLightArea(cylinder)).toBeCloseTo(12 * Math.PI);
    const packed = packLightsToBuffer([disk, cylinder], [-1, -1]);
    expect(packed[4]).toBeCloseTo(8 / (4 * Math.PI));
    expect(packed[24 + 4]).toBeCloseTo(12 / (12 * Math.PI));
    expect(packed[18]).toBe(5);
    expect(packed[24 + 18]).toBe(6);
  });

  it('packs position, emission and type for the renderer', () => {
    const rect = new RectLight({size: [2, 3], color: [0.5, 1, 0.25], intensity: 4});
    mat4.translate(rect.transform, rect.transform, [1, 2, 3]);
    const directional = Object.assign(new DirectionalLight({color: [1, 1, 1], intensity: 2}), {position: [4, 5, 6]}).lookAt([0, 0, 0]);
    const buffer = packLightsToBuffer([rect, directional], [-1, -1]);

    expect(Array.from(buffer.slice(0, 3))).toEqual([1, 2, 3]);
    expect(Array.from(buffer.slice(4, 7))).toEqual([2, 4, 1]);
    expect(buffer).toHaveLength(48);
  });

  it('packs light-selection PMFs and CDFs for MIS', () => {
    const lights = [
      Object.assign(new DirectionalLight({}), {position: [0, 1, 0]}).lookAt([0, 0, 0]),
      Object.assign(new DirectionalLight({}), {position: [1, 0, 0]}).lookAt([0, 0, 0])
    ];
    const buffer = packLightsToBuffer(
      lights,
      [-1, -1],
      [0.25, 0.75],
      [0.25, 1]
    );

    expect(buffer[3]).toBeCloseTo(0.25);
    expect(buffer[7]).toBeCloseTo(0.25);
    expect(buffer[27]).toBeCloseTo(0.75);
    expect(buffer[31]).toBeCloseTo(1);
  });
});
