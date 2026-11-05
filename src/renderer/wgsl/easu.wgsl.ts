// Adapted from AMD FidelityFX FSR 1, ffx_fsr1.h v1.20210629,
// FsrEasuSetF/FsrEasuTapF/FsrEasuF (32-bit path). MIT; see LICENSES/FidelityFX-FSR.txt.
// https://github.com/GPUOpen-Effects/FidelityFX-FSR/blob/master/ffx-fsr/ffx_fsr1.h
// Uses exact reciprocals instead of the reference's low precision approximations.
export const easuShader = /* wgsl */ `
@group(0) @binding(0) var colorImage: texture_2d<f32>;
@group(0) @binding(1) var<uniform> outputSize: vec4f;
@vertex fn vertex(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((index << 1u) & 2u), f32(index & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}
const offsets = array<vec2i,12>(vec2i(0,-1),vec2i(1,-1),vec2i(-1,0),vec2i(0,0),vec2i(1,0),vec2i(2,0),
  vec2i(-1,1),vec2i(0,1),vec2i(1,1),vec2i(2,1),vec2i(0,2),vec2i(1,2));
fn loadColor(p: vec2i) -> vec4f {return textureLoad(colorImage, clamp(p,vec2i(0),vec2i(textureDimensions(colorImage))-1),0);}
fn gradient(a: f32,b: f32,c: f32,d: f32,e: f32,w: f32) -> vec3f {
  let direction = vec2f(d-b,e-a);
  let length = clamp(abs(direction)/max(vec2f(max(abs(d-c),abs(c-b)),max(abs(e-c),abs(c-a))),vec2f(1e-8)),vec2f(0),vec2f(1));
  return vec3f(direction,dot(length,length))*w;
}
fn easuWeight(offset: vec2f, direction: vec2f, length: vec2f, lobe: f32) -> f32 {
  let v = vec2f(dot(offset,direction),dot(offset,vec2f(-direction.y,direction.x)))*length;
  let distance = min(dot(v,v),1.0/lobe);
  let b = 0.4*distance-1.0;
  let a = lobe*distance-1.0;
  return (1.5625*b*b-0.5625)*a*a;
}
@fragment fn fragment(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let point = position.xy*vec2f(textureDimensions(colorImage))/outputSize.xy-0.5;
  let base = vec2i(floor(point)); let phase = fract(point);
  var colors: array<vec4f,12>;
  var luma: array<f32,12>;
  // FSR expects [0,1]. Normalize the neighborhood for direction estimation
  // in extended-range output; filter the original RGB without clipping it to 1.
  var range = 1.0;
  for(var i=0u;i<12u;i++){colors[i]=loadColor(base+offsets[i]);range=max(range,max(max(colors[i].r,colors[i].g),colors[i].b));}
  for(var i=0u;i<12u;i++){luma[i]=dot(colors[i].rgb/range,vec3f(0.5,1.0,0.5));}
  let g = gradient(luma[0],luma[2],luma[3],luma[4],luma[7],(1.0-phase.x)*(1.0-phase.y))+
    gradient(luma[1],luma[3],luma[4],luma[5],luma[8],phase.x*(1.0-phase.y))+
    gradient(luma[3],luma[6],luma[7],luma[8],luma[10],(1.0-phase.x)*phase.y)+
    gradient(luma[4],luma[7],luma[8],luma[9],luma[11],phase.x*phase.y);
  var direction = vec2f(1.0,0.0);
  if(dot(g.xy,g.xy)>=1.0/32768.0){direction=normalize(g.xy);}
  let edge = (g.z*0.5)*(g.z*0.5);
  let stretch = dot(direction,direction)/max(abs(direction.x),abs(direction.y));
  let length = vec2f(1.0+(stretch-1.0)*edge,1.0-0.5*edge);
  let lobe = 0.5+(0.21-0.5)*edge;
  var result=vec4f(0); var total=0.0;
  for(var i=0u;i<12u;i++){
    let weight=easuWeight(vec2f(offsets[i])-phase,direction,length,lobe);
    result+=colors[i]*weight;total+=weight;
  }
  let lower=min(min(colors[3],colors[4]),min(colors[7],colors[8]));
  let upper=max(max(colors[3],colors[4]),max(colors[7],colors[8]));
  return clamp(result/total,lower,upper);
}
`;

// Not part of FSR: exact area average for inputs larger than the output,
// alpha-weighted so transparent texels do not darken coverage edges.
export const areaDownsampleShader = /* wgsl */ `
@group(0) @binding(0) var colorImage: texture_2d<f32>;
@group(0) @binding(1) var<uniform> outputSize: vec4f;
@vertex fn vertex(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((index << 1u) & 2u), f32(index & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}
@fragment fn fragment(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let scale = vec2f(textureDimensions(colorImage))/outputSize.xy;
  let start = floor(position.xy)*scale; let end = start+scale;
  var sum = vec4f(0);
  for (var y = i32(floor(start.y)); y < i32(ceil(end.y)); y++) {
    for (var x = i32(floor(start.x)); x < i32(ceil(end.x)); x++) {
      let overlap = max(vec2f(0), min(vec2f(vec2i(x+1,y+1)), end)-max(vec2f(vec2i(x,y)), start));
      let color = textureLoad(colorImage, vec2i(x,y), 0);
      sum += vec4f(color.rgb*color.a, color.a)*overlap.x*overlap.y;
    }
  }
  return vec4f(sum.rgb/max(sum.a, 1e-8), sum.a/(scale.x*scale.y));
}
`;
