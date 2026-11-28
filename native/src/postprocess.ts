import {BLOOM_LEVELS, BLOOM_PLAN, bloomBlurSize, bloomBlendWeight, bloomBrightDefine, bloomBrightMain, bloomDownDefine, bloomDownMain,
  bloomBlurDefine, bloomBlurMain, bloomBlendMain} from '../../src/renderer/wgsl/bloom.wgsl.js';
import {oidnHighlightWGSL} from '../../src/renderer/wgsl/oidnHighlight.wgsl.js';
import {oidnAuxiliaryDefine} from '../../src/renderer/wgsl/oidnAuxiliary.wgsl.js';

// Only compute entry points and texture access differ from WGPUFullQuadPass.
export function nativeBloomShader(): string {
  const sample = (name: string, texture: string) => `
fn ${name}(uv: vec2f) -> vec4f {
  let p = uv * vec2f(textureDimensions(${texture})) - 0.5;
  let i = vec2i(floor(p)); let w = fract(p);
  let size = vec2i(textureDimensions(${texture})) - 1;
  let a = textureLoad(${texture}, clamp(i, vec2i(0), size), 0);
  let b = textureLoad(${texture}, clamp(i + vec2i(1,0), vec2i(0), size), 0);
  let c = textureLoad(${texture}, clamp(i + vec2i(0,1), vec2i(0), size), 0);
  let d = textureLoad(${texture}, clamp(i + vec2i(1,1), vec2i(0), size), 0);
  return mix(mix(a,b,w.x),mix(c,d,w.x),w.y);
}`;
  const entry = (name: string, body: string) => `
@compute @workgroup_size(8,8)
fn ${name}(@builtin(global_invocation_id) id: vec3u) {
  if (any(id.xy >= textureDimensions(outputImage))) { return; }
  let uv = vec2i(id.xy);
  let uv2 = (vec2f(id.xy) + 0.5) / vec2f(textureDimensions(outputImage));
${name === 'bright' ? '  let threshold = params.values.x;\n  let scale = 1.0;' : ''}
${name === 'blur' ? '  let size = params.values.y;\n  let direction = params.direction.xy;' : ''}
${name === 'blend' ? '  let weight = params.values.z;' : ''}
  var output: FSOutput;
${body}
  textureStore(outputImage, id.xy, output.color);
}`;
  return `// Generated from the shared Web bloom pass bodies.
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var second: texture_2d<f32>;
@group(0) @binding(2) var outputImage: texture_storage_2d<rgba16float, write>;
struct Params { values: vec4f, direction: vec4f }
@group(0) @binding(3) var<uniform> params: Params;
struct FSOutput { color: vec4f }
fn colorTexRegion() -> vec2u { return textureDimensions(source); }
fn load_colorTex(pixel: vec2i, level: i32) -> vec4f {
  return textureLoad(source, clamp(pixel, vec2i(0), vec2i(textureDimensions(source))-1), 0);
}
${sample('sample_colorTex_linearSampler', 'source')}
${sample('sample_colorTex1_linearSampler', 'source')}
${sample('sample_colorTex2_linearSampler', 'second')}
${bloomBrightDefine}
${bloomDownDefine}
${bloomBlurDefine}
${entry('bright', bloomBrightMain)}
${entry('down', bloomDownMain)}
${entry('blur', bloomBlurMain)}
${entry('blend', bloomBlendMain)}
`;
}

export function nativeOidnAuxiliaryShader(): string {
  return `// Shared OIDN guide math; native adapts signed normals and buffers.
struct Params { size: vec2u, samples: u32, flat: u32 }
@group(0) @binding(0) var<storage, read> albedo: array<vec4f>;
@group(0) @binding(1) var<storage, read> normal: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> encodedAlbedo: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> encodedNormal: array<vec4f>;
@group(0) @binding(4) var<storage, read> filteredAlbedo: array<vec4f>;
@group(0) @binding(5) var<storage, read> filteredNormal: array<vec4f>;
@group(0) @binding(6) var<storage, read_write> cleanAlbedo: array<vec4f>;
@group(0) @binding(7) var<storage, read_write> cleanNormal: array<vec4f>;
@group(0) @binding(8) var<uniform> params: Params;
${oidnAuxiliaryDefine}
@compute @workgroup_size(8,8)
fn encode(@builtin(global_invocation_id) id: vec3u) {
  if (any(id.xy >= params.size)) { return; }
  let i = id.y * params.size.x + id.x;
  encodedAlbedo[i] = vec4f(oidnEncodeAlbedo(albedo[i].rgb), albedo[i].a);
  encodedNormal[i] = vec4f(oidnSanitizeNormal(normal[i].rgb * 0.5 + 0.5), 1.0);
}
@compute @workgroup_size(8,8)
fn decode(@builtin(global_invocation_id) id: vec3u) {
  if (any(id.xy >= params.size)) { return; }
  let i = id.y * params.size.x + id.x;
  cleanAlbedo[i] = vec4f(oidnDecodeAlbedo(filteredAlbedo[i].rgb), 1.0);
  cleanNormal[i] = vec4f(oidnSanitizeNormal(filteredNormal[i].rgb) * 2.0 - 1.0, 1.0);
}
`;
}

