import {textureBytes} from './gpuMemory.js';
import {compactAovResolveCode} from './wgsl/aovCompact.wgsl.js';
import {aovBorrowDepthShader, aovBorrowReflectanceShader} from './wgsl/aovResolve.wgsl.js';
import {aovDisplayShader} from './wgsl/aovDisplay.wgsl.js';
import {packAovDisplay, type AovDisplayOptions} from './aovDisplay.js';
import {aovSnapshotShader, aovSnapshotBinding, AOV_SNAPSHOT_BATCH_SIZE} from './wgsl/aovSnapshot.wgsl.js';
import {AovHistory, AOV_KINDS, AOV_LAYOUT, aovLaneKind, aovMask, type AovKind, type AovFrameSnapshot} from './aov.js';
/** @internal Content revision of each borrowed AOV texture; changes whenever it is re-resolved. */
export const borrowedAovRevision = new WeakMap<GPUTexture, number>();
/** One target's optional AOV allocations and accepted frame history. */
export class WGPUAov {
  readonly history = new AovHistory();
  width = 0; height = 0; samples = 0; centerReady = false; compact = false;
  private revision = 0;
  private readonly borrowed = new Map<AovKind, {image: GPUTexture; pipeline: GPUComputePipeline | GPURenderPipeline; samples: number; revision: number}>();
  accumulation?: GPUBuffer; center?: GPUBuffer; previousCenter?: GPUBuffer; scene?: GPUBuffer;
  frame?: AovFrameSnapshot;
  private displayPipeline?: GPUComputePipeline;
  private displayTexture?: GPUTexture;
  private readonly resolvePipelines = new Map<string, GPUComputePipeline>();
  private scenePrimitives?: Uint32Array;
  private scenePrimitiveOffset = 0;
  private snapshotGeneration = 0;
  private readonly snapshotPool = new Map<AovKind, GPUBuffer>();
  private readonly snapshotLeases = new WeakMap<GPUBuffer, {kind: AovKind; generation: number}>();
  private readonly snapshotBuffers = new Set<GPUBuffer>();
  constructor(readonly device: GPUDevice) {}
  private resolveCode(code: string) {
    return this.compact ? compactAovResolveCode(code) : code;
  }
  reset() {
    this.revision++;
    if (!this.compact && this.centerReady && this.center && this.previousCenter) {
      const encoder=this.device.createCommandEncoder();encoder.copyBufferToBuffer(this.center,0,this.previousCenter,0,this.center.size);this.device.queue.submit([encoder.finish()]);
    }
    this.samples = 0; this.centerReady = false; this.frame = undefined; }
  resize(width: number, height: number, compact = false) {
    if (width === this.width && height === this.height && compact === this.compact) return;
    const stride = compact ? 24 : AOV_LAYOUT.accumulatedBytes;
    if (width*height*stride>this.device.limits.maxStorageBufferBindingSize || width*height*stride>this.device.limits.maxBufferSize) throw new RangeError('AOV accumulation exceeds device buffer limits');
    this.dispose(); this.history.clear(); this.reset(); this.width = width; this.height = height; this.compact = compact; this.displayPipeline = undefined;
    const usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
    this.accumulation = this.device.createBuffer({label: 'AOV accumulation', size: width * height * stride, usage});
    this.previousCenter = this.device.createBuffer({label: 'Previous AOV center', size: compact ? 32 : width*height*AOV_LAYOUT.centerBytes, usage});
    this.center = this.device.createBuffer({label: 'AOV center', size: compact ? 32 : width * height * AOV_LAYOUT.centerBytes, usage});
  }
  setScene(words: Uint32Array, primitiveIds?: Uint32Array) {
    const bytes = words.byteLength + (primitiveIds?.byteLength ?? 0);
    if (bytes > this.device.limits.maxStorageBufferBindingSize) throw new RangeError('AOV scene metadata exceeds device storage binding limit');
    let replaced = false;
    if (!this.scene || this.scene.size < bytes) {
      this.scene?.destroy();
      this.scene = this.device.createBuffer({label: 'AOV identities/history', size: Math.max(16, bytes), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST});
      replaced = true;
    }
    this.device.queue.writeBuffer(this.scene, 0, words);
    // Primitive-cache arrays are immutable. Camera, material and rigid edits
    // update only the prefix; topology/storage replacements change the tail's
    // identity, and instance/material counts can move its byte offset.
    if (primitiveIds && (replaced || this.scenePrimitives !== primitiveIds || this.scenePrimitiveOffset !== words.byteLength)) {
      this.device.queue.writeBuffer(this.scene, words.byteLength, primitiveIds);
    }
    this.scenePrimitives = primitiveIds; this.scenePrimitiveOffset = words.byteLength;
  }
  get bytes() { return (this.accumulation?.size ?? 0) + (this.center?.size ?? 0) + (this.previousCenter?.size ?? 0) + (this.scene?.size ?? 0) + (this.displayTexture ? this.width*this.height*8 : 0) + [...this.borrowed.values()].reduce((bytes, entry) => bytes + textureBytes(entry.image), 0) + [...this.snapshotBuffers].reduce((bytes, buffer) => bytes + buffer.size, 0); }
  snapshot(kinds: readonly AovKind[]): Partial<Record<AovKind,GPUBuffer>> {
    if(!this.accumulation || !this.center || !this.samples) throw new Error('AOV output is not ready');
    const device = this.device;
    aovMask(kinds);
    const unique = AOV_KINDS.filter(kind => kinds.includes(kind));
    const batches: {kinds: AovKind[]; pipeline: GPUComputePipeline}[] = [];
    for (let offset = 0; offset < unique.length; offset += AOV_SNAPSHOT_BATCH_SIZE) {
      const batch = unique.slice(offset, offset + AOV_SNAPSHOT_BATCH_SIZE), key = `${this.compact}:${batch.join(',')}`;
      let pipeline = this.resolvePipelines.get(key);
      if (!pipeline) {
        pipeline = device.createComputePipeline({label: 'AOV snapshot', layout: 'auto',
          compute: {module: device.createShaderModule({code: this.resolveCode(aovSnapshotShader(batch))}), entryPoint: 'main', ...(this.compact ? {constants: {AOV_COMPACT: 1}} : {})}});
        this.resolvePipelines.set(key, pipeline);
      }
      batches.push({kinds: batch, pipeline});
    }
    const buffers: Partial<Record<AovKind, GPUBuffer>> = {};
    if (!batches.length) return buffers;
    const parameters = device.createBuffer({size: 16, usage: GPUBufferUsage.UNIFORM, mappedAtCreation: true});
    new Uint32Array(parameters.getMappedRange()).set([this.width, this.height, this.samples, 0]); parameters.unmap();
    try {
      const encoder = device.createCommandEncoder({label: 'AOV snapshot'}), pass = encoder.beginComputePass();
      for (const {kinds: batch, pipeline} of batches) {
        const entries: GPUBindGroupEntry[] = [
          {binding: 0, resource: {buffer: this.accumulation}},
          {binding: 1, resource: {buffer: this.center}},
          {binding: 3, resource: {buffer: parameters}}
        ];
        batch.forEach((kind, index) => {
          const buffer = this.snapshotPool.get(kind) ?? device.createBuffer({label: `Custom ${kind} input`, size: this.width * this.height * 16,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST});
          this.snapshotPool.delete(kind);
          this.snapshotLeases.set(buffer, {kind, generation: this.snapshotGeneration});
          this.snapshotBuffers.add(buffer);
          buffers[kind] = buffer;
          entries.push({binding: aovSnapshotBinding(index), resource: {buffer}});
        });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, device.createBindGroup({layout: pipeline.getBindGroupLayout(0), entries}));
        pass.dispatchWorkgroups(Math.ceil(this.width / 8), Math.ceil(this.height / 8));
      }
      pass.end(); device.queue.submit([encoder.finish()]);
      return buffers;
    } catch (error) {
      // Nothing was submitted, so these unfinished outputs can be retired now.
      Object.values(buffers).forEach(buffer => {
        if (buffer) {this.snapshotLeases.delete(buffer); this.snapshotBuffers.delete(buffer); buffer.destroy();}
      });
      throw error;
    } finally { parameters.destroy(); }
  }
  // Call only after the consumer and its queued GPU work have finished. Each
  // in-flight denoiser owns separate outputs, including cancelled jobs whose
  // callbacks have not settled. Keep at most one reusable buffer per kind.
  releaseSnapshot(buffers: Partial<Record<AovKind, GPUBuffer>>) {
    for (const buffer of Object.values(buffers)) {
      if (!buffer) continue;
      const lease = this.snapshotLeases.get(buffer);
      if (!lease) continue;
      this.snapshotLeases.delete(buffer);
      if (lease.generation === this.snapshotGeneration && !this.snapshotPool.has(lease.kind)) {
        this.snapshotPool.set(lease.kind, buffer);
      } else { this.snapshotBuffers.delete(buffer); buffer.destroy(); }
    }
  }
  visualize(kind: AovKind, options: AovDisplayOptions, linear: boolean): GPUTexture {
    if(!this.accumulation || !this.center || !this.samples) throw new Error('AOV output is not ready');
    const device=this.device;
    this.displayPipeline ??= device.createComputePipeline({label:'AOV visualization',layout:'auto',compute:{module:device.createShaderModule({code:this.resolveCode(aovDisplayShader('rgba16float'))}),entryPoint:'main',...(this.compact ? {constants:{AOV_COMPACT:1}} : {})}});
    if(!this.displayTexture || this.displayTexture.width!==this.width || this.displayTexture.height!==this.height){
      this.displayTexture?.destroy();
      this.displayTexture=device.createTexture({label:'AOV display image',size:[this.width,this.height],format:'rgba16float',usage:GPUTextureUsage.STORAGE_BINDING|GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_SRC});
    }
    const words=packAovDisplay(this.width,this.height,this.samples,kind,options,linear);
    const parameters=device.createBuffer({size:48,usage:GPUBufferUsage.UNIFORM,mappedAtCreation:true});new Uint32Array(parameters.getMappedRange()).set(words);parameters.unmap();
    const group=device.createBindGroup({layout:this.displayPipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:this.accumulation}},{binding:1,resource:{buffer:this.center}},{binding:2,resource:this.displayTexture.createView()},{binding:3,resource:{buffer:parameters}}]});
    const encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();pass.setPipeline(this.displayPipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(Math.ceil(this.width/8),Math.ceil(this.height/8));pass.end();device.queue.submit([encoder.finish()]);parameters.destroy();
    return this.displayTexture;
  }
  texture(kind: 'depth' | 'diffuseColor' | 'specularColor'): GPUTexture | undefined {
    if (!this.samples || !this.accumulation || !this.center) return;
    const device = this.device;
    let entry = this.borrowed.get(kind);
    if (!entry) {
      // Reflectance in [0,1] is stored sRGB-encoded in 8 bits (decoded on load), halving its memory
      // with fine steps for dark albedo; depth keeps float32 precision.
      const depth = kind === 'depth', format: GPUTextureFormat = depth ? 'rg32float' : 'rgba8unorm-srgb';
      const constants = this.compact ? {constants: {AOV_COMPACT: 1}} : {};
      let pipeline: GPUComputePipeline | GPURenderPipeline;
      if (depth) {
        pipeline = device.createComputePipeline({label: `Borrow ${kind}`, layout: 'auto', compute: {
          module: device.createShaderModule({code:this.resolveCode(aovBorrowDepthShader)}), entryPoint: 'main', ...constants}});
      } else {
        const module = device.createShaderModule({code:this.resolveCode(aovBorrowReflectanceShader)});
        pipeline = device.createRenderPipeline({label: `Borrow ${kind}`, layout: 'auto', vertex: {module, entryPoint: 'vertex', ...constants},
          fragment: {module, entryPoint: 'fragment', targets: [{format}], ...constants}});
      }
      const image = device.createTexture({label: `Borrow ${kind}`, size: [this.width,this.height], format,
        usage: (depth ? GPUTextureUsage.STORAGE_BINDING : GPUTextureUsage.RENDER_ATTACHMENT) | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC});
      entry = {image, pipeline, samples: -1, revision: -1}; this.borrowed.set(kind, entry);
    }
    if (entry.samples !== this.samples || entry.revision !== this.revision) {
      const parameters = device.createBuffer({size:16,usage:GPUBufferUsage.UNIFORM,mappedAtCreation:true});
      new Uint32Array(parameters.getMappedRange()).set([this.width,this.height,this.samples,aovLaneKind(kind)]); parameters.unmap();
      const encoder = device.createCommandEncoder();
      const entries: GPUBindGroupEntry[] = [{binding:0,resource:{buffer:this.accumulation}},{binding:1,resource:{buffer:this.center}},{binding:3,resource:{buffer:parameters}}];
      if (kind === 'depth') {
        const pipeline = entry.pipeline as GPUComputePipeline;
        const group = device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[...entries,{binding:2,resource:entry.image.createView()}]});
        const pass = encoder.beginComputePass({label:`Resolve ${kind}`});
        pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(Math.ceil(this.width/8),Math.ceil(this.height/8));pass.end();
      } else {
        const pipeline = entry.pipeline as GPURenderPipeline;
        const group = device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries});
        const pass = encoder.beginRenderPass({label:`Resolve ${kind}`,colorAttachments:[{view:entry.image.createView(),loadOp:'clear',storeOp:'store'}]});
        pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.draw(3);pass.end();
      }
      device.queue.submit([encoder.finish()]);parameters.destroy();entry.samples=this.samples;entry.revision=this.revision;
      borrowedAovRevision.set(entry.image, (borrowedAovRevision.get(entry.image) ?? 0) + 1);
    }
    return entry.image;
  }
  async read(kind: AovKind) {
    if (this.compact) {
      const buffers = this.snapshot([kind]), source = buffers[kind]!;
      const staging = this.device.createBuffer({size: source.size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST});
      try {
        const encoder = this.device.createCommandEncoder();encoder.copyBufferToBuffer(source,0,staging,0,source.size);
        this.device.queue.submit([encoder.finish()]);await staging.mapAsync(GPUMapMode.READ);
        return {width:this.width,height:this.height,data:new Float32Array(staging.getMappedRange().slice(0))};
      } finally {
        if(staging.mapState==='mapped')staging.unmap();staging.destroy();
        this.snapshotLeases.delete(source);this.snapshotBuffers.delete(source);source.destroy();
      }
    }
    const center = kind === 'id' || kind === 'motion';
    const source = center ? this.center! : this.accumulation!;
    const staging = this.device.createBuffer({size: source.size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST});
    try {
      const encoder = this.device.createCommandEncoder(); encoder.copyBufferToBuffer(source, 0, staging, 0, source.size);
      this.device.queue.submit([encoder.finish()]); await staging.mapAsync(GPUMapMode.READ);
      const f = new Float32Array(staging.getMappedRange()), u = new Uint32Array(f.buffer);
      const data = kind === 'id' ? new Uint32Array(this.width*this.height*4) : new Float32Array(this.width*this.height*4);
      for (let y = 0; y < this.height; y++) for (let x = 0; x < this.width; x++) {
        const target = (y * this.width + x) * 4;
        // Tracing uses OpenGL camera coordinates; API images are top row first.
        const pixel = ((this.height-1-y)*this.width+x), o = pixel * (center ? 8 : 16);
        if (kind === 'id') data.set(u.subarray(o, o+4), target);
        else if (kind === 'motion') data.set([f[o+4],f[o+5],0,f[o+7]], target);
        else {
          const hits = f[o+7], coverage = hits / Math.max(1, this.samples), inv = hits > 0 ? 1 / hits : 0;
          if (kind === 'depth') data.set([f[o]*inv, 0, 0, coverage], target);
          else if (kind === 'position') data.set([f[o+4]*inv, f[o+5]*inv, f[o+6]*inv, coverage], target);
          else if (kind === 'roughness') data.set([f[o+1]*inv, f[o+2]*inv, f[o+3]*inv, coverage], target);
          else { const offset = aovLaneKind(kind) === 3 ? o+8 : o+12, valid = f[offset+3];
            const scale = valid > 0 ? 1/valid : 0;
            data.set([f[offset]*scale, f[offset+1]*scale, f[offset+2]*scale, valid / Math.max(1,this.samples)], target); }
        }
      }
      return {width: this.width, height: this.height, data};
    } finally { if (staging.mapState === 'mapped') staging.unmap(); staging.destroy(); }
  }
  dispose() {
    const borrowed = [...this.borrowed.values()];this.borrowed.clear();
    const texture=this.displayTexture;this.displayTexture=undefined;
    this.scenePrimitives = undefined; this.scenePrimitiveOffset = 0;
    this.snapshotGeneration++;
    const pooled = [...this.snapshotPool.values()]; this.snapshotPool.clear();
    pooled.forEach(buffer => this.snapshotBuffers.delete(buffer));
    const buffers=[this.accumulation,this.center,this.scene,this.previousCenter,...pooled];
    this.accumulation=this.center=this.scene=this.previousCenter=undefined;
    void this.device.queue.onSubmittedWorkDone().catch(()=>undefined).then(()=>{borrowed.forEach(entry=>entry.image.destroy());texture?.destroy();buffers.forEach(buffer=>buffer?.destroy());});
  }
}
