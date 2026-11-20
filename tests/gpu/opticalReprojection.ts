import optics from '../../src/renderer/wgsl/opticalReprojection.wgsl.js';

const source = optics + /* wgsl */ `
@group(0) @binding(0) var<storage, read_write> output: array<vec4f>;
@compute @workgroup_size(1)
fn main() {
  let scale = vec2f(640.0, 480.0);
  let normal = vec3f(0.0, 0.0, 1.0);
  let point = vec3f(0.0);
  let central = opticalReflectionImage(point, normal, vec3f(0.0, 0.0, 0.25));
  let shifted = opticalReflectionImage(point, normal, vec3f(0.125, -0.125, 0.25));
  let identity = mat4x4f(vec4f(1, 0, 0, 0), vec4f(0, 1, 0, 0), vec4f(0, 0, 1, 0), vec4f(0, 0, 0, 1));
  let cameraShift = mat4x4f(identity[0], identity[1], identity[2], vec4f(-0.25, 0.0, 0.0, 1.0));
  output[0] = vec4f(central, 1.0);
  output[1] = vec4f(opticalImageMotion(central, central, identity, cameraShift, scale), 1.0);
  output[2] = vec4f(opticalImageMotion(central, shifted, identity, identity, scale), 1.0);
  output[3] = vec4f(opticalImageMotion(central, vec3f(2.0, 0.0, -0.25), identity, identity, scale), 1.0);
  output[4] = opticalSlabEntrance(point, normal, 0.5, 1.5, vec3f(0, 0, 2), vec3f(0, 0, -3));
  output[5] = opticalSlabEntrance(point, normal, 0.5, 1.5, vec3f(0, 0, 2), vec3f(3.0, -1.0, -3));
  output[6] = opticalSlabEntrance(point, normal, 0.0, 1.5, vec3f(0, 0, 2), vec3f(2.5, 0.0, -3));
  output[7] = opticalSlabEntrance(point, normal, 0.5, 1.5, vec3f(0, 0, 2), vec3f(0, 0, -0.25));
}
`;

async function run() {
  const adapter = await navigator.gpu.requestAdapter({powerPreference: 'high-performance'});
  if (!adapter) throw new Error('WebGPU adapter unavailable');
  const device = await adapter.requestDevice();
  const size = 8 * 16;
  const output = device.createBuffer({size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC});
  const staging = device.createBuffer({size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ});
  try {
    const shader = device.createShaderModule({code: source});
    const info = await shader.getCompilationInfo();
    const errors = info.messages.filter(message => message.type === 'error');
    if (errors.length) throw new Error(errors.map(message => message.message).join('\n'));
    const pipeline = await device.createComputePipelineAsync({layout:'auto', compute: {module: shader, entryPoint:'main'}});
    const group = device.createBindGroup({layout:pipeline.getBindGroupLayout(0), entries:[{binding:0, resource:{buffer:output}}]});
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(1);
    pass.end();
    encoder.copyBufferToBuffer(output, 0, staging, 0, size);
    device.queue.submit([encoder.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const values = Array.from(new Float32Array(staging.getMappedRange()));
    const verify = (row: number, expected: readonly number[], tolerance = 1e-5) => {
      const actual = values.slice(4 * row, 4 * row + 4);
      if (!actual.every((value, i) => Math.abs(value - expected[i]) < tolerance)) {
        throw new Error(`Optical projection ${row}: ${actual} vs ${expected}`);
      }
    };
    verify(0, [0, 0, -.25, 1]);
    verify(1, [-80, 0, 1, 1]);
    verify(2, [40, 30, 1, 1]);
    verify(3, [0, 0, 0, 1]);
    verify(4, [0, 0, 0, 1]);
    const forwardX = values[20] / 2;
    const forwardY = values[21] / 2;
    const incidence = Math.atan(Math.hypot(forwardX, forwardY));
    const refraction = Math.asin(Math.sin(incidence) / 1.5);
    const ambient = 2 + 2.5;
    const scale = ambient + .5 * Math.tan(refraction) / Math.tan(incidence);
    const slabTargetError = Math.hypot(scale * forwardX - 3, scale * forwardY + 1);
    if (slabTargetError >= 1e-5 || values[23] !== 1) throw new Error(`Snell target error ${slabTargetError}`);
    verify(6, [1, 0, 0, 1]);
    verify(7, [0, 0, 0, 0]);
    const adapterInfo = (adapter as GPUAdapter & { info?: GPUAdapterInfo }).info;
    return {backend:'webgpu', adapter:adapterInfo?.description || adapterInfo?.vendor || 'WebGPU', values, slabTargetError, passed:true};
  } finally {
    if (staging.mapState === 'mapped') staging.unmap();
    staging.destroy();
    output.destroy();
    device.destroy();
  }
}

const completion = run();
Object.assign(window, {opticalReprojectionResult: completion});
completion.then(result => {
  document.querySelector('#result')!.textContent = JSON.stringify(result);
}, error => {
  document.querySelector('#result')!.textContent = String(error?.stack ?? error);
});
