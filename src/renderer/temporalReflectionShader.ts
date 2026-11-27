// The native trace outputs are bottom-first. Store the reflection data on the
// same top-first capture grid as the A2 window and its motion field.
export const createCaptureReflectionsWGSL = (planarExperiment = false) => /* wgsl */ `
${planarExperiment ? 'override EXPERIMENTAL_PLANAR_REFLECTIONS: bool = false;\n' : ''}struct Params { size: vec2u, slot: u32, samples: u32 }
struct Record { endpoint: vec4u, motion: vec4f }
@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var<storage, read> radianceSum: array<vec4f>;
@group(0) @binding(2) var<storage, read> albedoSum: array<vec4f>;
@group(0) @binding(3) var<storage, read> records: array<Record>;
@group(0) @binding(4) var<storage, read> hdr: array<vec4f>;
@group(0) @binding(5) var radianceOut: texture_storage_2d_array<rgba16float, write>;
@group(0) @binding(6) var endpointOut: texture_storage_2d_array<rgba32uint, write>;
struct CameraData { vp: mat4x4f, lens: vec4f }
@group(0) @binding(7) var<storage, read> cameraData: array<CameraData>;

fn centerIndex(at: vec2i) -> u32 {
  return u32(at.x) + p.size.x*(p.size.y-1u-u32(at.y));
}

fn curvaturePrimary(at: vec2i) -> Record {
  return records[p.size.x*p.size.y + centerIndex(at)];
}
fn curvatureNeighbor(at: vec2i, key: vec3u) -> bool {
  if (any(at < vec2i(0)) || any(at >= vec2i(p.size))) { return false; }
  return all(records[centerIndex(at)].endpoint.xyz == key);
}

fn normalDerivative(a: Record, b: Record) -> f32 {
  let dp=b.motion.xyz-a.motion.xyz;
  let dn=bitcast<vec3f>(b.endpoint.xyz)-bitcast<vec3f>(a.endpoint.xyz);
  return dot(dn,dp)/max(dot(dp,dp),1e-12);
}

fn axisCurvature(at: vec2i, axis: vec2i, key: vec3u, center: Record) -> vec3f {
  let hasLo=curvatureNeighbor(at-axis,key);
  let hasHi=curvatureNeighbor(at+axis,key);
  var lo=center;
  var hi=center;
  if (hasLo) { lo=curvaturePrimary(at-axis); }
  if (hasHi) { hi=curvaturePrimary(at+axis); }
  let mid=normalDerivative(lo,hi);
  let noise=abs(normalDerivative(center,hi)-normalDerivative(lo,center))*.5;
  return vec3f(mid,noise,select(0.,1.,hasLo && hasHi));
}

// The packed alpha marks a tangent-plane record with +1. A negative value
// stores the negated curvature confidence. -2 marks a rejected solve.
fn curvedDisplacement(pixel: vec2i, source: u32, record: Record, samples: f32) -> vec3f {
  let planar=record.motion.xy;
${planarExperiment ? '  if (EXPERIMENTAL_PLANAR_REFLECTIONS) { return vec3f(planar,1.); }\n' : ''}  let surfaceMotion=record.motion.zw;
  let distance=bitcast<f32>(record.endpoint.z);
  if (distance==0. || any(abs(planar)>=vec2f(p.size)) || any(abs(surfaceMotion)>=vec2f(p.size))) {
    return vec3f(planar,1.);
  }
  let camera=cameraData[p.slot];
  let position=curvaturePrimary(pixel);
  let depth=bitcast<f32>(position.endpoint.w);
  if (!(depth > 0.) || !(camera.lens.x > 0.)) { return vec3f(planar,1.); }
  let normal=bitcast<vec3f>(position.endpoint.xyz);
  let key=records[source].endpoint.xyz;
  let kx=axisCurvature(pixel,vec2i(1,0),key,position);
  let ky=axisCurvature(pixel,vec2i(0,1),key,position);
  let k=vec2f(kx.x,ky.x);
  let parallax=planar-surfaceMotion;
  let lobes=unpack2x16float(record.endpoint.w);
  let cosine=lobes.y;
  let vp=camera.vp;
  let wAxis=vec3f(vp[0].w,vp[1].w,vp[2].w);
  if (dot(wAxis,wAxis) <= 1e-12) { return vec3f(planar,1.); }
  let vpPoint=vp*vec4f(position.motion.xyz,1.);
  let vpNormal=vp*vec4f(normal,0.);
  let planeNormal=(vpNormal.xy-vpPoint.xy/vpPoint.w*vpNormal.w)*vec2f(f32(p.size.x),-f32(p.size.y));
  var incidence=vec2f(1,0);
  if (dot(planeNormal,planeNormal)>1e-8) { incidence=normalize(planeNormal); }
  let incidence2=incidence*incidence;
  let projected=(vec2f(pixel)+.5-.5*vec2f(p.size))/camera.lens.x;
  let eyeRange=depth*sqrt(1.+dot(projected,projected));
  let reach=select(eyeRange,distance*eyeRange/(eyeRange+distance),distance>0.);
  let curvature=vec2f(dot(k,incidence2),dot(k,incidence2.yx));
  let power=2.*reach*vec2f(1./max(.05,cosine),cosine);
  let u=power*curvature;
  let denominator=1.+u;
  if (max(abs(u.x),abs(u.y))<1e-4) { return vec3f(planar,1.); }
  if (any(denominator<vec2f(.25)) || min(kx.z,ky.z)==0.) { return vec3f(planar,-2.); }
  let sagittal=vec2f(-incidence.y,incidence.x);
  let components=vec2f(dot(parallax,incidence),dot(parallax,sagittal));
  let adjusted=components/denominator;
  let correction=adjusted.x*incidence+adjusted.y*sagittal;
  let localTurns=max(abs(k.x),abs(k.y))*eyeRange*length(correction)/(camera.lens.x*max(.2,cosine));
  let uncertainty=vec2f(kx.y,ky.y);
  let deltaU=power*vec2f(dot(uncertainty,incidence2),dot(uncertainty,incidence2.yx));
  let estimationError=length(adjusted*deltaU/denominator);
  let aperture=camera.lens.x*camera.lens.y*(1./max(depth,1e-4)-select(0.,1./(depth+distance),distance>0.));
  let residual=length(correction)*localTurns+estimationError+aperture*max(abs(u.x/denominator.x),abs(u.y/denominator.y));
  // A nearest-texel tap adds up to half a pixel of rounding on each
  // axis. This matters more for narrow projected lobes and as current-frame
  // sample noise falls with 1/sqrt(spp). Keep the tangent-plane validation
  // when the added alignment error outweighs the expected noise reduction.
  let lobeWidth = .5 + camera.lens.x*lobes.x*lobes.x/max(denominator.x,denominator.y);
  let samplePrecision = sqrt(max(1.,samples/3.))-1.;
  let alignmentCost = samplePrecision*(.5+residual)/lobeWidth;
  if (alignmentCost >= 1.) { return vec3f(planar,1.); }
  let trust = (1.-smoothstep(.10,.45,residual))*smoothstep(.25,.48,cosine)*
    (1.-smoothstep(.5,1.,alignmentCost));
  // The smallest normal half-float keeps the model tag on devices that
  // flush subnormals when storing the confidence.
  let packedTrust = select(-2.,-trust,trust >= 0.00006103515625);
  return vec3f(surfaceMotion+correction,packedTrust);
}

fn packReflectionMetadata(raw: vec4u) -> u32 {
  let distance = bitcast<f32>(raw.z);
  // A logarithmic fixed-point code preserves relative distance precision from
  // close-ups to large scenes. Zero marks an invalid record and 65535 is sky.
  let logarithm = clamp(log2(max(distance, exp2(-120.))),-120.,120.);
  let finiteDistance = 1u + u32(round((logarithm+120.)*256.));
  let depth = select(select(finiteDistance,65535u,distance<0.),0u,raw.z==0u);
  let lobes = vec2u(round(clamp(unpack2x16float(raw.w),vec2f(0),vec2f(1))*255.));
  return depth | (lobes.x<<16u) | (lobes.y<<24u);
}
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) g:vec3u) {
  if (any(g.xy >= p.size)) { return; }
  let source = centerIndex(vec2i(g.xy));
  let targetIndex = g.y * p.size.x + g.x;
  let record = records[2u*p.size.x*p.size.y+source];
  let samples = select(f32(p.samples),albedoSum[source].w,albedoSum[source].w>0.0);
  let reflected = clamp(radianceSum[source].rgb/max(1.0,samples),vec3f(0),max(hdr[targetIndex].rgb,vec3f(0)));
  let finite = all(abs(reflected) <= vec3f(65504));
  let corrected = curvedDisplacement(vec2i(g.xy),source,record,samples);
  textureStore(radianceOut,vec2i(g.xy),i32(p.slot),vec4f(select(vec3f(0),reflected,finite),corrected.z));
  // Keep invalid motion outside the viewport, including after conversion to half.
  let displacement = pack2x16float(clamp(corrected.xy,vec2f(-65504),vec2f(65504)));
  textureStore(endpointOut,vec2i(g.xy),i32(p.slot),
    vec4u(record.endpoint.xy,displacement,packReflectionMetadata(record.endpoint)));
}
`;
export const captureReflectionsWGSL = createCaptureReflectionsWGSL();

