// The native trace outputs are bottom-first. Store the reflection data on the
// same top-first capture grid as the A2 window and its motion field.
export const captureReflectionsWGSL = /* wgsl */ `
struct Params { size: vec2u, slot: u32, samples: u32 }
struct Record { endpoint: vec4u, motion: vec4f }
@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var<storage, read> radianceSum: array<vec4f>;
@group(0) @binding(2) var<storage, read> albedoSum: array<vec4f>;
@group(0) @binding(3) var<storage, read> records: array<Record>;
@group(0) @binding(4) var<storage, read> hdr: array<vec4f>;
@group(0) @binding(5) var radianceOut: texture_storage_2d_array<rgba16float, write>;
@group(0) @binding(6) var endpointOut: texture_storage_2d_array<rgba32uint, write>;
@group(0) @binding(7) var motionOut: texture_storage_2d_array<rgba32float, write>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) g:vec3u) {
  if (any(g.xy >= p.size)) { return; }
  let source = (p.size.y - 1u - g.y) * p.size.x + g.x;
  let targetIndex = g.y * p.size.x + g.x;
  let record = records[2u*p.size.x*p.size.y+source];
  let samples = select(f32(p.samples),albedoSum[source].w,albedoSum[source].w>0.0);
  let reflected = clamp(radianceSum[source].rgb/max(1.0,samples),vec3f(0),max(hdr[targetIndex].rgb,vec3f(0)));
  let finite = all(abs(reflected) <= vec3f(65504));
  textureStore(radianceOut,vec2i(g.xy),i32(p.slot),vec4f(select(vec3f(0),reflected,finite),1.0));
  textureStore(endpointOut,vec2i(g.xy),i32(p.slot),record.endpoint);
  textureStore(motionOut,vec2i(g.xy),i32(p.slot),record.motion);
}
`;

