import {researchTransport} from './researchTransport.js';
import {EmissiveTriangleCache} from './lightSampling.js';
import {prepareWebGLLightSampling} from './webglLightSampling.js';
import {AovPrimitiveCache} from './AovPrimitiveCache.js';
import {aovTraceFragment} from './glsl/aovTrace.frag.js';
import {WebGLAov} from './WebGLAov.js';
import {packAovScene} from './aovScene.js';
import {aovMask, type AovKind} from './aov.js';
import { WebGLSkySource } from './WebGLSkySource.js';
import { normalizeBounces } from './pathLimits.js';
import { updateMeshInstanceColors } from './prepareMeshBVH.js';
import { updateTLASInstanceColors } from './bvhAccel.js';
import { getMaterialHashKey } from '../scene/openPbrSchema.js';
import { sameInstanceMembership } from './meshInstances.js';
import InstancedMesh from '../scene/InstancedMesh.js';
import { dirtyMeshInstanceIndices } from './prepareMeshBVH.js';
import { cameraApertureRadius } from './cameraLens.js';
import { getGeometryBvh, setGeometryBvh } from './geometryBvh.js';
import { samplingPatternCode, zSobolLog2SPP, type SamplingPattern } from './sampling.js';
import depthQueryFrag from './glsl/depthQuery.frag.js';
import { readFloatPixelsAsync } from './WebGLReadback.js';
import { DEPTH_SAMPLE_GRID, packDepthSampleArea, unpackDepthSamples, type DepthSampleArea } from './depthQuery.js';
import { MeshMembershipCache } from './meshMembership.js';
import { SceneEnvironmentCache, RectLightTextureTracker } from './sceneLightChanges.js';
import { MaterialChangeTracker, materialIsEmissive, type MaterialUpdateLevel } from './materialChanges.js';
import {
  constants,
  WebGLDevice as WebGLRenderer,
  Texture2D as WebGLTexture2D
} from './webgl.js';
import { WebGLFullQuadPass } from './WebGLFullQuadPass.js';
import { mat4 } from '../math.js';
import Mesh from '../scene/Mesh.js';
import {
  buildBLAS,
  buildTLAS,
  concatBLASBuffers,
  refitBLAS,
  refitTLAS,
  mergeRefitRanges,
  type FlattendBVH
} from './bvhAccel.js';
import {
  generateBackgroundMapFromSceneBackground, environmentRotation, backgroundMapTransform, backgroundMapRotation
} from './envMapCreation.js';
import {
  envMapDistribution,
  environmentMapSourcesMatch,
  type EnvironmentMapSource
} from './envMapDistribution.js';
import createRayTraceFragmentShader from './glsl/rayTrace.frag.js';
import shadowCatcherFrag from './glsl/shadowCatcher.frag.js';
import MaterialTable, {
  DEFAULT_MAX_TEXTURE_ARRAY_BYTES,
  materialUsesMedium
} from './MaterialTable.js';
import OpenPBRMaterial, {
  resolveMaterialAlphaMode
} from '../scene/OpenPBRMaterial.js';

import DirectionalLight from '../scene/DirectionalLight.js';
import SphereLight from '../scene/SphereLight.js';
import RectLight from '../scene/RectLight.js';
import SpotLight from '../scene/SpotLight.js';
import type { SceneBackground, SceneLight } from '../scene/Scene.js';
import { isIntelMac, numberArraysEqual } from './util.js';
import Camera from '../scene/Camera.js';
import {
  commonLinearFloatProps,
  commonNearestFloatProps,
  setDataTexture,
  textureDimensionsFromArray
} from './dataTextureUtil.js';
import {
  CONSTANT_DIRECTIONAL_LIGHT,
  CONSTANT_RECT_LIGHT,
  CONSTANT_SPHERE_LIGHT,
  packLightsToBuffer
} from './lightsUtil.js';
import {
  estimateAnalyticLightPower,
  estimateEnvironmentPower,
  packIESProfiles
} from './lightSampling.js';
import { updatePreparedGeometries, canUpdateGeometries, geometryTopologyChanged } from './geometryUpdates.js';
import Geometry, { Attribute } from '../scene/Geometry.js';
import { updateMeshInstances, updateMeshInstanceTransforms } from './prepareMeshBVH.js';
import { mergeMeshesToGeometry } from './mergeMeshesToGeometry.js';
import {
  DEFAULT_BEVEL_SAMPLES,
  normalizeBevelSamples
} from './RenderingPipeline.js';
import {
  getOpenPbrEnergyLutData,
  OPENPBR_ENERGY_LUT_HEIGHT,
  OPENPBR_ENERGY_LUT_WIDTH
} from './openPbrEnergyLut.js';

type AnalyticLight = DirectionalLight | SphereLight | SpotLight | RectLight;
// A defensive mixture keeps weak-but-wide lights from being starved by an
// imperfect scalar power estimate while still favoring dominant emitters.
const POWER_WEIGHTED_LIGHT_MIX = 0.25;

function packLightsToTexture(
  texture: WebGLTexture2D,
  lights: AnalyticLight[],
  texturesIndices: number[],
  selectionPmfs: ArrayLike<number>,
  selectionCdfs: ArrayLike<number>,
  iesProfileTexelOffsets: ArrayLike<number>
) {
  const data = packLightsToBuffer(
    lights,
    texturesIndices,
    selectionPmfs,
    selectionCdfs,
    iesProfileTexelOffsets
  );
  texture.source = {
    data,
    width: data.length / 4,
    height: 1
  };
}

// TODO EXT_float_blend
// rayTraceBlendNode.inputs = {
//   colorTex: rayTraceNode,
//   prevColorTex: {
//     node: rayTraceBlendNode,
//     prevFrame: true
//   }
// };

