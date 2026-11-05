import type {PostProcess} from '../Display.js';
import {easuShader} from './wgsl/easu.wgsl.js';
import {albedoDownsampleShader, easuDetailShader} from './wgsl/easuDetail.wgsl.js';

/** Display-space albedo compensation controls. */
export interface EasuOptions {
  /** Recover texture detail using enabled display-resolution diffuseAlbedo, specularAlbedo and depth AOVs. Default false. Missing or mismatched AOVs use EASU alone; unsupported surfaces and silhouettes receive no compensation. */ albedoDetail?: boolean;
  /** Per-channel linear compensation bounds, positive finite min <= max. Wider bounds recover more texture contrast but alter highlights and silhouettes. Default [0.9, 1.1]. */ ratioRange?: readonly [number, number];
  /** Relative depth jump rejecting compensation across silhouettes, positive finite; absolute tolerance is at least 1e-4 scene units. Default 0.02. */ depthThreshold?: number;
  /** Minimum valid AOV coverage in (0,1]. Default 0.95. */ coverageThreshold?: number;
}
/** A display pass with optional scratch images. Dispose after unregistering; it may be used again. */
export type EasuPass = PostProcess & {dispose(): void};
/** Creates an edge-adaptive display-space upscale pass (AMD FSR 1 EASU), without sharpening. Register with outputSize: (_, display) => display. WebGPU only; supports rgba8unorm and extended-range rgba16float, including alpha. Default EASU alone. */
export function createEasuPass(options: EasuOptions = {}): EasuPass { return createEasuPassImpl(options); }

/** @internal Separate-lobe approximation is retained for comparisons; not a package export. */
export function createEasuPassImpl(options: EasuOptions = {}, separate = false): EasuPass {
  const detailEnabled = options.albedoDetail ?? false;
  const [min, max] = options.ratioRange ?? [0.9, 1.1];
  const depth = options.depthThreshold ?? .02, coverage = options.coverageThreshold ?? .95;
  if (![min,max,depth,coverage].every(Number.isFinite) || min <= 0 || max < min || depth <= 0 || coverage <= 0 || coverage > 1) throw new RangeError('Invalid EASU detail compensation options.');
  const devices = new Map<GPUDevice, {pipelines: Map<string, GPURenderPipeline>; scratch?: GPUTexture[]}>();
  const retire = (device: GPUDevice, resources: (GPUTexture | GPUBuffer)[]) => {
    // This callback's encoder is submitted after it returns.
    void Promise.resolve().then(() => device.queue.onSubmittedWorkDone()).catch(() => {}).then(() => resources.forEach(resource => resource.destroy()));
  };
  const pass: PostProcess = ctx => {
    const {device, encoder, input, output, render} = ctx;
    for (const [previous, old] of devices) if (previous !== device) {if(old.scratch)retire(previous,old.scratch);devices.delete(previous);}
    let state = devices.get(device);
    if (!state) {state = {pipelines: new Map()}; devices.set(device, state);}
    const pipeline = (key: string, code: string, formats: GPUTextureFormat[]) => {
      let value = state!.pipelines.get(key);
      if (!value) {
        const module = device.createShaderModule({label: key, code});
        value = device.createRenderPipeline({label: key, layout: 'auto', vertex: {module,entryPoint:'vertex'},
          fragment: {module,entryPoint:'fragment',targets:formats.map(format => ({format}))}});
        state!.pipelines.set(key, value);
      }
      return value;
    };
    const buffer = (values: number[]) => {
      const value = device.createBuffer({size:16,usage:GPUBufferUsage.UNIFORM,mappedAtCreation:true});
      new Float32Array(value.getMappedRange()).set(values);value.unmap();retire(device,[value]);return value;
    };
    const aovs = detailEnabled ? (['diffuseAlbedo','specularAlbedo','depth'] as const).map(kind => render.getAovTexture(kind)) : [];
    const detail = aovs.length === 3 && aovs.every(image => image && image.width === output.width && image.height === output.height);
    const entries: GPUBindGroupEntry[] = [{binding:0,resource:input.createView()}, {binding:1,resource:{buffer:buffer([output.width,output.height,min,max])}}];
    if (detail) {
      if (!state.scratch || state.scratch[0].width !== input.width || state.scratch[0].height !== input.height) {
        if(state.scratch)retire(device,state.scratch);
        state.scratch = [0,1].map(index => device.createTexture({label:`EASU low albedo ${index}`,size:[input.width,input.height],format:'rgba16float',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.RENDER_ATTACHMENT}));
      }
      const down = pipeline('Albedo area downsample',albedoDownsampleShader,['rgba16float','rgba16float']);
      const group = device.createBindGroup({layout:down.getBindGroupLayout(0),entries:[
        {binding:0,resource:aovs[0]!.createView()},{binding:1,resource:aovs[1]!.createView()},
        {binding:2,resource:{buffer:buffer([input.width,input.height,0,0])}}
      ]});
      const draw = encoder.beginRenderPass({label:'Albedo area downsample',colorAttachments:state.scratch.map(image=>({view:image.createView(),loadOp:'clear',storeOp:'store'}))});
      draw.setPipeline(down);draw.setBindGroup(0,group);draw.draw(3);draw.end();
      aovs.forEach((image,index)=>entries.push({binding:2+index,resource:image!.createView()}));
      state.scratch.forEach((image,index)=>entries.push({binding:5+index,resource:image.createView()}));
      entries.push({binding:7,resource:{buffer:buffer([1e-3,coverage,depth,1e-4])}});
    }
    const upscale = pipeline(`FSR 1 EASU ${detail ? 'detail' : 'color'} ${output.format}`,detail ? easuDetailShader(separate) : easuShader,[output.format]);
    const group = device.createBindGroup({layout:upscale.getBindGroupLayout(0),entries});
    const draw = encoder.beginRenderPass({label:'FSR 1 EASU',colorAttachments:[{view:output.createView(),loadOp:'clear',storeOp:'store'}]});
    draw.setPipeline(upscale);draw.setBindGroup(0,group);draw.draw(3);draw.end();
  };
  return Object.assign(pass, {dispose() {for(const [device,state] of devices) if(state.scratch)retire(device,state.scratch);devices.clear();}});
}
