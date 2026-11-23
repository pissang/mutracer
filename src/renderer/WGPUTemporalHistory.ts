import {TemporalRevisionTable} from './temporalRevisionTable.js';
import {idSnapshot, snapshot, temporalFlagsWGSL, temporalOverflowWGSL, temporalOverflowBuckets, temporalOverflowEntryBytes} from './temporalKernels.js';

const captureWGSL = /* wgsl */ `
struct Params { size: vec2u, slot: u32, revisionCount: u32 }
@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var<storage, read> depth: array<vec4f>;
@group(0) @binding(2) var<storage, read> normal: array<vec4f>;
@group(0) @binding(3) var<storage, read> roughness: array<vec4f>;
@group(0) @binding(4) var<storage, read> albedo: array<vec4f>;
@group(0) @binding(5) var<storage, read> color: array<vec4f>;
@group(0) @binding(6) var<storage, read> motion: array<vec4f>;
@group(0) @binding(7) var surfaceOut: texture_storage_2d_array<rgba16float, write>;
@group(0) @binding(8) var hdrOut: texture_storage_2d_array<rgba16float, write>;
@group(0) @binding(9) var motionOut: texture_storage_2d_array<rgba32float, write>;
${temporalOverflowWGSL}
@group(0) @binding(10) var<storage, read_write> overflow: array<Overflow>;
${temporalFlagsWGSL}
fn nearestHalf(value:f32)->f32{
  let magnitude=abs(value);if(magnitude==0. || magnitude>65504.){return value;}
  let step=select(exp2(floor(log2(magnitude))-10.),exp2(-24.),magnitude<exp2(-14.));
  let scaled=magnitude/step;let lower=floor(scaled);let fraction=scaled-lower;
  let increment=select(0.,1.,fraction>.5 || (fraction==.5 && (u32(lower)&1u)==1u));
  return sign(value)*(lower+increment)*step;
}
fn nearestHalf4(value:vec4f)->vec4f{return vec4f(nearestHalf(value.x),nearestHalf(value.y),nearestHalf(value.z),nearestHalf(value.w));}
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) g: vec3u) {
  if (any(g.xy >= p.size)) { return; }
  let i = g.y * p.size.x + g.x;
  let at = vec2i(g.xy);
  let layer = i32(p.slot);
  let hit = depth[i].w > .5;
  let surface = vec4f(normal[i].xyz, depth[i].x);
  textureStore(surfaceOut, at, layer * 2, nearestHalf4(surface));
  textureStore(surfaceOut, at, layer * 2 + 1, surface);

  let r = roughness[i];
  let capped = !(abs(r.x) <= 3.402823e38) || (r.x < .25 && r.y > .10);
  let peak = max(albedo[i].x, max(albedo[i].y, albedo[i].z));
  let guide = u32(floor(255. * sqrt(clamp(peak, 0., 1.)) + .5));
  let coverage = u32(floor(255. * clamp(r.w, 0., 1.) + .5));
  let m = motion[i];
  var flags = u32(m.w) | (guide << 10u) | (coverage << 2u) |
    select(0u, CENTER_HIT, hit) | select(0u, SURFACE_CAPPED, capped);

  let rgba = color[i];
  let stored = vec4f(nearestHalf4(vec4f(clamp(rgba.rgb, vec3f(-65504), vec3f(65504)), 0.)).rgb, rgba.a);
  if (any(!(abs(rgba) <= vec4f(65504)))) {
    flags |= HDR_MISSING;
    let key = i + 1u;
    for (var probe = 0u; probe < OVERFLOW_BUCKETS; probe++) {
      let address = bucket(key, probe, p.slot);
      loop {
        let claim = atomicCompareExchangeWeak(&overflow[address].index, 0u, key);
        if (claim.exchanged) {
          overflow[address].color = vec4f(rgba.rgb, select(nearestHalf(rgba.a), rgba.a, abs(rgba.a) > 65504.));
          flags = (flags & ~HDR_MISSING) | HDR_OVERFLOW;
          break;
        }
        if (claim.old_value != 0u) { break; }
      }
      if ((flags & HDR_OVERFLOW) != 0u) { break; }
    }
  }
  textureStore(hdrOut, at, layer, stored);
  // All packed flags fit in the exactly representable integer range of float32.
  textureStore(motionOut, at, layer, vec4f(m.xyz, f32(flags)));
}
`;

interface CaptureMetadata {
  viewProjection: ArrayLike<number>;
  projection: ArrayLike<number>;
  apertureRadius: number;
  focusDistance: number;
}

export class TemporalHistoryGPU {
  readonly bytes: number;
  readonly frames = new Map<number, number>();
  private readonly resources = new Map<GPUBuffer | GPUTexture, number>();
  private readonly guideFrames = new Map<number, number>();
  private revisions!: TemporalRevisionTable;
  private capturePipeline!: GPUComputePipeline;
  private guidePipeline!: GPUComputePipeline;
  private idPipeline!: GPUComputePipeline;
  private params!: GPUBuffer;
  surface!: GPUTexture;
  motion!: GPUTexture;
  id!: GPUTexture;
  raw!: GPUTexture;
  guides!: GPUTexture;
  meta!: GPUBuffer;
  overflow!: GPUBuffer;
  private customGuides?: {albedo: GPUBuffer; normal: GPUBuffer}[];

  static async create(device: GPUDevice, width: number, height: number, capacity: number,
    guideCapacity: number, custom: boolean) {
    const history = new TemporalHistoryGPU(device, width, height, capacity, guideCapacity);
    try { await history.init(custom); return history; }
    catch (error) { history.dispose(); throw error; }
  }

