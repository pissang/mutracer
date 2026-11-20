// Sparse patch estimates at three scales, interpolated onto the display grid.
const params = /* wgsl */ `
struct Params { size: vec2u, a: u32, b: u32, delta: i32, stage: u32, axis: u32, pad: u32 }
@group(0) @binding(0) var<uniform> p: Params;
fn sq(x: f32) -> f32 { return x*x; }
fn bounded(x: vec2f) -> bool { return all(x >= vec2f(0)) && all(x <= vec2f(p.size-1u)); }
`;

export const pyramid = params + /* wgsl */ `
@group(0) @binding(1) var source: texture_2d_array<f32>;
@group(0) @binding(2) var reduced: texture_storage_2d_array<rgba16float,write>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) g: vec3u) {
  if (any(g.xy >= textureDimensions(reduced))) { return; }
  let x = vec2i(g.xy) * 2;
  let end = vec2i(textureDimensions(source))-1;
  var value = 0.0;
  for (var y=0; y<2; y++) {
    for (var k=0; k<2; k++) {
      let s = textureLoad(source,min(x+vec2i(k,y),end),i32(p.a),0).rgb;
      value += dot(s,vec3f(0.299,0.587,0.114));
    }
  }
  textureStore(reduced,vec2i(g.xy),i32(p.a),vec4f(vec3f(value*0.25),1));
}
`;

const grid = /* wgsl */ `
fn gridSize(size: vec2u) -> vec2u { return (size+2u)/3u; }
fn gridCoord(x: vec2f) -> vec2f { return (x-1.0)/3.0; }
`;
function interpolator(name: string, buffer: string) {
  return /* wgsl */ `
fn ${name}(x: vec2f, size: vec2u) -> vec2f {
  let uv = clamp(gridCoord(x),vec2f(0),vec2f(size-1u));
  let i = vec2u(floor(uv)); let j = min(i+1u,size-1u); let f = fract(uv);
  return mix(mix(${buffer}[i.y*size.x+i.x],${buffer}[i.y*size.x+j.x],f.x),
             mix(${buffer}[j.y*size.x+i.x],${buffer}[j.y*size.x+j.x],f.x),f.y);
}
`;
}

export const match = params + grid + /* wgsl */ `
@group(0) @binding(1) var image: texture_2d_array<f32>;
@group(0) @binding(2) var<storage, read> coarse: array<vec2f>;
@group(0) @binding(3) var<storage, read> geometry: array<vec4f>;
@group(0) @binding(4) var<storage, read_write> flow: array<vec2f>;
` + interpolator('sampleCoarse', 'coarse') + /* wgsl */ `
fn pixel(x: vec2i, frame: u32) -> f32 {
  return textureLoad(image,clamp(x,vec2i(0),vec2i(textureDimensions(image))-1),i32(frame),0).r;
}
fn sample(x: vec2f, frame: u32) -> f32 {
  let i=vec2i(floor(x)); let f=fract(x);
  return mix(mix(pixel(i,frame),pixel(i+vec2i(1,0),frame),f.x),
             mix(pixel(i+vec2i(0,1),frame),pixel(i+vec2i(1,1),frame),f.x),f.y);
}
fn patchError(center: vec2f, motion: vec2f) -> f32 {
  var sum=0.0; var sumSq=0.0;
  for (var y=-3; y<=4; y++) {
    for (var x=-3; x<=4; x++) {
      let at=center+vec2f(f32(x),f32(y));
      let diff=sample(at+motion,p.b)-sample(at,p.a);
      sum+=diff; sumSq+=diff*diff;
    }
  }
  return (sumSq-0.98*sum*sum/64.0)/64.0;
}
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) g: vec3u) {
  let size=textureDimensions(image); let n=gridSize(size);
  if (any(g.xy>=n)) { return; }
  let center=min(vec2f(g.xy)*3.0+1.0,vec2f(size-1u));
  let scale=f32(p.axis);
  let full=clamp((center+0.5)*scale-0.5,vec2f(0),vec2f(p.size-1u));
  let at=vec2u(round(full));
  let geo=geometry[at.y*p.size.x+at.x];
  var motion=vec2f(0);
  if (p.axis<8u) {
    motion=2.0*sampleCoarse((center+0.5)*0.5-0.5,gridSize((size+1u)/2u));
  }
  var best=patchError(center,motion);
  if (p.stage==5u) {
    motion=coarse[g.y*n.x+g.x];
    best=patchError(center,motion);
    let own=motion;
    var average=own;
    var count=1.0;
    for (var y=-1; y<=1; y++) {
      for (var x=-1; x<=1; x++) {
        if (x==0 && y==0) {continue;}
        let near=vec2u(clamp(vec2i(g.xy)+vec2i(x,y),vec2i(0),vec2i(n)-1));
        let candidate=coarse[near.y*n.x+near.x];
        let separation=dot(candidate-own,candidate-own);
        let cost=patchError(center,candidate)+0.015*separation;
        if (cost<best) { motion=candidate; best=cost; }
        let weight=exp(-separation/0.6);
        average+=candidate*weight; count+=weight;
      }
    }
    average/=count;
    if (patchError(center,average)<=best+0.25) { motion=average; }
  }
  if (p.stage!=5u && geo.w>=2.0) {
    let candidate=(geo.xy-vec2f(at))/scale;
    let error=patchError(center,candidate);
    if (error<best) { motion=candidate; best=error; }
  }
  // Search around the winning predictor, then refine the local estimate.
  let seed=motion;
  let step=select(1.0,2.0,p.axis==8u);
  for (var y=-1; y<=1 && p.stage!=5u; y++) {
    for (var x=-1; x<=1; x++) {
      let offset=vec2f(f32(x),f32(y))*step;
      let error=patchError(center,seed+offset)+0.02*dot(offset,offset);
      if (error<best) { motion=seed+offset; best=error; }
    }
  }
  let base=motion;
  for (var iteration=0u; iteration<select(6u,2u,p.stage==5u); iteration++) {
    var gx=0.0; var gy=0.0; var dd=0.0;
    var xx=0.0; var xy=0.0; var yy=0.0; var xd=0.0; var yd=0.0;
    for (var y=-3; y<=4; y++) {
      for (var x=-3; x<=4; x++) {
        let at=center+vec2f(f32(x),f32(y));
        let q=at+motion;
        let diff=sample(q,p.b)-sample(at,p.a);
        let dx=0.5*(sample(q+vec2f(1,0),p.b)-sample(q-vec2f(1,0),p.b));
        let dy=0.5*(sample(q+vec2f(0,1),p.b)-sample(q-vec2f(0,1),p.b));
        gx+=dx; gy+=dy; dd+=diff;
        xx+=dx*dx; xy+=dx*dy; yy+=dy*dy; xd+=dx*diff; yd+=dy*diff;
      }
    }
    xx+=3.0-gx*gx/64.0; xy-=gx*gy/64.0; yy+=3.0-gy*gy/64.0;
    xd-=gx*dd/64.0; yd-=gy*dd/64.0;
    let update=vec2f(yy*xd-xy*yd,xx*yd-xy*xd)/max(xx*yy-xy*xy,1e-5);
    let bound=select(2.0,0.35,p.stage==5u);
    motion=base+clamp(motion-base-clamp(update,vec2f(-1),vec2f(1)),vec2f(-bound),vec2f(bound));
  }
  flow[g.y*n.x+g.x]=motion;
}
`;

