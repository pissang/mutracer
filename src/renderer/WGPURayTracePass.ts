import {causticDiagnostics} from './causticDiagnostics.js';
import {WGPUPhotonMap, photonRadius} from './WGPUPhotonMap.js';
import {CausticSeedCache} from './causticSeeds.js';
import {causticEmissionTable} from './causticEmission.js';
import {WGPUCausticLightPass} from './WGPUCausticLightPass.js';
import {causticLightCompute} from './wgsl/causticLight.compute.js';
import {
  causticCasterSpheres,
  hasStochasticCausticCaster,
  causticCasterSphere,
  isCausticSpecular
} from './caustics.js';
import {AovPrimitiveCache} from './AovPrimitiveCache.js';
import {WGPUAov} from './WGPUAov.js';
import {packAovScene} from './aovScene.js';
import {aovMask, type AovKind} from './aov.js';
import {proceduralEnvironmentPower} from './proceduralEnvironmentPower.js';
import {WGPUSkyBaker} from './WGPUSkyBaker.js';
import {
  initialSceneConstants,
  sceneAttributeLayout,
  sceneTraversalConstants,
  prepareSceneLightSampling,
  writeTraceLighting,
  packSceneAnalyticLights,
  writeTraceQuality,
  traceSampling,
  writeTraceSampling
} from './sceneAssembly.js';
import {rayTraceBindGroupLayouts} from './sceneLayoutSchema.js';
import {WGPUBindlessMaterialData} from './WGPUBindlessMaterialData.js';
import {WGPUBindlessTextures} from './WGPUBindlessTextures.js';
import {bindlessBindGroupLayouts, bindlessShaderSource} from './wgpuBindlessSource.js';
import {
  bindlessLimitReason,
  resourceTableLayout,
  setResourceTable,
  type MaterialTextureSelection
} from './wgpuBindless.js';
import {wgpuMaterialConstants} from './wgpuMaterialConstants.js';
import {wgpuShaderSource, wgpuPipelineConstantKeys, WGPU_SHADER_DEFINE_KEYS} from './wgpuShaderSource.js';
import {makeRayTraceUniform, WGPU_SCENE_BUFFER_MIN_BYTES} from './wgpuSceneUniform.js';
import {constants} from './webgl.js';
import {MATERIAL_FLOAT_COUNT} from './materialLayoutSchema.js';
import {normalizeBounces} from './pathLimits.js';
import {updateMeshInstanceColors} from './prepareMeshBVH.js';
import {updateTLASInstanceColors} from './bvhAccel.js';
import {getMaterialHashKey} from '../scene/openPbrSchema.js';
import {sameInstanceMembership} from './meshInstances.js';
import InstancedMesh from '../scene/InstancedMesh.js';
import {dirtyMeshInstanceIndices} from './prepareMeshBVH.js';
import {cameraApertureRadius} from './cameraLens.js';
import {getGeometryBvh, setGeometryBvh} from './geometryBvh.js';
import {packCameraUniform} from './cameraUniform.js';
import {SHADOW_CATCHER_ACCUMULATION_BYTES} from './wgsl/chunks/shadowCatcherAccumulation.wgsl.js';
import type {SamplingPattern} from './sampling.js';
import {
  DEPTH_SAMPLE_COUNT,
  packDepthSampleArea,
  unpackDepthSamples,
  type DepthSampleArea
} from './depthQuery.js';
import {MeshMembershipCache} from './meshMembership.js';
import {mergeRefitRanges} from './bvhAccel.js';
import {
  updatePreparedGeometries,
  canUpdateGeometries,
  geometryTopologyChanged,
  packVertexAttributes
} from './geometryUpdates.js';
import {SceneEnvironmentCache, RectLightTextureTracker} from './sceneLightChanges.js';
import {MaterialChangeTracker, materialIsEmissive, type MaterialUpdateLevel} from './materialChanges.js';
import {WGPUEnvMapDistribution} from './WGPUEnvMapDistribution.js';
import {WGPUShaderCache, retainedShaderCapacity} from './WGPUShaderCache.js';
import {WGPUShaderCapabilities} from './WGPUShaderCapabilities.js';
import {wgpuSceneFeatureFlags} from './WGPUSceneFeatures.js';
import {
  lightShaderCapabilities,
  retainedShaderCapabilities,
  type ShaderCapabilities
} from './shaderCapabilities.js';
import {mat4} from '../math.js';
import Mesh from '../scene/Mesh.js';
import DirectionalLight from '../scene/DirectionalLight.js';
import SphereLight from '../scene/SphereLight.js';
import RectLight from '../scene/RectLight.js';
import SpotLight from '../scene/SpotLight.js';
import MaterialTable, {DEFAULT_MAX_TEXTURE_ARRAY_BYTES} from './MaterialTable.js';
import type {SceneBackground, SceneLight} from '../scene/Scene.js';
import {numberArraysEqual} from './util.js';
import Camera from '../scene/Camera.js';
import {
  generateBackgroundMapFromSceneBackground,
  environmentRotation,
  backgroundMapTransform,
  backgroundMapRotation
} from './envMapCreation.js';
import {WORKGROUP_SIZE} from './wgsl/rayTrace.compute.js';
import Geometry from '../scene/Geometry.js';
import {
  envMapDistribution,
  environmentMapSourcesMatch,
  type EnvironmentSource
} from './envMapDistribution.js';
import {updateMeshInstances, updateMeshInstanceTransforms} from './prepareMeshBVH.js';
import {
  buildTLAS,
  concatBLASBuffers,
  type FlattendBVH,
  getTraversalStackSizes,
  refitBLAS,
  refitTLAS
} from './bvhAccel.js';
import {isTextureDataSource} from '../scene/Texture.js';
import OpenPBRMaterial from '../scene/OpenPBRMaterial.js';
import {
  DEFAULT_BEVEL_SAMPLES,
  DEFAULT_DIRECT_LIGHT_CANDIDATES,
  normalizeBevelSamples,
  normalizeDirectLightCandidates,
  type AlphaBlendStrategy,
  type ShaderCompilationDiagnostics
} from './RenderingPipeline.js';
import {
  EmissiveTriangleCache,
  LightChoiceBuffer,
  type EmissiveTriangle,
  estimateEnvironmentPower
} from './lightSampling.js';
import {
  getOpenPbrEnergyLutData,
  OPENPBR_ENERGY_LUT_HEIGHT,
  OPENPBR_ENERGY_LUT_WIDTH
} from './openPbrEnergyLut.js';
import {offlineAdaptiveCompute} from './wgsl/offlineAdaptive.compute.js';
import {
  normalizeOfflineAdaptiveSamplingOptions,
  type OfflineAdaptiveSamplingOptions,
  type OfflineAdaptiveSamplingResult,
  type OfflineVarianceHistory
} from './OfflineAdaptiveSampling.js';
type AnalyticLight = DirectionalLight | SphereLight | SpotLight | RectLight;
const F32 = Float32Array;

const FIXED_LIGHT_COUNT = 64;
const PIXELS_PER_LIGHT = 6;

export interface WGPURayTraceTimingCapture {
  querySet: GPUQuerySet;
}

/**
 * WebGPU errors are Web IDL objects and are not required to inherit from the
 * JavaScript Error class. In particular, GPUValidationError exposes a useful
 * `message` while String(error) may only return "[object GPUValidationError]".
 */
export function getWebGPUErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.length > 0) return message;
  }
  return String(error);
}

function joinWebGPUErrors(...errors: unknown[]) {
  return [
    ...new Set(
      errors
        .filter((error) => error != null)
        .map(getWebGPUErrorMessage)
        .filter(Boolean)
    )
  ].join('\n');
}

function shaderCompilationNow() {
  return typeof performance === 'undefined' ? Date.now() : performance.now();
}

function shaderSourceLineCount(source: string) {
  let lines = 1;
  for (let offset = source.indexOf('\n'); offset >= 0;
    offset = source.indexOf('\n', offset + 1)) {
    lines++;
  }
  return lines;
}

