import type {DisplayParityAccumulation, DisplayParityTarget} from './displayParityDiagnostics.js';
import {hdrResolveWGSL} from './wgsl/compose.frag.wgsl.js';
import {oidnAuxiliaryDefine} from './wgsl/oidnAuxiliary.wgsl.js';
import {displayAovKind, DEFAULT_AOV_DISPLAY, type AovDisplayOptions} from './aovDisplay.js';
import {WGPUAov} from './WGPUAov.js';
import {aovMask} from './aov.js';
import {scheduleFrame} from '../util/frame.js';
import {DisplayPostProcess} from './DisplayPostProcess.js';
import {customDenoiseLayersMain, customDenoiseCoverageMain} from './wgsl/customDenoise.wgsl.js';
import { WGPUCanvasSurface } from './WGPUCanvasSurface.js';
import { WGPUScratchBuffer } from './WGPUScratchBuffer.js';
import { WGPUScratchTexture } from './WGPUScratchTexture.js';
import { ScratchPool } from './ScratchPool.js';
import { GPUTraceQueue } from './GPUTraceQueue.js';
import { makeRenderPipeline, type TraceSettings, type RenderPipeline } from './renderPipeline.js';
import { textureBytes } from './gpuMemory.js';
import type { TargetPipeline } from './accumulationTarget.js';
// Portions adapted from ray-tracing-renderer@0.10.15
// (https://github.com/hoverinc/ray-tracing-renderer).
// Copyright (c) 2019 HOVER, MIT license; see LICENSES/RayTracingRenderer-MIT.txt.

import type { SceneBackground } from '../scene/Scene.js';
import Camera from '../scene/Camera.js';

import { WGPUFullQuadPass } from './WGPUFullQuadPass.js';
import WGPURayTracePass from './WGPURayTracePass.js';
import type {MaterialTextureSelection} from './wgpuBindless.js';
import {
  composeMain,
  composeDefine,
  compositeDenoiseOutputMain,
  compositeDenoiseDisplayMain,
  linearToSrgbDefine
} from './wgsl/compose.frag.wgsl.js';
import halton from './halton.js';
import { makeTileRender, makeTileRenderWithPredict } from './TileRender.js';
import type { ToneMappingParams } from './RenderingPipeline.js';
import type { DisplayChannel } from './RenderingPipeline.js';
import type { ColorRGB } from '../types.js';
import { WGPURayTraceOutputPass } from './WGPURayTraceOutput.js';
import { vec3 } from '../math.js';

import WGPUBloomPass from './WGPUBloomPass.js';
import { WGPUComputePass } from './WGPUComputePass.js';
import WGPUHDRPeakMeter from './WGPUHDRPeakMeter.js';
import { type JNLMDenoiser } from './jnlm.js';
import type { DenoiserHandle, OIDNWeb, OIDNWebGPUData, OIDNWebGPUOutputData } from './denoiser.js';
import { WGPUJNLMDenoisePass } from './WGPUJNLMDenoiser.js';

export const oidnAlbedoSrgbEncodeMain = /* wgsl */ `
if (globalId.x >= u32(imageSize.x) || globalId.y >= u32(imageSize.y)) { return; }
let index = globalId.x + globalId.y * u32(imageSize.x);
let raw = textureLoad(in_albedo, vec2u(globalId.xy), 0);
let encoded = oidnEncodeAlbedo(raw.rgb);
out_albedo[index] = vec4f(encoded, raw.a);
`;

export const oidnAlbedoSrgbDecodeMain = /* wgsl */ `
if (globalId.x >= u32(imageSize.x) || globalId.y >= u32(imageSize.y)) { return; }
let index = globalId.x + globalId.y * u32(imageSize.x);
let filtered = in_albedo[index];
let linear = oidnDecodeAlbedo(filtered.rgb);
var result = linear;
let surfaceCoverage = textureLoad(in_rawAlbedo, vec2i(globalId.xy), 0).a;
if (preserveSurfaceTexture != 0u) {
  // Primary albedo retains the accumulated surface texture. Do not ask the
  // auxiliary network to reconstruct its high-frequency texture.
  // Retain its filtered result across normal/coverage discontinuities.
  let pixel = vec2i(globalId.xy);
  let center = textureLoad(in_rawNormal, pixel, 0);
  let n = normalize(center.rgb * 2.0 - 1.0 + vec3f(1e-8));
  var discontinuity = 0.0;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let neighbor = textureLoad(in_rawNormal,
        clamp(pixel + vec2i(x, y), vec2i(0), imageSize - 1), 0);
      let nn = normalize(neighbor.rgb * 2.0 - 1.0 + vec3f(1e-8));
      discontinuity = max(discontinuity,
        max(1.0 - dot(n, nn), abs(center.a - neighbor.a)));
    }
  }
  let edgeWeight = smoothstep(0.02, 0.1, discontinuity);
  let raw = clamp(textureLoad(in_rawAlbedo, pixel, 0).rgb,
    vec3f(0.0), vec3f(1.0));
  result = mix(raw, linear, edgeWeight);
}
out_albedo[index] = vec4f(result, surfaceCoverage);
`;

export const oidnNormalSanitizeMain = /* wgsl */ `
if (globalId.x >= u32(imageSize.x) || globalId.y >= u32(imageSize.y)) { return; }
let index = globalId.x + globalId.y * u32(imageSize.x);
out_normal[index] = vec4f(oidnSanitizeNormal(in_normal[index].rgb), 1.0);
`;

export interface WGPURenderingPipelineOptions {
  presentationFormat?: GPUTextureFormat;
  materialTextures?: MaterialTextureSelection;
}

function createTimeQuery(device: GPUDevice) {
  try {
    const querySet = device.createQuerySet({
      type: 'timestamp',
      count: 16
    });
    const resolveBuffer = device.createBuffer({
      size: querySet.count * 8,
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC
    });
    const resultBuffer = device.createBuffer({
      size: resolveBuffer.size,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
    });
    return {
      querySet,
      resolveBuffer,
      resultBuffer
    };
  } catch (e) {
    console.error(e);
    return undefined;
  }
}

