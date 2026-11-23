import {temporalMetadataWGSL, temporalPostSurfaceWGSL} from './temporalKernels.js';


// The OIDN snapshots in the post ring hold floating-point sRGB codes (0–255).
// Read only the original snapshots so that one impulsive frame cannot propagate recursively.
const postBindings = /* wgsl */ `
struct Params { size: vec2u, slot: u32, capacity: u32, past: i32, future: i32, revisionStride:u32, geometrySlot:u32 }
struct Camera { vp: mat4x4f, lens: vec4f }
@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var surfaces: texture_2d_array<f32>;
@group(0) @binding(2) var ids: texture_2d_array<u32>;
@group(0) @binding(3) var colors: texture_2d_array<f32>;
@group(0) @binding(4) var blurred: texture_2d_array<f32>;
@group(0) @binding(5) var<storage,read> cameras: array<Camera>;
@group(0) @binding(6) var<storage,read_write> output: array<vec4f>;
@group(0) @binding(7) var motions: texture_2d_array<f32>;
@group(0) @binding(8) var<storage,read> changedMaterials: array<u32>;

${temporalMetadataWGSL}
${temporalPostSurfaceWGSL}
fn luminance(rgb: vec3f) -> f32 { return dot(rgb, vec3f(.2126,.7152,.0722)); }
fn inside(q:vec2f)->bool{return all(q>=vec2f(0))&&all(q<=vec2f(p.size)-1.0);}
fn nearestPixel(q:vec2f)->vec2i{return clamp(vec2i(floor(q+.5)),vec2i(0),vec2i(p.size)-1);}
fn materialChanged(id:u32,slot:u32)->bool{
  let row=slot*p.revisionStride;let count=changedMaterials[row];var low=0u;var high=count;
  if(count==0xffffffffu){return true;}
  for(var iteration=0u;iteration<32u && low<high;iteration++){
    let mid=low+(high-low)/2u;let value=changedMaterials[row+1u+mid];
    if(value==id){return true;}if(value<id){low=mid+1u;}else{high=mid;}
  }
  return false;
}
fn motionAt(q:vec2f,slot:u32,id:vec3u,revision:u32)->vec4f{
  if(!inside(q)){return vec4f(0);}let origin=vec2i(floor(q));let phase=fract(q);var value=vec4f(0);var total=0.;
  for(var dy=0;dy<2;dy++){for(var dx=0;dx<2;dx++){
    let at=origin+vec2i(dx,dy);let identity=textureLoad(ids,at,i32(slot),0);if(any(at>=vec2i(p.size))||any(identity.xyz!=id)||identity.w!=revision){continue;}
    let m=motionSample(at, slot);if(m.w!=3.){continue;}
    let w=select(1.-phase.x,phase.x,dx==1)*select(1.-phase.y,phase.y,dy==1);value+=m*w;total+=w;
  }}if(total<=0.){return vec4f(0);}return vec4f(value.xyz/total,3.);
}
fn trace(dt:i32,x:vec2f,id:vec3u,revision:u32)->vec4f{
  var q=x;var depth=postSurface(nearestPixel(q),p.geometrySlot,1).x;var normal=postSurface(nearestPixel(q),p.geometrySlot,2).xyz;
  for(var step=0;step<abs(dt);step++){
    let laterI=i32(p.geometrySlot)+select(-step,step+1,dt>0);let cap=i32(arrayLength(&cameras));let later=u32((laterI%cap+cap)%cap);
    let prior=(later+u32(cap)-1u)%u32(cap);let src=select(prior,later,dt<0);let dst=select(later,prior,dt<0);
    let srcAt=nearestPixel(q);let srcId=textureLoad(ids,srcAt,i32(src),0);if(any(srcId.xyz!=id)||srcId.w!=revision||dot(normal,postSurface(srcAt,src,2).xyz)<.95){return vec4f(q,depth,0);}
    var m=motionAt(q,later,id,revision);if(m.w!=3.){return vec4f(q,depth,0);}var next=q;
    if(dt<0){next=q+m.xy;depth=m.z;}else{
      next=q-m.xy;var found=true;
      for(var iteration=0;iteration<4;iteration++){let edge=motionAt(next,later,id,revision);if(edge.w!=3.){found=false;break;}next=q-edge.xy;m=edge;}
      if(!found){return vec4f(q,depth,0);}let edge=motionAt(next,later,id,revision);
      if(edge.w!=3.||length(next+edge.xy-q)>=.05){return vec4f(q,depth,0);}
      depth+=postSurface(nearestPixel(next),later,1).x-edge.z;
    }
    if(!inside(next)){return vec4f(q,depth,0);}let dstAt=nearestPixel(next);
    let dstId=textureLoad(ids,dstAt,i32(dst),0);if(any(dstId.xyz!=id)||dstId.w!=revision||dot(normal,postSurface(dstAt,dst,2).xyz)<.95){return vec4f(q,depth,0);}
    q=next;normal=postSurface(dstAt,dst,2).xyz;
  }return vec4f(q,depth,1);
}

`;

