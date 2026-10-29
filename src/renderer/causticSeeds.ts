import {EmissiveTriangleCache,type EmissiveTriangle,type EmissiveMeshBinding} from './lightSampling.js';
import type Material from '../scene/MaterialState.js';
import {isCausticSpecular} from './caustics.js';
/** World-space triangles and their area CDF. Shared by Newton and SMS seeds. */
export class CausticSeedCache {
 private readonly cache=new EmissiveTriangleCache(m=>isCausticSpecular(m)?1:0);
 private previous:EmissiveTriangle[]=[];
 private result={data:new Float32Array(0),count:0};
 collect(bindings:EmissiveMeshBinding[],materials:Material[]) {
 const triangles=this.cache.collect(bindings,materials);
 if(triangles.length===this.previous.length&&triangles.every((t,i)=>t===this.previous[i]))return this.result;
 this.previous=triangles.slice();
 const data=new Float32Array(triangles.length*12);let area=0;
 for(const triangle of triangles)area+=triangle.area;
 let cdf=0;
 triangles.forEach((triangle,i)=>{
  data.set(triangle.p0,i*12);data.set(triangle.p1,i*12+4);data.set(triangle.p2,i*12+8);
  cdf+=triangle.area/area;data[i*12+3]=cdf;
 });
 if(triangles.length)data[(triangles.length-1)*12+3]=1;
 return this.result={data,count:triangles.length};
 }
}
