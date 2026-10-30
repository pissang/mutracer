import type {DisplayParityAccumulation, DisplayParityTarget} from './displayParityDiagnostics.js';
import {displayAovKind, DEFAULT_AOV_DISPLAY, type AovDisplayOptions} from './aovDisplay.js';
import {WebGLAov} from './WebGLAov.js';
import {aovMask} from './aov.js';
import {scheduleFrame} from '../util/frame.js';
import type {DenoiserHandle} from './denoiser.js';
import { WebGLScratchCopy } from './WebGLScratchCopy.js';
import { ScratchPool } from './ScratchPool.js';
import { makeRenderPipeline, type TraceSettings, type RenderPipeline } from './renderPipeline.js';
import type { TargetPipeline } from './accumulationTarget.js';
import { readRgbaPixels } from './WebGLReadback.js';
// Portions adapted from ray-tracing-renderer@0.10.15
// (https://github.com/hoverinc/ray-tracing-renderer).
// Copyright (c) 2019 HOVER, MIT license; see LICENSES/RayTracingRenderer-MIT.txt.

import Camera from '../scene/Camera.js';
import type { ColorRGB } from '../types.js';
import { vec3 } from '../math.js';
import halton from './halton.js';
import { makeTileRender } from './TileRender.js';
import type {
  DisplayChannel,
  ToneMappingParams
} from './RenderingPipeline.js';
import { constants, WebGLDevice, Texture2D } from './webgl.js';
import { WebGLFullQuadPass } from './WebGLFullQuadPass.js';
import WebGLRayTracePass from './WebGLRayTracePass.js';
import { WebGLRayTraceOutputPass } from './WebGLRayTraceOutputPass.js';
import WebGLBloomPass from './WebGLBloomPass.js';
import {
  composeFragment,
  outputFragment
} from './glsl/webglPipeline.frag.js';
import { type JNLMDenoiser } from './jnlm.js';
import { WebGLJNLMDenoisePass } from './WebGLJNLMDenoiser.js';


/**
 * WebGL 2.0 counterpart of WGPURenderingPipeline.
 *
 * The frame is encoded as a fixed pass sequence. Each pass owns explicit
 * textures/FBOs, so no compositor graph or node lifecycle participates here.
 */
