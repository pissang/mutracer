import {PHOTON_GRID_SIZE, photonPackingWgsl} from './photonMap.compute.js';
import background from './chunks/background.wgsl.js';
import atomic from './chunks/causticAtomic.wgsl.js';
import adjoint from './chunks/causticAdjoint.wgsl.js';
import common from './chunks/common.wgsl.js';
import core from './chunks/rayTraceCore.wgsl.js';
import {createMaterialBufferWgsl} from './chunks/materialBuffer.wgsl.js';
import intersect from './chunks/intersect.wgsl.js';
import rand from './chunks/rand.wgsl.js';
import random from './chunks/random.wgsl.js';
import env from './chunks/envMap.wgsl.js';
import sampling from './chunks/sampling.wgsl.js';
import {createOpenPbrBsdfWgsl} from './chunks/openPbrBsdf.wgsl.js';
import light from './chunks/sampleLight.wgsl.js';
import uv from './chunks/uvProjection.wgsl.js';
import {causticPartitionWGSL} from './chunks/caustics.wgsl.js';
import {wgpuShaderPreamble} from '../wgpuShaderSource.js';
import {WGPU_SCENE_FEATURE_BITS} from '../WGPUSceneFeatures.js';

export const CAUSTIC_UNIFORM_BYTES = 112;
export const causticUnitRandomWgsl = /* wgsl */ `
  fn causticUnitRandom(value:f32)->f32 {
    return clamp((value-EPS)/(1.0-2.0*EPS),0.0,0.99999994);
  }
`;

