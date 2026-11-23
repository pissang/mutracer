import {createAovDenoisingGuideWgsl} from '../../src/renderer/wgsl/aovDenoisingGuide.wgsl.js';
import glslGuide from '../../src/renderer/glsl/aovDenoisingGuide.glsl.js';

const height = 3;
const cases = [
  // Smooth base, rough clearcoat, different normals and colored lobes.
  {alpha: [0, 0], coatRoughness: .5, diffuse: [.15, .3, 0], base: [.3, 0, .3], coat: [0, 0, .45],
    expected: [[.15, .3, .45], [.3, 0, .3], [.3, 0, .7, .45]]},
  // Geometric mean .075 gives an even diffuse/specular split in the base.
  {alpha: [.15, .0375], coatRoughness: .5, diffuse: [0, 0, 0], base: [0, .6, 0], coat: [0, 0, 0],
    expected: [[0, .3, 0], [0, .3, 0], [0, 0, 1, Math.sqrt(.075)]]},
  {alpha: [.3, .3], coatRoughness: .5, diffuse: [.3, .3, .3], base: [0, 0, 0], coat: [0, 0, 0],
    expected: [[.3, .3, .3], [0, 0, 0], [0, 0, 1, 1]]},
  {alpha: [.3, .3], coatRoughness: .5, diffuse: [0, 0, 0], base: [0, 0, 0], coat: [0, 0, 0],
    expected: [[0, 0, 0], [0, 0, 0], [0, 0, 0, 0]]},
];
const width = cases.length;
const vector = (values: number[]) => values.map(value => value.toFixed(8)).join(', ');

async function webgpu() {
  const adapter = await navigator.gpu.requestAdapter({powerPreference: 'high-performance'});
  if (!adapter) throw new Error('WebGPU adapter unavailable');
  const device = await adapter.requestDevice();
  const size = width * height * 16;
  try {
    const shader = device.createShaderModule({code: /* wgsl */ `
      struct Material { alphaX: f32, alphaY: f32, coatRoughness: f32 }
      struct Basis { normal: vec3f }
      struct OpenPbrPreparedBsdf { material: Material, basis: Basis, coatBasis: Basis }
      struct MtReflectance { diffuse: vec3f, specular: vec3f, coat: vec3f }
      fn openpbr_roughness_to_alpha(roughness: f32, anisotropy: f32) -> vec2f {
        return vec2f(roughness * roughness);
      }
      ${createAovDenoisingGuideWgsl(true)}
      @group(0) @binding(0) var<storage, read_write> output: array<vec4f>;
      @compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id: vec3u) {
        let materials = array(${cases.map(c => `Material(${vector([...c.alpha, c.coatRoughness])})`).join(', ')});
        let lobes = array(${cases.map(c => `MtReflectance(vec3f(${vector(c.diffuse)}), vec3f(${vector(c.base)}), vec3f(${vector(c.coat)}))`).join(', ')});
        let prepared = OpenPbrPreparedBsdf(materials[id.x], Basis(vec3f(0, 0, 1)), Basis(vec3f(1, 0, 0)));
        let guide = aovDenoisingGuide(prepared, lobes[id.x]);
        output[id.x] = vec4f(guide.diffuse, 0);
        output[id.x + ${width}u] = vec4f(guide.specular, 0);
        output[id.x + ${2 * width}u] = guide.normalRoughness;
      }
    `});
    const pipeline = await device.createComputePipelineAsync({layout: 'auto', compute: {module: shader, entryPoint: 'main'}});
    const output = device.createBuffer({size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC});
    const staging = device.createBuffer({size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ});
    const group = device.createBindGroup({layout: pipeline.getBindGroupLayout(0), entries: [{binding: 0, resource: {buffer: output}}]});
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(width);
    pass.end();
    encoder.copyBufferToBuffer(output, 0, staging, 0, size);
    device.queue.submit([encoder.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    return new Float32Array(staging.getMappedRange().slice(0));
  } finally {
    device.destroy();
  }
}

function webgl() {
  const gl = document.createElement('canvas').getContext('webgl2');
  if (!gl || !gl.getExtension('EXT_color_buffer_float')) throw new Error('WebGL 2 float framebuffer unavailable');
  try {
    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type)!;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader)!);
      return shader;
    };
    const program = gl.createProgram()!;
    gl.attachShader(program, compile(gl.VERTEX_SHADER, /* glsl */ `#version 300 es
      void main() {
        vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
        gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
      }
    `));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, /* glsl */ `#version 300 es
      precision highp float; precision highp int;
      #define USE_COAT_NORMAL_FRAMES
      struct OpenPbrResolvedMaterial { float alphaX, alphaY, coatRoughness; };
      struct Basis { vec3 normal; };
      struct OpenPbrPreparedBsdf { OpenPbrResolvedMaterial material; Basis basis; Basis coatBasis; };
      vec2 openpbr_roughness_to_alpha(float roughness, float anisotropy) { return vec2(roughness * roughness); }
      ${glslGuide}
      out vec4 result;
      void main() {
        int i = int(gl_FragCoord.x);
        int row = int(gl_FragCoord.y);
        OpenPbrResolvedMaterial materials[] = OpenPbrResolvedMaterial[](${cases.map(c => `OpenPbrResolvedMaterial(${vector([...c.alpha, c.coatRoughness])})`).join(', ')});
        vec3 diffuse[] = vec3[](${cases.map(c => `vec3(${vector(c.diffuse)})`).join(', ')});
        vec3 base[] = vec3[](${cases.map(c => `vec3(${vector(c.base)})`).join(', ')});
        vec3 coat[] = vec3[](${cases.map(c => `vec3(${vector(c.coat)})`).join(', ')});
        OpenPbrPreparedBsdf prepared = OpenPbrPreparedBsdf(materials[i], Basis(vec3(0, 0, 1)), Basis(vec3(1, 0, 0)));
        AovDenoisingGuide guide = aovDenoisingGuide(prepared, diffuse[i], base[i], coat[i]);
        result = row == 0 ? vec4(guide.diffuse, 0.0) : row == 1 ? vec4(guide.specular, 0.0) : guide.normalRoughness;
      }
    `));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program)!);
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, width, height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, gl.createFramebuffer());
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('Incomplete float framebuffer');
    gl.useProgram(program);
    gl.viewport(0, 0, width, height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const values = new Float32Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.FLOAT, values);
    if (gl.getError() !== gl.NO_ERROR) throw new Error('WebGL denoising guide check failed');
    return values;
  } finally {
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}

async function run() {
  const backend = location.search.includes('webgl') ? 'webgl' : 'webgpu';
  const values = backend === 'webgpu' ? await webgpu() : webgl();
  let maxError = 0;
  cases.forEach(({expected}, index) => expected.forEach((row, lane) => row.forEach((value, component) => {
    const actual = values[(lane * width + index) * 4 + component];
    const error = Math.abs(actual - value);
    if (!(error < 1e-6)) throw new Error(`Guide case ${index}, lane ${lane}, component ${component}: ${actual} vs ${value}`);
    maxError = Math.max(maxError, error);
  })));
  return {backend, passed: true, cases: width, maxError};
}

const completion = run();
Object.assign(window, {aovDenoisingGuideResult: completion});
completion.then(result => {
  document.querySelector('#result')!.textContent = JSON.stringify(result);
}, error => {
  document.querySelector('#result')!.textContent = String(error?.stack ?? error);
});
