import {reflectionWindowWGSL} from './temporalReflectionShader.js';
import {temporalMaterialWGSL, temporalMetadataWGSL, temporalOverflowWGSL, temporalRadianceWGSL} from './temporalKernels.js';

export const directGeometryWGSL = /* wgsl */ `
fn surface(x: vec2i, frame: u32, field: u32) -> vec4f {
  let data = textureLoad(surfaces, x, i32(frame*2u), 0);
  let flags = frameFlags(x, frame);
  let hit = (flags & CENTER_HIT) != 0u;
  if (field == 0u) { return vec4f(0, 0, 0, select(0., data.w, hit)); }
  return vec4f(data.xyz, f32(hit));
}
fn ident(x: vec2i, frame: u32) -> vec3u {
  return textureLoad(ids, x, i32(frame), 0).xyz;
}
@group(0) @binding(9) var motions: texture_2d_array<f32>;
${temporalMetadataWGSL}
fn inFrame(q:vec2f)->bool{return all(q>=vec2f(0))&&all(q<=vec2f(p.size)-1.0);}
fn revisionAt(x:vec2i,frame:u32)->u32{return select(0u,textureLoad(ids,x,i32(frame),0).w,(p.mode&4u)!=0u);}
fn sameMaterial(x:vec2i,frame:u32,id:vec3u,revision:u32)->bool{return all(ident(x,frame)==id)&&revisionAt(x,frame)==revision;}
fn strictSilhouette() -> bool { return p.symmetric == 1u && (p.mode & 4u) != 0u; }
fn motionAt(q:vec2f,frame:u32,id:vec3u,revision:u32)->vec4f{
  if(!inFrame(q)){return vec4f(0);}let origin=vec2i(floor(q));let phase=fract(q);var value=vec4f(0);var total=0.;
  for(var dy=0;dy<2;dy++){for(var dx=0;dx<2;dx++){
    let at=origin+vec2i(dx,dy);if(any(at>=vec2i(p.size))||!sameMaterial(at,frame,id,revision)){continue;}
    let m=motionSample(at, frame);if(m.w!=3.){continue;}
    let w=select(1.-phase.x,phase.x,dx==1)*select(1.-phase.y,phase.y,dy==1);value+=m*w;total+=w;
  }}
  if(total<=0.){return vec4f(0);}return vec4f(value.xyz/total,3.);
}
// The source point can be outside the later frame's same-ID footprint
// even when the inverse has a visible solution. A seed is just a proposal;
// invertForwardMotion still samples and validates the later motion field.
fn predictForwardSeed(q: vec2f, later: u32, prior: u32, id: vec3u, revision:u32) -> vec4f {
  let previous = motionAt(q, prior, id, revision);
  let guess = q - select(vec2f(0.0), previous.xy, previous.w == 3.0);
  let prediction = motionAt(guess, later, id, revision);
  if (prediction.w == 3.0 && motionAt(q - prediction.xy, later, id, revision).w == 3.0) {
    return prediction;
  }
  let center = vec2i(floor(clamp(guess, vec2f(0), vec2f(p.size) - 1.0) + 0.5));
  let radius = select(4, 2, previous.w == 3.0);
  var best = 4.0;
  var seed = vec4f(0.0);
  for (var y = -radius; y <= radius; y++) {
    for (var x = -radius; x <= radius; x++) {
      let at = center + vec2i(x, y);
      if (any(at < vec2i(0)) || any(at >= vec2i(p.size)) || !sameMaterial(at, later, id, revision)) {
        continue;
      }
      let motion = motionSample(at, later);
      if (motion.w != 3.0) { continue; }
      let residual = vec2f(at) + motion.xy - q;
      let error = dot(residual, residual);
      if (error < best) {
        best = error;
        seed = motion;
      }
    }
  }
  return seed;
}
fn invertForwardMotion(q: vec2f, later: u32, id: vec3u, revision:u32, seed: vec4f) -> vec4f {
  if (seed.w != 3.0) { return vec4f(0.0); }
  var next = q - seed.xy;
  for (var iteration = 0; iteration < 4; iteration++) {
    let edge = motionAt(next, later, id, revision);
    if (edge.w != 3.0) { return vec4f(0.0); }
    next = q - edge.xy;
  }
  let edge = motionAt(next, later, id, revision);
  if (edge.w != 3.0 || length(next + edge.xy - q) >= 0.05) { return vec4f(0.0); }
  return vec4f(next, edge.z, 1.0);
}
fn guideAt(q:vec2f,frame:u32,field:u32,id:vec3u,revision:u32)->vec4f{
  if(!inFrame(q)){return vec4f(0);}let origin=vec2i(floor(q));let phase=fract(q);var value=vec4f(0);var total=0.;
  for(var dy=0;dy<2;dy++){for(var dx=0;dx<2;dx++){
    let at=origin+vec2i(dx,dy);if(any(at>=vec2i(p.size))||!sameMaterial(at,frame,id,revision)){continue;}
    let s=surface(at,frame,field);if(s.w<=0.){continue;}
    let w=select(1.-phase.x,phase.x,dx==1)*select(1.-phase.y,phase.y,dy==1);value+=s*w;total+=w;
  }}if(total<=0.){return vec4f(0);}value/=total;
  if(field==1u){value=vec4f(normalize(value.xyz),total);}return value;
}
fn traceMotionFrom(x:vec2f,id:vec3u,first:u32,delta:i32)->vec4f{
  let revision=revisionAt(vec2i(x),first);
  var q=x;var depth=guideAt(x,first,0u,id,revision).w;var normal=guideAt(x,first,1u,id,revision).xyz;
  let capacity=i32(arrayLength(&cameras));
  let minCoverage=select(0.,.90,strictSilhouette());
  for(var step=0;step<abs(delta);step++){
    let laterI=i32(first)+select(-step,step+1,delta>0);let later=u32((laterI%capacity+capacity)%capacity);
    let prior=(later+u32(capacity)-1u)%u32(capacity);let src=select(prior,later,delta<0);let dst=select(later,prior,delta<0);
    let sourceNormal=guideAt(q,src,1u,id,revision);
    if(sourceNormal.w<=minCoverage||dot(normal,sourceNormal.xyz)<.95){return vec4f(q,depth,0);}
    let motion = motionAt(q, later, id, revision);
    var next: vec2f;
    if (delta < 0) {
      if (motion.w != 3.0) { return vec4f(q, depth, 0); }
      next = q + motion.xy;
      depth = motion.z;
    } else {
      var forward = invertForwardMotion(q, later, id, revision, motion);
      if (forward.w == 0.0 && p.symmetric == 1u) {
        let seed = predictForwardSeed(q, later, prior, id, revision);
        forward = invertForwardMotion(q, later, id, revision, seed);
      }
      if (forward.w == 0.0) { return vec4f(q, depth, 0); }
      next = forward.xy;
      let currentDepth = guideAt(next, later, 0u, id, revision);
      if (currentDepth.w <= 0.0) { return vec4f(q, depth, 0); }
      depth += currentDepth.w - forward.z;
    }
    if(!inFrame(next)){return vec4f(q,depth,0);}let destNormal=guideAt(next,dst,1u,id,revision);
    if(destNormal.w<=minCoverage||dot(normal,destNormal.xyz)<.95){return vec4f(q,depth,0);}
    q=next;normal=destNormal.xyz;
  }
  return vec4f(q,depth,1.);
}
fn traceMotion(x:vec2f,id:vec3u)->vec4f{return traceMotionFrom(x,id,p.current,p.delta);}
fn coc(depth:f32, frame:u32)->f32 {
  let lens=cameras[frame].lens;
  return lens.x*lens.y*abs(1.0/max(depth,1e-4)-1.0/lens.z);
}
`;

