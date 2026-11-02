import {expect,it} from 'vitest';
import {gradientNoise,noiseMask,noiseVectors,volumeFbm} from '../fixtures/volumeNoiseReference';
it('has continuous gradients across lattice boundaries and bounded density masks',()=>{
  for(const p of noiseVectors)for(const octaves of [1,4,6]) {
    const f=volumeFbm(p,octaves);expect(f).toBeGreaterThanOrEqual(0);expect(f).toBeLessThanOrEqual(1);
    expect(noiseMask(p,[1,2,3],[0,0,0],1,0,octaves)).toBe(1);
  }
  for(const x of [-2,-1,0,1,2])expect(Math.abs(gradientNoise([x-1e-6,.3,.7])-gradientNoise([x+1e-6,.3,.7]))).toBeLessThan(1e-5);
  expect(volumeFbm([0,0,0])).toBe(.5);
});