export const combine = params + grid + /* wgsl */ `
@group(0) @binding(1) var images: texture_2d_array<f32>;
@group(0) @binding(2) var blurred: texture_2d_array<f32>;
@group(0) @binding(3) var<storage, read> geometry: array<vec4f>;
@group(0) @binding(4) var<storage, read> forward: array<vec2f>;
@group(0) @binding(5) var<storage, read> backward: array<vec2f>;
@group(0) @binding(6) var<storage, read_write> total: array<vec4f>;
@group(0) @binding(7) var<storage, read_write> paths: array<u32>;
@group(0) @binding(8) var<storage, read> reverseGeometry: array<vec4f>;
` + interpolator('sampleForward', 'forward') + interpolator('sampleBackward', 'backward') + /* wgsl */ `
fn sample(image: texture_2d_array<f32>, x: vec2f, frame: u32) -> vec3f {
  let uv=clamp(x,vec2f(0),vec2f(p.size-1u));
  let i=vec2i(floor(uv)); let j=min(i+1,vec2i(p.size)-1); let f=fract(uv);
  let a=textureLoad(image,i,i32(frame),0).rgb;
  let b=textureLoad(image,vec2i(j.x,i.y),i32(frame),0).rgb;
  let c=textureLoad(image,vec2i(i.x,j.y),i32(frame),0).rgb;
  let d=textureLoad(image,j,i32(frame),0).rgb;
  return mix(mix(a,b,f.x),mix(c,d,f.x),f.y);
}
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) g: vec3u) {
  if (any(g.xy>=p.size)) { return; }
  let i=g.y*p.size.x+g.x;
  let x=vec2f(g.xy); let n=gridSize((p.size+1u)/2u);
  let flow=sampleForward((x+0.5)*0.5-0.5,n)*2.0;
  let imageMatch=x+flow;
  let geo=geometry[i];
  let center=textureLoad(blurred,vec2i(g.xy),i32(p.a),0).rgb;
  let imageDiff=abs(sample(blurred,imageMatch,p.b)-center);
  let geoDiff=abs(sample(blurred,geo.xy,p.b)-center);
  let distance=length(geo.xy-imageMatch);
  let useGeometry=geo.z>0.0 && (distance<=0.5 ||
    (distance<=1.5 && dot(geoDiff-imageDiff,vec3f(1.0/3.0))<=0.5));
  let y=select(imageMatch,geo.xy,useGeometry);
  var reverse=sampleBackward((y+0.5)*0.5-0.5,n)*2.0;
  if (useGeometry) {
    let at=vec2u(round(y));
    let reverseGeo=reverseGeometry[at.y*p.size.x+at.x];
    if (reverseGeo.z>0.0 && length(reverseGeo.xy-x)<=1.0) {
      reverse=reverseGeo.xy-vec2f(at);
    }
  }
  let consistency=exp(-sq(length(y-x+reverse)/2.2));
  let difference=select(imageDiff,geoDiff,useGeometry);
  let weight=exp(-sq(f32(p.delta)/2.25)-sq(dot(difference,vec3f(1.0/24.0))))*consistency;
  total[i]+=vec4f(sample(images,y,p.b)*weight,weight);
  paths[i]=select(select(2u,1u,useGeometry),0u,weight<0.001);
}
`;