// Direct temporal window. Each neighbor is projected once into the current frame.
const windowBindingsAndGeometry = /* wgsl */ `
struct Params { size: vec2u, current: u32, source: u32, delta: i32, symmetric: u32, stage: u32, mode: u32, radiusMin: u32, radiusMax: u32 }
struct Camera { vp: mat4x4f, lens: vec4f }
${temporalOverflowWGSL}
@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var surfaces: texture_2d_array<f32>;
@group(0) @binding(2) var ids: texture_2d_array<u32>;
@group(0) @binding(3) var hdr: texture_2d_array<f32>;
@group(0) @binding(4) var<storage, read> cameras: array<Camera>;
@group(0) @binding(5) var<storage, read_write> total: array<vec4f>;
@group(0) @binding(6) var<storage, read_write> output: array<vec4f>;
@group(0) @binding(7) var<storage, read_write> overflow: array<Overflow>;
@group(0) @binding(8) var<storage, read_write> rejects: array<atomic<u32>>;
@group(0) @binding(10) var materials: texture_2d_array<u32>;

${temporalMaterialWGSL}
fn surfaceMaterial(at: vec2i) -> vec3f {
  return unpackSurfaceMaterial(textureLoad(materials, at, i32(p.current), 0).x);
}
fn surfaceRadius(radius: f32, material: vec3f) -> f32 {
  if (material.y <= METALLIC_THRESHOLD || material.x >= .24) { return radius; }
  return (radius + 1.) * smoothstep(.05, .24, material.x) - 1.;
}

${directGeometryWGSL}
${temporalRadianceWGSL}
fn radiance(x:vec2i,frame:u32)->vec3f { return loadRadiance(x, frame, p.size.x).rgb; }
fn overflowMissing(x:vec2i,frame:u32)->bool {
  return (frameFlags(x, frame) & HDR_MISSING) != 0u;
}
fn landingNormal(q: vec2f, id: vec3u, revision:u32) -> vec3f {
  // Follow the same surface as the trace when the nearest texel belongs to
  // a different surface. Causal reconstruction retains its existing sampler.
  if (p.symmetric == 1u) { return guideAt(q, p.source, 1u, id, revision).xyz; }
  let nearest = clamp(vec2i(floor(q + 0.5)), vec2i(0), vec2i(p.size) - 1);
  return surface(nearest, p.source, 1u).xyz;
}
fn viewRay(q: vec2f, frame: u32) -> vec3f {
  let vp = cameras[frame].vp;
  let right = vec3f(vp[0].x,vp[1].x,vp[2].x);
  let up = vec3f(vp[0].y,vp[1].y,vp[2].y);
  let perspective = vec3f(vp[0].w,vp[1].w,vp[2].w);
  if (dot(perspective,perspective) < 1e-12) { return normalize(cross(up,right)); }
  let forward = normalize(perspective);
  let offset = vec2f(dot(right,forward),dot(up,forward));
  let xAxis = right-offset.x*forward;
  let yAxis = up-offset.y*forward;
  let ndc = (2.*(q+.5)/vec2f(p.size)-1.)*vec2f(1.,-1.)-offset;
  return normalize(forward+ndc.x*xAxis/dot(xAxis,xAxis)+ndc.y*yAxis/dot(yAxis,yAxis));
}
// A matched surface point can see different incident light through a narrow
// reflection lobe. Compare its reflected rays in world space, so a pure camera
// pan around the same origin can keep samples from stationary reflectors.
fn dielectricSurfaceConfidence(x: vec2i, q: vec2f, material: vec3f) -> f32 {
  if (p.symmetric != 1u || (p.mode & 4u) == 0u || material.z <= .005 || material.x >= .2) { return 1.; }
  let n = normalize(surface(x,p.current,1u).xyz);
  let oldNormal = landingNormal(q,ident(x,p.current),revisionAt(x,p.current));
  let current = reflect(viewRay(vec2f(x),p.current),n);
  let neighbor = reflect(viewRay(q,p.source),oldNormal);
  let focal = cameras[p.current].lens.x;
  let slip = focal*length(current-neighbor);
  let tolerance = max(.15,.12*focal*material.x*material.x);
  let glossy = smoothstep(.005,.035,material.z)*(1.-smoothstep(.09,.2,material.x));
  return 1.-glossy*smoothstep(.035,tolerance,slip);
}
fn tapRejection(at:vec2i, targetDepth:f32, targetNormal:vec3f, id:vec3u, revision:u32)->u32 {
  let oldPos=surface(at,p.source,0u);
  let oldNormal=surface(at,p.source,1u);
  if (!(oldPos.w>0.0001 && oldNormal.w>0.0)) { return 5u; }
  if (!sameMaterial(at,p.source,id,revision)) { return 7u; }
  if (abs(oldPos.w-targetDepth)>0.015*targetDepth) { return 8u; }
  if (dot(oldNormal.xyz,targetNormal)<0.95) { return 9u; }
  return 0u;
}
fn rejection(x:vec2i, q:vec3f, nearest:vec2i, partial:bool)->u32 {
  let pos=surface(x,p.current,0u);
  if (!(pos.w>0.0001)) { return 1u; }
  if (!(all(q.xy>=vec2f(0)) && all(q.xy<=vec2f(p.size)-1.0) && q.z>0.0)) { return 3u; }
  if (!(abs(coc(pos.w,p.current)-coc(q.z,p.source))<=0.5)) { return 4u; }
  let id=ident(x,p.current);
  let revision=revisionAt(x,p.current);
  let endpointNormal=landingNormal(q.xy,id,revision);
  if (partial) { return tapRejection(nearest,q.z,endpointNormal,id,revision); }
  let origin=vec2i(floor(q.xy));
  for (var dy=0;dy<=1;dy++) { for (var dx=0;dx<=1;dx++) {
    let at=min(origin+vec2i(dx,dy),vec2i(p.size)-1);
    let reason=tapRejection(at,q.z,endpointNormal,id,revision);
    if (reason!=0u) { return reason; }
  }}
  return 0u;
}
fn footprintWeight(x:vec2i,q:vec2f,nearest:vec2i,targetDepth:f32)->f32 {
  let origin=vec2i(floor(q));
  let phase=fract(q);
  let pos=surface(x,p.current,0u);
  let normal=surface(x,p.current,1u);
  let id=ident(x,p.current);
  let revision=revisionAt(x,p.current);
  let endpointNormal=landingNormal(q,id,revision);
  var coverage=0.0;
  for(var dy=0;dy<2;dy++){for(var dx=0;dx<2;dx++){
    let at=min(origin+vec2i(dx,dy),vec2i(p.size)-1);
    if(tapRejection(at,targetDepth,endpointNormal,id,revision)==0u){
      coverage+=select(1-phase.x,phase.x,dx==1)*select(1-phase.y,phase.y,dy==1);
    }
  }}
  // At a silhouette, even a validated nearest tap can have different subpixel coverage.
  let offset=q-vec2f(nearest);
  if (strictSilhouette() && coverage < .90) { return 0.; }
  return select(0.35*coverage*exp(-16.*dot(offset,offset)),1.,coverage>.9999);
}
`;

