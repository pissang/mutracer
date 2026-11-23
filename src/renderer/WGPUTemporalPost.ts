import {accumulate, blur, reproject, snapshot} from './temporalKernels.js';
import {combine, match, pyramid} from './temporalFlow.js';
import type {TemporalHistoryGPU} from './WGPUTemporalHistory.js';

const scales = [2, 4, 8];

export class TemporalPostGPU {
  [key: string]: any;
  static async create(history: TemporalHistoryGPU, slots: number, materialCount=0) {
    const ring = new TemporalPostGPU(history, slots, materialCount);
    try { await ring.init(); return ring; }
    catch (error) { ring.dispose(); throw error; }
  }

  private constructor(readonly history: TemporalHistoryGPU, readonly capacity: number, materialCount: number) {
    const {device, width, height, bytes} = history;
    Object.assign(this, {device, width, height, bytes, materialCapacity: Math.max(1, materialCount)});
    this.resources = new Map();
  }

  texture(name:string, layers:number, format:GPUTextureFormat = 'rgba16float', width:number = this.width, height:number = this.height) {
    const texture = this.device.createTexture({label:name, size:[width,height,layers], format,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST |
        GPUTextureUsage.COPY_SRC | GPUTextureUsage.STORAGE_BINDING});
    this.resources.set(texture, width * height * layers * (format === 'rgba16float' ? 8 : 16));
    return texture;
  }

  buffer(size:number, usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC) {
    const buffer = this.device.createBuffer({size, usage});
    this.resources.set(buffer, size);
    return buffer;
  }

  async init() {
    const d = this.device, count = this.capacity;
    this.map = this.buffer(this.bytes);
    this.counts = this.buffer(80);
    this.total = this.buffer(this.bytes);
    this.output = this.buffer(this.bytes);
    this.params = this.buffer(32, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    this.changedMaterials = this.buffer(count * (this.materialCapacity + 1) * 4);
    this.display = this.texture('OIDN display history', count);
    this.blurTemp = this.texture('Horizontal blur scratch', 1);
    this.blurred = this.texture('Blurred display history', count);
    this.pyramid = scales.map(scale => this.texture('Image match pyramid', count,
      'rgba16float', Math.ceil(this.width/scale), Math.ceil(this.height/scale)));
    this.reverseMap = this.buffer(this.bytes);
    this.paths = this.buffer(this.bytes / 4);
    this.forward = scales.map(scale => this.flowGrid(scale));
    this.backward = scales.map(scale => this.flowGrid(scale));
    this.empty = this.buffer(8);
    this.forwardRefined = this.flowGrid(scales[0]);
    this.backwardRefined = this.flowGrid(scales[0]);

    const uniform = {buffer:{type:'uniform'}}, storage = {buffer:{type:'storage'}}, read = {buffer:{type:'read-only-storage'}};
    const tex = {texture:{sampleType:'unfilterable-float',viewDimension:'2d-array'}};
    const ids = {texture:{sampleType:'uint',viewDimension:'2d-array'}};
    const target = {storageTexture:{access:'write-only',format:'rgba16float',viewDimension:'2d-array'}};
    const shaders: Record<string, [string, any[]]> = {
      reproject: [reproject, [uniform,tex,ids,read,storage,storage,tex]],
      accumulate: [accumulate, [uniform,tex,storage,storage]],
      snapshot: [snapshot, [uniform,read,target]],
      combine: [combine,[uniform,tex,tex,read,read,read,storage,storage,read,ids,read]],
      match: [match,[uniform,tex,read,read,storage]],
      pyramid: [pyramid,[uniform,tex,target]],
      blur: [blur,[uniform,tex,target]],
    };
    this.pipelines = {};
    for (const [name, [code, entries]] of Object.entries(shaders)) {
      const module = d.createShaderModule({label:name, code});
      const errors = (await module.getCompilationInfo()).messages.filter((row:GPUCompilationMessage) => row.type === 'error');
      if (errors.length) throw Error(name + ': ' + errors.map((error:GPUCompilationMessage) => error.message).join('\n'));
      const layout = d.createBindGroupLayout({entries: entries.map((entry,binding) => ({
        binding, visibility:GPUShaderStage.COMPUTE, ...entry
      }))});
      this.pipelines[name] = await d.createComputePipelineAsync({
        layout:d.createPipelineLayout({bindGroupLayouts:[layout]}), compute:{module,entryPoint:'main'}
      });
    }
  }

  memory() {
    return {total: [...this.resources.values() as Iterable<number>].reduce((sum, bytes) => sum + bytes, 0)};
  }

  async ensureMaterialCapacity(count:number) {
    const capacity=Math.max(1,count);if(capacity<=this.materialCapacity)return;
    await this.device.queue.onSubmittedWorkDone();
    const old=this.changedMaterials;this.resources.delete(old);
    this.materialCapacity=capacity;this.changedMaterials=this.buffer(this.capacity*(capacity+1)*4);
    old.destroy();
  }

  writeMaterialChanges(frame:number,ids:readonly number[]) {
    if(!this.changedMaterials)return;
    const values=new Uint32Array(ids.length+1);values[0]=ids.length;values.set(ids,1);
    const stride=(this.materialCapacity+1)*4;
    this.device.queue.writeBuffer(this.changedMaterials,this.slot(frame)*stride,values);
  }

  clearMaterialChanges() {
    if(!this.changedMaterials)return;
    const words=this.materialCapacity+1,values=new Uint32Array(this.capacity*words);
    for(let slot=0;slot<this.capacity;slot++)values[slot*words]=0xffffffff;
    this.device.queue.writeBuffer(this.changedMaterials,0,values);
  }

  slot(frame:number) { return ((frame % this.capacity) + this.capacity) % this.capacity; }

  paramsFor(i:number, j:number, stage = 0, axis = 0) {
    return [this.width,this.height,this.slot(i),this.slot(j),j-i,stage,axis,this.capacity];
  }

  flowGrid(scale:number) {
    return this.buffer(Math.ceil(this.width/(scale*3))*Math.ceil(this.height/(scale*3))*8);
  }

  async dispatch(name:string, resources:any[], params:any, label:string, width:number = this.width, height:number = this.height) {
    const d = this.device;
    d.queue.writeBuffer(this.params,0,new Uint32Array(params));
    const pipeline = this.pipelines[name];
    const group = d.createBindGroup({layout:pipeline.getBindGroupLayout(0),
      entries:resources.map((resource,binding) => ({
        binding, resource:resource instanceof GPUBuffer ? {buffer:resource} : resource.createView({dimension:'2d-array'})
      }))});
    const encoder = d.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0,group);
    pass.dispatchWorkgroups(Math.ceil(width/8), Math.ceil(height/8));
    pass.end();
    d.queue.submit([encoder.finish()]);
  }

