import {hdrResolveWGSL} from './wgsl/compose.frag.wgsl.js';
import { getTargetShaderCache } from './WGPUShaderCache.js';
import { textureBytes } from './gpuMemory.js';
import shadowCatcherAccumulationWGSL from './wgsl/chunks/shadowCatcherAccumulation.wgsl.js';
import { fullScreenQuadVertexShaderWGSL } from './WGPUFullQuadPass.js';

export function createNormalizeRayTraceOutputWGSL(layers = false, catcher = true, caustics = false) {
  return /* wgsl */ `
${hdrResolveWGSL}
@group(0) @binding(0) var<storage, read> colorBuffer: array<vec4f>;
@group(0) @binding(1) var<storage, read> normalBuffer: array<vec4f>;
@group(0) @binding(2) var<storage, read> albedoBuffer: array<vec4f>;
${shadowCatcherAccumulationWGSL}
@group(0) @binding(3) var<storage, read> shadowCatcherBuffer: array<ShadowCatcherAccumulation>;

${caustics ? /* wgsl */ `@group(0) @binding(4) var<storage, read> causticBuffer: array<vec4f>;
` : ''}@group(1) @binding(0) var<uniform> sampleCount: f32;
@group(1) @binding(1) var<uniform> sampleTileGrid: vec2u;

override outputWidth: f32;
override outputHeight: f32;

struct FSOutput {
  ${layers ? `@location(0) foreground: vec4f,
  @location(1) catcherBackground: vec4f` : `@location(0) color: vec4f,
  @location(1) normal: vec4f,
  @location(2) albedo: vec4f${catcher ? ',\n  @location(3) shadowCatcher: vec4f' : ''}`}
}
@fragment
fn main(@builtin(position) coord: vec4f) -> FSOutput {
  let size = vec2u(u32(outputWidth), u32(outputHeight));
  let pixel = vec2u(u32(coord.x), size.y - u32(coord.y) - 1u);
  var idx = pixel.x + pixel.y * size.x;
  // Tiles are interleaved pixel grids, not contiguous rectangles. The first
  // tile samples (0, 0) of every grid cell across the current camera image.
  // Reconstruct only pixels not yet sampled, until the first sweep completes;
  // never write these display estimates back into the accumulated ray buffers.
  if (sampleCount < 1.0 && normalBuffer[idx].a <= 0.0) {
    let grid = max(sampleTileGrid, vec2u(1u));
    let nearest = min(
      ((pixel + grid / 2u) / grid) * grid,
      ((size - vec2u(1u)) / grid) * grid
    );
    let nearestIdx = nearest.x + nearest.y * size.x;
    if (normalBuffer[nearestIdx].a > 0.0) {
      idx = nearestIdx;
    }
  }
  var output: FSOutput;
  if (normalBuffer[idx].a <= 0.0) {
    ${layers ? `output.foreground = vec4f(0.0);
    output.catcherBackground = vec4f(0.0);` : `output.color = vec4f(0.0);
    output.normal = vec4f(0.0);
    output.albedo = vec4f(0.0);
    ${catcher ? 'output.shadowCatcher = vec4f(0.0);' : ''}`}
    return output;
  }
  let color = colorBuffer[idx];
  let normal = normalBuffer[idx];
  let albedo = albedoBuffer[idx];
  let hit = albedo.a;
  // The CPU count covers completed sweeps and is still zero during the first
  // interleaved sample. Use the actual per-pixel count, including for misses.
  // Empty pixels must remain finite: NaN alpha can poison float HDR output
  // even when its canvas uses opaque compositing.
  let total = max(normal.a, 1.0);
  ${layers ? `
  let shadow = shadowCatcherBuffer[idx];
  let foregroundHit = max(hit - shadow.mask.b, 0.0);
  // Separated background includes flat primary misses as well as catcher
  // samples. Neither belongs in the hit-normalized geometry color/alpha.
  output.foreground = vec4f(
    (color.rgb - shadow.background.rgb)
      / select(total, foregroundHit, foregroundHit > 0.0),
    clamp((color.a - shadow.mask.g) / total, 0.0, 1.0)
  );
  output.catcherBackground = shadow.background / total;
  ` : `output.color = vec4f(
    // average the color by hit count.
    // So the antialised edge color will be correct when having transparent background
    vec3f(hdr_resolve_component(color.r,normal.a,hit,1.0,true),
      hdr_resolve_component(color.g,normal.a,hit,1.0,true),
      hdr_resolve_component(color.b,normal.a,hit,1.0,true)),
    hdr_resolve_component(color.a,normal.a,hit,1.0,false)
  );

  output.normal = vec4f(0.0);
  // Normalize to 0 - 1
  if (dot(normal.rgb, normal.rgb) > 0.1) {
    output.normal = vec4f(normal.rgb / total * 0.5 + 0.5, 1.0);
  }
  output.albedo = vec4f(albedo.rgb / total, clamp(hit / total, 0.0, 1.0));
  ${catcher ? `let shadow = shadowCatcherBuffer[idx];
  // Opacity is the ratio of the summed occluded and total light sample
  // counts; a per-sample ratio average would keep its low-sample bias. Alpha
  // carries it scaled by coverage, as composition expects.
  output.shadowCatcher = vec4f(shadow.mask.rgb / total,
    shadow.mask.r / total * select(0.0, shadow.moments.z / shadow.moments.w, shadow.moments.w > 0.0));` : ''}
  `}
${caustics ? /* wgsl */ `  let causticColor=causticBuffer[idx].rgb/max(causticBuffer[idx].a,1.0);
  ${layers ? 'output.foreground = vec4f(output.foreground.rgb+causticColor,output.foreground.a);' : 'output.color = vec4f(output.color.rgb+causticColor,output.color.a);'}
` : ''}  return output;
}
`;
}

