// Native presentation reuses the Web display functions without changing Web code.
import {composeDefine} from '../../src/renderer/wgsl/compose.frag.wgsl.js';
export function nativeDisplayShader(): string {
  return `
struct Params {
  size: vec2u, samples: f32, exposure: f32,
  toneMode: u32, outputKind: u32, flags: u32, originalSamples: f32,
  grading: vec4f
}
@group(0) @binding(0) var<storage, read> accumulation: array<vec4f>;
@group(0) @binding(1) var output: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(2) var<uniform> params: Params;
@group(0) @binding(3) var<storage, read> normals: array<vec4f>;
@group(0) @binding(4) var<storage, read> albedos: array<vec4f>;

var<private> toneMappingParams: vec4f;
var<private> colorGradingParams: vec4f;
${composeDefine}
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id: vec3u) {
  if (any(id.xy >= params.size)) { return; }
  toneMappingParams = vec4f(f32(params.toneMode), 0.0, 0.0, 0.0);
  colorGradingParams = params.grading;
  let index = (params.size.y - 1u - id.y) * params.size.x + id.x;
  let rgba = accumulation[index] / params.samples;
  var alpha = select(1.0, clamp(rgba.a, 0.0, 1.0), (params.flags & 1u) != 0u);
  var linear = rgba.rgb;
  // Raw radiance is accumulated by sample count. Transparent edge colors use
  // the hit count, matching the shared Web normalization before tone mapping.
  let hit = albedos[index].a / params.originalSamples;
  if (alpha < 1.0 && hit > 0.0) { linear /= hit; }
  var color = linearToSrgb(applyToneMapping(gradeColor(max(linear * params.exposure, vec3f(0.0)))));
  if (params.outputKind == 1u) {
    let normal = normals[index];
    alpha = select(0.0, 1.0, dot(normal.rgb, normal.rgb) > 0.1);
    color = select(vec3f(0.0), normal.rgb / params.originalSamples * 0.5 + 0.5, alpha > 0.0);
  } else if (params.outputKind == 2u) {
    let albedo = albedos[index] / params.originalSamples;
    color = albedo.rgb;
    alpha = clamp(albedo.a, 0.0, 1.0);
  }
  if ((params.flags & 2u) != 0u) { color *= alpha; }
  textureStore(output, id.xy, vec4f(color, alpha));
}`;
}