function makeWebGLAccumulationTarget(renderer: WebGLDevice, rayTracePass: WebGLRayTracePass, scratch: ScratchPool) {
  let sampleRenderedCallback = (
    _sampleCount: number,
    _isFirstFrame: boolean,
    _frameTime: number
  ) => { };
  let batchSamples = false;
  let offlineSamplesPerBatch = 0;
  let deferPostProcess = false;
  let sampleSequenceOffset = 0;
  const aov=new WebGLAov(renderer);
  let aovCamera: Camera | undefined;
  let displayTrace: string[] | undefined;
  let sampleCount = 0;
  let elapsedFrameTime = 32;
  let elapsedTileTime: number | undefined;
  let tileTimingGeneration = 0;
  let isFirstFrame = true;
  let renderFailed = false;
  let disposed = false;
  let renderWidth = 1;
  let renderHeight = 1;
  let screenWidth = 1;
  let screenHeight = 1;

  const targetKey = {};
  let execution: TraceSettings | undefined;

  let resolvedSamples = 0;
  let resolvedHasShadowCatcher = false;
  let presentationTexture: Texture2D | undefined;
  let presentationDenoised = false;

  let maxTimePerTile = 21;

  let bloomIntensity = 0;
  let bloomThreshold = 1;
  let bloomRadius = 0.6;
  let exposure = 1;
  let toneMappingMode = 0;
  let contrast = 1;
  let saturation = 1;
  let temperature = 0;
  let tint = 0;
  let vignette = 0;
  let output: DisplayChannel = 'final';
  let aovDisplayOptions: AovDisplayOptions = DEFAULT_AOV_DISPLAY;
  let pageLeaveTime = performance.now();
  let pageInvisibleTime = 0;
  const shadowCatcherColor = vec3.create();
  let shadowCatcherAlpha = 1;

  // Preview frames have a different resolution, bounce limit, and timing
  // target. Keep their measurements out of the full-resolution estimator so
  // returning from preview does not split a 4K sample into hundreds of tiles.
  const tileRender = makeTileRender(renderer.gl);
  tileRender.setDesiredMsPerTile(maxTimePerTile);

  const rayTraceOutputPass = new WebGLRayTraceOutputPass(renderer);
  let bloomPass: WebGLBloomPass | undefined;

  const composePass = scratch.get('composePass', () => new WebGLFullQuadPass<
    'colorTex' | 'foregroundTex' | 'catcherBackgroundTex' | 'shadowCatcherTex' | 'bloomTex',
    'color'
  >('compose', renderer, {
    shader: composeFragment,
    outputs: ['color'],
    outputParams: { color: { type: constants.UNSIGNED_BYTE } }
  }));
  composePass.setUniforms({
    exposure,
    shadowCatcherColor,
    shadowCatcherAlpha,
    shadowCatcherEnabled: 0,
    bloomIntensity: 0,
    toneMappingMode,
    contrast,
    saturation,
    temperature,
    tint,
    vignette,
    outputMode: 0,
    sRGBOutput: 1
  });

  const outputPass = scratch.get('outputPass', () => new WebGLFullQuadPass<
    'colorTex' | 'colorDenoisedTex',
    'color'
  >('output', renderer, { shader: outputFragment, outputs: ['color'] }));
  outputPass.setRenderToScreen();
  const copy = scratch.get('image copy', () => new WebGLScratchCopy(renderer));
  const rawReadFrameBuffer = copy.readFrameBuffer;

  // Built-in JNLM denoising. WebGL runs it synchronously inside the
  // post-process, between composition and output.
  let jnlmPass: WebGLJNLMDenoisePass | undefined;
  let pendingDenoiser: JNLMDenoiser | undefined;
  let denoisedTexture: Texture2D | undefined;
  let denoiseValid = false;
  // Keep the last denoised image visible while while-converging batches
  // accumulate (see RenderingPipeline.setPreserveDenoisedOutput).
  let preserveDenoisedOutput = false;

  function updateSeed(useJitter: boolean) {
    const sequenceSample = sampleCount + sampleSequenceOffset;
    const jitterX = useJitter ? halton(sequenceSample, 2) - 0.5 : 0;
    const jitterY = useJitter ? halton(sequenceSample, 3) - 0.5 : 0;
    rayTracePass.setJitter(jitterX / renderWidth, jitterY / renderHeight);
  }

  function traceSample(
    clear: boolean,
    tile: { x: number; y: number; width: number; height: number }
  ) {
    rayTracePass.setSampleCount(sampleCount + sampleSequenceOffset);
    rayTracePass.setSampleSequenceOffset(sampleSequenceOffset);
    updateSeed(true);
    if (rayTracePass.hasDispersion()) {
      if (execution?.dispersionWavelengths === 1) {
        // A positive channel enables stochastic hero-wavelength sampling in
        // the shader. Preview traces one random RGB channel per pixel.
        rayTracePass.setSpectralChannel(1);
        rayTracePass.createPass(clear, tile);
      } else {
        for (let channel = 1; channel <= 3; channel++) {
          rayTracePass.setSpectralChannel(channel);
          rayTracePass.createPass(clear && channel === 1, tile, channel > 1);
        }
      }
    } else {
      rayTracePass.setSpectralChannel(0);
      rayTracePass.createPass(clear, tile);
    }
  }

  function drawPostProcess(_forceNeedsDenoise = false, resolve = false) {
    if (resolve) { resolvedSamples = sampleCount; resolvedHasShadowCatcher = rayTracePass.hasShadowCatcher(); }
    const aovKind = displayAovKind(output);
    if (aovKind && sampleCount === 0) {
      if (!execution?.aovs?.includes(aovKind)) throw new Error(`AOV ${aovKind} is not enabled`);
      if (!aov.samples) return;
      presentationTexture = copy.copy(aov.visualize(aovKind,aovDisplayOptions), renderWidth, renderHeight, presentationTexture);
      presentationDenoised = false;
      return;
    }
    if (resolvedSamples === 0) return;
    if (resolve) {
      rayTraceOutputPass.setSampleCount(sampleCount);
      rayTraceOutputPass.createPass(rayTracePass);
    }

    composePass.setSize(renderWidth, renderHeight);
    composePass.setUniforms({ exposure, toneMappingMode, contrast, saturation, temperature, tint, vignette, shadowCatcherColor, shadowCatcherAlpha });
    const colorTexture = rayTraceOutputPass.getOutput('color');
    const bloomEnabled = bloomIntensity > 0;
    const samplesSkipped = sampleCount < 10 || sampleCount % 10 > 0;
    const bloomState = scratch.get('bloom state', () => ({ owner: undefined as object | undefined, settings: '', dispose() { } }));
    const bloomSettings = `${bloomThreshold}/${bloomRadius}`;
    const needsUpdateBloom = bloomEnabled && sampleCount >= 10 && (!samplesSkipped || bloomState.owner !== targetKey || bloomState.settings !== bloomSettings);
    let currentBloomIntensity = bloomIntensity;
    if (needsUpdateBloom) {
      bloomPass ||= scratch.get('bloom', () => new WebGLBloomPass(renderer));
      bloomPass.setSize(renderWidth, renderHeight);
      bloomState.owner = targetKey; bloomState.settings = bloomSettings;
      bloomPass.setBrightThreshold(bloomThreshold);
      bloomPass.setRadius(bloomRadius);
      displayTrace?.push('Bloom:SceneLinear');
      bloomPass.createPass(colorTexture);
    } else if (bloomEnabled && sampleCount < 10) {
      currentBloomIntensity = 0;
    }

    composePass.setUniforms({
      bloomIntensity: currentBloomIntensity,
      shadowCatcherEnabled: +resolvedHasShadowCatcher,
      outputMode: output === 'shadow' ? 1 : 0
    });
    displayTrace?.push('Compose:DisplayEncoded');
    composePass.createPass({
      colorTex: colorTexture,
      foregroundTex: rayTraceOutputPass.getOutput('foreground'),
      catcherBackgroundTex: rayTraceOutputPass.getOutput('catcherBackground'),
      shadowCatcherTex: rayTraceOutputPass.getOutput('shadowCatcher'),
      bloomTex:
        bloomEnabled && bloomPass
          ? bloomPass.getOutput()
          : renderer.emptyTexture
    });

    if (pendingDenoiser) {
      jnlmPass ??= scratch.get('jnlm', () => new WebGLJNLMDenoisePass(renderer));
      const filtered = jnlmPass.render({
        width: renderWidth,
        height: renderHeight,
        moments: rayTracePass.getOutput('moments'),
        catcherMoments: rayTracePass.hasShadowCatcher()
          ? rayTracePass.getOutput('catcherMoments')
          : undefined,
        color: composePass.getOutput('color'),
        albedo: rayTraceOutputPass.getOutput('albedo'),
        normal: rayTraceOutputPass.getOutput('normal'),
        shadowCatcher: rayTraceOutputPass.getOutput('shadowCatcher'),
        strength: pendingDenoiser.strength,
        shape: pendingDenoiser.shape
      }, displayTrace);
      denoisedTexture = copy.copy(filtered, renderWidth, renderHeight, denoisedTexture); denoiseValid = true;
      pendingDenoiser = undefined;
    }

    let displayTexture =
      (output === 'final' && denoiseValid && denoisedTexture) || composePass.getOutput('color');
    if (aovKind) {
      if (!execution?.aovs?.includes(aovKind)) throw new Error(`AOV ${aovKind} is not enabled`);
      displayTexture = aov.visualize(aovKind,aovDisplayOptions);
    } else if (output === 'normal' || output === 'albedo') {
      displayTrace?.push('AOV:Raw');
      displayTexture = rayTraceOutputPass.getOutput(output);
    } else if (output === 'shadowCatcher') {
      displayTrace?.push('AOV:Raw');
      displayTexture = rayTraceOutputPass.getOutput('shadowCatcher');
    }
    presentationTexture = copy.copy(displayTexture, renderWidth, renderHeight, presentationTexture);
    presentationDenoised = output === 'final' && denoiseValid && !!denoisedTexture;

  }

  function startRecordFrameTime(collectTileTiming: boolean) {
    const start = performance.now();
    const generation = tileTimingGeneration;
    const timedTileRender = tileRender;
    scheduleFrame(() => {
      elapsedFrameTime = Math.max(
        performance.now() - start - pageInvisibleTime,
        pageInvisibleTime > 0 ? 16 : 8
      );
      pageInvisibleTime = 0;
      if (
        generation === tileTimingGeneration &&
        timedTileRender === tileRender && !isFirstFrame
      ) {
        elapsedTileTime = collectTileTiming && renderer.isAllProgramCompiled()
          ? elapsedFrameTime : undefined;
      }
    });
  }

  function trace(camera: Camera, maxSamples: number) {
    if (rayTracePass.isInvalid() || renderFailed) return false;
    if (!renderer.isAllProgramCompiled()) {
      isFirstFrame = true;
      sampleCount = 0;
      tileRender.reset();
      return true;
    }

    rayTracePass.setCamera(camera);
    aovCamera=camera;
    if (!rayTracePass.preparePrograms()) return true;
    const resetAccumulation = isFirstFrame;
    if(resetAccumulation) aov.reset();
    if (execution?.aovs?.length && !rayTracePass.prepareAovs(aov,camera,renderWidth,renderHeight,execution.aovs)) return true;
    if (resetAccumulation) {
      tileTimingGeneration++;
      elapsedTileTime = undefined;
      rayTracePass.setCamera(camera);
      tileRender.reset();
      sampleCount = 0;
      isFirstFrame = false;
    }
    if (sampleCount >= maxSamples) {
      drawPostProcess(true);
      return false;
    }
    // New samples make the denoised image stale.
    if (!preserveDenoisedOutput || resetAccumulation) denoiseValid = false;

    // The first draw after an update lazily prepares scene data and shaders.
    // Keep its wall time for reporting, but not for estimating tile throughput.
    startRecordFrameTime(!resetAccumulation);
    const frameSampleCount = sampleCount;
    let tile = tileRender.nextTile(elapsedTileTime);
    if (offlineSamplesPerBatch > 0 && tile.isFirstTile && tile.isLastTile) {
      tile.samplesPerFrame = offlineSamplesPerBatch;
    } else if (
      !batchSamples ||
      !(tile.isFirstTile && tile.isLastTile)
    ) {
      tile.samplesPerFrame = 1;
    }

    try {
      for (let i = 0;i < tile.samplesPerFrame && sampleCount < maxSamples;i++) {
        traceSample(sampleCount === 0 && tile.isFirstTile, {
          x: tile.x,
          y: tile.y,
          width: tile.tileWidth,
          height: tile.tileHeight
        });
        if (tile.isLastTile) sampleCount++;
      }
      if(sampleCount!==frameSampleCount){
      if(execution?.aovs?.length) rayTracePass.renderAovs(aov,camera,renderWidth,renderHeight,Math.max(sampleCount,aov.samples),execution.aovSamples ?? 16,execution.aovs,sampleSequenceOffset);
      }
      if (sampleCount !== frameSampleCount && (!deferPostProcess || sampleCount >= maxSamples)) {
        drawPostProcess(sampleCount >= maxSamples, true);
      }
    } catch (error) {
      console.error(error);
      renderFailed = true;
      return false;
    }

    if (sampleCount !== frameSampleCount) {
      sampleRenderedCallback(
        sampleCount,
        frameSampleCount === 0,
        elapsedFrameTime
      );

    }
    return !renderer.isAllProgramCompiled();
  }

  function applyRenderResolution() {
    rayTracePass.useTarget(targetKey);
    const scale = 1;
    const nextWidth = Math.max(1, Math.round(screenWidth * scale));
    const nextHeight = Math.max(1, Math.round(screenHeight * scale));
    rayTracePass.setSize(nextWidth, nextHeight, screenWidth / screenHeight);
    if (nextWidth === renderWidth && nextHeight === renderHeight) return;
    renderWidth = nextWidth;
    renderHeight = nextHeight;
    tileRender.setSize(renderWidth, renderHeight);
    rayTraceOutputPass.setSize(renderWidth, renderHeight);
    composePass.setSize(renderWidth, renderHeight);
    bloomPass?.setSize(renderWidth, renderHeight);
    sampleCount = 0;
    resolvedSamples = 0;
    isFirstFrame = true;

  }

  function setSize(width: number, height: number) {
    width = Math.max(1, width);
    height = Math.max(1, height);
    if (width === screenWidth && height === screenHeight) return;
    screenWidth = width;
    screenHeight = height;

    outputPass.setSize(screenWidth, screenHeight);
    applyRenderResolution();
    sampleCount = 0;
    isFirstFrame = true;
  }

  function onVisibilityChange() {
    if (document.hidden) pageLeaveTime = performance.now();
    else pageInvisibleTime = performance.now() - pageLeaveTime;
  }
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibilityChange);

  function activate() {
    rayTracePass.useTarget(targetKey);
    rayTracePass.setSize(renderWidth, renderHeight, screenWidth / screenHeight);
    if (execution) {
      rayTracePass.setQuality(execution);
      rayTracePass.setClamping(execution.clamping);
      rayTracePass.setTransmissiveOutputAlphaMin(execution.transmissiveOutputAlphaMin);
      rayTracePass.setBevelSamples(execution.bevelSamples);
      rayTracePass.setSamplingPattern(execution.samplingPattern, execution.maxSamples);
    }
  }

  return {
    invalidateDenoisedOutput() { pendingDenoiser = undefined; denoiseValid = false; preserveDenoisedOutput = false; },
    synchronizeBackground() { },
    configure(settings: TraceSettings) {
      if(settings.aovs?.length && (!Number.isInteger(settings.aovSamples ?? 16) || (settings.aovSamples ?? 16)<1)) throw new RangeError('aovSamples must be a positive integer');
      const previousMask = aovMask(execution?.aovs ?? []), nextMask = aovMask(settings.aovs ?? []);
      if (previousMask !== nextMask || execution?.aovSamples !== settings.aovSamples) aov.samples = 0;
      execution = { ...settings, aovs: [...(settings.aovs ?? [])] };
      // A reduced preview set can retire the previously displayed AOV before
      // Display applies its next channel after tracing.
      const displayedAov = displayAovKind(output);
      if (displayedAov && !settings.aovs?.includes(displayedAov)) output = 'final';
      if(previousMask && !nextMask){aov.dispose();aov.history.clear();aov.width=aov.height=0;aov.reset();}
      maxTimePerTile = Math.max(1, settings.timeBudgetMs);
      batchSamples = settings.batchSamples;
      tileRender.setDesiredMsPerTile(maxTimePerTile);
      tileRender.setMaxTiles(settings.maxTiles);
    },
    activate,
    canCompleteSampleWithin(timeBudgetMs: number) { return elapsedFrameTime <= timeBudgetMs; },
    getOutputTexture() { return undefined; },
    applyPostProcesses() {},
    get presentationComplete() { return !!presentationTexture; },
    get presentationDenoised() { return presentationDenoised; },
    present() {
      if (!presentationTexture) return;
      {

        outputPass.setSize(renderer.canvas.width, renderer.canvas.height);
      }
      outputPass.setUniform('denoisedPercent', 0);
      outputPass.createPass({ colorTex: presentationTexture, colorDenoisedTex: presentationTexture });
    },
    getMemory() {
      return {
        width: renderWidth, height: renderHeight,
        bytes: aov.bytes + rayTracePass.getTargetMemoryBytes(targetKey)
          + rayTraceOutputPass.getMemoryBytes() + (presentationTexture?.getMemoryBytes() ?? 0) + (denoisedTexture?.getMemoryBytes() ?? 0)
      };
    },
    isFirstFrame: () => isFirstFrame,
    restartSamples(_preserveTemporalHistory = false) {
      aov.reset();
      tileRender.reset();
      isFirstFrame = true;
      sampleCount = 0;
      denoiseValid = false;
      preserveDenoisedOutput = false;
    },
    /** Denoises the current image. WebGL only supports the built-in JNLM filter. */
    performDenoise(filter: DenoiserHandle): Promise<boolean> {
      if (filter.kind !== 'jnlm') {
        return Promise.reject(new Error('This denoiser requires WebGPU.'));
      }
      if (isFirstFrame || sampleCount < 1) return Promise.resolve(false);
      if (output !== 'final' && output !== 'shadow') return Promise.resolve(true);
      pendingDenoiser = filter.denoiser;
      drawPostProcess(true);
      return Promise.resolve(true);
    },
    cancelDenoise() {
      pendingDenoiser = undefined;
    },
    setPreserveDenoisedOutput(preserve: boolean) {
      preserveDenoisedOutput = preserve;
    },
    trace,
    drawPostProcess: () => drawPostProcess(true),
    setSize,
    setToneMappingParams(params: ToneMappingParams) {
      const nextExposure = params.exposure ?? 1;
      const nextToneMappingMode = {
        agx: 0,
        aces: 1,
        cineon: 2,
        reinhard: 3,
        linear: 4
      }[params.toneMapping ?? 'agx'] ?? 0;
      const nextContrast = params.contrast ?? 1;
      const nextSaturation = params.saturation ?? 1;
      const nextTemperature = params.temperature ?? 0;
      const nextTint = params.tint ?? 0;
      const nextVignette = params.vignette ?? 0;
      if (
        nextExposure === exposure &&
        nextToneMappingMode === toneMappingMode &&
        nextContrast === contrast &&
        nextSaturation === saturation &&
        nextTemperature === temperature &&
        nextTint === tint &&
        nextVignette === vignette
      ) return false;
      exposure = nextExposure;
      toneMappingMode = nextToneMappingMode;
      contrast = nextContrast;
      saturation = nextSaturation;
      temperature = nextTemperature;
      tint = nextTint;
      vignette = nextVignette;
      composePass.setUniforms({
        exposure,
        toneMappingMode,
        contrast,
        saturation,
        temperature,
        tint,
        vignette
      });
      return true;
    },
    setOfflineRenderOptions(options) {
      offlineSamplesPerBatch = Math.max(0, Math.round(options.samplesPerBatch));
      deferPostProcess = options.deferPostProcess;
      sampleSequenceOffset = Math.max(
        0,
        Math.round(options.sampleSequenceOffset)
      );
    },
    setVarianceMoments(_enabled: boolean) { },
    setAdaptiveSamplingTargets(_targets) { },
    async prepareOfflineAdaptiveSampling(_options) {
      return undefined;
    },
    getTotalSamplesRendered: () => sampleCount,
    /** @internal */
    _displayParity() {
      return {
        record(trace?: string[]) { displayTrace = trace; },
        load(input: DisplayParityAccumulation) {
          setSize(input.width, input.height);
          denoiseValid = false; pendingDenoiser = undefined;
          const texture = (data: Float32Array) => {
            const t = new Texture2D({width: input.width, height: input.height,
              source: {data, width: input.width, height: input.height}, type: constants.FLOAT,
              minFilter: constants.NEAREST, magFilter: constants.NEAREST});
            return t;
          };
          const shadow = Float32Array.from({length: input.width * input.height * 4}, (_, i) =>
            i % 4 === 3 ? input.moments[Math.floor(i / 4) * 4 + 2] : input.shadow[Math.floor(i / 4) * 8 + i % 4]);
          const background = Float32Array.from(shadow, (_, i) => input.shadow[Math.floor(i / 4) * 8 + 4 + i % 4]);
          const inputs = {color: texture(input.color), albedo: texture(input.albedo), normal: texture(input.normal),
            moments: texture(Float32Array.from(input.moments, (v, i) => i % 4 === 2 ? input.samples : v)),
            shadowCatcher: texture(shadow), catcherBackground: texture(background), catcherMoments: texture(input.moments)};
          rayTracePass._loadDiagnosticAccumulation(inputs, input.catcher);
          sampleCount = resolvedSamples = input.samples;
          resolvedHasShadowCatcher = input.catcher; isFirstFrame = false;
          rayTraceOutputPass.setSize(renderWidth, renderHeight);
          rayTraceOutputPass.setSampleCount(sampleCount);
          rayTraceOutputPass.createPass(rayTracePass);
        }
      };
    },
    getDiagnostics: () => ({ ...rayTracePass.getDiagnostics(), shaderCompilation: renderer.getShaderCompilationDiagnostics() }),
    flushDiagnostics: async () => { },
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
    setBloomParams({ intensity, threshold, radius }) {
      const changed =
        intensity !== bloomIntensity ||
        threshold !== bloomThreshold ||
        radius !== bloomRadius;
      bloomIntensity = intensity;
      bloomThreshold = threshold;
      bloomRadius = radius;
      return changed;
    },
    setOnSampleRendered(cb) {
      sampleRenderedCallback = cb;
    },

    setAovDisplayOptions(options: AovDisplayOptions) { aovDisplayOptions={...options,depthRange:[...options.depthRange]}; },
    setOutput(nextOutput: DisplayChannel) {
      if (output === nextOutput) return false;
      output = nextOutput;
      return true;
    },
    async readPresentation() {
      if (!presentationTexture) throw new Error('Render has no complete image.');
      rawReadFrameBuffer.bind(renderer, [presentationTexture]);
      const width = presentationTexture.width, height = presentationTexture.height;
      return { width, height, data: readRgbaPixels(renderer.gl, width, height, presentationTexture.isByteEncoded) };
    },
    aovReady(kind) { return !!execution?.aovs?.includes(kind) && aov.samples > 0; },
    getAovSamples() { return aov.samples; },
    restartAovs() { aov.reset(); },
    refineAovs(camera, samples = sampleCount) {
      if (samples < 1 || !execution?.aovs?.length) return true;
      rayTracePass.setCamera(camera); aovCamera = camera;
      return rayTracePass.renderAovs(aov,camera,renderWidth,renderHeight,samples,execution.aovSamples ?? 16,execution.aovs,sampleSequenceOffset);
    },
    async readAov(kind) {
      if(!execution?.aovs?.includes(kind) || !aovCamera || (sampleCount<1 && aov.samples<1)) throw new Error('AOV output is not ready');
      rayTracePass.setCamera(aovCamera);
      while (!rayTracePass.renderAovs(aov,aovCamera,renderWidth,renderHeight,Math.max(sampleCount,aov.samples),execution.aovSamples ?? 16,execution.aovs,sampleSequenceOffset)) {
        if (disposed || renderer.gl.isContextLost()) throw new Error('AOV compilation was interrupted');
        await new Promise<void>(resolve => scheduleFrame(() => resolve()));
      }
      return aov.read(kind);
    },
    async readOutput(kind) {
      if (kind === 'denoised' && (!denoisedTexture || !denoiseValid)) kind = 'hdr';
      const texture = kind === 'denoised' ? denoisedTexture! : rayTraceOutputPass.getOutput(kind === 'hdr' ? 'color' : kind);
      rawReadFrameBuffer.bind(renderer, [texture]);
      return { data: readRgbaPixels(renderer.gl, renderWidth, renderHeight, kind === 'albedo' || kind === 'normal'), width: renderWidth, height: renderHeight };
    },
    dispose() {
      if (disposed) return; disposed = true;
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibilityChange);

      aov.dispose();
      rayTracePass.releaseTarget(targetKey);
      rayTraceOutputPass.dispose();
      presentationTexture?.dispose(renderer.gl);
      denoisedTexture?.dispose(renderer.gl);
    }
  } satisfies TargetPipeline & DisplayParityTarget;
}

/** Independent render targets, without preview or presentation policy. */
export function makeWebGLRenderTargets(renderer: WebGLDevice): RenderPipeline {
  const rayTracePass = new WebGLRayTracePass(renderer);
  const scratch = new ScratchPool();
  return makeRenderPipeline(rayTracePass, () => makeWebGLAccumulationTarget(renderer, rayTracePass, scratch), true, scratch);
}
