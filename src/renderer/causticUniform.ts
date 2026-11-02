import {researchTransport} from './researchTransport.js';
import {matrixStorage} from '../math/storage.js';
import {CAUSTIC_UNIFORM_BYTES} from './wgsl/causticLight.compute.js';
export interface CausticLightUniformOptions {casterSphere:readonly number[];viewProjection:Float32Array|Float64Array|number[];photons:number;batch:number;cameraScale:number;casterCount?:number;choiceCount?:number;orthographic?:boolean;experiments?:number}
export function packCausticLightUniform(options:CausticLightUniformOptions) {
  const data=new ArrayBuffer(CAUSTIC_UNIFORM_BYTES),f=new Float32Array(data),u=new Uint32Array(data);
  const matrix=matrixStorage(options.viewProjection);for(let i=0;i<4;i++)f[i]=options.casterSphere[i];for(let i=0;i<16;i++)f[i+4]=matrix[i];
  u[20]=options.photons;u[21]=options.batch;u[22]=0;f[23]=options.cameraScale;u[24]=options.casterCount??0;u[25]=options.choiceCount??0;u[26]=+!!options.orthographic;
  u[27]=options.experiments??0;
  researchTransport()?.packUniform(data, options);
  return data;
}