// TODO use one method to set all required properties.
// Ensure necessary properties are set.
class WebGLRayTracePass {
  private _aovPrimitiveCache = new AovPrimitiveCache();
  private readonly _renderer: WebGLRenderer;
  private _meshes: Mesh[] = [];
  private _emissiveActive=false;
  private _directLightLegacy?: {env:number;pmfs:Float32Array};
  private _emissiveCache=new EmissiveTriangleCache();
  private _emissiveTex=new WebGLTexture2D(commonNearestFloatProps);
  private _sceneEnvironment = new SceneEnvironmentCache();
  private _rectLightTextures = new RectLightTextureTracker();
  private _analyticLights: AnalyticLight[] = [];
  private _analyticLightSelectionPmfs = new Float32Array(0);
  private _analyticLightSelectionCdfs = new Float32Array(0);
  private _envLightSelectionPmf = 0;
  private _materialData: MaterialTable | undefined;
  private _maxTextureArrayBytes = DEFAULT_MAX_TEXTURE_ARRAY_BYTES;
  private _preparedMeshData?: ReturnType<typeof updateMeshInstances>;
  private _membershipCache = new MeshMembershipCache();
  private _pendingMembershipData?: ReturnType<typeof updateMeshInstances>;
  private _materialChanges = new MaterialChangeTracker();
  private _pendingMaterialUpdate?: { level: MaterialUpdateLevel; emission: boolean; emissiveMap: boolean; materials: Set<OpenPBRMaterial> };
  private _pendingGeometryUpdates = new Set<Geometry>();
  private _needsUpdateMeshData = true;
  private _needsUpdateMeshMembership = false;
  private _needsRefitTLAS = false;
  private _dirtyTransformMeshes = new Set<Mesh>();
  private _dirtyColorMeshes = new Set<Mesh>();
  private _tlas?: FlattendBVH;
  private _bvhData?: Float32Array;
  private _instancesData?: Float32Array;
  private _materialIndexData?: Float32Array;
  private _meshSnapshot: {
    mesh: Mesh;
    instanceCount: number;
    instanceVersion: number;
    instanceTransforms?: Float32Array;
    instanceColors?: Float32Array;
    colorVersion: number;
    geometry: Mesh['geometry'];
    materials: OpenPBRMaterial[];
    materialKeys: string[];
    geometryVersion: number;
    positionArray: Float32Array;
    indexArray: Geometry['indices']['array'];
    matrix: number[];
  }[] = [];
  private _snapshotByMesh = new WeakMap<Mesh, (typeof this._meshSnapshot)[number]>();
  private _needsUpdateAnalyticLightsBuffer = true;
  private _debugBvhData?: {
    buffer: ArrayBuffer;
  };

  private _lightTex = new WebGLTexture2D(commonNearestFloatProps);
  private _iesProfileTex = new WebGLTexture2D(commonNearestFloatProps);
  private _iesProfileColumns = 1;
  private _iesProfileTexelOffsets = new Int32Array(0);
  private _openPbrEnergyLut = new WebGLTexture2D({
    ...commonNearestFloatProps,
    source: {
      data: getOpenPbrEnergyLutData(),
      width: OPENPBR_ENERGY_LUT_WIDTH,
      height: OPENPBR_ENERGY_LUT_HEIGHT
    }
  });

  private _envMap = new WebGLTexture2D(commonLinearFloatProps);
  private _envMapDistribution = new WebGLTexture2D(commonLinearFloatProps);
  private _envImageSource?: EnvironmentMapSource;
  private readonly _skySource = new WebGLSkySource();
  private _backgroundTex = new WebGLTexture2D(commonLinearFloatProps);

  private _hasEnvMap = false;
  private _hasBackground = false;
  private _groundedBackgroundParams = new Float32Array([0, 0, 0, 0]);
  private _groundedBackgroundCenter = new Float32Array([0, 0]);
  private _backgroundMapTransform = backgroundMapTransform();
  private _backgroundMapRotation = new Float32Array([1,0,0, 0,1,0, 0,0,1]);

  private _bounces = 2;
  private _bevelSamples = DEFAULT_BEVEL_SAMPLES;
  private _clamping?: number;

  // higher number results in faster convergence over time, but with lower quality initial samples

  private _samplingCode = -1;
  private _sequenceSeed = 0;
  private _zLogSPP = 0;

  private _positionBufferTex = new WebGLTexture2D(commonNearestFloatProps);
  private _normalBufferTex = new WebGLTexture2D(commonNearestFloatProps);
  private _colorBufferTex = new WebGLTexture2D(commonNearestFloatProps);
  private _tangentBufferTex = new WebGLTexture2D(commonNearestFloatProps);
  private _uvBufferTex = new WebGLTexture2D(commonNearestFloatProps);
  private _uv1BufferTex = new WebGLTexture2D(commonNearestFloatProps);
  private _bvhBufferTex = new WebGLTexture2D(commonNearestFloatProps);
  private _instancesBufferTex = new WebGLTexture2D(commonNearestFloatProps);
  private _matIndexBufferTex = new WebGLTexture2D({
    ...commonNearestFloatProps
    // type: constants.INT
  });

  private _hasTransmission = false;
  private _hasAlpha = false;

  private _invalid = false;
  private _transmissiveAlphaMin = 1;

  private _mainPass: WebGLFullQuadPass<
    never,
    'color' | 'albedo' | 'normal' | 'moments'
  >;
  private _shadowCatcherPass: WebGLFullQuadPass<
    never,
    'shadowCatcher' | 'catcherBackground' | 'catcherMoments'
  >;

  private _viewProjInv = mat4.create();
  private _apertureRadius = 0;
  private _focusDistance = 10;

  private _aovPass: WebGLFullQuadPass<string, 'geometry' | 'position' | 'diffuse' | 'specular'>;
  private _aovCenter: WebGLFullQuadPass<string, 'id' | 'motion'>;
  private _tracePasses: WebGLFullQuadPass<any, any>[];
  private readonly _depthPass: WebGLFullQuadPass<never, 'depth'>;
  private readonly _depthAbort = new AbortController();
  private _depthAspect = 1;
  private _hasShadowCatcher = false;
  private _spectral = false;

  constructor(renderer: WebGLRenderer) {
    this._renderer = renderer;
    const accumulationOutput = {
      type: constants.FLOAT,
      minFilter: constants.LINEAR,
      magFilter: constants.LINEAR,
      wrapS: constants.CLAMP_TO_EDGE,
      wrapT: constants.CLAMP_TO_EDGE
    };

    const rayTraceFrag = createRayTraceFragmentShader();
    rayTraceFrag.parallelCompile = true;
    shadowCatcherFrag.parallelCompile = true;
    this._mainPass = new WebGLFullQuadPass<
      never,
      'color' | 'albedo' | 'normal' | 'moments'
    >('rayTrace', renderer, {
      shader: rayTraceFrag,
      // `moments` holds the denoiser's guide value moments and sample count.
      outputs: ['color', 'albedo', 'normal', 'moments'],
      outputParams: {
        color: accumulationOutput,
        albedo: accumulationOutput,
        normal: accumulationOutput,
        moments: accumulationOutput
      }
    });
    this._shadowCatcherPass = new WebGLFullQuadPass<
      never,
      'shadowCatcher' | 'catcherBackground' | 'catcherMoments'
    >(
      'shadowCatcher',
      renderer,
      {
        shader: shadowCatcherFrag,
        outputs: ['shadowCatcher', 'catcherBackground', 'catcherMoments'],
        outputParams: {
          shadowCatcher: accumulationOutput,
          catcherBackground: accumulationOutput,
          catcherMoments: accumulationOutput
        }
      }
    );
    this._depthPass = new WebGLFullQuadPass('Depth query', renderer, {
      shader: depthQueryFrag, outputs: ['depth'],
      outputParams: { depth: commonNearestFloatProps }
    });
    this._aovPass = new WebGLFullQuadPass('AOV accumulation', renderer, {shader:aovTraceFragment(false), outputs:['geometry','position','diffuse','specular'], outputParams: Object.fromEntries(['geometry','position','diffuse','specular'].map(name=>[name,commonNearestFloatProps]))});
    this._aovCenter = new WebGLFullQuadPass('AOV center',renderer,{shader:aovTraceFragment(true),outputs:['id','motion'],outputParams:{id:{...commonNearestFloatProps,type:5125},motion:commonNearestFloatProps}});
    this._tracePasses = [this._aovPass, this._aovCenter, this._mainPass, this._shadowCatcherPass, this._depthPass];
    this._tracePasses.forEach((pass) => {
      pass.setDefines({
        OES_texture_float_linear: !!renderer.gl.getExtension(
          'OES_texture_float_linear'
        )
      });
    });
    this._mainPass.setUniform('openPbrEnergyLut', this._openPbrEnergyLut);
    this._aovPass.setUniform('openPbrEnergyLut', this._openPbrEnergyLut);
  }