type RayTraceOutput = 'color' | 'normal' | 'albedo' | 'shadowCatcher'
  | 'foreground' | 'catcherBackground';
type RayTraceBuffers = {
  color: GPUBuffer;
  caustic?: GPUBuffer;
  wideHdr?:boolean;
  normal: GPUBuffer;
  albedo: GPUBuffer;
  shadowCatcher: GPUBuffer;
  shadowCatcherOffset?: number;
};

export class WGPURayTraceOutputPass {
  private _device: GPUDevice;

  private _pipeline!: GPURenderPipeline;
  private _layersPipeline!: GPURenderPipeline;
  private _foregroundTexture!: GPUTexture;
  private _catcherBackgroundTexture!: GPUTexture;
  private _colorTexture!: GPUTexture;
  private _normalTexture!: GPUTexture;
  private _albedoTexture!: GPUTexture;
  private _shadowCatcherTexture!: GPUTexture;
  private _uniformBindGroup!: GPUBindGroup;

  private _uniformsBuffers;

  private _width = 1;
  private _height = 1;

  private _hasCatcher = false;
  private _hasCaustics = false;
  private _hasWideHdr=false;
  private _maskPipeline?:GPURenderPipeline;
  private _wideColor?:GPUTexture;
  private _wideForeground?:GPUTexture;
  private _causticPipeline?:GPURenderPipeline;
  private _needsUpdatePipeline = true;

  constructor(device: GPUDevice, private readonly zeroTexture?: GPUTexture) {
    this._device = device;
    this._uniformsBuffers = {
      sampleCount: device.createBuffer({
        size: 4,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
      }),
      sampleTileGrid: device.createBuffer({
        size: 8,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
      })
    };
  }

  private readonly _retainedOutputs = new Set<GPUTexture>();
  retainOutput(texture: GPUTexture) {
    const owned = ['color', 'normal', 'albedo', 'shadowCatcher', 'foreground', 'catcherBackground'] as const;
    if (owned.some(label => this.getOutput(label) === texture)) this._retainedOutputs.add(texture);
  }
  releaseOutput(texture: GPUTexture) {
    if (!this._retainedOutputs.delete(texture)) return;
    const owned = ['color', 'normal', 'albedo', 'shadowCatcher', 'foreground', 'catcherBackground'] as const;
    if (!owned.some(label => this.getOutput(label) === texture)) {
      void this._device.queue.onSubmittedWorkDone().catch(() => undefined).then(() => texture.destroy());
    }
  }

  getOutput(label: RayTraceOutput): GPUTexture {

    if(this._hasCaustics&&label==='color'&&this._wideColor)return this._wideColor;
    if(this._hasCaustics&&label==='foreground'&&this._wideForeground)return this._wideForeground;
    return this[`_${label}Texture`] ?? this.zeroTexture!;
  }