import {nativeDisplayEffectsShader} from './display-shader.js';
import {composeDefine, createCompositeDenoiseDisplayMain, hdrResolveWGSL} from '../../src/renderer/wgsl/compose.frag.wgsl.js';
const nativeOidnNormalizeShader = `// Generated native bindings around the shared HDR resolve equations.
${hdrResolveWGSL}
${oidnHighlightWGSL}
struct Params { size: vec2u, samples: u32, flat: u32 }
@group(0) @binding(0) var<storage, read> color: array<vec4f>;
@group(0) @binding(1) var<storage, read> albedo: array<vec4f>;
@group(0) @binding(2) var<storage, read> normal: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> resolved: array<vec4f>;
@group(0) @binding(4) var<storage, read_write> preview: array<vec4f>;
@group(0) @binding(5) var<storage, read_write> guide: array<vec4f>;
@group(0) @binding(6) var<uniform> params: Params;

fn resolveColor(i: u32, samples: f32) -> vec4f {
    let col = color[i] / samples;
    let nor = normal[i] / samples;
    let alb = albedo[i] / samples;
    if (nor.a <= 0.0) { return vec4f(0.0); }
    let total = max(nor.a, 1.0 / samples);
    let minimum = 1.0 / samples;
    let coverage = clamp(alb.a / total, 0.0, 1.0);
    let flat = (params.flat & 1u) != 0u;
    return vec4f(
      hdr_flat_component(hdr_resolve_component(col.r,nor.a,alb.a,minimum,true), coverage, flat, true),
      hdr_flat_component(hdr_resolve_component(col.g,nor.a,alb.a,minimum,true), coverage, flat, true),
      hdr_flat_component(hdr_resolve_component(col.b,nor.a,alb.a,minimum,true), coverage, flat, true),
      hdr_resolve_component(col.a,nor.a,alb.a,minimum,false));
}

@compute @workgroup_size(8, 8)
fn normalize(@builtin(global_invocation_id) id: vec3u) {
    if (any(id.xy >= params.size)) { return; }
    let i = id.y * params.size.x + id.x;
    let samples = f32(params.samples);
    var result = resolveColor(i, samples);
    if ((params.flat & 2u) != 0u && oidnRadiancePeak(result.rgb) > 8.0) {
        var peak = 0.0;
        for (var y = -1; y <= 1; y++) {
            for (var x = -1; x <= 1; x++) {
                let at = vec2i(id.xy) + vec2i(x, y);
                if ((x == 0 && y == 0) || any(at < vec2i(0)) || any(at >= vec2i(params.size))) { continue; }
                let index = u32(at.y) * params.size.x + u32(at.x);
                peak = max(peak, oidnRadiancePeak(resolveColor(index, samples).rgb));
            }
        }
        result = vec4f(oidnHighlightLimit(result.rgb, peak), result.a);
    }
    resolved[i] = result;
    preview[i] = albedo[i] / samples;
    guide[i] = normal[i] / samples;
}

// Separate entry point: the planner's output is resolved HDR. Undo only its
// coverage resolve for the existing display composition, leaving readback intact.
@group(0) @binding(3) var<storage, read> filtered: array<vec4f>;
@group(0) @binding(4) var<storage, read_write> displayColor: array<vec4f>;
@group(0) @binding(5) var<uniform> displayParams: Params;
@compute @workgroup_size(8, 8)
fn restore(@builtin(global_invocation_id) id: vec3u) {
    if (any(id.xy >= displayParams.size)) { return; }
    let i = id.y * displayParams.size.x + id.x;
    let samples = f32(displayParams.samples);
    let total = max(normal[i].a / samples, 1.0 / samples);
    let hit = albedo[i].a / samples;
    let divisor = select(total, hit, hit > 0.0 && (displayParams.flat & 1u) == 0u);
    displayColor[i] = vec4f(filtered[i].rgb * divisor, filtered[i].a);
}
`;

