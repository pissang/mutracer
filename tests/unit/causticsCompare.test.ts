import {expect,it} from 'vitest';
// @ts-expect-error Evidence tools are executable ES modules.
import {statistics,boxDownsample,resampleReference,compare,blotchStatistics,denoisedBlotchStatistics,cornellBlotchMasks} from '../../scripts/caustics-compare.mjs';
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
 expect(result.masks.patch.indices).toEqual([0,1,3,4]);
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


it('distinguishes equally energetic correlated and independent errors',()=>{
 const width=128,height=96,ref={width,height,data:new Float32Array(width*height*4).fill(1)};
 const independent={...ref,data:new Float32Array(ref.data)},correlated={...ref,data:new Float32Array(ref.data)};
 let seed=19;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2**32-.5;};
 const noise=Array.from({length:width*height},random),indices=noise.map((_,i)=>i);
 // A fixed disk average creates a correlated field without sharing metric code.
 const field=noise.map((_,i)=>{let sum=0,n=0;const x=i%width,y=Math.floor(i/width);for(let dy=-4;dy<=4;dy++)for(let dx=-4;dx<=4;dx++)if(dx*dx+dy*dy<=16&&x+dx>=0&&x+dx<width&&y+dy>=0&&y+dy<height){sum+=noise[(y+dy)*width+x+dx];n++;}return sum/n;});
 const rms=(a:number[])=>Math.sqrt(a.reduce((s,v)=>s+v*v,0)/a.length);
 const an=.1/rms(noise),bn=.1/rms(field);
 for(const i of indices)for(let c=0;c<3;c++){independent.data[i*4+c]+=noise[i]*an;correlated.data[i*4+c]+=field[i]*bn;}
 const a=blotchStatistics(independent,ref,indices,3),b=blotchStatistics(correlated,ref,indices,3);
 expect(b.residualRelativeRMS/a.residualRelativeRMS).toBeCloseTo(1,1);
 expect(b.blotchRelativeRMS).toBeGreaterThan(a.blotchRelativeRMS*4);
 expect(b.autocorrelation[1].value).toBeGreaterThan(.7);
 const ca=denoisedBlotchStatistics(independent,independent,ref,indices,1.5),cb=denoisedBlotchStatistics(correlated,correlated,ref,indices,1.5);
 expect(cb.correlatedCloudRelativeRMS).toBeGreaterThan(ca.correlatedCloudRelativeRMS*4);
 expect(Math.abs(a.autocorrelation[1].value)).toBeLessThan(.05);
 const clean=blotchStatistics(ref,ref,indices,3);expect(clean.blotchRelativeRMS).toBe(0);
});
it('scales fixed cloud regions with the authored vertical field of view',()=>{
 const a=cornellBlotchMasks(960,544,{verticalFov:true}),b=cornellBlotchMasks(1920,1088,{verticalFov:true});
 expect(a.ceilingWhole).not.toContain(44*960+478);
 expect(Object.keys(a)).toEqual(['aboveWaterWallUpperLeft','aboveWaterWallWhole','ceilingWhole']);
 for(const name of Object.keys(a))expect(b[name].length/a[name].length).toBeCloseTo(4,0);
});

it('keeps pixel error when opposite residuals cancel in a regional energy mean',()=>{
 const image={width:4,height:4,data:new Float32Array(64).fill(1)};
 const noisy={...image,data:new Float32Array(image.data)};
 for(let i=0;i<16;i++)for(let c=0;c<3;c++)noisy.data[i*4+c]+=i%2?.25:-.25;
 const row=compare(image,[{path:'balanced',image:noisy}],{masks:{patch:Array.from({length:16},(_,i)=>i)}}).rows[0];
 expect(row.relativeError.rawMean).toBe(0);
 expect(row.trimmedRelativeMAE).toBeCloseTo(.25);
});
