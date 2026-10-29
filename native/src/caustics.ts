import {causticCasterSphere,causticCasterSpheres} from '../../src/renderer/caustics.js';
import {CausticSeedCache} from '../../src/renderer/causticSeeds.js';
import {causticEmissionTable} from '../../src/renderer/causticEmission.js';
import {packCausticLightUniform} from '../../src/renderer/causticUniform.js';
import {causticLightCompute,causticAccumulateCompute,causticBufferCompositeCompute} from '../../src/renderer/wgsl/causticLight.compute.js';
import {photonGridCompute} from '../../src/renderer/wgsl/photonMap.compute.js';
import {mat4} from '../../src/math.js';
import type Mesh from '../../src/scene/MeshState.js';
import type Material from '../../src/scene/MaterialState.js';
import type {EmissiveMeshBinding,EmissiveTriangle} from '../../src/renderer/lightSampling.js';
import type {AnalyticLightState} from '../../src/scene/lightState.js';
import type {WGPUShaderFeatures} from '../../src/renderer/wgpuShaderSource.js';
import {decodeCamera} from './camera-core.js';
const seedCaches=new WeakMap<object,CausticSeedCache>();
export function nativeCausticTarget(input:{meshes:Mesh[];bindings:EmissiveMeshBinding[];materials:Material[];lights:AnalyticLightState[];emissive:EmissiveTriangle[];environmentPower:number;lighting:Float32Array;cacheKey:object},
 settings:{causticFlags:number;lightPhotons:number;photonMapPhotons:number;photonMapRadius:number},width:number,height:number,cameraRecord:Uint8Array,cameraUniform:Uint8Array,constants:Record<string,boolean|number>,features:WGPUShaderFeatures,intersections:string,hardware:boolean){
 const spheres=causticCasterSpheres(input.meshes);if(!settings.causticFlags||!spheres.length)return undefined;
 const flags=settings.causticFlags,bounds=causticCasterSphere(input.meshes);
 const emission=causticEmissionTable(input.lights,input.emissive,bounds[3],input.environmentPower);
 const texels=Math.max(1,spheres.length+emission.count*2),distributionWidth=Math.min(texels,4096),distributionHeight=Math.ceil(texels/distributionWidth);
 const distribution=new Float32Array(distributionWidth*distributionHeight*4);spheres.forEach((sphere,i)=>distribution.set(sphere,i*4));distribution.set(emission.data,spheres.length*4);
 let cache=seedCaches.get(input.cacheKey);if(!cache){cache=new CausticSeedCache();seedCaches.set(input.cacheKey,cache);}
 const seed=flags&1?cache.collect(input.bindings,input.materials):{data:new Float32Array(0),count:0};
 const seedOffset=input.lighting.length/4,total=seedOffset+seed.data.length/4,lightWidth=Math.min(Math.max(1,total),4096),lightHeight=Math.ceil(total/lightWidth);
 const lighting=new Float32Array(lightWidth*lightHeight*4);lighting.set(input.lighting);lighting.set(seed.data,seedOffset*4);
 const camera=decodeCamera(cameraRecord),projection=camera.getProjectionMatrix(width/height),inverse=new Float32Array(cameraUniform.buffer,cameraUniform.byteOffset,16),vp=mat4.create();mat4.invert(vp,inverse);
 const uniform=new Uint8Array(packCausticLightUniform({casterSphere:bounds,viewProjection:vp,photons:1,batch:0,mnee:!!(flags&1),cameraScale:Math.abs(projection[0]*projection[5])/4,casterCount:spheres.length,choiceCount:emission.count,orthographic:camera.projection==='orthographic'}));
 const preamble=hardware?'enable wgpu_ray_query;\n':'';
 // Large Metal manifold kernels spill or fail with larger threadgroups.
 // Keep host dispatch and shader block sizes equal; disabled targets keep 8.
 const metadata={flags,workgroupSize:flags&1?1:features.workgroupSize??8,lightWidth,lightHeight,distributionWidth,distributionHeight,
  lightPhotons:settings.lightPhotons||Math.max(1,Math.round(width*height/4)),photonMapPhotons:settings.photonMapPhotons||Math.max(1,Math.round(width*height/4)),
  initialRadius:settings.photonMapRadius||Math.max(bounds[3]*.03,1e-4),
  lightShader:flags&2?preamble+causticLightCompute(constants,features.blasLayoutMask,features.hasDisplacement,'lightTracing',intersections):'',
  photonShader:flags&4?preamble+causticLightCompute(constants,features.blasLayoutMask,features.hasDisplacement,'photonMapping',intersections):'',
  composeShader:causticBufferCompositeCompute,gridShader:flags&4?photonGridCompute:'',accumulateShader:causticAccumulateCompute};
 return {metadata,uniform,distribution:new Uint8Array(distribution.buffer),lighting:new Uint8Array(lighting.buffer),seedCount:seed.count,seedOffset};
}