  preparePrograms() {
    this.prepare();
    const main = this._mainPass.isProgramReady();
    const shadow = !this._hasShadowCatcher || this._shadowCatcherPass.isProgramReady();
    return main && shadow;
  }

  createPass(
    clear: boolean,
    tile: { x: number; y: number; width: number; height: number },
    disableShadowCatcher = false
  ) {
    this.prepare();
    const options = {
      clear,
      blend: !clear,
      scissor: tile
    };
    this._mainPass.createPass({} as Record<never, WebGLTexture2D>, undefined, options);
    if (this._hasShadowCatcher && !disableShadowCatcher) {
      this._shadowCatcherPass.createPass(
        {} as Record<never, WebGLTexture2D>,
        undefined,
        options
      );
    }
  }

  getOutput(
    label: 'color' | 'albedo' | 'normal' | 'moments' |
      'shadowCatcher' | 'catcherBackground' | 'catcherMoments'
  ) {
    return label === 'shadowCatcher' || label === 'catcherBackground' ||
      label === 'catcherMoments'
      ? this._shadowCatcherPass.getOutput(label)
      : this._mainPass.getOutput(label);
  }

  setBounce(bounce: number) {
    const next = normalizeBounces(bounce);
    const changed = this._bounces !== next;
    this._bounces = next;
    return changed;
  }

  setClamping(clamping?: number) {
    const changed = this._clamping !== clamping;
    this._clamping = clamping;
    return changed;
  }

  setBevelSamples(samples: number) {
    const next = normalizeBevelSamples(samples);
    const changed = this._bevelSamples !== next;
    if (changed) {
      this._bevelSamples = next;
    }
    return changed;
  }

  private _setEnvMap(envImage: EnvironmentMapSource | undefined) {
    if (!environmentMapSourcesMatch(envImage, this._envImageSource) && envImage) {
      this._envMap.source = envImage;
      this._envMapDistribution.source = envMapDistribution(envImage);
    }
    this._envImageSource = envImage;
    this._tracePasses.forEach((pass) => {
      pass.setUniform('envMap', envImage ? this._envMap : null);
      pass.setUniform(
        'envMapDistribution',
        envImage ? this._envMapDistribution : null
      );
      pass.setUniform('envLightSelectionPmf', this._envLightSelectionPmf);

      pass.setDefines({
        USE_ENVMAP: !!envImage
      });
    });

    this._hasEnvMap = !!envImage;
  }

  setBackground(background?: SceneBackground) {
    this._backgroundMapTransform.set(backgroundMapTransform(background));
    const rotation = backgroundMapRotation(background);
    this._backgroundMapRotation.set([rotation[0],rotation[1],rotation[2], rotation[4],rotation[5],rotation[6], rotation[8],rotation[9],rotation[10]]);
    const backgroundImage =
      background ? this._skySource.resolve(generateBackgroundMapFromSceneBackground(background)) : undefined;

    if (backgroundImage) {
      this._backgroundTex.source = backgroundImage;
    }
    this._hasBackground = !!backgroundImage;
    const grounded =
      background &&
      !Array.isArray(background) &&
      'type' in background &&
      background.type === 'GroundedSkybox'
        ? background
        : undefined;
    this._groundedBackgroundParams.set(
      grounded
        ? [
            Math.max(grounded.height, 0.0001),
            Math.max(grounded.radius, 0.0001),
            grounded.groundHeight ?? 0,
            1
          ]
        : [0, 0, 0, 0]
    );
    this._groundedBackgroundCenter.set(grounded?.center ?? [0, 0]);
  }

  setTransmissiveOutputAlphaMin(transmissiveAlphaMin: number) {
    const changed = this._transmissiveAlphaMin !== transmissiveAlphaMin;
    this._transmissiveAlphaMin = transmissiveAlphaMin;
    return changed;
  }

