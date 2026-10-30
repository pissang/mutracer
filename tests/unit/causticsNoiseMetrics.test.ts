import {expect,it} from 'vitest';
// @ts-expect-error Evidence tools are executable ES modules.
import {noiseMetrics,noiseRMSE} from '../../scripts/caustics-noise-metrics.mjs';
// @ts-expect-error Evidence tools are executable ES modules.
import {displayLinear} from '../../scripts/caustics-study-color.mjs';
const image=(width=16,height=16)=>({width,height,data:new Float32Array(width*height*4).fill(.8)});
it('requires a reference at the actual capture resolution',()=>{
 const reference=image(8,8),candidate=image();
 expect(()=>noiseRMSE(candidate,reference,[0,1,2])).toThrow('exactly');
 expect(()=>noiseMetrics(candidate,candidate,reference,{patch:[0,1,2]})).toThrow('exactly');
});
it('compares OIDN to a transformed unfiltered HDR reference in the same space',()=>{
 const reference=image(),indices=Array.from({length:256},(_,i)=>i);
 const result=noiseMetrics(reference,displayLinear(reference),reference,{patch:indices});
 expect(result.rows[0].hdrRMSE).toBe(0);
 expect(result.rows[0].oidnRMSE).toBe(0);
 expect(result.rows[0].oidnD).toBe(0);
 expect(result.rows[0].oidnB).toBe(0);
});
it('retains pixel variance when signed regional errors cancel',()=>{
 const reference=image(),candidate=image(),indices=Array.from({length:256},(_,i)=>i);
 for(const i of indices)for(let c=0;c<3;c++)candidate.data[4*i+c]+=i%2?.2:-.2;
 expect(noiseRMSE(candidate,reference,indices)).toBeCloseTo(.25,6);
});