// Preserve the dormant R1 uniform slot and shader spelling for source parity.
// Production packs zero; only an explicitly registered research adapter sets it.
export function causticLightCompute(
  constants: Record<string, boolean | number>,
  blasLayoutMask: number,
  hasDisplacement: boolean,
  mode: 'lightTracing' | 'photonMapping' = 'lightTracing',
  sceneIntersections = '',
  fullEmissionRandom = true
) {
  const frames = !!constants.USE_ANISOTROPY_DIRECTIONS || !!constants.USE_COAT_NORMAL_FRAMES,
    coat = !!constants.USE_COAT_NORMAL_FRAMES;
  return (
    wgpuShaderPreamble(constants, true) +
    /* wgsl */ `
${Object.keys(WGPU_SCENE_FEATURE_BITS)
  .map((name) => `const ${name} = ${!!constants[name]};`)
  .join('\n')}
${common}
${core({hasAnisotropyDirections: frames, hasCoatNormals: coat, caustics: true})}
${uv}
${createMaterialBufferWgsl({hasAnisotropyDirections: frames, hasCoatNormals: coat, caustics: true})}
${intersect({
  hasDisplacement,
  blasLayoutMask,
  hasAnisotropyDirections: frames,
  hasCoatNormals: coat,
  sceneIntersections
})}
${rand}
${random}
${env}
${sampling}
${createOpenPbrBsdfWgsl(frames, coat)}
${light}
${background.replace(
  /\b(?:USE_BACKGROUND|USE_BACKGROUND_MAP|USE_GROUNDED_BACKGROUND)\b/g,
  (name) =>
    `((rtUniform.backgroundFlags & ${
      {USE_BACKGROUND: 1, USE_BACKGROUND_MAP: 2, USE_GROUNDED_BACKGROUND: 4}[name]
    }) != 0)`
)}
${causticPartitionWGSL(false, false)}
${adjoint}
  struct CausticLightUniform {
    casterSphere: vec4f,
    viewProjection: mat4x4f,
    photonCount: u32,
    batch: u32,
    mnee: u32,
    cameraScale: f32,
    casterCount: u32,
    choiceCount: u32,
    orthographic: u32,
    experiments: u32,
  }
  @group(3) @binding(0) var<uniform> caustic: CausticLightUniform;
${
  mode === 'lightTracing'
    ? '@group(3) @binding(1) var<storage,read_write> splats: array<atomic<u32>>;'
    : `${photonPackingWgsl}
  @group(3)@binding(1)var photons:texture_storage_2d<rgba32uint,write>;
  @group(3)@binding(3)var photonDirections:texture_storage_2d<r32uint,write>;
  fn photonStore(i:u32,value:vec4u) {
    let width=textureDimensions(photons).x;
    textureStore(photons,vec2i(vec2u(i%width,i/width)),value);
  }
  fn photonStoreDirections(i:u32,value:u32) {
    let buckets=min(${PHOTON_GRID_SIZE}u,1u<<(32u-countLeadingZeros(max(256u,caustic.photonCount*2u)-1u)));
    let index=8u+buckets*4u+caustic.photonCount*2u+i;
    let width=textureDimensions(photonDirections).x;
    textureStore(photonDirections,vec2i(vec2u(index%width,index/width)),vec4u(value));
  }
`
}
  @group(3) @binding(2) var causticDistribution:texture_2d<f32>;
  // Geometric emission PDFs assume the full disk/cone/area support. The generic
  // BSDF sampler contracts randoms by EPS; undo that contraction for these warps.
${causticUnitRandomWgsl}
fn causticEmission1D(dim:u32)->f32{return ${
      fullEmissionRandom ? 'causticUnitRandom(sample1D(dim))' : 'sample1D(dim)'
    }
  ;
}
fn causticEmission2D(dim:u32)->vec2f {
  let value=sample2D(dim);
  return
${fullEmissionRandom ? 'vec2f(causticUnitRandom(value.x),causticUnitRandom(value.y))' : 'value'}
  ;
}
fn causticLoad(i:u32)->vec4f {
  let width=textureDimensions(causticDistribution).x;
  return textureLoad(causticDistribution,vec2i(vec2u(i%width,i/width)),0);
}
fn causticSphere(i:u32)->vec4f {
  return causticLoad(i);
}
// Photon emission samples a source surface, independently of any receiver.
// A NEE sample viewed from the aggregate caster center can reject an emitter
// which still illuminates another caster, or sample only part of a sphere.
var<private> causticEmissionOrigin:vec3f;
var<private> causticEmissionAreaPdf:f32;
fn causticAreaLight(origin:vec3f,position:vec3f,normal:vec3f,emission:vec3f,area:f32,pmf:f32,result:ptr<function,LightSampleRec>) {
  causticEmissionOrigin=position;
  causticEmissionAreaPdf=pmf/max(area,1e-20);
  let offset=position-origin;
  (*result).dist=length(offset);
  (*result).direction=offset/max((*result).dist,1e-20);
  (*result).normal=normal;
  (*result).emission=emission;
  (*result).pdf=pmf;
}
fn causticSampleLight(origin:vec3f,rnd:vec3f,result:ptr<function,LightSampleRec>) {
  causticEmissionAreaPdf=0.0;
  (*result).pdf=0.0;
  (*result).sourceType=0u;
  (*result).isDelta=false;
  if(caustic.choiceCount==0u) {
    return;
  }
  let scaled=rnd.z*f32(caustic.choiceCount);
  let column=min(u32(scaled),caustic.choiceCount-1u);
  let entry=causticLoad(caustic.casterCount+column*2u);
  let selected=select(bitcast<u32>(entry.y),column,fract(scaled)<entry.x);
  let choice=bitcast<vec4u>(causticLoad(caustic.casterCount+selected*2u));
  let pmf=causticLoad(caustic.casterCount+selected*2u+1u).x;
  (*result).sourceIndex=choice.w;
  if(choice.z==1u) {
    (*result).sourceType=0u;
    sampleEnvLight(rnd.xy,result);
    (*result).pdf*=pmf;
  }
  else if(choice.z==2u) {
    (*result).sourceType=2u;
    var light=analyticLights[choice.w];
    let kind=i32(light.litType);
    if(kind==RECT_LIGHT) {
      let position=light.position+light.u*(rnd.x-.5)+light.v*(rnd.y-.5);
      causticAreaLight(origin,position,normalize(cross(light.u,light.v)),light.emission,light.area,pmf,result);
      (*result).isDelta=light.radiusOrSpread<=.001;
      light_apply_rect_texture(light,position,light.position-.5*(light.u+light.v),result);
    }
    else if((kind==SPHERE_LIGHT||kind==SPOT_LIGHT)&&light.radiusOrSpread>0.0) {
      let z=1.0-2.0*rnd.x;
      let radial=sqrt(max(0.0,1.0-z*z));
      let normal=vec3f(radial*cos(TWOPI*rnd.y),radial*sin(TWOPI*rnd.y),z);
      causticAreaLight(origin,light.position+light.radiusOrSpread*normal,normal,light.emission,light.area,pmf,result);
    }
    else {
      light.selectionPmf=1.0;
      sampleAnalyticLight(light,origin,rnd.xy,result);
      (*result).pdf*=pmf;
    }
  }
  else {
    (*result).sourceType=1u;
    let triangle=getEmissiveTriangle(i32(choice.w));
    let u=sqrt(rnd.x);
    let bary=vec3f(1.0-u,u*(1.0-rnd.y),u*rnd.y);
    let position=bary.x*triangle.p0+bary.y*triangle.p1+bary.z*triangle.p2;
    let normal=normalize(cross(triangle.p1-triangle.p0,triangle.p2-triangle.p0));
    let uv=bary.x*triangle.uv0+bary.y*triangle.uv1+bary.z*triangle.uv2;
    let uv1=bary.x*triangle.secondaryUv0+bary.y*triangle.secondaryUv1+bary.z*triangle.secondaryUv2;
    causticAreaLight(origin,position,normal,getMaterialEmission(i32(triangle.materialIndex),uv,uv1),triangle.area,pmf,result);
  }
  (*result).selectionPmf=pmf;
}
fn causticCosMax(s:vec4f,origin:vec3f)->f32 {
  let distanceSquared=dot(s.xyz-origin,s.xyz-origin);
  return select(-1.0,sqrt(max(0.0,1.0-s.w*s.w/distanceSquared)),distanceSquared>s.w*s.w);
}
// A positive floor retains paths from offscreen or occluded casters. The
// complete weighted mixture PDF below, including overlaps, compensates selection.
fn causticTargetWeight(s:vec4f)->f32 {
  if((caustic.experiments&2u)==0u) { return 1.0; }
  let clip=caustic.viewProjection*vec4f(s.xyz,1.0);
  let m=caustic.viewProjection;
  let extent=s.w*max(length(vec3f(m[0].x,m[1].x,m[2].x)),length(vec3f(m[0].y,m[1].y,m[2].y)));
  if(clip.w<=0.0||abs(clip.x)>clip.w+extent||abs(clip.y)>clip.w+extent) { return .05; }
  return .05+min(1.0,extent*extent/max(clip.w*clip.w,1e-20));
}
fn causticDirection(origin:vec3f,rnd:vec3f,pdf:ptr<function,f32>,targetRadius:ptr<function,f32>)->vec3f {
  var total=0.0;
  for(var i=0u;i<caustic.casterCount;i++) {
    total+=(1.0-causticCosMax(causticSphere(i),origin))*causticTargetWeight(causticSphere(i));
  }
  var choice=rnd.z*total;
  var selected=causticSphere(0u);
  for(var i=0u;i<caustic.casterCount;i++) {
    let sphere=causticSphere(i);
    selected=sphere;
    choice-=(1.0-causticCosMax(sphere,origin))*causticTargetWeight(sphere);
    if(choice<=0.0) {
      break;
    }
  }
  *targetRadius=selected.w;
  let offset=selected.xyz-origin;
  let axis=normalize(select(vec3f(0.0,0.0,1.0),offset,dot(offset,offset)>1e-20));
  let cosine=mix(1.0,causticCosMax(selected,origin),rnd.x);
  let sine=sqrt(max(0.0,1.0-cosine*cosine));
  var t:vec3f;
  var b:vec3f;
  sampling_orthonormal_basis(axis,&t,&b);
  let direction=axis*cosine+(t*cos(TWOPI*rnd.y)+b*sin(TWOPI*rnd.y))*sine;
  // Evaluate the entire mixture, since intersecting bounding cones overlap.
  var overlaps=0.0;
  for(var i=0u;i<caustic.casterCount;i++) {
    let sphere=causticSphere(i);
    let c=causticCosMax(sphere,origin);
    if(c<0.0||dot(normalize(sphere.xyz-origin),direction)>=c) {
      overlaps+=causticTargetWeight(sphere);
    }
  }
  *pdf=overlaps/max(TWOPI*total,1e-20);
  return direction;
}
${
  mode === 'lightTracing'
    ? /* wgsl */ `${atomic}
  fn causticCameraConnect(si: SurfaceInteraction, material: OpenPbrResolvedMaterial, incoming: Ray, flux: vec3f, extinction: vec3f) {
    let eye=cameraUniform.viewInv[3].xyz;
    let forward=-normalize(cameraUniform.viewInv[2].xyz);
    let lensSample=causticEmission2D(causticDim(68u));
    let radius=cameraUniform.apertureRadius*sqrt(lensSample.x);
    var lens=eye+radius*(cos(TWOPI*lensSample.y)*cameraUniform.viewInv[0].xyz+sin(TWOPI*lensSample.y)*cameraUniform.viewInv[1].xyz);
    if(caustic.orthographic!=0u) {
      lens=si.position-forward*dot(si.position-eye,forward);
    }
    let toEye=lens-si.position;
    let distanceSquared=dot(toEye,toEye);
    let direction=normalize(toEye);
    let focalPoint=lens+(si.position-lens)*cameraUniform.focusDistance/max(dot(si.position-lens,forward),1e-12);
    let projected=select(focalPoint,si.position,caustic.orthographic!=0u);
    let clip=caustic.viewProjection*vec4f(projected,1.0);
    if(clip.w<=0.0||dot(si.position-eye,forward)<=0.0) {
      return;
    }
    let film=clip.xy/clip.w*0.5+0.5;
    if(any(film<vec2f(0.0))||any(film>=vec2f(1.0))) {
      return;
    }
    var shadow:Ray;
    initRay(&shadow,si.position+EPS*direction,direction);
    if(intersectSceneShadow(shadow,sqrt(distanceSquared)-2.0*EPS,si.triangleIndex,si.instanceIndex)) {
      return;
    }
    var m=material;
    let normal=select(-si.normal,si.normal,dot(si.normal,-incoming.d)>=0.0);
    m.inside=dot(si.faceNormal,-incoming.d)<0.0;
    m.relativeIor=select(1.0/m.specularIor,m.specularIor,m.inside);
${
  frames
    ? /* wgsl */ `  m.directionTangent=si.directionTangent;m.directionBitangent=si.directionBitangent;m.geometryTangent=si.geometryTangent;m.geometryBitangent=si.geometryBitangent;`
    : ''
}
${
  coat
    ? /* wgsl */ `  m.coatNormal=normal;m.geometricNormal=select(-si.faceNormal,si.faceNormal,dot(si.faceNormal,-incoming.d)>=0.0);`
    : ''
}
  let prepared=openpbr_prepare(si.tangent,m,-incoming.d,normal);
  var pdf:f32;
  let response=openpbr_eval_prepared(prepared,direction,&pdf);
  let cameraCosine=dot(-direction,-normalize(cameraUniform.viewInv[2].xyz));
  if(cameraCosine<=0.0) {
    return;
  }
  let importance=caustic.cameraScale*rtUniform.outputSize.x*rtUniform.outputSize.y /
  select(max(distanceSquared*cameraCosine*cameraCosine*cameraCosine,1e-12),1.0,caustic.orthographic!=0u);
  let transmittance=exp(-extinction*sqrt(distanceSquared));
  let value=flux*transmittance*response*causticAdjoint(-incoming.d,direction,normal,si.faceNormal)*importance/f32(caustic.photonCount);
  let pixel=vec2u(film*rtUniform.outputSize);
  let index=(pixel.x+pixel.y*u32(rtUniform.outputSize.x))*3u;
  causticAtomicAdd(index,value.x);
  causticAtomicAdd(index+1u,value.y);
  causticAtomicAdd(index+2u,value.z);
}
`
    : ''
}
  @compute @workgroup_size(64)
  fn main(@builtin(global_invocation_id) id:vec3u) {
    let photonIndex=id.x+id.y*4194240u;
    if(photonIndex>=caustic.photonCount) {
      return;
    }
${mode === 'photonMapping' ? 'photonStore(photonIndex,vec4u(0u));' : ''}
  samplingPixel=vec2u(photonIndex%u32(rtUniform.outputSize.x),photonIndex/u32(rtUniform.outputSize.x));
  pixelSampleIndex=caustic.batch;
  samplingBounce=0u;
  hashedCounter=0u;
  rng_initialize(samplingPixel,i32(sampleSeed(caustic.batch,rtUniform.sequenceSeed)));
  var wavelength=0.0;
  if(SPECTRAL) {
    let wavelengths=array<f32,3>(650.0,510.0,475.0);
    wavelength=wavelengths[min(u32(causticEmission1D(causticDim(69u))*3.0),2u)];
  }
  var ls:LightSampleRec;
  causticSampleLight(caustic.casterSphere.xyz,vec3f(causticEmission2D(causticDim(60u)),causticEmission1D(causticDim(61u))),&ls);
  if(ls.pdf<=0.0) {
    return;
  }
  var infinite=ls.sourceType==0u;
  if(ls.sourceType==2u) {
    infinite=i32(analyticLights[ls.sourceIndex].litType)==DIRECTIONAL_LIGHT;
  }
  var origin=caustic.casterSphere.xyz+ls.direction*ls.dist;
  if(causticEmissionAreaPdf>0.0) { origin=causticEmissionOrigin; }
  var direction:vec3f;
  var flux:vec3f;
  var targetRadius=caustic.casterSphere.w;
  if(infinite) {
    direction=-ls.direction;
    // Mixture of projected caster disks. Every overlap contributes to the PDF.
    var area=0.0;
    for(var i=0u;i<caustic.casterCount;i++) {
      let s=causticSphere(i);
      area+=s.w*s.w*causticTargetWeight(s);
    }
    var choice=causticEmission1D(causticDim(63u))*area;
    var sphere=causticSphere(0u);
    for(var i=0u;i<caustic.casterCount;i++) {
      sphere=causticSphere(i);
      choice-=sphere.w*sphere.w*causticTargetWeight(sphere);
      if(choice<=0.0) {
        break;
      }
    }
    targetRadius=sphere.w;
    var t:vec3f;
    var b:vec3f;
    sampling_orthonormal_basis(direction,&t,&b);
    let rnd=causticEmission2D(causticDim(62u));
    origin=sphere.xyz-direction*dot(sphere.xyz-caustic.casterSphere.xyz,direction)-direction*caustic.casterSphere.w;
    origin+=sphere.w*sqrt(rnd.x)*(t*cos(TWOPI*rnd.y)+b*sin(TWOPI*rnd.y));
    var overlaps=0.0;
    for(var i=0u;i<caustic.casterCount;i++) {
      let s=causticSphere(i);
      let offset=origin-s.xyz;
      let projected=offset-direction*dot(offset,direction);
      if(dot(projected,projected)<=s.w*s.w) {
        overlaps+=causticTargetWeight(s);
      }
    }
    let diskPdf=overlaps/max(PI*area,1e-20);
    flux=ls.emission/(ls.pdf*diskPdf);
  }
  else if(ls.sourceType==2u&&i32(analyticLights[ls.sourceIndex].litType)==RECT_LIGHT&&ls.isDelta) {
    // A zero-spread rectangle is a collimated beam, matching PT's delta source.
    direction=ls.normal;
    flux=ls.emission/causticEmissionAreaPdf;
  }
  else {
    var areaPdf=ls.pdf*abs(dot(ls.normal,-ls.direction))/max(ls.dist*ls.dist,1e-20);
    if(causticEmissionAreaPdf>0.0) { areaPdf=causticEmissionAreaPdf; }
    if(ls.isDelta) {
      areaPdf=ls.selectionPmf;
    }
    if(areaPdf<=0.0) {
      return;
    }
    var directionPdf:f32;
    direction=causticDirection(origin,vec3f(causticEmission2D(causticDim(62u)),causticEmission1D(causticDim(63u))),&directionPdf,&targetRadius);
    var emission=ls.emission;
    var emissionCosine=max(0.0,dot(ls.normal,direction));
    if(ls.sourceType==2u) {
      let source=analyticLights[ls.sourceIndex];
      emission=source.emission;
      if(i32(source.litType)==SPOT_LIGHT) {
        emission*=evaluateSpotEmissionMultiplier(source,direction);
      }
      if(ls.isDelta) {
        emissionCosine=1.0;
      }
      if(i32(source.litType)==RECT_LIGHT&&emissionCosine<cos(0.5*PI*source.radiusOrSpread)) {
        return;
      }
      if(i32(source.litType)==RECT_LIGHT) {
        var textured:LightSampleRec;
        textured.emission=emission;
        light_apply_rect_texture(source,origin,source.position-0.5*(source.u+source.v),&textured);
        emission=textured.emission;
      }
    }
    flux=emission*emissionCosine/(areaPdf*directionPdf);
  }
  if(SPECTRAL) {
    flux=3.0*sampling_spectral_rgb_filter(flux,wavelength);
  }
  var ray:Ray;
  initRay(&ray,origin+EPS*direction,direction);
  var chain=0u;
  var singleT=false;
  var extinction=vec3f(0.0);
  var scattering=vec3f(0.0);
  var si:SurfaceInteraction;
  for(var depth=0;
${mode === 'photonMapping' ? 'depth<=max(rtUniform.bounces,0)' : 'depth<20'}
  ;
  depth++) {
    samplingBounce=u32(depth);
    si.triangleIndex=-1;
    intersectScene(ray,&si,0,true,depth>0);
    if(!si.hit) {
      return;
    }
    var m:OpenPbrResolvedMaterial;
    getMaterial(&m,si.materialIndex,si.uv,si.uv1,si.instanceIndex,si.vertexColor);
    if(m.alpha<1.0&&causticEmission1D(causticDim(79u))>=m.alpha) {
      initRay(&ray,si.position+EPS*ray.d,ray.d);
      continue;
    }
    if(m.materialType==SHADOW_CATCHER) {
      return;
    }
    let segment=distance(ray.o,si.position);
    let channel=min(u32(sample1D(bounceDim(MEDIUM_CHANNEL))*3.0),2u);
    if(extinction[channel]>0.0&&any(scattering>vec3f(0.0))) {
      let sampled=-log(max(sample1D(bounceDim(MEDIUM_DISTANCE)),1e-7))/extinction[channel];
      // A volume event belongs to PT's R3. Surface-reaching photons use the
      // same RGB survival mixture as PT, retaining absorption and scattering.
      if(sampled<segment) {
        return;
      }
    }
    let transmittance=exp(-extinction*segment);
    let survival=(transmittance.x+transmittance.y+transmittance.z)/3.0;
    flux*=transmittance/select(1.0,max(survival,1e-20),any(scattering>vec3f(0.0)));
    if(SPECTRAL) {
      m.specularIor=sampling_cauchy_ior(wavelength,m.specularIor,m.transmissionDispersionScale,m.dispersionAbbeNumber);
    }
    if(!isCausticSpecular(m)) {
      let mneeSource=ls.sourceType!=0u;
      let r1=mneeSource&&chain==1u&&singleT&&m.baseWeight*(1.0-m.baseMetalness)*(1.0-m.transmissionWeight)>0.0&&m.subsurfaceWeight==0.0;
      if(chain>0u
${mode === 'lightTracing' ? '&&!(caustic.mnee!=0u&&r1)' : ''}){${
      mode === 'lightTracing'
        ? 'causticCameraConnect(si,m,ray,flux,extinction);'
        : /* wgsl */ `
  let position=bitcast<vec3u>(si.position);
  photonStore(photonIndex,vec4u(position,photonEncodeFlux(flux)));
  if((caustic.experiments&1u)!=0u) {
    var maximum=1e-8;
    for(var i=0u;i<caustic.casterCount;i++) { maximum=max(maximum,causticSphere(i).w); }
    let buckets=min(${PHOTON_GRID_SIZE}u,1u<<(32u-countLeadingZeros(max(256u,caustic.photonCount*2u)-1u)));
    let index=8u+buckets*4u+caustic.photonCount*3u+photonIndex;
    let width=textureDimensions(photonDirections).x;
    textureStore(photonDirections,vec2i(vec2u(index%width,index/width)),vec4u(bitcast<u32>(targetRadius/maximum)));
  }
  let incoming=vec2u(round(photonEncodeOct(-ray.d)*255.0));
  let normal=vec2u(round(photonEncodeOct(si.faceNormal)*vec2f(255.0,127.0)));
  photonStoreDirections(photonIndex,normal.x|(normal.y<<8u)|(select(0u,1u,r1)<<15u)|(incoming.x<<16u)|(incoming.y<<24u));
`
    }
}
return;
}
let view=-ray.d;
let normal=select(-si.normal,si.normal,dot(si.normal,view)>=0.0);
m.inside=dot(si.faceNormal,view)<0.0;
m.relativeIor=select(1.0/m.specularIor,m.specularIor,m.inside);
${
  frames
    ? /* wgsl */ `    m.directionTangent=si.directionTangent;m.directionBitangent=si.directionBitangent;m.geometryTangent=si.geometryTangent;m.geometryBitangent=si.geometryBitangent;`
    : ''
}
${
  coat
    ? /* wgsl */ `    m.coatNormal=normal;m.geometricNormal=select(-si.faceNormal,si.faceNormal,dot(si.faceNormal,view)>=0.0);`
    : ''
}
  let prepared=openpbr_prepare(si.tangent,m,view,normal);
  var next:vec3f;
  var pdf:f32;
  var transmission:bool;
  var roughness:f32;
  var specular:bool;
  var diffuse:bool;
  var lobe:u32;
  var marginal:f32;
  var full:vec3f;
  let response=openpbr_sample_prepared(prepared,vec3f(sample2D(bounceDim(BSDF_DIRECTION)),sample1D(bounceDim(BSDF_LOBE))),&next,&pdf,&transmission,&roughness,&specular,&diffuse,&lobe,&marginal,&full);
  if(!(pdf>0.0)) {
    return;
  }
  if(chain==0u&&ls.sourceType==0u&&transmission) {
    var reverse:Ray;
    initRay(&reverse,si.position,-ray.d);
    let bg=sampleSceneBackground(reverse);
    var numerator=bg.rgb*bg.a;
    var denominator=ls.emission;
    if(SPECTRAL) {
      numerator=sampling_spectral_rgb_filter(numerator,wavelength);
      denominator=sampling_spectral_rgb_filter(denominator,wavelength);
    }
    flux*=numerator/max(denominator,vec3f(1e-20));
  }
  flux*=response/pdf*causticAdjoint(view,next,normal,si.faceNormal);
  // The shared BSDF is a radiance sampler. Cancel its eta_i/eta_t squared
  // factor for adjoint (light-to-camera) propagation.
  if(transmission&&!m.thinWalled) {
    flux/=m.relativeIor*m.relativeIor;
  }
  // Match PT: a clear solid interface does not replace the active medium.
  if(transmission&&!m.thinWalled&&m.mediumType>0) {
    extinction=select(m.mediumExtinction,vec3f(0.0),m.inside);
    scattering=select(m.mediumScattering,vec3f(0.0),m.inside);
  }
  chain++;
  singleT=chain==1u&&((isCausticT(m)&&transmission)||(isCausticR(m)&&!transmission));
  initRay(&ray,si.position+EPS*next,next);
}
}
`
  );
}