function makeWGPUAccumulationTarget(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  device: GPUDevice,
  rayTracePass: WGPURayTracePass,
  surface: WGPUCanvasSurface,
  scratch: ScratchPool,
  customJobs: Set<Promise<unknown>>,
  traceQueue: GPUTraceQueue
) {
  let sampleRenderedCallback: (
    sampleCount: number,
    isFirstFrame: boolean,
    frameTime: number
  ) => void = () => { };

  let batchSamples = false;
  let realtimeBatchBudgetMs = Infinity;
  // Samples traced between display frames skip the resolve and composition;
  // the next presentation or read resolves them once.
  let realtimeDeferPostProcess = false;
  let postProcessPending = false;
  let offlineSamplesPerBatch = 0;
  let deferPostProcess = false;
  let sampleSequenceOffset = 0;

  const aov = new WGPUAov(device);
  let aovCamera: Camera | undefined;
  let sampleCount = 0;
  let elapsedFrameTime = 32;
  let elapsedTileTime: number | undefined;
  let tileTimingGeneration = 0;
  let causticBatchTimeMs=0,photonBatchTimeMs=0;
  let lastGpuTraceTiming:
    | {
      causticTimeMs?:number;
      photonMappingTimeMs?:number;
      photonStagesMs?:number[];
      pathTracingTimeMs?:number;
      tileTimeMs: number;
      tileTimePerSampleMs?: number;
      estimatedFullFrameTimeMs: number;
      tileCount: number;
    }
    | undefined;
  let displayTrace: string[] | undefined;
  let diagnosticsReadbackPromise: Promise<void> = Promise.resolve();

  let isFirstFrame = true;
  let disposed = false;

  let needsUpdatePredicting = true;
  let isPredictingFrame = false;

  let renderWidth = 0;
  let renderHeight = 0;
  let screenWidth = 0;
  let screenHeight = 0;

  const targetKey = {};
  let execution: TraceSettings | undefined;

  let resolvedSamples = 0;
  let resolvedHasShadowCatcher = false;
  let pendingFlatBackground = [0, 0, 0, 0];
  let resolvedFlatBackground = [0, 0, 0, 0];
  let presentationTexture: GPUTexture | undefined;
  let presentationDenoised = false;
  const displayPostProcess = new DisplayPostProcess(device);
  let denoiseValid = false;

  let maxTimePerTile = 21;

  let bloomIntensity = 0;
  // Sample count of this accumulation's last bloom refresh.
  let bloomSamples = 0;
  let bloomThreshold = 1;
  let bloomRadius = 0.6;

  let exposure = 1;
  let toneMappingMode = 0;
  let contrast = 1;
  let saturation = 1;
  let temperature = 0;
  let tint = 0;
  let vignette = 0;
  let hdrOutputRequested = false;
  let hdrOutputActive = false;
  let output: DisplayChannel = 'final';
  let aovDisplayOptions: AovDisplayOptions = DEFAULT_AOV_DISPLAY;
  let shadowCatcherColor = vec3.create();
  let shadowCatcherAlpha = 1;

  let pageLeaveTime = performance.now();
  let pageInvisibleTime = 0;

  let denoisedBuffer: GPUBuffer | undefined;
  let denoisedTexture: GPUTexture | undefined;
  let denoisedDisplayLinear = false;
  let denoisedHDR = false;
  let activeCustomController: AbortController | undefined;
  let jnlmPass: WGPUJNLMDenoisePass | undefined;
  let denoiseGeneration = 0;
  let preserveDenoisedOutput = false;

  let activeOidnPhase:
    | {
      abort: () => void;
      finish: () => void;
    }
    | undefined;

  function cancelDenoise() {
    activeCustomController?.abort(); activeCustomController = undefined;
    denoiseGeneration++;
    const activePhase = activeOidnPhase;
    activeOidnPhase = undefined;
    if (activePhase) {
      try {
        activePhase.abort();
      } finally {
        activePhase.finish();
      }
    }
  }

  function runOIDNPhase(
    generation: number,
    execute: (
      finish: () => void,
      fail: (reason: unknown) => void
    ) => () => void
  ): Promise<void> {
    if (generation !== denoiseGeneration) return Promise.resolve();

    return new Promise((resolve, reject) => {
      let settled = false;
      let phase:
        | {
          abort: () => void;
          finish: () => void;
        }
        | undefined;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (activeOidnPhase === phase) activeOidnPhase = undefined;
        resolve();
      };
      const fail = (reason: unknown) => {
        if (settled) return;
        settled = true;
        if (activeOidnPhase === phase) activeOidnPhase = undefined;
        reject(reason);
      };

      try {
        const abort = execute(finish, fail);
        phase = { abort, finish };
        if (settled) return;
        if (generation !== denoiseGeneration) {
          abort();
          finish();
          return;
        }
        activeOidnPhase = phase;
      } catch (error) {
        if (activeOidnPhase === phase) activeOidnPhase = undefined;
        settled = true;
        reject(error);
      }
    });
  }

  const ctx = surface.context;

  const timeQuery = device.features.has('timestamp-query')
    ? scratch.get('trace timing', () => {
      const query = createTimeQuery(device);
      return {
query, getMemoryBytes: () => query ? query.resolveBuffer.size + query.resultBuffer.size : 0,
        dispose() { query?.querySet.destroy(); query?.resolveBuffer.destroy(); query?.resultBuffer.destroy(); }
};
    }).query
    : undefined;
  const tileRender = makeTileRender();
  const tileRenderWithPredict = timeQuery ? makeTileRenderWithPredict() : undefined;
  tileRender.setDesiredMsPerTile(maxTimePerTile);
  tileRenderWithPredict?.setDesiredMsPerTile(maxTimePerTile);

  function invalidateTilePrediction() {
    tileTimingGeneration++;
    tileRenderWithPredict?.needsUpdatePredicting();
    lastGpuTraceTiming = undefined;causticBatchTimeMs=0;photonBatchTimeMs=0;
    // A changed render configuration needs fresh timing. Refresh
    // its estimator without submitting a hidden probe in that mode.
    needsUpdatePredicting = offlineSamplesPerBatch === 0;
    isPredictingFrame = false;
  }

  const zero = scratch.get('empty texture', () => {
    const texture = device.createTexture({ label: 'Shared empty image', size: { width: 1, height: 1 }, format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING });
    return { texture, getMemoryBytes: () => 4, dispose: () => texture.destroy() };
  }).texture;
  const rayTraceOutputPass = new WGPURayTraceOutputPass(device, zero);
  const getFrameInput = (label: 'color' | 'albedo' | 'normal' | 'shadowCatcher' | 'foreground' | 'catcherBackground') =>
    rayTraceOutputPass.getOutput(label);
  let bloomPass: WGPUBloomPass | undefined;

  // Primary misses on a flat colour background are blank: they add the
  // background radiance but no surface hit, and the normalized colour divides
  // by hits only. Raw readback restores the per-sample average, as on WebGL.
  // Fully blank pixels are already divided by the sample count.
  const rawOutputPass = scratch.get('rawOutputPass', () => new WGPUFullQuadPass('raw output', device, {
    textureWillBeRead: true,
    inputs: ['colorTex', 'coverageTex'],
    outputs: ['color'],
    uniforms: [{ label: 'flatBackgroundColor', type: 'vec4f', data: [0, 0, 0, 0] }],
    fsDefine: hdrResolveWGSL,
    fsMain: /* wgsl */ `
var color = load_colorTex(uv, 0);
let coverage = clamp(load_coverageTex(uv, 0).a, 0.0, 1.0);
color = vec4f(
  hdr_flat_component(color.r, coverage, flatBackgroundColor.a > 0.5, true),
  hdr_flat_component(color.g, coverage, flatBackgroundColor.a > 0.5, true),
  hdr_flat_component(color.b, coverage, flatBackgroundColor.a > 0.5, true), color.a);
output.color = color;
`
  }));

  const readbackPass = scratch.get('readbackPass', () => new WGPUFullQuadPass('output readback', device, {
    textureWillBeRead: true, inputs: ['inputTex'], outputs: ['color'],
    fsMain: 'output.color = load_inputTex(uv, 0);'
  }));
  readbackPass.setOutputParams({ color: { format: 'rgba32float' } });

  let hdrPeakMeter: WGPUHDRPeakMeter | undefined;
  const composePass = scratch.get('composePass', () => new WGPUFullQuadPass('compose', device, {
    textureWillBeRead: true,
    fsMain: composeMain + compositeDenoiseOutputMain,
    fsDefine: composeDefine,
    uniforms: [
      {
        label: 'exposure',
        type: 'f32',
        data: exposure
      },
      {
        label: 'toneMappingParams',
        type: 'vec2f',
        data: [toneMappingMode, vignette]
      },
      {
        label: 'hdrOutputEnabled',
        type: 'f32',
        data: 0
      },
      {
        label: 'colorGradingParams',
        type: 'vec4f',
        data: [contrast, saturation, temperature, tint]
      },
      {
        label: 'flatBackgroundColor',
        type: 'vec4f',
        data: [0, 0, 0, 0]
      },
      {
        label: 'shadowCatcherColor',
        type: 'vec3f',
        data: shadowCatcherColor
      },
      {
        label: 'shadowCatcherAlpha',
        type: 'f32',
        data: shadowCatcherAlpha
      },
      {
        label: 'shadowCatcherEnabled',
        type: 'f32',
        data: 0
      },
      {
        label: 'bloomIntensity',
        type: 'f32',
        data: 0.25
      }
    ],
    outputs: ['color', 'denoiseColor', 'denoiseAlbedo'],
    inputs: [
      'colorTex',
      'foregroundTex',
      'catcherBackgroundTex',
      'flatBackgroundMaskTex',
      'shadowCatcherTex',
      'bloomTex'
    ]
  }));
  let composeColorFormat: GPUTextureFormat = 'rgba8unorm';
  composePass.setOutputParams({
    color: {
      format: composeColorFormat
    },
    denoiseColor: { format: 'rgba32float' },
    denoiseAlbedo: { format: 'rgba8unorm' }
  });
  const compositeDenoiseDisplayPass = scratch.get('compositeDenoiseDisplayPass', () => new WGPUFullQuadPass(
    'OIDN composed display', device, {
    textureWillBeRead: true,
    fsMain: compositeDenoiseDisplayMain,
    fsDefine: linearToSrgbDefine,
    uniforms: [
      { label: 'denoisedAlpha', type: 'f32', data: 0 }
    ],
    outputs: ['color'], inputs: ['colorTex', 'composedTex']
  }
  ));
  compositeDenoiseDisplayPass.setOutputParams({ color: { format: 'rgba8unorm' } });
  const auxiliaryPassUniforms = [
    {
      label: 'imageSize',
      type: 'vec2i' as const,
      data: new Int32Array([1, 1])
    }
  ];
  const oidnAlbedoEncodePass = scratch.get('oidnAlbedoEncodePass', () => new WGPUComputePass<'albedo', 'albedo'>(
    'OIDN albedo sRGB encode',
    device,
    {
      inputs: ['albedo'],
      outputs: ['albedo'],
      uniforms: auxiliaryPassUniforms,
      csDefine: oidnAuxiliaryDefine,
      csMain: oidnAlbedoSrgbEncodeMain
    }
  ));
  const oidnAlbedoDecodePass = scratch.get('oidnAlbedoDecodePass', () => new WGPUComputePass<'albedo' | 'rawAlbedo' | 'rawNormal', 'albedo'>(
    'OIDN albedo sRGB decode',
    device,
    {
      inputs: ['albedo', 'rawAlbedo', 'rawNormal'],
      outputs: ['albedo'],
      uniforms: [...auxiliaryPassUniforms, {
        label: 'preserveSurfaceTexture', type: 'u32', data: 0
      }],
      csDefine: oidnAuxiliaryDefine,
      csMain: oidnAlbedoSrgbDecodeMain
    }
  ));
  const oidnNormalSanitizePass = scratch.get('oidnNormalSanitizePass', () => new WGPUComputePass<'normal', 'normal'>(
    'OIDN normal sanitize',
    device,
    {
      inputs: ['normal'],
      outputs: ['normal'],
      uniforms: auxiliaryPassUniforms,
      csDefine: oidnAuxiliaryDefine,
      csMain: oidnNormalSanitizeMain
    }
  ));
  oidnAlbedoEncodePass.setOutputParams({ albedo: { channels: 4 } });
  oidnAlbedoDecodePass.setOutputParams({ albedo: { channels: 4 } });
  oidnNormalSanitizePass.setOutputParams({ normal: { channels: 4 } });
  const outputPass = scratch.get('outputPass', () => new WGPUFullQuadPass('output', device, {
    fsMain: /* wgsl */ `
let colorUv = min(
  vec2i(uv2 * vec2f(colorTexRegion())),
  vec2i(colorTexRegion()) - vec2i(1)
);
var color = load_colorTex(colorUv, 0);
color = vec4(color.rgb * color.a, color.a);
output.color = color;
`,
    outputs: ['color'],
    inputs: ['colorTex']
  }));
  outputPass.setOutputParams({
    color: {
      format: 'rgba8unorm'
    }
  });

  function _present(encoder: GPUCommandEncoder, texture: GPUTexture) {
    outputPass.setRenderToScreen(
      ctx.getCurrentTexture(),
      surface.format
    );
    outputPass.createPass(encoder, {
      colorTex: texture
    });
  }

  function _updateSeed(width: number, height: number) {
    const sequenceSample = sampleCount + sampleSequenceOffset;
    // Each ray includes a .5 pixel center, so its Halton jitter in [-.5,.5)
    // becomes a sub-pixel offset in [0,1).
    const jitterX = halton(sequenceSample, 2) - 0.5;
    const jitterY = halton(sequenceSample, 3) - 0.5;
    rayTracePass.setJitter(jitterX / width, jitterY / height);
  }

  function sample(clear: boolean, tiles: [number, number]) {
    const encoder = device.createCommandEncoder();
    rayTracePass.setSampleCount(sampleCount + sampleSequenceOffset);
    rayTracePass.setSampleSequenceOffset(sampleSequenceOffset);
    _updateSeed(renderWidth, renderHeight);
    const activeTimeQuery = timeQuery;
    const isUnmapped = activeTimeQuery?.resultBuffer.mapState === 'unmapped';
    const measuredCausticBatch=rayTracePass.createPass(
      encoder,
      clear,
      tiles,
      activeTimeQuery ? { querySet: activeTimeQuery.querySet } : undefined
    );
    if (activeTimeQuery) {
      encoder.resolveQuerySet(
        activeTimeQuery.querySet,
        0,
        activeTimeQuery.querySet.count,
        activeTimeQuery.resolveBuffer,
        0
      );
      if (isUnmapped) {
        encoder.copyBufferToBuffer(
          activeTimeQuery.resolveBuffer,
          0,
          activeTimeQuery.resultBuffer,
          0,
          activeTimeQuery.resultBuffer.size
        );
      }
    }

    // TODO if encoder is not submitted. The uniform buffer will be replaced
    device.queue.submit([encoder.finish()]);

    const submittedTileRenderWithPredict = tileRenderWithPredict;
    const submittedTimingGeneration = tileTimingGeneration;
    if (activeTimeQuery && isUnmapped && submittedTileRenderWithPredict) {

      const submittedTileCount = tiles[0] * tiles[1];
      diagnosticsReadbackPromise = activeTimeQuery.resultBuffer
        .mapAsync(GPUMapMode.READ).then(() => {
          const mappedRange = activeTimeQuery.resultBuffer.getMappedRange();
          const times = new BigInt64Array(mappedRange, 0, 16);
          const causticTime=(measuredCausticBatch&1)?Math.max(Number(times[3]-times[2]+times[5]-times[4])/1_000_000,0):0;
          // Independent timestamp pairs avoid Metal's cross-pass counter bug.
          const photonTime=(measuredCausticBatch&2)?Math.max(Number(times[7]-times[6]+times[9]-times[8]+times[11]-times[10]+times[13]-times[12]+times[15]-times[14])/1_000_000,0):0;
          const ptTime=Math.max(Number(times[1]-times[0])/1_000_000,0);
          // A readback may finish after scene preparation or a mode switch.
          // It must not overwrite throughput learned for the current scene.
          const timingIsCurrent =
            !disposed && submittedTimingGeneration === tileTimingGeneration &&
            !isFirstFrame;
          if (timingIsCurrent) {
            if(measuredCausticBatch&1)causticBatchTimeMs=causticTime;
            if(measuredCausticBatch&2)photonBatchTimeMs=photonTime;
            const traceTime=Math.max(ptTime+(causticBatchTimeMs+photonBatchTimeMs)/submittedTileCount,.1);
            lastGpuTraceTiming = {
              causticTimeMs:causticBatchTimeMs,photonMappingTimeMs:photonBatchTimeMs,
              photonStagesMs:(measuredCausticBatch&2)?[6,8,10,12,14].map(i=>Math.max(Number(times[i+1]-times[i])/1_000_000,0)):undefined,
              pathTracingTimeMs:ptTime,
              tileTimeMs: traceTime,
              tileTimePerSampleMs: traceTime,
              estimatedFullFrameTimeMs: traceTime * submittedTileCount,
              tileCount: submittedTileCount
            };
            submittedTileRenderWithPredict.setLastTraceTime(traceTime);
          }
          activeTimeQuery.resultBuffer.unmap();

        }).catch(() => {
          if (activeTimeQuery.resultBuffer.mapState === 'mapped') {
            activeTimeQuery.resultBuffer.unmap();
          }
        });
    }
  }

  function clearDenoisedOutput() { denoiseValid = false; }

  function invalidateCompositeDenoise() {
    if (!denoisedDisplayLinear) return;
    cancelDenoise();
    denoiseValid = false;
  }

  function prepareDenoisedTexture(
    encoder: GPUCommandEncoder,
    buffer: GPUBuffer | undefined,
    texture: GPUTexture | undefined
  ) {
    if (!buffer) {
      return undefined;
    }
    const conversion = scratch.get('denoised conversion', () => new WGPUScratchTexture(device));
    texture = conversion.get(renderWidth, renderHeight); conversion.setRegion(renderWidth, renderHeight);
    encoder.copyBufferToTexture(
      { buffer: buffer!, bytesPerRow: 16 * renderWidth },
      {
        texture: texture
      },
      {
        width: renderWidth,
        height: renderHeight,
        depthOrArrayLayers: 1
      }
    );
    return texture;
  }

  function copyDenoisedOutput(
    encoder: GPUCommandEncoder,
    output: OIDNWebGPUOutputData,
    target: GPUBuffer | undefined
  ) {
    const byteLength = output.width * output.height * 16;
    if (!target || target.size !== byteLength) {
      target?.destroy();
      target = device.createBuffer({
        label: 'Persistent denoised output',
        size: byteLength,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC
      });
    }
    encoder.copyBufferToBuffer(output.data, 0, target, 0, byteLength);
    return target;
  }

  function prepareComposition() {
    composePass.setSize(renderWidth, renderHeight);
    composePass.setOutputParams({ color: { format: composeColorFormat }, denoiseColor: { format: 'rgba32float' }, denoiseAlbedo: { format: 'rgba8unorm' } });
    composePass.setUniform('exposure', exposure);
    composePass.setUniform('toneMappingParams', [toneMappingMode, vignette]);
    composePass.setUniform('colorGradingParams', [contrast, saturation, temperature, tint]);
    composePass.setUniform('hdrOutputEnabled', +hdrOutputActive);
    composePass.setUniform('shadowCatcherColor', shadowCatcherColor);
    composePass.setUniform('shadowCatcherAlpha', shadowCatcherAlpha);
    compositeDenoiseDisplayPass.setSize(renderWidth, renderHeight);
    compositeDenoiseDisplayPass.setOutputParams({ color: { format: composeColorFormat } });
    compositeDenoiseDisplayPass.setUniform('denoisedAlpha', denoiseValid && denoisedDisplayLinear ? +rayTracePass.needsDenoiseAlpha() : 0);
  }
  function snapshotInput(encoder: GPUCommandEncoder, key: string, texture: GPUTexture, exact = false) {
    const buffer = scratch.get(key, () => new WGPUScratchBuffer(device)).get(renderWidth * renderHeight * 16, exact);
    encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: renderWidth * 16 }, { width: renderWidth, height: renderHeight });
    return buffer;
  }
  function copyGuide(key: string, input: GPUTexture, exact = false) {
    const pass = scratch.get(key, () => new WGPUComputePass(`${key} copy`, device, {
      inputs: ['guide'], outputs: ['color'], uniforms: auxiliaryPassUniforms,
      csMain: 'if (globalId.x >= u32(imageSize.x) || globalId.y >= u32(imageSize.y)) {return;} out_color[globalId.x + globalId.y * u32(imageSize.x)] = textureLoad(in_guide, vec2i(globalId.xy), 0);'
    }));
    pass.setOutputParams({ color: { channels: 4 } });
    pass.setSize(renderWidth, renderHeight); pass.setUniform('imageSize', [renderWidth, renderHeight]);
    const output = exact ? scratch.get(`${key} buffer`, () => new WGPUScratchBuffer(device)).get(renderWidth * renderHeight * 16, true) : undefined;
    const encoder = device.createCommandEncoder(); pass.createPass(encoder, { guide: { texture: input, channels: 4 } }, output ? {color: output} : undefined); device.queue.submit([encoder.finish()]);
    return output ?? pass.getOutput('color');
  }

  function drawPostProcess(
    encoder: GPUCommandEncoder,
    _forceNeedsDenoise?: boolean,
    resolve = false
  ) {
    displayPostProcess.reset();
    if (resolve) {
      resolvedSamples = sampleCount;
      resolvedHasShadowCatcher = rayTracePass.hasShadowCatcher();
      resolvedFlatBackground = pendingFlatBackground.slice();
    }
    composePass.setUniform('flatBackgroundColor', resolvedFlatBackground);
    rawOutputPass.setUniform('flatBackgroundColor', resolvedFlatBackground);
    const aovKind = displayAovKind(output);
    if (aovKind && sampleCount === 0) {
      if (!execution?.aovs?.includes(aovKind)) throw new Error(`AOV ${aovKind} is not enabled`);
      if (!aov.samples) return;
      finishPresentation(encoder, aov.visualize(aovKind, aovDisplayOptions, hdrOutputActive));
      return;
    }
    if (resolvedSamples < 1) return;
    prepareComposition();
    if (denoiseValid) denoisedTexture = prepareDenoisedTexture(
      encoder,
      denoisedBuffer,
      denoisedTexture
    );
    if (resolve) {
      rayTraceOutputPass.setSampleCount(sampleCount);
      rayTraceOutputPass.createPass(encoder, rayTracePass.getOutputBuffer(), resolvedHasShadowCatcher);
    }

    composePass.setUniform(
      'shadowCatcherEnabled',
      +resolvedHasShadowCatcher
    );

    let foregroundTexture = getFrameInput(
      resolvedHasShadowCatcher ? 'foreground' : 'color'
    );
    const colorTexture = denoiseValid && denoisedHDR && denoisedTexture ? denoisedTexture : getFrameInput('color');
    let catcherBackgroundTexture = getFrameInput('catcherBackground');
    if (denoiseValid && denoisedHDR && denoisedTexture && resolvedHasShadowCatcher) {
      const layers = scratch.get('custom HDR layers', () => new WGPUFullQuadPass('Custom HDR layers', device, {
        textureWillBeRead: true,
        inputs: ['originalTex', 'filteredTex', 'foregroundTex', 'backgroundTex'],
        outputs: ['foreground', 'background'], fsMain: customDenoiseLayersMain
      }));
      layers.setOutputParams({foreground: {format: 'rgba32float'}, background: {format: 'rgba32float'}});
      layers.setSize(renderWidth, renderHeight);
      displayTrace?.push('CorrectLayers:SceneLinear');
      layers.createPass(encoder, {originalTex: getFrameInput('color'), filteredTex: denoisedTexture,
        foregroundTex: foregroundTexture, backgroundTex: catcherBackgroundTexture});
      foregroundTexture = layers.getOutput('foreground');
      catcherBackgroundTexture = layers.getOutput('background');
    }
    const bloomEnabled = bloomIntensity > 0.0;
    // Progressive accumulation refreshes bloom after every ten new samples,
    // including when several samples are resolved at once.
    const bloomState = scratch.get('bloom state', () => ({ owner: undefined as object | undefined, settings: '', dispose() { } }));
    const bloomSettings = `${bloomThreshold}/${bloomRadius}/${+(denoiseValid && denoisedHDR)}`;
    const needsUpdateBloom = bloomEnabled && sampleCount >= 10 && (sampleCount - bloomSamples >= 10 || bloomState.owner !== targetKey || bloomState.settings !== bloomSettings);
    let bloomIntensityToUpdate = bloomIntensity;
    if (needsUpdateBloom) {
      if (!bloomPass) {
        bloomPass = scratch.get('bloom', () => new WGPUBloomPass(device));
        bloomPass.setSize(renderWidth, renderHeight);
      }
      bloomPass.setSize(renderWidth, renderHeight);
      bloomState.owner = targetKey; bloomState.settings = bloomSettings; bloomSamples = sampleCount;
      bloomPass.setBrightThreshold(bloomThreshold);
      bloomPass.setRadius(bloomRadius);
      displayTrace?.push('Bloom:SceneLinear');
      bloomPass.createPass(encoder, colorTexture);
    } else if (bloomEnabled && sampleCount < 10) {
      bloomIntensityToUpdate = 0;
    }
    composePass.setUniform('bloomIntensity', bloomIntensityToUpdate);
    displayTrace?.push('Compose:DisplayLinear+DisplayEncoded');
    composePass.createPass(encoder, {
      colorTex: colorTexture,
      foregroundTex: foregroundTexture,
      catcherBackgroundTex: catcherBackgroundTexture,
      flatBackgroundMaskTex: getFrameInput('albedo'),
      shadowCatcherTex: getFrameInput('shadowCatcher'),
      // Use color texture as placeholder
      bloomTex: bloomEnabled && bloomPass ? bloomPass.getOutput() : colorTexture
    });
    if (denoiseValid && !denoisedHDR && denoisedDisplayLinear && denoisedTexture) {
      displayTrace?.push('Encode:DisplayEncoded');
      compositeDenoiseDisplayPass.createPass(encoder, {
        colorTex: denoisedTexture,
        composedTex: composePass.getOutput('denoiseColor')
      });
    }
    let displayTexture =
      (denoiseValid && denoisedBuffer ? (denoisedHDR ? composePass.getOutput('color') : denoisedDisplayLinear
        ? compositeDenoiseDisplayPass.getOutput('color') : denoisedTexture) : undefined) ||
      composePass.getOutput('color');
    if (aovKind) {
      if (!execution?.aovs?.includes(aovKind)) throw new Error(`AOV ${aovKind} is not enabled`);
      displayTexture = aov.visualize(aovKind, aovDisplayOptions, hdrOutputActive);
    }
    finishPresentation(encoder, displayTexture);
  }

  function finishPresentation(encoder: GPUCommandEncoder, displayTexture: GPUTexture) {
    const activeHDRPeakMeter = hdrOutputActive
      ? (hdrPeakMeter ??= scratch.get('hdrPeak', () => new WGPUHDRPeakMeter(device)))
      : undefined;
    const hdrPeakReadbackSubmitted =
      activeHDRPeakMeter?.encode(
        encoder,
        displayTexture,
        renderWidth,
        renderHeight
      ) ?? false;

    if (output === 'normal' || output === 'albedo') {
      displayTrace?.push('AOV:Raw');
      displayTexture = getFrameInput(output);
    } else if (output === 'shadowCatcher') {
      displayTrace?.push('AOV:Raw');
      displayTexture = getFrameInput('shadowCatcher');
    }

    if (displayTexture.width < renderWidth || displayTexture.height < renderHeight) {
      readbackPass.setSize(renderWidth, renderHeight);
      readbackPass.createPass(encoder, { inputTex: displayTexture });
      displayTexture = readbackPass.getOutput('color');
    }
    // Keep the completed denoise visible until its replacement is ready.
    if (!(preserveDenoisedOutput && output === 'final' && !denoiseValid && presentationDenoised)) {
      const width = renderWidth, height = renderHeight;
      if (!presentationTexture || presentationTexture.width !== width || presentationTexture.height !== height || presentationTexture.format !== displayTexture.format) {
        const previous = presentationTexture;
        presentationTexture = device.createTexture({
label: 'Render complete image', size: { width, height }, format: displayTexture.format,
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC
});
        if (previous) void device.queue.onSubmittedWorkDone().catch(() => { }).then(() => previous.destroy());
      }
      encoder.copyTextureToTexture({ texture: displayTexture }, { texture: presentationTexture }, { width, height });
      presentationDenoised = output === 'final' && denoiseValid;
    }
    const commandBuffer = encoder.finish();
    device.queue.submit([commandBuffer]);
    if (hdrPeakReadbackSubmitted) {
      void activeHDRPeakMeter?.resolve();
    }
  }

  function flushPostProcess() {
    if (!postProcessPending) return;
    postProcessPending = false;
    drawPostProcess(device.createCommandEncoder(), false, true);
  }

  function trace(camera: Camera, maxSamples: number) {
    // A call to draw means accumulation has been invalidated. Cancel OIDN
    // before checking shader compilation: pipeline-affecting parameter changes
    // otherwise leave the previous asynchronous denoise alive while resources
    // and bind groups are being replaced.
    cancelDenoise();

    if (rayTracePass.isCompilingShader()) {
      isFirstFrame = true;
      sampleCount = 0;
      return true;
    }

    // Update the camera before compiling and sampling.
    rayTracePass.setCamera(camera);
    aovCamera = camera;
    const resetAccumulation = isFirstFrame;
    if (resetAccumulation) aov.reset();
    if (resetAccumulation) {
      postProcessPending = false;
      bloomSamples = 0;
      denoiseValid = false;
      tileTimingGeneration++;
      elapsedTileTime = undefined;
      rayTracePass.setCamera(camera);
      (tileRenderWithPredict || tileRender).reset();

      // Reset
      isFirstFrame = false;
      sampleCount = 0;
    }

    rayTracePass.updatePipeline();

    if (rayTracePass.isCompilingShader() || !rayTracePass.isPipelineReady()) {
      isFirstFrame = true;
      sampleCount = 0;
      return true;
    }
    if (execution?.aovs?.length && !rayTracePass.prepareAovs(execution.aovs)) return true;

    // Keep the last completed denoise visible while a static while-converging batch
    // accumulates, including the incomplete first sample after a scene edit.
    if (!preserveDenoisedOutput || isFirstFrame) {
      clearDenoisedOutput();
    }
    if (isPredictingFrame) {
      (tileRenderWithPredict || tileRender).reset();
      isPredictingFrame = false;
    }

    // Never enter a waiting prediction state while the shared timestamp
    // buffer is still being mapped. Render normally and retry the probe at an
    // accumulation restart; a delayed probe must not discard visible samples.
    // The probe itself is also non-blocking: if readback fails or
    // is superseded, the renderer keeps using the conservative tile seed.
    if (
      offlineSamplesPerBatch === 0 &&
      resetAccumulation &&
      tileRenderWithPredict &&
      needsUpdatePredicting &&
      timeQuery?.resultBuffer.mapState === 'unmapped'
    ) {
      (tileRenderWithPredict || tileRender).reset();
      isPredictingFrame = true;
      tileRenderWithPredict.needsUpdatePredicting();
      needsUpdatePredicting = false;
    }

    const frameSampleCount = sampleCount;
    const sampleTimeMs = lastGpuTraceTiming?.estimatedFullFrameTimeMs;
    const realtime = offlineSamplesPerBatch === 0 && batchSamples;
    const realtimeBudget = Math.min(maxTimePerTile, realtimeBatchBudgetMs);
    if (realtime && !resetAccumulation && !isPredictingFrame && sampleTimeMs !== undefined &&
      traceQueue.available(realtimeBudget) < Math.min(sampleTimeMs, realtimeBudget)) return false;
    // Only batch a measured, unchanged full-frame workload. New cameras get
    // their first sample immediately; expensive samples retain tiled execution.
    const realtimeBatch = realtime && sampleCount > 0 &&
      !resetAccumulation && !isPredictingFrame && lastGpuTraceTiming?.tileCount === 1 && sampleTimeMs !== undefined &&
      sampleTimeMs <= realtimeBudget / 2;
    const realtimeSamples = realtimeBatch
      ? Math.min(64, Math.floor(traceQueue.available(realtimeBudget) / sampleTimeMs!)) : 1;
    if (realtimeBatch && realtimeSamples === 0) return false;
    const batchStarted = performance.now();
    _startRecordFrameTime(!resetAccumulation);
    const renderSampleTarget = maxSamples;
    const batchTarget = Math.min(
      renderSampleTarget,
      sampleCount + (offlineSamplesPerBatch > 0 ? offlineSamplesPerBatch : realtimeSamples)
    );
    do {
      let {
        xIndex,
        yIndex,
        columns,
        rows,
        isFirstTile,
        isLastTile,
        samplesPerFrame
      } = (tileRenderWithPredict || tileRender).nextTile(elapsedTileTime);

      rayTraceOutputPass.setSampleTileGrid(columns, rows);

      if ((offlineSamplesPerBatch > 0 || realtimeBatch) && columns * rows === 1) {
        samplesPerFrame = batchTarget - sampleCount;
      } else if (!batchSamples) {
        samplesPerFrame = 1;
      }

      if (columns * rows === 1) {
        rayTracePass.setSampleTiles(1, 1, 0, 0);
        let samplesSubmitted = 0;
        while (
          samplesSubmitted < samplesPerFrame &&
          sampleCount < renderSampleTarget &&
          sampleCount < batchTarget
        ) {
          sample(sampleCount === 0, [1, 1]);
          sampleCount++;
          samplesSubmitted++;
          if (realtime && !isPredictingFrame && sampleTimeMs !== undefined) traceQueue.track(sampleTimeMs);
          if (realtimeBatch) {
            // Encoding many tiny samples must also leave the main thread free
            // to receive camera input. Yield before encoding another batch.
            if (performance.now() - batchStarted >= 4) break;
          }
        }
      } else {
        rayTracePass.setSampleTiles(columns, rows, xIndex, yIndex);
        sample(sampleCount === 0 && isFirstTile, [columns, rows]);
        if (realtime && !isPredictingFrame && sampleTimeMs !== undefined) traceQueue.track(sampleTimeMs / (columns * rows));
        if (isLastTile) sampleCount++;
      }
    } while (
      offlineSamplesPerBatch > 0 &&
      sampleCount < batchTarget &&
      sampleCount < renderSampleTarget
    );

    // Not displaying on screen for prediciting frame.
    if (isPredictingFrame) {
      // This hidden timing probe has not resolved the OIDN input textures.
      // Exclude it from progressive samples so a 1spp target cannot denoise
      // stale inputs, and clear its accumulation on the next visible sample.
      sampleCount = 0;
      return false;
    }

    if (sampleCount !== frameSampleCount && execution?.aovs?.length) {
      rayTracePass.renderAovs(aov, camera, sampleCount, execution.aovSamples ?? 16, execution.aovs);
    }
    if (sampleCount !== frameSampleCount && realtime && realtimeDeferPostProcess && sampleCount < renderSampleTarget) {
      postProcessPending = true;
    } else if (sampleCount !== frameSampleCount && (!deferPostProcess || sampleCount >= renderSampleTarget)) {
      postProcessPending = false;
      const encoder = device.createCommandEncoder();
      drawPostProcess(encoder, sampleCount >= renderSampleTarget, true);
    }
    if (sampleCount !== frameSampleCount) {
      sampleRenderedCallback(
        sampleCount,
        frameSampleCount === 0,
        elapsedFrameTime
      );
    }

    return false;
  }

  function roundUp(a: number, b: number) {
    return Math.ceil(a / b) * b;
  }

  function _applyRenderResolution() {
    if (!screenWidth || !screenHeight) return;
    rayTracePass.useTarget(targetKey);
    const scale = 1;
    const nextRenderWidth = roundUp(
      Math.max(1, Math.round(screenWidth * scale)),
      16
    );
    const nextRenderHeight = roundUp(
      Math.max(1, Math.round(screenHeight * scale)),
      16
    );
    if (nextRenderWidth === renderWidth && nextRenderHeight === renderHeight) {
      rayTracePass.setSize(nextRenderWidth, nextRenderHeight, screenWidth / screenHeight);
      return;
    }

    // OIDN retains the ray-trace output textures supplied at the start of a
    // tile sequence. Stop every phase (including Promise-chained follow-ups)
    // before those textures are replaced below.
    cancelDenoise();
    // Completed OIDN buffers use the previous image dimensions. Scene edits
    // may preserve them, but a resize must not copy them with the new stride.
    // The target retains its complete presentation texture through the resize.
    clearDenoisedOutput();
    tileTimingGeneration++;
    renderWidth = nextRenderWidth;
    renderHeight = nextRenderHeight;
    (tileRenderWithPredict || tileRender).setSize(renderWidth, renderHeight);
    // Projection follows the displayed canvas, independent of preview/texture alignment.
    rayTracePass.setSize(renderWidth, renderHeight, screenWidth / screenHeight);
    rayTraceOutputPass.setSize(renderWidth, renderHeight);
    composePass.setSize(renderWidth, renderHeight);
    compositeDenoiseDisplayPass.setSize(renderWidth, renderHeight);
    bloomPass?.setSize(renderWidth, renderHeight);

    resolvedSamples = 0;
    // Resizing starts a fresh accumulation while retaining the previous presentation.
    sampleCount = 0;
    resolvedSamples = 0;
    isFirstFrame = true;
  }

  function setSize(width: number, height: number) {
    if (width === screenWidth && height === screenHeight) {
      return;
    }
    screenWidth = width;
    screenHeight = height;
    invalidateTilePrediction();
    _applyRenderResolution();
    outputPass.setSize(screenWidth, screenHeight);
    isFirstFrame = true;
  }

  function synchronizeBackground(background?: SceneBackground) {
    const flatColor = Array.isArray(background) && background[3] >= 0.99999
      ? background
      : undefined;
    const flatBackgroundColor = flatColor
      ? [flatColor[0], flatColor[1], flatColor[2], 1]
      : [0, 0, 0, 0];
    pendingFlatBackground = flatBackgroundColor;
  }

  function setToneMappingParams(params: ToneMappingParams) {
    const newExposure = params.exposure ?? 1;
    const newToneMappingMode = {
      agx: 0,
      aces: 1,
      cineon: 2,
      reinhard: 3,
      linear: 4
    }[params.toneMapping ?? 'agx'] ?? 0;
    const newContrast = params.contrast ?? 1;
    const newSaturation = params.saturation ?? 1;
    const newTemperature = params.temperature ?? 0;
    const newTint = params.tint ?? 0;
    const newVignette = params.vignette ?? 0;
    if (
      newExposure === exposure &&
      newToneMappingMode === toneMappingMode &&
      newContrast === contrast &&
      newSaturation === saturation &&
      newTemperature === temperature &&
      newTint === tint &&
      newVignette === vignette
    ) return false;
    invalidateCompositeDenoise();
    exposure = newExposure;
    toneMappingMode = newToneMappingMode;
    contrast = newContrast;
    saturation = newSaturation;
    temperature = newTemperature;
    tint = newTint;
    vignette = newVignette;
    composePass.setUniform('exposure', exposure);
    composePass.setUniform('toneMappingParams', [toneMappingMode, vignette]);
    composePass.setUniform('colorGradingParams', [
      contrast,
      saturation,
      temperature,
      tint
    ]);
    return true;
  }

  function setHDROutputEnabled(enabled: boolean) {
    if (enabled === hdrOutputRequested) return false;
    invalidateCompositeDenoise();
    hdrOutputRequested = enabled;
    const wasActive = hdrOutputActive;

    hdrOutputActive = enabled && surface.supportsHDR;

    const nextComposeColorFormat: GPUTextureFormat = hdrOutputActive
      ? 'rgba16float'
      : 'rgba8unorm';
    if (nextComposeColorFormat !== composeColorFormat) {
      composeColorFormat = nextComposeColorFormat;
      composePass.setOutputParams({
        color: { format: composeColorFormat },
        denoiseColor: { format: 'rgba32float' },
        denoiseAlbedo: { format: 'rgba8unorm' }
      });

    }
    if (wasActive !== hdrOutputActive) {
      hdrPeakMeter?.reset();
    }
    compositeDenoiseDisplayPass.setOutputParams({ color: { format: composeColorFormat } });
    composePass.setUniform('hdrOutputEnabled', hdrOutputActive ? 1 : 0);
    return wasActive !== hdrOutputActive;
  }

  function _startRecordFrameTime(collectTileTiming: boolean) {
    const start = performance.now();
    const generation = tileTimingGeneration;
    const timedTileRender = tileRender;
    const scheduleFrame =
      typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame
        : (callback: FrameRequestCallback) =>
          setTimeout(
            () => callback(performance.now()),
            0
          ) as unknown as number;
    scheduleFrame(() => {
      // TODO use timestamp from requestAnimationFrame may have negative value.
      elapsedFrameTime = Math.max(
        performance.now() - start - pageInvisibleTime,
        pageInvisibleTime > 0 ? 16 : 8
      );

      pageInvisibleTime = 0;
      if (
        generation === tileTimingGeneration &&
        timedTileRender === tileRender && !isFirstFrame
      ) {
        // Without GPU timestamps, discard the draw that follows a scene
        // update instead of feeding its preparation/compilation time back.
        elapsedTileTime = collectTileTiming ? elapsedFrameTime : undefined;
      }
    });
  }
  function _onPageVisiblilityChange() {
    if (typeof document !== 'undefined' && document.hidden) {
      pageLeaveTime = performance.now();
    } else {
      pageInvisibleTime = performance.now() - pageLeaveTime;
    }
  }

  /** Runs the built-in JNLM filter on the current composed image. */
  function performJNLMDenoise(
    denoiser: JNLMDenoiser
  ): Promise<boolean> {
    const generation = denoiseGeneration;

    jnlmPass ??= scratch.get('jnlm', () => new WGPUJNLMDenoisePass(device));
    const rayBuffers = rayTracePass.getOutputBuffer();
    const encoder = device.createCommandEncoder({ label: 'JNLM denoise' });
    displayTrace?.push('Denoise:DisplayLinear');
    const output = jnlmPass.encode(encoder, {
      width: renderWidth,
      height: renderHeight,
      accumulation: rayBuffers.shadowCatcher,
      normalAccumulation: rayBuffers.normal,
      color: composePass.getOutput('denoiseColor'),
      albedo: getFrameInput('albedo'),
      normal: getFrameInput('normal'),
      shadowCatcher: getFrameInput('shadowCatcher'),
      strength: denoiser.strength,
      shape: denoiser.shape
    });
    denoisedBuffer = copyDenoisedOutput(
      encoder,
      { data: output, width: renderWidth, height: renderHeight },
      denoisedBuffer
    );
    denoisedDisplayLinear = true;
    denoiseValid = true;
    // The filter also smooths coverage, which carries catcher shadows and
    // transmissive alpha.
    compositeDenoiseDisplayPass.setUniform(
      'denoisedAlpha', +rayTracePass.needsDenoiseAlpha()
    );
    drawPostProcess(encoder, false);
    return device.queue.onSubmittedWorkDone().then(() => {
      const completed = generation === denoiseGeneration;

      return completed;
    });
  }

  function performCustomDenoise(
    denoiser: import('../Render.js').Denoiser,
    schedule: import('../Render.js').DenoiseSchedule,
    signal?: AbortSignal,
    requestedAovs: readonly import('./aov.js').AovKind[] = []
  ): Promise<boolean> {
    const generation = denoiseGeneration;
    const controller = activeCustomController = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, {once: true});
    if (signal?.aborted) abort();
    const task = (async () => {
      if (controller.signal.aborted) return false;
      const color = copyGuide('Custom HDR input', getFrameInput('color'), true);
      const width = renderWidth, height = renderHeight;
      const albedo = copyGuide('Custom albedo', getFrameInput('albedo'), true);
      const normal = copyGuide('Custom normal', getFrameInput('normal'), true);
      const output = scratch.get('Custom output', () => new WGPUScratchBuffer(device)).get(width * height * 16, true);
      const aovs=requestedAovs.length?aov.snapshot(requestedAovs):undefined;
      displayTrace?.push('Denoise:SceneLinear');
      try {await denoiser.denoise({device, width, height, color, albedo, normal, output, aovs}, {signal: controller.signal, schedule});}
      finally {if(aovs)void device.queue.onSubmittedWorkDone().catch(()=>undefined).then(()=>aov.releaseSnapshot(aovs));}
      if (controller.signal.aborted || disposed || generation !== denoiseGeneration) return false;
      const coverage = scratch.get('custom coverage', () => new WGPUComputePass('Custom coverage', device, {
        inputs: ['filtered', 'original'], outputs: ['color'], uniforms: auxiliaryPassUniforms,
        csMain: customDenoiseCoverageMain
      }));
      coverage.setOutputParams({color: {channels: 4}});
      coverage.setSize(width, height); coverage.setUniform('imageSize', [width, height]);
      const finish = device.createCommandEncoder({label: 'Custom HDR result'});
      coverage.createPass(finish, {filtered: {buffer: output, channels: 4}, original: {buffer: color, channels: 4}});
      denoisedBuffer = copyDenoisedOutput(finish, {data: coverage.getOutput('color'), width, height}, denoisedBuffer);
      denoisedHDR = true; denoisedDisplayLinear = false; denoiseValid = true;
      drawPostProcess(finish, false);
      await device.queue.onSubmittedWorkDone();
      return !controller.signal.aborted && !disposed && generation === denoiseGeneration;
    })();
    customJobs.add(task);
    void task.finally(() => {
      customJobs.delete(task); signal?.removeEventListener('abort', abort);
      if (activeCustomController === controller) activeCustomController = undefined;
    }).catch(() => {});
    return task;
  }

  function performDenoise(
    attachedDenoiser: DenoiserHandle,
    alphaDenoiser: OIDNWeb | undefined,
    denoiseSchedule: 'converged' | 'progressive' | 'every-sample' = 'converged',
    signal?: AbortSignal
  ): Promise<boolean> {
    cancelDenoise();
    if (isFirstFrame || sampleCount < 1) return Promise.resolve(false);
    if (output !== 'final' && output !== 'shadow') return Promise.resolve(true);
    flushPostProcess();
    if (attachedDenoiser.kind === 'custom') return performCustomDenoise(attachedDenoiser.denoiser, denoiseSchedule, signal, attachedDenoiser.aovs);
    denoisedHDR = false;
    if (attachedDenoiser.kind === 'jnlm') return performJNLMDenoise(attachedDenoiser.denoiser);
    const denoiser: OIDNWeb = attachedDenoiser.denoiser;
    compositeDenoiseDisplayPass.setUniform('denoisedAlpha', 0);
    const generation = denoiseGeneration;

    const size = { width: renderWidth, height: renderHeight };
    const snapshotEncoder = device.createCommandEncoder();
    const colorInput = snapshotInput(snapshotEncoder, 'OIDN color input', composePass.getOutput('denoiseColor'));
    device.queue.submit([snapshotEncoder.finish()]);
    for (const pass of [oidnAlbedoEncodePass, oidnAlbedoDecodePass, oidnNormalSanitizePass]) {
      pass.setSize(renderWidth, renderHeight); pass.setUniform('imageSize', [renderWidth, renderHeight]);
    }
    const convergingTileOptions = {
      ...(denoiseSchedule !== 'converged' ? {
        tileOverlap: 80,
        // Low-resolution interaction must finish as one low-latency frame;
        // otherwise continuous camera updates outrun a multi-tile denoise.
        // The settled full-resolution image uses bounded dynamic tiles so
        // 4K inference cannot allocate a whole-image U-Net activation set.
        wholeImage: denoiseSchedule === 'every-sample'
      } : {}),
      // A preview frame is one whole-image pass. Settled images can take many
      // tiles; oidn-webgpu runs those back to back by default, which starves
      // the page at 4K, so pace them to display frames instead.
      scheduling: denoiseSchedule === 'every-sample' ? 'event-loop' as const : 'animation-frame' as const
    };
    type AuxiliaryGuides = {
      albedo: OIDNWebGPUData;
      normal: OIDNWebGPUData;
    };

    async function denoiseAuxiliaryGuides(): Promise<
      AuxiliaryGuides | undefined
    > {
      const auxiliaryDenoisers = denoiser.auxiliaryDenoisers;
      // Prefilter sampled texture/normal detail for clean-aux weights. The
      // accumulated guides alone are not antialiased at silhouettes and
      // subpixel texture boundaries.
      if (!auxiliaryDenoisers) {
        return {
          albedo: {
            data: copyGuide('OIDN raw albedo', composePass.getOutput('denoiseAlbedo')),
            ...size
          },
          normal: {
            data: copyGuide('OIDN raw normal', getFrameInput('normal')),
            ...size
          }
        };
      }
      if (generation !== denoiseGeneration) return undefined;

      const encodeEncoder = device.createCommandEncoder();
      oidnAlbedoEncodePass.createPass(encodeEncoder, {
        albedo: {
          texture: composePass.getOutput('denoiseAlbedo'),
          channels: 4
        }
      });
      device.queue.submit([encodeEncoder.finish()]);

      let albedoOutput: OIDNWebGPUOutputData | undefined;
      await runOIDNPhase(generation, (finish, fail) =>
        auxiliaryDenoisers.albedo.tileExecute({
          ...convergingTileOptions,
          color: {
            data: oidnAlbedoEncodePass.getOutput('albedo'),
            ...size
          },
          done(output) {
            albedoOutput = output;
            finish();
          },
          error: fail
        })
      );
      if (generation !== denoiseGeneration || !albedoOutput) return undefined;

      const decodeEncoder = device.createCommandEncoder();
      oidnAlbedoDecodePass.setUniform('preserveSurfaceTexture', +false);
      oidnAlbedoDecodePass.createPass(decodeEncoder, {
        albedo: { buffer: albedoOutput.data, channels: 4 },
        rawAlbedo: { texture: composePass.getOutput('denoiseAlbedo'), channels: 4 },
        rawNormal: { texture: getFrameInput('normal'), channels: 4 }
      });
      device.queue.submit([decodeEncoder.finish()]);

      let normalOutput: OIDNWebGPUOutputData | undefined;
      await runOIDNPhase(generation, (finish, fail) =>
        auxiliaryDenoisers.normal.tileExecute({
          ...convergingTileOptions,
          color: {
            data: copyGuide('OIDN raw normal', getFrameInput('normal')),
            ...size
          },
          done(output) {
            normalOutput = output;
            finish();
          },
          error: fail
        })
      );
      if (generation !== denoiseGeneration || !normalOutput) return undefined;

      const normalEncoder = device.createCommandEncoder();
      oidnNormalSanitizePass.createPass(normalEncoder, {
        normal: { buffer: normalOutput.data, channels: 4 }
      });
      device.queue.submit([normalEncoder.finish()]);

      return {
        albedo: {
          data: oidnAlbedoDecodePass.getOutput('albedo'),
          ...size
        },
        normal: {
          data: oidnNormalSanitizePass.getOutput('normal'),
          ...size
        }
      };
    }

    function denoiseComposite(guides: AuxiliaryGuides): Promise<void> {
      if (generation !== denoiseGeneration) return Promise.resolve();
      // Snapshot the complete raw composition; never feed a previous denoise
      // back into the network during progressive updates.
      displayTrace?.push('Denoise:DisplayLinear');
      return runOIDNPhase(generation, (finish, fail) =>
        denoiser.tileExecute({
          ...convergingTileOptions,
          color: { data: colorInput, ...size },
          albedo: guides.albedo,
          normal: guides.normal,
          progress(output, _tileData, _tile, currentIdx, totalIdx) {
            if (generation !== denoiseGeneration) return;
            if (denoiseSchedule !== 'converged' && currentIdx + 1 < totalIdx) return;
            const encoder = device.createCommandEncoder();
            denoisedBuffer = copyDenoisedOutput(encoder, output, denoisedBuffer);
            denoisedDisplayLinear = true;
            denoiseValid = true;
            drawPostProcess(encoder, false);
          },
          done(output) {
            if (generation === denoiseGeneration) {
              const encoder = device.createCommandEncoder();
              denoisedBuffer = copyDenoisedOutput(encoder, output, denoisedBuffer);
              denoisedDisplayLinear = true;
              denoiseValid = true;
              drawPostProcess(encoder, false);
            }
            finish();
          },
          error: fail
        })
      );
    }

    // Denoise alpha channel
    function denoiseComposed(): Promise<void> {
      if (!alphaDenoiser || generation !== denoiseGeneration) {
        return Promise.resolve();
      }
      const encoder = device.createCommandEncoder();
      readbackPass.setSize(renderWidth, renderHeight);
      readbackPass.createPass(encoder, { inputTex: denoisedDisplayLinear ? compositeDenoiseDisplayPass.getOutput('color') : composePass.getOutput('color') });
      const alphaInput = snapshotInput(encoder, 'OIDN alpha input', readbackPass.getOutput('color'));
      device.queue.submit([encoder.finish()]);
      return runOIDNPhase(generation, (finish, fail) =>
        alphaDenoiser.tileExecute({
          ...convergingTileOptions,
          color: { data: alphaInput, ...size },
          denoiseAlpha: true,
          progress(output, _tileData, _tile, currentIdx, totalIdx) {
            if (generation !== denoiseGeneration) return;
            // While-converging denoising keeps the previous complete frame (or the
            // fallback) visible while tiled inference is
            // running. Publishing the shared output buffer before its final
            // tile would expose uninitialized regions as black rectangles.
            if (denoiseSchedule !== 'converged' && currentIdx + 1 < totalIdx) return;
            const encoder = device.createCommandEncoder();
            denoisedBuffer = copyDenoisedOutput(
              encoder,
              output,
              denoisedBuffer
            );
            denoisedDisplayLinear = false;
            denoiseValid = true;
            drawPostProcess(encoder, false);
          },
          done(output) {
            if (generation === denoiseGeneration) {
              const encoder = device.createCommandEncoder();
              denoisedBuffer = copyDenoisedOutput(encoder, output, denoisedBuffer);
              denoisedDisplayLinear = false;
              denoiseValid = true;
              drawPostProcess(encoder, false);
            }
            finish();
          },
          error: fail
        })
      );
    }

    return denoiseAuxiliaryGuides()
      .then(async (guides) => {
        if (guides && generation === denoiseGeneration) {
          await denoiseComposite(guides);
        }
      })
      .then(() => {
        if (
          generation === denoiseGeneration &&
          rayTracePass.needsDenoiseAlpha()
        ) {
          return denoiseComposed();
        }
      })
      .then(() => {
        const completed = generation === denoiseGeneration;

        return completed;
      });
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', _onPageVisiblilityChange);
  }
  function dispose() {
    if (disposed) return;
    if (typeof document !== 'undefined') {
      document.removeEventListener(
        'visibilitychange',
        _onPageVisiblilityChange
      );
    }
    disposed = true;
    tileTimingGeneration++;
    cancelDenoise();
    // Target outputs and timestamp readbacks can still be referenced by the
    // queue. Cancel inference now; retire all GPU-owned target resources after
    // both submitted work and the pending timestamp mapping have completed.
    void Promise.all([
      device.queue.onSubmittedWorkDone().catch(() => undefined),
      diagnosticsReadbackPromise
    ]).then(() => {
      rayTracePass.releaseTarget(targetKey);
      aov.dispose();
      denoisedBuffer?.destroy();
      presentationTexture?.destroy();
      displayPostProcess.dispose();
      rayTraceOutputPass.dispose();
    });
  }

  function activate() {
    rayTracePass.useTarget(targetKey);
    if (renderWidth && renderHeight) rayTracePass.setSize(renderWidth, renderHeight, screenWidth / screenHeight);
    if (execution) {
      rayTracePass.setQuality(execution);
      rayTracePass.setClamping(execution.clamping);
      rayTracePass.setTransmissiveOutputAlphaMin(execution.transmissiveOutputAlphaMin);
      rayTracePass.setBevelSamples(execution.bevelSamples);
      rayTracePass.setAlphaBlendStrategy(execution.alphaBlendStrategy);
      rayTracePass.setSamplingPattern(execution.samplingPattern, execution.maxSamples);
    }
  }

  return {
    invalidateTiming: invalidateTilePrediction,
    invalidateDenoisedOutput() { cancelDenoise(); denoiseValid = false; preserveDenoisedOutput = false; },
    configure(settings: TraceSettings) {
      const timingKeys = ['bounces', 'bevel', 'bevelSamples', 'directLightCandidates', 'dispersionWavelengths', 'alphaBlendStrategy', 'samplingPattern', 'clamping', 'transmissiveOutputAlphaMin', 'caustics'] as const;
      if (!execution || timingKeys.some(key => execution![key] !== settings[key])) invalidateTilePrediction();
      if (settings.aovs?.length && (!Number.isInteger(settings.aovSamples ?? 16) || (settings.aovSamples ?? 16) < 1)) throw new RangeError('aovSamples must be a positive integer');
      const previousMask = aovMask(execution?.aovs ?? []), nextMask = aovMask(settings.aovs ?? []);
      if (previousMask !== nextMask || execution?.aovSamples !== settings.aovSamples) aov.samples = 0;
      execution = { ...settings, aovs: [...(settings.aovs ?? [])] };
      // Presentation may still name the previous preview's AOV. Drop that
      // selection before tracing with a smaller set; Display validates and
      // reapplies the current channel when the new image is presented.
      const displayedAov = displayAovKind(output);
      if (displayedAov && !settings.aovs?.includes(displayedAov)) output = 'final';
      if (previousMask && !nextMask) { aov.dispose(); aov.history.clear(); aov.width = aov.height = 0; aov.reset(); }
      maxTimePerTile = Math.max(1, settings.timeBudgetMs);
      batchSamples = settings.batchSamples;
      tileRender.setDesiredMsPerTile(maxTimePerTile);
      tileRender.setMaxTiles(settings.maxTiles);
      tileRenderWithPredict?.setDesiredMsPerTile(maxTimePerTile);
      tileRenderWithPredict?.setMaxTiles(settings.maxTiles);
    },
    synchronizeBackground,
    activate,
    canCompleteSampleWithin(timeBudgetMs: number) {
      return (lastGpuTraceTiming?.estimatedFullFrameTimeMs ?? elapsedFrameTime) <= timeBudgetMs;
    },
    setRealtimeBatchBudget(milliseconds) { realtimeBatchBudgetMs = milliseconds; },
    setRealtimeDeferPostProcess(defer) { realtimeDeferPostProcess = defer; },
    getRealtimeSampleTime() { return lastGpuTraceTiming?.estimatedFullFrameTimeMs; },
    getRealtimeTileTime() { return lastGpuTraceTiming?.tileTimePerSampleMs; },
    whenTraceAvailable() { return traceQueue.whenAvailable(); },
    get presentationComplete() { return !!presentationTexture; },
    get presentationDenoised() { return presentationDenoised; },
    present() {
      if (!presentationTexture) return;
      surface.configure(hdrOutputActive);
      const encoder = device.createCommandEncoder();
      outputPass.setSize(canvas.width, canvas.height);
      _present(encoder, displayPostProcess.output ?? presentationTexture);
      device.queue.submit([encoder.finish()]);
    },
    getMemory() {
      return {
width: renderWidth, height: renderHeight,
        bytes: aov.bytes + rayTracePass.getTargetMemoryBytes(targetKey) + rayTraceOutputPass.getMemoryBytes() + textureBytes(presentationTexture) + displayPostProcess.getMemoryBytes() + (denoisedBuffer?.size ?? 0)
};
    },
    isFirstFrame() {
      return isFirstFrame;
    },

    restartSamples() {
      aov.reset();
      // Input edits reset accumulation, not learned throughput. Re-arming a
      // hidden probe here starves continuously changing scenes of visible samples.
      tileTimingGeneration++;
      cancelDenoise();
      preserveDenoisedOutput = false;
      denoiseValid = false;
      presentationDenoised = false;
      resolvedSamples = 0; postProcessPending = false; bloomSamples = 0;
      (tileRenderWithPredict || tileRender).reset();
      isPredictingFrame = false;
      isFirstFrame = true;
      sampleCount = 0;
    },

    getOutputTexture(kind) {
      flushPostProcess();
      if (kind === 'hdr') return resolvedSamples > 0 ? getFrameInput('color') : undefined;
      return displayPostProcess.output ?? presentationTexture;
    },
    applyPostProcesses(passes, render) {
      if (presentationTexture) displayPostProcess.run(presentationTexture, passes, render);
    },
    trace,
    drawPostProcess() {
      const resolve = postProcessPending;
      postProcessPending = false;
      drawPostProcess(device.createCommandEncoder(), true, resolve);
    },
    performDenoise,
    cancelDenoise,
    setSize,
    setHDROutputEnabled,
    setToneMappingParams,
    async readPresentation() {
      if (!presentationTexture) throw new Error('Render has no complete image.');
      const image = displayPostProcess.output ?? presentationTexture;
      const width = image.width, height = image.height;
      const bytesPerRow = Math.ceil(width * 16 / 256) * 256;
      const buffer = device.createBuffer({ size: bytesPerRow * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      const encoder = device.createCommandEncoder();
      const presentationReadback=hdrOutputActive && displayAovKind(output) ? scratch.get('AOV encoded readback',()=>new WGPUFullQuadPass('AOV encoded readback',device,{textureWillBeRead:true,inputs:['inputTex'],outputs:['color'],fsMain:`let c=load_inputTex(uv,0);let rgb=select(1.055*pow(max(c.rgb,vec3f(0.0)),vec3f(1.0/2.4))-0.055,12.92*c.rgb,c.rgb<=vec3f(0.0031308));output.color=vec4f(rgb,c.a);`})) : readbackPass;
      presentationReadback.setOutputParams({color:{format:'rgba32float'}});presentationReadback.setSize(width,height);
      presentationReadback.createPass(encoder,{inputTex:image});
      encoder.copyTextureToBuffer({texture:presentationReadback.getOutput('color')},{buffer,bytesPerRow},{width,height});
      device.queue.submit([encoder.finish()]);
      try {
        await buffer.mapAsync(GPUMapMode.READ);
        const mapped = new Float32Array(buffer.getMappedRange());
        const data = new Float32Array(width * height * 4);
        for (let y = 0;y < height;y++) data.set(mapped.subarray(y * bytesPerRow / 4, y * bytesPerRow / 4 + width * 4), y * width * 4);
        return { width, height, data };
      } finally { buffer.unmap(); buffer.destroy(); }
    },
    aovReady(kind) { return !!execution?.aovs?.includes(kind) && aov.samples > 0; },
    getAovSamples() { return aov.samples; },
    restartAovs() { aov.reset(); },
    refineAovs(camera, samples = sampleCount) {
      if (samples < 1 || !execution?.aovs?.length) return true;
      rayTracePass.setCamera(camera); aovCamera = camera;
      rayTracePass.updatePipeline();
      if (rayTracePass.isCompilingShader() || !rayTracePass.isPipelineReady()) return false;
      return rayTracePass.renderAovs(aov, camera, samples, execution.aovSamples ?? 16, execution.aovs);
    },
    async readAov(kind) {
      if (!execution?.aovs?.includes(kind) || !aovCamera || (sampleCount < 1 && aov.samples < 1)) throw new Error('AOV output is not ready');
      rayTracePass.setCamera(aovCamera);
      while (!rayTracePass.renderAovs(aov, aovCamera, Math.max(sampleCount, aov.samples), execution.aovSamples ?? 16, execution.aovs)) {
        if (disposed) throw new Error('AOV compilation was interrupted');
        await new Promise<void>(resolve => scheduleFrame(() => resolve()));
      }
      return aov.read(kind);
    },
    async readOutput(kind) {
      flushPostProcess();
      rawOutputPass.setUniform('flatBackgroundColor', resolvedFlatBackground);
      const width = renderWidth, height = renderHeight;
      const bytesPerRow = Math.ceil(width * 16 / 256) * 256;
      const buffer = device.createBuffer({
        size: bytesPerRow * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
      });
      const encoder = device.createCommandEncoder();
      const denoised = kind === 'denoised' && denoiseValid ? denoisedBuffer : undefined;
      if (kind === 'denoised' && !denoised) kind = 'hdr';
      const pass = kind === 'hdr' ? rawOutputPass : readbackPass;
      pass.setOutputParams({ color: { format: 'rgba32float' } });
      pass.setSize(width, height);
      if (denoised) {
        encoder.copyBufferToBuffer(denoised, 0, buffer, 0, width * height * 16);
      } else if (kind === 'hdr') {
        rawOutputPass.createPass(encoder, { colorTex: getFrameInput('color'), coverageTex: getFrameInput('albedo') });
      } else {
        readbackPass.createPass(encoder, { inputTex: getFrameInput(kind as 'albedo' | 'normal') });
      }
      if (!denoised) encoder.copyTextureToBuffer({ texture: pass.getOutput('color') }, { buffer, bytesPerRow }, { width, height, depthOrArrayLayers: 1 });
      device.queue.submit([encoder.finish()]);
      try {
        await buffer.mapAsync(GPUMapMode.READ);
        const mapped = new Float32Array(buffer.getMappedRange());
        const data = new Float32Array(width * height * 4);
        const stride = denoised ? width * 4 : bytesPerRow / 4;
        for (let y = 0;y < height;y++) data.set(mapped.subarray(y * stride, y * stride + width * 4), y * width * 4);
        return { data, width, height };
      } finally { buffer.unmap(); buffer.destroy(); }
    },

    setPreserveDenoisedOutput(preserve: boolean) {
      preserveDenoisedOutput = preserve;
    },
    setOfflineRenderOptions(options) {
      const wasOffline = offlineSamplesPerBatch > 0;
      offlineSamplesPerBatch = Math.max(0, Math.round(options.samplesPerBatch));
      deferPostProcess = options.deferPostProcess;
      sampleSequenceOffset = Math.max(
        0,
        Math.round(options.sampleSequenceOffset)
      );
      if (offlineSamplesPerBatch > 0 && isPredictingFrame) {
        (tileRenderWithPredict || tileRender).reset();
        isPredictingFrame = false;
      }
      if (offlineSamplesPerBatch > 0) needsUpdatePredicting = false;
      else if (wasOffline) invalidateTilePrediction();
    },
    setVarianceMoments(enabled: boolean) {
      rayTracePass.setVarianceMoments(enabled);
    },
    setAdaptiveSamplingTargets(targets) {
      rayTracePass.setAdaptiveSamplingTargets(targets);
    },
    prepareOfflineAdaptiveSampling(options) {
      return rayTracePass.prepareOfflineAdaptiveSampling(options);
    },

    getTotalSamplesRendered() {
      return sampleCount;
    },

    /** @internal */
    _displayParity() {
      return {
        record(trace?: string[]) { displayTrace = trace; },
        load(input: DisplayParityAccumulation) {
          cancelDenoise(); clearDenoisedOutput();
          setSize(input.width, input.height);
          rayTracePass.useTarget(targetKey);
          rayTracePass.setSize(renderWidth, renderHeight, screenWidth / screenHeight);
          const buffers = rayTracePass.getOutputBuffer();
          const shadow = new Float32Array(input.width * input.height * 12);
          for (let i = 0; i < input.width * input.height; i++) {
            shadow.set(input.shadow.subarray(i * 8, i * 8 + 8), i * 12);
            shadow.set(input.moments.subarray(i * 4, i * 4 + 4), i * 12 + 8);
          }
          for (const [buffer, data] of [[buffers.color, input.color], [buffers.albedo, input.albedo],
            [buffers.normal, input.normal], [buffers.shadowCatcher, shadow]] as const) device.queue.writeBuffer(buffer, 0, data);
          sampleCount = resolvedSamples = input.samples;
          resolvedHasShadowCatcher = input.catcher;
          isFirstFrame = false; postProcessPending = false; bloomSamples = 0;
          rayTraceOutputPass.setSampleCount(sampleCount);
          rayTraceOutputPass.setSampleTileGrid(1, 1);
          const encoder = device.createCommandEncoder();
          rayTraceOutputPass.createPass(encoder, buffers, resolvedHasShadowCatcher);
          device.queue.submit([encoder.finish()]);
        }
      };
    },

    getDiagnostics() {
      return {
        ...rayTracePass.getDiagnostics(),
        hdrPresentation: {
          requested: hdrOutputRequested,
          active: surface.hdr,
          peakDisplayValue: surface.hdr
            ? hdrPeakMeter?.getPeakDisplayValue()
            : undefined
        },
        gpuTraceTiming: lastGpuTraceTiming
      };
    },

    async flushDiagnostics() {
      await device.queue.onSubmittedWorkDone();
      await diagnosticsReadbackPromise;
    },

    setBloomParams({ intensity, threshold, radius }) {
      const changed =
        threshold !== bloomThreshold ||
        intensity !== bloomIntensity ||
        radius !== bloomRadius;
      if (changed) invalidateCompositeDenoise();
      bloomThreshold = threshold;
      bloomIntensity = intensity;
      bloomRadius = radius;
      return changed;
    },

    setShadowCatcherParams(color: ColorRGB, alpha: number) {
      const changed =
        color[0] !== shadowCatcherColor[0] ||
        color[1] !== shadowCatcherColor[1] ||
        color[2] !== shadowCatcherColor[2] ||
        alpha !== shadowCatcherAlpha;

      if (changed) {
        vec3.copy(shadowCatcherColor, color);
        shadowCatcherAlpha = alpha;

        composePass.setUniform('shadowCatcherColor', color);
        composePass.setUniform('shadowCatcherAlpha', alpha);
      }

      return changed;
    },

    setOnSampleRendered(
      cb: (
        sampleCount: number,
        isFirstFrame: boolean,
        frameTime: number
      ) => void
    ) {
      sampleRenderedCallback = cb;
    },

    setAovDisplayOptions(options: AovDisplayOptions) { aovDisplayOptions={...options,depthRange:[...options.depthRange]}; },
    setOutput(nextOutput: DisplayChannel) {
      if (output === nextOutput) return false;
      output = nextOutput;
      return true;
    },

    dispose
  } satisfies TargetPipeline & DisplayParityTarget;
}

/** Independent render targets, without preview or presentation policy. */
export function makeWGPURenderTargets(canvas: HTMLCanvasElement | OffscreenCanvas, device: GPUDevice, options: WGPURenderingPipelineOptions = {}): RenderPipeline {
  const rayTracePass = new WGPURayTracePass(device, options.materialTextures);
  const traceQueue = new GPUTraceQueue(device.queue);
  const customJobs = new Set<Promise<unknown>>();
  const scratch = new ScratchPool(work => {
    // A cancelled custom filter can keep submitting GPU work until its promise settles.
    // A custom callback can dispose synchronously, before its promise is recorded.
    // Observe leases after that callback returns so its borrowed inputs stay alive.
    void Promise.resolve().then(() => Promise.allSettled([...customJobs]))
      .then(() => device.queue.onSubmittedWorkDone()).catch(() => {}).then(work);
  });
  const surface = scratch.get('canvas', () => new WGPUCanvasSurface(canvas, device, options.presentationFormat ?? navigator.gpu.getPreferredCanvasFormat()));
  return makeRenderPipeline(rayTracePass, () => {
    const target = makeWGPUAccumulationTarget(canvas, device, rayTracePass, surface, scratch, customJobs, traceQueue);
    return target;
  }, false, scratch);
}
