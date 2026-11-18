import {WGPUComputePass, type Uniform} from './WGPUComputePass.js';
import type {ScratchPool} from './ScratchPool.js';
import {oidnAuxiliaryDefine} from './wgsl/oidnAuxiliary.wgsl.js';

function readImage(buffer: boolean, name: string, xy: string) {
  if (!buffer) return `textureLoad(in_${name}, ${xy}, 0)`;
  return `in_${name}[imageIndex(vec2i(${xy}))]`;
}

const imageIndex = /* wgsl */ `
fn imageIndex(pixel: vec2i) -> u32 { return u32(pixel.y * imageSize.x + pixel.x); }
`;

const oidnAlbedoSrgbEncodeMain = (buffers: boolean) => /* wgsl */ `
if (globalId.x >= u32(imageSize.x) || globalId.y >= u32(imageSize.y)) { return; }
let index = globalId.x + globalId.y * u32(imageSize.x);
let raw = ${readImage(buffers, 'albedo', 'vec2u(globalId.xy)')};
let encoded = oidnEncodeAlbedo(raw.rgb);
out_albedo[index] = vec4f(encoded, raw.a);
`;

const oidnAlbedoSrgbDecodeMain = (buffers: boolean) => /* wgsl */ `
if (globalId.x >= u32(imageSize.x) || globalId.y >= u32(imageSize.y)) { return; }
let index = globalId.x + globalId.y * u32(imageSize.x);
let filtered = in_albedo[index];
let linear = oidnDecodeAlbedo(filtered.rgb);
var result = linear;
let surfaceCoverage = ${readImage(buffers, 'rawAlbedo', 'vec2i(globalId.xy)')}.a;
if (preserveSurfaceTexture != 0u) {
  // Primary albedo retains the accumulated surface texture. Do not ask the
  // auxiliary network to reconstruct its high-frequency texture.
  // Retain its filtered result across normal/coverage discontinuities.
  let pixel = vec2i(globalId.xy);
  let center = ${readImage(buffers, 'rawNormal', 'pixel')};
  let n = normalize(center.rgb * 2.0 - 1.0 + vec3f(1e-8));
  var discontinuity = 0.0;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let neighbor = ${readImage(buffers, 'rawNormal', 'clamp(pixel + vec2i(x, y), vec2i(0), imageSize - 1)')};
      let nn = normalize(neighbor.rgb * 2.0 - 1.0 + vec3f(1e-8));
      discontinuity = max(discontinuity,
        max(1.0 - dot(n, nn), abs(center.a - neighbor.a)));
    }
  }
  let edgeWeight = smoothstep(0.02, 0.1, discontinuity);
  let raw = clamp(${readImage(buffers, 'rawAlbedo', 'pixel')}.rgb,
    vec3f(0.0), vec3f(1.0));
  result = mix(raw, linear, edgeWeight);
}
out_albedo[index] = vec4f(result, surfaceCoverage);
`;

const oidnNormalSanitizeMain = /* wgsl */ `
if (globalId.x >= u32(imageSize.x) || globalId.y >= u32(imageSize.y)) { return; }
let index = globalId.x + globalId.y * u32(imageSize.x);
out_normal[index] = vec4f(oidnSanitizeNormal(in_normal[index].rgb), 1.0);
`;

/** The same transfer and sanitation for composed textures and caller-owned buffers. */
export function getOIDNGuidePasses(scratch: ScratchPool, device: GPUDevice, buffers = false) {
  const uniforms: Uniform[] = [{label: 'imageSize', type: 'vec2i', data: new Int32Array([1, 1])}];
  const albedoEncode = scratch.get(buffers ? 'oidnBufferAlbedoEncodePass' : 'oidnAlbedoEncodePass', () => {
    const pass = new WGPUComputePass('OIDN albedo sRGB encode', device, {
      inputs: ['albedo'], outputs: ['albedo'], uniforms,
      csDefine: oidnAuxiliaryDefine + (buffers ? imageIndex : ''),
      csMain: oidnAlbedoSrgbEncodeMain(buffers)
    });
    pass.setOutputParams({albedo: {channels: 4}});
    return pass;
  });
  const albedoDecode = scratch.get(buffers ? 'oidnBufferAlbedoDecodePass' : 'oidnAlbedoDecodePass', () => {
    const pass = new WGPUComputePass('OIDN albedo sRGB decode', device, {
      inputs: ['albedo', 'rawAlbedo', 'rawNormal'], outputs: ['albedo'],
      uniforms: [...uniforms, {label: 'preserveSurfaceTexture', type: 'u32', data: 0}],
      csDefine: oidnAuxiliaryDefine + (buffers ? imageIndex : ''),
      csMain: oidnAlbedoSrgbDecodeMain(buffers)
    });
    pass.setOutputParams({albedo: {channels: 4}});
    return pass;
  });
  const normalSanitize = scratch.get('oidnNormalSanitizePass', () => {
    const pass = new WGPUComputePass('OIDN normal sanitize', device, {
      inputs: ['normal'], outputs: ['normal'], uniforms,
      csDefine: oidnAuxiliaryDefine, csMain: oidnNormalSanitizeMain
    });
    pass.setOutputParams({normal: {channels: 4}});
    return pass;
  });
  return {albedoEncode, albedoDecode, normalSanitize};
}
