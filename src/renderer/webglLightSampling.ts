import {prepareSceneLightSampling} from './sceneAssembly.js';
import type {EmissiveTriangle} from './lightSampling.js';
import type {AnalyticLightState} from '../scene/lightState.js';
/** Alias probabilities are stored as numeric texels; indices retain their bit representation. */
export function prepareWebGLLightSampling(lights: AnalyticLightState[], triangles: EmissiveTriangle[], environmentPower: number) {
  const lighting=prepareSceneLightSampling(lights,triangles,environmentPower,4096);
  const pmfOffset=lighting.emissiveTexels+lighting.choiceCount;
  const data=new Float32Array(Math.max(1,pmfOffset+lighting.choiceCount)*4);
  data.set(lighting.lightData.subarray(0,pmfOffset*4));
  const words=new Int32Array(data.buffer);
  for(let i=0;i<lighting.choiceCount;i++) {
    const type=words[(lighting.emissiveTexels+i)*4+2],source=words[(lighting.emissiveTexels+i)*4+3];
    data[(pmfOffset+i)*4]=type===1?lighting.environmentPmf:type===2?lighting.analyticPmfs[source]:triangles[source].selectionPmf;
  }
  return {...lighting,data,pmfOffset};
}