const recoverHistoryWGSL = /* wgsl */ `
// Jittered hit coverage and square-root albedo share the motion flag lane.
// The center-ray identity remains the only authority for accepting a surface.
fn packedGuide(x: vec2i, frame: u32) -> u32 {
  return (frameFlags(x, frame) >> 2u) & GUIDE_MASK;
}
fn hitCoverage(x: vec2i, frame: u32) -> f32 {
  return f32(packedGuide(x,frame)&255u)/255.;
}
fn skyCorrection(x: vec2i, tap: vec2i, pos: vec4f, rgb: vec3f) -> vec3f {
  let current=packedGuide(x,p.current);
  let source=packedGuide(tap,p.source);
  if(min(current&255u,source&255u)>246u){return rgb;}
  let currentAlbedo=f32(current>>8u);
  let sourceAlbedo=f32(source>>8u);
  if(min(currentAlbedo,sourceAlbedo)<8. || abs(currentAlbedo-sourceAlbedo)<1.){return rgb;}

  // Estimate the sky contribution only when nearby misses agree that there
  // is no second visible surface behind this silhouette.
  let reach=i32(clamp(ceil(coc(pos.w,p.current))+1.,2.,4.));
  let id=ident(x,p.current);
  var background=vec3f(0);
  var count=0.;
  for(var dy=-1;dy<=1;dy++){
    for(var dx=-1;dx<=1;dx++){
      if(dx==0 && dy==0){continue;}
      let at=clamp(x+vec2i(dx,dy)*reach,vec2i(0),vec2i(p.size)-1);
      let depth=surface(at,p.current,0u).w;
      if(depth>0. && any(ident(at,p.current)!=id)){return rgb;}
      if(depth==0. && (packedGuide(at,p.current)&255u)<=8u){
        background+=radiance(at,p.current);
        count+=1.;
      }
    }
  }
  if(count<2.){return rgb;}
  background/=count;
  let ratio=clamp((currentAlbedo*currentAlbedo)/(sourceAlbedo*sourceAlbedo),.5,1.8);
  let prediction=max(vec3f(0),background+(rgb-background)*ratio);
  return mix(rgb,prediction,.75);
}

struct HistoryTap { at: vec2i, support: f32 }
fn recoverTap(x: vec2i, pos: vec4f, q: vec3f, original: HistoryTap) -> HistoryTap {
  let strict = strictSilhouette();
  let nearestDepth=surface(original.at,p.source,0u).w;
  if(nearestDepth>.0001 && nearestDepth<q.z*select(.985,.992,strict)){return original;}
  let normal=surface(x,p.current,1u);
  let id=ident(x,p.current);
  let revision=revisionAt(x,p.current);
  let coverage=hitCoverage(x,p.current);
  var best=0.;
  var at=original.at;
  for(var dy=-1;dy<=1;dy++){
    for(var dx=-1;dx<=1;dx++){
      let tap=original.at+vec2i(dx,dy);
      if(any(tap<vec2i(0)) || any(tap>=vec2i(p.size))){continue;}
      let endpointNormal=landingNormal(q.xy,id,revision);
      let why=tapRejection(tap,q.z,endpointNormal,id,revision);
      if(why!=0u && (strict || why!=9u)){continue;}
      let source=surface(tap,p.source,0u);
      let alignment=dot(endpointNormal,surface(tap,p.source,1u).xyz);
      if(alignment<select(.80,.975,strict) || abs(source.w-q.z)>select(.015,.008,strict)*q.z){continue;}
      let forward=vec2f(tap)-q.xy;
      let reversePath=traceMotionFrom(vec2f(tap),id,p.source,-p.delta);
      if(reversePath.w<=.5){continue;}
      let reverse=reversePath.xy-vec2f(x);
      let distance2=max(dot(forward,forward),dot(reverse,reverse));
      if(distance2>select(2.25,.64,strict)){continue;}
      let coverageDelta=coverage-hitCoverage(tap,p.source);
      let score=exp(-1.5*distance2-(1.-min(alignment,1.))*24.-coverageDelta*coverageDelta*18.);
      if(score>best){
        best=score;
        at=tap;
      }
    }
  }
  let confidence=best*1.2*(4.-f32(abs(p.delta)))/3.;
  let mixed=1.-smoothstep(.85,1.,min(coverage,hitCoverage(at,p.source)));
  let luma=vec3f(.2126,.7152,.0722);
  let currentY=max(.005,dot(radiance(x,p.current),luma));
  let historyY=max(.005,dot(radiance(at,p.source),luma));
  let change=log(historyY/currentY);
  let support=confidence*exp(-mixed*(1.6*pow(max(change,0.),2.)+.2*pow(min(change,0.),2.)));
  if(support>original.support){return HistoryTap(at,support);}
  return original;
}
`;

