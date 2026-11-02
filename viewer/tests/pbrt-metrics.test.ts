import { describe, expect, it } from 'vitest';
import { comparePixels, idBoundaryMask } from '../../scripts/pbrt-metrics.mjs';
describe('PBRT comparison statistics', () => {
  it('dilates ID boundaries one pixel in both directions', () => {
    const ids=new Uint32Array(8*4);for(let i=4;i<8;i++) ids[i*4+2]=1;
    expect(Array.from(idBoundaryMask(ids,8,1))).toEqual([0,0,1,1,1,1,0,0]);
  });
  it('excludes coverage errors from regional tests but retains whole-frame metrics', () => {
    const ids=new Uint32Array(32*4),mu=new Float32Array(32*4).fill(1),reference=mu.slice();
    for(let i=16;i<32;i++) ids[i*4+2]=1;
    for(const pixel of [15,16]) for(let c=0;c<3;c++) mu[pixel*4+c]=2;
    const result=comparePixels({mu,reference,ids,width:32,height:1,noiseA:mu.slice(),noiseB:reference.slice()});
    expect(result.frameStatus).toBe('mismatch');expect(result.regionStatus).toBe('within-estimated-noise');
  });
  it('retains measurements but skips strict verdicts for an incomparable scene', () => {
    const ids = new Uint32Array(64 * 4), reference = new Float32Array(64 * 4).fill(1), mu = reference.map(v => v * 2);
    for (let i = 32; i < 64; i++) ids[i * 4 + 2] = 1;
    const result = comparePixels({mu, reference, ids, width: 8, height: 8, noiseA: mu.slice(), noiseB: reference.slice(), approximateMaterialIds: [1], sceneComparable: false});
    expect(result.frameStatus).toBe('not-comparable'); expect(result.regionStatus).toBe('not-comparable');
    expect(result.comparisonErrors).toEqual([]);
    expect(result.regions.find(r => r.name === 'approximate')).toMatchObject({pixels: 64, approximate: true, meanBias: [1, 1, 1]});
    expect(result.regions.every(r => r.approximate)).toBe(true);
  });
  it('sums pixel variances before computing standard error and detects a mean shift', () => {
    const ids=new Uint32Array(64*4),reference=new Float32Array(64*4).fill(1),mu=reference.slice(),noiseA=reference.slice(),noiseB=reference.slice();
    for(let i=0;i<64;i++) for(let c=0;c<3;c++) {mu[i*4+c]+=.1;noiseA[i*4+c]+=.1+(i%2?.01:-.01);noiseB[i*4+c]+=(i%2?.01:-.01);}
    const result=comparePixels({mu,reference,ids,width:8,height:8,noiseA,noiseB});
    const frame=result.regions[0];expect(frame.noiseStandardError[0]).toBeCloseTo(.01/8,6);
    expect(frame.meanBiasZScore[0]).toBeCloseTo(80,3);expect(result.regionStatus).toBe('mismatch');
  });
});
