import Camera from '../../src/scene/Camera.js';
import {mat4} from '../../src/math.js';
import {packCameraUniform} from '../../src/renderer/cameraUniform.js';
import rayTraceCompute from '../../src/renderer/wgsl/rayTrace.compute.js';
import cameraProjection from '../../src/renderer/glsl/chunks/cameraProjection.glsl.js';

// Test the production shader functions on the GPU. CPU-only arithmetic misses
// the cancellation introduced by f32 matrix storage and GPU multiplication.
export async function measureCameraPrecision(backend: 'webgpu' | 'webgl') {
  let read: (projection: Float32Array, world: Float32Array) => Promise<Float32Array>;
  let dispose: () => void;
  const errors: string[] = [];
  if (backend === 'webgpu') {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('WebGPU adapter unavailable');
    const device = await adapter.requestDevice();
    device.addEventListener('uncapturederror', event => errors.push((event as GPUUncapturedErrorEvent).error.message));
    const source = rayTraceCompute({hasDisplacement: false, cameraProjectionInverse: true});
    const block = source.match(/struct CameraUniform \{[^}]+\};/)![0];
    const ray = source.match(/fn initCameraRay\(coord: vec2f\) -> Ray \{[^}]+\}/)![0];
    const module = device.createShaderModule({code: `${block}
      @group(0) @binding(0) var<uniform> cameraUniform: CameraUniform;
      @group(0) @binding(1) var<storage,read_write> result: array<vec4f>;
      struct Ray {o: vec3f, d: vec3f};
      fn initRay(r: ptr<function,Ray>, o: vec3f, d: vec3f) {(*r).o=o; (*r).d=d;}
      ${ray}
      @compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id: vec3u) {
        let uv=array(vec2f(.5,.5),vec2f(.25,.25),vec2f(.75,.75));
        result[id.x]=vec4f(initCameraRay(uv[id.x]).d,1.0);
      }`});
    const info = await module.getCompilationInfo();
    if (info.messages.some(message => message.type === 'error')) throw new Error(info.messages.map(message => message.message).join('\n'));
    const pipeline = device.createComputePipeline({layout: 'auto', compute: {module, entryPoint: 'main'}});
    const uniform = device.createBuffer({size: 208, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST});
    const output = device.createBuffer({size: 48, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC});
    const staging = device.createBuffer({size: 48, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST});
    const group = device.createBindGroup({layout: pipeline.getBindGroupLayout(0), entries: [
      {binding: 0, resource: {buffer: uniform}}, {binding: 1, resource: {buffer: output}}
    ]});
    read = async (projection, world) => {
      const combined = mat4.mul(mat4.create(), world, projection);
      device.queue.writeBuffer(uniform, 0, packCameraUniform(combined, world, 0, 17, projection));
      const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass();
      pass.setPipeline(pipeline); pass.setBindGroup(0, group); pass.dispatchWorkgroups(3); pass.end();
      encoder.copyBufferToBuffer(output, 0, staging, 0, 48); device.queue.submit([encoder.finish()]);
      await staging.mapAsync(GPUMapMode.READ);
      const result = new Float32Array(staging.getMappedRange()).slice(); staging.unmap(); return result;
    };
    dispose = () => device.destroy();
  } else {
    const gl = document.createElement('canvas').getContext('webgl2')!;
    if (!gl?.getExtension('EXT_color_buffer_float')) throw new Error('Float WebGL framebuffer unavailable');
    const compile = (type: number, code: string) => {
      const shader = gl.createShader(type)!; gl.shaderSource(shader, code); gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader)!);
      return shader;
    };
    const program = gl.createProgram()!;
    gl.attachShader(program, compile(gl.VERTEX_SHADER, `#version 300 es
      void main(){vec2 p=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2));gl_Position=vec4(p*2.-1.,0.,1.);}`));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, `#version 300 es
      precision highp float;
      uniform mat4 projectionInv; uniform mat4 viewInv;
      struct Ray {vec3 o; vec3 d;};
      void initRay(out Ray r,vec3 o,vec3 d){r.o=o;r.d=d;}
      ${cameraProjection}
      out vec4 color;
      void main(){vec2 uv[3]=vec2[3](vec2(.5),vec2(.25),vec2(.75));color=vec4(initCameraRay(uv[int(gl_FragCoord.x)]).d,1.);}`));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program)!);
    gl.useProgram(program);
    const texture = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, 3, 1);
    gl.bindFramebuffer(gl.FRAMEBUFFER, gl.createFramebuffer());
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0); gl.viewport(0, 0, 3, 1);
    read = async (projection, world) => {
      gl.uniformMatrix4fv(gl.getUniformLocation(program, 'projectionInv'), false, projection);
      gl.uniformMatrix4fv(gl.getUniformLocation(program, 'viewInv'), false, world);
      gl.drawArrays(gl.TRIANGLES, 0, 3); const result = new Float32Array(12);
      gl.readPixels(0, 0, 3, 1, gl.RGBA, gl.FLOAT, result);
      if (gl.getError()) throw new Error('WebGL camera probe failed'); return result;
    };
    dispose = () => {gl.getExtension('WEBGL_lose_context')?.loseContext();};
  }
  const records: {projection: string; frame: number; errors: number[][]}[] = [];
  try {
    const base = mat4.create(); mat4.targetTo(base, [0, 5.5, -24], [0, 11, 10], [0, 1, 0]);
    const cameras = [new Camera({projection: 'perspective', fov: 62.660870028372074, aspect: 1000 / 1400, near: .0001, far: 1e8}),
      new Camera({projection: 'orthographic', left: -2, right: 3, bottom: -1, top: 2, near: .1, far: 1000})];
    for (const camera of cameras) for (let frame = 0; frame < 32; frame++) {
      const angle = frame * .0001, c = Math.cos(angle), s = Math.sin(angle);
      const rotation = [c,0,-s,0, 0,1,0,0, s,0,c,0, 0,0,0,1];
      const world: number[] = []; mat4.mul(world, rotation, base);
      const projection = camera.getProjectionMatrix(), inverse = mat4.invert(mat4.create(), projection)!;
      const rays = await read(inverse, new Float32Array(world));
      // Project a point along each returned ray back into the original camera.
      // Perspective direction alone suffices; orthographic direction must be -Z.
      const deviations = [0, 1, 2].map(index => {
        const d = rays.subarray(index * 4, index * 4 + 3);
        const local = [0, 1, 2].map(axis => world[axis * 4] * d[0] + world[axis * 4 + 1] * d[1] + world[axis * 4 + 2] * d[2]);
        const expected = [0, -.5, .5][index];
        return camera.projection === 'perspective'
          ? [(-projection[0] * local[0] / local[2] - expected) * 500, (-projection[5] * local[1] / local[2] - expected) * 700]
          : [local[0] * 500, local[1] * 700];
      });
      records.push({projection: camera.projection, frame, errors: deviations});
    }
    const maxErrorPixels = Math.max(...records.flatMap(record => record.errors.flat().map(Math.abs)));
    if (!Number.isFinite(maxErrorPixels) || maxErrorPixels > .001 || errors.length) throw new Error(JSON.stringify({maxErrorPixels, errors}));
    return {backend, maxErrorPixels, records};
  } finally {dispose();}
}

const run = () => measureCameraPrecision(new URLSearchParams(location.search).has('webgl') ? 'webgl' : 'webgpu');
(window as unknown as {runBenchmark: typeof run}).runBenchmark = run;
document.getElementById('run')?.addEventListener('click', () => {
  void run().then(result => {document.getElementById('result')!.textContent = JSON.stringify(result, null, 2);})
    .catch(error => {document.getElementById('result')!.textContent = String(error);});
});