const startWindowWGSL = (guides = false, reflections = false) => /* wgsl */ `
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) g:vec3u) {
  if(any(g.xy>=p.size)){return;}
  let x=vec2i(g.xy); let index=g.y*p.size.x+g.x;
  if(p.stage==0u){
    total[index]=vec4f(radiance(x,p.current),1.0);${reflections ? `
    let reflected = reflection(x,p.current);
    total[index] = vec4f(total[index].rgb-reflected,1.0);
    reflectedTotal[index] = vec4f(reflected,1.0);
    if ((p.mode&32u)!=0u) { reflectedTotal[index+p.size.x*p.size.y]=vec4f(0); reflectedTotal[index+2u*p.size.x*p.size.y]=vec4f(0); }` : ''}${guides ? `
    albedoSum[index]=vec4f(loadAlbedo(x,p.current),0.);
    normalSum[index]=vec4f(loadNormal(x,p.current),0.);` : ''}
    return;
  }
  if(p.stage==2u){ output[index]=vec4f(total[index].rgb/total[index].a,loadRadiance(x,p.current,p.size.x).a);${reflections ? `
    output[index] += vec4f(reflectedTotal[index].rgb/reflectedTotal[index].a,0.0);` : ''}${guides ? `
    albedoSum[index]/=total[index].a;
    normalSum[index]/=total[index].a;` : ''} return; }
  if(overflowMissing(x,p.current)){return;}
  let pos=surface(x,p.current,0u);
  if(pos.w<=0.0001){return;}
  var radius=f32(p.radiusMax);
  if((p.mode & 1u)!=0u){radius=clamp(f32(p.radiusMin)+f32(p.radiusMax-p.radiusMin)*max(coc(pos.w,p.current)-2.0,0.0),f32(p.radiusMin),f32(p.radiusMax));}
  let distance = abs(f32(p.delta));
  if (distance > radius) { return; }
  let material = surfaceMaterial(x);
  // A camera cut is a correspondence check, independent of radiance weights.
  let surfaceWindow = select(radius, surfaceRadius(radius, material), (p.mode & 4u) != 0u);
  ${reflections ? '' : 'if (distance > surfaceWindow) { return; }'}
  let path=traceMotion(vec2f(x),ident(x,p.current));
  let q=path.xyz;
  if(path.w<=.5){${reflections ? ' countReflectionTap(index,1u);' : ''}return;}
  let nearest=clamp(vec2i(floor(q.xy+0.5)),vec2i(0),vec2i(p.size)-1);
  let partial=(p.mode & 2u)!=0u;
  let reason=rejection(x,q,nearest,partial);
`;