export const causticAccumulateCompute = /* wgsl */ `
  @group(0) @binding(0) var<storage,read_write> splats:array<atomic<u32>>;
  @group(0) @binding(1) var<storage,read_write> accumulation:array<vec4f>;
  @compute @workgroup_size(64)
  fn main(@builtin(global_invocation_id) id:vec3u, @builtin(num_workgroups) groups:vec3u) {
    // Large images exceed one dispatch row; preserve the linear pixel order.
    let pixel=id.x+id.y*groups.x*64u;
    if(pixel>=arrayLength(&accumulation)) {
      return;
    }
    let i=pixel*3u;
    accumulation[pixel]+=vec4f(vec3f(bitcast<f32>(atomicLoad(&splats[i])),bitcast<f32>(atomicLoad(&splats[i+1u])),bitcast<f32>(atomicLoad(&splats[i+2u]))),1.0);
  }
`;

/** Native buffer resolve has the same independent batch normalization as web. */
export const causticBufferCompositeCompute = /* wgsl */ `
  @group(0)@binding(0)var<storage,read>pt:array<vec4f>;
  @group(0)@binding(1)var<storage,read>caustics:array<vec4f>;
  @group(0)@binding(2)var<storage,read>normal:array<vec4f>;
  @group(0)@binding(3)var<storage,read_write>output:array<vec4f>;
  @compute @workgroup_size(64)fn main(@builtin(global_invocation_id)id:vec3u) {
    if(id.x>=arrayLength(&output)) {
      return;
    }
    let c=caustics[id.x];
    let p=pt[id.x];
    output[id.x]=vec4f(p.rgb+c.rgb/max(c.a,1.0)*normal[id.x].a,p.a);
  }
`;