  setMeshes(meshes: Mesh[], update?: { transforms?: readonly Mesh[]; colors?: readonly Mesh[]; geometries?: readonly Geometry[]; materials?: readonly OpenPBRMaterial[] }) {
    for (const mesh of update?.colors ?? []) this._dirtyColorMeshes.add(mesh);
    if (update && this._preparedMeshData && this._materialData &&
      !this._needsUpdateMeshData && meshes === this._meshes) {
      const change = this._materialChanges.classify(update.materials ?? []);
      if (change.level !== 'geometry' && canUpdateGeometries(this._preparedMeshData, update.geometries ?? [])) {
        if (update.materials?.length) {
          const pending = this._pendingMaterialUpdate;
          this._pendingMaterialUpdate = { level: pending?.level === 'textures' ? 'textures' : change.level,
            emission: !!pending?.emission || change.emission,
            emissiveMap: !!pending?.emissiveMap || change.emissiveMap,
            materials: new Set([...(pending?.materials ?? []), ...update.materials]) };
          this._meshSnapshot.forEach(item => { item.materialKeys = item.materials.map(getMaterialHashKey); });
        }
        for (const geometry of update.geometries ?? []) this._pendingGeometryUpdates.add(geometry);
        for (const item of this._meshSnapshot) if (this._pendingGeometryUpdates.has(item.geometry)) item.geometryVersion = item.geometry.version;
        for (const mesh of update.transforms ?? []) {
          const item = this._snapshotByMesh.get(mesh);
          if (!item) continue;
          for (let i = 0; i < 16; i++) item.matrix[i] = mesh.transform[i];
          this._dirtyTransformMeshes.add(mesh); this._needsRefitTLAS = true;
        }
        return !!update.materials?.length || !!update.transforms?.length || !!update.colors?.length || !!update.geometries?.length;
      }
    }
    const materialChange = !!update?.materials?.length;
    const next = meshes.map((mesh) => ({
      mesh,
      instanceCount: mesh instanceof InstancedMesh ? mesh.count : 1,
      instanceVersion: mesh instanceof InstancedMesh ? mesh.transformsVersion : 0,
      instanceTransforms: mesh instanceof InstancedMesh ? mesh.transforms : undefined,
      instanceColors: mesh instanceof InstancedMesh ? mesh.colors : undefined,
      colorVersion: mesh instanceof InstancedMesh ? mesh.colorsVersion : 0,
      geometry: mesh.geometry,
      materials: mesh.materials.slice(),
      materialKeys: mesh.materials.map(getMaterialHashKey),
      geometryVersion: mesh.geometry.version,
      positionArray: mesh.geometry.position.array, indexArray: mesh.geometry.indices.array,
      matrix: Array.from(mesh.transform as ArrayLike<number>)
    }));
    const membershipChanged = next.length !== this._meshSnapshot.length ||
      next.some((item, i) => item.mesh !== this._meshSnapshot[i]?.mesh || item.instanceCount !== this._meshSnapshot[i]?.instanceCount ||
        item.materials.some((material, k) => material !== this._meshSnapshot[i]?.materials[k]));
    const membership = !this._needsUpdateMeshData && membershipChanged && this._preparedMeshData
      ? this._membershipCache.update(this._preparedMeshData, meshes) : undefined;
    if (membership) {
      const versions = new Map(this._meshSnapshot.flatMap(item => item.materials.map((m, i) => [m, item.materialKeys[i]] as const)));
      const materialsChanged = membership.materials.length !== this._preparedMeshData!.materials.length ||
        membership.materials.some((m, i) => m !== this._preparedMeshData!.materials[i] ||
          versions.has(m) && getMaterialHashKey(m) !== versions.get(m));
      this._pendingMembershipData = membership;
      this._meshes = meshes;
      this._meshSnapshot = next;
      this._snapshotByMesh = new WeakMap();
      next.forEach(item => this._snapshotByMesh.set(item.mesh, item));
      this._needsUpdateMeshMembership = true;
      this._needsRefitTLAS = false;
      this._dirtyTransformMeshes.clear();
      if (materialsChanged) this._pendingMaterialUpdate = { level: 'textures', emission: true,
        emissiveMap: true, materials: new Set(membership.materials) };
      return true;
    }
    const changed =
      next.length !== this._meshSnapshot.length ||
      next.some((item, i) => {
        const prev = this._meshSnapshot[i];
        return (
          !prev ||
          item.mesh !== prev.mesh || item.instanceCount !== prev.instanceCount || item.instanceVersion !== prev.instanceVersion || item.instanceTransforms !== prev.instanceTransforms ||
          item.geometry !== prev.geometry || item.colorVersion !== prev.colorVersion || item.instanceColors !== prev.instanceColors ||
          item.materials.length !== prev.materials.length ||
          item.materials.some((material, k) => material !== prev.materials[k]) ||
          item.materialKeys.some((hash, k) => hash !== prev.materialKeys[k]) ||
          item.geometryVersion !== prev.geometryVersion ||
          item.matrix.some((value, k) => value !== prev.matrix[k])
        );
      });
    next.forEach((item, i) => {
      const prev = this._meshSnapshot[i];
      if (
        prev &&
        item.geometry === prev.geometry &&
         (item.geometryVersion !== prev.geometryVersion || item.positionArray !== prev.positionArray || item.indexArray !== prev.indexArray)
      ) {
        const usesDisplacement =
          !!item.materials[0]?.displacementMap &&
          Math.abs(item.materials[0].displacementScale) > 1e-6;
        if (
          usesDisplacement || geometryTopologyChanged(this._preparedMeshData, item.geometry) ||
          !getGeometryBvh(item.geometry) ||
          !refitBLAS(getGeometryBvh(item.geometry)!, item.geometry)
        ) {
          setGeometryBvh(item.geometry, undefined);
        }
      }
    });
    this._meshSnapshot = next;
    this._snapshotByMesh = new WeakMap();
    next.forEach(item => this._snapshotByMesh.set(item.mesh, item));
    if (!changed && update && !materialChange) return false;
    this._meshes = meshes;
    this._needsUpdateMeshData = true;
    this._needsRefitTLAS = false; this._dirtyTransformMeshes.clear();
    this._debugBvhData = undefined;
    return true;
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

  getDebugBVHData() {
    if (!this._debugBvhData) {
      const mergedMesh = mergeMeshesToGeometry(this._meshes);
      const bvh = buildBLAS(mergedMesh.geometry);
      this._debugBvhData = { buffer: bvh.buffer };
    }
    return this._debugBvhData;
  }

  /** @internal */
  _loadDiagnosticAccumulation(inputs: Record<string, WebGLTexture2D>, catcher: boolean) {
    this._mainPass.loadDiagnosticOutputs({color: inputs.color, albedo: inputs.albedo, normal: inputs.normal, moments: inputs.moments});
    this._shadowCatcherPass.loadDiagnosticOutputs({shadowCatcher: inputs.shadowCatcher, catcherBackground: inputs.catcherBackground, catcherMoments: inputs.catcherMoments});
    this._hasShadowCatcher = catcher;
  }

  getDiagnostics() {
    return { textureAtlas: this._materialData?.textureAtlasStats };
  }

  private _updateMeshData() {
    this._pendingGeometryUpdates.clear();
    this._needsUpdateMeshData = false;

    // GLSL intersects the original triangles, so its BVH must bound those
    // triangles rather than WebGPU's displaced height prisms.
    const res = updateMeshInstances(this._meshes, { displacement: false });
    this._preparedMeshData = res;
    this._membershipCache.capture(res);
    this._pendingMembershipData = undefined;
    this._needsUpdateMeshMembership = false;
    const mergedGeometry = res.geometry;
    const materials = res.materials;
    const tlas = buildTLAS(res.instances, res.blases);
    this._tlas = tlas;
    const tlasBuffer = new Float32Array(tlas.buffer);
    const instancesBuffer = this._instancesData = new Float32Array(tlas.instancesBuffer!);
    const blasBuffer = new Float32Array(concatBLASBuffers(res.blases));
    const bvhBuffer = this._bvhData = new Float32Array(tlasBuffer.length + blasBuffer.length);
    const blasOffset = tlasBuffer.length / 4;
    bvhBuffer.set(tlasBuffer);
    bvhBuffer.set(blasBuffer, blasOffset * 4);

    if (mergedGeometry.position.array.length > 0) {
      setDataTexture(this._positionBufferTex, mergedGeometry.position.array, 3);
      setDataTexture(this._normalBufferTex, mergedGeometry.normal.array, 3);
      mergedGeometry.color &&
        setDataTexture(this._colorBufferTex, mergedGeometry.color.array, 3);
      mergedGeometry.tangent &&
        setDataTexture(this._tangentBufferTex, mergedGeometry.tangent.array, 4);
      mergedGeometry.uv &&
        setDataTexture(this._uvBufferTex, mergedGeometry.uv.array, 2);
      mergedGeometry.uv1 &&
        setDataTexture(this._uv1BufferTex, mergedGeometry.uv1.array, 2);
      mergedGeometry.materialIndex &&
        setDataTexture(
          this._matIndexBufferTex,
          // TODO currently int texture doesn't work
          this._materialIndexData = new Float32Array(mergedGeometry.materialIndex.array),
          4
        );
    }
    if (bvhBuffer.length > 0) {
      setDataTexture(this._bvhBufferTex, bvhBuffer, 4);
      setDataTexture(this._instancesBufferTex, instancesBuffer, 4);
    }

    this._materialData?.dispose(this._renderer.gl);
    const materialData = new MaterialTable(
      materials,
      this._analyticLights,
      {
        maxTextureArrayBytes: this._maxTextureArrayBytes,
        maxTextureArrayLayers: this._renderer.gl.getParameter(
          this._renderer.gl.MAX_ARRAY_TEXTURE_LAYERS
        ),
        maxTextureDimension2D: this._renderer.gl.getParameter(
          this._renderer.gl.MAX_TEXTURE_SIZE
        )
      }
    );
    this._materialData = materialData;

    this._tracePasses.forEach((pass) => {
      pass.setUniforms({
        bvhBuffer: this._bvhBufferTex,
        instancesBuffer: this._instancesBufferTex,
        positionBuffer: this._positionBufferTex,
        normalBuffer: this._normalBufferTex,
        tangentBuffer: mergedGeometry.tangent ? this._tangentBufferTex : null,
        colorBuffer: mergedGeometry.color ? this._colorBufferTex : null,
        uvBuffer: mergedGeometry.uv ? this._uvBufferTex : null,
        uv1Buffer: mergedGeometry.uv1 ? this._uv1BufferTex : null,
        materialIndexBuffer: this._matIndexBufferTex,

        bvhColumns: textureDimensionsFromArray(bvhBuffer.length / 4).columnsLog,
        vertexColumns: textureDimensionsFromArray(
          Attribute.getCount(mergedGeometry.position)
        ).columnsLog,
        instancesColumns: textureDimensionsFromArray(instancesBuffer.length / 4)
          .columnsLog,
        blasOffset,

        isEmptyScene: +(res.instances.length === 0)
      });

    });
    this._updateMaterialConstants(materials, materialData, mergedGeometry);
    this._materialChanges.capture(materials);
    this._pendingMaterialUpdate = undefined;

    return bvhBuffer;
  }

  private _updateMaterialConstants(materials: OpenPBRMaterial[], materialData: MaterialTable, mergedGeometry: Geometry) {
    // Avoid too much shader compilation
    const STACK_SIZE = 50;
    const hasShadowCatcher = materials.some((m) => m.shadowCatcher);
    const HAS_BEVEL = materials.some((m) => m.bevelSize > 0);
    const HAS_MEDIUM = materials.some(materialUsesMedium);

    this._hasShadowCatcher = hasShadowCatcher;
    this._hasTransmission = materials.some(
      (m) =>
        m.transmissionWeight > 0 ||
        m.mapAlphaUsage === "transmission"
    );
    this._hasAlpha = materials.some(
      (m) => resolveMaterialAlphaMode(m) !== 'opaque'
    );
    this._spectral = materials.some((m) => m.transmissionDispersionScale > 0);


    this._tracePasses.forEach(pass => {
      pass.setDefines({
        OES_texture_float_linear: true,

        STACK_SIZE,
        USE_VERTEX_COLOR: mergedGeometry.color != null,
        USE_TANGENT: mergedGeometry.tangent != null,
        USE_COAT_NORMAL_FRAMES: materials.some(m => m.coatWeight > 0 && (!!m.normalMap || !!m.coatNormalMap)),
        HAS_TRANSMISSION: this._hasTransmission,
        HAS_GLTF_ANISOTROPY: materials.some(m => m.specularAnisotropyModel === 'gltf' && m.specularAnisotropy > 0),
        HAS_BEVEL,
        HAS_MEDIUM,
        HAS_ALPHA: this._hasAlpha,

        BEVEL_SAMPLES: this._bevelSamples,

        RECT_LIGHT: CONSTANT_RECT_LIGHT,
        SPHERE_LIGHT: CONSTANT_SPHERE_LIGHT,
        DIRECTIONAL_LIGHT: CONSTANT_DIRECTIONAL_LIGHT,

        USE_RR: true,
        // Multiple-scattering SSS paths need enough collisions to return to
        // the boundary before roulette; terminating at depth five produces
        // dark materials and a handful of very large surviving samples.
        RR_MAX: HAS_MEDIUM ? 12 : 2,

        ...materialData.defines
      });

      materialData.setToPass(pass);
    });
  }

  private _updateMeshMembership() {
    const res = this._pendingMembershipData!;
    this._preparedMeshData = res;
    const tlas = this._tlas = buildTLAS(res.instances, res.blases);
    const blas = new Float32Array(concatBLASBuffers(res.blases));
    const data = this._bvhData = new Float32Array(tlas.buffer.byteLength / 4 + blas.length);
    data.set(new Float32Array(tlas.buffer));
    data.set(blas, tlas.buffer.byteLength / 4);
    this._instancesData = new Float32Array(tlas.instancesBuffer!);
    setDataTexture(this._bvhBufferTex, data, 4);
    setDataTexture(this._instancesBufferTex, this._instancesData, 4);
    this._tracePasses.forEach(pass => pass.setUniforms({
      bvhColumns: textureDimensionsFromArray(data.length / 4).columnsLog,
      instancesColumns: textureDimensionsFromArray(this._instancesData!.length / 4).columnsLog,
      blasOffset: tlas.buffer.byteLength / 16,
      isEmptyScene: +(res.instances.length === 0)
    }));
    this._pendingMembershipData = undefined;
    this._needsUpdateMeshMembership = false;
    this._debugBvhData = undefined;
  }

  private _updateGeometryData() {
    const res = this._preparedMeshData!, tlas = this._tlas!;
    const update = updatePreparedGeometries(res, this._pendingGeometryUpdates);
    for (const { first, count, topologyChanged, deformationOnly } of update.vertices) {
      for (const [attribute, texture] of [
        [res.geometry.position, this._positionBufferTex], [res.geometry.normal, this._normalBufferTex],
        [res.geometry.tangent, this._tangentBufferTex], [res.geometry.color, this._colorBufferTex],
        [res.geometry.uv, this._uvBufferTex], [res.geometry.uv1, this._uv1BufferTex]
      ] as const) if (attribute && (!deformationOnly || attribute === res.geometry.position || attribute === res.geometry.normal || attribute === res.geometry.tangent)) texture.updateDataRange(this._renderer.gl, attribute.array,
        first * attribute.itemSize * 4, count * attribute.itemSize * 4);
      if (!topologyChanged) continue;
      const material = this._materialIndexData!;
      for (let i = first * 4; i < (first + count) * 4; i++) material[i] = res.geometry.materialIndex!.array[i];
      this._matIndexBufferTex.updateDataRange(this._renderer.gl, material, first * 16, count * 16);
    }
    for (const mesh of update.meshes) this._dirtyTransformMeshes.add(mesh);
    if (update.relocated) for (const binding of res.instanceBindings) this._dirtyTransformMeshes.add(binding.mesh);
    if (update.resized) {
      res.instances = updateMeshInstanceTransforms(res.instanceBindings);
      refitTLAS(tlas, res.instances, res.blases);
      const blas = new Float32Array(concatBLASBuffers(res.blases));
      this._bvhData = new Float32Array(tlas.buffer.byteLength / 4 + blas.length);
      this._bvhData.set(new Float32Array(tlas.buffer)); this._bvhData.set(blas, tlas.buffer.byteLength / 4);
      setDataTexture(this._bvhBufferTex, this._bvhData, 4);
      this._tracePasses.forEach(pass => pass.setUniform('bvhColumns', textureDimensionsFromArray(this._bvhData!.length / 4).columnsLog));
    } else {
      const ranges = [];
      for (const { blas, offset } of update.blases) {
        const target = tlas.buffer.byteLength + offset;
        new Uint8Array(this._bvhData!.buffer).set(new Uint8Array(blas.buffer), target);
        ranges.push({offset: target, size: blas.buffer.byteLength});
      }
      for (const { offset, size } of mergeRefitRanges(ranges)) this._bvhBufferTex.updateDataRange(this._renderer.gl, this._bvhData!, offset, size);
    }
    this._needsRefitTLAS = true; this._pendingGeometryUpdates.clear(); this._debugBvhData = undefined;
  }

  private _updateMeshColors() {
    const res = this._preparedMeshData, tlas = this._tlas;
    if (res && tlas) {
      const dirty = updateMeshInstanceColors(res.instanceBindings, res.instances, this._dirtyColorMeshes);
      const ranges = updateTLASInstanceColors(tlas, res.instances, dirty);
      for (const {offset, size} of ranges) this._instancesBufferTex.updateDataRange(this._renderer.gl, this._instancesData!, offset, size);
    }
    this._dirtyColorMeshes.clear();
  }

  private _refitMeshInstances() {
    const res = this._preparedMeshData!, tlas = this._tlas!;
    const dirty = dirtyMeshInstanceIndices(res.instanceBindings, this._dirtyTransformMeshes, res.instances);
    const previousInstances = res.instances;
    res.instances = updateMeshInstanceTransforms(res.instanceBindings, res.instances, dirty);
    if (!sameInstanceMembership(previousInstances, res.instances)) {
      this._pendingMembershipData = res;
      this._updateMeshMembership();
      this._dirtyTransformMeshes.clear(); this._needsRefitTLAS = false;
      return;
    }
    const ranges = refitTLAS(tlas, res.instances, res.blases, dirty);
    this._bvhData!.set(new Float32Array(tlas.buffer));
    for (const { offset, size } of ranges.tlasRanges) this._bvhBufferTex.updateDataRange(this._renderer.gl, this._bvhData!, offset, size);
    for (const { offset, size } of ranges.instanceRanges) this._instancesBufferTex.updateDataRange(this._renderer.gl, this._instancesData!, offset, size);
    this._dirtyTransformMeshes.clear(); this._needsRefitTLAS = false;
    this._debugBvhData = undefined;
  }

  private _updateMaterialData() {
    const update = this._pendingMaterialUpdate!;
    const res = this._preparedMeshData!;
    let data = this._materialData!;
    if (update.level === 'textures') {
      data.dispose(this._renderer.gl);
      data = this._materialData = new MaterialTable(res.materials, this._analyticLights, {
        maxTextureArrayBytes: this._maxTextureArrayBytes,
        maxTextureArrayLayers: this._renderer.gl.getParameter(this._renderer.gl.MAX_ARRAY_TEXTURE_LAYERS),
        maxTextureDimension2D: this._renderer.gl.getParameter(this._renderer.gl.MAX_TEXTURE_SIZE)
      });
      this._needsUpdateAnalyticLightsBuffer = true;
    } else data.repackParams(res.materials);
    this._updateMaterialConstants(res.materials, data, res.geometry);
    if (update.emission || update.emissiveMap) {
      // WebGL currently evaluates mesh emission on path hits; its direct-light
      // sampler has only analytic/environment sources. Retain that behavior.
      res.emissiveBindings = res.instanceBindings.filter(binding =>
        binding.materialIndices.some(index => materialIsEmissive(res.materials[index])));
    }
    this._materialChanges.capture([...update.materials]);
    this._pendingMaterialUpdate = undefined;
  }

  setLights(lights: SceneLight[]) {
    const analyticLights = lights.filter(
      (light) =>
        light.type === 'DirectionalLight' ||
        light.type === 'SphereLight' ||
        light.type === 'SpotLight' ||
        light.type === 'RectLight'
    ) as AnalyticLight[];
    const numAnalyticLights = analyticLights.length;

    const envImage = this._skySource.resolve(this._sceneEnvironment.update(lights));
    const rotation = environmentRotation(lights);
    const rotation3 = [rotation[0], rotation[1], rotation[2], rotation[4], rotation[5], rotation[6], rotation[8], rotation[9], rotation[10]];
    this._tracePasses.forEach(pass => pass.setUniform('environmentRotation', rotation3));

    const envWeight = estimateEnvironmentPower(envImage);
    const analyticWeights = analyticLights.map(estimateAnalyticLightPower);
    const totalWeight =
      envWeight + analyticWeights.reduce((sum, weight) => sum + weight, 0);
    const sourceCount = analyticLights.length + (envImage ? 1 : 0);
    const fallbackPmf = sourceCount > 0 ? 1 / sourceCount : 0;
    this._envLightSelectionPmf = envImage
      ? totalWeight > 0
        ? (1 - POWER_WEIGHTED_LIGHT_MIX) * fallbackPmf +
          POWER_WEIGHTED_LIGHT_MIX * (envWeight / totalWeight)
        : fallbackPmf
      : 0;
    this._analyticLightSelectionPmfs = Float32Array.from(
      analyticWeights,
      (weight) =>
        totalWeight > 0
          ? (1 - POWER_WEIGHTED_LIGHT_MIX) * fallbackPmf +
            POWER_WEIGHTED_LIGHT_MIX * (weight / totalWeight)
          : fallbackPmf
    );
    this._directLightLegacy={env:this._envLightSelectionPmf,pmfs:this._analyticLightSelectionPmfs};
    let cumulativePmf = this._envLightSelectionPmf;
    this._analyticLightSelectionCdfs = Float32Array.from(
      this._analyticLightSelectionPmfs,
      (pmf) => {
        cumulativePmf += pmf;
        return cumulativePmf;
      }
    );
    if (this._analyticLightSelectionCdfs.length > 0) {
      this._analyticLightSelectionCdfs[
        this._analyticLightSelectionCdfs.length - 1
      ] = 1;
    }

    this._tracePasses.forEach((pass) => {
      pass.setDefines({
        NUM_LIGHTS: numAnalyticLights,
        HAS_SPHERE_LIGHTS: !!analyticLights.find(
          (light) => light.type === 'SphereLight'
        ),
        HAS_SPOT_LIGHTS: !!analyticLights.find(
          (light) => light.type === 'SpotLight'
        ),
        HAS_RECT_LIGHTS: !!analyticLights.find(
          (light) => light.type === 'RectLight'
        ),
        HAS_DIRECTIONAL_LIGHTS: !!analyticLights.find(
          (light) => light.type === 'DirectionalLight'
        )
      });
    });

    const lightTexturesChanged = this._rectLightTextures.update(analyticLights);
    this._analyticLights = analyticLights;
    const packedIES = packIESProfiles(analyticLights);
    this._iesProfileTexelOffsets = packedIES.offsets;
    this._iesProfileColumns = setDataTexture(
      this._iesProfileTex,
      packedIES.data.length ? packedIES.data : new Float32Array(4),
      4
    ).columns;
    if (lightTexturesChanged) this._needsUpdateMeshData = true;

    this._needsUpdateAnalyticLightsBuffer = true;

    this._setEnvMap(envImage);
  }

  private _getViewProjInv(camera: Camera, viewProjInv: mat4.Mat4Array) {
    mat4.invert(viewProjInv, camera.getProjectionMatrix(this._depthAspect));
    mat4.mul(viewProjInv, camera.transform, viewProjInv);
  }

  setCamera(camera: Camera) {
    const viewProjectionInv = this._viewProjInv;
    this._apertureRadius = cameraApertureRadius(camera);
    this._focusDistance = camera.focusDistance;
    this._getViewProjInv(camera, viewProjectionInv);
    this._tracePasses.forEach((pass) => {
      pass.setUniform('viewProjectionInv', viewProjectionInv);
      pass.setUniform('viewInv', camera.transform);
      // Zero for orthographic cameras, which have no depth of field.
      pass.setUniform('cameraApertureRadius', this._apertureRadius);
      pass.setUniform('cameraFocusDistance', camera.focusDistance);
    });
  }

  cameraChanged(camera: Camera) {
    const tmp = mat4.create();
    this._getViewProjInv(camera, tmp);
    return (
      !numberArraysEqual(this._viewProjInv, tmp) ||
      cameraApertureRadius(camera) !== this._apertureRadius ||
      camera.focusDistance !== this._focusDistance
    );
  }

  setSize(width: number, height: number, targetAspect = width / height) {
    this._depthAspect = targetAspect;
    this._tracePasses.forEach((pass) => {
      pass.setSize(pass === this._depthPass ? DEPTH_SAMPLE_GRID : width,
        pass === this._depthPass ? DEPTH_SAMPLE_GRID : height);
      pass.setUniform('pixelSize', [1 / width, 1 / height]);
    });
  }

  setJitter(x: number, y: number) {
    this._tracePasses.forEach((pass) => {
      pass.setUniform('jitter', [x, y]);
    });
  }

  releaseTarget(target: object) { this._mainPass.releaseTarget(target); this._shadowCatcherPass.releaseTarget(target); }

  getTargetMemoryBytes(target: object) {
    return this._mainPass.getMemoryBytes(target) + this._shadowCatcherPass.getMemoryBytes(target);
  }

  useTarget(target: object) {
    this._mainPass.useTarget(target);
    this._shadowCatcherPass.useTarget(target);
  }

  setQuality(options: { bounces: number; bevel: boolean; dispersionWavelengths: 1 | 3; directLightCandidates: number; caustics?: import('../Render.js').CausticSettings }) {
    researchTransport()?.configure(this, 'webgl');
    this._tracePasses.forEach(pass => {
      pass.setUniform('bounceLimit', normalizeBounces(options.bounces));
      pass.setUniform('bevelEnabled', options.bevel);
      pass.setUniform('dispersionWavelengths', options.dispersionWavelengths);
    });
  }

  setSpectralChannel(channel: number) {
    this._tracePasses.forEach((pass) => {
      pass.setUniform('spectralChannel', channel);
    });
  }

  setSampleCount(sampleCount: number) {
    this._tracePasses.forEach((pass) => {
      pass.setUniform('sampleCount', sampleCount);
    });
  }

  isInvalid() {
    return this._invalid;
  }

  hasShadowCatcher() {
    return this._hasShadowCatcher;
  }

  hasDispersion() {
    return this._spectral;
  }

  prepare(): void {
    if (this._needsUpdateMeshData) {
      this._updateMeshData();
    } else if (this._needsUpdateMeshMembership) {
      this._updateMeshMembership();
    }
    if (this._pendingGeometryUpdates.size) this._updateGeometryData();
    if (this._needsRefitTLAS) this._refitMeshInstances();
    if (this._dirtyColorMeshes.size) this._updateMeshColors();

    if (this._pendingMaterialUpdate) this._updateMaterialData();

    researchTransport()?.prepare(this, 'webgl');

    const res=this._preparedMeshData;
    if(res) {
      const triangles=this._emissiveCache.collect(res.emissiveBindings,res.materials);
      this._mainPass.setDefines({HAS_EMISSIVE_LIGHTS:triangles.length>0});
      if(!triangles.length&&this._emissiveActive&&this._directLightLegacy) {
        this._envLightSelectionPmf=this._directLightLegacy.env;
        this._analyticLightSelectionPmfs=Float32Array.from(this._directLightLegacy.pmfs);
        this._tracePasses.forEach(pass=>pass.setUniform('envLightSelectionPmf',this._envLightSelectionPmf));
        this._needsUpdateAnalyticLightsBuffer=true;
      }
      this._emissiveActive=triangles.length>0;
      if(triangles.length) {
        const lighting=prepareWebGLLightSampling(this._analyticLights,triangles,estimateEnvironmentPower(this._envImageSource));
        this._envLightSelectionPmf=lighting.environmentPmf;
        this._analyticLightSelectionPmfs=Float32Array.from(lighting.analyticPmfs);
        const columns=setDataTexture(this._emissiveTex,lighting.data,4).columnsLog;
        this._mainPass.setUniforms({emissiveLightData:this._emissiveTex,emissiveLightColumns:columns,
          emissiveChoiceOffset:lighting.emissiveTexels,emissiveChoiceCount:lighting.choiceCount,
          emissivePmfOffset:lighting.pmfOffset,emissiveWeightTotal:lighting.totalWeight,envLightSelectionPmf:lighting.environmentPmf});
        this._needsUpdateAnalyticLightsBuffer=true;
      }
    }

    if (this._needsUpdateAnalyticLightsBuffer) {
      const analyticLights = this._analyticLights;
      analyticLights.length > 0 &&
        packLightsToTexture(
          this._lightTex,
          analyticLights,
          this._materialData!.getLightTexturesIndices(),
          this._analyticLightSelectionPmfs,
          this._analyticLightSelectionCdfs,
          this._iesProfileTexelOffsets
        );
      this._needsUpdateAnalyticLightsBuffer = false;
    }

    this._tracePasses.forEach((pass) => {
      pass.setUniform(
        'backgroundMap',
        this._hasBackground
          ? this._backgroundTex
          : this._hasEnvMap
            ? this._envMap
            : null
      );

      pass.setUniform(
        'transmissiveOutputAlphaMin',
        Math.max(Math.min(1, this._transmissiveAlphaMin), 0)
      );

      pass.setUniform('lightsTex', this._lightTex);
      pass.setUniform('iesProfileData', this._iesProfileTex);
      pass.setUniform('iesProfileColumns', this._iesProfileColumns);
      pass.setUniform('groundedBackgroundParams', this._groundedBackgroundParams);
      pass.setUniform('groundedBackgroundCenter', this._groundedBackgroundCenter);
      pass.setUniform('backgroundMapTransform', this._backgroundMapTransform);
      pass.setUniform('backgroundMapRotation', this._backgroundMapRotation);

      pass.setDefines({
        // Double bounce fix on intel mac
        // Limit the bounce to avoid long compilation time.
        BOUNCES: isIntelMac()
          ? Math.min(this._bounces, 3) *
            (this._hasTransmission || this._hasAlpha ? 2 : 1)
          : this._bounces,
        CLAMPING: this._clamping || undefined,
        BEVEL_SAMPLES: this._bevelSamples,
        USE_BACKGROUND: this._hasBackground,
        USE_GROUNDED_BACKGROUND: this._groundedBackgroundParams[3] > 0
      });
    });
  }

  setSamplingPattern(pattern: SamplingPattern, maxSamples: number, sequenceSeed = 0) {
    const code = samplingPatternCode(pattern);
    const logSPP = zSobolLog2SPP(code === 1 ? maxSamples - 1 : maxSamples);
    const changed = this._samplingCode !== code || this._sequenceSeed !== (sequenceSeed >>> 0) ||
      (code === 1 && this._zLogSPP !== logSPP);
    this._samplingCode = code;
    this._sequenceSeed = sequenceSeed >>> 0;
    this._zLogSPP = logSPP;
    this._tracePasses.forEach(pass => {
      pass.setUniform('samplingPattern', code);
      pass.setUniform('sequenceSeed', this._sequenceSeed);
      pass.setUniform('zSobolLogSPP', logSPP);
    });
    return changed;
  }

  // WebGL has uniform per-pixel counts; setSampleCount already includes offset.
  setSampleSequenceOffset(_offset: number) {}

  prepareAovs(state: WebGLAov, camera: Camera, width: number, height: number, kinds: readonly AovKind[]) {
    if (!kinds.length) return true;
    // An AOV channel may be the first thing to render a new scene.
    this.prepare();
    if (!this._preparedMeshData || !this._tlas) return true;
    const gl = this._renderer.gl;
    if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('AOV requires EXT_color_buffer_float');
    state.resize(width,height);
    this._aovPass.setDefines({AOV_REFLECTANCE: (aovMask(kinds) & 24) !== 0});
    if (!state.frame) { const packed=packAovScene(this._preparedMeshData,this._tlas,camera,width,height,state.history,this._aovPrimitiveCache.get(this._preparedMeshData,this._tlas)); state.frame=packed.frame; state.setScene(packed.words); }
    this._aovCenter.setUniform('aovScene',state.scene); this._aovCenter.setUniform('previousId',state.previousCenter!.id);this._aovCenter.setUniform('previousMotion',state.previousCenter!.motion); this._aovPass.setUniform('aovScene',state.scene);
    this._aovCenter.setSize(width,height); this._aovPass.setSize(width,height);
    const previous=state.accumulation[(state.samples+1)%2];
    const center=this._aovCenter.isProgramReady();
    const accumulation=this._aovPass.isProgramReady({previousGeometry:previous.geometry,previousPosition:previous.position,previousDiffuse:previous.diffuse,previousSpecular:previous.specular});
    return center && accumulation;
  }

  renderAovs(state: WebGLAov, camera: Camera, width: number, height: number, samples: number, cap: number, kinds: readonly AovKind[], sequenceOffset = 0) {
    if (!this.prepareAovs(state,camera,width,height,kinds)) return false;
    if (!kinds.length || !this._preparedMeshData || !this._tlas) return true;
    if (!state.centerReady) {this._aovCenter.createPass({},state.center);state.centerReady=true;state.history.accept(state.frame!);}
    const target=Math.min(samples,cap);
    if ((aovMask(kinds) & 31) === 0) state.samples = target;
    while(state.samples<target){
      const output=state.accumulation[state.samples%2], previous=state.accumulation[(state.samples+1)%2];
      this._aovPass.setUniform('aovMask',aovMask(kinds));
      this._aovPass.setUniform('aovSample',state.samples);
      this._aovPass.setUniform('sampleCount',state.samples+sequenceOffset);
      this._aovPass.createPass({previousGeometry:previous.geometry,previousPosition:previous.position,previousDiffuse:previous.diffuse,previousSpecular:previous.specular},output);
      state.samples++;
    }
    return true;
  }

  async readDepthSamples(area: DepthSampleArea, aspect?: number): Promise<Float32Array | undefined> {
    if (this._depthAbort.signal.aborted || this._invalid || !this._preparedMeshData ||
      !this._renderer.isAllProgramCompiled()) return;
    this.prepare();
    this._depthPass.setUniform('depthArea', packDepthSampleArea(area, aspect ?? this._depthAspect));
    this._depthPass.createPass({});
    const rgba = await readFloatPixelsAsync(this._renderer.gl,
      DEPTH_SAMPLE_GRID, DEPTH_SAMPLE_GRID, this._depthAbort.signal);
    return unpackDepthSamples(rgba);
  }

  dispose() {
    researchTransport()?.dispose(this, 'webgl');
    this._skySource.dispose();
    this._depthAbort.abort();
    this._materialData?.dispose(this._renderer.gl);
    this._materialData = undefined;
    this._tracePasses.forEach((pass) => pass.dispose());
    const gl = this._renderer.gl;
    [
      this._lightTex,
      this._emissiveTex,
      this._openPbrEnergyLut,
      this._envMap,
      this._envMapDistribution,
      this._backgroundTex,
      this._positionBufferTex,
      this._normalBufferTex,
      this._colorBufferTex,
      this._tangentBufferTex,
      this._uvBufferTex,
      this._uv1BufferTex,
      this._bvhBufferTex,
      this._instancesBufferTex,
      this._matIndexBufferTex
    ].forEach((texture) => texture.dispose(gl));
  }
}

export default WebGLRayTracePass;