// Keep the original tap and weighting expressions for the strict and round-1 controls.
export const directWindowWGSL = /* wgsl */ `${windowBindingsAndGeometry}
${startWindowWGSL()}  if(reason!=0u || overflowMissing(nearest,p.source)){atomicAdd(&rejects[reason],1u);return;}
  atomicAdd(&rejects[0],1u);
  var weight=(surfaceWindow+1.0-distance)/(surfaceWindow+1.0);
  if(partial){weight*=footprintWeight(x,q.xy,nearest,q.z);}
  total[index]+=vec4f(radiance(nearest,p.source)*weight,weight);
}
`;

const windowGuidesWGSL = /* wgsl */ `
@group(0) @binding(11) var guides: texture_2d_array<f32>;
@group(0) @binding(12) var<storage, read_write> albedoSum: array<vec4f>;
@group(0) @binding(13) var<storage, read_write> normalSum: array<vec4f>;
fn loadAlbedo(at: vec2i, slot: u32) -> vec3f {
  // Captured albedo already includes the neutral white contribution of glass hits.
  return textureLoad(guides,at,i32(slot*2u),0).rgb;
}
fn loadNormal(at: vec2i, slot: u32) -> vec3f {
  let n=textureLoad(guides,at,i32(slot*2u+1u),0);
  // Decode before averaging, including zero vectors for misses. Retain the
  // length of the mean, which carries subpixel normal variation.
  return select(vec3f(0),(n.rgb-0.5)*2.0,n.a>0.0);
}
`;

