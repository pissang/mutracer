import bsdf from './chunks/openPbrBsdf.glsl.js';
import sampling from './chunks/sampling.glsl.js';
import reflectance from './aovReflectance.glsl.js';
import {FragmentShader, Shader} from '../shader.js';
import common from './chunks/common.glsl.js';
import core from './chunks/rayTraceCore.glsl.js';
import materials from './chunks/materialBuffer.glsl.js';
import intersect from './chunks/intersect.glsl.js';
import uvProjection from './chunks/uvProjection.glsl.js';
import random from './chunks/random.glsl.js';
import cameraRay from './chunks/cameraRay.glsl.js';
import rand from './chunks/rand.glsl.js';
const surface = /* glsl */ `
uint aovWord(int index) { ivec2 size = textureSize(aovScene,0); uvec4 v = texelFetch(aovScene, ivec2((index/4)%size.x, (index/4)/size.x),0); return v[index%4]; }
vec3 aovVector(int offset){return vec3(uintBitsToFloat(aovWord(offset)),uintBitsToFloat(aovWord(offset+1)),uintBitsToFloat(aovWord(offset+2)));}
mat4 aovMatrix(int offset) { mat4 m; for (int i=0;i<4;i++) for(int j=0;j<4;j++) m[i][j]=uintBitsToFloat(aovWord(offset+i*4+j)); return m; }
Ray aovRay(vec2 uv) {
  vec4 origin = viewProjectionInv*vec4(uv*2.0-1.0,-1.0,1.0);
  vec4 target = viewProjectionInv*vec4(uv*2.0-1.0,1.0,1.0);
  Ray ray; initRay(ray, origin.xyz/origin.w, normalize(target.xyz*origin.w-origin.xyz*target.w)); return ray;
}
bool aovSurface(Ray inputRay, out SurfaceInteraction si, out OpenPbrResolvedMaterial material) {
  Ray ray=inputRay; si.triangleIndex=-1;
  for(int layer=0;layer<32;layer++) {
    intersectScene(ray,si,false); if(!si.hit) return false;
    getMaterial(material,si.materialIndex,si.uv,si.uv1,si.instanceIndex,si.vertexColor);
    if(material.materialType!=SHADOW_CATCHER && material.alpha>=0.5) return true;
    ray.o=si.position+ray.d*(EPS*0.02);
  }
  return false;
}
`;
export function aovTraceFragment(center: boolean) {
  const shader = new FragmentShader({name: center ? 'AOV center' : 'AOV accumulation',
    outputs: center ? ['id','motion'] : ['geometry','position','diffuse','specular'],
    outputTypes: center ? {id: 'uvec4'} : {}, defines: {DEPTH_QUERY_MODE: true},
    includes: [core,materials,intersect,random],
    uniforms: {viewProjectionInv: Shader.uniform('mat4'), viewInv: Shader.uniform('mat4'),
      cameraApertureRadius: Shader.uniform('float',0), cameraFocusDistance: Shader.uniform('float',10),
      viewportSize: Shader.uniform('vec2'), aovScene: Shader.uniform('usampler2D'),
      previousId: Shader.uniform('usampler2D'), previousMotion: Shader.uniform('sampler2D'),
      previousGeometry: Shader.uniform('sampler2D'), previousPosition: Shader.uniform('sampler2D'),
      previousDiffuse: Shader.uniform('sampler2D'), previousSpecular: Shader.uniform('sampler2D'),
      openPbrEnergyLut: Shader.uniform('sampler2D'), aovMask: Shader.uniform('int',0),
      aovSample: Shader.uniform('int',0)},
    main: /* glsl */ `
${common}
${rand}
${random.main}
${core.main}
${uvProjection}
${materials.main}
${intersect.main}
${cameraRay}
${center ? '' : sampling+bsdf+reflectance}
${surface}
void main() {
  ${center ? /* glsl */ `
  out_id=uvec4(0xffffffffu); out_motion=vec4(0.0);
  Ray ray=aovRay((floor(gl_FragCoord.xy)+0.5)/viewportSize);
  SurfaceInteraction si; OpenPbrResolvedMaterial material;
  if(!aovSurface(ray,si,material)) return;
  int offset=52+si.instanceIndex*24;
  out_id=uvec4(aovWord(offset),aovWord(offset+1),aovWord(int(aovWord(16))+si.materialIndex),aovWord(int(aovWord(17))+si.triangleIndex));
  out_motion.z=dot(si.position-aovVector(36),aovVector(40));
  if(aovWord(offset+2)==0u)return;
  vec4 oldWorld=aovMatrix(offset+4)*vec4(si.position,1.0);
  vec4 oldClip=aovMatrix(0)*oldWorld;
  if(oldClip.w<=0.0)return;
  vec3 oldNdc=oldClip.xyz/oldClip.w;vec2 oldPixel=(oldNdc.xy*0.5+0.5)*viewportSize;
  if(any(lessThan(oldPixel,vec2(0.0)))||any(greaterThanEqual(oldPixel,viewportSize))||abs(oldNdc.z)>1.0)return;
  uvec4 identity=texelFetch(previousId,ivec2(oldPixel),0);float oldDepth=texelFetch(previousMotion,ivec2(oldPixel),0).z;
  if(any(notEqual(identity.xy,out_id.xy))||abs(oldDepth-dot(oldWorld.xyz-aovVector(44),aovVector(48)))>max(1e-4,abs(oldDepth)*1e-3))return;
  out_motion=vec4((oldPixel-gl_FragCoord.xy)*vec2(1.0,-1.0),out_motion.z,3.0);
  ` : /* glsl */ `
  ivec2 coord=ivec2(gl_FragCoord.xy);
  out_geometry=aovSample==0 ? vec4(0.0) : texelFetch(previousGeometry,coord,0);
  out_position=aovSample==0 ? vec4(0.0) : texelFetch(previousPosition,coord,0);
  out_diffuse=aovSample==0 ? vec4(0.0) : texelFetch(previousDiffuse,coord,0);
  out_specular=aovSample==0 ? vec4(0.0) : texelFetch(previousSpecular,coord,0);
  initRandom(); samplingPixel=uvec2(floor(gl_FragCoord.xy));
  rng_initialize(floor(gl_FragCoord.xy),int(pixelSampleIndex ^ sampleHash(uint(sequenceSeed))));
  Ray ray=aovRay((floor(gl_FragCoord.xy)+sample2D(CAMERA_PIXEL))/viewportSize);
  if(cameraApertureRadius>0.0) {
    vec3 eye=viewInv[3].xyz, forward=-normalize(viewInv[2].xyz);
    vec3 focusPoint=eye+ray.d*(cameraFocusDistance/dot(ray.d,forward));
    vec2 lens=cameraApertureRadius*sampleCircle(sample2D(CAMERA_LENS));
    vec3 origin=(viewInv*vec4(lens,0.0,1.0)).xyz;
    initRay(ray,origin,normalize(focusPoint-origin));
  }
  SurfaceInteraction si; OpenPbrResolvedMaterial material;
  if(!aovSurface(ray,si,material)) return;
  float depth=max(dot(si.position-viewInv[3].xyz,-normalize(viewInv[2].xyz)),0.0);
  bool unsupported=material.materialType!=STANDARD || material.alpha<1.0 || material.coatWeight>0.0 || material.fuzzWeight>0.0 || material.specularAnisotropy>0.0 || material.subsurfaceWeight>0.0 || dot(material.mediumScattering,material.mediumScattering)>0.0 || material.bevel>0.0 || material.thinFilmWeight>0.0 || material.transmissionDispersionScale>0.0;
  out_geometry+=vec4(depth,material.specularRoughness,material.baseMetalness,unsupported?1.0:0.0);
  #ifdef AOV_REFLECTANCE
  if((aovMask&24)!=0 && !unsupported){
    vec3 normal=si.normal,face=si.faceNormal;float cosine=-dot(normal,ray.d),faceCosine=-dot(face,ray.d);
    if(material.thinWalled&&(material.transmissionWeight>0.0||material.subsurfaceWeight>0.0)){
      if(cosine<0.0){normal=-normal;cosine=-cosine;}if(faceCosine<0.0){face=-face;faceCosine=-faceCosine;}
    }
    if(faceCosine>=0.0&&cosine<0.0){normal=face;cosine=faceCosine;}
    if(cosine<0.0)normal=-normal;
    material.inside=cosine<=0.0&&!material.thinWalled;material.relativeIor=cosine>0.0?1.0/material.specularIor:material.specularIor;
    vec3 tangent=vec3(0.0);
#ifdef USE_TANGENT
    tangent=si.tangent;
#endif
    OpenPbrPreparedBsdf prepared=openpbr_prepare(tangent,material,-ray.d,normal);
    vec3 diffuse,specular;aovReflectance(prepared,(aovMask&8)!=0,(aovMask&16)!=0,diffuse,specular);
    out_diffuse+=vec4(diffuse,1.0);out_specular+=vec4(specular,1.0);
  }
  #endif
  out_position+=vec4(si.position,1.0);
  `}
}
`});
  shader.parallelCompile = true;
  return shader;
}