  private constructor(readonly device: GPUDevice, readonly width: number, readonly height: number,
    readonly capacity: number, readonly guideCapacity: number) {
    this.bytes = width * height * 16;
  }

  private texture(label: string, layers: number, format: GPUTextureFormat = 'rgba16float') {
    const texture = this.device.createTexture({label, size: [this.width, this.height, layers], format,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC});
    this.resources.set(texture, this.width * this.height * layers * (format === 'rgba16float' ? 8 : 16));
    return texture;
  }

  private buffer(label: string, size: number,
    usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC) {
    const buffer = this.device.createBuffer({label, size, usage});
    this.resources.set(buffer, size);
    return buffer;
  }

  private async init(custom: boolean) {
    const d = this.device;
    this.surface = this.texture('Temporal surface history', this.capacity * 2);
    this.motion = this.texture('Temporal motion and surface flags', this.capacity, 'rgba32float');
    this.id = this.texture('Temporal IDs and material revisions', this.capacity, 'rgba32uint');
    this.raw = this.texture('Temporal HDR history', this.capacity);
    this.guides = this.texture('Temporal spatial guides', this.guideCapacity * 2);
    this.meta = this.buffer('Temporal cameras', this.capacity * 80);
    this.overflow = this.buffer('Temporal HDR overflow', this.capacity * temporalOverflowBuckets * temporalOverflowEntryBytes);
    this.params = this.buffer('Temporal capture parameters', 32, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    this.revisions = new TemporalRevisionTable(d, 'Temporal material revision table');
    if (custom) {
      this.customGuides = Array.from({length: this.guideCapacity}, () => ({
        albedo: this.buffer('Temporal custom albedo guide', this.bytes),
        normal: this.buffer('Temporal custom normal guide', this.bytes),
      }));
    }
    const createPipeline = async (label: string, code: string) => {
      const module = d.createShaderModule({label, code});
      return d.createComputePipelineAsync({label, layout: 'auto', compute: {module, entryPoint: 'main'}});
    };
    this.capturePipeline = await createPipeline('Temporal history capture', captureWGSL);
    this.guidePipeline = await createPipeline('Temporal guide capture', snapshot);
    this.idPipeline = await createPipeline('Temporal ID capture', idSnapshot);
  }

  slot(frame: number) { return frame % this.capacity; }
  guideSlot(frame: number) { return frame % this.guideCapacity; }

  async capture(frame: number, meta: CaptureMetadata, buffers: Record<string, GPUBuffer>,
    revisionEntries: readonly (readonly [number, number])[] = []) {
    const d = this.device;
    const slot = this.slot(frame), guideSlot = this.guideSlot(frame);
    const encoder = d.createCommandEncoder({label: 'Clear temporal overflow and copy custom guides'});
    const overflowBytes = temporalOverflowBuckets * temporalOverflowEntryBytes;
    encoder.clearBuffer(this.overflow, slot * overflowBytes, overflowBytes);
    const custom = this.customGuides?.[guideSlot];
    if (custom) {
      encoder.copyBufferToBuffer(buffers.albedo, 0, custom.albedo, 0, this.bytes);
      encoder.copyBufferToBuffer(buffers.normal, 0, custom.normal, 0, this.bytes);
    }
    d.queue.submit([encoder.finish()]);

    this.dispatch(this.capturePipeline, [slot, 0],
      [buffers.centerDepth, buffers.centerNormal, buffers.roughness, buffers.albedo, buffers.color,
        buffers.motion, this.surface, this.raw, this.motion, this.overflow]);
    const revisionTable = await this.revisions.write(revisionEntries);
    this.dispatch(this.idPipeline, [slot, 0, 0, 0, 0, revisionEntries.length], [buffers.id, revisionTable, this.id]);
    this.dispatch(this.guidePipeline, [guideSlot * 2, 0, 0, 0], [buffers.albedo, this.guides]);
    this.dispatch(this.guidePipeline, [guideSlot * 2 + 1, 0, 0, 0], [buffers.normal, this.guides]);
    d.queue.writeBuffer(this.meta, slot * 80, new Float32Array([
      ...Array.from(meta.viewProjection), this.height * meta.projection[5] * 0.5, meta.apertureRadius, meta.focusDistance, 0,
    ]));
    this.frames.set(slot, frame);
    this.guideFrames.set(guideSlot, frame);
  }

  getCustomGuides(frame: number) {
    const slot = this.guideSlot(frame);
    if (!this.customGuides || this.guideFrames.get(slot) !== frame) throw new Error('Missing custom guides for frame ' + frame);
    return this.customGuides[slot];
  }

  private dispatch(pipeline: GPUComputePipeline, params: number[], resources: (GPUBuffer | GPUTexture)[]) {
    const d = this.device;
    d.queue.writeBuffer(this.params, 0, new Uint32Array([this.width, this.height, ...params]));
    const group = d.createBindGroup({layout: pipeline.getBindGroupLayout(0), entries: [this.params, ...resources]
      .map((value, binding) => ({binding, resource: value instanceof GPUBuffer ? {buffer: value} : value.createView({dimension: '2d-array'})}))});
    const encoder = d.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(Math.ceil(this.width / 8), Math.ceil(this.height / 8));
    pass.end();
    d.queue.submit([encoder.finish()]);
  }

  memory() {
    return {total: [...this.resources.values()].reduce((sum, bytes) => sum + bytes, 0) + this.revisions.buffer.size};
  }

  dispose() {
    this.revisions?.dispose();
    for (const resource of this.resources.keys()) resource.destroy();
    this.resources.clear();
  }
}
