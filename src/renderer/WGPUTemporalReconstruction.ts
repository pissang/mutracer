import type {TemporalHistoryGPU} from './WGPUTemporalHistory.js';
import {temporalMaterialWGSL} from './temporalKernels.js';

const reconstruct = /* wgsl */ `
struct Params { size: vec2u, slot: u32, guideSlot: u32 }
@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var<storage, read> support: array<f32>;
@group(0) @binding(2) var<storage, read> inputColor: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> color: array<vec4f>;
@group(0) @binding(4) var<storage, read_write> mask: array<f32>;
@group(0) @binding(5) var surfaces: texture_2d_array<f32>;
@group(0) @binding(6) var ids: texture_2d_array<u32>;
@group(0) @binding(7) var guides: texture_2d_array<f32>;
@group(0) @binding(8) var materials: texture_2d_array<u32>;
${temporalMaterialWGSL}
fn bottomIndex(at: vec2i) -> u32 {
  return (p.size.y - 1u - u32(at.y))*p.size.x + u32(at.x);
}
fn compatible(at: vec2i, id: vec4u, surface: vec4f, albedo: vec3f) -> bool {
  if (any(at<vec2i(0)) || any(at>=vec2i(p.size))) { return false; }
  if (any(textureLoad(ids,at,i32(p.slot),0)!=id)) { return false; }
  let other = textureLoad(surfaces,at,i32(2u*p.slot),0);
  if (dot(other.xyz,surface.xyz)<.985 || abs(other.w-surface.w)>.012*surface.w) { return false; }
  let guide = textureLoad(guides,at,i32(2u*p.guideSlot),0);
  return guide.a>=.999 && length(guide.rgb-albedo)<.035;
}
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) g: vec3u) {
  if (any(g.xy>=p.size)) { return; }
  let at = vec2i(g.xy);
  let dst = bottomIndex(at);
  let pixel = g.y*p.size.x+g.x;
  let center = inputColor[dst];
  color[dst] = center;
  // Composition consumes bottom-first packed HDR. OIDN and its output mask are top-first.
  mask[pixel] = 0.;
  let confidence = 1.-smoothstep(1.,2.5,support[pixel]);
  if (confidence<=0.) { return; }
  let surface = textureLoad(surfaces,at,i32(2u*p.slot),0);
  let material = unpackSurfaceMaterial(textureLoad(materials,at,i32(p.slot),0).x);
  let guide = textureLoad(guides,at,i32(2u*p.guideSlot),0);
  if (surface.w<=0. || guide.a<.999 || material.x<.35 || material.y>.10 || material.z>.15) { return; }
  let id = textureLoad(ids,at,i32(p.slot),0);
  // Keep silhouettes, thin geometry and sharp texture edges on the ordinary path.
  for (var j=-1; j<=1; j++) {
    for (var i=-1; i<=1; i++) {
      if (!compatible(at+vec2i(i,j),id,surface,guide.rgb)) { return; }
    }
  }
  var rgb = center.rgb;
  var sum = 1.;
  for (var j=-4; j<=4; j++) {
    for (var i=-4; i<=4; i++) {
      let d2 = i*i+j*j;
      if (d2==0 || d2>16) { continue; }
      let tap = at+vec2i(i,j);
      if (!compatible(tap,id,surface,guide.rgb) || !compatible(at+vec2i(i/2,j/2),id,surface,guide.rgb)) { continue; }
      let weight = exp(-f32(d2)/8.);
      rgb += weight*inputColor[bottomIndex(tap)].rgb;
      sum += weight;
    }
  }
  if (sum<4.) { return; }
  color[dst] = vec4f(mix(center.rgb,rgb/sum,.75),center.a);
  mask[pixel] = confidence;
}
`;

const selectOutput = /* wgsl */ `
struct Params { count: u32, encoded: u32 }
@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var<storage, read> alternate: array<vec4f>;
@group(0) @binding(2) var<storage, read> mask: array<f32>;
@group(0) @binding(3) var<storage, read_write> output: array<vec4f>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) g: vec3u) {
  let i = g.y*p.count+g.x;
  if (g.x>=p.count || i>=arrayLength(&mask) || mask[i]<=0.) { return; }
  var rgb = alternate[i].rgb;
  if (p.encoded!=0u) {
    let linear = max(rgb,vec3f(0));
    let srgb = select(1.055*pow(linear,vec3f(1./2.4))-.055,12.92*linear,linear<=vec3f(.0031308));
    rgb = clamp(srgb,vec3f(0),vec3f(1))*255.;
  }
  output[i] = vec4f(mix(output[i].rgb,rgb,.85*mask[i]),output[i].a);
}
`;

export class TemporalReconstructionGPU {
  private readonly params: GPUBuffer;

  private constructor(private readonly history: TemporalHistoryGPU,
    private readonly reconstruct: GPUComputePipeline, private readonly selectOutput: GPUComputePipeline) {
    this.params = history.device.createBuffer({label: 'Spatial reconstruction parameters', size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST});
  }

  static async create(history: TemporalHistoryGPU) {
    const d = history.device;
    const pipeline = (label: string, code: string) => d.createComputePipelineAsync({
      label, layout: 'auto', compute: {module: d.createShaderModule({label, code}), entryPoint: 'main'}
    });
    const [pre, select] = await Promise.all([
      pipeline('Low history spatial reconstruction', reconstruct),
      pipeline('Select low history output', selectOutput)
    ]);
    return new TemporalReconstructionGPU(history, pre, select);
  }

  rebuild(frame: number, support: GPUBuffer, inputColor: GPUBuffer) {
    const h = this.history;
    const usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST;
    const color = h.device.createBuffer({label: 'Reconstructed temporal HDR', size: h.bytes, usage});
    const mask = h.device.createBuffer({label: 'Spatial reconstruction mask', size: h.bytes / 4, usage});
    try {
      this.dispatch(this.reconstruct, [h.width, h.height, h.slot(frame), h.guideSlot(frame)],
        [support, inputColor, color, mask, h.surface, h.id, h.guides, h.material]);
      return {color, mask};
    } catch (error) {
      color.destroy(); mask.destroy();
      throw error;
    }
  }

  select(alternate: GPUBuffer, mask: GPUBuffer, output: GPUBuffer, encoded: boolean) {
    this.dispatch(this.selectOutput, [this.history.width, Number(encoded)], [alternate, mask, output]);
  }

  private dispatch(pipeline: GPUComputePipeline, params: number[], inputs: (GPUBuffer | GPUTexture)[]) {
    const {device, width, height} = this.history;
    device.queue.writeBuffer(this.params, 0, new Uint32Array(params));
    const group = device.createBindGroup({layout: pipeline.getBindGroupLayout(0),
      entries: [this.params, ...inputs].map((value, binding) => ({binding,
        resource: value instanceof GPUBuffer ? {buffer: value} : value.createView({dimension: '2d-array'})}))});
    const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass();
    pass.setPipeline(pipeline); pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8)); pass.end();
    device.queue.submit([encoder.finish()]);
  }

  dispose() { this.params.destroy(); }
}