  async mapping(i:number, j:number, stats = false, output:any = this.map) {
    const history = this.history;
    for (let k = Math.min(i, j); k <= Math.max(i, j); k++) {
      if (history.frames.get(history.slot(k)) !== k) throw Error('Missing history ' + k);
    }
    if (stats) this.device.queue.writeBuffer(this.counts, 0, new Uint32Array(20));
    await this.dispatch('reproject', [this.params, history.surface, history.id, history.meta, output, this.counts, history.motion],
      [this.width, this.height, history.slot(i), history.slot(j), j - i, 4, Number(stats), history.capacity], 'post-geometry');
  }

  async match(i:number, j:number, outputs:any[], mapping:any, refined:any) {
    for (let level=scales.length-1; level>=0; level--) {
      const scale = scales[level];
      await this.dispatch('match',[this.params,this.pyramid[level],outputs[level+1]??this.empty,mapping,outputs[level]],
        this.paramsFor(i,j,4,scale),'match-1/'+scale,Math.ceil(this.width/(3*scale)),Math.ceil(this.height/(3*scale)));
    }
    const scale = scales[0];
    await this.dispatch('match',[this.params,this.pyramid[0],outputs[0],mapping,refined],
      this.paramsFor(i,j,5,scale),'match-propagate',Math.ceil(this.width/(3*scale)),Math.ceil(this.height/(3*scale)));
  }

  async filter(i:number, neighbors:number[], stats = false, onPath?:any, changedByFrame:ReadonlyMap<number,readonly number[]>=new Map()) {
    this.clearMaterialChanges();
    const init = [this.params, this.display, this.total, this.output];
    await this.dispatch('accumulate', init, this.paramsFor(i, i), 'post-init');
    const counts: Record<number, number[]> = {};
    for (const j of neighbors) {
      await this.mapping(i, j, stats);
      if (stats) counts[j - i] = Array.from(new Uint32Array(await this.read(this.counts, 80)));
      this.writeMaterialChanges(j, changedByFrame.get(j) ?? []);
      await this.mapping(j, i, false, this.reverseMap);
      await this.match(i, j, this.forward, this.map, this.forwardRefined);
      await this.match(j, i, this.backward, this.reverseMap, this.backwardRefined);
      const combineParams = this.paramsFor(i, j, 4, this.history.slot(i));
      combineParams[7] = this.materialCapacity + 1;
      await this.dispatch('combine', [this.params, this.display, this.blurred, this.map, this.forwardRefined,
        this.backwardRefined, this.total, this.paths, this.reverseMap, this.history.id, this.changedMaterials], combineParams, 'combine');
      if (onPath) await onPath(j, new Uint32Array(await this.read(this.paths, this.bytes / 4)));
    }
    await this.dispatch('accumulate', init, this.paramsFor(i, i, 2), 'post-resolve');
    return counts;
  }

  async prepareDisplay(frame:number) {
    await this.dispatch('blur',[this.params,this.display,this.blurTemp],this.paramsFor(frame,frame,0,0),'blur-x');
    await this.dispatch('blur',[this.params,this.blurTemp,this.blurred],this.paramsFor(frame,frame,0,1),'blur-y');
    for (let level=0; level<scales.length; level++) {
      const dst=this.pyramid[level];
      await this.dispatch('pyramid',[this.params,level?this.pyramid[level-1]:this.display,dst],
        this.paramsFor(frame,frame),'pyramid-1/'+scales[level],dst.width,dst.height);
    }
  }

  async setDisplayBuffer(frame:number, buffer:GPUBuffer) {
    await this.dispatch('snapshot',[this.params,buffer,this.display],this.paramsFor(frame,frame,4),'display-snapshot');
    await this.prepareDisplay(frame);
  }

  async read(buffer:GPUBuffer = this.output, size:number = this.bytes) {
    const d = this.device;
    const staging = d.createBuffer({size,usage:GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ});
    try {
      const encoder = d.createCommandEncoder();
      encoder.copyBufferToBuffer(buffer,0,staging,0,size);
      d.queue.submit([encoder.finish()]);
      await staging.mapAsync(GPUMapMode.READ);
      return staging.getMappedRange().slice(0);
    } finally { staging.destroy(); }
  }

  dispose() {
    for (const resource of this.resources.keys()) resource.destroy();
    this.resources.clear();
  }
}