  private _createTextures() {
    const { _device: device, _width: width, _height: height } = this;
    const textureDescriptor: GPUTextureDescriptor = {
      size: {
        width,
        height,
        depthOrArrayLayers: 1
      },
      format: 'rgba8unorm',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC
    };
    this._destroyTextures();
    this._colorTexture = device.createTexture({
      ...textureDescriptor,
      label: 'Ray Trace Color',
      format: this._hasWideHdr?'rgba32float':'rgba16float',
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC
    });
    this._normalTexture = device.createTexture({
      ...textureDescriptor,
      label: 'Ray Trace Normal',
      usage: textureDescriptor.usage | GPUTextureUsage.COPY_SRC
    });
    this._albedoTexture = device.createTexture({
      ...textureDescriptor,
      label: 'Ray Trace Albedo'
    });
    this._wideColor=this._wideForeground=undefined;
    if(this._hasCaustics){
      this._wideColor=device.createTexture({...textureDescriptor,label:'Caustic HDR color',format:'rgba32float'});
      if(this._hasCatcher)this._wideForeground=device.createTexture({...textureDescriptor,label:'Caustic HDR foreground',format:'rgba32float'});
    }
    if (this._hasCatcher) {
    this._foregroundTexture = device.createTexture({
      ...textureDescriptor,
      label: 'Ray Trace Foreground',
      format: this._hasWideHdr?'rgba32float':'rgba16float'
    });
    this._catcherBackgroundTexture = device.createTexture({
      ...textureDescriptor,
      label: 'Ray Trace Catcher Background',
      format: 'rgba16float'
    });
    this._shadowCatcherTexture = device.createTexture({
      ...textureDescriptor,
      label: 'Ray Trace Shadow Catcher',
      format: 'rgba16float'
    });
    } else {
      this._foregroundTexture = this._catcherBackgroundTexture = this._shadowCatcherTexture = undefined!;
    }
  }

  private _updateBindGroups() {
    const device = this._device;
    this._uniformBindGroup = device.createBindGroup({
      layout: this._pipeline.getBindGroupLayout(1),
      entries: [
        {
          binding: 0,
          resource: {
            buffer: this._uniformsBuffers.sampleCount
          }
        },
        {
          binding: 1,
          resource: {
            buffer: this._uniformsBuffers.sampleTileGrid
          }
        }
      ]
    });
  }

  private _updatePipeline() {
    if (!this._needsUpdatePipeline) {
      return;
    }
    this._needsUpdatePipeline = false;
    const device = this._device;

    this._pipeline = getTargetShaderCache(device).createRenderPipeline({
      label: 'rayTraceOutput',
      layout: 'auto',
      vertex: {
        module: getTargetShaderCache(device).createShaderModule({
          code: fullScreenQuadVertexShaderWGSL
        }),
        entryPoint: 'main'
      },
      fragment: {
        module: getTargetShaderCache(device).createShaderModule({
          code: createNormalizeRayTraceOutputWGSL(false, this._hasCatcher&&!this._hasWideHdr, false)
        }),
        entryPoint: 'main',
        targets: [
          {
            format: this._hasWideHdr?'rgba32float':'rgba16float'
          },
          {
            format: 'rgba8unorm'
          },
          {
            format: 'rgba8unorm'
          },
          ...(this._hasCatcher&&!this._hasWideHdr ? [{format: 'rgba16float' as const}] : [])
        ],
        constants: {
          outputWidth: this._width,
          outputHeight: this._height
        }
      }
    });

    if (this._hasCatcher) this._layersPipeline = getTargetShaderCache(device).createRenderPipeline({
      label: 'rayTraceLayers',
      layout: 'auto',
      vertex: {
        module: getTargetShaderCache(device).createShaderModule({ code: fullScreenQuadVertexShaderWGSL }),
        entryPoint: 'main'
      },
      fragment: {
        module: getTargetShaderCache(device).createShaderModule({ code: createNormalizeRayTraceOutputWGSL(true, true, false) }),
        entryPoint: 'main',
        targets: [{ format: this._hasWideHdr?'rgba32float':'rgba16float' }, { format: 'rgba16float' }],
        constants: { outputWidth: this._width, outputHeight: this._height }
      }
    });
    this._updateBindGroups();
  }

  setSize(width: number, height: number) {
    if (
      this._width !== width ||
      this._height !== height ||
      !this._colorTexture
    ) {
      this._width = width;
      this._height = height;this._maskPipeline=undefined;
      this._createTextures();
      this._needsUpdatePipeline = true;
    }
  }

  setSampleCount(sampleCount: number) {
    this._device.queue.writeBuffer(
      this._uniformsBuffers.sampleCount,
      0,
      new Float32Array([sampleCount])
    );
  }

  setSampleTileGrid(columns: number, rows: number) {
    this._device.queue.writeBuffer(
      this._uniformsBuffers.sampleTileGrid,
      0,
      new Uint32Array([columns, rows])
    );
  }

