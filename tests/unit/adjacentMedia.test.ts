import {describe, expect, it} from 'vitest';
import OpenPBRMaterial from '../../src/scene/OpenPBRMaterial';
import {packMaterialParams} from '../../src/renderer/materialParams';

describe('adjacent dielectric media', () => {
  const liquid = new OpenPBRMaterial({transmissionWeight: 1, transmissionDepth: .06, transmissionColor: [.8, .5, .2]});
  const wall = new OpenPBRMaterial({transmissionWeight: 1});

  it('packs liquid extinction separately from both glass walls', () => {
    const packed = packMaterialParams([wall, liquid, wall]);
    expect(packed.mediumExtinction[0]).toEqual([0, 0, 0]);
    expect(packed.mediumExtinction[2]).toEqual([0, 0, 0]);
    packed.mediumExtinction[1].forEach((sigma, c) => {
      expect(Math.exp(-sigma * .06)).toBeCloseTo(liquid.transmissionColor[c], 8);
    });
  });
});
