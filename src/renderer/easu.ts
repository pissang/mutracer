import type {PostProcess} from '../Display.js';
import {easuShader} from './wgsl/easu.wgsl.js';
import {albedoDownsampleShader, easuDetailShader, toneLutShader, TONE_LUT_SIZE} from './wgsl/easuDetail.wgsl.js';
import {borrowedAovRevision} from './WGPUAov.js';
import {TONE_MAPPING_MODES} from './wgsl/compose.frag.wgsl.js';

/** Display-space albedo compensation controls. */
export interface EasuOptions {
  /** Recover texture detail using enabled display-resolution diffuseAlbedo, specularAlbedo and depth AOVs. Default false. Missing or mismatched AOVs use EASU alone; unsupported surfaces and silhouettes receive no compensation. */ albedoDetail?: boolean;
  /** Per-channel linear compensation bounds, positive finite min <= max. Wider bounds recover more texture contrast but alter highlights and silhouettes. Default [0.85, 1.18]. */ ratioRange?: readonly [number, number];
  /** Relative departure of neighboring inverse depth from a plane that marks a silhouette and rejects compensation there, positive finite; sloped planes are not silhouettes. Default 0.02. */ depthThreshold?: number;
  /** Minimum valid AOV coverage in (0,1]. Default 0.95. */ coverageThreshold?: number;
}
/** A display pass with optional scratch images. Dispose after unregistering; it may be used again. */
export type EasuPass = PostProcess & {dispose(): void};
/** Creates an edge-adaptive display-space upscale pass (AMD FSR 1 EASU), without sharpening. Register with outputSize: (_, display) => display. WebGPU only; supports rgba8unorm and extended-range rgba16float, including alpha. Default EASU alone. */
export function createEasuPass(options: EasuOptions = {}): EasuPass { return createEasuPassImpl(options); }