  createPass(
    encoder: GPUCommandEncoder,
    inputBuffers: RayTraceBuffers,
    separateCatcher = false
  ) {
    if(this._hasWideHdr!==!!inputBuffers.wideHdr){this._hasWideHdr=!!inputBuffers.wideHdr;this._createTextures();this._needsUpdatePipeline=true;}
    if (this._hasCaustics !== !!inputBuffers.caustic) {
      this._hasCaustics=!!inputBuffers.caustic;this._createTextures();this._needsUpdatePipeline=true;
    }
    if (this._hasCatcher !== separateCatcher) {
      this._hasCatcher = separateCatcher; this._createTextures(); this._needsUpdatePipeline = true;
    }
    this._updatePipeline();
    this._createOutputPass(encoder, inputBuffers, false);
    if (separateCatcher) this._createOutputPass(encoder, inputBuffers, true);
    if(this._hasWideHdr&&separateCatcher)this._resolveMask(encoder,inputBuffers);
    if(inputBuffers.caustic){
      this._addCaustics(encoder,this._colorTexture,this._wideColor!,inputBuffers.caustic);
      if(separateCatcher)this._addCaustics(encoder,this._foregroundTexture,this._wideForeground!,inputBuffers.caustic);
    }
  }

  private _createOutputPass(
    encoder: GPUCommandEncoder,
    inputBuffers: RayTraceBuffers,
    layers: boolean
  ) {
    const pipeline = layers ? this._layersPipeline : this._pipeline;
    const textures = layers
      ? [this._foregroundTexture, this._catcherBackgroundTexture]
      : [this._colorTexture, this._normalTexture, this._albedoTexture, ...(this._hasCatcher&&!this._hasWideHdr ? [this._shadowCatcherTexture] : [])];
    const pass = encoder.beginRenderPass({
      colorAttachments: textures.map((texture) => ({
        view: texture.createView(),
        loadValue: { r: 0, g: 0, b: 0, a: 0 },
        storeOp: 'store',
        loadOp: 'clear'
      }))
    });
    pass.setPipeline(pipeline);

    pass.setBindGroup(
      0,
      this._device.createBindGroup({
        label: 'rayTraceOutput',
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          inputBuffers.color,
          inputBuffers.normal,
          inputBuffers.albedo,
          inputBuffers.shadowCatcher
        ].map((buffer, idx) => ({
          binding: idx,
          resource: {
            buffer,
            ...(idx === 3 ? { offset: inputBuffers.shadowCatcherOffset ?? 0 } : {})
          }
        })).filter(entry => entry.binding < 3 || (this._hasCatcher&&!this._hasWideHdr) || layers).concat(
          []
        )
      })
    );
    pass.setBindGroup(1, layers ? this._device.createBindGroup({
      layout: pipeline.getBindGroupLayout(1),
      entries: Object.values(this._uniformsBuffers).map((buffer, binding) => ({
        binding, resource: { buffer }
      }))
    }) : this._uniformBindGroup);