// Composed inputs are top-row first; raw normal accumulation is bottom-row first.
const nativeOidnDisplayShader = `
struct Params { size: vec2u, samples: f32, flags: u32 }
@group(0) @binding(0) var colorImage: texture_2d<f32>;
@group(0) @binding(1) var albedoImage: texture_2d<f32>;
@group(0) @binding(2) var<storage, read> accumulatedNormal: array<vec4f>;
@group(0) @binding(3) var<uniform> prepareParams: Params;
@group(0) @binding(4) var<storage, read_write> color: array<vec4f>;
@group(0) @binding(5) var<storage, read_write> albedo: array<vec4f>;
@group(0) @binding(6) var<storage, read_write> normal: array<vec4f>;
@compute @workgroup_size(8,8)
fn prepare(@builtin(global_invocation_id) id: vec3u) {
  if (any(id.xy >= prepareParams.size)) { return; }
  let i = id.y * prepareParams.size.x + id.x;
  let raw = (prepareParams.size.y - 1u - id.y) * prepareParams.size.x + id.x;
  color[i] = textureLoad(colorImage, id.xy, 0);
  albedo[i] = textureLoad(albedoImage, id.xy, 0);
  let n = accumulatedNormal[raw];
  normal[i] = n / prepareParams.samples;
  if (prepareParams.flags != 0u) {
    // The Web temporal composition publishes both guides through RGBA8Unorm targets.
    var encoded = vec3f(0.0);
    if (dot(n.rgb, n.rgb) > 0.1) { encoded = n.rgb / prepareParams.samples * 0.5 + 0.5; }
    normal[i] = vec4f(unpack4x8unorm(pack4x8unorm(vec4f(encoded, 1.0))).rgb * 2.0 - 1.0, 1.0);
    albedo[i] = unpack4x8unorm(pack4x8unorm(albedo[i]));
  }
}
@compute @workgroup_size(8,8)
fn collect(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(colorImage);
  if (any(id.xy >= size)) { return; }
  color[id.y * size.x + id.x] = textureLoad(colorImage, id.xy, 0);
}
@group(0) @binding(0) var<storage, read> filtered: array<vec4f>;
@group(0) @binding(1) var outputImage: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(2) var<uniform> params: Params;
var<private> toneMappingParams: vec4f;
var<private> colorGradingParams: vec4f;
${composeDefine}
fn load_colorTex(uv: vec2i, level: i32) -> vec4f { return filtered[u32(uv.y) * params.size.x + u32(uv.x)]; }
fn load_composedTex(uv: vec2i, level: i32) -> vec4f { return load_colorTex(uv, level); }
struct FSOutput { color: vec4f }
@compute @workgroup_size(8,8)
fn present(@builtin(global_invocation_id) id: vec3u) {
  if (any(id.xy >= params.size)) { return; }
  let uv = vec2i(id.xy);
  let denoisedAlpha = 0.0;
  let hdrOutputEnabled = 0.0;
  var output: FSOutput;
${createCompositeDenoiseDisplayMain('srgb')}
  if ((params.flags & 1u) == 0u) { output.color.a = 1.0; }
  if ((params.flags & 2u) != 0u) { output.color = vec4f(output.color.rgb * output.color.a, output.color.a); }
  textureStore(outputImage, id.xy, output.color);
}
`;

import frameResolve from './frame-resolve.wgsl.js';
import {areaDownsampleShader, easuShader} from '../../src/renderer/wgsl/easu.wgsl.js';
import {albedoDownsampleShader, easuDetailShader, guidedCoefficientShader, toneLutShader, EASU_DETAIL, TONE_LUT_SIZE} from '../../src/renderer/wgsl/easuDetail.wgsl.js';
import {specializeMotionIndices} from './shader-variants.js';
import aovTraceWGSL from '../../src/renderer/wgsl/aovTrace.wgsl.js';
import aovTraceDisplayWGSL from '../../src/renderer/wgsl/aovTraceDisplay.wgsl.js';

