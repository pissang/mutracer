// Independent of beauty composition and denoising; shared by WebGPU and native.
export function aovDisplayShader(format: 'rgba16float' | 'rgba8unorm', primary = false) {
  return /* wgsl */ `
struct DisplayAovAccum { geometry: vec4f, position: vec4f, diffuse: vec4f, specular: vec4f, }
struct DisplayAovCenter { identity: vec4u, motion: vec4f, }
struct DisplayAovParams { sizeKind: vec4u, mapping: vec4f, flags: vec4u, }
@group(0) @binding(0) var<storage, read> accumulation: array<DisplayAovAccum>;
@group(0) @binding(1) var<storage, read> center: array<DisplayAovCenter>;
@group(0) @binding(2) var image: texture_storage_2d<${format}, write>;
@group(0) @binding(3) var<uniform> params: DisplayAovParams;

fn displayAovHash(input: u32) -> u32 {
  var v = input;
  v = (v ^ (v >> 16u)) * 0x7feb352du;
  v = (v ^ (v >> 15u)) * 0x846ca68bu;
  return v ^ (v >> 16u);
}
fn displayAovSrgb(rgb: vec3f) -> vec3f {
  return select(1.055 * pow(max(rgb, vec3f(0.0)), vec3f(1.0 / 2.4)) - 0.055,
    12.92 * rgb, rgb <= vec3f(0.0031308));
}
fn displayAovLinear(rgb: vec3f) -> vec3f {
  return select(pow((rgb + 0.055) / 1.055, vec3f(2.4)), rgb / 12.92,
    rgb <= vec3f(0.04045));
}
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = params.sizeKind.xy;
  if (any(id.xy >= size)) { return; }
  let index = id.x + (size.y - 1u - id.y) * size.x;
  let kind = params.sizeKind.w;
  let pixel = accumulation[index];
  let hit = pixel.position.w;
  var color = vec3f(0.0);
  var alpha = hit / f32(max(params.sizeKind.z, 1u));
  let inv = 1.0 / max(hit, 1.0);
  if (kind == 0u) {
    color = vec3f(clamp((pixel.geometry.x * inv - params.mapping.x) /
      (params.mapping.y - params.mapping.x), 0.0, 1.0));
  } else if (kind == 1u) {
    color = clamp(pixel.position.xyz * inv / params.mapping.z * 0.5 + 0.5,
      vec3f(0.0), vec3f(1.0));
  } else if (kind == 2u) {
    color = clamp(pixel.geometry.yzw * inv, vec3f(0.0), vec3f(1.0));
  } else if (kind == 3u || kind == 4u) {
    let r = select(pixel.diffuse, pixel.specular, kind == 4u);
    alpha = r.w / f32(max(params.sizeKind.z, 1u));
    color = displayAovSrgb(clamp(r.xyz / max(r.w, 1.0), vec3f(0.0), vec3f(1.0)));
  } else if (kind == 5u) {
    let identity = center[index].identity;
    alpha = select(1.0, 0.0, identity.x == 0xffffffffu);
    let hash = displayAovHash(identity[params.flags.x]);
    color = 0.2 + 0.8 * vec3f(f32(hash & 255u), f32((hash >> 8u) & 255u),
      f32((hash >> 16u) & 255u)) / 255.0;
  }${primary ? /* wgsl */ ` else if (kind >= 9u) {
    let primary = center[index + size.x * size.y];
    let normalDepth = bitcast<vec4f>(primary.identity);
    alpha = primary.motion.w;
    if (kind == 9u) { color = clamp(normalDepth.xyz * 0.5 + 0.5, vec3f(0.0), vec3f(1.0)); }
    else if (kind == 10u) { color = vec3f(clamp((normalDepth.w - params.mapping.x) / (params.mapping.y - params.mapping.x), 0.0, 1.0)); }
    else { color = clamp(primary.motion.xyz / params.mapping.z * 0.5 + 0.5, vec3f(0.0), vec3f(1.0)); }
  }` : ''} else {
    let m = center[index].motion;
    alpha = select(0.0, 1.0, m.w == 3.0);
    let magnitude = length(m.xy);
    var hue = 0.0;
    if (magnitude > 0.0) { hue = fract(atan2(m.y, m.x) / 6.28318530718 + 1.0); }
    let p = abs(fract(vec3f(hue) + vec3f(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
    color = clamp(p - 1.0, vec3f(0.0), vec3f(1.0)) * clamp(magnitude / params.mapping.w, 0.0, 1.0);
  }
  if (alpha <= 0.0) { color = vec3f(0.0); }
  if (params.flags.y != 0u) { color = displayAovLinear(color); }
  textureStore(image, vec2i(id.xy), vec4f(color, clamp(alpha, 0.0, 1.0)));
}
`;
}