export function reflectionWindowWGSL(binding: number) {
  return /* wgsl */ `
@group(0) @binding(${binding}) var reflected: texture_2d_array<f32>;
@group(0) @binding(${binding + 1}) var endpoints: texture_2d_array<u32>;
@group(0) @binding(${binding + 2}) var virtualMotions: texture_2d_array<f32>;
@group(0) @binding(${binding + 3}) var<storage, read_write> reflectedTotal: array<vec4f>;

fn reflection(at: vec2i, frame: u32) -> vec3f {
  return textureLoad(reflected,at,i32(frame),0).rgb;
}

fn endpoint(at: vec2i, frame: u32) -> vec4u {
  return textureLoad(endpoints,at,i32(frame),0);
}

fn virtualStep(q: vec2f, frame: u32, id: vec3u, revision: u32, key: vec2u) -> vec3f {
  if (!inFrame(q)) { return vec3f(0); }
  let origin = vec2i(floor(q));
  let phase = fract(q);
  var motion = vec2f(0); var support = 0.;
  for (var dy=0; dy<2; dy++) { for (var dx=0; dx<2; dx++) {
    let at = min(origin+vec2i(dx,dy),vec2i(p.size)-1);
    if (!sameMaterial(at,frame,id,revision) || any(endpoint(at,frame).xy!=key)) { continue; }
    let field = textureLoad(virtualMotions,at,i32(frame),0);
    let delta = select(field.xy,field.zw,(p.mode&16u)!=0u);
    if (any(abs(delta) >= vec2f(p.size))) { continue; }
    let w = select(1.-phase.x,phase.x,dx==1)*select(1.-phase.y,phase.y,dy==1);
    support += w;
    motion += w*delta;
  }}
  return vec3f(motion/max(support,1e-6),support);
}

fn reflectionAgreement(a: vec4u, b: vec4u) -> f32 {
  if (a.z == 0u || b.z == 0u) { return 0.; }
  let ra = unpack2x16float(a.w).x;
  let rb = unpack2x16float(b.w).x;
  let roughness = exp(-8.*abs(ra*ra-rb*rb));
  let d0 = bitcast<f32>(a.z);
  let d1 = bitcast<f32>(b.z);
  if (d0 < 0. && d1 < 0.) { return roughness; }
  let error = abs(d1-d0)/max(max(d1,d0),1e-4);
  return roughness * (1.-smoothstep(.08,.35,error));
}

fn virtualLanding(x: vec2i, id: vec3u, revision: u32, record: vec4u, surfaceQ: vec2f) -> vec3f {
  let count = arrayLength(&cameras);
  let signDelta = select(-1,1,p.delta>0);
  var q = vec2f(x);
  var frame = p.current;
  var confidence = 1.;
  for (var step=0; step<abs(p.delta); step++) {
    let next = u32((i32(frame)+signDelta+i32(count))%i32(count));
    if (signDelta < 0) {
      let m = virtualStep(q,frame,id,revision,record.xy);
      if (m.z < .5) { return vec3f(0); }
      q += m.xy;
      confidence = min(confidence,m.z);
    } else {
      let surfaceSeed = surfaceQ-vec2f(x);
      let displacement = surfaceSeed/f32(p.delta);
      let previousMotion = virtualStep(q,frame,id,revision,record.xy);
      let starting = q + select(displacement,-previousMotion.xy,previousMotion.z >= .5);
      var guess = starting;
      for (var iteration=0; iteration<4; iteration++) {
        let m = virtualStep(guess,next,id,revision,record.xy);
        if (m.z < .5) { break; }
        guess = q - m.xy;
      }
      let check = virtualStep(guess,next,id,revision,record.xy);
      if (check.z < .5 || distance(guess+check.xy,q) > .25) { return vec3f(0); }
      q = guess;
      confidence = min(confidence,check.z);
    }
    if (!inFrame(q)) { return vec3f(0); }
    let candidate = vec2i(floor(q+0.5));
    if (!sameMaterial(candidate,next,id,revision)) { return vec3f(0); }
    let prior = endpoint(candidate,next);
    if (any(prior.xy != record.xy)) { return vec3f(0); }
    // Test the reflected path on intermediate frames, including the landing.
    confidence = min(confidence,reflectionAgreement(record,prior));
    if (confidence <= 0.) { return vec3f(0); }
    frame = next;
  }
  return vec3f(q,confidence);
}

fn virtualWeight(x: vec2i, landing: vec3f, q: vec3f, record: vec4u) -> f32 {
  if (landing.z <= 0.) { return 0.; }
  let nearest = vec2i(floor(landing.xy+0.5));
  let pos = surface(x,p.current,0u);
  let oldPos = surface(nearest,p.source,0u);
  if (oldPos.w<=0.0001 || abs(coc(pos.w,p.current)-coc(oldPos.w,p.source))>.5 ||
      abs(oldPos.w-q.z)>.05*q.z || overflowMissing(nearest,p.source)) { return 0.; }
  let normal = surface(x,p.current,1u).xyz;
  let oldNormal = surface(nearest,p.source,1u).xyz;
  let alignment = clamp(dot(normal,oldNormal),-1.,1.);
  // The GGX lobe broadens continuously with alpha. Surface depth and
  // projected displacement bound the extra normal rotation at a curved hit.
  let roughness = unpack2x16float(record.w).x;
  let lobe = max(.04,2.*roughness*roughness);
  let angle = acos(alignment);
  let discrepancy = distance(landing.xy,q.xy);
  let normalWeight = 1.-smoothstep(lobe,lobe*2.+.01,angle);
  if (alignment <= 0.) { return 0.; }
  let coverage = smoothstep(.94,1.,min(hitCoverage(x,p.current),hitCoverage(nearest,p.source)));
  let footprint = footprintWeight(x,landing.xy,nearest,oldPos.w);
  return landing.z * normalWeight * coverage * footprint * smoothstep(.1,1.,discrepancy);
}

fn accumulateReflection(
  x: vec2i, index: u32, tap: HistoryTap, q: vec3f, weight: f32, surfaceRgb: vec3f, tent: f32
) {
  let record = endpoint(x,p.current);
  let roughnessCosine = unpack2x16float(record.w);
  let smoothness = clamp(1.-roughnessCosine.x,0.,1.);
  // A continuous dominant-lobe estimate. As the lobe broadens or becomes
  // grazing, the surface-motion candidate contributes more.
  let dominant = smoothness*smoothness*(.5+.5*roughnessCosine.y);
  let id = ident(x,p.current);
  let revision = revisionAt(x,p.current);
  var land = vec3f(0);
  if (record.z != 0u && dominant > 0.01 && hitCoverage(x,p.current)>.94) {
    land = virtualLanding(x,id,revision,record,q.xy);
  }
  let amount = dominant*virtualWeight(x,land,q,record);
  let virtualTap = vec2i(floor(land.xy+0.5));
  let srcHdr = radiance(tap.at,p.source);
  let positiveSurface = max(surfaceRgb,vec3f(0));
  let reflectedSurface = min(positiveSurface,reflection(tap.at,p.source) *
    (positiveSurface/max(srcHdr,vec3f(1e-12))));
  let srcEndpoint = endpoint(tap.at,p.source);
  let oldShift = textureLoad(virtualMotions,x,i32(p.current),0);
  let delta = select(oldShift.xy,oldShift.zw,(p.mode&16u)!=0u);
  let localMotion = motionSample(x,p.current).xy;
  let slip = length(delta-localMotion)*f32(abs(p.delta));
  let matchSurface = select(0.,reflectionAgreement(record,srcEndpoint),all(srcEndpoint.xy==record.xy));
  let validDelta = record.z != 0u && all(abs(delta) < vec2f(p.size));
  let mismatch = select(0.,dominant*smoothstep(.25,2.,slip)*(1.-matchSurface),validDelta);
  let surfaceWeight = weight*(1.-amount)*(1.-mismatch);
  let virtualW = tent*amount;
  total[index] += vec4f((surfaceRgb-reflectedSurface)*weight,weight);
  reflectedTotal[index] += vec4f(reflectedSurface*surfaceWeight +
    reflection(virtualTap,p.source)*virtualW,surfaceWeight+virtualW);
  if ((p.mode&32u)!=0u) {
    let offset = p.size.x*p.size.y;
    reflectedTotal[index+offset] += vec4f(f32(weight>0.), f32(virtualW>0.), f32(land.z>0.), 1.);
  }
}
`;
}
