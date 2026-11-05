import type {PostProcess} from '../Display.js';
import {easuShader} from './wgsl/easu.wgsl.js';

/** Creates an edge-adaptive display-space upscale pass (AMD FSR 1 EASU), without sharpening. Register with outputSize: (_, display) => display. WebGPU only; supports rgba8unorm and extended-range rgba16float, including alpha. */
export function createEasuPass(): PostProcess {
  const devices = new WeakMap<GPUDevice, Map<GPUTextureFormat, GPURenderPipeline>>();
  return ({device, encoder, input, output}) => {
    let formats = devices.get(device);
    if (!formats) {formats = new Map(); devices.set(device, formats);}
    let pipeline = formats.get(output.format);
    if (!pipeline) {
      const module = device.createShaderModule({label: 'FSR 1 EASU', code: easuShader});
      pipeline = device.createRenderPipeline({label: 'FSR 1 EASU', layout: 'auto',
        vertex: {module, entryPoint: 'vertex'}, fragment: {module, entryPoint: 'fragment', targets: [{format: output.format}]}});
      formats.set(output.format, pipeline);
    }
    const parameters = device.createBuffer({size: 16, usage: GPUBufferUsage.UNIFORM, mappedAtCreation: true});
    new Float32Array(parameters.getMappedRange()).set([output.width, output.height, 0, 0]); parameters.unmap();
    const group = device.createBindGroup({layout: pipeline.getBindGroupLayout(0), entries: [
      {binding: 0, resource: input.createView()}, {binding: 1, resource: {buffer: parameters}}
    ]});
    const pass = encoder.beginRenderPass({label: 'FSR 1 EASU', colorAttachments: [{view: output.createView(), loadOp: 'clear', storeOp: 'store'}]});
    pass.setPipeline(pipeline); pass.setBindGroup(0, group); pass.draw(3); pass.end();
    // The callback's encoder has not been submitted yet. Retire after this turn's submission.
    void Promise.resolve().then(() => device.queue.onSubmittedWorkDone()).catch(() => {}).then(() => parameters.destroy());
  };
}
