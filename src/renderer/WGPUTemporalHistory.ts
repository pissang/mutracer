import {accumulate, blur, idSnapshot, rawSnapshot, reproject, snapshot} from './temporalKernels.js';
import {combine, match, pyramid} from './temporalFlow.js';

const overflowBuckets = 4096, entryBytes = 32;
const fields = ['centerPosition', 'centerDepth', 'centerNormal', 'roughness', 'motion'];
const scales = [2, 4, 8];

export class TemporalGPU {
  [key: string]: any;
  static async create(device: GPUDevice, width: number, height: number, stage: 'pre'|'post', slots: number) {
    const ring = new TemporalGPU(device, width, height, stage, slots);
    try { await ring.init(); return ring; }
    catch (error) { ring.dispose(); throw error; }
  }

  constructor(device: GPUDevice, width: number, height: number, stage: 'pre'|'post', capacity: number) {
    Object.assign(this, {device, width, height, stage, capacity});
    this.bytes = width * height * 16;
    this.fields = fields.slice(0, stage === 'pre' ? 5 : 3);
    this.frames = new Map();
    this.timings = [];
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
    const d = this.device, count = this.capacity, post = this.stage === 'post';
    this.surface = this.texture('Temporal surface', count * this.fields.length);
    this.id = this.texture('Temporal IDs', count, 'rgba32uint');
    this.meta = this.buffer(count * 80);
    this.map = this.buffer(this.bytes);
    this.counts = this.buffer(80);
    this.total = this.buffer(this.bytes);
    this.output = this.buffer(this.bytes);
    this.params = this.buffer(32, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    this.overflow = this.buffer(post ? entryBytes : count * overflowBuckets * entryBytes);
    if (post) {
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
    } else {
      this.raw = this.texture('Raw radiance history', count);
      this.guides = this.texture('Raw guide history', count * 2);
      this.guideBuffers = Array.from({length: count}, () => ({albedo: this.buffer(this.bytes), normal: this.buffer(this.bytes)}));
      this.missed = this.buffer(4);
    }
    const uniform = {buffer:{type:'uniform'}}, storage = {buffer:{type:'storage'}}, read = {buffer:{type:'read-only-storage'}};
    const tex = {texture:{sampleType:'unfilterable-float',viewDimension:'2d-array'}};
    const target = {storageTexture:{access:'write-only',format:'rgba16float',viewDimension:'2d-array'}};
    const shaders: Record<string, [string, any[]]> = {
      reproject: [reproject, [uniform,tex,{texture:{sampleType:'uint',viewDimension:'2d-array'}},read,storage,storage]],
      accumulate: [accumulate, [uniform,tex,tex,read,storage,storage,storage]],
      snapshot: [snapshot, [uniform,read,target]],
      idSnapshot: [idSnapshot, [uniform,read,{storageTexture:{access:'write-only',format:'rgba32uint',viewDimension:'2d-array'}}]],
      ...(post ? {
        combine: [combine,[uniform,tex,tex,read,read,read,storage,storage,read]],
        match: [match,[uniform,tex,read,read,storage]],
        pyramid: [pyramid,[uniform,tex,target]],
        blur: [blur,[uniform,tex,target]]
      } : {rawSnapshot: [rawSnapshot,[uniform,read,target,storage,storage]]})
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
    const post = this.stage === 'post', pixels = this.width * this.height;
    const fields = post ? {
      surface: 24*pixels, id: 16*pixels, display: 8*pixels, blurred: 8*pixels,
      pyramid: this.pyramid.reduce((sum:number, tex:GPUTexture) => sum + tex.width * tex.height * 8, 0), camera: 80
    } : {
      surface: 40*pixels, id: 16*pixels, radiance: 8*pixels, guides: 16*pixels, camera: 80,
      radianceOverflow: overflowBuckets * entryBytes
    };
    const history = this.capacity * Object.values(fields).reduce((sum, bytes) => sum + bytes, 0);
    const total = [...this.resources.values()].reduce((sum, bytes) => sum + bytes, 0);
    return {slots:this.capacity, fields, history, scratch:total-history, total};
  }

  slot(frame:number) { return ((frame % this.capacity) + this.capacity) % this.capacity; }

  writeTexture(texture:GPUTexture, data:AllowSharedBufferSource, layer:number, bytesPerPixel:number) {
    this.device.queue.writeTexture({texture,origin:[0,0,layer]},data,
      {bytesPerRow:this.width*bytesPerPixel},[this.width,this.height,1]);
  }

  metadata(frame:number, meta:any) {
    const slot = this.slot(frame);
    this.device.queue.writeBuffer(this.meta,slot*80,new Float32Array([
      ...meta.viewProjection, this.height*meta.projection[5]*0.5, meta.apertureRadius, meta.focusDistance, 0
    ]));
    this.frames.set(slot, frame);
  }

  upload(frame:number, meta:any, arrays:any, exactHDR:number[] = []) {
    const slot = this.slot(frame);
    const exactHDRPixels = new Set(exactHDR);
    this.fields.forEach((name:string,index:number) => this.writeTexture(this.surface,
      new Float16Array(new Float32Array(arrays[name])),slot*this.fields.length+index,8));
    this.writeTexture(this.id, arrays.id, slot, 16);
    if (this.raw) {
      const source = new Float32Array(arrays.hdr), half = new Float16Array(source);
      const table = new ArrayBuffer(overflowBuckets * entryBytes);
      const keys = new Uint32Array(table), values = new Float32Array(table);
      for (let offset=0; offset<half.length; offset+=4) {
        const forceExact = exactHDRPixels.has(offset/4);
        if (!forceExact && Number.isFinite(half[offset]) && Number.isFinite(half[offset+1]) &&
            Number.isFinite(half[offset+2]) && Number.isFinite(half[offset+3])) continue;
        const key = offset/4+1;
        let bucket = Math.imul(key, 2654435761) & (overflowBuckets-1);
        for (let probe=0; keys[bucket*8]; probe++) {
          if (probe === overflowBuckets) throw Error('Temporal HDR overflow history is full.');
          bucket = (bucket+1) & (overflowBuckets-1);
        }
        keys[bucket*8] = key;
        values.set(source.subarray(offset,offset+4),bucket*8+4);
        half[offset+3] = -1;
      }
      this.device.queue.writeBuffer(this.overflow,slot*table.byteLength,table);
      this.writeTexture(this.raw, half, slot, 8);
      this.writeTexture(this.guides,new Float16Array(new Float32Array(arrays.albedo)),slot*2,8);
      this.writeTexture(this.guides,new Float16Array(new Float32Array(arrays.normal)),slot*2+1,8);
    }
    this.metadata(frame, meta);
  }

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
    for (let k=Math.min(i,j); k<=Math.max(i,j); k++) {
      if (this.frames.get(this.slot(k)) !== k) throw Error('Missing history '+k);
    }
    const post = this.stage === 'post';
    if (stats) this.device.queue.writeBuffer(this.counts,0,new Uint32Array(20));
    await this.dispatch('reproject',[this.params,this.surface,this.id,this.meta,output,this.counts],
      this.paramsFor(i,j,post?4:0,Number(stats)),post?'post-geometry':'reproject');
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

  async filter(i:number, neighbors:number[], stats = false, onPath?:any) {
    const post = this.stage === 'post', source = post ? this.display : this.raw;
    const label = post ? 'post' : 'pre';
    const init = [this.params,source,this.blurred??source,this.map,this.total,this.output,this.overflow];
    await this.dispatch('accumulate',init,this.paramsFor(i,i),label+'-init');
    const counts: Record<number, number[]> = {};
    for (const j of neighbors) {
      await this.mapping(i,j,stats);
      if (stats) counts[j-i] = Array.from(new Uint32Array(await this.read(this.counts,80)));
      if (post) {
        await this.mapping(j,i,false,this.reverseMap);
        await this.match(i,j,this.forward,this.map,this.forwardRefined);
        await this.match(j,i,this.backward,this.reverseMap,this.backwardRefined);
        await this.dispatch('combine',[this.params,this.display,this.blurred,this.map,this.forwardRefined,
          this.backwardRefined,this.total,this.paths,this.reverseMap],this.paramsFor(i,j,4),'combine');
        if (onPath) await onPath(j,new Uint32Array(await this.read(this.paths,this.bytes/4)));
      } else {
        await this.dispatch('accumulate',init,this.paramsFor(i,j,1),'accumulate');
      }
    }
    await this.dispatch('accumulate',init,this.paramsFor(i,i,2),label+'-resolve');
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

  async setDisplay(frame:number, rgba:any) {
    this.writeTexture(this.display, new Float16Array(rgba), this.slot(frame), 8);
    await this.prepareDisplay(frame);
  }

  async setDisplayBuffer(frame:number, buffer:GPUBuffer) {
    await this.dispatch('snapshot',[this.params,buffer,this.display],this.paramsFor(frame,frame,4),'display-snapshot');
    await this.prepareDisplay(frame);
  }

  async uploadBuffers(frame:number, meta:any, buffers:Record<string,GPUBuffer>) {
    const d = this.device, slot = this.slot(frame);
    const encoder = d.createCommandEncoder();
    encoder.clearBuffer(this.overflow,slot*overflowBuckets*entryBytes,overflowBuckets*entryBytes);
    encoder.clearBuffer(this.missed);
    encoder.copyBufferToBuffer(buffers.albedo,0,this.guideBuffers[slot].albedo,0,this.bytes);
    encoder.copyBufferToBuffer(buffers.normal,0,this.guideBuffers[slot].normal,0,this.bytes);
    d.queue.submit([encoder.finish()]);

    await this.dispatch('idSnapshot',[this.params,buffers.id,this.id],this.paramsFor(frame,frame),'capture-ids');

    await this.dispatch('rawSnapshot',[this.params,buffers.color,this.raw,this.overflow,this.missed],
      this.paramsFor(frame,frame),'capture-radiance');
    const images = [...this.fields.map((name:string,index:number) => [buffers[name],this.surface,slot*this.fields.length+index]),
      [buffers.albedo,this.guides,slot*2],[buffers.normal,this.guides,slot*2+1]];
    for (const [input,texture,layer] of images) {
      const params = this.paramsFor(frame,frame);
      params[2] = layer;
      await this.dispatch('snapshot',[this.params,input,texture],params,'capture-guides');
    }
    this.metadata(frame,meta);
  }

  getGuides(frame:number) {
    if(this.frames.get(this.slot(frame))!==frame) throw Error('Guide frame is missing: '+frame);
    return this.guideBuffers[this.slot(frame)];
  }

  copySurfaces(frame:number, post:TemporalGPU) {
    const d = this.device, a = this.slot(frame), b = post.slot(frame);
    const encoder = d.createCommandEncoder(), size = [this.width,this.height,1];
    for (let field=0; field<post.fields.length; field++) {
      encoder.copyTextureToTexture({texture:this.surface,origin:[0,0,a*this.fields.length+field]},
        {texture:post.surface,origin:[0,0,b*post.fields.length+field]},size);
    }
    encoder.copyTextureToTexture({texture:this.id,origin:[0,0,a]},{texture:post.id,origin:[0,0,b]},size);
    encoder.copyBufferToBuffer(this.meta,a*80,post.meta,b*80,80);
    d.queue.submit([encoder.finish()]);
    post.frames.set(b,frame);
  }

  // Readback used only by the former hand-off in the comparison harness.
  async readGuide(frame:number, normal:boolean) {
    const d = this.device, size = this.bytes/2;
    const staging = d.createBuffer({size,usage:GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ});
    try {
      const encoder = d.createCommandEncoder();
      encoder.copyTextureToBuffer({texture:this.guides,origin:[0,0,this.slot(frame)*2+Number(normal)]},
        {buffer:staging,bytesPerRow:this.width*8},[this.width,this.height,1]);
      d.queue.submit([encoder.finish()]);
      await staging.mapAsync(GPUMapMode.READ);
      return Float32Array.from(new Float16Array(staging.getMappedRange()));
    } finally { staging.destroy(); }
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
