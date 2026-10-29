import type {AnalyticLightState} from '../scene/lightState.js';
import {buildLightAliasTable,colorLuminance,estimateAnalyticLightPower,type EmissiveTriangle} from './lightSampling.js';
import {getSpotLightArea,getSpotLightRadiance} from './lightsData.js';

/** Emitted flux, independent of the NEE selection heuristic. */
export function causticEmissionPower(light:AnalyticLightState,radius=1) {
  if(light.type==='DirectionalLight')return colorLuminance(light.color)*light.intensity*Math.PI*radius*radius;
  if(light.type==='RectLight')return estimateAnalyticLightPower(light)*Math.sin(Math.PI*.5*light.spread)**2;
  if(light.type!=='SpotLight')return estimateAnalyticLightPower(light);
  const outer=Math.cos(light.outerAngle*Math.PI/180),inner=Math.cos(Math.min(light.innerAngle,light.outerAngle)*Math.PI/180);
  const rows=128,columns=128;let integral=0;
  for(let y=0;y<rows;y++)for(let x=0;x<columns;x++){
    const cosine=1-(1-outer)*(y+.5)/rows;
    const t=inner>outer?Math.min(1,Math.max(0,(cosine-outer)/(inner-outer))):1;
    const ies=light.iesProfile?.sampleBaked(Math.acos(cosine),2*Math.PI*(x+.5)/columns-Math.PI)??1;
    integral+=t*t*(3-2*t)*ies;
  }
  integral*=2*Math.PI*(1-outer)/(rows*columns);
  const intensity=colorLuminance(light.color)*(light.radius===0?light.intensity:getSpotLightRadiance(light)*getSpotLightArea(light));
  return intensity*integral;
}
/** Two texels per alias choice: probability/alias/type/index, then its PMF. */
export function causticEmissionTable(lights:readonly AnalyticLightState[],triangles:readonly EmissiveTriangle[],radius=1,environmentPower=0) {
  const entries=lights.map((light,sourceIndex)=>({sourceType:2,sourceIndex,weight:causticEmissionPower(light,radius)}));
  triangles.forEach((triangle,sourceIndex)=>entries.push({sourceType:3,sourceIndex,weight:Math.PI*triangle.area*triangle.samplingLuminance}));
  if(environmentPower>0)entries.push({sourceType:1,sourceIndex:0,weight:environmentPower*Math.PI*radius*radius});
  const distribution=buildLightAliasTable(entries),count=distribution.pmfs.length;
  const data=new Float32Array(count*8),words=new Uint32Array(data.buffer);
  for(let i=0;i<count;i++){words.set(distribution.choices.subarray(i*4,i*4+4),i*8);data[i*8+4]=distribution.pmfs[i];}
  return {data,count,totalPower:distribution.totalWeight};
}
