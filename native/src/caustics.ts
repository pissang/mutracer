import {causticCasterSphere,causticCasterSpheres} from '../../src/renderer/caustics.js';
import {causticEmissionTable} from '../../src/renderer/causticEmission.js';
import {packCausticLightUniform} from '../../src/renderer/causticUniform.js';
import {causticLightCompute,causticAccumulateCompute,causticBufferCompositeCompute} from '../../src/renderer/wgsl/causticLight.compute.js';
import {defaultPhotonMapPhotons,photonGridCompute} from '../../src/renderer/wgsl/photonMap.compute.js';
import {mat4} from '../../src/math.js';
import type Mesh from '../../src/scene/MeshState.js';
import type Material from '../../src/scene/MaterialState.js';
import type {EmissiveMeshBinding,EmissiveTriangle} from '../../src/renderer/lightSampling.js';
import type {AnalyticLightState} from '../../src/scene/lightState.js';
import type {WGPUShaderFeatures} from '../../src/renderer/wgpuShaderSource.js';
import {decodeCamera} from './camera-core.js';
export function nativeCausticTarget(input:{meshes:Mesh[];bindings:EmissiveMeshBinding[];materials:Material[];lights:AnalyticLightState[];emissive:EmissiveTriangle[];environmentPower:number;lighting:Float32Array;cacheKey:object},
 settings:{causticFlags:number;lightPhotons:number;photonMapPhotons:number;photonMapRadius:number},width:number,height:number,cameraRecord:Uint8Array,cameraUniform:Uint8Array,constants:Record<string,boolean|number>,features:WGPUShaderFeatures,intersections:string,hardware:boolean){
 const spheres=causticCasterSpheres(input.meshes);if(!settings.causticFlags||!spheres.length)return undefined;
 let maximumCasterRadius=0;for(const sphere of spheres)maximumCasterRadius=Math.max(maximumCasterRadius,sphere[3]);
 const flags=settings.causticFlags&6,bounds=causticCasterSphere(input.meshes);
 const emission=causticEmissionTable(input.lights,input.emissive,bounds[3],input.environmentPower);
 const texels=Math.max(1,spheres.length+emission.count*2),distributionWidth=Math.min(texels,4096),distributionHeight=Math.ceil(texels/distributionWidth);
 const distribution=new Float32Array(distributionWidth*distributionHeight*4);spheres.forEach((sphere,i)=>distribution.set(sphere,i*4));distribution.set(emission.data,spheres.length*4);
 const lightWidth=Math.min(Math.max(1,input.lighting.length/4),4096),lightHeight=Math.ceil(Math.max(1,input.lighting.length/4)/lightWidth);
 const lighting=new Float32Array(lightWidth*lightHeight*4);lighting.set(input.lighting);
 const camera=decodeCamera(cameraRecord),projection=camera.getProjectionMatrix(width/height),inverse=new Float32Array(cameraUniform.buffer,cameraUniform.byteOffset,16),vp=mat4.create();mat4.invert(vp,inverse);
 const uniform=new Uint8Array(packCausticLightUniform({casterSphere:bounds,viewProjection:vp,photons:1,batch:0,cameraScale:Math.abs(projection[0]*projection[5])/4,casterCount:spheres.length,choiceCount:emission.count,orthographic:camera.projection==='orthographic'}));
 const preamble=hardware?'enable wgpu_ray_query;\n':'';
 const metadata={flags,workgroupSize:features.workgroupSize??8,lightWidth,lightHeight,distributionWidth,distributionHeight,
  lightPhotons:settings.lightPhotons||Math.max(1,Math.round(width*height/4)),photonMapPhotons:settings.photonMapPhotons||defaultPhotonMapPhotons(width,height),
  initialRadius:settings.photonMapRadius||Math.max(bounds[3]*.03,1e-4),
  perCasterRadius:settings.photonMapRadius||Math.max(maximumCasterRadius*.03,1e-4),
  lightShader:flags&2?preamble+causticLightCompute(constants,features.blasLayoutMask,features.hasDisplacement,'lightTracing',intersections):'',
  photonShader:flags&4?preamble+causticLightCompute(constants,features.blasLayoutMask,features.hasDisplacement,'photonMapping',intersections):'',
  composeShader:causticBufferCompositeCompute,gridShader:flags&4?photonGridCompute:'',accumulateShader:causticAccumulateCompute};
 return {metadata,uniform,distribution:new Uint8Array(distribution.buffer),lighting:new Uint8Array(lighting.buffer)};
}