/** Fast diagnostic fingerprint; cache implementations use their own hashes. */
export function shaderSourceFingerprint(source: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index++) {
    hash = Math.imul(hash ^ source.charCodeAt(index), 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function isWebGPUPipelineSpecializationFailure(...errors: unknown[]) {
  return errors.some((error) =>
    /(?:compute )?library failed creation/i.test(
      getWebGPUErrorMessage(error)
    )
  );
}

/** CPU-side views over the `RayTraceUniform` WGSL struct. */
export { makeRayTraceUniform } from './wgpuSceneUniform.js';
export function packAnalyticsLightsToBuffer(lights: AnalyticLight[], texturesIndices: number[], selectionPmfs: number[],
  iesProfileTexelOffsets: ArrayLike<number> = []) {
  return packSceneAnalyticLights(lights, texturesIndices, selectionPmfs, i => iesProfileTexelOffsets[i]);
}

class WGPURayTracePass {
  private _aovPrimitiveCache = new AovPrimitiveCache();
  private _device!: GPUDevice;
  private _rayTracePipeline?: GPUComputePipeline;
  private _targetAspect = 1;
  private _width: number = 0;
  private _height: number = 0;

  private _meshes: Mesh[] = [];
  private _causticKey = '';
  private _photonMapping = false;
  private _photonMap?: WGPUPhotonMap;
  private _causticLight?: WGPUCausticLightPass;
  private _causticSettings?: import('../Render.js').CausticSettings;
  private _causticPerspective = true;
  private _causticCameraScale = 1;
  private _causticBounds: [number, number, number, number] = [0, 0, 0, 0];
  private _compiledCausticKey = '';
  private readonly _causticSeeds = new CausticSeedCache();
  private _mnee = false;
  private _lightTracing = false;
  private _sceneEnvironment = new SceneEnvironmentCache();
  private _rectLightTextures = new RectLightTextureTracker();
  private _analyticLights: AnalyticLight[] = [];
  private _iesProfileTexelOffsets = new Int32Array(0);
  private _materialChanges = new MaterialChangeTracker();
  private _pendingMaterialUpdate?: { level: MaterialUpdateLevel; emission: boolean; emissiveMap: boolean; materials: Set<OpenPBRMaterial> };
  private _materialData: MaterialTable | WGPUBindlessMaterialData | undefined;
  private _bindless?: WGPUBindlessTextures;
  private _retiredBindless = new Set<WGPUBindlessTextures>();
  private _disposed = false;
  private _maxTextureArrayBytes = DEFAULT_MAX_TEXTURE_ARRAY_BYTES;
  private _pendingGeometryUpdates = new Set<Geometry>();
  private _needsUpdateMeshData = true;
  private _needsUpdateMeshMembership = false;
  private _needsRefitTLAS = false;
  private _preparedMeshData?: ReturnType<typeof updateMeshInstances>;
  private _membershipCache = new MeshMembershipCache();
  private _pendingMembershipData?: ReturnType<typeof updateMeshInstances>;
  private _residentPreparedMeshData?: ReturnType<typeof updateMeshInstances>;
  private _tlas?: FlattendBVH;
  private _meshSnapshot: {
    mesh: Mesh;
    instanceCount: number;
    instanceVersion: number;
    instanceTransforms?: Float32Array;
    instanceColors?: Float32Array;
    colorVersion: number;
    geometry: Geometry;
    bvh?: FlattendBVH;
    materials: OpenPBRMaterial[];
    materialKeys: string[];
    geometryVersion: number;
    positionArray: Float32Array;
    positionItemSize: number;
    indexArray: Uint16Array | Uint32Array;
    indexItemSize: number;
    materialIndexArray?: Int32Array;
    materialIndexItemSize?: number;
    matrix: number[];
  }[] = [];
  private _snapshotByMesh = new WeakMap<
    Mesh,
    (typeof this._meshSnapshot)[number]
  >();
  private _residentSnapshotByMesh = new WeakMap<
    Mesh,
    (typeof this._meshSnapshot)[number]
  >();
  private _dirtyTransformMeshes = new Set<Mesh>();
  private _dirtyColorMeshes = new Set<Mesh>();
  private _geometriesNeedRefit = new Set<Geometry>();
  private _needsUpdateAnalyticLightsBuffer = true;

  private _activeTarget: object = {};
  private _targetOutputs = new Map<object, { buffers: GPUBuffer[]; bindGroup?: GPUBindGroup; pipeline?: GPUComputePipeline }>();

  releaseTarget(target: object) {
    const output = this._targetOutputs.get(target);
    if (!output) return;
    this._targetOutputs.delete(target);
    this._causticLight?.release(target);
    this._photonMap?.release(target);
    for (const buffer of output.buffers) buffer.destroy();
    if (this._activeTarget === target) {
      this._rayTraceBindGroups = undefined;
      this._needsUpdateBindGroups = true;
    }
  }

  getTargetMemoryBytes(target: object) {
    return (
      (this._targetOutputs.get(target)?.buffers.reduce((sum, buffer) => sum + buffer.size, 0) ?? 0) +
      (this._causticLight?.bytes(target) ?? 0) +
      (this._photonMap?.bytes(target) ?? 0)
    );
  }

  useTarget(target: object) {
    if (this._photonMapping && this._activeTarget !== target) this._needsUpdateBindGroups = true;
    this._activeTarget = target;
    const output = this._targetOutputs.get(target);
    [this._outColorBuffer, this._outNormalBuffer, this._outAlbedoBuffer, this._outShadowCatcherBuffer] =
      output?.buffers ?? [];
    if (output?.bindGroup && output.pipeline === this._rayTracePipeline && this._rayTraceBindGroups) {
      this._rayTraceBindGroups[this._bindless ? 2 : 3] = output.bindGroup;
    } else {
      this._needsUpdateBindGroups = true;
    }
  }

  private _outColorBuffer!: GPUBuffer;
  private _outNormalBuffer!: GPUBuffer;
  private _outAlbedoBuffer!: GPUBuffer;
  private _outShadowCatcherBuffer!: GPUBuffer;

  private _uniforms!: {
    cameraUniform: GPUBuffer;
    rtUniform: GPUBuffer;
    analyticLights: GPUBuffer;
  };
  private _rtUniform = makeRayTraceUniform();
  private _mapInfoUniform!: GPUBuffer;
  private _attributeData?: Float32Array;
  private _attributeStride = 0;
  private _attributeOffsets: number[] = [];
  private _attrBuffers?: GPUBuffer;
  private _materialsBuffer?: GPUBuffer;
  private _lightSamplingTexture?: GPUTexture;
  private _lightSamplingTextureSize: [number, number] = [0, 0];
  private _lightDomainDiagnostics = {
    environment: { count: 0, weight: 0, pmf: 0 },
    infinite: { count: 0, weight: 0, pmf: 0 },
    localAndEmissive: { count: 0, weight: 0, pmf: 0 }
  };
  private _openPbrEnergyLut: GPUTexture;

  private _bvhBuffer?: GPUBuffer;
  private _instancesBuffer?: GPUBuffer;
  private _emissiveCache = new EmissiveTriangleCache();
  private _lightChoices = new LightChoiceBuffer();
  private _shadowCatcherLightChoices = new LightChoiceBuffer();
  private _lightSamplingData?: Float32Array;
  private _lightSamplingScratch?: Float32Array;
  private _lightSamplingTriangleCount = -1;
  private _emissiveTriangles: EmissiveTriangle[] = [];
  private _analyticLightSelectionPmfs: number[] = [];
  private _needsUpdateLightSamplingData = true;

  private _adaptiveSamplingTexture: GPUTexture;
  private _adaptiveSamplingTextureSize: [number, number] = [1, 1];
  private _offlineAdaptivePipeline?: GPUComputePipeline;
  private _offlineAdaptiveHistory?: {
    history: OfflineVarianceHistory;
    varianceBuffer: GPUBuffer;
  };
  private _mapsSampler: GPUSampler;
  private _maps?: GPUTexture;

  private _envImageSource: EnvironmentSource | undefined;
  private _envTex?: GPUTexture;
  private _envDistributionTex?: GPUTexture;
  private _envDistribution?: WGPUEnvMapDistribution;
  private _skyBaker?: WGPUSkyBaker;
  private _backgroundImageSource: EnvironmentSource | undefined;
  private _backgroundTex?: GPUTexture;

  private _rayTracePipelineLayout?: GPUPipelineLayout;
  private _rayTraceBindGroups?: GPUBindGroup[];
  private _photonEmissionGroups?: GPUBindGroup[];
  private _blasLayoutMask = 1;
  private _compiledBlasLayoutMask = 0;
  private _compiledAnisotropyDirections = false;
  private _compiledCoatNormals = false;
  private _compiledHasAlpha = true;
  private _compiledSceneHasAlpha = true;
  private _alphaBlendStrategy: AlphaBlendStrategy = 'stochastic';
  private _constants = initialSceneConstants();
  private _retainedShaderCapabilities?: ShaderCapabilities;
  private _retainedShaderStructure?: string;
  private _shaderCapabilities = new WGPUShaderCapabilities();
  private _prevPipelineConstants: Record<string, boolean | number> = {};
  private _prevDefinesCode = '';
  private _prevPipelineInputs?: string;

  private _hasTransmission = false;
  private _hasShadowCatcher = false;
  private _hasDisplacement = false;

  // User set params
  private _bounces = -1;
  private _bevelSamples = DEFAULT_BEVEL_SAMPLES;
  private _directLightCandidates = DEFAULT_DIRECT_LIGHT_CANDIDATES;
  private _clamping?: number;
  private _transmissiveAlphaMin = 1;

  private _viewProjInv = mat4.create();
  private _cameraWorld = mat4.create();
  private _apertureRadius = 0;
  private _focusDistance = 10;

  private _needsUpdateBindGroups = true;

  private _computeShaderModule?: GPUShaderModule;
  private _aovPipelines = new WeakMap<GPUComputePipeline, Map<boolean, {
    accumulation?: GPUComputePipeline; center?: GPUComputePipeline; error?: unknown;
  }>>();
  private _depthCompute?: GPUProgrammableStage;
  private _depthTracePipeline?: GPUComputePipeline;
  private _depthPipeline?: Promise<GPUComputePipeline>;
  private _shaderCache: WGPUShaderCache;
  private _debugBVHBuffer?: ArrayBuffer;

  private _isCompilingShader = false;
  private _shaderCompilationDiagnostics?: ShaderCompilationDiagnostics;
  private _pipelineError: unknown;
  // Fold scene invariants before backend inlining; runtime edits use uniforms.
  private _bakePipelineConstants = true;
  private _failedPipelineSignature?: string;



  constructor(device: GPUDevice, private _textureSelection: MaterialTextureSelection = {requested: 'atlas'}) {
    this._device = device;
    this._shaderCache = new WGPUShaderCache(device);
    if (_textureSelection.support) this._bindless = new WGPUBindlessTextures(device);

    this._uniforms = {
      cameraUniform: this._uniformBuffer(36 * 4),
      rtUniform: this._uniformBuffer(this._rtUniform.buffer.byteLength),
      analyticLights: this._uniformBuffer(
        FIXED_LIGHT_COUNT * PIXELS_PER_LIGHT * 4 * 4
      )
    };
    this._mapInfoUniform = this._uniformBuffer(4 * 4);

    this._openPbrEnergyLut = device.createTexture({
      format: 'r32float',
      label: 'OpenPBR opaque dielectric energy compensation',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      size: {
        width: OPENPBR_ENERGY_LUT_WIDTH,
        height: OPENPBR_ENERGY_LUT_HEIGHT
      }
    });
    device.queue.writeTexture(
      { texture: this._openPbrEnergyLut },
      getOpenPbrEnergyLutData(),
      { bytesPerRow: OPENPBR_ENERGY_LUT_WIDTH * Float32Array.BYTES_PER_ELEMENT },
      {
        width: OPENPBR_ENERGY_LUT_WIDTH,
        height: OPENPBR_ENERGY_LUT_HEIGHT
      }
    );

    this._mapsSampler = device.createSampler({
      minFilter: 'linear',
      magFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge'
    });

    this._setBackgroundMap(undefined);
    this._adaptiveSamplingTexture = device.createTexture({
      format: 'r32float',
      label: 'Adaptive sample targets placeholder',
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.STORAGE_BINDING,
      size: [1, 1]
    });
    device.queue.writeTexture(
      { texture: this._adaptiveSamplingTexture },
      new Float32Array([Number.MAX_SAFE_INTEGER]),
      { bytesPerRow: 4 },
      [1, 1]
    );
  }

  getOutputBuffer() {
    return {
      color: this._outColorBuffer,
      ...(this._photonMapping || causticDiagnostics.mneeDebugGroup >= 0 ? {wideHdr: true} : {}),
      ...(this._lightTracing && this._causticLight?.get(this._activeTarget)
        ? {caustic: this._causticLight.get(this._activeTarget)!}
        : {}),
      normal: this._outNormalBuffer,
      albedo: this._outAlbedoBuffer,
      shadowCatcher: this._outShadowCatcherBuffer
    };
  }

  private _ensureAdaptiveSamplingTexture(width: number, height: number) {
    if (
      this._adaptiveSamplingTextureSize[0] === width &&
      this._adaptiveSamplingTextureSize[1] === height
    ) {
      return;
    }
    this._adaptiveSamplingTexture.destroy();
    this._adaptiveSamplingTexture = this._device.createTexture({
      format: 'r32float',
      label: 'Adaptive sample targets',
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.STORAGE_BINDING,
      size: [width, height]
    });
    this._adaptiveSamplingTextureSize = [width, height];
    this._needsUpdateBindGroups = true;
  }

  /**
   * Reduces pilot moments and expands final sample targets without transferring
   * full-resolution buffers through JavaScript. Only compact per-tile history
   * is read back for diagnostics and animation-frame reuse.
   */
  async prepareOfflineAdaptiveSampling(
    options: OfflineAdaptiveSamplingOptions
  ): Promise<OfflineAdaptiveSamplingResult | undefined> {
    const width = this._width;
    const height = this._height;
    if (!width || !height || !this._outColorBuffer || !this._outNormalBuffer) {
      return undefined;
    }

    const normalized = normalizeOfflineAdaptiveSamplingOptions(
      options,
      width,
      height
    );
    const {
      maxSamples,
      minSamples,
      tileSize,
      columns,
      rows,
      absoluteError,
      relativeError,
      confidence,
      previous
    } = normalized;
    const tileCount = columns * rows;
    const tileByteLength = tileCount * Float32Array.BYTES_PER_ELEMENT;
    const oldResidentHistory = this._offlineAdaptiveHistory;

    let ownsPreviousBuffer = false;
    let previousBuffer: GPUBuffer;
    if (previous && oldResidentHistory?.history === previous) {
      previousBuffer = oldResidentHistory.varianceBuffer;
    } else {
      previousBuffer = this._device.createBuffer({
        label: previous
          ? 'Offline previous tile variance upload'
          : 'Offline empty tile variance',
        size: previous ? tileByteLength : Float32Array.BYTES_PER_ELEMENT,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
      });
      this._device.queue.writeBuffer(
        previousBuffer,
        0,
        previous?.variance ?? new Float32Array(1)
      );
      ownsPreviousBuffer = true;
    }

    const uniformBuffer = this._device.createBuffer({
      label: 'Offline adaptive sampling parameters',
      size: 48,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    const uniformData = new ArrayBuffer(48);
    new Uint32Array(uniformData, 0, 8).set([
      width,
      height,
      tileSize,
      columns,
      rows,
      maxSamples,
      minSamples,
      previous ? 1 : 0
    ]);
    new Float32Array(uniformData, 32, 4).set([
      absoluteError,
      relativeError,
      confidence,
      0
    ]);
    this._device.queue.writeBuffer(uniformBuffer, 0, uniformData);

    const meanBuffer = this._device.createBuffer({
      label: 'Offline tile mean luminance',
      size: tileByteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
    });
    const varianceBuffer = this._device.createBuffer({
      label: 'Offline current tile variance',
      size: tileByteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
    });
    const targetBuffer = this._device.createBuffer({
      label: 'Offline tile sample targets',
      size: tileByteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
    });
    const readbackBuffer = this._device.createBuffer({
      label: 'Offline compact tile history readback',
      size: tileByteLength * 3,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
    });

    this._ensureAdaptiveSamplingTexture(width, height);
    this._offlineAdaptivePipeline ??=
      await this._device.createComputePipelineAsync({
        label: 'Offline adaptive sampling planner',
        layout: 'auto',
        compute: {
          module: this._device.createShaderModule({
            label: 'Offline adaptive sampling planner',
            code: offlineAdaptiveCompute
          }),
          entryPoint: 'main'
        }
      });

    const bindGroup = this._device.createBindGroup({
      label: 'Offline adaptive sampling planner',
      layout: this._offlineAdaptivePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uniformBuffer } },
        { binding: 1, resource: { buffer: this._outColorBuffer } },
        { binding: 2, resource: { buffer: this._outNormalBuffer } },
        { binding: 3, resource: { buffer: previousBuffer } },
        { binding: 4, resource: { buffer: meanBuffer } },
        { binding: 5, resource: { buffer: varianceBuffer } },
        { binding: 6, resource: { buffer: targetBuffer } },
        {
          binding: 7,
          resource: this._adaptiveSamplingTexture.createView()
        }
      ]
    });
    const encoder = this._device.createCommandEncoder({
      label: 'Offline adaptive sampling planner'
    });
    const pass = encoder.beginComputePass({
      label: 'Offline adaptive sampling planner'
    });
    pass.setPipeline(this._offlineAdaptivePipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(tileCount / 64));
    pass.end();
    encoder.copyBufferToBuffer(
      meanBuffer,
      0,
      readbackBuffer,
      0,
      tileByteLength
    );
    encoder.copyBufferToBuffer(
      varianceBuffer,
      0,
      readbackBuffer,
      tileByteLength,
      tileByteLength
    );
    encoder.copyBufferToBuffer(
      targetBuffer,
      0,
      readbackBuffer,
      tileByteLength * 2,
      tileByteLength
    );
    this._device.queue.submit([encoder.finish()]);

    let succeeded = false;
    try {
      await readbackBuffer.mapAsync(GPUMapMode.READ);
      const mapped = readbackBuffer.getMappedRange();
      const meanLuminance = new Float32Array(mapped, 0, tileCount).slice();
      const variance = new Float32Array(
        mapped,
        tileByteLength,
        tileCount
      ).slice();
      const sampleTargets = new Uint32Array(
        mapped,
        tileByteLength * 2,
        tileCount
      ).slice();
      const history: OfflineVarianceHistory = {
        width,
        height,
        tileSize,
        columns,
        rows,
        meanLuminance,
        variance,
        sampleTargets
      };

      let maximumTarget = minSamples;
      let totalTargetSamples = 0;
      for (let tile = 0; tile < tileCount; tile++) {
        const target = sampleTargets[tile];
        maximumTarget = Math.max(maximumTarget, target);
        const tileX = tile % columns;
        const tileY = Math.floor(tile / columns);
        const tileWidth = Math.min(tileSize, width - tileX * tileSize);
        const tileHeight = Math.min(tileSize, height - tileY * tileSize);
        totalTargetSamples += target * tileWidth * tileHeight;
      }

      this._offlineAdaptiveHistory = { history, varianceBuffer };
      this._rtUniform.views.adaptiveSampling[0] = 1;
      succeeded = true;
      if (oldResidentHistory?.varianceBuffer !== varianceBuffer) {
        oldResidentHistory?.varianceBuffer.destroy();
      }
      return {
        maximumTarget,
        averageTarget: totalTargetSamples / (width * height),
        history
      };
    } finally {
      if (readbackBuffer.mapState === 'mapped') readbackBuffer.unmap();
      readbackBuffer.destroy();
      meanBuffer.destroy();
      targetBuffer.destroy();
      uniformBuffer.destroy();
      if (ownsPreviousBuffer) previousBuffer.destroy();
      if (!succeeded) varianceBuffer.destroy();
    }
  }

  private _createPipelineLayout() {
    const descriptor = {
      label: 'Ray Trace Pipeline Layout',
      bindGroupLayouts: (this._bindless ? bindlessBindGroupLayouts() : rayTraceBindGroupLayouts()).map(
        (layout, index) => {
          if (this._photonMapping && index === (this._bindless ? 0 : 1))
            layout = {
              ...layout,
              entries: [
                ...layout.entries,
                ...[11, 12].map((binding) => ({
                  binding: binding + (this._bindless ? 4 : 0),
                  visibility: GPUShaderStage.COMPUTE,
                  texture: {sampleType: 'uint' as const}
                }))
              ]
            };
          return this._shaderCache.createBindGroupLayout(layout);
        }
      )
    };
    this._rayTracePipelineLayout = this._shaderCache.createPipelineLayout(
      this._bindless ? resourceTableLayout(descriptor) : descriptor
    );
  }

  private _updateGPUBuffer(
    label: string,
    gpuBuffer: GPUBuffer | undefined,
    data: Float32Array | Uint32Array,
    minSize = WGPU_SCENE_BUFFER_MIN_BYTES
  ) {
    const device = this._device;
    const size = Math.max(data.byteLength, minSize);

    if (gpuBuffer == null || gpuBuffer.size < size) {
      this._needsUpdateBindGroups = true;
      if (gpuBuffer) {
        gpuBuffer.destroy();
      }
      gpuBuffer = device.createBuffer({
        label,
        size,
        usage:
          GPUBufferUsage.STORAGE |
          GPUBufferUsage.COPY_DST |
          GPUBufferUsage.COPY_SRC
      });
    }
    this._device.queue.writeBuffer(gpuBuffer, 0, data.buffer);
    return gpuBuffer;
  }

  private _uniformBuffer(size: number) {
    this._needsUpdateBindGroups = true;
    return this._device.createBuffer({
      size,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
  }

  async updatePipeline() {
    if (this._isCompilingShader) {
      return;
    }
    // Set this before any synchronous preparation. updatePipeline is called
    // without awaiting it, so a preparation error must not let createPass run
    // with an undefined pipeline in the same frame.
    this._isCompilingShader = true;
    let attemptedPipelineSignature: string | undefined;
    let compilationStartedAt: number | undefined;
    let pipelineCompilationStartedAt: number | undefined;
    try {
      if (this._bindless?.retirement) await this._bindless.retirement;
      if (this._disposed) return;
      if (this._needsUpdateMeshData) {
        this._updateMeshData();
      } else if (this._needsUpdateMeshMembership) {
        this._updateMeshMembership();
      }
      if (this._pendingGeometryUpdates.size) this._updateGeometryData();
      if (this._needsRefitTLAS) this._refitMeshInstances();
      if (this._dirtyColorMeshes.size) this._updateMeshColors();
      if (this._pendingMaterialUpdate) this._updateMaterialData();
      this._setCaustics(this._causticSettings);
      if (this._needsUpdateLightSamplingData) {
        this._updateLightSamplingData();
      }

      this._setCaustics(this._causticSettings);
      if (this._lightTracing || this._photonMapping) this._causticBounds = causticCasterSphere(this._meshes);
      if (this._photonMapping) {
        this._photonMap ??= new WGPUPhotonMap(this._device);
        const before = this._photonMap.get(this._activeTarget)?.data;
        const requested = this._causticSettings?.photonMapping;
        const n = typeof requested === 'object' ? requested.photonsPerSample : undefined;
        const after = this._photonMap.ensure(
          this._activeTarget,
          Number.isFinite(n) && n! > 0 ? n! : (this._width * this._height) / 4
        );
        if (before !== after.data) this._needsUpdateBindGroups = true;
      }
      const device = this._device;
      const pipelineInputs = JSON.stringify([
        this._constants,
        this._hasDisplacement,
        this._alphaBlendStrategy,
        this._blasLayoutMask,
        this._bakePipelineConstants,
        this._causticKey
      ]);
      // Steady rendering must not repeat capability selection and cache-key
      // preparation. Dirty resources still take the normal bind-group path.
      if (
        pipelineInputs === this._prevPipelineInputs &&
        this._rayTracePipeline &&
        this._rayTraceBindGroups &&
        !this._needsUpdateBindGroups
      )
        return;
      this._rtUniform.views.sceneFeatureFlags[0] = wgpuSceneFeatureFlags(this._constants);
      const requiredCapabilities = retainedShaderCapabilities(this._constants);
      const constants: Record<string, boolean | number> = {...this._constants, ...requiredCapabilities};
      const hasAlpha =
        Boolean(constants.HAS_ALPHA_BLEND) && this._alphaBlendStrategy === 'deterministic-source-over';
      const hasSceneAlpha = Boolean(constants.HAS_ALPHA);
      const pipelineConstantsKeys = wgpuPipelineConstantKeys(constants);
      const defineCode = WGPU_SHADER_DEFINE_KEYS.map((key) => `const ${key} = ${constants[key]};`).join('\n');
      const structure = {
        hasDisplacement: this._hasDisplacement,
        caustics: this._causticKey,
        hasAlpha,
        hasSceneAlpha,
        hasAnisotropyDirections: Boolean(constants.USE_ANISOTROPY_DIRECTIONS),
        hasCoatNormals: Boolean(constants.USE_COAT_NORMAL_FRAMES),
        blasLayoutMask: this._blasLayoutMask,
        bakePipelineConstants: this._bakePipelineConstants
      };
      const structureKey = JSON.stringify({
        ...structure,
        defineCode,
        constants: pipelineConstantsKeys
          .filter((key) => !(key in requiredCapabilities))
          .map((key) => [key, constants[key]])
      });
      // Prefer an existing compatible pipeline, including an earlier lean
      // variant. Only grow the current variant when it cannot cover an edit;
      // do not carry unused capabilities across different transport/layouts.
      const capabilities =
        this._shaderCapabilities.find(structureKey, requiredCapabilities) ??
        retainedShaderCapabilities(
          this._constants,
          structureKey === this._retainedShaderStructure ? this._retainedShaderCapabilities : undefined
        );
      Object.assign(constants, capabilities);
      const pipelineSignature = JSON.stringify({
        ...structure,
        constants: Object.keys(constants)
          .sort()
          .map((key) => [key, constants[key]])
      });
      attemptedPipelineSignature = pipelineSignature;
      if (pipelineSignature === this._failedPipelineSignature) {
        return;
      }
      this._pipelineError = undefined;
      const previousPipelineConstantsKeys = wgpuPipelineConstantKeys(this._prevPipelineConstants);
      const needsCreateShaderModule =
        this._causticKey !== this._compiledCausticKey ||
        !this._rayTracePipelineLayout ||
        !this._computeShaderModule ||
        pipelineConstantsKeys.join(',') !== previousPipelineConstantsKeys.join(',') ||
        defineCode !== this._prevDefinesCode ||
        hasAlpha !== this._compiledHasAlpha ||
        hasSceneAlpha !== this._compiledSceneHasAlpha ||
        Boolean(constants.USE_ANISOTROPY_DIRECTIONS) !== this._compiledAnisotropyDirections ||
        Boolean(constants.USE_COAT_NORMAL_FRAMES) !== this._compiledCoatNormals ||
        this._blasLayoutMask !== this._compiledBlasLayoutMask ||
        (this._bakePipelineConstants &&
          pipelineConstantsKeys.some((key) => constants[key] !== this._prevPipelineConstants[key]));

      const needsCreatePipeline =
        needsCreateShaderModule ||
        pipelineConstantsKeys.some((key) => constants[key] !== this._prevPipelineConstants[key]);

      compilationStartedAt = needsCreatePipeline ? shaderCompilationNow() : undefined;
      let sourceGenerationTimeMs = 0;
      let moduleCreationTimeMs = 0;
      let sourceBytes = this._shaderCompilationDiagnostics?.sourceBytes ?? 0;
      let sourceLines = this._shaderCompilationDiagnostics?.sourceLines ?? 0;
      let sourceFingerprint = this._shaderCompilationDiagnostics?.modules[0]?.sourceFingerprint ?? '';
      if (needsCreateShaderModule) {
        this._compiledCausticKey = this._causticKey;
        const sourceGenerationStartedAt = shaderCompilationNow();
        let rayTraceShaderCode = wgpuShaderSource(
          constants,
          {
            hasDisplacement: this._hasDisplacement,
            hasAlpha,
            hasSceneAlpha,
            mnee: this._mnee,
            mneeMethod:
              typeof causticDiagnostics.mnee === 'object' ? causticDiagnostics.mnee.method : undefined,
            lightTracing: this._lightTracing,
            photonMapping: this._photonMapping,
            photonMaxDepth: causticDiagnostics.photonMaxDepth ?? 20,
            mneeDebugGroup: causticDiagnostics.mneeDebugGroup,
            mneeSeeds: causticDiagnostics.mneeSeeds ?? 4,
            mneeDamping: !!causticDiagnostics.mneeDamping,
            smsRoulette: !!causticDiagnostics.smsRoulette,
            mneeMaxDepth: causticDiagnostics.mneeMaxDepth ?? 20,
            workgroupSize: this._mnee ? 1 : WORKGROUP_SIZE,
            hasAnisotropyDirections: Boolean(constants.USE_ANISOTROPY_DIRECTIONS),
            hasCoatNormals: Boolean(constants.USE_COAT_NORMAL_FRAMES),
            blasLayoutMask: this._blasLayoutMask,
            dynamicEnvironment: true
          },
          this._bakePipelineConstants
        );
        if (this._bindless)
          rayTraceShaderCode = bindlessShaderSource(
            rayTraceShaderCode,
            this._textureSelection.support!.enable
          );

        sourceBytes = rayTraceShaderCode.length;
        sourceLines = shaderSourceLineCount(rayTraceShaderCode);
        sourceFingerprint = shaderSourceFingerprint(rayTraceShaderCode);
        sourceGenerationTimeMs = shaderCompilationNow() - sourceGenerationStartedAt;
        const moduleCreationStartedAt = shaderCompilationNow();
        this._computeShaderModule = this._shaderCache.createShaderModule({
          label: 'Ray Trace',
          code: rayTraceShaderCode
        });
        moduleCreationTimeMs = shaderCompilationNow() - moduleCreationStartedAt;
        this._compiledHasAlpha = hasAlpha;
        this._compiledSceneHasAlpha = hasSceneAlpha;
        this._compiledAnisotropyDirections = Boolean(constants.USE_ANISOTROPY_DIRECTIONS);
        this._compiledCoatNormals = Boolean(constants.USE_COAT_NORMAL_FRAMES);
        this._compiledBlasLayoutMask = this._blasLayoutMask;
      }

      if (needsCreatePipeline) {
        if (!this._rayTracePipelineLayout) {
          device.pushErrorScope('validation');
          let layoutScopeOpen = true;
          try {
            this._createPipelineLayout();
            const layoutError = await device.popErrorScope();
            layoutScopeOpen = false;
            if (layoutError) throw layoutError;
          } catch (error) {
            const scopedError = layoutScopeOpen ? await device.popErrorScope().catch(() => null) : null;
            this._rayTracePipelineLayout = undefined;
            const detail = joinWebGPUErrors(error, scopedError);
            throw new Error(`Unable to create the ray tracing pipeline layout: ${detail}`);
          }
        }

        // NOTE must before creating pipeline.
        // Because createComputePipelineAsync is async.
        // The constants may be changed after the pipeline is created(in setMesh).
        this._prevPipelineConstants = {...constants};
        this._prevDefinesCode = defineCode;
        this._needsUpdateBindGroups = true;

        device.pushErrorScope('validation');
        let pipelineScopeOpen = true;
        try {
          const pipelineConstants = !this._bakePipelineConstants
            ? pipelineConstantsKeys.reduce(
                (obj, key) => {
                  obj[key] = +constants[key];
                  return obj;
                },
                {} as Record<string, number>
              )
            : undefined;
          const diagnostic: ShaderCompilationDiagnostics['pipelines'][number] = {
            label: 'Ray Trace',
            entryPoint: 'main',
            firstFrameRequired: true,
            status: 'compiling'
          };
          pipelineCompilationStartedAt = shaderCompilationNow();
          diagnostic.startedAtMs = 0;
          diagnostic.concurrentCompilationCount = 1;
          this._shaderCompilationDiagnostics = {
            status: 'compiling',
            sourceBytes,
            sourceLines,
            pipelineCount: 1,
            completedPipelineCount: 0,
            sourceGenerationTimeMs,
            moduleCreationTimeMs,
            modules: [
              {
                label: 'Ray Trace',
                sourceBytes,
                sourceLines,
                sourceFingerprint
              }
            ],
            pipelines: [{...diagnostic}],
            maximumConcurrentPipelineCount: 1,
            peakConcurrentPipelineCount: 1
          };
          let rayTracePipeline: GPUComputePipeline;
          try {
            rayTracePipeline = await this._shaderCache.createComputePipelineAsync({
              label: 'Ray Trace',
              layout: this._rayTracePipelineLayout!,
              compute: {
                module: this._computeShaderModule!,
                entryPoint: 'main',
                constants: pipelineConstants
              }
            });
            diagnostic.status = 'ready';
          } catch (error) {
            diagnostic.status = 'failed';
            diagnostic.error = getWebGPUErrorMessage(error);
            // Pipeline creation already reports WGSL failures. Pull the much
            // heavier module diagnostics only on that failure path so normal
            // startup does not schedule a second full-module inspection.
            const info = await this._computeShaderModule!.getCompilationInfo().catch(() => undefined);
            const shaderErrors = (info?.messages ?? []).filter((message) => message.type === 'error');
            if (shaderErrors.length) {
              throw new Error(
                shaderErrors
                  .map((message) => `Ray Trace WGSL ${message.lineNum}:${message.linePos} ${message.message}`)
                  .join('\n')
              );
            }
            throw error;
          } finally {
            diagnostic.endedAtMs = shaderCompilationNow() - pipelineCompilationStartedAt;
            diagnostic.durationMs = diagnostic.endedAtMs;
          }
          this._rayTracePipeline = rayTracePipeline;
          this._depthCompute = {module: this._computeShaderModule!, constants: pipelineConstants};
          const pipelineError = await device.popErrorScope();
          pipelineScopeOpen = false;
          if (pipelineError) throw pipelineError;
          const compilationCompletedAt = shaderCompilationNow();
          this._shaderCompilationDiagnostics = {
            ...this._shaderCompilationDiagnostics!,
            status: 'ready',
            completedPipelineCount: 1,
            pipelines: [{...diagnostic}],
            pipelineCompilationTimeMs: compilationCompletedAt - pipelineCompilationStartedAt,
            totalTimeMs: compilationCompletedAt - compilationStartedAt!
          };
        } catch (error) {
          const scopedError = pipelineScopeOpen ? await device.popErrorScope().catch(() => null) : null;
          const detail = joinWebGPUErrors(error, scopedError);
          if (!this._bakePipelineConstants && isWebGPUPipelineSpecializationFailure(error, scopedError)) {
            const failedAt = shaderCompilationNow();
            if (this._shaderCompilationDiagnostics?.status === 'compiling') {
              this._shaderCompilationDiagnostics = {
                ...this._shaderCompilationDiagnostics,
                status: 'failed',
                pipelineCompilationTimeMs:
                  pipelineCompilationStartedAt == null ? undefined : failedAt - pipelineCompilationStartedAt,
                totalTimeMs: compilationStartedAt == null ? undefined : failedAt - compilationStartedAt,
                error: detail
              };
            }
            // WebKit can accept a large WGSL module but fail while translating
            // its specialization-constant variant to Metal. Baking the values
            // into WGSL lets its front end eliminate disabled feature branches
            // before creating the Metal library.
            this._bakePipelineConstants = true;
            this._rayTracePipeline = undefined;
            this._rayTraceBindGroups = undefined;
            this._computeShaderModule = undefined;
            this._prevPipelineConstants = {};
            console.warn('WebGPU pipeline specialization failed; retrying with constants baked into WGSL.');
            return;
          }
          throw new Error(detail);
        }
      }

      // Compilation can complete after Engine disposal/device loss has released
      // the material table and its textures. Never bind that retired generation.
      if (this._disposed) return;
      // TODO rebind when lights, materials, bvh changed.
      if (this._needsUpdateBindGroups) {
        this._needsUpdateBindGroups = false;

        this._updateBindGroups();
      }
      if (this._lightTracing) {
        this._causticLight ??= new WGPUCausticLightPass(device);
        this._causticLight.setDistribution(
          causticDiagnostics.aggregateCasters ? [this._causticBounds] : causticCasterSpheres(this._meshes),
          causticEmissionTable(
            this._analyticLights,
            this._emissiveTriangles,
            this._causticBounds[3],
            this._envImageSource && 'sky' in this._envImageSource
              ? proceduralEnvironmentPower(this._envImageSource)
              : estimateEnvironmentPower(this._envImageSource)
          )
        );
        let causticSource = causticLightCompute(
          constants,
          this._blasLayoutMask,
          this._hasDisplacement,
          'lightTracing',
          '',
          causticDiagnostics.fullEmissionRandom !== false
        );
        if (this._bindless)
          causticSource = bindlessShaderSource(causticSource, this._textureSelection.support!.enable);
        await this._causticLight.prepare(
          causticSource,
          (this._bindless ? [0, 1] : [0, 1, 2]).map((i) => this._rayTracePipeline!.getBindGroupLayout(i)),
          !!this._bindless,
          this._rayTracePipeline!
        );
      }
      if (this._photonMapping && this._photonMap) {
        const emitter = this._photonMap.emission;
        emitter.setDistribution(
          causticDiagnostics.aggregateCasters ? [this._causticBounds] : causticCasterSpheres(this._meshes),
          causticEmissionTable(
            this._analyticLights,
            this._emissiveTriangles,
            this._causticBounds[3],
            this._envImageSource && 'sky' in this._envImageSource
              ? proceduralEnvironmentPower(this._envImageSource)
              : estimateEnvironmentPower(this._envImageSource)
          )
        );
        let source = causticLightCompute(
          constants,
          this._blasLayoutMask,
          this._hasDisplacement,
          'photonMapping',
          '',
          causticDiagnostics.fullEmissionRandom !== false
        );
        if (this._bindless) source = bindlessShaderSource(source, this._textureSelection.support!.enable);
        await emitter.prepare(
          source,
          (this._bindless ? [0, 1] : [0, 1, 2]).map((i) => this._rayTracePipeline!.getBindGroupLayout(i)),
          !!this._bindless,
          this._rayTracePipeline!
        );
      }
      this._retainedShaderCapabilities = capabilities;
      this._retainedShaderStructure = structureKey;
      this._shaderCapabilities.remember(structureKey, capabilities);
      this._prevPipelineInputs = pipelineInputs;
      this._failedPipelineSignature = undefined;
    } catch (error) {
      if (this._disposed) return;
      this._pipelineError = error;
      const failedAt = shaderCompilationNow();
      if (this._shaderCompilationDiagnostics?.status === 'compiling') {
        this._shaderCompilationDiagnostics = {
          ...this._shaderCompilationDiagnostics,
          status: 'failed',
          pipelineCompilationTimeMs:
            pipelineCompilationStartedAt == null ? undefined : failedAt - pipelineCompilationStartedAt,
          totalTimeMs: compilationStartedAt == null ? undefined : failedAt - compilationStartedAt,
          error: getWebGPUErrorMessage(error)
        };
      }
      this._failedPipelineSignature = attemptedPipelineSignature;
      // Do not allow the render loop to submit the previous/partial state.
      // The failed signature prevents retrying the same shader every frame;
      // changing a pipeline-affecting setting permits a new attempt.
      this._rayTracePipeline = undefined;
      this._rayTraceBindGroups = undefined;
      this._prevPipelineConstants = {};
      this._needsUpdateBindGroups = true;
      console.error('Failed to update WebGPU ray tracing pipeline.', error);
    } finally {
      this._isCompilingShader = false;
    }
  }

  private _prepareAovPipelines(kinds: readonly AovKind[]) {
    const trace = this._rayTracePipeline;
    if (!trace || !this._depthCompute) return;
    const reflectance = (aovMask(kinds) & 24) !== 0;
    let variants = this._aovPipelines.get(trace);
    if (!variants) { variants = new Map(); this._aovPipelines.set(trace, variants); }
    let pipelines = variants.get(reflectance);
    if (!pipelines) {
      pipelines = {};
      variants.set(reflectance, pipelines);
      const pending = pipelines;
      const textures = this._bindless, groupIndex = textures ? 2 : 3;
      const output = this._device.createBindGroupLayout({entries: [
        {binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: {type: 'storage'}},
        {binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: {type: 'storage'}},
        {binding: 7, visibility: GPUShaderStage.COMPUTE, buffer: {type: 'read-only-storage'}},
        {binding: 8, visibility: GPUShaderStage.COMPUTE, buffer: {type: 'uniform'}},
        {binding: 9, visibility: GPUShaderStage.COMPUTE, buffer: {type: 'read-only-storage'}}
      ]});
      const descriptor = {bindGroupLayouts: Array.from({length: groupIndex}, (_, i) => trace.getBindGroupLayout(i)).concat(output)};
      const layout = this._device.createPipelineLayout(textures ? resourceTableLayout(descriptor) : descriptor);
      const compute = {...this._depthCompute, constants: {...this._depthCompute.constants, DEPTH_QUERY_MODE: 1, AOV_REFLECTANCE: reflectance ? 1 : 0}};
      // Keep the UI responsive during first use, and reuse both variants across
      // preview/final target changes rather than recreating synchronous pipelines.
      void Promise.all([
        this._shaderCache.createComputePipelineAsync({label: 'AOV accumulation', layout, compute: {...compute, entryPoint: 'aovTrace'}}),
        this._shaderCache.createComputePipelineAsync({label: 'AOV center', layout, compute: {...compute, entryPoint: 'aovTraceCenter'}})
      ]).then(([accumulation, center]) => { pending.accumulation = accumulation; pending.center = center; },
        error => { pending.error = error; });
    }
    if (pipelines.error) throw pipelines.error;
    return pipelines;
  }

  prepareAovs(kinds: readonly AovKind[]) {
    const pipelines = this._prepareAovPipelines(kinds);
    return !!pipelines?.accumulation && !!pipelines.center;
  }

  renderAovs(state: WGPUAov, camera: Camera, samples: number, cap: number, kinds: readonly AovKind[]) {
    const groups = this._rayTraceBindGroups;
    if (!groups || !this._tlas || !this._preparedMeshData || !kinds.length) return false;
    const pipelines = this._prepareAovPipelines(kinds);
    if (!pipelines?.accumulation || !pipelines.center) return false;
    state.resize(this._width, this._height);
    const textures = this._bindless, groupIndex = textures ? 2 : 3;
    const target = Math.min(samples, cap);
    if (state.centerReady && state.samples >= target) return true;
    if (!state.frame) {
      const primitiveIds = this._aovPrimitiveCache.get(this._preparedMeshData, this._tlas);
      const packed = packAovScene(this._preparedMeshData, this._tlas, camera, this._width, this._height, state.history, primitiveIds, false);
      state.frame = packed.frame; state.setScene(packed.words, primitiveIds);
    }
    this._device.queue.writeBuffer(this._uniforms.rtUniform, 0, this._rtUniform.buffer);
    this._device.queue.writeBuffer(this._uniforms.cameraUniform, 0, packCameraUniform(this._viewProjInv, this._cameraWorld, this._apertureRadius, this._focusDistance));
    const device = this._device;
    const run = (pipeline: GPUComputePipeline, sample: number) => {
      // A fresh uniform for each queued dispatch keeps batch samples independent.
      const parameters = device.createBuffer({size: 16, usage: GPUBufferUsage.UNIFORM, mappedAtCreation: true});
      new Uint32Array(parameters.getMappedRange()).set([state.width, state.height, sample, aovMask(kinds)]); parameters.unmap();
      const output = device.createBindGroup({layout: pipeline.getBindGroupLayout(groupIndex), entries: [
        {binding: 5, resource: {buffer: state.accumulation!}}, {binding: 6, resource: {buffer: state.center!}},
        {binding: 7, resource: {buffer: state.scene!}}, {binding: 8, resource: {buffer: parameters}}, {binding: 9, resource: {buffer: state.previousCenter!}}
      ]});
      const encoder = device.createCommandEncoder({label: 'AOV'}), pass = encoder.beginComputePass();
      if (textures?.table) setResourceTable(pass, textures.table);
      pass.setPipeline(pipeline); for (let i = 0; i < groupIndex; i++) pass.setBindGroup(i, groups[i]);
      pass.setBindGroup(groupIndex, output); pass.dispatchWorkgroups(Math.ceil(state.width/8), Math.ceil(state.height/8)); pass.end();
      device.queue.submit([encoder.finish()]); parameters.destroy();
    };
    if (!state.centerReady) { run(pipelines.center, 0); state.centerReady = true; state.history.accept(state.frame); }
    if ((aovMask(kinds) & 31) === 0) state.samples = target;
    while (state.samples < target) { run(pipelines.accumulation, state.samples); state.samples++; }
    return true;
  }

  async readDepthSamples(area: DepthSampleArea, aspect?: number): Promise<Float32Array | undefined> {
    const tracePipeline = this._rayTracePipeline;
    const groups = this._rayTraceBindGroups;
    const textures = this._bindless, textureRevision = textures?.revision;
    if (!tracePipeline || !groups || !this._depthCompute || this._isCompilingShader) return;
    const packed = packDepthSampleArea(area, aspect ?? this._width / this._height);
    if (this._depthTracePipeline !== tracePipeline || !this._depthPipeline) {
      const outputLayout = this._shaderCache.createBindGroupLayout({
        label: 'Depth query output',
        entries: [
          { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
          { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } }
        ]
      });
      const descriptor = {
        label: 'Depth query layout',
        bindGroupLayouts: (textures ? [0, 1] : [0, 1, 2]).map(i => tracePipeline.getBindGroupLayout(i)).concat(outputLayout)
      };
      const layout = this._shaderCache.createPipelineLayout(textures ? resourceTableLayout(descriptor) : descriptor);
      this._depthTracePipeline = tracePipeline;
      this._depthPipeline = this._shaderCache.createComputePipelineAsync({
        label: 'Depth query', layout,
        compute: { ...this._depthCompute, entryPoint: 'depthQuery',
          constants: { ...this._depthCompute.constants, DEPTH_QUERY_MODE: 1 } }
      });
    }
    const pipeline = await this._depthPipeline;
    // Scene uploads can replace the buffers while the small query compiles.
    if (tracePipeline !== this._rayTracePipeline || groups !== this._rayTraceBindGroups || textures !== this._bindless || textureRevision !== textures?.revision) return;
    const device = this._device;
    const bytes = DEPTH_SAMPLE_COUNT * 16;
    const output = device.createBuffer({ label: 'Depth samples', size: bytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const readback = device.createBuffer({ label: 'Depth readback', size: bytes,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const params = device.createBuffer({ label: 'Depth area', size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    try {
      device.queue.writeBuffer(params, 0, packed);
      const outputGroup = device.createBindGroup({ layout: pipeline.getBindGroupLayout(textures ? 2 : 3), entries: [
        { binding: 0, resource: { buffer: output } },
        { binding: 4, resource: { buffer: params } }
      ] });
      const encoder = device.createCommandEncoder({ label: 'Depth query' });
      const pass = encoder.beginComputePass();
      if (textures?.table) setResourceTable(pass, textures.table);
      pass.setPipeline(pipeline);
      for (let i = 0; i < (textures ? 2 : 3); i++) pass.setBindGroup(i, groups[i]);
      pass.setBindGroup(textures ? 2 : 3, outputGroup);
      pass.dispatchWorkgroups(1);
      pass.end();
      encoder.copyBufferToBuffer(output, 0, readback, 0, bytes);
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
      return unpackDepthSamples(new Float32Array(readback.getMappedRange()));
    } finally {
      if (readback.mapState === 'mapped') readback.unmap();
      readback.destroy(); output.destroy(); params.destroy();
    }
  }

  isCompilingShader() {
    return this._isCompilingShader;
  }

  isPipelineReady() {
    return (
      (!!this._rayTracePipeline) &&
      !!this._rayTraceBindGroups
    );
  }

  getPipelineError() {
    return this._pipelineError;
  }

  private _updateBindGroups() {
    const {_device} = this;
    const bindGroupPipeline = this._rayTracePipeline;
    if (!bindGroupPipeline) {
      throw new Error('WebGPU ray tracing bind-group pipeline is not ready.');
    }
    if (!this._bvhBuffer || !this._instancesBuffer) {
      throw new Error('WebGPU BVH buffers are not ready.');
    }
    const bufferEntries: GPUBindGroupEntry[] = [
      this._bvhBuffer,
      this._instancesBuffer,
      this._attrBuffers,
      this._materialsBuffer
    ].map(
      (buffer, i) =>
        ({
          binding: i,
          resource: {
            buffer: buffer!
          }
        }) satisfies GPUBindGroupEntry
    );
    const textureEntries: GPUBindGroupEntry[] = [
      ...(this._bindless
        ? []
        : [
            {
              binding: 0,
              resource: this._mapsSampler
            },
            {
              binding: 1,
              resource: this._maps!.createView()
            }
          ]),
      {
        binding: 3,
        resource: {
          buffer: this._bindless?.metadata ?? this._mapInfoUniform
        }
      },
      {binding: 4, resource: this._envTex!.createView()},
      {binding: 5, resource: this._envDistributionTex!.createView()},
      {binding: 6, resource: this._backgroundTex!.createView()},
      ...(this._photonMapping
        ? [
            {binding: 11, resource: this._photonMap!.get(this._activeTarget)!.data.createView()},
            {binding: 12, resource: this._photonMap!.get(this._activeTarget)!.headers.createView()}
          ]
        : []),
      {binding: 8, resource: this._lightSamplingTexture!.createView()},
      {binding: 9, resource: this._openPbrEnergyLut.createView()},
      {
        binding: 10,
        resource: this._adaptiveSamplingTexture.createView()
      }
    ];
    const bufferBindGroup = _device.createBindGroup({
      layout: bindGroupPipeline.getBindGroupLayout(0),
      entries: this._bindless
        ? bufferEntries.concat(textureEntries.map((e) => ({...e, binding: e.binding + 4})))
        : bufferEntries
    });
    const texturesBindGroup = this._bindless
      ? undefined
      : _device.createBindGroup({
          layout: bindGroupPipeline.getBindGroupLayout(1),
          entries: textureEntries
        });
    const uniformBindGroup = _device.createBindGroup({
      layout: bindGroupPipeline.getBindGroupLayout(this._bindless ? 1 : 2),
      entries: Object.keys(this._uniforms).map(
        (key, i) =>
          ({
            binding: i,
            resource: {
              buffer: this._uniforms[key as keyof typeof this._uniforms]
            }
          }) satisfies GPUBindGroupEntry
      )
    });
    if (this._photonMapping) {
      // Explicit layouts still track unused textures. Bind a placeholder while
      // emission writes the real packed map through its storage view.
      const emissionEntries = textureEntries.map((entry) =>
        entry.binding === 11 || entry.binding === 12
          ? {...entry, resource: this._photonMap!.placeholder.createView()}
          : entry
      );
      const sceneGroup = _device.createBindGroup({
        layout: bindGroupPipeline.getBindGroupLayout(this._bindless ? 0 : 1),
        entries: this._bindless
          ? bufferEntries.concat(emissionEntries.map((e) => ({...e, binding: e.binding + 4})))
          : emissionEntries
      });
      this._photonEmissionGroups = this._bindless
        ? [sceneGroup, uniformBindGroup]
        : [bufferBindGroup, sceneGroup, uniformBindGroup];
    }
    const target = this._targetOutputs.get(this._activeTarget)!;
    const outputBindGroup =
      (target.pipeline === bindGroupPipeline && target.bindGroup) ||
      _device.createBindGroup({
        layout: bindGroupPipeline.getBindGroupLayout(this._bindless ? 2 : 3),
        entries: [
          this._outColorBuffer,
          this._outNormalBuffer,
          this._outAlbedoBuffer,
          this._outShadowCatcherBuffer
        ].map(
          (buffer, i) =>
            ({
              binding: i,
              resource: {buffer}
            }) satisfies GPUBindGroupEntry
        )
      });

    target.bindGroup = outputBindGroup;
    target.pipeline = bindGroupPipeline;
    this._rayTraceBindGroups = [
      bufferBindGroup,
      ...(texturesBindGroup ? [texturesBindGroup] : []),
      uniformBindGroup,
      outputBindGroup
    ];
  }

  createPass(
    encoder: GPUCommandEncoder,
    clear: boolean,
    tiles: [number, number],
    timing?: WGPURayTraceTimingCapture
  ) {
    // Update light buffer.
    if (this._needsUpdateAnalyticLightsBuffer) {
      const lightsBufferData = packAnalyticsLightsToBuffer(
        this._analyticLights,
        this._materialData!.getLightTexturesIndices(),
        this._analyticLightSelectionPmfs,
        this._iesProfileTexelOffsets
      );

      this._device.queue.writeBuffer(
        this._uniforms.analyticLights,
        0,
        lightsBufferData.buffer,
        0,
        lightsBufferData.buffer.byteLength
      );
      this._needsUpdateAnalyticLightsBuffer = false;
    }

    const dispatchWidth = Math.ceil(this._width / tiles[0]);
    const dispatchHeight = Math.ceil(this._height / tiles[1]);

    // Update other uniforms
    this._device.queue.writeBuffer(this._uniforms.rtUniform, 0, this._rtUniform.buffer);

    if (clear) {
      encoder.clearBuffer(this._outColorBuffer);
      encoder.clearBuffer(this._outNormalBuffer);
      encoder.clearBuffer(this._outAlbedoBuffer);
      encoder.clearBuffer(this._outShadowCatcherBuffer);
    }

    const offset = this._rtUniform.views.scaleOffset;
    const causticBatch = this._lightTracing && offset[2] === tiles[0] - 1 && offset[3] === tiles[1] - 1;
    const photonBatch = this._photonMapping && offset[2] === 0 && offset[3] === 0;
    if (photonBatch && this._photonMap) {
      const requested = this._causticSettings?.photonMapping,
        initial = typeof requested === 'object' ? requested.initialRadius : undefined;
      const radius =
        Number.isFinite(initial) && initial! > 0 ? initial! : Math.max(this._causticBounds[3] * 0.03, 1e-4);
      const batch = Math.max(
        1,
        this._rtUniform.views.sampleCount[0] - this._rtUniform.views.sampleSequenceOffset[0] + 1
      );
      this._photonMap.encode(
        encoder,
        this._photonEmissionGroups!,
        this._activeTarget,
        photonRadius(radius, batch, causticDiagnostics.photonAlpha ?? 2 / 3),
        {
          querySet: timing?.querySet,
          resourceTable: this._bindless?.table,
          orthographic: !this._causticPerspective,
          width: this._width,
          height: this._height,
          clear,
          run: true,
          photons: 1,
          batch: Math.floor(this._rtUniform.views.sampleCount[0]),
          mnee: this._mnee,
          viewProjection: new Float32Array(16),
          casterSphere: this._causticBounds,
          cameraScale: this._causticCameraScale
        }
      );
    }
    const descriptor: GPUComputePassDescriptor = {};
    const querySet = timing?.querySet;
    if (querySet) {
      descriptor.timestampWrites = {
        querySet,
        beginningOfPassWriteIndex: 0,
        endOfPassWriteIndex: 1
      };
    }

    const pass = encoder.beginComputePass(descriptor);
    if (this._bindless?.table) setResourceTable(pass, this._bindless.table);
    if (!this._rayTracePipeline || !this._rayTraceBindGroups) {
      throw new Error('WebGPU ray tracing pass was submitted before it was ready.');
    }
    pass.setPipeline(this._rayTracePipeline);
    this._rayTraceBindGroups!.forEach((bindGroup, idx) => {
      pass.setBindGroup(idx, bindGroup);
    });

    if (causticDiagnostics.captureRoots) causticDiagnostics.rootPass = this;
    pass.dispatchWorkgroups(
      Math.ceil(dispatchWidth / (this._mnee ? 1 : WORKGROUP_SIZE)),
      Math.ceil(dispatchHeight / (this._mnee ? 1 : WORKGROUP_SIZE)),
      1
    );
    pass.end();
    if (this._lightTracing && this._causticLight) {
      const viewProjection = mat4.create();
      mat4.invert(viewProjection, this._viewProjInv);
      const requested = this._causticSettings?.lightTracing;
      const count = typeof requested === 'object' ? requested.photonsPerSample : undefined;
      const photons = Math.min(
        this._device.limits.maxComputeWorkgroupsPerDimension * 64,
        Math.max(1, Math.round(Number.isFinite(count) ? count! : (this._width * this._height) / 4))
      );
      this._causticLight.encode(
        encoder,
        this._rayTraceBindGroups!.slice(0, this._bindless ? 2 : 3),
        this._activeTarget,
        {
          querySet: causticBatch ? querySet : undefined,
          width: this._width,
          height: this._height,
          clear,
          run: !!causticBatch,
          photons,
          batch: Math.floor(this._rtUniform.views.sampleCount[0]),
          mnee: this._mnee,
          resourceTable: this._bindless?.table,
          orthographic: !this._causticPerspective,
          viewProjection,
          casterSphere: this._causticBounds,
          cameraScale: this._causticCameraScale
        }
      );
    }
    return (causticBatch ? 1 : 0) | (photonBatch ? 2 : 0);
  }

  async getDebugBVHData() {
    if (!this._debugBVHBuffer) {
      throw new Error(
        `software-bvh exposes no CPU-readable BVH debug buffer`
      );
    }
    return {
      buffer: this._debugBVHBuffer
    };
  }

  getDiagnostics() {
    const atlas = this._materialData instanceof MaterialTable ? this._materialData.textureAtlasStats : undefined;
    return {
      textureAtlas: atlas,
      materialTextures: {
        requested: this._textureSelection.requested,
        active: this._bindless ? 'bindless' as const : 'atlas' as const,
        fallbackReason: this._textureSelection.fallbackReason,
        ...(this._bindless?.diagnostics ?? {
          textureCount: atlas?.textureCount ?? 0, estimatedBytes: atlas?.estimatedBytes ?? 0,
          scale: atlas?.scale ?? 1, metadataBytes: 0, resourceTableCapacity: 0, retiredBytes: 0
        })
      },
      shaderCompilation: this._shaderCompilationDiagnostics,
      lightSampling: {
        emissiveTriangles: this._emissiveTriangles.length,
        activeChoices: this._rtUniform.views.lightChoiceCount[0],
        totalWeight: this._rtUniform.views.lightWeightTotal[0],
        domains: this._lightDomainDiagnostics
      },
      bvh: {
        tlasTraversalStackSize:
          this._constants.TLAS_STACK_SIZE as number | undefined,
        blasTraversalStackSize:
          this._constants.BLAS_STACK_SIZE as number | undefined
      }
    };
  }

  setAlphaBlendStrategy(strategy: AlphaBlendStrategy) {
    const next = strategy === 'deterministic-source-over'
      ? strategy
      : 'stochastic';
    if (next === this._alphaBlendStrategy) return false;
    this._alphaBlendStrategy = next;
    if (this._constants.HAS_ALPHA_BLEND) {
      this._computeShaderModule = undefined;
      this._rayTracePipeline = undefined;
      this._rayTracePipelineLayout = undefined;
      this._rayTraceBindGroups = undefined;
      this._prevPipelineConstants = {};
      this._failedPipelineSignature = undefined;
      this._needsUpdateBindGroups = true;
    }
    return true;
  }

  hasDepthOfField() {
    return this._apertureRadius > 0;
  }


  setBounce(bounce: number) {
    const next = normalizeBounces(bounce);
    const changed = this._bounces !== next;
    this._bounces = next;
    this._rtUniform.views.bounces[0] = next;
    return changed;
  }

  setDirectLightCandidates(candidates: number) {
    const next = normalizeDirectLightCandidates(candidates);
    const changed = this._directLightCandidates !== next;
    this._directLightCandidates = next;
    this._rtUniform.views.directLightCandidates[0] = next;
    return changed;
  }

  setClamping(clamping?: number) {
    const changed = this._clamping !== clamping;
    this._rtUniform.views.clamping[0] = clamping ?? 0;
    this._clamping = clamping;
    return changed;
  }

  setBevelSamples(samples: number) {
    const next = normalizeBevelSamples(samples);
    const changed = this._bevelSamples !== next;
    if (changed) {
      this._bevelSamples = next;
      this._constants.BEVEL_SAMPLES = next;
    }
    return changed;
  }

  setSamplingPattern(pattern: SamplingPattern, maxSamples: number, sequenceSeed = 0) {
    const sampling = traceSampling(pattern, maxSamples, sequenceSeed);
    const {code, logSPP} = sampling;
    const views = this._rtUniform.views;
    const changed = this._constants.SAMPLING_PATTERN !== code ||
      views.sequenceSeed[0] !== (sequenceSeed >>> 0) ||
      (code === 1 && views.zSobolLogSPP[0] !== logSPP);
    this._constants.SAMPLING_PATTERN = code;
    writeTraceSampling(views, sampling);
    return changed;
  }

  setSampleSequenceOffset(offset: number) {
    this._rtUniform.views.sampleSequenceOffset[0] = offset;
  }

  setVarianceMoments(enabled: boolean) {
    this._rtUniform.views.varianceMoments[0] = enabled ? 1 : 0;
  }

  setAdaptiveSamplingTargets(targets?: {
    width: number;
    height: number;
    data: Float32Array;
  }) {
    this._rtUniform.views.adaptiveSampling[0] = targets ? 1 : 0;
    if (!targets) return;
    const { width, height, data } = targets;
    if (width <= 0 || height <= 0 || data.length !== width * height) {
      throw new Error('Adaptive sample targets do not match their dimensions.');
    }
    this._ensureAdaptiveSamplingTexture(width, height);
    this._device.queue.writeTexture(
      { texture: this._adaptiveSamplingTexture },
      data,
      { bytesPerRow: width * Float32Array.BYTES_PER_ELEMENT },
      [width, height]
    );
  }

  setQuality(options: {
    bounces: number;
    bevel: boolean;
    dispersionWavelengths: 1 | 3;
    directLightCandidates: number;
    caustics?: import('../Render.js').CausticSettings;
  }) {
    WGPURayTracePass.prototype._setCaustics.call(this, options.caustics);
    writeTraceQuality(this._rtUniform.views, options);
  }

  private _setCaustics(settings?: import('../Render.js').CausticSettings) {
    this._causticSettings = settings;
    const hasCaster =
      !!(causticDiagnostics.mnee || settings?.lightTracing || settings?.photonMapping) &&
      this._meshes.some((mesh) => mesh.materials.some(isCausticSpecular));
    const mnee = !!causticDiagnostics.mnee && hasCaster;
    if (mnee !== !!this._mnee) this._needsUpdateLightSamplingData = true;
    this._mnee = mnee;
    const photonSupported =
      !(settings?.lightTracing || settings?.photonMapping) ||
      !hasCaster ||
      !hasStochasticCausticCaster(this._meshes);
    this._lightTracing = !!settings?.lightTracing && hasCaster && photonSupported;
    const photonMapping = !!settings?.photonMapping && hasCaster && photonSupported;
    if (photonMapping !== !!this._photonMapping) {
      this._rayTracePipelineLayout = undefined;
      this._needsUpdateBindGroups = true;
    }
    this._photonMapping = photonMapping;
    this._causticKey =
      this._mnee || this._lightTracing || this._photonMapping
        ? `${this._mnee}/${this._lightTracing}/${this._photonMapping}/${causticDiagnostics.fullEmissionRandom !== false}/${causticDiagnostics.photonMaxDepth ?? 20}/${causticDiagnostics.mneeDebugGroup}/${causticDiagnostics.mneeSeeds ?? 4}/${!!causticDiagnostics.mneeDamping}/${!!causticDiagnostics.smsRoulette}/${causticDiagnostics.mneeMaxDepth ?? 20}/${typeof causticDiagnostics.mnee === 'object' ? causticDiagnostics.mnee.method : 'newton'}`
        : '';
  }

  private _setEnvMap(envImage: EnvironmentSource | undefined) {
    const device = this._device;
    // Always create env tex
    if (
      !environmentMapSourcesMatch(envImage, this._envImageSource) ||
      !this._envTex
    ) {
      this._envImageSource = envImage;

      const sky = envImage && 'sky' in envImage ? envImage : undefined;
      if (sky && (sky.width + 2 > device.limits.maxTextureDimension2D || sky.height + 1 > device.limits.maxTextureDimension2D)) throw new RangeError('ProceduralSky resolution exceeds the device texture size limit.');
      const gpuDistribution = envImage && (sky || envImage.width * envImage.height >= 65536) &&
        WGPUEnvMapDistribution.supported(device, envImage.width, envImage.height);
      if (sky && !gpuDistribution) throw new RangeError('ProceduralSky resolution exceeds the GPU sampling storage limit; reduce resolution.');
      const distribution = envImage && !('sky' in envImage) && !gpuDistribution ? envMapDistribution(envImage) : undefined;
      const distributionWidth = envImage ? envImage.width + 2 : 1;
      const distributionHeight = envImage ? envImage.height + 1 : 1;
      const width = envImage?.width ?? 1;
      const height = envImage?.height ?? 1;
      const resized = !this._envTex || this._envTex.width !== width || this._envTex.height !== height ||
        !this._envDistributionTex || this._envDistributionTex.width !== distributionWidth || this._envDistributionTex.height !== distributionHeight;
      if (resized) {
        this._envTex?.destroy();
        this._envDistributionTex?.destroy();
        const usage =
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_DST |
          GPUTextureUsage.RENDER_ATTACHMENT;
        this._envTex = device.createTexture({
          format: 'rgba32float',
          usage: usage | GPUTextureUsage.STORAGE_BINDING,
          label: 'Env',
          size: {
            width,
            height,
            depthOrArrayLayers: 1
          }
        });
        this._envDistributionTex = device.createTexture({
          format: 'rg32float',
          usage: usage | GPUTextureUsage.STORAGE_BINDING,
          label: 'Env Distribution',
          size: {
            width: distributionWidth,
            height: distributionHeight,
            depthOrArrayLayers: 1
          }
        });
      }
      if (envImage) {
        if ('sky' in envImage) {
          this._skyBaker ??= new WGPUSkyBaker(device);
          this._skyBaker.bake(envImage, this._envTex!);
        } else device.queue.writeTexture(
          {
            texture: this._envTex!
          },
          envImage.data.buffer,
          {
            bytesPerRow: envImage.width * 4 * 4
          },
          {
            width: envImage.width,
            height: envImage.height,
            depthOrArrayLayers: 1
          }
        );
        if (gpuDistribution) {
          this._envDistribution ??= new WGPUEnvMapDistribution(device);
          this._envDistribution.build(this._envTex!, this._envDistributionTex!);
        } else if (distribution) {
          this._envDistribution?.dispose();
          device.queue.writeTexture(
            { texture: this._envDistributionTex! }, distribution.data.buffer,
            { bytesPerRow: distribution.width * 4 * 2 },
            { width: distribution.width, height: distribution.height, depthOrArrayLayers: 1 }
          );
        }
      } else this._envDistribution?.dispose();

      this._needsUpdateBindGroups ||= resized;
    }

    this._constants.USE_ENVMAP = !!envImage;
  }

  setMeshes(meshes: Mesh[], update?: { transforms?: readonly Mesh[]; colors?: readonly Mesh[]; geometries?: readonly Geometry[]; materials?: readonly OpenPBRMaterial[] }) {
    for (const mesh of update?.colors ?? []) this._dirtyColorMeshes.add(mesh);
    if (update && this._preparedMeshData && this._materialData &&
      !this._needsUpdateMeshData && !this._needsUpdateMeshMembership && meshes === this._meshes) {
      const materialUpdate = this._materialChanges.classify(update.materials ?? []);
      if (materialUpdate.level !== 'geometry' && canUpdateGeometries(this._preparedMeshData, update.geometries ?? [])) {
        if (update.materials?.length) {
          const pending = this._pendingMaterialUpdate;
          this._pendingMaterialUpdate = {
            level: pending?.level === 'textures' ? 'textures' : materialUpdate.level,
            emission: !!pending?.emission || materialUpdate.emission,
            emissiveMap: !!pending?.emissiveMap || materialUpdate.emissiveMap,
            materials: new Set([...(pending?.materials ?? []), ...update.materials])
          };
          this._meshSnapshot.forEach(item => { item.materialKeys = item.materials.map(getMaterialHashKey); });
        }
        for (const geometry of update.geometries ?? []) this._pendingGeometryUpdates.add(geometry);
        for (const item of this._meshSnapshot) if (this._pendingGeometryUpdates.has(item.geometry)) item.geometryVersion = item.geometry.version;
        for (const mesh of update.transforms ?? []) {
          const item = this._snapshotByMesh.get(mesh);
          if (!item) continue;
          item.matrix = Array.from(mesh.transform);
          this._dirtyTransformMeshes.add(mesh);
          this._needsRefitTLAS = true;
        }
        return !!update.materials?.length || !!update.transforms?.length || !!update.colors?.length || !!update.geometries?.length;
      }
    }
    const transformOnlyMeshes = update?.materials?.length || update?.colors?.length ? undefined : update?.transforms;
    const materialChange = !!update?.materials?.length;
    if (
      transformOnlyMeshes && !transformOnlyMeshes.some(mesh => mesh instanceof InstancedMesh) &&
      meshes === this._meshes &&
      this._meshSnapshot.length === meshes.length &&
      this._meshSnapshot.every(
        (snapshot) =>
          snapshot.geometryVersion === snapshot.geometry.version &&
          snapshot.bvh === getGeometryBvh(snapshot.geometry)
      )
    ) {
      let transformChange = false;
      for (const mesh of transformOnlyMeshes) {
        const snapshot = this._snapshotByMesh.get(mesh);
        if (!snapshot) continue;
        const matrix = mesh.transform;
        if (
          snapshot.matrix.length === matrix.length &&
          snapshot.matrix.every((value, index) => value === matrix[index])
        ) {
          continue;
        }
        snapshot.matrix = Array.from(matrix as ArrayLike<number>);
        this._dirtyTransformMeshes.add(mesh);
        transformChange = true;
      }
      if (transformChange) {
        this._needsRefitTLAS = true;
      }
      return transformChange;
    }
    const previousSnapshot = this._meshSnapshot;
    const nextSnapshot = meshes.map((mesh) => ({
      mesh,
      instanceCount: mesh instanceof InstancedMesh ? mesh.count : 1,
      instanceVersion: mesh instanceof InstancedMesh ? mesh.transformsVersion : 0,
      instanceTransforms: mesh instanceof InstancedMesh ? mesh.transforms : undefined,
      instanceColors: mesh instanceof InstancedMesh ? mesh.colors : undefined,
      colorVersion: mesh instanceof InstancedMesh ? mesh.colorsVersion : 0,
      geometry: mesh.geometry,
      bvh: getGeometryBvh(mesh.geometry),
      materials: mesh.materials.slice(),
      materialKeys: mesh.materials.map(getMaterialHashKey),
      geometryVersion: mesh.geometry.version,
      positionArray: mesh.geometry.position.array,
      positionItemSize: mesh.geometry.position.itemSize,
      indexArray: mesh.geometry.indices.array,
      indexItemSize: mesh.geometry.indices.itemSize,
      materialIndexArray: mesh.geometry.materialIndex?.array,
      materialIndexItemSize: mesh.geometry.materialIndex?.itemSize,
      matrix: Array.from(mesh.transform as ArrayLike<number>)
    }));
    const membershipChanged = nextSnapshot.length !== previousSnapshot.length ||
      nextSnapshot.some((item, i) => item.mesh !== previousSnapshot[i]?.mesh || item.instanceCount !== previousSnapshot[i]?.instanceCount ||
        item.materials.some((material, k) => material !== previousSnapshot[i]?.materials[k]));
    const membership = !this._needsUpdateMeshData && membershipChanged && this._preparedMeshData
      ? this._membershipCache.update(this._preparedMeshData, meshes) : undefined;
    if (membership) {
      const versions = new Map(previousSnapshot.flatMap(item => item.materials.map((m, i) => [m, item.materialKeys[i]] as const)));
      const materialsChanged = membership.materials.length !== this._preparedMeshData!.materials.length ||
        membership.materials.some((m, i) => m !== this._preparedMeshData!.materials[i] ||
          versions.has(m) && getMaterialHashKey(m) !== versions.get(m));
      this._pendingMembershipData = membership;
      this._meshes = meshes;
      this._meshSnapshot = nextSnapshot;
      this._snapshotByMesh = new WeakMap();
      nextSnapshot.forEach(item => this._snapshotByMesh.set(item.mesh, item));
      this._needsUpdateMeshMembership = true;
      this._needsRefitTLAS = false;
      this._dirtyTransformMeshes.clear();
      if (materialsChanged) this._pendingMaterialUpdate = { level: 'textures', emission: true,
        emissiveMap: true, materials: new Set(membership.materials) };
      return true;
    }
    const membershipOnlyChange =
      !!this._residentPreparedMeshData &&
      (
        nextSnapshot.length !== previousSnapshot.length ||
        nextSnapshot.some(
          (next, index) => next.mesh !== previousSnapshot[index]?.mesh
        )
      ) &&
      nextSnapshot.every((next) => {
        const resident = this._residentSnapshotByMesh.get(next.mesh);
        return (
          !!resident &&
          next.colorVersion === resident.colorVersion && next.instanceColors === resident.instanceColors &&
          next.geometry === resident.geometry &&
          next.bvh === resident.bvh &&
          next.materials.length === resident.materials.length &&
          next.materials.every(
            (material, index) => material === resident.materials[index]
          ) &&
          next.materialKeys.every(
            (hash, index) => hash === resident.materialKeys[index]
          ) &&
          next.geometryVersion === resident.geometryVersion &&
          this._materialChanges.classify(next.materials).level === 'params' &&
          next.positionArray === resident.positionArray &&
          next.indexArray === resident.indexArray &&
          next.materialIndexArray === resident.materialIndexArray &&
          next.matrix.every(
            (value, index) => value === resident.matrix[index]
          )
        );
      });
    if (membershipOnlyChange) {
      this._meshes = meshes;
      this._meshSnapshot = nextSnapshot;
      this._snapshotByMesh = new WeakMap();
      nextSnapshot.forEach((snapshot) => {
        this._snapshotByMesh.set(snapshot.mesh, snapshot);
      });
      this._needsUpdateMeshMembership = true;
      this._needsRefitTLAS = false;
      this._dirtyTransformMeshes.clear();
      return true;
    }
    const topologyOrMaterialChange =
      nextSnapshot.length !== previousSnapshot.length ||
      nextSnapshot.some((next, i) => {
        const prev = previousSnapshot[i];
        return (
          !prev ||
          next.mesh !== prev.mesh || next.instanceCount !== prev.instanceCount ||
          next.geometry !== prev.geometry ||
          next.bvh !== prev.bvh || next.colorVersion !== prev.colorVersion || next.instanceColors !== prev.instanceColors ||
          next.materials.length !== prev.materials.length ||
          next.materials.some((material, k) => material !== prev.materials[k]) ||
          next.materialKeys.some((hash, k) => hash !== prev.materialKeys[k]) ||
          next.positionArray !== prev.positionArray ||
          next.positionArray.length !== prev.positionArray.length ||
          next.positionItemSize !== prev.positionItemSize ||
          next.indexArray !== prev.indexArray ||
          next.indexArray.length !== prev.indexArray.length ||
          next.indexItemSize !== prev.indexItemSize ||
          next.materialIndexArray !== prev.materialIndexArray ||
          next.materialIndexArray?.length !== prev.materialIndexArray?.length ||
          next.materialIndexItemSize !== prev.materialIndexItemSize
        );
      });
    const geometryChange = !topologyOrMaterialChange &&
      nextSnapshot.some((next, i) =>
        next.geometryVersion !== previousSnapshot[i].geometryVersion
      );
    const structuralChange = topologyOrMaterialChange || geometryChange;
    const transformChange =
      !topologyOrMaterialChange &&
      nextSnapshot.some((next, i) =>
        next.instanceVersion !== previousSnapshot[i].instanceVersion || next.instanceTransforms !== previousSnapshot[i].instanceTransforms || next.matrix.some((value, k) => value !== previousSnapshot[i].matrix[k])
      );
    this._meshes = meshes;
    nextSnapshot.forEach((next, i) => {
      const prev = previousSnapshot[i];
      if (prev?.geometry === next.geometry && (prev.positionArray !== next.positionArray || prev.indexArray !== next.indexArray)) {
        setGeometryBvh(next.geometry, undefined); this._geometriesNeedRefit.add(next.geometry);
      }
      // A mesh can be animated before this renderer sees it for the first
      // time. Its precomputed BLAS may then describe an older pose as well.
      if (next.geometryVersion > 0 && (
        !prev || next.geometry !== prev.geometry ||
        next.geometryVersion !== prev.geometryVersion
      )) {
        this._geometriesNeedRefit.add(next.geometry);
      }
    });
    this._meshSnapshot = nextSnapshot;
    this._snapshotByMesh = new WeakMap();
    nextSnapshot.forEach((snapshot) => {
      this._snapshotByMesh.set(snapshot.mesh, snapshot);
    });
    if (structuralChange) {
      this._needsUpdateMeshData = true;
      this._needsUpdateMeshMembership = false;
      this._needsRefitTLAS = false;
      this._dirtyTransformMeshes.clear();
    } else if (transformChange) {
      this._needsRefitTLAS = true;
      nextSnapshot.forEach((next, index) => {
        if (
          next.instanceVersion !== previousSnapshot[index].instanceVersion || next.instanceTransforms !== previousSnapshot[index].instanceTransforms || next.matrix.some(
            (value, matrixIndex) =>
              value !== previousSnapshot[index]?.matrix[matrixIndex]
          )
        ) {
          this._dirtyTransformMeshes.add(next.mesh);
        }
      });
    }
    if (materialChange || !update && !structuralChange && !transformChange) {
      this._needsUpdateMeshData = true;
    }
    return structuralChange || transformChange || materialChange || !update;
  }

  setTextureAtlasBudget(maxBytes: number) {
    const next = Number.isFinite(maxBytes)
      ? Math.max(4, Math.floor(maxBytes))
      : DEFAULT_MAX_TEXTURE_ARRAY_BYTES;
    if (next === this._maxTextureArrayBytes) return false;
    this._maxTextureArrayBytes = next;
    this._needsUpdateMeshData = true;
    return true;
  }

  setBackground(background?: SceneBackground) {
    this._rtUniform.views.backgroundMapTransform.set(backgroundMapTransform(background));
    this._rtUniform.views.backgroundMapRotation.set(backgroundMapRotation(background));
    this._constants.USE_BACKGROUND = !!background;
    const backgroundImage =
      background && !Array.isArray(background)
        ? generateBackgroundMapFromSceneBackground(background)
        : undefined;
    this._constants.USE_BACKGROUND_MAP = !!backgroundImage;
    if (Array.isArray(background)) {
      this._rtUniform.views.backgroundColor.set(new F32(background));
    }
    const grounded =
      background &&
      !Array.isArray(background) &&
      'type' in background &&
      background.type === 'GroundedSkybox'
        ? background
        : undefined;
    this._rtUniform.views.groundedBackgroundParams.set(
      grounded
        ? [
            Math.max(grounded.height, 0.0001),
            Math.max(grounded.radius, 0.0001),
            grounded.groundHeight ?? 0,
            1
          ]
        : [0, 0, 0, 0]
    );
    this._rtUniform.views.groundedBackgroundCenter.set(grounded?.center ?? [0, 0]);
    this._constants.USE_GROUNDED_BACKGROUND = !!grounded;
    this._rtUniform.views.backgroundFlags[0] =
      ((background ? 1 : 0) | (backgroundImage ? 2 : 0) | (grounded ? 4 : 0)) |
      (this._rtUniform.views.backgroundFlags[0] & 0x80000000);
    this._setBackgroundMap(backgroundImage);
  }

  private _setBackgroundMap(
    backgroundImage: EnvironmentSource | undefined
  ) {
    if (backgroundImage === this._backgroundImageSource && this._backgroundTex) {
      return;
    }
    this._backgroundImageSource = backgroundImage;
    const width = backgroundImage?.width ?? 1;
    const height = backgroundImage?.height ?? 1;
    if (backgroundImage && 'sky' in backgroundImage && (width > this._device.limits.maxTextureDimension2D || height > this._device.limits.maxTextureDimension2D)) throw new RangeError('ProceduralSky resolution exceeds the device texture size limit.');
    const resized = !this._backgroundTex || this._backgroundTex.width !== width || this._backgroundTex.height !== height;
    if (resized) {
      this._backgroundTex?.destroy();
      this._backgroundTex = this._device.createTexture({
        format: 'rgba32float',
        usage:
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_DST |
          GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.STORAGE_BINDING,
        label: 'Background',
        size: { width, height, depthOrArrayLayers: 1 }
      });
    }
    if (backgroundImage && 'sky' in backgroundImage) {
      this._skyBaker ??= new WGPUSkyBaker(this._device);
      this._skyBaker.bake(backgroundImage, this._backgroundTex!);
    } else if (backgroundImage) {
      const source = backgroundImage.data;
      const data =
        source instanceof Float32Array
          ? source
          : source instanceof Uint8Array || source instanceof Uint8ClampedArray
            ? Float32Array.from(source, value => value / 255)
            : Float32Array.from(source);
      this._device.queue.writeTexture(
        { texture: this._backgroundTex! },
        data.buffer,
        { bytesPerRow: width * 4 * 4 },
        { width, height, depthOrArrayLayers: 1 }
      );
    }
    this._needsUpdateBindGroups ||= resized;
  }

  private _updateLightSamplingData() {
    this._constants.LIGHT_CAPABILITIES = lightShaderCapabilities(
      this._analyticLights.map((light) => light.type),
      this._emissiveTriangles.length
    );
    const lighting = prepareSceneLightSampling(
      this._analyticLights,
      this._emissiveTriangles,
      this._envImageSource && 'sky' in this._envImageSource
        ? proceduralEnvironmentPower(this._envImageSource)
        : estimateEnvironmentPower(this._envImageSource),
      this._device.limits.maxTextureDimension2D,
      this._lightChoices,
      this._lightSamplingScratch,
      this._shadowCatcherLightChoices
    );
    if (this._mnee && this._preparedMeshData) {
      const seed = this._causticSeeds.collect(
        this._preparedMeshData.instanceBindings,
        this._preparedMeshData.materials
      );
      const offset = lighting.lightData.length / 4;
      this._constants.CAUSTIC_SEED_OFFSET = offset;
      this._constants.CAUSTIC_SEED_COUNT = seed.count;
      const texels = offset + seed.data.length / 4,
        width = Math.min(Math.max(1, texels), this._device.limits.maxTextureDimension2D),
        height = Math.ceil(texels / width);
      const data = new Float32Array(width * height * 4);
      data.set(lighting.lightData);
      data.set(seed.data, offset * 4);
      lighting.lightData = data;
      lighting.lightWidth = width;
      lighting.lightHeight = height;
    } else {
      delete this._constants.CAUSTIC_SEED_OFFSET;
      delete this._constants.CAUSTIC_SEED_COUNT;
    }
    this._analyticLightSelectionPmfs = lighting.analyticPmfs;
    this._iesProfileTexelOffsets = lighting.profiles.offsets;
    this._lightDomainDiagnostics = lighting.domains;
    const {lightWidth: width, lightHeight: height, lightData: textureData} = lighting;
    writeTraceLighting(this._rtUniform.views, lighting);
    const resized =
      !this._lightSamplingTexture ||
      width !== this._lightSamplingTextureSize[0] ||
      height !== this._lightSamplingTextureSize[1];
    if (
      !this._lightSamplingTexture ||
      width !== this._lightSamplingTextureSize[0] ||
      height !== this._lightSamplingTextureSize[1]
    ) {
      this._lightSamplingTexture?.destroy();
      this._lightSamplingTexture = this._device.createTexture({
        label: 'Light sampling data',
        size: [width, height],
        format: 'rgba32float',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
      });
      this._lightSamplingTextureSize = [width, height];
      this._needsUpdateBindGroups = true;
    }
    const previous = this._lightSamplingData;
    const full = resized || !previous || this._lightSamplingTriangleCount !== this._emissiveTriangles.length;
    const words = new Uint32Array(textureData.buffer);
    const oldWords = previous && new Uint32Array(previous.buffer);
    let startRow = -1;
    for (let row = 0; row <= height; row++) {
      let changed = row < height && full;
      if (row < height && !full) {
        for (let i = row * width * 4; i < (row + 1) * width * 4; i++) {
          if (words[i] !== oldWords![i]) {
            changed = true;
            break;
          }
        }
      }
      if (changed && startRow < 0) startRow = row;
      if (!changed && startRow >= 0) {
        this._device.queue.writeTexture(
          {texture: this._lightSamplingTexture!, origin: [0, startRow]},
          textureData.subarray(startRow * width * 4, row * width * 4),
          {bytesPerRow: width * 16},
          {width, height: row - startRow}
        );
        startRow = -1;
      }
    }
    this._lightSamplingScratch = previous;
    this._lightSamplingData = textureData;
    this._lightSamplingTriangleCount = this._emissiveTriangles.length;
    this._needsUpdateAnalyticLightsBuffer = true;
    this._needsUpdateLightSamplingData = false;
  }

  /** Uploads the combined TLAS/BLAS buffer and the instance records. */
  private _uploadBVH(tlas: FlattendBVH, blases: Parameters<typeof concatBLASBuffers>[0]) {
    const stacks = getTraversalStackSizes(tlas, blases);
    this._constants.TLAS_STACK_SIZE = retainedShaderCapacity(stacks.tlas, Number(this._constants.TLAS_STACK_SIZE ?? 0));
    this._constants.BLAS_STACK_SIZE = retainedShaderCapacity(stacks.blas, Number(this._constants.BLAS_STACK_SIZE ?? 0), 32);
    const tlasBuffer = new Float32Array(tlas.buffer);
    const blasBuffer = new Float32Array(concatBLASBuffers(blases));
    const bvhData = new Float32Array(tlasBuffer.length + blasBuffer.length);
    const blasOffset = tlasBuffer.length / 4;
    bvhData.set(tlasBuffer);
    bvhData.set(blasBuffer, blasOffset * 4);
    const bvhBuffer = this._updateGPUBuffer('BVH', this._bvhBuffer, bvhData);
    const instancesBuffer = this._updateGPUBuffer(
      'Instances',
      this._instancesBuffer,
      new Float32Array(tlas.instancesBuffer!)
    );
    if (bvhBuffer !== this._bvhBuffer || instancesBuffer !== this._instancesBuffer) {
      this._needsUpdateBindGroups = true;
    }
    this._bvhBuffer = bvhBuffer;
    this._instancesBuffer = instancesBuffer;
    this._debugBVHBuffer = bvhData.buffer.slice(0);
    this._rtUniform.views.blasOffset.set([blasOffset]);
  }

  private _updateMeshData() {
    this._pendingGeometryUpdates.clear();
    this._emissiveCache = new EmissiveTriangleCache();
    const meshes = this._meshes;
    for (const geometry of this._geometriesNeedRefit) {
      const usesDisplacement = meshes.some(
        (mesh) =>
          mesh.geometry === geometry &&
          !!mesh.materials[0]?.displacementMap &&
          (mesh.materials[0].displacementScale !== 0 || mesh.materials[0].displacementBias !== 0)
      );
      if (usesDisplacement || geometryTopologyChanged(this._preparedMeshData, geometry) || !getGeometryBvh(geometry) || !refitBLAS(getGeometryBvh(geometry)!, geometry)) {
        setGeometryBvh(geometry, undefined);
      }
    }
    this._geometriesNeedRefit.clear();
    // TODO check bvh needs to change
    const res = updateMeshInstances(meshes);
    this._preparedMeshData = res;
    this._membershipCache.capture(res);
    this._pendingMembershipData = undefined;
    this._needsUpdateMeshMembership = false;
    const mergedGeometry = res.geometry;
    const materials = res.materials;
    const isEmpty = meshes.length === 0 || res.instances.length === 0;
    const tlas = buildTLAS(res.instances, res.blases);
    this._tlas = tlas;
    this._uploadBVH(tlas, res.blases);

    const materialData = (this._materialData = this._createMaterialData(
      materials,
      this._analyticLights,
      {
        maxTextureArrayBytes: this._maxTextureArrayBytes,
        maxTextureArrayLayers: this._device.limits.maxTextureArrayLayers,
        maxTextureDimension2D: this._device.limits.maxTextureDimension2D
      }
    ));
    this._emissiveTriangles = this._emissiveCache.collect(
      res.emissiveBindings,
      materials
    );
    this._needsUpdateLightSamplingData = true;

    const attributeLayout = sceneAttributeLayout(mergedGeometry);
    const {stride, offsets} = attributeLayout;

    const attrBufferData = new F32(
      mergedGeometry.vertexCount * stride
    );
    packVertexAttributes(mergedGeometry, attrBufferData, stride, offsets, 0, mergedGeometry.vertexCount);

    this._attributeData = attrBufferData; this._attributeStride = stride; this._attributeOffsets = offsets;
    this._attrBuffers = this._updateGPUBuffer(
      'Attributes',
      this._attrBuffers,
      attrBufferData
    );

    this._materialsBuffer = this._updateGPUBuffer(
      'Materials',
      this._materialsBuffer,
      materialData.getBufferArray(),
      // WGSL requires a runtime array binding to contain at least one
      // MaterialBuffer element, including while a
      // scene reload temporarily has no material payload.
      MATERIAL_FLOAT_COUNT * 4
    );

    const traversalStackSizes = getTraversalStackSizes(tlas, res.blases);
    const blasLayoutBits = {
      bvh2: 1,
      bvh4: 2,
      'bvh-gpu': 4,
      cwbvh: 8
    } as const;
    this._blasLayoutMask = res.blases.reduce(
      (mask, blas) => mask | blasLayoutBits[blas.bvh.layout ?? 'bvh2'],
      0
    );

    Object.assign(this._constants, sceneTraversalConstants(traversalStackSizes.tlas, traversalStackSizes.blas, this._constants), attributeLayout.constants);
    this._updateMaterialConstants(materials, materialData, mergedGeometry);
    this._updateTextures(materialData);

    this._needsUpdateBindGroups = true;

    this._rtUniform.views.isEmpty[0] = +isEmpty;
    this._meshSnapshot.forEach((snapshot) => {
      snapshot.bvh = getGeometryBvh(snapshot.geometry);
    });
    this._residentPreparedMeshData = res;
    this._residentSnapshotByMesh = new WeakMap();
    this._meshSnapshot.forEach((snapshot) => {
      this._residentSnapshotByMesh.set(snapshot.mesh, snapshot);
    });
    this._materialChanges.capture(materials);
    this._pendingMaterialUpdate = undefined;
    this._needsUpdateMeshData = false;
    this._needsUpdateMeshMembership = false;
    this._needsRefitTLAS = false;
  }

  private _updateMaterialConstants(materials: OpenPBRMaterial[], materialData: MaterialTable | WGPUBindlessMaterialData, mergedGeometry: Geometry) {
    const hasTransmission = materials.some((m) => m.transmissionWeight > 0);
    if (hasTransmission !== this._hasTransmission) {
      this._hasTransmission = hasTransmission;
    }

    this._hasShadowCatcher = materials.some((m) => m.shadowCatcher);

    const hasDisplacement = materialData.getDisplacementMaps().length > 0;
    if (hasDisplacement !== this._hasDisplacement) {
      this._hasDisplacement = hasDisplacement;
      // Needs to recreate pipeline layout
      this._rayTracePipelineLayout = undefined;
    }

    Object.assign(this._constants, wgpuMaterialConstants(materials, materialData, mergedGeometry,
      this._bevelSamples, Number(this._constants.NUM_MAPS ?? 0)));
    // Runtime storage metadata has no texture-count specialization.
    if (this._bindless) this._constants.NUM_MAPS = 20;
  }

  private _updateGeometryData() {
    const res = this._preparedMeshData!, tlas = this._tlas!;
    const update = updatePreparedGeometries(res, this._pendingGeometryUpdates);
    for (const { first, count, topologyChanged, deformationOnly } of update.vertices) {
      packVertexAttributes(res.geometry, this._attributeData!, this._attributeStride, this._attributeOffsets, first, count, topologyChanged, deformationOnly);
      const offset = first * this._attributeStride * 4, size = count * this._attributeStride * 4;
      this._device.queue.writeBuffer(this._attrBuffers!, offset, this._attributeData!.buffer, offset, size);
    }
    for (const mesh of update.meshes) this._dirtyTransformMeshes.add(mesh);
    if (update.relocated) for (const binding of res.instanceBindings) this._dirtyTransformMeshes.add(binding.mesh);
    // Instance BLAS offsets must be refreshed before uploading a resized BVH.
    if (update.resized) {
      res.instances = updateMeshInstanceTransforms(res.instanceBindings);
      refitTLAS(tlas, res.instances, res.blases);
      this._uploadBVH(tlas, res.blases);
    } else {
      const bytes = new Uint8Array(this._debugBVHBuffer!);
      const ranges = [];
      for (const { blas, offset } of update.blases) {
        const target = tlas.buffer.byteLength + offset;
        bytes.set(new Uint8Array(blas.buffer), target);
        ranges.push({offset: target, size: blas.buffer.byteLength});
      }
      for (const { offset, size } of mergeRefitRanges(ranges)) {
        this._device.queue.writeBuffer(this._bvhBuffer!, offset, this._debugBVHBuffer!, offset, size);
      }
    }
    const bits = { bvh2: 1, bvh4: 2, 'bvh-gpu': 4, cwbvh: 8 };
    this._blasLayoutMask = res.blases.reduce((mask, b) => mask | bits[b.bvh.layout ?? 'bvh2'], 0);
    const stacks = getTraversalStackSizes(tlas, res.blases);
    this._constants.BLAS_STACK_SIZE = retainedShaderCapacity(stacks.blas, Number(this._constants.BLAS_STACK_SIZE ?? 0), 32);
    this._meshSnapshot.forEach(item => { item.bvh = getGeometryBvh(item.geometry); });
    this._needsRefitTLAS = true; this._pendingGeometryUpdates.clear();
  }

  private _updateMaterialData() {
    const update = this._pendingMaterialUpdate!;
    const res = this._preparedMeshData!;
    let materialData = this._materialData!;
    if (update.level === 'textures') {
      materialData = this._materialData = this._createMaterialData(res.materials, this._analyticLights, {
        maxTextureArrayBytes: this._maxTextureArrayBytes,
        maxTextureArrayLayers: this._device.limits.maxTextureArrayLayers,
        maxTextureDimension2D: this._device.limits.maxTextureDimension2D
      });
      this._updateTextures(materialData);
    } else materialData.repackParams(res.materials);
    this._materialsBuffer = this._updateGPUBuffer('Materials', this._materialsBuffer, materialData.getBufferArray(), MATERIAL_FLOAT_COUNT * 4);
    this._updateMaterialConstants(res.materials, materialData, res.geometry);
    if (update.emission || update.emissiveMap) {
      const resident = this._residentPreparedMeshData!;
      resident.emissiveBindings = resident.instanceBindings.filter(binding =>
        binding.materialIndices.some(index => materialIsEmissive(res.materials[index])));
      const active = new Set(this._meshes);
      res.emissiveBindings = resident.emissiveBindings.filter(binding => active.has(binding.mesh));
      this._emissiveTriangles = this._emissiveCache.collect(res.emissiveBindings, res.materials);
      this._needsUpdateLightSamplingData = true;
    }
    this._needsUpdateBindGroups = true;
    this._materialChanges.capture([...update.materials]);
    this._pendingMaterialUpdate = undefined;
  }

  /** Rebuilds only instance acceleration data for a cached mesh subset. */
  private _updateMeshMembership() {
    const resident = this._pendingMembershipData ?? this._residentPreparedMeshData;
    const pending = this._pendingMembershipData;
    if (!resident) {
      this._needsUpdateMeshData = true;
      this._needsUpdateMeshMembership = false;
      return;
    }
    const activeMeshes = new Set(this._meshes);
    const instanceBindings = resident.instanceBindings.filter(({ mesh }) =>
      activeMeshes.has(mesh)
    );
    const emissiveBindings = resident.emissiveBindings.filter(({ mesh }) =>
      activeMeshes.has(mesh)
    );
    const instances = updateMeshInstanceTransforms(instanceBindings);
    const res = {
      ...resident,
      instances,
      instanceBindings,
      emissiveBindings
    };
    this._preparedMeshData = res;
    if (pending) this._residentPreparedMeshData = res;
    this._pendingMembershipData = undefined;
    const tlas = buildTLAS(instances, res.blases);
    this._tlas = tlas;
    this._uploadBVH(tlas, res.blases);

    this._emissiveTriangles = this._emissiveCache.collect(
      emissiveBindings,
      res.materials
    );
    this._needsUpdateLightSamplingData = true;
    this._rtUniform.views.isEmpty[0] = +(instances.length === 0);
    this._meshSnapshot.forEach((snapshot) => {
      snapshot.bvh = getGeometryBvh(snapshot.geometry);
    });
    this._needsUpdateMeshMembership = false;
  }

  private _updateMeshColors() {
    const res = this._preparedMeshData, tlas = this._tlas;
    if (res && tlas) {
      const dirty = updateMeshInstanceColors(res.instanceBindings, res.instances, this._dirtyColorMeshes);
      const ranges = updateTLASInstanceColors(tlas, res.instances, dirty);
      if (this._instancesBuffer) for (const {offset, size} of ranges) {
        this._device.queue.writeBuffer(this._instancesBuffer, offset, tlas.instancesBuffer!, offset, size);
      }
    }
    this._dirtyColorMeshes.clear();
  }

  private _refitMeshInstances() {
    const res = this._preparedMeshData;
    const tlas = this._tlas;
    if (!res || !tlas || !this._bvhBuffer || !this._instancesBuffer) {
      this._needsUpdateMeshData = true;
      this._needsRefitTLAS = false;
      return;
    }

    const dirtyIndices = dirtyMeshInstanceIndices(res.instanceBindings, this._dirtyTransformMeshes, res.instances);
    const incremental = dirtyIndices.size > 0;
    const previousInstances = res.instances;
    res.instances = updateMeshInstanceTransforms(
      res.instanceBindings,
      incremental ? res.instances : undefined,
      incremental ? dirtyIndices : undefined
    );
    if (!sameInstanceMembership(previousInstances, res.instances)) {
      this._tlas = buildTLAS(res.instances, res.blases);
      this._uploadBVH(this._tlas, res.blases);
      this._emissiveTriangles = this._emissiveCache.collect(res.emissiveBindings, res.materials);
      this._needsUpdateLightSamplingData = true;
      this._rtUniform.views.isEmpty[0] = +(res.instances.length === 0);
      this._dirtyTransformMeshes.clear(); this._needsRefitTLAS = false;
      return;
    }
    const ranges = refitTLAS(
      tlas,
      res.instances,
      res.blases,
      incremental ? dirtyIndices : undefined
    );
    const tlasData = new Float32Array(tlas.buffer);
    for (const { offset, size } of ranges.tlasRanges) {
      this._device.queue.writeBuffer(
        this._bvhBuffer,
        offset,
        tlas.buffer,
        offset,
        size
      );
    }
    for (const { offset, size } of ranges.instanceRanges) {
      this._device.queue.writeBuffer(
        this._instancesBuffer,
        offset,
        tlas.instancesBuffer!,
        offset,
        size
      );
    }
    if (this._debugBVHBuffer) {
      new Float32Array(this._debugBVHBuffer).set(tlasData);
    }

    if (
      !incremental ||
      res.emissiveBindings.some(({ mesh }) =>
        this._dirtyTransformMeshes.has(mesh)
      )
    ) {
      this._emissiveTriangles = this._emissiveCache.collect(
        res.emissiveBindings,
        res.materials
      );
      this._needsUpdateLightSamplingData = true;
    }
    this._dirtyTransformMeshes.clear();
    this._needsRefitTLAS = false;
  }

  private _createMaterialData(...args: ConstructorParameters<typeof MaterialTable>): MaterialTable | WGPUBindlessMaterialData {
    if (this._bindless) {
      const data = new WGPUBindlessMaterialData(args[0], args[1]);
      const reason = bindlessLimitReason(this._device, data.textures.length);
      if (!reason) return data;
      this._textureSelection.fallbackReason = reason;
      const retired = this._bindless;
      this._retiredBindless.add(retired);
      void this._device.queue.onSubmittedWorkDone().catch(() => {}).then(() => {retired.dispose(); this._retiredBindless.delete(retired);});
      this._bindless = undefined;
      this._computeShaderModule = undefined; this._rayTracePipelineLayout = undefined;
    }
    return new MaterialTable(...args);
  }

  private _updateTextures(materialData: MaterialTable | WGPUBindlessMaterialData) {
    if (materialData instanceof WGPUBindlessMaterialData) {
      this._bindless!.update(materialData.textures, this._maxTextureArrayBytes);
      this._needsUpdateBindGroups = true;
      return;
    }
    // Textures
    // TODO Avoid zero length array.
    const mapInfo = materialData.bufferData.mapInfo ?? [0, 0, 0, 0];
    const mapTransform = materialData.bufferData.mapTransform ?? [1, 1, 0, 0];
    const mapUvChannel = materialData.bufferData.mapUvChannel ?? [0];
    const mapColorLinear = materialData.bufferData.mapColorLinear;
    const numMaps = +this._constants.NUM_MAPS;
    const mapInfoData = new F32(numMaps * 12);
    for (let i = 0; i < mapInfo.length; i++) {
      mapInfoData[i] = mapInfo[i];
    }
    for (let i = 0; i < mapTransform.length; i++) {
      mapInfoData[numMaps * 4 + i] = mapTransform[i];
    }
    for (let i = 0; i < mapUvChannel.length; i++) {
      mapInfoData[numMaps * 8 + i * 4] = mapUvChannel[i];
      mapInfoData[numMaps * 8 + i * 4 + 1] = mapColorLinear[i];
      mapInfoData[numMaps * 8 + i * 4 + 2] = materialData.bufferData.mapWrap[i * 2];
      mapInfoData[numMaps * 8 + i * 4 + 3] = materialData.bufferData.mapWrap[i * 2 + 1];
    }
    let mapInfoUniform = this._mapInfoUniform;
    if (!mapInfoUniform || mapInfoUniform.size !== mapInfoData.byteLength) {
      mapInfoUniform?.destroy();
      mapInfoUniform = this._uniformBuffer(mapInfoData.byteLength);
      this._mapInfoUniform = mapInfoUniform;
    }
    this._device.queue.writeBuffer(mapInfoUniform, 0, mapInfoData);
    const texture = materialData.texture;
    const maps = this._maps;
    const textureFormat = texture?.storageType === constants.HALF_FLOAT ? 'rgba16float' : 'rgba8unorm';
    const bytesPerPixel = textureFormat === 'rgba16float' ? 8 : 4;
    const textureWidth = Math.max(texture?.width ?? 1, 1);
    const textureHeight = Math.max(texture?.height ?? 1, 1);
    // TODO Must at least 2 layers.
    const textureDepth = Math.max(texture?.source!.length ?? 1, 2);
    const maxTextureArrayLayers = this._device.limits.maxTextureArrayLayers;

    if (textureDepth > maxTextureArrayLayers) {
      throw new Error(
        `The scene needs ${textureDepth} texture-array layers, but this GPU device supports ${maxTextureArrayLayers}.`
      );
    }

    if (
      !maps ||
      textureFormat !== maps.format ||
      textureWidth !== maps.width ||
      textureHeight !== maps.height ||
      textureDepth !== maps.depthOrArrayLayers
    ) {
      maps && maps.destroy();
      this._maps = this._device.createTexture({
        format: textureFormat,
        label: 'Maps',
        usage:
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_DST |
          GPUTextureUsage.RENDER_ATTACHMENT,
        size: {
          width: textureWidth,
          height: textureHeight,
          depthOrArrayLayers: textureDepth
        }
      });

      this._needsUpdateBindGroups = true;
    }
    // Upload the textures
    texture?.source!.forEach((img: TexImageSource & { width: number; height: number }, idx: number) => {
      if (isTextureDataSource(img)) {
        if (!(img.data instanceof Uint8Array) && !(img.data instanceof Uint16Array)) {
          throw new Error('Material texture atlas GPU upload requires RGBA8 or RGBA16F data.');
        }
        this._device.queue.writeTexture(
          { texture: this._maps!, origin: [0, 0, idx] },
          img.data,
          { bytesPerRow: img.width * bytesPerPixel, rowsPerImage: img.height },
          { width: img.width, height: img.height, depthOrArrayLayers: 1 }
        );
        return;
      }
      this._device.queue.copyExternalImageToTexture(
        {
          source: img as HTMLImageElement | HTMLCanvasElement | OffscreenCanvas | ImageBitmap,
          // @ts-ignore WebGPU support different flipY for each layer.
          flipY: texture.flipYArray[idx]
        },
        { texture: this._maps!, origin: [0, 0, idx] },
        [img.width, img.height]
      );
    });
  }

  setLights(lights: SceneLight[]) {
    const allAnalyticLights = lights.filter(
      (light) =>
        light.type === 'DirectionalLight' ||
        light.type === 'SphereLight' ||
        light.type === 'SpotLight' ||
        light.type === 'RectLight'
    );
    if (allAnalyticLights.length > FIXED_LIGHT_COUNT) {
      console.warn(
        `Too many lights, only the first ${FIXED_LIGHT_COUNT} lights will be used.`
      );
    }
    const analyticLights = allAnalyticLights.slice(0, FIXED_LIGHT_COUNT);
    const numAnalyticLights = analyticLights.length;

    const envImage = this._sceneEnvironment.update(lights);
    this._rtUniform.views.environmentRotation.set(environmentRotation(lights));

    this._rtUniform.views.lightsCount[0] = numAnalyticLights;

    this._setEnvMap(envImage);

    const lightTexturesChanged = this._rectLightTextures.update(analyticLights);
    this._analyticLights = analyticLights;
    if (lightTexturesChanged) this._needsUpdateMeshData = true;

    this._needsUpdateAnalyticLightsBuffer = true;
    this._needsUpdateLightSamplingData = true;
  }

  private _updateViewProjInv(camera: Camera, viewProjInv: mat4.Mat4Array) {
    mat4.invert(viewProjInv, camera.getProjectionMatrix(this._targetAspect));
    mat4.mul(viewProjInv, camera.transform, viewProjInv);
  }

  // TODO reuse the code of RayTraceNode
  setCamera(camera: Camera) {
    this._causticPerspective = camera.projection === 'perspective';
    const projection = camera.getProjectionMatrix(this._targetAspect);
    this._causticCameraScale = Math.abs(projection[0] * projection[5]) / 4;
    this._setCaustics(this._causticSettings);
    const viewProjectionInvMat = this._viewProjInv;
    this._apertureRadius = cameraApertureRadius(camera);
    this._focusDistance = camera.focusDistance;
    this._updateViewProjInv(camera, viewProjectionInvMat);
    mat4.copy(this._cameraWorld, camera.transform);
  }

  cameraChanged(camera: Camera) {
    const tmp = mat4.create();
    this._updateViewProjInv(camera, tmp);
    return (
      !numberArraysEqual(this._viewProjInv, tmp) ||
      cameraApertureRadius(camera) !== this._apertureRadius ||
      camera.focusDistance !== this._focusDistance
    );
  }

  setSize(width: number, height: number, targetAspect = width / height) {
    this._targetAspect = targetAspect;
    this._width = width;
    this._height = height;

    const arr = this._rtUniform.views.outputSize;
    arr[0] = width;
    arr[1] = height;

    const outColorBuffer = this._outColorBuffer;
    const bufferSize = width * height * 4 * 4;
    if (outColorBuffer && outColorBuffer.size === bufferSize) {
      return;
    }

    this._needsUpdateBindGroups = true;
    const previousBuffers: GPUBuffer[] = [];
    for (let target of [
      'Color',
      'Normal',
      'Albedo',
      'ShadowCatcher'
    ] as const) {
      const previous = this[`_out${target}Buffer`];
      if (previous) previousBuffers.push(previous);
      this[`_out${target}Buffer`] = this._device.createBuffer({
        label: 'Ray Trace ' + target,
        // The catcher stores its mask and its primary background contribution.
        size: target === 'ShadowCatcher' ? width * height * SHADOW_CATCHER_ACCUMULATION_BYTES : bufferSize,
        usage:
          GPUBufferUsage.STORAGE |
          GPUBufferUsage.COPY_DST |
          GPUBufferUsage.COPY_SRC
      });
    }
    this._targetOutputs.set(this._activeTarget, { buffers: [this._outColorBuffer, this._outNormalBuffer, this._outAlbedoBuffer, this._outShadowCatcherBuffer] });
    // A preview-resolution update can replace these buffers immediately after
    // an encoded ray-trace or output command was submitted. Retire every old
    // output only after the queue has completed work already submitted
    // against it.
    void this._device.queue
      .onSubmittedWorkDone()
      .catch(() => undefined)
      .then(() => previousBuffers.forEach((buffer) => buffer.destroy()));
  }

  setJitter(x: number, y: number) {
    const arr = this._rtUniform.views.jitter;
    arr[0] = x;
    arr[1] = y;

    this._device.queue.writeBuffer(
      this._uniforms.cameraUniform,
      0,
      packCameraUniform(this._viewProjInv, this._cameraWorld,
        this._apertureRadius, this._focusDistance)
    );
  }

  setSampleTiles(columns: number, rows: number, tileX: number, tileY: number) {
    const arr = this._rtUniform.views.scaleOffset;
    arr[0] = columns;
    arr[1] = rows;
    arr[2] = tileX;
    arr[3] = tileY;
  }

  setSampleCount(sampleCount: number) {
    this._rtUniform.views.sampleCount[0] = sampleCount;
  }
  setTransmissiveOutputAlphaMin(transmissiveAlphaMin: number) {
    this._rtUniform.views.transmissiveOutputAlphaMin[0] = transmissiveAlphaMin;
    const changed = this._transmissiveAlphaMin !== transmissiveAlphaMin;
    this._transmissiveAlphaMin = transmissiveAlphaMin;
    return changed;
  }

  needsDenoiseAlpha() {
    return (
      this._hasShadowCatcher ||
      (this._transmissiveAlphaMin < 1 && this._hasTransmission)
    );
  }

  hasShadowCatcher() {
    return this._hasShadowCatcher;
  }

  dispose() {
    this._disposed = true;
    this._envDistribution?.dispose();
    this._skyBaker?.dispose();
    this._bindless?.dispose();
    this._retiredBindless.forEach((textures) => textures.dispose());
    this._retiredBindless.clear();
    this._causticLight?.dispose();
    this._photonMap?.dispose();
    this._shaderCache.clear();
    this._shaderCapabilities.clear();
    const buffers = new Set<GPUBuffer | undefined>([
      ...Array.from(this._targetOutputs.values()).flatMap((target) => target.buffers),
      this._mapInfoUniform,
      this._attrBuffers,
      this._materialsBuffer,
      this._bvhBuffer,
      this._instancesBuffer,
      this._offlineAdaptiveHistory?.varianceBuffer,
      ...Object.values(this._uniforms)
    ]);
    buffers.forEach((buffer) => buffer?.destroy());
    const textures = new Set<GPUTexture | undefined>([
      this._maps,
      this._lightSamplingTexture,
      this._openPbrEnergyLut,
      this._envTex,
      this._envDistributionTex,
      this._backgroundTex,
      this._adaptiveSamplingTexture
    ]);
    textures.forEach((texture) => texture?.destroy());
    this._rayTracePipeline = undefined;
    this._rayTraceBindGroups = undefined;
  }

}

export default WGPURayTracePass;