    pass.draw(6, 1, 0, 0);
    pass.end();

  }

  private _resolveMask(encoder:GPUCommandEncoder,input:RayTraceBuffers){
    const device=this._device;
    this._maskPipeline??=device.createRenderPipeline({label:'Wide HDR catcher mask',layout:'auto',
      vertex:{module:device.createShaderModule({code:fullScreenQuadVertexShaderWGSL}),entryPoint:'main'},
      fragment:{module:device.createShaderModule({code:shadowMaskResolveWGSL}),entryPoint:'main',constants:{IMAGE_WIDTH:this._width,IMAGE_HEIGHT:this._height},targets:[{format:'rgba16float'}]}});
    const pass=encoder.beginRenderPass({label:'Wide HDR catcher mask',colorAttachments:[{view:this._shadowCatcherTexture.createView(),loadOp:'clear',storeOp:'store'}]});
    pass.setPipeline(this._maskPipeline);pass.setBindGroup(0,device.createBindGroup({layout:this._maskPipeline.getBindGroupLayout(0),entries:[
      {binding:0,resource:{buffer:input.normal}},{binding:1,resource:{buffer:input.shadowCatcher}},
      {binding:2,resource:{buffer:this._uniformsBuffers.sampleTileGrid}},{binding:3,resource:{buffer:this._uniformsBuffers.sampleCount}}]}));
    pass.draw(6);pass.end();
  }

  private _addCaustics(encoder:GPUCommandEncoder,base:GPUTexture,target:GPUTexture,caustics:GPUBuffer){
    const device=this._device;
    this._causticPipeline??=device.createRenderPipeline({label:'Caustic HDR resolve',layout:'auto',
      vertex:{module:device.createShaderModule({code:fullScreenQuadVertexShaderWGSL}),entryPoint:'main'},
      fragment:{module:device.createShaderModule({code:causticCompositeWGSL}),entryPoint:'main',targets:[{format:'rgba32float'}]}});
    const pass=encoder.beginRenderPass({label:'Caustic HDR resolve',colorAttachments:[{view:target.createView(),loadOp:'clear',storeOp:'store'}]});
    pass.setPipeline(this._causticPipeline);pass.setBindGroup(0,device.createBindGroup({layout:this._causticPipeline.getBindGroupLayout(0),entries:[{binding:0,resource:base.createView()},{binding:1,resource:{buffer:caustics}}]}));
    pass.draw(6);pass.end();
  }

  private _destroyTextures() {
    if (!this._colorTexture) return;

    // These textures are also OIDN inputs. A resolution or preview-mode
    // change can replace them immediately after a denoising command buffer
    // was submitted. Keep the old resources alive until all work submitted so
    // far has completed; destroying them synchronously can make Dawn validate
    // the pending submit against an already-destroyed texture.
    const textures = [
      this._wideColor,this._wideForeground,
      this._colorTexture,
      this._normalTexture,
      this._albedoTexture,
      this._shadowCatcherTexture,
      this._foregroundTexture,
      this._catcherBackgroundTexture
    ].filter((texture): texture is GPUTexture => !!texture && !this._retainedOutputs.has(texture));
    void this._device.queue
      .onSubmittedWorkDone()
      .catch(() => undefined)
      .then(() => textures.forEach((texture) => texture.destroy()));
  }

  getMemoryBytes() {
    const textures = ['color', 'normal', 'albedo', 'shadowCatcher', 'foreground', 'catcherBackground'] as const;
    return Object.values(this._uniformsBuffers).reduce((sum, buffer) => sum + buffer.size, 0)
      + Array.from(new Set([...textures.map(label => this[`_${label}Texture`]), ...this._retainedOutputs]))
        .reduce((sum, texture) => sum + textureBytes(texture), 0);
  }

  dispose() {
    const retained = Array.from(this._retainedOutputs);
    void this._device.queue.onSubmittedWorkDone().catch(() => undefined).then(() => retained.forEach(texture => texture.destroy()));
    this._destroyTextures();
    this._retainedOutputs.clear();
    Object.keys(this._uniformsBuffers).forEach((key) => {
      (this._uniformsBuffers as any)[key].destroy();
    });
  }
}

// A separate color attachment preserves float32 caustics within the baseline
// 32-byte MRT budget, including when the catcher needs its fourth attachment.
export const causticCompositeWGSL=/* wgsl */ `
@group(0)@binding(0)var base:texture_2d<f32>;
@group(0)@binding(1)var<storage,read>caustics:array<vec4f>;
@fragment fn main(@builtin(position)position:vec4f)->@location(0)vec4f{
 let pixel=vec2u(position.xy);let size=textureDimensions(base);
 let c=textureLoad(base,vec2i(pixel),0);let photon=caustics[pixel.x+(size.y-pixel.y-1u)*size.x];
 return vec4f(c.rgb+photon.rgb/max(photon.a,1.0),c.a);
}
`;

export const shadowMaskResolveWGSL=/* wgsl */ `
${shadowCatcherAccumulationWGSL}
override IMAGE_WIDTH:u32;override IMAGE_HEIGHT:u32;
@group(0)@binding(0)var<storage,read>normal:array<vec4f>;
@group(0)@binding(1)var<storage,read>shadow:array<ShadowCatcherAccumulation>;
@group(0)@binding(2)var<uniform>grid:vec2u;
@group(0)@binding(3)var<uniform>samples:f32;
@fragment fn main(@builtin(position)position:vec4f)->@location(0)vec4f{
 // Image dimensions are supplied by the actual attachment through a uniform.
 let size=vec2u(IMAGE_WIDTH,IMAGE_HEIGHT);
 let pixel=vec2u(u32(position.x),size.y-u32(position.y)-1u);var index=pixel.x+pixel.y*size.x;
 if(samples<1.0&&normal[index].a<=0.0){
  let tile=max(grid,vec2u(1u));let nearest=min(((pixel+tile/2u)/tile)*tile,((size-vec2u(1u))/tile)*tile);
  let candidate=nearest.x+nearest.y*size.x;if(normal[candidate].a>0.0){index=candidate;}
 }
 if(normal[index].a<=0.0){return vec4f(0.0);}
 let s=shadow[index];let total=max(normal[index].a,1.0);
 return vec4f(s.mask.rgb/total,s.mask.r/total*select(0.0,s.moments.z/s.moments.w,s.moments.w>0.0));
}
`;