export function reflectionWindowWGSL(binding: number, sampleTiles = false, diagnostics = false) {
  return /* wgsl */ `
@group(0) @binding(${binding}) var reflected: texture_2d_array<f32>;
@group(0) @binding(${binding + 1}) var endpoints: texture_2d_array<u32>;
@group(0) @binding(${binding + 2}) var<storage, read_write> reflectedTotal: array<vec4f>;
const OPTICAL_SILHOUETTE = 14.;

fn reflectionModel(at: vec2i, frame: u32) -> f32 {
  return textureLoad(reflected,at,i32(frame),0).a;
}

fn modelTrust(model: f32) -> f32 {
  return select(select(-model,0.,model < -1.),1.,model >= 0.);
}

fn reflection(at: vec2i, frame: u32) -> vec3f {
  return textureLoad(reflected,at,i32(frame),0).rgb;
}

fn reflectedSurfaceRgb(at: vec2i, surfaceRgb: vec3f) -> vec3f {
  let srcHdr = radiance(at,p.source);
  let positiveSurface = max(surfaceRgb,vec3f(0.));
  return min(positiveSurface,reflection(at,p.source)*(positiveSurface/max(srcHdr,vec3f(1e-12))));
}

fn endpoint(at: vec2i, frame: u32) -> vec4u {
  return textureLoad(endpoints,at,i32(frame),0);
}
fn distanceCode(record: vec4u) -> u32 { return record.w & 65535u; }
fn roughnessCosine(record: vec4u) -> vec2f {
  return vec2f((vec2u(record.w)>>vec2u(16u,24u)) & vec2u(255u))/255.;
}

fn virtualStep(q: vec2f, frame: u32, id: vec3u, revision: u32, key: vec2u) -> vec4f {
  if (!inFrame(q)) { return vec4f(0); }
  let origin = vec2i(floor(q));
  let phase = fract(q);
  var motion = vec2f(0); var support = 0.; var confidence = 0.;
  for (var dy=0; dy<2; dy++) { for (var dx=0; dx<2; dx++) {
    let at = min(origin+vec2i(dx,dy),vec2i(p.size)-1);
    let record = endpoint(at,frame);
    if (!sameMaterial(at,frame,id,revision) || any(record.xy!=key)) { continue; }
    let delta = unpack2x16float(record.z);
    let trust = modelTrust(reflectionModel(at,frame));
    if (trust <= 0. || any(abs(delta) >= vec2f(p.size))) { continue; }
    let w = select(1.-phase.x,phase.x,dx==1)*select(1.-phase.y,phase.y,dy==1);
    support += w;
    confidence += w*trust;
    motion += w*delta;
  }}
  return vec4f(motion/max(support,1e-6),support,confidence/max(support,1e-6));
}

fn reflectionAgreement(a: vec4u, b: vec4u) -> f32 {
  let d0 = distanceCode(a);
  let d1 = distanceCode(b);
  if (d0 == 0u || d1 == 0u) { return 0.; }
  let ra = roughnessCosine(a).x;
  let rb = roughnessCosine(b).x;
  let roughness = exp(-8.*abs(ra*ra-rb*rb));
  if (d0 == 65535u || d1 == 65535u) { return select(0.,roughness,d0==d1); }
  let error = 1.-exp2(-abs(f32(d1)-f32(d0))/256.);
  return roughness * (1.-smoothstep(.08,.35,error));
}

// Near an optical silhouette the center reflection and jittered rays can
// land on different objects even when the virtual center maps correctly.
fn endpointInterior(at: vec2i, slot: u32, id: vec3u, revision: u32, record: vec4u) -> bool {
  let offsets = array<vec2i, 4>(vec2i(-1, 0), vec2i(1, 0), vec2i(0, -1), vec2i(0, 1));
  for (var i = 0u; i < 4u; i++) {
    let q = at+offsets[i];
    if (any(q < vec2i(0)) || any(q >= vec2i(p.size)) || !sameMaterial(q,slot,id,revision)) { return false; }
    let old = endpoint(q,slot);
    if (any(old.xy != record.xy) || reflectionAgreement(record,old) < .6) { return false; }
  }
  return true;
}

// Debug counts pack four eight-bit bins in each lane. A window has at most 64 neighbors.
fn countReflectionTap(index: u32, reason: u32) {
  if ((p.mode&32u)==0u) { return; }
  let offset = index + p.size.x*p.size.y*2u;
  var bins = bitcast<vec4u>(reflectedTotal[offset]);
  bins[reason/4u] += 1u << (8u*(reason%4u));
  reflectedTotal[offset] = bitcast<vec4f>(bins);
}

fn invertVirtualStep(q: vec2f, seed: vec2f, frame: u32, id: vec3u, revision: u32, key: vec2u) -> vec4f {
  var guess = seed;
  for (var iteration=0; iteration<4; iteration++) {
    let m = virtualStep(guess,frame,id,revision,key);
    if (m.z < .5) { return vec4f(0,0,0,4); }
    guess = q-m.xy;
  }
  let check = virtualStep(guess,frame,id,revision,key);
  if (check.z < .5) { return vec4f(0,0,0,4); }
  if (distance(guess+check.xy,q) > .25) { return vec4f(0,0,0,5); }
  return vec4f(guess,min(check.z,check.w),0);
}

fn virtualLanding(x: vec2i, id: vec3u, revision: u32, record: vec4u, surfaceQ: vec2f) -> vec4f {
  let count = arrayLength(&cameras);
  let signDelta = select(-1,1,p.delta>0);
  var q = vec2f(x);
  var frame = p.current;
  var confidence = 1.;
  for (var step=0; step<abs(p.delta); step++) {
    let next = u32((i32(frame)+signDelta+i32(count))%i32(count));
    if (signDelta < 0) {
      let m = virtualStep(q,frame,id,revision,record.xy);
      if (m.z < .5) { return vec4f(0,0,0,3); }
      q += m.xy;
      confidence = min(confidence,min(m.z,m.w));
    } else {
      let surfaceSeed = q+(surfaceQ-vec2f(x))/f32(p.delta);
      let previousMotion = virtualStep(q,frame,id,revision,record.xy);
      let starting = select(surfaceSeed,q-previousMotion.xy,previousMotion.z>=.5);
      var inverted = invertVirtualStep(q,starting,next,id,revision,record.xy);
      // This alternative only seeds the inverse. The later endpoint and the
      // residual of its actual virtual motion still have to agree.
      if (inverted.z <= 0. && distance(starting,surfaceSeed) > .5) {
        inverted = invertVirtualStep(q,surfaceSeed,next,id,revision,record.xy);
      }
      if (inverted.z <= 0.) { return inverted; }
      q = inverted.xy;
      confidence = min(confidence,inverted.z);
    }
    if (!inFrame(q)) { return vec4f(0,0,0,6); }
    let candidate = vec2i(floor(q+0.5));
    if (!sameMaterial(candidate,next,id,revision)) { return vec4f(0,0,0,7); }
    let prior = endpoint(candidate,next);
    if (any(prior.xy != record.xy)) { return vec4f(0,0,0,8); }
    // Test the reflected path on intermediate frames, including the landing.
    confidence = min(confidence,reflectionAgreement(record,prior));
    if (confidence <= 0.) { return vec4f(0,0,0,9); }
    frame = next;
  }
  return vec4f(q,confidence,0);
}

fn virtualWeight(x: vec2i, landing: vec4f, surfaceDepth: f32, record: vec4u) -> vec2f {
  if (landing.z <= 0.) { return vec2f(0,landing.w); }
  let nearest = vec2i(floor(landing.xy+0.5));
  let pos = surface(x,p.current,0u);
  let oldPos = surface(nearest,p.source,0u);
  if (oldPos.w<=0.0001 || abs(oldPos.w-surfaceDepth)>.05*surfaceDepth) { return vec2f(0,10); }
  if (abs(coc(pos.w,p.current)-coc(oldPos.w,p.source))>.5) { return vec2f(0,11); }
  if (overflowMissing(nearest,p.source)) { return vec2f(0,10); }
  let normal = surface(x,p.current,1u).xyz;
  let oldNormal = surface(nearest,p.source,1u).xyz;
  let alignment = clamp(dot(normal,oldNormal),-1.,1.);
  // The GGX lobe broadens continuously with alpha. For a tighter lobe,
  // even small normal changes can put the reflected feature outside the tap.
  let roughness = roughnessCosine(record).x;
  let lobe = max(.04,2.*roughness*roughness);
  let angle = acos(alignment);
  let normalWeight = 1.-smoothstep(lobe,lobe*2.+.01,angle);
  if (normalWeight <= 0.) { return vec2f(0,12); }
  let coverage = smoothstep(.94,1.,min(hitCoverage(x,p.current),hitCoverage(nearest,p.source)));
  let footprint = footprintWeight(x,landing.xy,nearest,oldPos.w);
  if (coverage <= 0. || footprint <= 0.) { return vec2f(0,13); }
  return vec2f(min(landing.z,modelTrust(reflectionModel(nearest,p.source))) * normalWeight * coverage * footprint,0);
}

// View-space position of a center hit. lens.x is the focal length in pixels;
// an orthographic projection has no perspective row.
fn viewPoint(at: vec2i, depth: f32) -> vec3f {
  let vp = cameras[p.current].vp;
  let perspective = dot(vec3f(vp[0].w,vp[1].w,vp[2].w),vec3f(vp[0].w,vp[1].w,vp[2].w)) > 1e-12;
  let scale = select(1.,depth,perspective)/cameras[p.current].lens.x;
  return vec3f((vec2f(at)-.5*vec2f(p.size))*vec2f(1,-1)*scale,depth);
}

// Signed normal curvature along one screen axis, from the center normals and
// depths of neighbors on the same surface. Shading normals are used, so normal
// maps count as curvature, as they do for the reflected image.
fn axisCurvature(x: vec2i, axis: vec2i, id: vec3u, revision: u32) -> f32 {
  let vp = cameras[p.current].vp;
  let right = normalize(vec3f(vp[0].x,vp[1].x,vp[2].x));
  let up = normalize(vec3f(vp[0].y,vp[1].y,vp[2].y));
  let basis = mat3x3f(right,up,normalize(cross(up,right)));
  var ends = array<vec2i,2>(x,x);
  for (var side=0; side<2; side++) {
    let at = x+select(-axis,axis,side==1);
    if (all(at>=vec2i(0)) && all(at<vec2i(p.size)) && sameMaterial(at,p.current,id,revision) &&
        surface(at,p.current,0u).w>0.0001) { ends[side] = at; }
  }
  if (all(ends[0]==ends[1])) { return 0.; }
  let a = viewPoint(ends[0],surface(ends[0],p.current,0u).w);
  let b = viewPoint(ends[1],surface(ends[1],p.current,0u).w);
  let dp = basis*(b-a);
  let dn = surface(ends[1],p.current,1u).xyz-surface(ends[0],p.current,1u).xyz;
  return dot(dn,dp)/max(dot(dp,dp),1e-12);
}

// The virtual image is built on the tangent plane. On a mirror of normal
// curvature k, a feature at distance d forms its image at a different depth,
// and the planar landing misses by parallax*|u/(1+u)| with
// u = 2*k*cos*d*D/(D+d) (D is the view depth of the surface). The lens
// aperture adds the image's defocus parallax as a second baseline. Trust
// fades from 0.1 px to 0.5 px of predicted error.
fn planarTrust(x: vec2i, id: vec3u, revision: u32, record: vec4u, parallax: vec2f) -> f32 {
  let code = distanceCode(record);
  let slip = length(parallax);
  let depth = surface(x,p.current,0u).w;
  let reach = exp2((f32(code)-1.)/256.-120.);
  let sky = code == 65535u;
  let lens = cameras[p.current].lens;
  let aperture = lens.x*lens.y*(1./max(depth,1e-4)-select(1./(depth+reach),0.,sky));
  if (code == 0u || slip+aperture < 1e-4) { return 1.; }
  let kx = axisCurvature(x,vec2i(1,0),id,revision);
  let ky = axisCurvature(x,vec2i(0,1),id,revision);
  let direction = parallax/max(slip,1e-6);
  let scale = 2.*roughnessCosine(record).y*select(reach*depth/(depth+reach),depth,sky);
  let u = scale*vec2f(kx*direction.x*direction.x+ky*direction.y*direction.y,
    select(ky,kx,abs(kx)>abs(ky)));
  if (any(1.+u < vec2f(.25))) { return 0.; }
  let error = dot(vec2f(slip,aperture),abs(u/(1.+u)));
  return 1.-smoothstep(.1,.5,error);
}

fn accumulateReflection(
  x: vec2i, index: u32, tap: HistoryTap, q: vec3f, weight: f32, surfaceRgb: vec3f, tent: f32,
  metallic: f32, surfaceConfidence: f32, glossyDielectric: bool
) {
  let record = endpoint(x,p.current);
  let lobes = roughnessCosine(record);
  let smoothness = 1.-lobes.x;
  // A continuous dominant-lobe estimate. As the lobe broadens or becomes
  // grazing, the surface-motion candidate contributes more.
  let roughness = lobes.x;
  let dominant = mix(1.,smoothness*smoothness*(.5+.5*lobes.y),
    smoothstep(0.,.25,roughness));
  let id = ident(x,p.current);
  let revision = revisionAt(x,p.current);
  let delta = unpack2x16float(record.z);
  let localMotion = motionSample(x,p.current).xy;
  let validDelta = distanceCode(record) != 0u && all(abs(delta) < vec2f(p.size));
  var land = vec4f(0,0,0,2);
  if (distanceCode(record) != 0u && dominant > 0.01 && hitCoverage(x,p.current)>.94) {
    land = virtualLanding(x,id,revision,record,q.xy);
  }
  // The image parallax is the gap between the planar and the surface landing.
  // Without a landing, extrapolate the current frame's virtual motion.
  let slipped = select(vec2f(0),(delta-localMotion)*f32(abs(p.delta)),validDelta);
  let parallax = select(slipped,land.xy-q.xy,land.z>0.);
  let model = reflectionModel(x,p.current);
  var trust = modelTrust(model);
  if (model >= 0.) { trust = planarTrust(x,id,revision,record,parallax); }
  var validation = virtualWeight(x,land,q.z,record);
  let virtualTap = vec2i(floor(land.xy+0.5));
  let isMetal = metallic > METALLIC_THRESHOLD;
  if (glossyDielectric && roughness < .15 && trust > 0. && validation.x > 0. &&
      (surfaceConfidence < .95 || length(parallax) > .15) &&
      (!endpointInterior(x,p.current,id,revision,record) ||
       !endpointInterior(virtualTap,p.source,id,revision,record))) {
    validation = vec2f(0.,OPTICAL_SILHOUETTE);
  }
  // At small parallax the projected separation can be inside the lobe's
  // footprint. In that case a changing view still limits optical confidence.
  let footprint = max(.5,cameras[p.current].lens.x*roughness*roughness);
  let reliableParallax = smoothstep(footprint,2.*footprint,length(parallax));
  let opticalConfidence = select(mix(surfaceConfidence,1.,reliableParallax),1.,!glossyDielectric || roughness >= .15);
  let amount = dominant*validation.x*opticalConfidence;
  let reflectedSurface = reflectedSurfaceRgb(tap.at,surfaceRgb);
  let srcEndpoint = endpoint(tap.at,p.source);
  let slip = length(slipped);
  let matchSurface = select(0.,reflectionAgreement(record,srcEndpoint),all(srcEndpoint.xy==record.xy));
  let mismatch = select(0.,dominant*smoothstep(.25,2.,slip)*(1.-matchSurface),validDelta);
  // Optical parallax can invalidate a reflected surface sample even when
  // geometric reprojection succeeds. The unreflected residual keeps its weight.
  let fade = mix(1.,smoothstep(.05,.20,roughness),smoothstep(.25,2.,select(slip,length(parallax),glossyDielectric)));
  let fallback = select(1.,fade,isMetal || glossyDielectric);
  let geometricFallback = mix(1.,(1.-amount)*(1.-mismatch)*fallback,trust);
  var surfaceWeight = select(weight*min(surfaceConfidence,geometricFallback),0.,validation.y==OPTICAL_SILHOUETTE);
  ${diagnostics ? 'var reflectedLightingLimited = false;\n  ' : ''}if (surfaceWeight > 0.) { ${diagnostics ? `
    let lighting = lightingConfidence(x,tap.at,true);
    reflectedLightingLimited = lighting<.95;
    surfaceWeight *= lighting;
  ` : 'surfaceWeight *= lightingConfidence(x,tap.at,true);'} }
  var virtualW = tent*amount*trust;
  if (virtualW > 0.) { ${diagnostics ? `
    let lighting = lightingConfidence(x,virtualTap,true);
    reflectedLightingLimited = reflectedLightingLimited || lighting<.95;
    virtualW *= lighting;
  ` : 'virtualW *= lightingConfidence(x,virtualTap,true);'}${sampleTiles ?
    ' virtualW *= sampleWeight(virtualTap,p.source,fullCoverage(x,virtualTap));' : ''} }
${diagnostics ? `  if (weight>0.) { diagnosticTap(index,1u); }
  let hasEndpoint = distanceCode(record)!=0u && dominant>.01;
  if (hasEndpoint && surfaceWeight+virtualW>0.) { diagnosticTap(index,2u); }
  diagnosticReason(index,6u,hasEndpoint && (isMetal || glossyDielectric) && fade<.95 && trust>.05);
  diagnosticReason(index,7u,hasEndpoint && trust<.95);
  diagnosticReason(index,8u,hasEndpoint && validation.x<=0. && validation.y!=OPTICAL_SILHOUETTE);
  diagnosticReason(index,9u,validation.y==OPTICAL_SILHOUETTE);
  diagnosticReason(index,10u,glossyDielectric && surfaceConfidence<.95);
  diagnosticReason(index,12u,reflectedLightingLimited);
` : ''}  total[index] += vec4f((surfaceRgb-reflectedSurface)*weight,weight);
  reflectedTotal[index] += vec4f(reflectedSurface*surfaceWeight +
    reflection(virtualTap,p.source)*virtualW,surfaceWeight+virtualW);
  if ((p.mode&32u)!=0u) {
    let offset = p.size.x*p.size.y;
    countReflectionTap(index, u32(validation.y));
    reflectedTotal[index+offset] += vec4f(f32(weight>0.), f32(virtualW>0.), f32(land.z>0.), 1.);
  }
}
`;
}
