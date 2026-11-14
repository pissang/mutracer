import {materialEmission} from './materialEmission.js';
import {materialGraphConstants} from './materialGraph/features.js';
import {MaterialGraphState, graphShaderKey, type GraphPlan} from './materialGraph/state.js';
import {materialGraphShader} from './materialGraph/shader.js';
import {materialSurfaceAreas} from './materialGraph/usage.js';
import {GraphCompileCalibration, GraphCompileClock, graphCompilerBackend, nextGraphCompile, type GraphCompileRole as CompileRole} from './materialGraph/tierPolicy.js';
import {invalidateInstanceTransformRanges, canSkipInstanceRefit} from './instanceTransformChanges.js';
import {resolveSurfaceHit, type SurfaceHit} from './surfaceHit.js';
import {compactVertexLayout, packCompactVertices, packTriangleMaterials} from './compactVertices.js';
import {causticDiagnostics} from './causticDiagnostics.js';
import {WGPUPhotonMap, photonRadius} from './WGPUPhotonMap.js';
import {defaultPhotonMapPhotons} from './wgsl/photonMap.compute.js';
import {researchTransport, type ResearchPassState} from './researchTransport.js';
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
import {aovMask, AOV_PRIMARY_MASK, AOV_ACCUMULATED_MASK, AOV_REFLECTANCE_MASK, COMPACT_AOV_KINDS, type AovKind} from './aov.js';
import {proceduralEnvironmentPower} from './proceduralEnvironmentPower.js';
import {WGPUSkyBaker} from './WGPUSkyBaker.js';
import {
  initialSceneConstants,
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
import {normalizeBounces, MAX_PATH_EVENTS_WGPU} from './pathLimits.js';
import {updateMeshInstanceColors} from './prepareMeshBVH.js';
import {updateTLASInstanceColors,tlasInstanceSlots} from './bvhAccel.js';
import {getMaterialHashKey} from '../scene/openPbrSchema.js';
import {sameInstanceMembership} from './meshInstances.js';
import InstancedMesh from '../scene/InstancedMesh.js';
import {dirtyMeshInstanceIndices} from './prepareMeshBVH.js';
import {cameraApertureRadius} from './cameraLens.js';
import {getGeometryBvh, setGeometryBvh} from './geometryBvh.js';
import {packCameraUniform} from './cameraUniform.js';
import {SHADOW_CATCHER_ACCUMULATION_BYTES} from './wgsl/chunks/shadowCatcherAccumulation.wgsl.js';
import type {SamplingPattern} from './sampling.js';
import {MAX_ANALYTIC_LIGHTS} from './lightConstants.js';
import {
  DEPTH_SAMPLE_COUNT,
  packDepthSampleArea,
  unpackDepthSamples,
  type DepthSampleArea
} from './depthQuery.js';
import {MeshMembershipCache} from './meshMembership.js';
import {
  updatePreparedGeometries,
  canUpdateGeometries,
  geometryTopologyChanged,
} from './geometryUpdates.js';
import {SceneEnvironmentCache, RectLightTextureTracker} from './sceneLightChanges.js';
import {MaterialChangeTracker, type MaterialUpdateLevel} from './materialChanges.js';
import {WGPUEnvMapDistribution} from './WGPUEnvMapDistribution.js';
import {WGPUShaderCache, retainedShaderCapacity} from './WGPUShaderCache.js';
import {WGPUShaderCapabilities} from './WGPUShaderCapabilities.js';
import {wgpuSceneFeatureFlags, WGPU_SCENE_FEATURE_BITS} from './WGPUSceneFeatures.js';
import {
  lightShaderCapabilities,
  retainedShaderCapabilities,
  ALL_MATERIAL_SHADER_CAPABILITIES,
  type ShaderCapabilities
} from './shaderCapabilities.js';
import {mat4} from '../math.js';
import Mesh from '../scene/Mesh.js';
import DirectionalLight from '../scene/DirectionalLight.js';
import SphereLight from '../scene/SphereLight.js';
import RectLight from '../scene/RectLight.js';
import SpotLight from '../scene/SpotLight.js';
import DiskLight from '../scene/DiskLight.js';
import CylinderLight from '../scene/CylinderLight.js';
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
import {selectVisibleInstances} from './scenePreparation.js';
import {refreshMaterialKeys} from './meshMembership.js';
import {
  buildWebTLAS,
  type BLASInstance,
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
  estimateEnvironmentPower, colorLuminance
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
type AnalyticLight = DirectionalLight | SphereLight | SpotLight | RectLight | DiskLight | CylinderLight;
const F32 = Float32Array;

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

/** One compiled shader configuration. Its compilation task owns all of these fields. */
interface TraceVariant {
  graphKey: string;
  graphRevision: number;
  baseSignature: string;
  status: 'pending' | 'ready' | 'failed';
  settled: Promise<void>;
  capabilities: ShaderCapabilities;
  structureKey: string;
  diagnostics: ShaderCompilationDiagnostics;
  pipeline?: GPUComputePipeline;
  depthCompute?: GPUProgrammableStage;
  lightEmitter?: GPUComputePipeline;
  photonEmitter?: GPUComputePipeline;
  error?: unknown;
}
const MAX_TRACE_VARIANTS = 32;
// Requests are cheap but drivers are not, and a running compilation cannot be cancelled.
const MAX_CONCURRENT_COMPILES = 2;
/** Structure flags the editing variant enables. Each only adds code that per-material data
 * gates, so scenes without the feature render the same through it. */
const EDITING_STRUCTURE = {HAS_MEDIUM: true, USE_UV1: true, USE_ANISOTROPY_DIRECTIONS: true, USE_COAT_NORMAL_FRAMES: true};
const EDITING_SCENE_CAPABILITIES = WGPU_SCENE_FEATURE_BITS.HAS_COAT | WGPU_SCENE_FEATURE_BITS.HAS_FUZZ |
  WGPU_SCENE_FEATURE_BITS.HAS_THIN_FILM | WGPU_SCENE_FEATURE_BITS.HAS_SUBSURFACE;
const editingShaderCapabilities = (required: ShaderCapabilities): ShaderCapabilities => ({
  SCENE_CAPABILITIES: required.SCENE_CAPABILITIES | EDITING_SCENE_CAPABILITIES,
  MATERIAL_CAPABILITIES: required.MATERIAL_CAPABILITIES | ALL_MATERIAL_SHADER_CAPABILITIES,
  LIGHT_CAPABILITIES: required.LIGHT_CAPABILITIES
});
/** Scene stability before the lean variant replacing the editing variant compiles. */
const EDITING_SETTLE_MS = 2000;
interface TraceRequest {
  constants: Record<string, boolean | number>; hasAlpha: boolean; hasSceneAlpha: boolean; defineCode: string;
  pipelineConstantsKeys: string[]; structureKey: string; capabilities: ShaderCapabilities; baseSignature: string;
  signature: string; graphPlan: GraphPlan; fallbackSignature: string;
}
/** Background compiles (gated upgrades, the editing-interpreter prefetch) leave this many
 * slots to compiles that render an edit correctly, which never wait behind them. */
const EDIT_RESERVED_COMPILES = 1;
const MAX_QUEUED_COMPILES = 4;
// Compile speed and compile overlap are properties of the device, shared by its passes.
const deviceCompileProfiles = new WeakMap<GPUDevice, {calibration: GraphCompileCalibration; clock: GraphCompileClock}>();
function deviceCompileProfile(device: GPUDevice) {
  let profile = deviceCompileProfiles.get(device);
  if (!profile) deviceCompileProfiles.set(device, profile = {calibration: new GraphCompileCalibration(graphCompilerBackend()), clock: new GraphCompileClock()});
  return profile;
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
  private _transport?: ResearchPassState;
  private _lightTracing = false;
  private _sceneEnvironment = new SceneEnvironmentCache();
  private _rectLightTextures = new RectLightTextureTracker();
  private _analyticLights: AnalyticLight[] = [];
  private _iesProfileTexelOffsets = new Int32Array(0);
  private _graphs?: MaterialGraphState;
  /** Editing prefetch: after a variant installs, compile a variant with every lobe in the
   * background, so a later material edit that needs another lobe installs without waiting.
   * Default off. */
  shaderPrefetch: 'off' | 'editing' = 'off';
  private _editingRequest?: TraceRequest;
  private _leanRequest?: TraceRequest & {since: number};
  /** Signatures whose background compile failed. Maintenance never retries them, since
   * nothing waits for them; a render that requests one compiles it again. */
  private _failedPrefetch = new Set<string>();
  get graphs() {
    if (!this._graphs) {
      this._graphs = new MaterialGraphState(); this._graphs.interpreterAvailable = true; this._graphs.usage = () => materialSurfaceAreas(this._meshes);
      if (this._device) this._graphs.calibration = deviceCompileProfile(this._device).calibration;
    }
    return this._graphs;
  }
  private _canTraceOldGraph = false;
  private _materialChanges = new MaterialChangeTracker();
  private _pendingMaterialUpdate?: { level: MaterialUpdateLevel; emission: boolean; emissiveMap: boolean; materials: Set<OpenPBRMaterial> };
  private _materialData: MaterialTable | WGPUBindlessMaterialData | undefined;
  private _bindless?: WGPUBindlessTextures;
  private _retiredBindless = new Set<WGPUBindlessTextures>();
  private _disposed = false;
  private _maxTextureArrayBytes = DEFAULT_MAX_TEXTURE_ARRAY_BYTES;
  private _pendingGeometryUpdates = new Set<Geometry>();
  private _needsUpdateMeshData = true;
  private _appendOnly = false;
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
    visible: boolean;
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
    if (this._photonMapping && this._activeTarget !== target) this._needsPhotonTargetBindGroups = true;
    this._activeTarget = target;
    const output = this._targetOutputs.get(target);
    [this._outColorBuffer, this._outNormalBuffer, this._outAlbedoBuffer, this._outShadowCatcherBuffer] =
      output?.buffers ?? [];
    if (output?.bindGroup && output.pipeline === this._rayTracePipeline && this._rayTraceBindGroups) {
      this._rayTraceBindGroups[this._bindless ? 2 : 3] = output.bindGroup;
      this._needsUpdateOutputBindGroup = false;
    } else {
      this._needsUpdateOutputBindGroup = true;
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
  private _attributeData?: Uint32Array;
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
  private _emissiveCache = new EmissiveTriangleCache(material=>colorLuminance(this.graphs.emissionProposal(material as OpenPBRMaterial) ?? materialEmission(material)));
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

  private _rayTraceBindGroups?: GPUBindGroup[];
  private _photonEmissionGroups?: GPUBindGroup[];
  private _blasLayoutMask = 1;
  private _alphaBlendStrategy: AlphaBlendStrategy = 'stochastic';
  private _constants = initialSceneConstants();
  private _retainedShaderCapabilities?: ShaderCapabilities;
  private _retainedShaderStructure?: string;
  private _shaderCapabilities = new WGPUShaderCapabilities();
  private _targetTransport = new WeakMap<object, number>();
  private _traceVariants = new Map<string, TraceVariant>();
  private _queuedCompiles: {variant: TraceVariant; signature: string; role: CompileRole; run: () => Promise<void>; release: () => void}[] = [];
  private _activeCompiles = 0;
  private _traceModules = new Map<string, {module: GPUShaderModule; bytes: number; lines: number; fingerprint: string}>();
  private _requestedVariant?: TraceVariant;
  private _activeVariant?: TraceVariant;
  private _activeInputs?: string;
  private _awaitingRetirement?: Promise<void>;
  private _resourceError: unknown;
  private _aovPipelinesFailed = false;

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
  private _projectionInv = mat4.create();
  private _cameraWorld = mat4.create();
  private _apertureRadius = 0;
  private _focusDistance = 10;

  private _needsUpdateBindGroups = true;
  // Photon maps are per target. Switching targets only rebinds them, which
  // must not send steady frames through the asynchronous pipeline path.
  private _needsPhotonTargetBindGroups = false;
  // Target selection is not a scene-resource edit. A stale fallback must not
  // leave global bindings dirty after switching back to a prepared target.
  private _needsUpdateOutputBindGroup = false;

  private _aovPipelines = new WeakMap<GPUComputePipeline, Map<number, {
    accumulation?: GPUComputePipeline; center?: GPUComputePipeline; error?: unknown;
  }>>();
  private _depthCompute?: GPUProgrammableStage;
  private _depthTracePipeline?: GPUComputePipeline;
  private _depthPipeline?: Promise<GPUComputePipeline>;
  private _shaderCache: WGPUShaderCache;
  private _bvhCPU?: {tlas: FlattendBVH; blases: BLASInstance[]};
  private _bvhDataBytes = 0;
  /** Byte offset of the BLASes in the BVH buffer; the TLAS region before it has headroom. */
  private _blasBase = 0;
  private _uploadedBlases: ArrayBuffer[] = [];
  /** Bytes reserved after `_blasBase` for append-only BLAS growth. */
  private _blasCapacity = 0;

  // Fold scene invariants before backend inlining; runtime edits use uniforms.
  private _bakePipelineConstants = true;



  constructor(device: GPUDevice, private _textureSelection: MaterialTextureSelection = {requested: 'atlas'}) {
    this._device = device;
    this._shaderCache = new WGPUShaderCache(device);
    if (_textureSelection.support) this._bindless = new WGPUBindlessTextures(device);

    this._uniforms = {
      cameraUniform: this._uniformBuffer(52 * 4),
      rtUniform: this._uniformBuffer(this._rtUniform.buffer.byteLength),
      analyticLights: this._storageBuffer(PIXELS_PER_LIGHT * 4 * 4)
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
    // Another render may have traced since this target's samples were written.
    const transport = this._targetTransport.get(this._activeTarget) ?? 0;
    return {
      color: this._outColorBuffer,
      ...(transport & 2 || ((this._transport?.debugGroup ?? -1) >= 0 || causticDiagnostics.debugGroup >= 0) ? {wideHdr: true} : {}),
      ...(transport & 1 && this._causticLight?.get(this._activeTarget)
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

  private _createPipelineLayout(bindless: boolean, photonMapping: boolean) {
    const descriptor = {
      label: 'Ray Trace Pipeline Layout',
      bindGroupLayouts: (bindless ? bindlessBindGroupLayouts() : rayTraceBindGroupLayouts()).map(
        (layout, index) => {
          if (index === (bindless ? 1 : 2)) layout = {
            ...layout,
            entries: Array.from(layout.entries, entry => entry.binding === 2
              ? {...entry, buffer: {type: 'read-only-storage' as const}}
              : entry)
          };
          if (photonMapping && index === (bindless ? 0 : 1))
            layout = {
              ...layout,
              entries: [
                ...layout.entries,
                ...[11, 12].map((binding) => ({
                  binding: binding + (bindless ? 4 : 0),
                  visibility: GPUShaderStage.COMPUTE,
                  texture: {sampleType: 'uint' as const}
                }))
              ]
            };
          return this._shaderCache.createBindGroupLayout(layout);
        }
      )
    };
    return this._shaderCache.createPipelineLayout(
      bindless ? resourceTableLayout(descriptor) : descriptor
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
    const limit = Math.min(device.limits?.maxBufferSize ?? Infinity, device.limits?.maxStorageBufferBindingSize ?? Infinity);
    if (size > limit) throw new RangeError(`${label} buffer requires ${size} bytes; device storage buffer limit is ${limit} bytes.`);

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
          GPUBufferUsage.COPY_SRC,
        // Chromium's mapped-creation IPC payload is limited to a signed 32-bit
        // size even when the adapter supports larger storage buffers.
        mappedAtCreation: size < 0x80000000
      });
      if (size < 0x80000000) {
        new Uint8Array(gpuBuffer.getMappedRange()).set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
        gpuBuffer.unmap();
        return gpuBuffer;
      }
    }
    // Bound each staging allocation/IPC payload for large or reused buffers.
    const chunkBytes = 64 * 1024 * 1024;
    for (let offset = 0; offset < data.byteLength; offset += chunkBytes) {
      this._device.queue.writeBuffer(gpuBuffer, offset, data.buffer, data.byteOffset + offset, Math.min(chunkBytes, data.byteLength - offset));
    }
    return gpuBuffer;
  }

  private _uniformBuffer(size: number) {
    this._needsUpdateBindGroups = true;
    return this._device.createBuffer({
      size,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
  }

  private _storageBuffer(size: number) {
    this._needsUpdateBindGroups = true;
    return this._device.createBuffer({size: Math.max(16, size), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST});
  }

  private _preparePhotonTarget() {
    if (!this._photonMapping) return;
    this._photonMap ??= new WGPUPhotonMap(this._device);
    const before = this._photonMap.get(this._activeTarget)?.data;
    const requested = this._causticSettings?.photonMapping;
    const n = typeof requested === 'object' ? requested.photonsPerSample : undefined;
    const after = this._photonMap.ensure(
      this._activeTarget,
      Number.isFinite(n) && n! > 0 ? n! : defaultPhotonMapPhotons(this._width, this._height, causticDiagnostics.photonCountDivisor)
    );
    if (before !== after.data) this._needsUpdateBindGroups = true;
  }

  /**
   * Prepares the pipeline for the settings currently written to this pass.
   * Everything except compilation runs synchronously, and compilation only
   * writes to its own variant. Renders with different settings can therefore
   * interleave without invalidating each other. Returns a promise while the
   * requested state waits on the GPU; undefined means nothing is outstanding.
   */
  updatePipeline(): Promise<void> | undefined {
    if (this._disposed) return;
    if (this._needsUpdateMeshData || this._needsUpdateMeshMembership || this._pendingGeometryUpdates.size ||
      this._needsRefitTLAS || this._dirtyColorMeshes.size || this._pendingMaterialUpdate || this._needsUpdateLightSamplingData) {
      // A failure can have the same shader signature as its repaired scene.
      // Retry after authored updates, while keeping an unchanged failure idle.
      this._resourceError = undefined;
      for (const [signature, variant] of this._traceVariants) if (variant.status === 'failed') this._traceVariants.delete(signature);
      if (this._aovPipelinesFailed) { this._aovPipelines = new WeakMap(); this._aovPipelinesFailed = false; }
    }
    this._awaitingRetirement = this._bindless?.retirement;
    if (this._awaitingRetirement) return this._awaitingRetirement;
    if (this._resourceError) return;
    try {
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
      if (this._lightTracing || this._photonMapping) this._causticBounds = causticCasterSphere(this._visibleMeshes());
      this._targetTransport.set(this._activeTarget, (+this._lightTracing) | (+this._photonMapping << 1));
      this._preparePhotonTarget();
      // The tier policy may start a gated upgrade or switch tiers while verifying one.
      this.graphs.tick(this._activeCompiles + this._queuedCompiles.length);
      const graphPlan = this.graphs.candidate(!!this._rayTracePipeline);
      const graphConstants = materialGraphConstants(this._constants, graphPlan, this._preparedMeshData?.geometry);
      const pipelineInputs = JSON.stringify([
        graphPlan.key,
        graphShaderKey(graphPlan),
        graphConstants,
        Boolean(this._constants.SPECTRAL) && this._shareSpectralPrefix,
        this._hasDisplacement,
        this._alphaBlendStrategy,
        this._blasLayoutMask,
        this._bakePipelineConstants,
        this._causticKey,
        !!this._bindless
      ]);
      // Steady rendering must not repeat capability retention and pipeline-key
      // preparation. Dirty resources still take the normal bind-group path.
      if (
        pipelineInputs === this._activeInputs &&
        this._rayTracePipeline &&
        this._rayTraceBindGroups &&
        !this._needsUpdateBindGroups
      ) {
        if (this._needsPhotonTargetBindGroups || this._needsUpdateOutputBindGroup) {
          this._needsPhotonTargetBindGroups = false;
          this._needsUpdateOutputBindGroup = false;
          this._updateBindGroups();
        }
        this._requestedVariant = this._activeVariant;
        this._maintainShaderPrefetch();
        return;
      }
      this._rtUniform.views.sceneFeatureFlags[0] = wgpuSceneFeatureFlags(graphConstants);
      const fallbackSignature = JSON.stringify([this._constants, this._hasDisplacement, this._alphaBlendStrategy, this._blasLayoutMask, this._causticKey, !!this._bindless]);
      // A variant request: lean (what the scene needs) or, with editing prefetch, the
      // editing variant that also enables every lobe and code-adding structure flag.
      const request = (editing: boolean, plan = graphPlan) => {
        const planConstants = plan === graphPlan ? graphConstants : materialGraphConstants(this._constants, plan, this._preparedMeshData?.geometry);
        const source = editing ? {...planConstants, ...EDITING_STRUCTURE} : planConstants;
        const requiredCapabilities = retainedShaderCapabilities(source);
        const constants: Record<string, boolean | number> = {...source, ...requiredCapabilities};
        const hasAlpha =
          Boolean(constants.HAS_ALPHA_BLEND) && this._alphaBlendStrategy === 'deterministic-source-over';
        const hasSceneAlpha = Boolean(constants.HAS_ALPHA);
        const pipelineConstantsKeys = wgpuPipelineConstantKeys(constants);
        const defineCode = WGPU_SHADER_DEFINE_KEYS.map((key) => `const ${key} = ${constants[key]};`).join('\n');
        const structure = {
          shareSpectralPrefix: Boolean(constants.SPECTRAL) && this._shareSpectralPrefix,
          hasDisplacement: this._hasDisplacement,
          caustics: this._causticKey,
          bindless: !!this._bindless,
          hasAlpha,
          hasSceneAlpha,
          hasAnisotropyDirections: Boolean(constants.USE_ANISOTROPY_DIRECTIONS),
          hasCoatNormals: Boolean(constants.USE_COAT_NORMAL_FRAMES),
          blasLayoutMask: this._blasLayoutMask,
          bakePipelineConstants: this._bakePipelineConstants
        };
        const structureKey = JSON.stringify({
          graph: graphShaderKey(plan),
          ...structure,
          defineCode,
          constants: pipelineConstantsKeys
            .filter((key) => !(key in requiredCapabilities))
            .map((key) => [key, constants[key]])
        });
        // Prefer an existing compatible pipeline, including an earlier lean
        // variant. Only grow the current variant when it cannot cover an edit;
        // do not carry unused capabilities across different transport/layouts.
        const capabilities = editing ? editingShaderCapabilities(requiredCapabilities) :
          this._shaderCapabilities.find(structureKey, requiredCapabilities) ??
          retainedShaderCapabilities(
            graphConstants,
            structureKey === this._retainedShaderStructure ? this._retainedShaderCapabilities : undefined
          );
        Object.assign(constants, capabilities);
        // Runtime feature values live in uniforms, so edits can share a pipeline
        // as long as its compiled defines and overrides are the same.
        const baseSignature = JSON.stringify({
          ...structure,
          defineCode,
          constants: pipelineConstantsKeys.map((key) => [key, constants[key]])
        });
        // Interpreted structures share one shader key, so a structure-set change
        // reuses the installed variant and only uploads programs.
        const signature = graphShaderKey(plan) ? baseSignature + '\n' + graphShaderKey(plan) : baseSignature;
        return {constants, hasAlpha, hasSceneAlpha, defineCode, pipelineConstantsKeys, structureKey, capabilities, baseSignature, signature};
      };
      const lean = request(false);
      let chosen = lean;
      if (this.shaderPrefetch === 'editing') {
        // An edit that needs a variant not compiled yet uses the prefetched editing
        // variant at once; the lean variant compiles after the scene settles.
        // With material graphs the editing variant carries the graph editing interpreter,
        // so one background compile covers lobe and graph structure edits.
        const editingPlan = this.graphs.editingPlan() ?? graphPlan;
        const editing = request(true, editingPlan);
        this._editingRequest = editing.signature === lean.signature ? undefined : {...editing, graphPlan: editingPlan, fallbackSignature};
        // A lean variant is owed only while the editing variant serves this request.
        this._leanRequest = undefined;
        // It can serve only the graph shader the graph state installs.
        if (this._editingRequest && graphShaderKey(editingPlan) === graphShaderKey(graphPlan) &&
          this._traceVariants.get(lean.signature)?.status !== 'ready' && this._traceVariants.get(editing.signature)?.status === 'ready') {
          chosen = editing;
          this._leanRequest = {...lean, graphPlan, fallbackSignature, since: performance.now()};
        }
      }
      const {constants, hasAlpha, hasSceneAlpha, defineCode, pipelineConstantsKeys, structureKey, capabilities, baseSignature, signature} = chosen;
      const previousVariant = this._traceVariants.get(signature);
      if(previousVariant?.status === 'failed' && previousVariant.graphKey && previousVariant.graphRevision < this.graphs.revision) this._traceVariants.delete(signature);
      const variant = this._traceVariants.get(signature) ??
        this._startTraceVariant(signature, constants, {hasAlpha, hasSceneAlpha, defineCode, pipelineConstantsKeys, structureKey, capabilities, graphPlan, baseSignature:fallbackSignature}, this.graphs.compileRole(graphPlan));
      this._requestedVariant = variant;
      this._canTraceOldGraph = !!this._activeVariant && this._activeVariant.baseSignature === fallbackSignature && this._activeVariant.graphKey !== variant.graphKey;
      // A gated upgrade or a structure edit that needs a new variant compiles while
      // the installed variant keeps tracing (constants until a graph variant is ready).
      if (variant.status === 'pending') {
        this._requestQueuedCompile(variant, this.graphs.compileRole(graphPlan));
        if (this._canTraceOldGraph) {
          if(this._needsUpdateBindGroups) { this._updateBindGroups(); this._needsUpdateBindGroups = false; }
          return;
        }
        return variant.settled;
      }
      if (variant.status === 'failed') {
        if (this.graphs.abandonUpgrade(variant.graphKey)) { console.warn('Specialized material graph variant failed; keeping the installed variant.', variant.error); return; }
        if (graphPlan.key) this.graphs.fail(this.graphs.revision,variant.error);
        return;
      }
      this._installTraceVariant(variant, pipelineInputs);
      // Background compile of the editing interpreter (see MaterialGraphState.prefetch).
      const prefetch = this.graphs.prefetch(this._activeCompiles + this._queuedCompiles.length);
      if (prefetch && JSON.stringify(materialGraphConstants(this._constants, prefetch, this._preparedMeshData?.geometry)) === JSON.stringify(graphConstants)) {
        if (this.shaderPrefetch === 'editing') {
          // The editing variant compiles it, with every lobe (see _maintainShaderPrefetch).
          const editing = request(true, prefetch);
          this._editingRequest = {...editing, graphPlan: prefetch, fallbackSignature};
        } else {
          const prefetchSignature = baseSignature + '\n' + graphShaderKey(prefetch);
          if (!this._traceVariants.has(prefetchSignature))
            this._startTraceVariant(prefetchSignature, constants, {hasAlpha, hasSceneAlpha, defineCode, pipelineConstantsKeys, capabilities, graphPlan: prefetch, baseSignature: fallbackSignature,
              structureKey: JSON.stringify({...JSON.parse(structureKey), graph: graphShaderKey(prefetch)})}, 'prefetch');
        }
      }
      this._maintainShaderPrefetch();
    } catch (error) {
      this._resourceError = error;
      this._needsUpdateBindGroups = true;
      console.error('Failed to update WebGPU ray tracing resources.', error);
    }
  }

  /** Editing prefetch upkeep, one background compile at a time: the lean variant once the
   * scene has been stable for EDITING_SETTLE_MS (installed at the next update), otherwise
   * the editing variant of the current scene. */
  private _maintainShaderPrefetch() {
    if (this.shaderPrefetch !== 'editing' || !this._activeVariant) return;
    const idle = this._activeCompiles + this._queuedCompiles.length === 0;
    const start = (r: TraceRequest) => this._startTraceVariant(r.signature, r.constants, {hasAlpha: r.hasAlpha, hasSceneAlpha: r.hasSceneAlpha,
      defineCode: r.defineCode, pipelineConstantsKeys: r.pipelineConstantsKeys, structureKey: r.structureKey, capabilities: r.capabilities,
      graphPlan: r.graphPlan, baseSignature: r.fallbackSignature}, 'prefetch');
    const lean = this._leanRequest;
    if (lean) {
      const variant = this._traceVariants.get(lean.signature);
      if (variant?.status === 'ready') { this._leanRequest = undefined; this._activeInputs = undefined; }
      else if (variant?.status === 'failed' || this._failedPrefetch.has(lean.signature)) this._leanRequest = undefined;
      else if (!variant && idle && performance.now() - lean.since >= EDITING_SETTLE_MS) start(lean);
      return;
    }
    const editing = this._editingRequest;
    if (editing && idle && !this._traceVariants.has(editing.signature) && !this._failedPrefetch.has(editing.signature)) start(editing);
  }

  /** Runs only for a ready variant, without yielding, so tracing can start in this call. */
  private _installTraceVariant(variant: TraceVariant, pipelineInputs: string) {
    if (this.graphs.installShader(variant.graphKey)) {
      this.graphs.compilation={sourceBytes:variant.diagnostics.sourceBytes,sourceGenerationTimeMs:variant.diagnostics.sourceGenerationTimeMs,moduleCreationTimeMs:variant.diagnostics.moduleCreationTimeMs,totalTimeMs:variant.diagnostics.totalTimeMs};
      this._emissiveTriangles=this._collectEmissiveTriangles();
      this._updateLightSamplingData();
      this._materialsBuffer = this._updateGPUBuffer('Materials',this._materialsBuffer,this._materialData!.getBufferArray(),MATERIAL_FLOAT_COUNT * 4);
      this._needsUpdateBindGroups = true;
    }
    this._canTraceOldGraph = false;
    if (this._activeVariant !== variant) {
      this._activeVariant = variant;
      this._rayTracePipeline = variant.pipeline;
      this._depthCompute = variant.depthCompute;
      this._needsUpdateBindGroups = true;
    }
    const emission = () => causticEmissionTable(
      this._analyticLights,
      this._emissiveTriangles,
      this._causticBounds[3],
      this._envImageSource && 'sky' in this._envImageSource
        ? proceduralEnvironmentPower(this._envImageSource)
        : estimateEnvironmentPower(this._envImageSource)
    );
    const casters = () => causticDiagnostics.aggregateCasters ? [this._causticBounds] : causticCasterSpheres(this._visibleMeshes());
    if (this._lightTracing && this._causticLight) {
      this._causticLight.setDistribution(casters(), emission());
      this._causticLight.use(variant.lightEmitter!);
    }
    if (this._photonMapping && this._photonMap) {
      this._photonMap.emission.setDistribution(casters(), emission());
      this._photonMap.emission.use(variant.photonEmitter!);
    }
    // TODO rebind when lights, materials, bvh changed.
    if (this._needsUpdateBindGroups || this._needsPhotonTargetBindGroups || this._needsUpdateOutputBindGroup) {
      this._needsUpdateBindGroups = false;
      this._needsPhotonTargetBindGroups = false;
      this._needsUpdateOutputBindGroup = false;
      this._updateBindGroups();
    }
    this._retainedShaderCapabilities = variant.capabilities;
    this._retainedShaderStructure = variant.structureKey;
    this._shaderCapabilities.remember(variant.structureKey, variant.capabilities);
    this._activeInputs = pipelineInputs;
  }

  /** Snapshots everything compilation needs. The task must not read mutable pass state afterwards. */
  private _startTraceVariant(signature: string, constants: Record<string, boolean | number>, shader: {
    hasAlpha: boolean; hasSceneAlpha: boolean; defineCode: string; pipelineConstantsKeys: string[];
    structureKey: string; capabilities: ShaderCapabilities; graphPlan: GraphPlan; baseSignature: string;
  }, role: CompileRole = 'edit') {
    const shareSpectralPrefix = Boolean(constants.SPECTRAL) && this._shareSpectralPrefix;
    const bake = this._bakePipelineConstants, bindless = this._bindless;
    const hasDisplacement = this._hasDisplacement, blasLayoutMask = this._blasLayoutMask;
    const lightTracing = this._lightTracing, photonMapping = this._photonMapping;
    const causticKey = this._causticKey, transport = this._transport;
    const {hasAlpha, hasSceneAlpha, defineCode, pipelineConstantsKeys} = shader;
    const emitterSource = (mode: 'lightTracing' | 'photonMapping') => {
      let code = causticLightCompute(constants, blasLayoutMask, hasDisplacement, mode, '',
        causticDiagnostics.fullEmissionRandom !== false, true, true, false, true,
        {materialXNormals: !!constants.USE_MATERIALX_NORMAL_MAPS}, true);
      return bindless ? bindlessShaderSource(code, this._textureSelection.support!.enable) : code;
    };
    const lightEmitter = lightTracing ? this._causticLight ??= new WGPUCausticLightPass(this._device) : undefined;
    const photonEmitter = photonMapping ? this._photonMap?.emission : undefined;
    const pipelineDiagnostic: ShaderCompilationDiagnostics['pipelines'][number] = {
      label: 'Ray Trace', entryPoint: 'main', firstFrameRequired: true, status: 'compiling',
      startedAtMs: 0, concurrentCompilationCount: 1
    };
    const variant: TraceVariant = {
      graphKey: graphShaderKey(shader.graphPlan), graphRevision: this.graphs.revision, baseSignature: shader.baseSignature,
      status: 'pending', capabilities: shader.capabilities, structureKey: shader.structureKey,
      settled: undefined!,
      diagnostics: {
        status: 'compiling', sourceBytes: 0, sourceLines: 0, pipelineCount: 1,
        completedPipelineCount: 0, sourceGenerationTimeMs: 0, moduleCreationTimeMs: 0,
        modules: [], pipelines: [{...pipelineDiagnostic}], maximumConcurrentPipelineCount: 1, peakConcurrentPipelineCount: 1
      }
    };
    const device = this._device, groupIndices = bindless ? [0, 1] : [0, 1, 2];
    let startedAt = 0;
    const compile = async () => {
      startedAt = shaderCompilationNow();
      // Override values are not part of the WGSL unless they are baked, so a
      // quality edit can share the module that the driver has already parsed.
      const moduleKey = JSON.stringify([graphShaderKey(shader.graphPlan), causticKey, !!bindless, shareSpectralPrefix, Boolean(constants.SPECTRAL), hasAlpha, hasSceneAlpha, hasDisplacement,
        constants.USE_ANISOTROPY_DIRECTIONS, constants.USE_COAT_NORMAL_FRAMES, blasLayoutMask, defineCode, pipelineConstantsKeys,
        bake && pipelineConstantsKeys.map((key) => constants[key])]);
      let source = this._traceModules.get(moduleKey);
      if (!source) {
        let code = wgpuShaderSource(
          constants,
          {
            materialHooks: {
              ...materialGraphShader(lightTracing || photonMapping ? {...shader.graphPlan, key: ''} : shader.graphPlan,
                !!constants.USE_ANISOTROPY_DIRECTIONS || !!constants.USE_COAT_NORMAL_FRAMES),
              materialXNormals: !!constants.USE_MATERIALX_NORMAL_MAPS
            },
            maxPathEvents: MAX_PATH_EVENTS_WGPU,
            emissiveInstanceIndices: true,
            hasDisplacement,
            channelIndependentRis: Boolean(constants.SPECTRAL),
            shareSpectralPrefix,
            hasAlpha,
            hasSceneAlpha,
            ...transport?.features,
            lightTracing,
            photonMapping,
            photonMaxDepth: causticDiagnostics.photonMaxDepth ?? 20,
            photonDirectSubset: causticDiagnostics.photonDirectSubset,
            debugGroup: causticDiagnostics.debugGroup,
            workgroupSize: transport?.workgroupSize ?? WORKGROUP_SIZE,
            hasAnisotropyDirections: Boolean(constants.USE_ANISOTROPY_DIRECTIONS),
            hasCoatNormals: Boolean(constants.USE_COAT_NORMAL_FRAMES),
            blasLayoutMask,
            cameraProjectionInverse: true,
            perInstanceBounds: true,
            compactVertices: true,
            dynamicEnvironment: true,
            displayAovStorage: true
            ,analyticLightStorage: true
          },
          bake
        );
        if (bindless) code = bindlessShaderSource(code, this._textureSelection.support!.enable);
        variant.diagnostics.sourceGenerationTimeMs = shaderCompilationNow() - startedAt;
        const moduleStartedAt = shaderCompilationNow();
        source = {
          module: this._shaderCache.createShaderModule({label: 'Ray Trace', code}),
          bytes: code.length, lines: shaderSourceLineCount(code), fingerprint: shaderSourceFingerprint(code)
        };
        variant.diagnostics.moduleCreationTimeMs = shaderCompilationNow() - moduleStartedAt;
        this._traceModules.set(moduleKey, source);
        if (this._traceModules.size > 8) this._traceModules.delete(this._traceModules.keys().next().value!);
      }
      Object.assign(variant.diagnostics, {
        sourceBytes: source.bytes, sourceLines: source.lines,
        modules: [{label: 'Ray Trace', sourceBytes: source.bytes, sourceLines: source.lines, sourceFingerprint: source.fingerprint}]
      });
      const {module} = source;
      const layout = this._createPipelineLayout(!!bindless, photonMapping);
      const pipelineConstants = !bake
        ? pipelineConstantsKeys.reduce(
            (obj, key) => {
              obj[key] = +constants[key];
              return obj;
            },
            {} as Record<string, number>
          )
        : undefined;
      const lightSource = lightEmitter && emitterSource('lightTracing');
      const photonSource = photonEmitter && emitterSource('photonMapping');
      // Scopes capture all device errors while open, so one must never span an
      // await: frames presented meanwhile would be blamed on this pipeline.
      device.pushErrorScope('validation');
      const {clock} = deviceCompileProfile(device), timing = clock.start(shaderCompilationNow());
      const request = this._shaderCache.createComputePipelineAsync({
        label: 'Ray Trace', layout,
        compute: {module, entryPoint: 'main', constants: pipelineConstants}
      });
      const scope = device.popErrorScope().catch(() => null);
      let pipeline: GPUComputePipeline;
      try {
        pipeline = await request;
        // Calibrates this device's compile speed (cache hits and queueing are detected there).
        const {ms, overlapMs} = clock.end(timing, shaderCompilationNow());
        this.graphs.observeCompile(lightTracing || photonMapping ? {...shader.graphPlan, key: ''} : shader.graphPlan, source.bytes, ms, overlapMs);
        const scopedError = await scope;
        if (scopedError) throw scopedError;
      } catch (error) {
        clock.end(timing, shaderCompilationNow());
        const scopedError = await scope;
        // Pipeline creation already reports WGSL failures. Pull the much
        // heavier module diagnostics only on that failure path so normal
        // startup does not schedule a second full-module inspection.
        const info = await module.getCompilationInfo().catch(() => undefined);
        const shaderErrors = (info?.messages ?? []).filter((message) => message.type === 'error');
        if (shaderErrors.length) {
          throw new Error(
            shaderErrors
              .map((message) => `Ray Trace WGSL ${message.lineNum}:${message.linePos} ${message.message}`)
              .join('\n')
          );
        }
        if (isWebGPUPipelineSpecializationFailure(error, scopedError)) throw error;
        throw new Error(joinWebGPUErrors(error, scopedError));
      }
      const groups = lightEmitter || photonEmitter ? groupIndices.map((i) => pipeline.getBindGroupLayout(i)) : [];
      const [light, photon] = await Promise.all([
        lightEmitter?.prepare(lightSource!, groups, !!bindless),
        photonEmitter?.prepare(photonSource!, groups, !!bindless)
      ]);
      Object.assign(variant, {pipeline, lightEmitter: light, photonEmitter: photon,
        depthCompute: {module, constants: pipelineConstants}});
    };
    const finishDiagnostics = (status: 'ready' | 'failed', error?: string) => {
      const totalTimeMs = shaderCompilationNow() - startedAt;
      Object.assign(variant.diagnostics, {
        status, completedPipelineCount: status === 'ready' ? 1 : 0, error,
        pipelines: [{...pipelineDiagnostic, status, error, endedAtMs: totalTimeMs, durationMs: totalTimeMs}],
        pipelineCompilationTimeMs: totalTimeMs, totalTimeMs
      });
    };
    const run = () => compile().then(
      () => {
        variant.status = 'ready';
        this.graphs.compiled(variant.graphKey);
        finishDiagnostics('ready');
      },
      (error) => {
        finishDiagnostics('failed', getWebGPUErrorMessage(error));
        if (this._disposed) return;
        if (role === 'prefetch') this._failedPrefetch.add(signature);
        if (!bake && isWebGPUPipelineSpecializationFailure(error)) {
          // WebKit can accept a large WGSL module but fail while translating
          // its specialization-constant variant to Metal. Baking the values
          // into WGSL lets its front end eliminate disabled feature branches
          // before creating the Metal library. The next request has a new
          // signature, so this one stays pending until it is replaced.
          this._bakePipelineConstants = true;
          this._traceVariants.delete(signature);
          console.warn('WebGPU pipeline specialization failed; retrying with constants baked into WGSL.');
          return;
        }
        // Nobody needs an obsolete result, and a later request should try again.
        if (this._requestedVariant !== variant) {
          this._traceVariants.delete(signature);
          variant.status = 'failed';
          return;
        }
        variant.status = 'failed';
        variant.error = error;
        console.error('Failed to update WebGPU ray tracing pipeline.', error);
      }
    );
    variant.settled = new Promise((resolve) => {
      this._queuedCompiles.push({variant, signature, role, run, release: resolve});
    });
    this._traceVariants.set(signature, variant);
    if (this._queuedCompiles.length > MAX_QUEUED_COMPILES) {
      // A dropped variant stays pending, because a render that still wants it
      // replaces it with a new request on its next frame. Background work goes first.
      const background = this._queuedCompiles.findIndex((job) => job.role !== 'edit');
      const obsolete = this._queuedCompiles.splice(background >= 0 ? background : 0, 1)[0];
      if (this._traceVariants.get(obsolete.signature) === obsolete.variant) this._traceVariants.delete(obsolete.signature);
      obsolete.release();
    }
    for (const [key, retained] of this._traceVariants) {
      if (this._traceVariants.size <= MAX_TRACE_VARIANTS) break;
      if (retained.status !== 'pending' && retained !== this._activeVariant) this._traceVariants.delete(key);
    }
    this._pumpCompiles();
    return variant;
  }

  /** Starts queued compiles in the order of `nextGraphCompile`. */
  private _pumpCompiles() {
    for (let index; (index = nextGraphCompile(this._queuedCompiles, this._activeCompiles, MAX_CONCURRENT_COMPILES, EDIT_RESERVED_COMPILES)) >= 0;) {
      const job = this._queuedCompiles.splice(index, 1)[0];
      this._activeCompiles++;
      void job.run().finally(() => {
        this._activeCompiles--;
        job.release();
        if (!this._disposed) this._pumpCompiles();
      });
    }
  }

  /** Moves a queued variant to the front of its class; a background variant an edit now needs becomes an edit. */
  private _requestQueuedCompile(variant: TraceVariant, role: CompileRole) {
    const index = this._queuedCompiles.findIndex((job) => job.variant === variant);
    if (index < 0) return;
    const [job] = this._queuedCompiles.splice(index, 1);
    if (role === 'edit') job.role = 'edit';
    this._queuedCompiles.push(job);
    this._pumpCompiles();
  }

  private _prepareAovPipelines(kinds: readonly AovKind[], compact = false) {
    const trace = this._rayTracePipeline;
    if (!trace || !this._depthCompute) return;
    const reflectance = (aovMask(kinds) & AOV_REFLECTANCE_MASK) !== 0;
    let variants = this._aovPipelines.get(trace);
    if (!variants) { variants = new Map(); this._aovPipelines.set(trace, variants); }
    const primary = (aovMask(kinds) & AOV_PRIMARY_MASK) !== 0;
    const key = Number(reflectance) + Number(compact)*2 + Number(primary)*4;
    let pipelines = variants.get(key);
    if (!pipelines) {
      pipelines = {};
      variants.set(key, pipelines);
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
      const compute = {...this._depthCompute, constants: {...this._depthCompute.constants, DEPTH_QUERY_MODE: 1, AOV_REFLECTANCE: reflectance ? 1 : 0, AOV_COMPACT: compact ? 1 : 0, AOV_PRIMARY: primary ? 1 : 0}};
      // Keep the UI responsive during first use, and reuse both variants across
      // preview/final target changes rather than recreating synchronous pipelines.
      void Promise.all([
        this._shaderCache.createComputePipelineAsync({label: 'AOV accumulation', layout, compute: {...compute, entryPoint: 'aovTrace'}}),
        this._shaderCache.createComputePipelineAsync({label: 'AOV center', layout, compute: {...compute, entryPoint: 'aovTraceCenter'}})
      ]).then(([accumulation, center]) => { pending.accumulation = accumulation; pending.center = center; },
        error => { pending.error = error; this._aovPipelinesFailed = true; });
    }
    if (pipelines.error) throw pipelines.error;
    return pipelines;
  }

  prepareAovs(kinds: readonly AovKind[], compact = false) {
    const pipelines = this._prepareAovPipelines(kinds, compact);
    return !!pipelines?.accumulation && !!pipelines.center;
  }

  renderAovs(state: WGPUAov, camera: Camera, samples: number, cap: number, kinds: readonly AovKind[], resolution?: {width: number; height: number}) {
    const groups = this._rayTraceBindGroups;
    if (!groups || !this._tlas || !this._preparedMeshData || !kinds.length) return false;
    const compact = !!resolution && kinds.every(kind => COMPACT_AOV_KINDS.includes(kind));
    const pipelines = this._prepareAovPipelines(kinds, compact);
    if (!pipelines?.accumulation || !pipelines.center) return false;
    state.resize(resolution?.width ?? this._width, resolution?.height ?? this._height, compact, (aovMask(kinds) & AOV_PRIMARY_MASK) !== 0);
    const textures = this._bindless, groupIndex = textures ? 2 : 3;
    const target = Math.min(samples, cap);
    if (state.centerReady && state.samples >= target) return true;
    if (!state.frame) {
      // Only the center pass reads primitive IDs and compact display AOVs skip
      // it; building the map walks every BVH leaf on the main thread.
      const primitiveIds = compact ? undefined : this._aovPrimitiveCache.get(this._preparedMeshData, this._tlas, this._blasBase / 16);
      const packed = packAovScene(this._preparedMeshData, this._tlas, camera, state.width, state.height, state.history, primitiveIds, false);
      state.frame = packed.frame; state.setScene(packed.words, primitiveIds);
    }
    this._device.queue.writeBuffer(this._uniforms.rtUniform, 0, this._rtUniform.buffer);
    this._device.queue.writeBuffer(this._uniforms.cameraUniform, 0, packCameraUniform(this._viewProjInv, this._cameraWorld, this._apertureRadius, this._focusDistance, this._projectionInv));
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
    if (!state.centerReady) { if (!compact) run(pipelines.center, 0); state.centerReady = true; state.history.accept(state.frame); }
    if ((aovMask(kinds) & AOV_ACCUMULATED_MASK) === 0) state.samples = target;
    while (state.samples < target) { run(pipelines.accumulation, state.samples); state.samples++; }
    return true;
  }

  async pickSurface(x: number, y: number, aspect?: number): Promise<SurfaceHit | null | undefined> {
    const source = this._preparedMeshData, tlas = this._tlas;
    if (!source || !tlas) return;
    const values = await this._readDepthSamples({x, y, size: 0}, aspect, true);
    if (!values || source !== this._preparedMeshData || tlas !== this._tlas) return;
    return resolveSurfaceHit(source, tlas, values);
  }

  readDepthSamples(area: DepthSampleArea, aspect?: number) {
    return this._readDepthSamples(area, aspect);
  }

  private async _readDepthSamples(area: DepthSampleArea, aspect?: number, picking = false): Promise<Float32Array | undefined> {
    const tracePipeline = this._rayTracePipeline;
    const groups = this._rayTraceBindGroups;
    const textures = this._bindless, textureRevision = textures?.revision;
    if (!tracePipeline || !groups || !this._depthCompute || this.isCompilingShader()) return;
    const packed = packDepthSampleArea(area, aspect ?? this._width / this._height);
    if (picking) packed.set([-1, -1], 2);
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
      const rgba = new Float32Array(readback.getMappedRange());
      return picking ? rgba.slice(0, 4) : unpackDepthSamples(rgba);
    } finally {
      if (readback.mapState === 'mapped') readback.unmap();
      readback.destroy(); output.destroy(); params.destroy();
    }
  }

  /** Whether the latest request waits on GPU work that will settle on its own. */
  isCompilingShader() {
    return !!this._awaitingRetirement || (!this._canTraceOldGraph && this._requestedVariant?.status === 'pending');
  }

  isPipelineReady() {
    return (
      (!!this._rayTracePipeline) &&
      !!this._rayTraceBindGroups
    );
  }

  /** Failure of the latest request. A failed variant does not affect other renders. */
  getPipelineError() {
    return this._resourceError ?? (this._canTraceOldGraph ? undefined : this._requestedVariant?.error);
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
        Number.isFinite(initial) && initial! > 0 ? initial! : Math.max((causticDiagnostics.photonPerCasterRadius
          ? causticCasterSpheres(this._visibleMeshes()).reduce((maximum, s) => Math.max(maximum, s[3]), 0)
          : this._causticBounds[3]) * 0.03, 1e-4);
      const batch = Math.max(
        1,
        this._rtUniform.views.sampleCount[0] - this._rtUniform.views.sampleSequenceOffset[0] + 1
      );
      const photonViewProjection = mat4.create();
      mat4.invert(photonViewProjection, this._viewProjInv);
      this._photonMap.encode(
        encoder,
        this._photonEmissionGroups!,
        this._activeTarget,
        photonRadius(
          radius,
          causticDiagnostics.photonDebugBatch ?? batch,
          causticDiagnostics.photonAlpha ?? 2 / 3,
          // Allocation limits may reduce the requested count.
          this._photonMap.get(this._activeTarget)!.count,
          causticDiagnostics.photonRadiusScaling
        ),
        {
          querySet: timing?.querySet,
          resourceTable: this._bindless?.table,
          orthographic: !this._causticPerspective,
          progressiveBatch: batch,
          width: this._width,
          height: this._height,
          clear,
          run: true,
          photons: 1,
          batch: Math.floor(this._rtUniform.views.sampleCount[0]),
          ...this._transport?.uniform,
          viewProjection: photonViewProjection,
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

    researchTransport()?.capture(this);
    pass.dispatchWorkgroups(
      Math.ceil(dispatchWidth / (this._transport?.workgroupSize ?? WORKGROUP_SIZE)),
      Math.ceil(dispatchHeight / (this._transport?.workgroupSize ?? WORKGROUP_SIZE)),
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
          ...this._transport?.uniform,
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
    if (!this._bvhCPU) throw new Error('software-bvh exposes no CPU-readable BVH debug buffer');
    // Debug capture pays for a combined copy only when explicitly requested.
    const buffer = new ArrayBuffer(this._bvhDataBytes);
    this._writeBVH(buffer, this._bvhCPU.tlas, this._bvhCPU.blases);
    return {buffer};
  }

  getDiagnostics() {
    const atlas = this._materialData instanceof MaterialTable ? this._materialData.textureAtlasStats : undefined;
    const materialGraphs = this.graphs.diagnosticsState;
    if((this._lightTracing || this._photonMapping) && materialGraphs.topologyCount) {
      materialGraphs.status = 'failed';
      materialGraphs.diagnostics.push({code:'unsupported-transport',message:'Material graphs currently use the constant material fallback with light tracing or photon mapping.'});
    }
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
      shaderCompilation: this._requestedVariant?.diagnostics,
      materialGraphs,
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
    return true;
  }

  hasDepthOfField() {
    return this._apertureRadius > 0;
  }


  setBounce(bounce: number) {
    const next = normalizeBounces(bounce, MAX_PATH_EVENTS_WGPU);
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

  private _shareSpectralPrefix = true;

  setQuality(options: {
    bounces: number;
    bevel: boolean;
    dispersionWavelengths: 1 | 3;
    directLightCandidates: number;
    caustics?: import('../Render.js').CausticSettings;
  }) {
    this._shareSpectralPrefix = options.dispersionWavelengths !== 1;
    WGPURayTracePass.prototype._setCaustics.call(this, options.caustics);
    writeTraceQuality(this._rtUniform.views, options, MAX_PATH_EVENTS_WGPU);
  }

  private _setCaustics(settings?: import('../Render.js').CausticSettings) {
    this._causticSettings = settings;
    const transport = researchTransport()?.configure(this, 'webgpu');
    if (!!transport?.enabled !== !!this._transport?.enabled) this._needsUpdateLightSamplingData = true;
    this._transport = transport;
    const hasCaster = !!(settings?.lightTracing || settings?.photonMapping) &&
      this._visibleMeshes().some((mesh) => mesh.materials.some(isCausticSpecular));
    const photonSupported =
      !(settings?.lightTracing || settings?.photonMapping) ||
      !hasCaster ||
      !hasStochasticCausticCaster(this._visibleMeshes());
    this._lightTracing = !!settings?.lightTracing && hasCaster && photonSupported;
    const photonMapping = !!settings?.photonMapping && hasCaster && photonSupported;
    this._photonMapping = photonMapping;
    const emissionSampling=!this._lightTracing && !this._photonMapping;
    if(this.graphs.emissionSampling!==emissionSampling) {
      this.graphs.emissionSampling=emissionSampling;
      if(this._preparedMeshData && this._materialData) {
        this._materialsBuffer=this._updateGPUBuffer('Materials',this._materialsBuffer,this._materialData.getBufferArray(),MATERIAL_FLOAT_COUNT*4);
        this._emissiveTriangles=this._collectEmissiveTriangles();
        this._needsUpdateLightSamplingData=true;
        this._needsUpdateBindGroups=true;
      }
    }
    this._causticKey =
      this._transport?.enabled || this._lightTracing || this._photonMapping
        ? `${this._lightTracing}/${this._photonMapping}/${causticDiagnostics.fullEmissionRandom !== false}/${causticDiagnostics.photonMaxDepth ?? 20}/${causticDiagnostics.debugGroup}/${causticDiagnostics.photonDirectSubset !== false}/${this._transport?.key ?? ''}`
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

  private _visibleMeshes() { return this._meshes.filter(mesh => mesh.visible); }

  setMeshes(meshes: Mesh[], update?: { transforms?: readonly Mesh[]; colors?: readonly Mesh[]; geometries?: readonly Geometry[]; materials?: readonly OpenPBRMaterial[]; visibility?: readonly Mesh[]; added?: readonly Mesh[] }) {
    this._appendOnly = !!update?.added?.length;
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
          refreshMaterialKeys(this._meshSnapshot, update.materials);
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
        // Hidden meshes keep their resident data; only instances are reselected.
        for (const mesh of update.visibility ?? []) {
          const item = this._snapshotByMesh.get(mesh);
          if (item) item.visible = mesh.visible;
          this._needsUpdateMeshMembership = true;
        }
        return !!update.materials?.length || !!update.transforms?.length || !!update.colors?.length || !!update.geometries?.length ||
          !!update.visibility?.length;
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
    // Materials are shared by many meshes; hash each once per call.
    const materialKeys = new Map<OpenPBRMaterial, string>();
    const materialKey = (material: OpenPBRMaterial) => {
      let key = materialKeys.get(material);
      if (key === undefined) { key = getMaterialHashKey(material); materialKeys.set(material, key); }
      return key;
    };
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
      materialKeys: mesh.materials.map(materialKey),
      visible: mesh.visible,
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
        item.visible !== previousSnapshot[i]?.visible || item.materials.some((material, k) => material !== previousSnapshot[i]?.materials[k]));
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
          (next, index) => next.mesh !== previousSnapshot[index]?.mesh || next.visible !== previousSnapshot[index]?.visible
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

  private _collectEmissiveTriangles() {
    const res=this._preparedMeshData!;
    const gpuSlots=tlasInstanceSlots(this._tlas!);
    const bindings=res.instanceBindings.map((binding,index)=>{
      const slots=new Array<number>(binding.mesh.instanceData?.count ?? 1).fill(-1);
      if(Array.isArray(res.instances))slots[0]=gpuSlots.get(index) ?? -1;
      else for(const slot of res.instances.bindingSlots[index] ?? [])slots[res.instances.localIndices[slot]]=gpuSlots.get(slot) ?? -1;
      return {...binding,instanceSlots:slots};
    });
    // Candidate black emitters must survive mesh preparation. The installed
    // plan's proposal decides activity, including validation and transport fallback.
    res.emissiveBindings=bindings.filter(binding=>binding.materialIndices.some(index=>{
      const m=res.materials[index];
      return !m.unlit && !m.shadowCatcher && colorLuminance(this.graphs.emissionProposal(m) ?? materialEmission(m))>1e-8;
    }));
    return this._emissiveCache.collect(res.emissiveBindings,res.materials);
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
      this._shadowCatcherLightChoices,
      true
    );
    researchTransport()?.prepare(this, 'webgpu', lighting);
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
  /** Returns false when resident BLASes stayed in place and only the TLAS was written. */
  private _uploadBVH(tlas: FlattendBVH, blases: BLASInstance[]): boolean {
    const stacks = getTraversalStackSizes(tlas, blases);
    this._constants.TLAS_STACK_SIZE = retainedShaderCapacity(stacks.tlas, Number(this._constants.TLAS_STACK_SIZE ?? 0));
    this._constants.BLAS_STACK_SIZE = retainedShaderCapacity(stacks.blas, Number(this._constants.BLAS_STACK_SIZE ?? 0), 32);
    const blasBytes = blases.reduce((sum, b) => sum + b.bvh.buffer.byteLength, 0);
    // Missing limits (offline capture devices) are unbounded, as for scene buffers above.
    const limit = Math.min(this._device.limits?.maxBufferSize ?? Infinity, this._device.limits?.maxStorageBufferBindingSize ?? Infinity);
    // Instance-only updates (visibility, membership) keep resident BLASes in
    // place and rewrite only the TLAS when it fits the reserved region.
    const uploaded = this._uploadedBlases;
    if (this._bvhBuffer && this._bvhCPU && tlas.buffer.byteLength <= this._blasBase &&
      uploaded.length === blases.length && blases.every((blas, i) => blas.bvh.buffer === uploaded[i])) {
      this._device.queue.writeBuffer(this._bvhBuffer, 0, tlas.buffer);
      this._bvhCPU = {tlas, blases};
      const instancesBuffer = this._updateGPUBuffer('Instances', this._instancesBuffer, new Float32Array(tlas.instancesBuffer!));
      if (instancesBuffer !== this._instancesBuffer) this._needsUpdateBindGroups = true;
      this._instancesBuffer = instancesBuffer;
      return false;
    }
    const appendPrefix = this._bvhBuffer && this._bvhCPU && tlas.buffer.byteLength <= this._blasBase &&
      uploaded.length < blases.length && uploaded.every((buffer, i) => buffer === blases[i].bvh.buffer);
    if (appendPrefix && blasBytes <= this._blasCapacity) {
      this._device.queue.writeBuffer(this._bvhBuffer!, 0, tlas.buffer);
      let target = this._blasBase + uploaded.reduce((sum, buffer) => sum + buffer.byteLength, 0);
      for (let i = uploaded.length; i < blases.length; i++) {
        const source = blases[i].bvh.buffer;
        this._device.queue.writeBuffer(this._bvhBuffer!, target, source);
        target += source.byteLength;
      }
      this._uploadedBlases = blases.map(blas => blas.bvh.buffer);
      this._bvhCPU = {tlas, blases}; this._bvhDataBytes = this._blasBase + blasBytes;
      const instancesBuffer = this._updateGPUBuffer('Instances', this._instancesBuffer, new Float32Array(tlas.instancesBuffer!));
      if (instancesBuffer !== this._instancesBuffer) this._needsUpdateBindGroups = true;
      this._instancesBuffer = instancesBuffer;
      return false;
    }
    // Headroom lets later instance-only updates grow the TLAS without moving BLASes.
    const tlasBytes = tlas.buffer.byteLength;
    let blasBase = Math.ceil((tlasBytes + Math.min(tlasBytes >> 2, 1 << 20) + 256) / 256) * 256;
    if (blasBase + blasBytes > limit) blasBase = Math.ceil(tlasBytes / 16) * 16;
    const size = blasBase + blasBytes;
    if (size > limit) throw new RangeError(`BVH buffer requires ${size} bytes; device storage buffer limit is ${limit} bytes.`);
    const capacity = Math.min(limit - blasBase, Math.ceil((blasBytes + Math.min(blasBytes >> 1, 64 * 1024 * 1024) + 256) / 256) * 256);
    this._blasCapacity = capacity;
    this._blasBase = blasBase;
    this._uploadedBlases = blases.map(blas => blas.bvh.buffer);
    let bvhBuffer = this._bvhBuffer;
    if (!bvhBuffer || bvhBuffer.size < Math.max(blasBase + capacity, WGPU_SCENE_BUFFER_MIN_BYTES)) {
      bvhBuffer?.destroy();
      const allocationSize = Math.max(blasBase + capacity, WGPU_SCENE_BUFFER_MIN_BYTES);
      bvhBuffer = this._device.createBuffer({label: 'BVH', size: allocationSize,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC, mappedAtCreation: allocationSize < 0x80000000});
      if (allocationSize < 0x80000000) {
        this._writeBVH(bvhBuffer.getMappedRange(), tlas, blases);
        bvhBuffer.unmap();
      } else this._uploadBVHBlocks(bvhBuffer, tlas, blases);
    } else this._uploadBVHBlocks(bvhBuffer, tlas, blases);
    this._bvhCPU = {tlas, blases};
    this._bvhDataBytes = size;
    const blasOffset = blasBase / 16;
    const instancesBuffer = this._updateGPUBuffer(
      'Instances', this._instancesBuffer, new Float32Array(tlas.instancesBuffer!)
    );
    if (bvhBuffer !== this._bvhBuffer || instancesBuffer !== this._instancesBuffer) this._needsUpdateBindGroups = true;
    this._bvhBuffer = bvhBuffer;
    this._instancesBuffer = instancesBuffer;
    this._rtUniform.views.blasOffset.set([blasOffset]);
    return true;
  }

  private _uploadBVHBlocks(buffer: GPUBuffer, tlas: FlattendBVH, blases: BLASInstance[]) {
    this._device.queue.writeBuffer(buffer, 0, tlas.buffer);
    let target = this._blasBase;
    for (const blas of blases) {
      const chunkBytes = 64 * 1024 * 1024;
      for (let offset = 0; offset < blas.bvh.buffer.byteLength; offset += chunkBytes) {
        this._device.queue.writeBuffer(buffer, target + offset, blas.bvh.buffer, offset, Math.min(chunkBytes, blas.bvh.buffer.byteLength - offset));
      }
      target += blas.bvh.buffer.byteLength;
    }
  }

  private _writeBVH(buffer: ArrayBuffer, tlas: FlattendBVH, blases: BLASInstance[]) {
    const bytes = new Uint8Array(buffer);
    bytes.set(new Uint8Array(tlas.buffer));
    let offset = this._blasBase;
    for (const blas of blases) {
      bytes.set(new Uint8Array(blas.bvh.buffer), offset);
      offset += blas.bvh.buffer.byteLength;
    }
  }

  private _updateMeshData() {
    const previousPrepared = this._preparedMeshData;
    const previousMaterialData = this._materialData;
    const previousAttributes = this._attributeData;
    const previousStride = this._attributeStride;
    const previousOffsets = this._attributeOffsets;
    this._pendingGeometryUpdates.clear();
    this._emissiveCache = new EmissiveTriangleCache(material=>colorLuminance(this.graphs.emissionProposal(material as OpenPBRMaterial) ?? materialEmission(material)));
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
    const res = updateMeshInstances(meshes, {mergeAttributes: false});
    this._preparedMeshData = res;
    this._membershipCache.capture(res);
    this._pendingMembershipData = undefined;
    this._needsUpdateMeshMembership = false;
    const mergedGeometry = res.geometry;
    const materials = res.materials;
    const isEmpty = meshes.length === 0 || res.instances.length === 0;
    const tlas = buildWebTLAS(res.instances, res.blases);
    this._tlas = tlas;
    this._uploadBVH(tlas, res.blases);

    const reuseMaterials = this._appendOnly && previousPrepared && previousMaterialData &&
      materials.length === previousPrepared.materials.length && materials.every((material, i) => material === previousPrepared.materials[i]);
    const materialData = reuseMaterials ? previousMaterialData : (this._materialData = this._createMaterialData(
      materials, this._analyticLights, {maxTextureArrayBytes: this._maxTextureArrayBytes,
        maxTextureArrayLayers: this._device.limits.maxTextureArrayLayers,
        maxTextureDimension2D: this._device.limits.maxTextureDimension2D}));
    this._emissiveTriangles = this._collectEmissiveTriangles();
    this._needsUpdateLightSamplingData = true;

    // Displacement geometry and its CPU BVH bounds must use the same normal.
    // Preserve f32 normals in these scenes, avoiding quantization outside bounds.
    const attributeLayout = compactVertexLayout(res.geometries, materials.some(m => !!m.displacementMap));
    const {stride, offsets} = attributeLayout;
    const vertexWords = res.geometries.reduce((sum, g) => sum + g.vertexCount, 0) * stride;
    const materialWords = attributeLayout.constants.HAS_TRIANGLE_MATERIAL ? this._bvhDataBytes / 16 : 0;
    const appendVertexStart = previousPrepared && previousAttributes && !attributeLayout.constants.HAS_TRIANGLE_MATERIAL &&
      previousPrepared.geometries.length < res.geometries.length &&
      previousPrepared.geometries.every((geometry, i) => geometry === res.geometries[i]) &&
      previousStride === stride && previousOffsets.length === offsets.length && previousOffsets.every((value, i) => value === offsets[i])
      ? previousPrepared.geometries.reduce((sum, geometry) => sum + geometry.vertexCount, 0) : 0;
    const attrBufferData = new Uint32Array(vertexWords + materialWords);
    if (appendVertexStart) attrBufferData.set(previousAttributes!.subarray(0, appendVertexStart * stride));
    attributeLayout.constants.MATERIALINDEX_OFF = vertexWords;
    for (let geometryIndex = 0; geometryIndex < res.geometries.length; geometryIndex++) {
      const geometry = res.geometries[geometryIndex];
      if (appendVertexStart && geometryIndex < previousPrepared!.geometries.length) continue;
      const region = res.geometryRegions.get(geometry)!;
      packCompactVertices(geometry, attrBufferData, stride, offsets, 0, geometry.vertexCount,
        region.vertexOffset, false, !!attributeLayout.constants.COLOR_FLOAT, !!attributeLayout.constants.NORMAL_FLOAT);
    }
    this._attributeData = attrBufferData; this._attributeStride = stride; this._attributeOffsets = offsets;
    Object.assign(this._constants, attributeLayout.constants);
    this._packTriangleMaterials(res, tlas);
    if (appendVertexStart && this._attrBuffers && this._attrBuffers.size >= attrBufferData.byteLength) {
      const byteOffset = appendVertexStart * stride * 4;
      this._device.queue.writeBuffer(this._attrBuffers, byteOffset, attrBufferData.buffer, byteOffset, attrBufferData.byteLength - byteOffset);
    } else this._attrBuffers = this._updateGPUBuffer('Attributes', this._attrBuffers, attrBufferData,
      Math.ceil((attrBufferData.byteLength + Math.min(attrBufferData.byteLength >> 1, 64 * 1024 * 1024) + 255) / 256) * 256);

    if (!reuseMaterials) this._materialsBuffer = this._updateGPUBuffer(
      'Materials', this._materialsBuffer, materialData.getBufferArray(), MATERIAL_FLOAT_COUNT * 4);

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
    if (!reuseMaterials) { this._updateMaterialConstants(materials, materialData, mergedGeometry); this._updateTextures(materialData); }

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
    this._appendOnly = false;
  }

  private _updateMaterialConstants(materials: OpenPBRMaterial[], materialData: MaterialTable | WGPUBindlessMaterialData, mergedGeometry: Geometry) {
    materials = materialData.capabilityMaterials ?? materials;
    const hasTransmission = materials.some((m) => m.transmissionWeight > 0);
    if (hasTransmission !== this._hasTransmission) {
      this._hasTransmission = hasTransmission;
    }

    this._hasShadowCatcher = materials.some((m) => m.shadowCatcher);

    const hasDisplacement = materialData.getDisplacementMaps().length > 0;
    this._hasDisplacement = hasDisplacement;

    // Optional source specializations must disappear when their last map is removed.
    delete this._constants.USE_MATERIALX_NORMAL_MAPS;
    Object.assign(this._constants, wgpuMaterialConstants(materials, materialData, mergedGeometry,
      this._bevelSamples, Number(this._constants.NUM_MAPS ?? 0)));
    // Runtime storage metadata has no texture-count specialization.
    if (this._bindless) this._constants.NUM_MAPS = 20;
  }

  private _packTriangleMaterials(res: ReturnType<typeof updateMeshInstances>, tlas: FlattendBVH) {
    if (!this._constants.HAS_TRIANGLE_MATERIAL) return;
    let offset = Number(this._constants.MATERIALINDEX_OFF) + this._blasBase / 16;
    res.geometries.forEach((g, i) => {
      packTriangleMaterials(g, res.geometryRegions.get(g)!.materialIndices, res.blases[i].bvh.buffer, this._attributeData!, offset);
      offset += res.blases[i].bvh.buffer.byteLength / 16;
    });
  }

  private _refreshTriangleMaterials(res: ReturnType<typeof updateMeshInstances>, tlas: FlattendBVH) {
    if (!this._constants.HAS_TRIANGLE_MATERIAL) return;
    const vertexWords = Number(this._constants.MATERIALINDEX_OFF);
    const required = vertexWords + this._bvhDataBytes / 16;
    if (this._attributeData!.length !== required) {
      const next = new Uint32Array(required);
      next.set(this._attributeData!.subarray(0, vertexWords));
      this._attributeData = next;
    }
    this._packTriangleMaterials(res, tlas);
    if (this._attrBuffers!.size < this._attributeData!.byteLength) {
      this._attrBuffers = this._updateGPUBuffer('Attributes', this._attrBuffers, this._attributeData!);
    } else {
      const first = vertexWords * 4, end = this._attributeData!.byteLength, chunk = 64 * 1024 * 1024;
      for (let offset = first; offset < end; offset += chunk) {
        this._device.queue.writeBuffer(this._attrBuffers!, offset, this._attributeData!.buffer, offset, Math.min(chunk, end - offset));
      }
    }
  }

  private _updateGeometryData() {
    const res = this._preparedMeshData!, tlas = this._tlas!;
    // Promote the scene color plane if an edit introduces HDR/negative RGB.
    if (!this._constants.COLOR_FLOAT && [...this._pendingGeometryUpdates].some(g =>
      g.color?.array.some(value => !(value >= 0 && value <= 1)))) {
      this._updateMeshData();
      return;
    }
    invalidateInstanceTransformRanges(res.instances);
    const update = updatePreparedGeometries(res, this._pendingGeometryUpdates);
    for (const { first, count, deformationOnly } of update.vertices) {
      const geometry = res.geometries.find(g => res.geometryRegions.get(g)!.vertexOffset === first)!;
      packCompactVertices(geometry, this._attributeData!, this._attributeStride, this._attributeOffsets,
        0, count, first, deformationOnly, !!this._constants.COLOR_FLOAT, !!this._constants.NORMAL_FLOAT);
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
      for (const { blas, offset } of update.blases) {
        this._device.queue.writeBuffer(this._bvhBuffer!, this._blasBase + offset, blas.buffer);
      }
    }

    if (this._constants.HAS_TRIANGLE_MATERIAL && (update.relocated || update.vertices.some(v => v.topologyChanged))) {
      this._refreshTriangleMaterials(res, tlas);
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
      this._emissiveTriangles = this._collectEmissiveTriangles();
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
    const res = selectVisibleInstances(resident, this._meshes);
    const {instances} = res;
    this._preparedMeshData = res;
    if (pending) this._residentPreparedMeshData = res;
    this._pendingMembershipData = undefined;
    const tlas = buildWebTLAS(instances, res.blases);
    this._tlas = tlas;
    // Triangle materials follow the BLAS layout, which stays put when reused.
    if (this._uploadBVH(tlas, res.blases)) this._refreshTriangleMaterials(res, tlas);

    this._emissiveTriangles = this._collectEmissiveTriangles();
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
    if (!dirtyIndices.size && this._dirtyTransformMeshes.size && canSkipInstanceRefit(res.instances, res.instanceBindings)) {
      this._dirtyTransformMeshes.clear(); this._needsRefitTLAS = false; return;
    }
    const incremental = dirtyIndices.size > 0;
    const previousInstances = res.instances;
    res.instances = updateMeshInstanceTransforms(
      res.instanceBindings,
      incremental ? res.instances : undefined,
      incremental ? dirtyIndices : undefined
    );
    if (!sameInstanceMembership(previousInstances, res.instances)) {
      this._tlas = buildWebTLAS(res.instances, res.blases);
      if (this._uploadBVH(this._tlas, res.blases)) this._refreshTriangleMaterials(res, this._tlas);
      this._emissiveTriangles = this._collectEmissiveTriangles();
      this._needsUpdateLightSamplingData = true;
      this._rtUniform.views.isEmpty[0] = +(res.instances.length === 0);
      this._dirtyTransformMeshes.clear(); this._needsRefitTLAS = false;
      return;
    }
    const ranges = refitTLAS(
      tlas,
      res.instances,
      res.blases,
      incremental ? dirtyIndices : undefined,
      true
    );
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

    if (
      !incremental ||
      res.emissiveBindings.some(({ mesh }) =>
        this._dirtyTransformMeshes.has(mesh)
      )
    ) {
      this._emissiveTriangles = this._collectEmissiveTriangles();
      this._needsUpdateLightSamplingData = true;
    }
    this._dirtyTransformMeshes.clear();
    this._needsRefitTLAS = false;
  }

  private _createMaterialData(...args: ConstructorParameters<typeof MaterialTable>): MaterialTable | WGPUBindlessMaterialData {
    this.graphs.capabilities = this._bindless ? 'bindless' : 'atlas';
    if (this._bindless) {
      const data = new WGPUBindlessMaterialData(args[0], args[1], this.graphs);
      const reason = bindlessLimitReason(this._device, data.textures.length);
      if (!reason) return data;
      this._textureSelection.fallbackReason = reason;
      const retired = this._bindless;
      this._retiredBindless.add(retired);
      void this._device.queue.onSubmittedWorkDone().catch(() => {}).then(() => {retired.dispose(); this._retiredBindless.delete(retired);});
      this._bindless = undefined;
    }
    return new MaterialTable(args[0], args[1], args[2], this.graphs);
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
    const analyticLights = lights.filter(
      (light) =>
        light.type === 'DirectionalLight' ||
        light.type === 'SphereLight' ||
        light.type === 'SpotLight' ||
        light.type === 'RectLight' ||
        light.type === 'DiskLight' ||
        light.type === 'CylinderLight'
    ) as AnalyticLight[];
    if (analyticLights.length > MAX_ANALYTIC_LIGHTS) throw new RangeError(`At most ${MAX_ANALYTIC_LIGHTS} analytic lights are supported.`);
    const requiredLightBytes = Math.max(16, analyticLights.length * PIXELS_PER_LIGHT * 16);
    if (this._uniforms.analyticLights.size < requiredLightBytes) {
      this._uniforms.analyticLights.destroy();
      this._uniforms.analyticLights = this._storageBuffer(requiredLightBytes);
    }
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
    mat4.invert(this._projectionInv, projection);
    mat4.mul(viewProjectionInvMat, camera.transform, this._projectionInv);
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
        this._apertureRadius, this._focusDistance, this._projectionInv)
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
    for (const job of this._queuedCompiles.splice(0)) job.release();
    this._traceVariants.clear();
    this._rayTracePipeline = undefined;
    this._rayTraceBindGroups = undefined;
  }

}

export default WGPURayTracePass;