/** @internal Separate-lobe approximation and depth-guided silhouettes are retained for comparisons; not package exports. */
export function createEasuPassImpl(options: EasuOptions = {}, separate = false, silhouettes = false): EasuPass {
  const detailEnabled = options.albedoDetail ?? false;
  const [min, max] = options.ratioRange ?? [0.85, 1.18];
  const depth = options.depthThreshold ?? .02, coverage = options.coverageThreshold ?? .95;
  if (![min,max,depth,coverage].every(Number.isFinite) || min <= 0 || max < min || depth <= 0 || coverage <= 0 || coverage > 1) throw new RangeError('Invalid EASU detail compensation options.');
  const devices = new Map<GPUDevice, {pipelines: Map<string, GPURenderPipeline>; scratch?: GPUTexture[]; key?: unknown[]; tone?: GPUTexture; toneKey?: string}>();
  const retire = (device: GPUDevice, resources: (GPUTexture | GPUBuffer)[]) => {
    // This callback's encoder is submitted after it returns.
    void Promise.resolve().then(() => device.queue.onSubmittedWorkDone()).catch(() => {}).then(() => resources.forEach(resource => resource.destroy()));
  };
  const guideFormats: GPUTextureFormat[] = silhouettes ? ['rgba16float','rgba16float','rg32float'] : ['rgba16float','rgba16float'];
  const owned = (state: {scratch?: GPUTexture[]; tone?: GPUTexture}) => [...(state.scratch ?? []), ...(state.tone ? [state.tone] : [])];
  const pass: PostProcess = ctx => {
    const {device, encoder, input, output, render} = ctx;
    for (const [previous, old] of devices) if (previous !== device) {retire(previous,owned(old));devices.delete(previous);}
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
      // Cached images are recorded on their own submission so a failed chain cannot leave them stale.
      let cache: GPUCommandEncoder | undefined;
      const cached = () => cache ??= device.createCommandEncoder({label: 'EASU cache'});
      if (!state.scratch || state.scratch.length !== guideFormats.length || state.scratch[0].width !== input.width || state.scratch[0].height !== input.height) {
        if(state.scratch)retire(device,state.scratch);
        // Low diffuse and specular albedo, then (for silhouettes) nearest hit depth with hit coverage.
        state.scratch = guideFormats.map((format, index) => device.createTexture({label:`EASU low guide ${index}`,size:[input.width,input.height],format,usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.RENDER_ATTACHMENT}));
        state.key = undefined;
      }
      // Low albedo depends only on the AOV contents and beauty size; reuse it across presents.
      const key = [state.scratch[0], ...aovs, ...aovs.map(image => borrowedAovRevision.get(image!))];
      if (!state.key || key.some((value, index) => value !== state.key![index])) {
        const down = pipeline(`Albedo area downsample ${silhouettes}`,albedoDownsampleShader(silhouettes),guideFormats);
        const group = device.createBindGroup({layout:down.getBindGroupLayout(0),entries:[
          {binding:0,resource:aovs[0]!.createView()},{binding:1,resource:aovs[1]!.createView()},
          {binding:2,resource:{buffer:buffer([input.width,input.height,0,0])}},{binding:3,resource:aovs[2]!.createView()}
        ]});
        const draw = cached().beginRenderPass({label:'Albedo area downsample',colorAttachments:state.scratch.map(image=>({view:image.createView(),loadOp:'clear',storeOp:'store'}))});
        draw.setPipeline(down);draw.setBindGroup(0,group);draw.draw(3);draw.end();
        state.key = key;
      }
      aovs.forEach((image,index)=>entries.push({binding:2+index,resource:image!.createView()}));
      entries.push({binding:5,resource:state.scratch[0].createView()},{binding:6,resource:state.scratch[1].createView()});
      if (silhouettes) entries.push({binding:10,resource:state.scratch[2].createView()});
      entries.push({binding:7,resource:{buffer:buffer([1e-3,coverage,depth,1e-4])}});
      // The ratio is applied through the same grading and tone mapping as the composed image,
      // tabulated once per display setting.
      const display = render._engine.display, extended = output.format === 'rgba16float';
      const tone = [TONE_MAPPING_MODES[display.toneMapping] ?? 0, extended ? 16 : 1, display.toneMappingExposure, extended ? 1 : 0];
      const grading = [display.contrast, display.saturation, display.temperature, display.tint];
      const toneKey = [...tone, ...grading].join(',');
      state.tone ??= device.createTexture({label:'EASU tone table',size:[TONE_LUT_SIZE,2],format:'rgba32float',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.RENDER_ATTACHMENT});
      if (state.toneKey !== toneKey) {
        const build = pipeline('EASU tone table',toneLutShader,['rgba32float']);
        const group = device.createBindGroup({layout:build.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:buffer(tone)}},{binding:1,resource:{buffer:buffer(grading)}}]});
        const draw = cached().beginRenderPass({label:'EASU tone table',colorAttachments:[{view:state.tone.createView(),loadOp:'clear',storeOp:'store'}]});
        draw.setPipeline(build);draw.setBindGroup(0,group);draw.draw(3);draw.end();
        state.toneKey = toneKey;
      }
      entries.push({binding:8,resource:state.tone.createView()},{binding:9,resource:{buffer:buffer([tone[1],0,0,0])}});
      if (cache) device.queue.submit([cache.finish()]);
    }
    const upscale = pipeline(`FSR 1 EASU ${detail ? `detail ${separate} ${silhouettes}` : 'color'} ${output.format}`,detail ? easuDetailShader(separate, silhouettes) : easuShader,[output.format]);
    const group = device.createBindGroup({layout:upscale.getBindGroupLayout(0),entries});
    const draw = encoder.beginRenderPass({label:'FSR 1 EASU',colorAttachments:[{view:output.createView(),loadOp:'clear',storeOp:'store'}]});
    draw.setPipeline(upscale);draw.setBindGroup(0,group);draw.draw(3);draw.end();
  };
  return Object.assign(pass, {dispose() {for(const [device,state] of devices) retire(device,owned(state));devices.clear();}});
}
