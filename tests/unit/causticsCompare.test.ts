import {expect,it} from 'vitest';
// @ts-expect-error Evidence tools are executable ES modules.
import {statistics,boxDownsample,resampleReference,compare} from '../../scripts/caustics-compare.mjs';
it('reports a hot pixel separately without dropping it from another image',()=>{
 const values=Array(1000).fill(2);values[999]=100000;
 const s=statistics(values,.001,3);
 expect(s.median).toBe(2);expect(s.trimmedMean).toBe(2);expect(s.clampedMean).toBe(2.001);expect(s.rawMean).toBeGreaterThan(100);
});
it('box averages every reference sample and rejects resampling ambiguity',()=>{
 const image={width:2,height:2,data:new Float32Array([1,2,3,1,3,4,5,1,5,6,7,1,7,8,9,1])};
 expect(Array.from(boxDownsample(image,1,1).data)).toEqual([4,5,6,1]);
 expect(()=>boxDownsample(image,3,3)).toThrow();
});
it('keeps fixed masks independent of candidate brightness',()=>{
 const image={width:256,height:256,data:new Float32Array(256*256*4).fill(1)};
 const bright={...image,data:new Float32Array(image.data).fill(100)};
 const result=compare(image,[{path:'a',image},{path:'b',image:bright}]);
 expect(result.masks.underwaterBackWall.pixels).toBe(113*60);
 expect(result.rows[0].candidate.pixels).toBe(result.rows[1].candidate.pixels);
 expect(result.rows[1].relativeError.rawMean).toBe(99);
});

it('area resampling preserves constants and reports structure differences on a fixed mask',()=>{
 const image={width:4,height:4,data:new Float32Array(64).fill(2)};
 expect(Array.from(resampleReference(image,3,3).data)).toEqual(Array(36).fill(2));
 const result=compare(image,[{path:'same',image:resampleReference(image,3,3)}],{masks:{patch:[0,1,3,4]}});
 expect(result.rows[0].logRMSE).toBe(0);expect(result.rows[0].gradientRMSE).toBe(0);
 const shifted={width:4,height:4,data:new Float32Array(image.data)};shifted.data[4]=8;
 expect(compare(image,[{path:'changed',image:shifted}],{masks:{patch:[0,1,4,5]}}).rows[0].gradientRMSE).toBeGreaterThan(0);
});

it('separates uniform bias from low-frequency blotches without light spill',()=>{
 const image={width:16,height:16,data:new Float32Array(16*16*4).fill(1)};
 const shifted={...image,data:new Float32Array(image.data).fill(2)};
 const masks={patch:Array.from({length:64},(_,i)=>(Math.floor(i/8)+4)*16+i%8+4)};
 shifted.data[0]=100000;
 const row=compare(image,[{path:'bias',image:shifted}],{masks,gaussianSigma:2}).rows[0];
 expect(row.lowFrequencyRelativeRMSE).toBeCloseTo(1);
 expect(row.blotchRelativeRMS).toBeCloseTo(0);
 for(const i of masks.patch)for(let c=0;c<3;c++)shifted.data[i*4+c]=i%16<8?1:3;
 expect(compare(image,[{path:'blotch',image:shifted}],{masks,gaussianSigma:2}).rows[0].blotchRelativeRMS).toBeGreaterThan(.1);
});
