import {expect,it} from 'vitest';
import {prepareWebGLLightSampling} from '../../src/renderer/webglLightSampling';
import {collectEmissiveTriangles} from '../../src/renderer/lightSampling';
import {createPlaneGeometry} from '../../src/util/commonGeometry';
import Mesh from '../../src/scene/Mesh';
import OpenPBRMaterial from '../../src/scene/OpenPBRMaterial';
import RectLight from '../../src/scene/RectLight';
it('keeps millimetre HDR emitters finite and normalizes mixed-source PMFs',()=>{
 const material=new OpenPBRMaterial({emissionLuminance:541126.75});
 const mesh=new Mesh(createPlaneGeometry(),material);mesh.transform[0]=.0025;mesh.transform[10]=.002;
 const triangles=collectEmissiveTriangles([{mesh,geometry:mesh.geometry,materialIndices:[0]}],[material]);
 const result=prepareWebGLLightSampling([new RectLight({intensity:2})],triangles,1);
 expect(triangles.reduce((sum,t)=>sum+t.area,0)).toBeCloseTo(.005*.004,10);
 expect(result.totalWeight).toBeGreaterThan(10);
 let pmf=0;const ints=new Int32Array(result.data.buffer),types=new Set<number>();
 for(let i=0;i<result.choiceCount;i++) {
   const offset=(result.emissiveTexels+i)*4;types.add(ints[offset+2]);
   expect(ints[offset+1]).toBeLessThan(result.choiceCount);
   const value=result.data[(result.pmfOffset+i)*4];expect(value).toBeGreaterThan(0);pmf+=value;
 }
 expect(types).toEqual(new Set([1,2,3]));expect(pmf).toBeCloseTo(1,6);
 expect(result.data.every(Number.isFinite)).toBe(true);
});