// Share the browser's layer composition and sRGB display transfer.
import {createComposeMain, createCompositeDenoiseColorMain, createCompositeDenoiseAlbedoMain} from '../../src/renderer/wgsl/compose.frag.wgsl.js';
export function nativeDisplayEffectsShader(hdr = false, output: 'display' | 'linear' | 'albedo' = 'display'): string {
  const main = createComposeMain('srgb');
  return `
struct Params {
  size: vec2u, samples: f32, exposure: f32,
  toneMode: u32, outputKind: u32, flags: u32, originalSamples: f32,
  grading: vec4f, effects: vec4f, catcher: vec4f, background: vec4f, scene: vec4u
}
struct ShadowCatcherAccumulation { mask: vec4f, background: vec4f, moments: vec4f }
@group(0) @binding(0) var<storage, read> filtered: array<vec4f>;
@group(0) @binding(1) var<storage, read> original: array<vec4f>;
@group(0) @binding(2) var<storage, read> normals: array<vec4f>;
@group(0) @binding(3) var<storage, read> albedos: array<vec4f>;
@group(0) @binding(4) var<storage, read> shadows: array<ShadowCatcherAccumulation>;
@group(0) @binding(5) var bloom: texture_2d<f32>;
@group(0) @binding(6) var<uniform> params: Params;
@group(0) @binding(7) var outputImage: texture_storage_2d<${output !== 'display' ? 'rgba32float' : hdr ? 'rgba16float' : 'rgba8unorm'}, write>;
@group(0) @binding(8) var normalizedImage: texture_storage_2d<rgba32float, write>;
var<private> toneMappingParams: vec4f;
var<private> colorGradingParams: vec4f;
${composeDefine}
fn indexOf(uv: vec2i) -> u32 { return (params.size.y - 1u - u32(uv.y)) * params.size.x + u32(uv.x); }
fn colorTexRegion() -> vec2u { return params.size; }
fn load_colorTex(uv: vec2i, level: i32) -> vec4f {
  let i = indexOf(uv);
  var rgba = filtered[i] / params.samples;
  let coverage = albedos[i].a / params.originalSamples;
  if (coverage > 0.0) { rgba = vec4f(rgba.rgb / coverage, rgba.a); }
  return rgba;
}
fn rawColor(uv: vec2i) -> vec3f {
  let i = indexOf(uv);
  let hit = albedos[i].a;
  return original[i].rgb / select(params.originalSamples, hit, hit > 0.0);
}
fn load_flatBackgroundMaskTex(uv: vec2i, level: i32) -> vec4f { return albedos[indexOf(uv)] / params.originalSamples; }
fn load_shadowCatcherTex(uv: vec2i, level: i32) -> vec4f {
  if (params.scene.x == 0u) { return vec4f(0.0); }
  let shadow = shadows[indexOf(uv)];
  let total = params.originalSamples;
  let coverage = shadow.mask.r / total;
  let opacity = select(0.0, shadow.moments.z / max(shadow.moments.w, 0.000001), shadow.moments.w > 0.0);
  return vec4f(shadow.mask.rgb / total, coverage * opacity);
}
fn correctLayer(value: vec4f, uv: vec2i, background: bool) -> vec4f {
  if (params.scene.y == 0u) { return value; }
  let raw = rawColor(uv);
  let color = load_colorTex(uv, 0).rgb;
  if (all(raw == color)) { return value; }
  // Same correction as customDenoiseLayersMain; preserve each layer's coverage.
  let usable = abs(raw) > vec3f(0.000001);
  let scale = select(vec3f(1.0), color / select(vec3f(1.0), raw, usable), usable);
  let residual = select(color - raw, vec3f(0.0), usable);
  return vec4f(value.rgb * scale + residual * select(1.0, value.a, background), value.a);
}
fn load_foregroundTex(uv: vec2i, level: i32) -> vec4f {
  let i = indexOf(uv);
  let shadow = shadows[i];
  let hit = max(albedos[i].a - shadow.mask.b, 0.0);
  return correctLayer(vec4f((original[i].rgb - shadow.background.rgb) / select(params.originalSamples, hit, hit > 0.0),
    clamp((original[i].a - shadow.mask.g) / params.originalSamples, 0.0, 1.0)), uv, false);
}
fn load_catcherBackgroundTex(uv: vec2i, level: i32) -> vec4f {
  return correctLayer(shadows[indexOf(uv)].background / params.originalSamples, uv, true);
}
fn load_bloomTex(uv: vec2i, level: i32) -> vec4f { return textureLoad(bloom, uv, 0); }
struct FSOutput { color: vec4f }
@compute @workgroup_size(8,8)
fn normalize(@builtin(global_invocation_id) id: vec3u) {
  if (any(id.xy >= params.size)) { return; }
  textureStore(normalizedImage, id.xy, load_colorTex(vec2i(id.xy), 0));
}
@compute @workgroup_size(8,8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (any(id.xy >= params.size)) { return; }
  let uv = vec2i(id.xy);
  toneMappingParams = vec4f(f32(params.toneMode), params.effects.x, 0.0, 0.0);
  colorGradingParams = params.grading;
  let bloomIntensity = params.effects.y;
  let exposure = params.exposure;
  let hdrOutputEnabled = ${hdr ? '1.0' : '0.0'};
  let flatBackgroundColor = params.background;
  let shadowCatcherEnabled = f32(params.scene.x);
  let shadowCatcherColor = params.catcher.rgb;
  let shadowCatcherAlpha = params.catcher.a;
  var output: FSOutput;
${main}
  if (params.outputKind == 1u) {
    let n = normals[indexOf(uv)];
    let a = select(0.0, 1.0, dot(n.rgb, n.rgb) > 0.1);
    output.color = vec4f(select(vec3f(0.0), n.rgb / params.originalSamples * 0.5 + 0.5, a > 0.0), a);
  } else if (params.outputKind == 2u) {
    let a = load_flatBackgroundMaskTex(uv, 0);
    output.color = vec4f(a.rgb, clamp(a.a, 0.0, 1.0));
  } else if (params.outputKind == 4u) { output.color = load_shadowCatcherTex(uv, 0); }
${output === 'albedo' ? createCompositeDenoiseAlbedoMain('output.color') : ''}
${(hdr && output === 'display') || output === 'linear' ? `if (params.outputKind == 0u || params.outputKind == 3u) {
${createCompositeDenoiseColorMain('output.color', 'output.color', 'srgb')} }` : ''}
  if ((params.flags & 1u) == 0u) { output.color.a = 1.0; }
  if ((params.flags & 2u) != 0u) { output.color = vec4f(output.color.rgb * output.color.a, output.color.a); }
  textureStore(outputImage, id.xy, output.color);
}`;
}