import {captureWGSL} from '../../src/renderer/temporalCaptureShader.js';
import {createMixedWindowWGSL, mixedWindowWGSL} from '../../src/renderer/temporalWindowShader.js';
import {createCaptureReflectionsWGSL} from '../../src/renderer/temporalReflectionShader.js';
import {createVetoShader, vetoShader} from '../../src/renderer/temporalSparkleShader.js';
import {composePackWGSL, createComposePackWGSL, motionCoverageWGSL} from '../../src/renderer/temporalComposeShader.js';
import {idSnapshot, snapshot, reproject, accumulate, blur} from '../../src/renderer/temporalKernels.js';
import {combine, match, pyramid} from '../../src/renderer/temporalFlow.js';
import {supplementBlendWGSL, supplementGatherWGSL, supplementNeedWGSL} from './offline-supplement.js';
// The supplement's past-half estimate may run on every second pixel in each
// direction. Tests and sums are unchanged at the pixels it visits.
function sparseWindow(source: string): string {
  const entry = 'if(any(g.xy>=p.size)){return;}\n  let x=vec2i(g.xy); let index=g.y*p.size.x+g.x;';
  if (source.split(entry).length !== 2) throw new Error('Window entry changed; update the sparse supplement estimate.');
  return source.replace(entry, 'let gs=g.xy*2u; if(any(gs>=p.size)){return;}\n  let x=vec2i(gs); let index=gs.y*p.size.x+gs.x;');
}
export function postprocessParameters(): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    temporal: {capture:captureWGSL, window:mixedWindowWGSL, sparkle:vetoShader, pack:composePackWGSL, coverage:motionCoverageWGSL,
      captureReflections: createCaptureReflectionsWGSL(true),
      windowReflections: createMixedWindowWGSL(false, true),
      windowTiles: createMixedWindowWGSL(false, false, 4),
      windowReflectionsTiles: createMixedWindowWGSL(false, true, 4),
      windowTiles1: createMixedWindowWGSL(false, false, 1, false, true),
      windowReflectionsTiles1: createMixedWindowWGSL(false, true, 1, false, true),
      supplementNeed: supplementNeedWGSL, supplementGather: supplementGatherWGSL, supplementBlend: supplementBlendWGSL,
      windowSparse: sparseWindow(mixedWindowWGSL), windowReflectionsSparse: sparseWindow(createMixedWindowWGSL(false, true)),
      windowTilesSparse: sparseWindow(createMixedWindowWGSL(false, false, 4)),
      windowReflectionsTilesSparse: sparseWindow(createMixedWindowWGSL(false, true, 4)),
      windowGuidesReflections: createMixedWindowWGSL(true, true),
      windowGuides: createMixedWindowWGSL(true), packGuides: createComposePackWGSL(true),
      windowScan: createMixedWindowWGSL(false, false, undefined, true),
      windowReflectionsScan: createMixedWindowWGSL(false, true, undefined, true),
      windowTilesScan: createMixedWindowWGSL(false, false, 4, true),
      windowReflectionsTilesScan: createMixedWindowWGSL(false, true, 4, true),
      windowGuidesReflectionsScan: createMixedWindowWGSL(true, true, undefined, true),
      windowGuidesScan: createMixedWindowWGSL(true, false, undefined, true),
      sparkleScan: createVetoShader(true),
      idSnapshot: idSnapshot, snapshot: snapshot, reproject: reproject, accumulate: accumulate, blur: blur, combine: combine, match: match, pyramid: pyramid},
    bloom: nativeBloomShader(), auxiliary: nativeOidnAuxiliaryShader(),
    normalize: nativeOidnNormalizeShader, frame_resolve: frameResolve,
    oidn_composition: [nativeDisplayEffectsShader(false, 'linear'), nativeDisplayEffectsShader(false, 'albedo')],
    oidn_display: nativeOidnDisplayShader,
    bloom_levels: BLOOM_LEVELS, bloom_plan: BLOOM_PLAN,
    // The Web EASU pass: color, area downsample, guided detail, albedo guides, tone table, albedo fit.
    easu: [easuShader, areaDownsampleShader, easuDetailShader(), albedoDownsampleShader(), toneLutShader, guidedCoefficientShader],
    easu_detail: [...EASU_DETAIL.ratioRange, EASU_DETAIL.depthThreshold, EASU_DETAIL.coverageThreshold,
      EASU_DETAIL.minimumAlbedo, EASU_DETAIL.depthTolerance, EASU_DETAIL.guidedEpsilon],
    tone_lut_size: TONE_LUT_SIZE,
    // The display AOV trace replaces the default suffix of the path tracer source.
    aov_trace: [aovTraceWGSL, aovTraceDisplayWGSL],
    aov_trace_hwrt: [specializeMotionIndices(aovTraceWGSL), specializeMotionIndices(aovTraceDisplayWGSL)]
  }));
}
export function bloomParameters(radius: number): Uint8Array {
  return new TextEncoder().encode(JSON.stringify([bloomBlurSize(radius), bloomBlendWeight(radius)]));
}