export const createMixedWindowWGSL = (guides: boolean, reflections = false) => /* wgsl */ `${windowBindingsAndGeometry}
${guides ? windowGuidesWGSL : ''}${recoverHistoryWGSL}
${reflections ? reflectionWindowWGSL(guides ? 14 : 11) : ''}${startWindowWGSL(guides, reflections)}  var tap=HistoryTap(nearest,0.);
  if(reason==0u){
    tap.support=1.;
    if(partial){tap.support=footprintWeight(x,q.xy,nearest,q.z);}
  }
  if(distance <= surfaceWindow && partial && abs(p.delta)<=3 && (reason>=5u || (reason==0u && tap.support<1.))){
    tap=recoverTap(x,pos,q,tap);
  }
${reflections ? `  let accepted = distance <= surfaceWindow && tap.support>0. && !overflowMissing(tap.at,p.source);
  if (distance <= surfaceWindow) { atomicAdd(&rejects[select(reason,0u,accepted)],1u); }
  let tent = (radius+1.-distance)/(radius+1.);
  var weight = 0.;
  if (accepted) { weight = ((surfaceWindow+1.-distance)/(surfaceWindow+1.))*tap.support; }
  let rgb = select(vec3f(0),skyCorrection(x,tap.at,pos,radiance(tap.at,p.source)),accepted);
  var surfaceConfidence = 1.;
  if (accepted) { surfaceConfidence = dielectricSurfaceConfidence(x,q.xy,material); }
  accumulateReflection(x,index,tap,q,weight,rgb,tent,material.y,surfaceConfidence);` : `  if(tap.support<=0. || overflowMissing(tap.at,p.source)){atomicAdd(&rejects[reason],1u);return;}
  atomicAdd(&rejects[0],1u);
  let weight=(surfaceWindow+1.-distance)/(surfaceWindow+1.)*tap.support*dielectricSurfaceConfidence(x,q.xy,material);
  let rgb=skyCorrection(x,tap.at,pos,radiance(tap.at,p.source));
  total[index]+=vec4f(rgb*weight,weight);` }${guides ? `
  if ((p.mode & 8u)!=0u) {
    albedoSum[index]+=vec4f(loadAlbedo(tap.at,p.source)*weight,0.);
    normalSum[index]+=vec4f(loadNormal(tap.at,p.source)*weight,0.);
  }` : ''}
}
`;

export const mixedWindowWGSL = createMixedWindowWGSL(false);