const startPostWGSL = /* wgsl */ `
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) g: vec3u) {
  if (any(g.xy>=p.size)) { return; }
  let x=vec2i(g.xy);
  let index=g.y*p.size.x+g.x;
  let pos=postSurface(x,p.geometrySlot,0);
  let depth=postSurface(x,p.geometrySlot,1);
  let normal=postSurface(x,p.geometrySlot,2);
  if (pos.w<=.5 || depth.w<=.5 || normal.w<=.5) { return; }
  let identity=textureLoad(ids,x,i32(p.geometrySlot),0);let id=identity.xyz;let revision=identity.w;
  let low=textureLoad(blurred,x,i32(p.slot),0).rgb;
`;

// Compile the reference estimator separately for pixel-exact A/B comparisons.
export const vetoShader = /* wgsl */ `${postBindings}
fn glintSupport(q: vec2f, slot: u32, currentY: f32, contrast: f32) -> f32 {
  let near=vec2i(floor(q+.5));
  var peak=0.;
  for(var dy=-1;dy<=1;dy++){
    for(var dx=-1;dx<=1;dx++){
      let at=clamp(near+vec2i(dx,dy),vec2i(0),vec2i(p.size)-1);
      let color=luminance(textureLoad(colors,at,i32(slot),0).rgb);
      let low=luminance(textureLoad(blurred,at,i32(slot),0).rgb);
      let strength=smoothstep(.45,.8,(color-low)/max(contrast,1.));
      peak=max(peak,strength*smoothstep(-8.,0.,color-currentY));
    }
  }
  return peak;
}

${startPostWGSL}
  let current=output[index];
  let currentY=luminance(current.rgb);
  let contrast=max(0.,currentY-luminance(low));
  var supported=0.;
  var witnesses=0.;
  var nearMax=-1.;
  var nearCount=0u;
  var sum=vec3f(0);
  var mass=0.0;
  var secondMoment=0.0;
  var maxY=-1.;
  var maxContribution=vec3f(0.);
  var maxWeight=0.;
  var usable=0u;

  for (var dt=-p.past; dt<=p.future; dt++) {
    if (dt==0) { continue; }
    let slot=u32((i32(p.slot)+dt+i32(p.capacity))%i32(p.capacity));
    if(materialChanged(id.z,slot)){continue;}
    let geometryCapacity=i32(arrayLength(&cameras));
    let geometrySlot=u32((i32(p.geometrySlot)+dt+geometryCapacity)%geometryCapacity);
    let path=trace(dt,vec2f(x),id,revision);if(path.w<=.5){continue;}
    let q=path.xy;
    let endpointNormal=postSurface(nearestPixel(q),geometrySlot,2).xyz;
    if (any(q<vec2f(0)) || any(q>vec2f(p.size-1u))) { continue; }
    let landing=nearestPixel(q);let landingDepth=postSurface(landing,geometrySlot,1);
    if(landingDepth.w<=.5||abs(landingDepth.x-path.z)>.015*path.z||
      abs(cameras[p.geometrySlot].lens.x*cameras[p.geometrySlot].lens.y*abs(1./max(depth.x,1e-4)-1./cameras[p.geometrySlot].lens.z)-
          cameras[geometrySlot].lens.x*cameras[geometrySlot].lens.y*abs(1./max(path.z,1e-4)-1./cameras[geometrySlot].lens.z))>.5){continue;}

    // A real specular peak may migrate across a subpixel silhouette. A nearby
    // moving highlight can veto correction, but cannot supply color/history.
    if(abs(dt)==1 && contrast>3.){
      supported=max(supported,glintSupport(q,slot,currentY,contrast));
    }
    let origin=vec2i(floor(q));
    let phase=fract(q);
    var witness=0.;
    var rgb=vec3f(0);
    var lowSum=vec3f(0);
    var coverage=0.0;
    for (var dy=0; dy<2; dy++) {
      for (var dx=0; dx<2; dx++) {
        let y=min(origin+vec2i(dx,dy),vec2i(p.size)-1);
        let otherId=textureLoad(ids,y,i32(geometrySlot),0);if (any(otherId.xyz!=id)||otherId.w!=revision) { continue; }
        let otherPos=postSurface(y,geometrySlot,0);
        let otherDepth=postSurface(y,geometrySlot,1);
        let otherNormal=postSurface(y,geometrySlot,2);
        let minDot=mix(.72,.95,smoothstep(.45,1.,length(vec2f(y)-q)));
        if (otherPos.w<=.5 || otherDepth.w<=.5 || otherNormal.w<=.5 ||
            abs(otherDepth.x-path.z)>.015*max(otherDepth.x,path.z) ||
            dot(endpointNormal,otherNormal.xyz)<minDot) { continue; }
        let weight=select(1-phase.x,phase.x,dx==1)*select(1-phase.y,phase.y,dy==1);
        coverage+=weight;
        let color=textureLoad(colors,y,i32(slot),0).rgb;
        let localLow=textureLoad(blurred,y,i32(slot),0).rgb;
        rgb+=weight*color;
        lowSum+=weight*localLow;
        if(weight>.16 && luminance(color)>=currentY-3. &&
            luminance(color-localLow)>=max(6.,.75*contrast)){witness=1.;}
      }
    }
    if (coverage<.2) { continue; }
    let neighbor=rgb/coverage;
    let difference=dot(abs(lowSum/coverage-low),vec3f(1./3.));
    witnesses+=witness*select(.25,1.,abs(dt)<=1);
    if(abs(dt)==1){
      nearCount++;
      nearMax=max(nearMax,luminance(neighbor));
    }
    let weight=coverage*exp(-pow(f32(abs(dt))/3.,2.))/(1.+pow(difference/18.,2.));
    if(weight>.08){usable++;}
    if(luminance(neighbor)>maxY){
      maxY=luminance(neighbor);
      maxContribution=weight*neighbor;
      maxWeight=weight;
    }
    sum+=weight*neighbor;
    mass+=weight;
    secondMoment+=weight*luminance(neighbor)*luminance(neighbor);
  }
  if (mass<=0.0) { return; }

  var mean=sum/mass;
  if(usable>=4u && witnesses<.5 && mass-maxWeight>1.){
    mean=mix(mean,(sum-maxContribution)/(mass-maxWeight),.65);
  }
  let residual=luminance(current.rgb)-luminance(mean);
  let spread=sqrt(max(0.,secondMoment/mass-pow(luminance(sum/mass),2.)));
  // Correct a bright local peak only to the extent that its positive residual
  // exceeds the temporal spread. A stable edge can have large spatial contrast.
  let excess=max(0.,residual-max(2.,.9*spread));
  let local=luminance(current.rgb)-luminance(low);
  let isolated=nearCount==select(1u,2u,p.future>0 && p.past>0) && currentY-nearMax>10.;
  let reliability=select(1.,.45,isolated);
  let strength=(1.-smoothstep(.5,2.,witnesses*reliability))*mass/(.30+mass)*clamp(excess/max(residual,.01),0.,1.)*
    smoothstep(0.,7.,local);
  let allowed=mix(strength,min(strength,.6/max(abs(residual),1.)),supported);
  output[index]=vec4f(mix(current.rgb,mean,allowed),current.a);
}
`;

