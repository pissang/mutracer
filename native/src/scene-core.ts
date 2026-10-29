import {hasStochasticCausticCaster} from '../../src/renderer/caustics.js';
import {nativeCausticTarget} from './caustics.js';
import {packAovScene} from '../../src/renderer/aovScene.js';
import {AovPrimitiveCache} from '../../src/renderer/AovPrimitiveCache.js';
import {AovHistory} from '../../src/renderer/aov.js';
import {decodeCamera} from './camera-core.js';
/// <reference lib="esnext" />
/// <reference path="./browser-types.d.ts" />
import {sceneErrorPacket} from './scene-errors.js';
import {takeGeometryKernelHints, releaseGeometryKernelHints, geometryKernelBounds, encodeGeometryKernelHints, type GeometryKernelHint} from './geometry-kernel-hints.js';
import {matrixStorage} from '../../src/math/storage.js';
import {initialSceneConstants, sceneAttributeLayout, sceneTraversalConstants, prepareSceneLightSampling, writeTraceLighting, packSceneAnalyticLights, writeTraceQuality, writeTraceSampling} from '../../src/renderer/sceneAssembly.js';
import {defaultSceneConfiguration, decodeSceneConfiguration} from './scene-configuration.js';
import {nativeShaderVariant} from './shader-variants.js';
import {displacementBaseGeometry, displacementPrismAabbs} from '../../src/renderer/displacementPreparation.js';
import type {GeometryUpdateState} from '../../src/renderer/geometryUpdateState.js';
import {vec3} from '../../src/math.js';
import {markDeformedGeometry} from '../../src/scene/geometryChanges.js';
import {sameInstanceMembership} from '../../src/renderer/packedMeshInstances.js';
import {hardwareOpaqueGeometryFlags} from './hwrt-eligibility.js';
import {ERROR_CODE, VERSION, RESOURCE, KIND, FORMAT, HEADER as H, GEOMETRY as G, MESH as M, MATERIAL as MAT, TEXTURE as T, LIGHT as L, CAMERA as C, BATCH as B, SETTINGS as S, PACKET_HEADER as PH, PACKET_ENTRY as PE, WRITE_ENTRY as WE, WORD_BYTES, quantizeDisplacementRange} from './layout.js';
import {nativePathIntersections} from './path-diagnostics.wgsl.js';
import {nativeFrameInputHooks} from './frame-inputs.wgsl.js';
import type IESProfile from '../../src/scene/IESProfile.js';
import {computeDisplacementMinmax, computeTrianglesDisplacementRange} from '../../src/renderer/displacementPreparation.js';
import {releaseNativeScene} from './scene-sync.js';
import {decodeTexture, decodeMaterial, decodeGeometry, decodeMeshMaterials, decodeInstances, decodeLight, lightFromRecord} from './scene-records.js';
import { envMapDistribution } from '../../src/renderer/envMapDistribution.js';
import Geometry, { Attribute } from '../../src/scene/Geometry.js';
import {computeGeometryBounds} from '../../src/renderer/geometryBvhBounds.js';
import {copyTLASForRefit, refitLinearInstances, refitTLAS, packLinearInstances} from '../../src/renderer/bvhAccel.js';
import {attributeValue, attributeLength} from '../../src/scene/attributeData.js';
import MeshState from '../../src/scene/MeshState.js';
import MaterialState from '../../src/scene/MaterialState.js';
import PixelTexture from '../../src/scene/PixelTexture.js';
import type TextureState from '../../src/scene/TextureState.js';
import { sceneCameraParameters } from './camera-core.js';
import { InstanceState,
  EmissiveTriangleCache, estimateEnvironmentPower } from '../../src/renderer/lightCore.js';
export * from '../../src/renderer/lightCore.js';
import type { EmissiveTriangle } from '../../src/renderer/lightSampling.js';
import type { AnalyticLightState } from '../../src/scene/lightState.js';
import { meshInstancesLength, type MeshInstances } from '../../src/renderer/packedMeshInstances.js';
import { prepareSceneMeshes, computeGeometryNormals, dirtyPreparedInstanceIndices, updateMeshInstanceTransforms, type PreparedMeshInstanceBinding } from '../../src/renderer/scenePreparation.js';
import type { BLASInstance, FlattendBVH } from '../../src/renderer/bvhAccel.js';
import { buildBLAS, buildTLAS, concatBLASBuffers, getTraversalStackSizes, meshInstanceBounds, packBuiltTLAS } from '../../src/renderer/bvhAccel.js';
import { getGeometryBvh, setGeometryBvh } from '../../src/renderer/geometryBvh.js';
import { generateVertexTangents, hasGeneratedVertexTangents, updateDynamicTangents } from '../../src/util/geometry.js';
import { packVertexAttributes, canUpdateGeometries, updatePreparedGeometries } from '../../src/renderer/geometryUpdates.js';
import MaterialData from '../../src/renderer/MaterialData.js';
import { materialUsesMedium } from '../../src/renderer/materialParams.js';
import { writeRawAtlasPlacement } from '../../src/renderer/textureAtlasPixels.js';
import { wgpuMaterialConstants } from '../../src/renderer/wgpuMaterialConstants.js';
import { ALL_MATERIAL_SHADER_CAPABILITIES, ALL_LIGHT_SHADER_CAPABILITIES, updateSceneShaderCapabilities } from '../../src/renderer/shaderCapabilities.js';
import { wgpuSceneFeatureFlags } from '../../src/renderer/WGPUSceneFeatures.js';
import { nativeIntersections, nativeHitDiagnostics } from './intersections.wgsl.js';
import { wgpuShaderSource } from '../../src/renderer/wgpuShaderSource.js';
import { makeRayTraceUniform, WGPU_SCENE_BUFFER_MIN_BYTES } from '../../src/renderer/wgpuSceneUniform.js';
import { getOpenPbrEnergyLutData, OPENPBR_ENERGY_LUT_WIDTH, OPENPBR_ENERGY_LUT_HEIGHT } from '../../src/renderer/openPbrEnergyLut.js';

interface NativeLayout {
  hasAlpha: boolean; attributeStrideBytes: number; positionOffsetBytes: number;
  blasOffset: number; isEmpty: boolean; bevel: boolean; hasDisplacement: boolean;
  indexed?: boolean; hardwareGeometries?: HardwareGeometry[];
}
function nativeLayoutBytes(layout: NativeLayout, blasOffset: number, isEmpty: boolean): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({...layout, blasOffset, isEmpty}));
}

// Root source meshes and prepared bindings/BLASes for transform updates. The
// merged vertex allocation is not retained; geometry edits have a separate gate.
// A full context commit owns the token; raw/replay probes remain stateless.
const sceneConfigurations = new Map<number, ReturnType<typeof defaultSceneConfiguration>>();
export function configureSceneParameters(bytes: Uint8Array, token: number): Uint8Array {
  try {
    sceneConfigurations.set(token, decodeSceneConfiguration(bytes));
    return new Uint8Array(new Uint32Array([1, 0, 0, 0]).buffer);
  } catch (error) { return sceneErrorPacket(ERROR_CODE.CONFIGURE, error);}
}
const retainedScenes = new Map<number, {source: MaterialState[]; ordered: MaterialState[]; table: MaterialData;
  lights: AnalyticLightState[]; emissive: EmissiveTriangle[]; rt: ArrayBuffer;
  environmentWidth: number; environmentHeight: number; backgroundWidth: number; backgroundHeight: number;
  qualityFlags: number; environmentPower: number; meshes: MeshState[];
  textureIds: Map<TextureState, number>; nativeLayout: NativeLayout; hardware?: HardwareScene; prepared: PreparedScene; instances: MeshInstances; tlas: FlattendBVH; emissiveCache: EmissiveTriangleCache;
  bindings: PreparedMeshInstanceBinding[]; blases: BLASInstance[]; tlasStack: number; blasStack: number; geometries: Geometry[];
  shader: SceneShader}>();
/** Inputs of the production shader, retained so targets can request pattern/bevel-sample variants. */
interface SceneShader {
  constants: Record<string, boolean | number>; features: Parameters<typeof wgpuShaderSource>[1];
  variantFlags: number; isEmpty: boolean; hardware: boolean; opaqueClosest: boolean;
}
/** Trace-uniform fields owned by one target: size, sampling and per-render quality. */
function writeTargetTrace(views: ReturnType<typeof makeRayTraceUniform>['views'],
  configuration: ReturnType<typeof defaultSceneConfiguration>, width: number, height: number, qualityFlags: number) {
  views.outputSize.set([width, height]); views.scaleOffset.set([1, 1, 0, 0]); views.jitter.set([.5, .5]);
  writeTraceSampling(views, configuration.sampling);
  views.clamping[0] = configuration.clamping; views.transmissiveOutputAlphaMin[0] = configuration.transmissiveAlphaMin;
  views.sampleSequenceOffset[0] = configuration.sequenceOffset;
  writeTraceQuality(views, {bounces: configuration.bounces, bevel: !!(qualityFlags & 1), dispersionWavelengths: qualityFlags & 2 ? 3 : 1,
    directLightCandidates: configuration.directLightCandidates});
}
/** Production WGSL: the software shader, or the ray-query shader for hardware scenes. */
function productionShader(id: number, shader: SceneShader): Uint8Array {
  const {constants, features, variantFlags, isEmpty, hardware, opaqueClosest} = shader;
  return nativeShaderVariant(id, constants, features, variantFlags, id === RESOURCE.HWRT_SHADER
    ? () => 'enable wgpu_ray_query;\n' + wgpuShaderSource(constants, features, true,
      nativeIntersections(features, isEmpty, false, false, hardware, opaqueClosest))
    : () => wgpuShaderSource(constants, features, true));
}
type FloatGeometryPatch = {target: Float32Array; offset: number; data: Float32Array};
type UintGeometryPatch = {target: Uint32Array; offset: number; data: Uint32Array};
const pendingGeometry = new Map<number, {meshes: MeshState[]; bindings: PreparedMeshInstanceBinding[];
  blases: BLASInstance[]; geometries: Geometry[]; emissive: EmissiveTriangle[]; rt: ArrayBuffer;
  prepared: PreparedScene; instances: MeshInstances; tlas: FlattendBVH; floatPatches: FloatGeometryPatch[]; uintPatches: UintGeometryPatch[]}>();
export function acceptSceneGeometry(token: number): Uint8Array {
  const state = retainedScenes.get(token), pending = pendingGeometry.get(token);
  if (!state || !pending) return new Uint8Array(new Uint32Array([2, 1, 0, 0]).buffer);
  state.meshes = pending.meshes; state.bindings = pending.bindings; state.blases = pending.blases;
  state.geometries = pending.geometries; state.emissive = pending.emissive; state.rt = pending.rt;
  for (const patch of pending.floatPatches) patch.target.set(patch.data, patch.offset);
  for (const patch of pending.uintPatches) patch.target.set(patch.data, patch.offset);
  state.prepared = pending.prepared; state.instances = pending.instances; state.tlas = pending.tlas;
  retainedScenes.set(token, state); pendingGeometry.delete(token);
  return new Uint8Array(new Uint32Array([1, 0, 0, 0]).buffer);
}
type TransformStage = {meshes: MeshState[]; bindings: PreparedMeshInstanceBinding[]; instances: MeshInstances};
type GeometryStage = {meshes: MeshState[]; prepared: PreparedScene; geometry: Geometry; sourceIndex: number; instances: MeshInstances};
const transformStages = new Map<number, TransformStage>();
const geometryStages = new Map<number, GeometryStage>();
const pendingTransforms = new Map<number, {meshes: MeshState[]; bindings: PreparedMeshInstanceBinding[];
  emissive: EmissiveTriangle[]; rt: ArrayBuffer; instances: MeshInstances; tlas: FlattendBVH}>();
export function acceptSceneTransform(token: number): Uint8Array {
  const state = retainedScenes.get(token), pending = pendingTransforms.get(token);
  if (!state || !pending) return new Uint8Array(new Uint32Array([2, 1, 0, 0]).buffer);
  const previousMeshes = state.meshes;
  const previousMeshIndices = new Map(previousMeshes.map((mesh, index) => [mesh, index]));
  state.meshes = pending.meshes; state.bindings = pending.bindings;
  state.instances = pending.instances; state.tlas = pending.tlas;
  state.prepared.instanceBindings = pending.bindings; state.prepared.instances = pending.instances;
  state.prepared.emissiveBindings = state.prepared.emissiveBindings.map(b => {
    const index = previousMeshIndices.get(b.mesh) ?? -1;
    return index < 0 || previousMeshes[index] === pending.meshes[index] ? b : {...b, mesh: pending.meshes[index]};
  });
  state.emissive = pending.emissive; state.rt = pending.rt;
  retainedScenes.set(token, state); pendingTransforms.delete(token);
  return new Uint8Array(new Uint32Array([1, 0, 0, 0]).buffer);
}
// Pending light/environment candidates become authoritative only after the host
// validates resource shapes and completes GPU writes. Rejected edits never alter
// the inputs of a subsequent partial update.
const pendingLighting = new Map<number, {lights: AnalyticLightState[]; rt: ArrayBuffer; environmentPower: number; lightTextures?: number[];
  maps?: {environmentWidth: number; environmentHeight: number; backgroundWidth: number; backgroundHeight: number};
  atlas?: {table: MaterialData; textureIds: Map<TextureState, number>}}>();
export function acceptSceneLighting(token: number): Uint8Array {
  const state = retainedScenes.get(token), pending = pendingLighting.get(token);
  if (!state || !pending) return new Uint8Array(new Uint32Array([2, 1, 0, 0]).buffer);
  state.lights = pending.lights; state.rt = pending.rt; state.environmentPower = pending.environmentPower;
  if (pending.lightTextures) state.table.lightTexturesIndices = pending.lightTextures;
  const atlas = pending.atlas;
  if (atlas) { state.table = atlas.table; state.textureIds = atlas.textureIds; }
  const maps = pending.maps;
  if (maps) {
    state.environmentWidth = maps.environmentWidth; state.environmentHeight = maps.environmentHeight;
    state.backgroundWidth = maps.backgroundWidth; state.backgroundHeight = maps.backgroundHeight;
  }
  retainedScenes.set(token, state);
  pendingLighting.delete(token);
  return new Uint8Array(new Uint32Array([1, 0, 0, 0]).buffer);
}
/**
 * One render target of a retained scene, without preparing the scene again.
 * Input: render settings record, then width, height, quality flags, production shader id,
 * camera flag (0 = the descriptor camera), alpha blend strategy, reserved×2 and one camera record.
 * Output: version 1, shader byte length, then the camera uniform, the trace uniform (the
 * scene's current one with this target's fields) and, when sampling, bevel samples or
 * alpha strategy need a variant, the specialized production shader.
 */
export function sceneTargetParameters(bytes: Uint8Array, token: number): Uint8Array {
  try {
    const state = retainedScenes.get(token);
    if (!state) throw new Error('No retained scene');
    const settingsBytes = S.WORDS * WORD_BYTES;
    if (bytes.byteLength !== settingsBytes + 8 * WORD_BYTES + C.WORDS * WORD_BYTES) throw new Error('Invalid target request');
    const configuration = decodeSceneConfiguration(bytes.subarray(0, settingsBytes));
    const u = new Uint32Array(bytes.buffer, bytes.byteOffset + settingsBytes, 8);
    const [width, height, qualityFlags, shaderId] = [u[0], u[1], u[2], u[3]];
    if (!width || !height || u[5] > 1 || u[6] || u[7] || (shaderId !== RESOURCE.SOFTWARE_SHADER && shaderId !== RESOURCE.HWRT_SHADER)) throw new Error('Invalid target request');
    const camera = sceneCameraParameters(bytes.subarray(settingsBytes + 8 * WORD_BYTES), width, height);
    const rt = makeRayTraceUniform();
    new Uint8Array(rt.buffer).set(new Uint8Array(state.rt));
    writeTargetTrace(rt.views, configuration, width, height, qualityFlags);
    const {constants} = state.shader;
    // Match WGPURayTracePass: deterministic source-over specializes only scenes
    // with blend coverage. The shared scene retains the stochastic base shader.
    const hasAlpha = u[5] === 1 && Boolean(constants.HAS_ALPHA_BLEND);
    const frameInputs=(configuration.variants & 16)!==0;
    const frameFeatures: Parameters<typeof wgpuShaderSource>[1]={...state.shader.features,hasAlpha};
    const targetConstants: Record<string,boolean|number>={...constants, SAMPLING_PATTERN:configuration.sampling.code,BEVEL_SAMPLES:configuration.bevelSamples};
    const nativeHits=shaderId===RESOURCE.HWRT_SHADER?nativeIntersections(frameFeatures,state.shader.isEmpty,false,false,true,state.shader.opaqueClosest):'';
    // Independently traced frame guides use the original PT scene bindings.
    // Their radiance estimate is separate from the merged beauty accumulation.
    let effectiveFlags=frameInputs?0:configuration.causticFlags;
    if((effectiveFlags&6)&&hasStochasticCausticCaster(state.meshes))effectiveFlags&=~6;
    const causticConfiguration={...configuration,causticFlags:effectiveFlags};
    const light=effectiveFlags?prepareNativeLightSampling(state.lights,state.table,state.emissive,state.environmentPower):undefined;
    const caustics=light?nativeCausticTarget({meshes:state.meshes,bindings:state.prepared.instanceBindings,materials:state.prepared.materials,lights:state.lights,emissive:state.emissive,environmentPower:state.environmentPower,lighting:light.lightData,cacheKey:state.prepared},causticConfiguration,width,height,bytes.subarray(settingsBytes+8*WORD_BYTES),camera,targetConstants,{...frameFeatures,workgroupSize:shaderId===RESOURCE.HWRT_SHADER?1:8},nativeHits,shaderId===RESOURCE.HWRT_SHADER):undefined;
    if(caustics){
      frameFeatures.workgroupSize=caustics.metadata.workgroupSize;
      frameFeatures.mnee=!!(caustics.metadata.flags&1);frameFeatures.mneeHardwareIndices=shaderId===RESOURCE.HWRT_SHADER;frameFeatures.mneeMethod=caustics.metadata.flags&8?'sms':'newton';frameFeatures.lightTracing=!!(caustics.metadata.flags&2);frameFeatures.photonMapping=!!(caustics.metadata.flags&4);
      if(frameFeatures.mnee){targetConstants.CAUSTIC_SEED_COUNT=caustics.seedCount;targetConstants.CAUSTIC_SEED_OFFSET=caustics.seedOffset;}
      rt.views.lightSamplingTextureWidth[0]=caustics.metadata.lightWidth;
    }
    const variant=!!caustics||constants.SAMPLING_PATTERN!==configuration.sampling.code||constants.BEVEL_SAMPLES!==configuration.bevelSamples||hasAlpha!==state.shader.features.hasAlpha;
    const frameShader=()=>nativeShaderVariant(shaderId===RESOURCE.HWRT_SHADER?RESOURCE.HWRT_FRAME_SHADER:RESOURCE.SOFTWARE_FRAME_SHADER,targetConstants,frameFeatures,configuration.variants,()=>
      (shaderId===RESOURCE.HWRT_SHADER?'enable wgpu_ray_query;\n':'')+wgpuShaderSource(targetConstants,frameFeatures,true,
        shaderId===RESOURCE.HWRT_SHADER?nativeIntersections(frameFeatures,state.shader.isEmpty,false,false,true,state.shader.opaqueClosest):'',false,nativeFrameInputHooks()));
    const shader = frameInputs ? frameShader() : variant ? productionShader(shaderId, {...state.shader,
      features: frameFeatures,
      constants: targetConstants}) : new Uint8Array(0);
    if(caustics){
      const meta=new TextEncoder().encode(JSON.stringify(caustics.metadata));
      const parts=[camera,new Uint8Array(rt.buffer),shader,meta,caustics.distribution,caustics.lighting,caustics.uniform];
      const output=new Uint8Array(32+parts.reduce((sum,p)=>sum+p.byteLength,0));
      new Uint32Array(output.buffer,0,8).set([VERSION.TARGET_PACKET,shader.byteLength,camera.byteLength,rt.buffer.byteLength,meta.byteLength,caustics.distribution.byteLength,caustics.lighting.byteLength,caustics.uniform.byteLength]);
      let offset=32;for(const part of parts){output.set(part,offset);offset+=part.byteLength;}return output;
    }
    const result = new Uint8Array(4 * WORD_BYTES + camera.byteLength + rt.buffer.byteLength + shader.byteLength);
    new Uint32Array(result.buffer, 0, 4).set([1, shader.byteLength, camera.byteLength, rt.buffer.byteLength]);
    result.set(camera, 4 * WORD_BYTES); result.set(new Uint8Array(rt.buffer), 4 * WORD_BYTES + camera.byteLength);
    result.set(shader, 4 * WORD_BYTES + camera.byteLength + rt.buffer.byteLength);
    return result;
  } catch (error) { return sceneErrorPacket(ERROR_CODE.CONFIGURE, error); }
}
export function retainedSceneParameters(bytes: Uint8Array, token: number): Uint8Array {
  try { return buildSceneParameters(bytes, token); }
  catch (error) { retainedScenes.delete(token); return sceneErrorPacket(ERROR_CODE.RETAINED_SCENE, error);}
}
export function releaseSceneParameters(token: number): Uint8Array {
  aovCaches.delete(token); releaseNativeScene(token); releaseGeometryKernelHints(token); sceneConfigurations.delete(token); retainedScenes.delete(token); pendingLighting.delete(token); pendingTransforms.delete(token); pendingGeometry.delete(token); pendingBuilds.delete(token); transformStages.delete(token); geometryStages.delete(token);
  return new Uint8Array(16);
}
// Version 1: source material index and seven scalar parameters. Maps, emission,
// geometry and compile-time feature changes require a full commit instead.
export function sceneMaterialParameters(bytes: Uint8Array, token: number): Uint8Array {
  const state = retainedScenes.get(token);
  const u = new Uint32Array(bytes.buffer, bytes.byteOffset, 12);
  const f = new Float32Array(bytes.buffer, bytes.byteOffset, 12);
  const m = state?.source[u[1]];
  if (!state || !m || !state.ordered.includes(m) || m.unlit) return new Uint8Array(new Uint32Array([2, !state ? 1 : !m ? 2 : !state.ordered.includes(m) ? 3 : 4, 0, 0]).buffer);
  const color = m.baseColor, roughness = m.specularRoughness, metalness = m.baseMetalness;
  const transmission = m.transmissionWeight, ior = m.specularIor, medium = materialUsesMedium(m);
  m.baseColor = [f[4], f[5], f[6]]; m.specularRoughness = f[7]; m.baseMetalness = f[8];
  m.transmissionWeight = f[9]; m.specularIor = f[10];
  if (materialUsesMedium(m) !== medium) {
    m.baseColor = color; m.specularRoughness = roughness; m.baseMetalness = metalness;
    m.transmissionWeight = transmission; m.specularIor = ior;
    return new Uint8Array(new Uint32Array([2, 5, 0, 0]).buffer);
  }
  // Same repacking and layout used by browser MaterialTable updates. Texture
  // indices and atlas mapping remain in the retained MaterialData object.
  state.table.repackParams(state.ordered);
  const packed = state.table.getBufferArray();
  const result = new Uint8Array(16 + packed.byteLength);
  new Uint32Array(result.buffer).set([1, packed.byteLength, 0, 0]);
  result.set(new Uint8Array(packed.buffer), 16);
  return result;
}

// Versioned experimental wire protocol. The Rust boundary validates every span,
// reference, numeric range and resource budget before entering this trusted core.
// All offsets/counts below are uint32 words; float payloads are IEEE f32.
export function sceneParameters(bytes: Uint8Array): Uint8Array {
  try { return buildSceneParameters(bytes); }
  catch (error) { return sceneErrorPacket(ERROR_CODE.MATERIAL, error);}
}
type DecodedScene = ReturnType<typeof decodeScene>;
type PreparedScene = ReturnType<typeof prepareSceneMeshes<MeshState>>;
function buildSceneParameters(bytes: Uint8Array, token = 0): Uint8Array {
  const input = decodeScene(bytes, token), build = prepareSceneSources(input);
  for (const job of build.jobs) setGeometryBvh(job.geometry, buildBLAS(job.bvhGeometry, job.displacementScale, job.ranges));
  const prepared = prepareSceneMeshes(input.meshes, mesh => build.sources.get(mesh)!);
  return composeScene(input, prepared, buildTLAS(prepared.instances, prepared.blases), token);
}
function decodeScene(bytes: Uint8Array, token = 0) {
  const kernelHints = takeGeometryKernelHints(token);
  const u = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  const f = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  if (u[H.VERSION] !== VERSION.SCENE) throw new Error('Unsupported native scene version');
  const width = u[H.WIDTH], height = u[H.HEIGHT];
  const textures: PixelTexture[] = [];
  const textureIds = new Map<TextureState, number>();
  for (let i = 0; i < u[H.TEXTURE_COUNT]; i++) {
    const texture = decodeTexture(bytes, u, f, u[H.TEXTURE_OFFSET] + i * T.WORDS);
    textures.push(texture); textureIds.set(texture, i);
  }
  const grounded = u[H.GROUNDED_BACKGROUND] ? f.slice(u[H.GROUNDED_BACKGROUND], u[H.GROUNDED_BACKGROUND] + 6) : new Float32Array(6);
  const environmentSettings = u[H.ENVIRONMENT_SETTINGS] ? f.slice(u[H.ENVIRONMENT_SETTINGS], u[H.ENVIRONMENT_SETTINGS] + 4) : new Float32Array([1, 0, 1, 0]);
  const environment = scaleEnvironment(nativeFloatImage(u[H.ENVIRONMENT_TEXTURE] ? textures[u[H.ENVIRONMENT_TEXTURE] - 1] : undefined), environmentSettings[0]);
  const background = nativeFloatImage(u[H.BACKGROUND_TEXTURE] ? textures[u[H.BACKGROUND_TEXTURE] - 1] : undefined);
  const qualityFlags = u[H.QUALITY_FLAGS];
  const environmentDistribution = environment ? envMapDistribution(environment) : undefined;
  const materials: MaterialState[] = [];
  for (let i = 0; i < u[H.MATERIAL_COUNT]; i++) materials.push(decodeMaterial(u, f, u[H.MATERIAL_OFFSET] + i * MAT.WORDS, textures));
  for (let i = 0; i < materials.length; i++) materials[i].aovId = u[H.MATERIAL_AOV_IDS] ? u[u[H.MATERIAL_AOV_IDS] + i] : i;
  if (kernelHints && kernelHints.length !== u[H.GEOMETRY_COUNT]) throw new Error('Kernel geometry count mismatch');
  const geometries: Geometry[] = [];
  for (let i = 0; i < u[H.GEOMETRY_COUNT]; i++) {
    const hint = kernelHints && i < kernelHints.length ? kernelHints[i] : undefined;
    geometries.push(decodeGeometry(u, f, u[H.GEOMETRY_OFFSET] + i * G.WORDS, hint));
  }
  const meshes: MeshState[] = [];
  for (let i = 0; i < u[H.MESH_COUNT]; i++) {
    const off = u[H.MESH_OFFSET] + i * M.WORDS;
    const mesh = new MeshState(geometries[u[off + M.GEOMETRY]], decodeMeshMaterials(u, off, materials));
    mesh.aovId = u[H.MESH_AOV_IDS] ? u[u[H.MESH_AOV_IDS] + i] : i;
    if (u[H.BATCH_OFFSET]) {
      const instances = decodeInstances(u, f, u[H.BATCH_OFFSET] + i * B.WORDS);
      if (instances) mesh.setInstanceState(instances);
    }
    mesh.transform = f.slice(off + M.TRANSFORM, off + M.TRANSFORM + 16);
    meshes.push(mesh);
  }
  const lights: AnalyticLightState[] = [];
  const iesProfiles = new Map<string, IESProfile>();
  for (let i = 0; i < u[H.LIGHT_COUNT]; i++) {
    lights.push(decodeLight(bytes, u, f, u[H.LIGHT_OFFSET] + i * L.WORDS, textures, iesProfiles));
  }
  return {width, height, environment, background, environmentSettings, grounded, qualityFlags, environmentDistribution,
    materials, geometries, meshes, lights, textureIds, backgroundColor: f.slice(H.BACKGROUND_COLOR, H.BACKGROUND_COLOR + 4),
    cameraUniform: sceneCameraParameters(bytes.subarray(u[H.CAMERA_OFFSET] * WORD_BYTES, u[H.CAMERA_OFFSET] * WORD_BYTES + C.WORDS * WORD_BYTES), width, height)};
}
function prepareSceneSources(input: {meshes: MeshState[]; textureIds: Map<TextureState, number>}) {
  const {meshes, textureIds} = input;
  const minmaxCache = new Map<PixelTexture, Uint8Array[]>();
  const projectedGeometry = new Map<Geometry, Map<string, Geometry>>();
  const seen = new Set<Geometry>();
  const jobs: {geometry: Geometry; bvhGeometry: Geometry; displacementScale: number; displacementBias: number; ranges: Float32Array | undefined}[] = [];
  const sources = new Map<MeshState, {geometry: Geometry; displacementScale: number}>();
  for (const mesh of meshes) {
    if (!mesh.geometry.position.array.length) continue;
    const material = mesh.materials[0];
    const texture = material.displacementMap;
    const displacementScale = texture ? material.displacementScale : 0;
    const displacementBias = texture ? material.displacementBias : 0;
    let geometry = mesh.geometry;
    if (texture && (Math.abs(displacementScale) > 1e-6 || displacementBias !== 0)) {
      // Match browser projective-geometry sharing by source, texture and projection values.
      const key = [textureIds.get(texture), Number(texture.flipY), texture.uvScale.join(','), texture.uvOffset.join(','),
        displacementScale, displacementBias, material.displacementUvProjectionScale, material.displacementUvProjection].join('|');
      let entries = projectedGeometry.get(geometry);
      if (!entries) { entries = new Map<string, Geometry>(); projectedGeometry.set(geometry, entries); }
      let copy = entries.get(key);
      if (!copy) { copy = new Geometry(geometry); entries.set(key, copy); }
      geometry = copy;
    }
    if (!seen.has(geometry)) {
      let ranges: Float32Array | undefined;
      if (texture && Math.abs(displacementScale) > 1e-6) {
        if (!(texture instanceof PixelTexture)) throw new Error('Native displacement requires raw pixels.');
        let minmax = minmaxCache.get(texture);
        if (!minmax) {
          const pixels = texture.pixels.data;
          const channels = 4;
          minmax = pixels instanceof Float32Array
            ? computeDisplacementMinmax(texture.pixels.width, channels, i => Math.round(Math.min(Math.max(pixels[i], 0), 1) * 255))
            : pixels instanceof Uint8Array ? computeDisplacementMinmax(texture.pixels.width, channels, i => pixels[i])
            : pixels instanceof Uint8ClampedArray ? computeDisplacementMinmax(texture.pixels.width, channels, i => pixels[i])
            : computeDisplacementMinmax(texture.pixels.width, channels, i => Math.round(Math.min(Math.max(pixels[i], 0), 1) * 255));
          minmaxCache.set(texture, minmax);
        }
        ranges = computeTrianglesDisplacementRange(geometry, minmax, texture.pixels.width, texture.flipY, material);
      }
      seen.add(geometry); jobs.push({geometry, bvhGeometry: displacementBaseGeometry(geometry, displacementBias), displacementScale, displacementBias, ranges});
    }
    sources.set(mesh, {geometry, displacementScale});
  }
  return {jobs, sources};
}
function newMaterialData(materials: MaterialState[], lights: AnalyticLightState[]): MaterialData {
  return new MaterialData(materials, lights.map(light => light.type === 'RectLight' ? light.texture : undefined), texture => {
    if (!(texture instanceof PixelTexture)) throw new Error('Native scene requires raw pixels.');
    return Number(texture.pixels.data instanceof Float32Array);
  }, {maxTextureDimension2D: 4096, maxTextureArrayLayers: 256, maxTextureArrayBytes: 64 * 1024 * 1024});
}
function packMapInfo(table: MaterialData, mapCount: number): Float32Array {
  const mapInfo = new Float32Array(mapCount * 12);
  mapInfo.set(table.bufferData.mapInfo); mapInfo.set(table.bufferData.mapTransform, mapCount * 4);
  for (let i = 0; i < table.bufferData.mapUvChannel.length; i++) {
    mapInfo[mapCount * 8 + i * 4] = table.bufferData.mapUvChannel[i];
    mapInfo[mapCount * 8 + i * 4 + 1] = table.bufferData.mapColorLinear[i];
    mapInfo[mapCount * 8 + i * 4 + 2] = table.bufferData.mapWrap[i * 2];
    mapInfo[mapCount * 8 + i * 4 + 3] = table.bufferData.mapWrap[i * 2 + 1];
  }
  return mapInfo;
}
/** All atlas layers (at least two), layer after layer. */
function packAtlas(table: MaterialData): Uint8Array {
  const atlas = table.atlas, atlasLayers = Math.max(2, atlas.pages.length);
  const atlasBytes = new Uint8Array(atlas.width * atlas.height * atlasLayers * atlas.bytesPerPixel);
  for (let layer = 0; layer < atlas.pages.length; layer++) {
    const data = atlas.floatStorage ? new Uint16Array(atlas.width * atlas.height * 4) : new Uint8Array(atlas.width * atlas.height * 4);
    for (const placement of atlas.pages[layer].placements) {
      const texture = table.textures[placement.index];
      if (!(texture instanceof PixelTexture)) throw new Error('Native scene requires raw pixels.');
      writeRawAtlasPlacement(data, atlas.width, placement, {image: texture.pixels, flipY: texture.flipY}, atlas.floatStorage);
    }
    // scriptc needs both typed-array arms narrowed before reading buffer.
    atlasBytes.set(new Uint8Array(data instanceof Uint16Array ? data.buffer : data.buffer), layer * atlas.width * atlas.height * atlas.bytesPerPixel);
  }
  return atlasBytes;
}
function composeScene(input: DecodedScene, prepared: PreparedScene, tlas: FlattendBVH, token: number, hardware?: HardwareScene): Uint8Array {
  const {width, height, environment, background, qualityFlags, environmentDistribution,
    materials, geometries, meshes, lights, backgroundColor, cameraUniform, environmentSettings, grounded} = input;
  const blases = prepared.blases;
  const blas = hardware ? new Uint8Array(hardware.records.buffer) : new Uint8Array(concatBLASBuffers(blases));
  const bvh = new Uint8Array(tlas.buffer.byteLength + blas.byteLength);
  bvh.set(new Uint8Array(tlas.buffer)); bvh.set(blas, tlas.buffer.byteLength);
  const table = newMaterialData(prepared.materials, lights);
  const configuration = sceneConfigurations.get(token) ?? defaultSceneConfiguration();
  const geometry = prepared.geometry;
  const attributeLayout = sceneAttributeLayout(geometry);
  const {stride, offsets} = attributeLayout;
  const attributes = new Float32Array(geometry.vertexCount * stride);
  packVertexAttributes(geometry, attributes, stride, offsets, 0, geometry.vertexCount);
  const stacks = getTraversalStackSizes(tlas, blases);
  const constants: Record<string, boolean | number> = {...initialSceneConstants(), USE_BACKGROUND: !(qualityFlags & 4), USE_BACKGROUND_MAP: !!background, USE_GROUNDED_BACKGROUND: !!background && grounded[0] > 0,
    USE_ENVMAP: !!environment, ...sceneTraversalConstants(stacks.tlas, stacks.blas), ...attributeLayout.constants,
    ...wgpuMaterialConstants(prepared.materials, table, geometry, configuration.bevelSamples), SAMPLING_PATTERN: configuration.sampling.code};
  const features = {hasDisplacement: table.displacementMaps.length > 0,
    hasAlpha: false, hasSceneAlpha: Boolean(constants.HAS_ALPHA),
    hasAnisotropyDirections: Boolean(constants.USE_ANISOTROPY_DIRECTIONS),
    hasCoatNormals: Boolean(constants.USE_COAT_NORMAL_FRAMES), blasLayoutMask: 1};
  const mapInfo = packMapInfo(table, Number(constants.NUM_MAPS));
  const atlas = table.atlas, atlasLayers = Math.max(2, atlas.pages.length), atlasBytes = packAtlas(table);
  const emissiveCache = new EmissiveTriangleCache();
  const emissive = emissiveCache.collect(prepared.emissiveBindings, prepared.materials);
  // Native scalar edits can enable metal/transmission without replacing the
  // pipeline. Light-list edits can change types, and deformation can turn a
  // degenerate emitter into a light, so retain every light implementation too.
  constants.MATERIAL_CAPABILITIES = ALL_MATERIAL_SHADER_CAPABILITIES;
  constants.LIGHT_CAPABILITIES = ALL_LIGHT_SHADER_CAPABILITIES;
  updateSceneShaderCapabilities(constants);
  const lighting = prepareNativeLightSampling(lights, table, emissive, estimateEnvironmentPower(environment));
  const {lightData, lightWidth, lightHeight, lightUniform} = lighting;
  const rt = makeRayTraceUniform();
  writeEnvironmentSettings(rt, environmentSettings);
  writeGroundedSettings(rt, grounded);
  rt.views.lightsCount[0] = lights.length;
  if (!background && !(qualityFlags & 4)) rt.views.backgroundColor.set(backgroundColor);
  rt.views.backgroundFlags[0] = (qualityFlags & 4 ? 0 : 1) | (background ? 2 : 0) | (grounded[0] > 0 ? 4 : 0); rt.views.blasOffset[0] = tlas.buffer.byteLength / 16;
  rt.views.isEmpty[0] = Number(meshInstancesLength(prepared.instances) === 0); rt.views.bevel[0] = Number(!!(qualityFlags & 1));
  rt.views.dispersionWavelengths[0] = qualityFlags & 2 ? 3 : 1;
  writeTraceLighting(rt.views, lighting);
  writeTargetTrace(rt.views, configuration, width, height, qualityFlags);
  rt.views.sceneFeatureFlags[0] = wgpuSceneFeatureFlags(constants);
  // Output packet: version, count, width, height, then 8-word resource descriptors
  // (id, kind[0=buffer,1=texture,2=WGSL,3=metadata], length, width,height,layers,format,offset).
  const parts: Uint8Array[] = [], records: number[][] = [];
  function add(id: number, kind: number, data: Uint8Array, w: number, h: number, layers: number, format: number) {
    if (kind === 0 && id <= 3 && data.length < WGPU_SCENE_BUFFER_MIN_BYTES) {
      const padded = new Uint8Array(WGPU_SCENE_BUFFER_MIN_BYTES); padded.set(data); data = padded;
    }
    records.push(resourceRecord(id, kind, data.length, w, h, layers, format)); parts.push(data);
  }
  add(RESOURCE.BVH, KIND.BUFFER, bvh, 0, 0, 0, 0); add(RESOURCE.INSTANCES, KIND.BUFFER, new Uint8Array(tlas.instancesBuffer!), 0, 0, 0, 0);
  add(RESOURCE.ATTRIBUTES, KIND.BUFFER, new Uint8Array(attributes.buffer), 0, 0, 0, 0); add(RESOURCE.MATERIALS, KIND.BUFFER, new Uint8Array(table.getBufferArray().buffer), 0, 0, 0, 0);
  add(RESOURCE.MAP_INFO, KIND.BUFFER, new Uint8Array(mapInfo.buffer), 0, 0, 0, 0); add(RESOURCE.CAMERA, KIND.BUFFER, cameraUniform, 0, 0, 0, 0);
  add(RESOURCE.TRACE_UNIFORM, KIND.BUFFER, new Uint8Array(rt.buffer), 0, 0, 0, 0); add(RESOURCE.LIGHT_UNIFORM, KIND.BUFFER, new Uint8Array(lightUniform.buffer), 0, 0, 0, 0);
  add(RESOURCE.ATLAS, KIND.TEXTURE, atlasBytes, atlas.width, atlas.height, atlasLayers, atlas.floatStorage ? FORMAT.RGBA16_FLOAT : FORMAT.RGBA8_UNORM);
  add(RESOURCE.ENVIRONMENT, KIND.TEXTURE, environment ? new Uint8Array(environment.data.buffer) : new Uint8Array(16), environment?.width ?? 1, environment?.height ?? 1, 1, FORMAT.RGBA32_FLOAT);
  if (environmentDistribution) {
    const data = environmentDistribution.data;
    if (!(data instanceof Float32Array)) throw new Error('Expected float environment distribution.');
    add(RESOURCE.ENVIRONMENT_CDF, KIND.TEXTURE, new Uint8Array(data.buffer), environmentDistribution.width, environmentDistribution.height, 1, FORMAT.RG32_FLOAT);
  } else add(RESOURCE.ENVIRONMENT_CDF, KIND.TEXTURE, new Uint8Array(8), 1, 1, 1, FORMAT.RG32_FLOAT);
  add(RESOURCE.BACKGROUND, KIND.TEXTURE, background ? new Uint8Array(background.data.buffer) : new Uint8Array(16), background?.width ?? 1, background?.height ?? 1, 1, FORMAT.RGBA32_FLOAT);
  add(RESOURCE.LIGHT_SAMPLING, KIND.TEXTURE, new Uint8Array(lightData.buffer), lightWidth, lightHeight, 1, FORMAT.RGBA32_FLOAT);
  add(RESOURCE.ENERGY_LUT, KIND.TEXTURE, new Uint8Array(getOpenPbrEnergyLutData().buffer), OPENPBR_ENERGY_LUT_WIDTH, OPENPBR_ENERGY_LUT_HEIGHT, 1, FORMAT.R32_FLOAT);
  add(RESOURCE.DISPLACEMENT, KIND.TEXTURE, new Uint8Array(new Float32Array([Number.MAX_SAFE_INTEGER]).buffer), 1, 1, 1, FORMAT.R32_FLOAT);
  const nativeLayout: NativeLayout = {
    hasAlpha: Boolean(constants.HAS_ALPHA), attributeStrideBytes: stride * 4,
    positionOffsetBytes: offsets[0] * 4, blasOffset: rt.views.blasOffset[0],
    isEmpty: rt.views.isEmpty[0] !== 0, bevel: rt.views.bevel[0] !== 0,
    hasDisplacement: features.hasDisplacement, indexed: !!hardware, hardwareGeometries: hardware?.geometries
  };
  add(RESOURCE.METADATA, KIND.METADATA, nativeLayoutBytes(nativeLayout, nativeLayout.blasOffset, nativeLayout.isEmpty), 0, 0, 0, 0);
  const opaqueClosest = !!hardware && !features.hasDisplacement && hardware.geometries.some(g => g.opaque);
  const variantFlags = Number(nativeLayout.isEmpty) | Number(!!hardware) * 2 | Number(opaqueClosest) * 4;
  function shader(id: number, source: () => string) {
    add(id, KIND.WGSL, nativeShaderVariant(id, constants, features, variantFlags, source), 0, 0, 0, 0);
  }
  const sceneShader: SceneShader = {constants, features, variantFlags, isEmpty: nativeLayout.isEmpty, hardware: !!hardware, opaqueClosest};
  if (configuration.variants & 1) add(RESOURCE.SOFTWARE_SHADER, KIND.WGSL, productionShader(RESOURCE.SOFTWARE_SHADER, sceneShader), 0, 0, 0, 0);
  if (configuration.variants & 2) add(RESOURCE.HWRT_SHADER, KIND.WGSL, productionShader(RESOURCE.HWRT_SHADER, sceneShader), 0, 0, 0, 0);
  if (configuration.variants & 4) {
    shader(RESOURCE.SOFTWARE_HIT_SHADER, () => wgpuShaderSource(constants, features, true) + nativeHitDiagnostics(features, false, 'software'));
    shader(RESOURCE.HIT_SHADER, () => 'enable wgpu_ray_query;\n' + wgpuShaderSource(constants, features, true,
      nativeIntersections(features, nativeLayout.isEmpty, true, false, !!hardware, opaqueClosest))
      + nativeHitDiagnostics(features, nativeLayout.isEmpty, hardware ? 'hardware' : 'both'));
  }
  if (configuration.variants & 8) {
    shader(RESOURCE.SOFTWARE_PATH_SHADER, () => wgpuShaderSource(constants, features, true,
      nativePathIntersections(features, nativeLayout.isEmpty, false), true));
    shader(RESOURCE.HWRT_PATH_SHADER, () => 'enable wgpu_ray_query;\n' + wgpuShaderSource(constants, features, true,
      nativePathIntersections(features, nativeLayout.isEmpty, true, !!hardware, opaqueClosest), true));
  }
  if (configuration.variants & 16) {
    shader(RESOURCE.SOFTWARE_FRAME_SHADER, () => wgpuShaderSource(constants, features, true,
      '', false, nativeFrameInputHooks()));
    shader(RESOURCE.HWRT_FRAME_SHADER, () => 'enable wgpu_ray_query;\n' + wgpuShaderSource(constants, features, true,
      nativeIntersections(features, nativeLayout.isEmpty, false, false, !!hardware, opaqueClosest), false, nativeFrameInputHooks()));
  }
  // Both AS inputs remain explicitly indexed. Production retains source index
  // lookup; leaf-order regression diagnostics use sequence indices.
  const sourceIndices = geometry.indexArray;
  const sequential = new Uint32Array(sourceIndices.length);
  if (hardware) {
    for (const g of hardware.geometries) for (let i = g.indexOffset; i < g.indexOffset + g.indexCount; i++) {
      sequential[i] = sourceIndices[i] - g.vertexOffset;
    }
  } else for (let i = 0; i < sequential.length; i++) sequential[i] = i;
  add(RESOURCE.INDICES, KIND.METADATA, new Uint8Array(sequential.buffer), 0, 0, 0, 0);
  const identity: number[] = [];
  let recordBase = tlas.buffer.byteLength / 16;
  for (let i = 0; i < blases.length; i++) {
    const ids = blases[i].bvh.triangleIds;
    const primitiveBase = prepared.geometryRegions.get(prepared.geometries[i])!.indexOffset / 3;
    if (ids) for (let k = 0; k < ids.length; k += 2) identity.push(recordBase + ids[k], primitiveBase + ids[k + 1]);
    recordBase += blases[i].bvh.buffer.byteLength / 16;
  }
  add(RESOURCE.PRIMITIVE_IDS, KIND.METADATA, new Uint8Array(new Uint32Array(identity).buffer), 0, 0, 0, 0);
  if (hardware) {
    add(RESOURCE.DISPLACEMENT_BOUNDS, KIND.METADATA, new Uint8Array(hardware.bounds.buffer), 0, 0, 0, 0);
    add(RESOURCE.AS_POSITIONS, KIND.METADATA, new Uint8Array(hardwarePositions(geometry).buffer), 0, 0, 0, 0);
    const asIndices = new Uint32Array(sequential.length);
    for (const g of hardware.geometries) for (let i = g.indexOffset; i < g.indexOffset + g.indexCount; i++) asIndices[i] = i - g.indexOffset;
    add(RESOURCE.AS_INDICES, KIND.METADATA, new Uint8Array(asIndices.buffer), 0, 0, 0, 0);
  }
  if (token) retainedScenes.set(token, {source: materials, ordered: prepared.materials, table, lights, emissive,
    rt: rt.buffer, environmentWidth: environment?.width ?? 0, environmentHeight: environment?.height ?? 0,
    backgroundWidth: background?.width ?? 0, backgroundHeight: background?.height ?? 0, qualityFlags, environmentPower: estimateEnvironmentPower(environment),
    textureIds: input.textureIds, nativeLayout, hardware, prepared, instances: prepared.instances, tlas, emissiveCache, meshes, bindings: prepared.instanceBindings, blases, geometries, tlasStack: Number(constants.TLAS_STACK_SIZE), blasStack: Number(constants.BLAS_STACK_SIZE),
    shader: sceneShader});
  return resourcePacket(records, parts, width, height);
}

// AS soup is generated in source primitive order, independently of any BVH.
function hardwarePositions(geometry: Geometry): Float32Array {
  const source = geometry.position.array, indices = geometry.indexArray;
  const positions = new Float32Array(attributeLength(indices) * 3);
  for (let i = 0; i < attributeLength(indices); i++) {
    const vertex = attributeValue(indices, i) * 3;
    positions[i * 3] = source[vertex]; positions[i * 3 + 1] = source[vertex + 1]; positions[i * 3 + 2] = source[vertex + 2];
  }
  return positions;
}
interface HardwareGeometry {opaque: boolean; indexOffset: number; indexCount: number; vertexOffset: number; vertexCount: number; procedural: boolean; dynamic: boolean; boundsOffset: number}
interface HardwareScene {geometries: HardwareGeometry[]; records: Uint32Array; bounds: Float32Array}
function linearTlas(instances: MeshInstances, bindings: PreparedMeshInstanceBinding[], hardware: HardwareScene): FlattendBVH {
  const vertexOffsets = hardware.geometries.map((_, i) => {
    let offset = 0;
    for (let g = 0; g < i; g++) offset += bindings.find(b => b.blasIndex === g)!.geometry.vertexCount;
    return offset;
  });
  return {buffer: new ArrayBuffer(0), maxDepth: 0,
    instancesBuffer: packLinearInstances(instances, hardware.geometries.map(g => g.indexOffset / 3), vertexOffsets)};
}
function hardwareScene(prepared: PreparedScene, build: SceneSources): HardwareScene {
  const opaque = hardwareOpaqueGeometryFlags(prepared.materials, prepared.instanceBindings, prepared.geometries.length);
  const count = attributeLength(prepared.geometry.indexArray) / 3;
  const records = new Uint32Array(build.jobs.some(j => !!j.ranges || j.displacementBias !== 0) ? count * 4 : 0), boxes: number[] = [], geometries: HardwareGeometry[] = [];
  for (const geometry of prepared.geometries) {
    const region = prepared.geometryRegions.get(geometry)!, indexCount = geometry.indexArray.length;
    // Material-index clones share source positions and displacement ranges.
    const binding = prepared.instanceBindings.find(b => b.geometry === geometry)!;
    const source = build.sources.get(binding.mesh)!.geometry;
    const job = build.jobs.find(j => j.geometry === source)!;
    const ranges = job?.ranges;
    const procedural = (!!ranges && Math.abs(job.displacementScale) > 1e-6) || job.displacementBias !== 0;
    geometries.push({opaque: !procedural && opaque[geometries.length], indexOffset: region.indexOffset, indexCount, vertexOffset: region.vertexOffset, vertexCount: geometry.vertexCount,
      procedural, dynamic: geometry.dynamic, boundsOffset: boxes.length / 6});
    if (!ranges && job.displacementBias === 0) continue;
    const prisms = procedural ? displacementPrismAabbs(displacementBaseGeometry(geometry, job.displacementBias), job.displacementScale) : undefined;
    for (let t = 0; t < indexCount / 3; t++) {
      const record = region.indexOffset / 3 + t;
      if (ranges) {
        records[record * 4 + 3] = quantizeDisplacementRange(ranges[t * 2], ranges[t * 2 + 1]);
      }
      if (!procedural) continue;
      for (let axis = 0; axis < 6; axis++) boxes.push(prisms![t * 6 + axis]);
    }
  }
  return {geometries, records, bounds: new Float32Array(boxes)};
}
export function nativeHardwareScene(bytes: Uint8Array, token: number): Uint8Array {
  try {
    const input = decodeScene(bytes, token), build = prepareSceneSources(input);
    const prepared = prepareSceneMeshes(input.meshes, mesh => build.sources.get(mesh)!, geometryKernelBounds, false);
    const hardware = hardwareScene(prepared, build);
    const primitiveOffsets = hardware.geometries.map(g => g.indexOffset / 3);
    const vertexOffsets = prepared.geometries.map(g => prepared.geometryRegions.get(g)!.vertexOffset);
    const tlas: FlattendBVH = {buffer: new ArrayBuffer(0), maxDepth: 0,
      instancesBuffer: packLinearInstances(prepared.instances, primitiveOffsets, vertexOffsets)};
    return composeScene(input, prepared, tlas, token, hardware);
  } catch (error) {retainedScenes.delete(token); return sceneErrorPacket(ERROR_CODE.HARDWARE_SCENE, error);}
}

// Native construction is a finite three-step exchange. TS decodes and prepares
// requests once; the host builds official TinyBVH BLAS/TLAS data between calls.
type SceneSources = ReturnType<typeof prepareSceneSources>;
const pendingBuilds = new Map<number, {input: DecodedScene; build: SceneSources; prepared: PreparedScene | undefined}>();
function build_nativeSceneBegin(bytes: Uint8Array, token: number): Uint8Array {
  pendingBuilds.delete(token);
  const input = decodeScene(bytes, token), build = prepareSceneSources(input);
  pendingBuilds.set(token, {input, build, prepared: undefined});
  const records: number[][] = [], parts: Uint8Array[] = [];
  for (let i = 0; i < build.jobs.length; i++) {
    const job = build.jobs[i], geometry = job.bvhGeometry, sourceIndices = geometry.indexArray;
    const indices = sourceIndices instanceof Uint32Array ? sourceIndices : new Uint32Array(sourceIndices);
    const positions = new Uint8Array(geometry.position.array.buffer);
    const normals = job.ranges ? new Uint8Array(geometry.normal.array.buffer) : new Uint8Array(0);
    const ranges = job.ranges ? new Uint8Array(job.ranges.buffer) : new Uint8Array(0);
    const data = new Uint8Array(16 + positions.length + normals.length + indices.byteLength + ranges.length);
    new Uint32Array(data.buffer).set([geometry.vertexCount, indices.length, Number(!!job.ranges), 0]);
    new Float32Array(data.buffer)[3] = job.displacementScale;
    let offset = 16;
    for (const part of [positions, normals, new Uint8Array(indices.buffer), ranges]) {data.set(part, offset); offset += part.length;}
    records.push(resourceRecord(i, KIND.BUFFER, data.byteLength, 0, 0, 0, 0)); parts.push(data);
  }
  return resourcePacket(records, parts, 0, 0);
}
function builtBvhs(bytes: Uint8Array, count: number): FlattendBVH[] {
  const u = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4), result: FlattendBVH[] = [];
  if (u[0] !== 1 || u[1] !== count) throw new Error('Invalid native BVH result count');
  for (let i = 0; i < count; i++) {
    const o = 4 + i * 8;
    if (u[o] !== i || u[o + 3] > 64 || u[o + 5] % 2 !== 0) throw new Error('Invalid native BVH result');
    const data = bytes.slice(u[o + 7], u[o + 7] + u[o + 2]);
    const triangleIds = u[o + 5] ? new Uint32Array(bytes.buffer.slice(bytes.byteOffset + u[o + 6], bytes.byteOffset + u[o + 6] + u[o + 5] * 4)) : undefined;
    result.push({builder: 'tinybvh', layout: 'bvh2', triangleIds, buffer: data.buffer, maxDepth: u[o + 3], maxLeafPrimitives: u[o + 4]});
  }
  return result;
}
function instanceRequest(prepared: PreparedScene): Uint8Array {
  return requestInstances(prepared.instances);
}
function build_nativeSceneBlas(bytes: Uint8Array, token: number): Uint8Array {
  const state = pendingBuilds.get(token);
  if (!state) throw new Error('Missing native scene construction');
  const bvhs = builtBvhs(bytes, state.build.jobs.length);
  for (let i = 0; i < bvhs.length; i++) setGeometryBvh(state.build.jobs[i].geometry, bvhs[i]);
  const prepared = prepareSceneMeshes(state.input.meshes, mesh => state.build.sources.get(mesh)!);
  state.prepared = prepared; pendingBuilds.set(token, state);
  return instanceRequest(prepared);
}
function build_nativeSceneFinish(bytes: Uint8Array, token: number): Uint8Array {
  const state = pendingBuilds.get(token);
  if (!state || !state.prepared) throw new Error('Missing native scene instances');
  const prepared = state.prepared;
  const tlas = packBuiltTLAS(prepared.instances, prepared.blases, builtBvhs(bytes, 1)[0]);
  const output = composeScene(state.input, prepared, tlas, token);
  pendingBuilds.delete(token);
  return output;
}

function resourceRecord(id: number, kind: number, length: number, width: number, height: number, layers: number, format: number): number[] {
  const record = new Array<number>(PE.WORDS).fill(0);
  record[PE.ID] = id; record[PE.KIND] = kind; record[PE.LENGTH] = length;
  record[PE.WIDTH] = width; record[PE.HEIGHT] = height; record[PE.LAYERS] = layers; record[PE.FORMAT] = format;
  return record;
}

function resourcePacket(records: number[][], parts: Uint8Array[], width: number, height: number) {
  let size = (PH.WORDS + records.length * PE.WORDS) * WORD_BYTES;
  for (const part of parts) size += Math.ceil(part.length / WORD_BYTES) * WORD_BYTES;
  const result = new Uint8Array(size), header = new Uint32Array(result.buffer);
  header[PH.VERSION] = VERSION.RESOURCE_PACKET; header[PH.COUNT] = records.length; header[PH.WIDTH] = width; header[PH.HEIGHT] = height;
  let offset = (PH.WORDS + records.length * PE.WORDS) * WORD_BYTES;
  for (let i = 0; i < records.length; i++) {
    records[i][PE.BYTE_OFFSET] = offset; header.set(records[i], PH.WORDS + i * PE.WORDS);
    result.set(parts[i], offset); offset += Math.ceil(parts[i].length / WORD_BYTES) * WORD_BYTES;
  }
  return result;
}

function prepareNativeLightSampling(lights: AnalyticLightState[], table: MaterialData, emissive: EmissiveTriangle[], environmentPower: number) {
  const lighting = prepareSceneLightSampling(lights, emissive, environmentPower, 4096);
  const lightUniform = new Float32Array(64 * 24);
  lightUniform.set(packSceneAnalyticLights(lights, table.lightTexturesIndices, lighting.analyticPmfs, i => lighting.profiles.offsets[i]));
  return {...lighting, lightUniform};
}

// Incremental writes carry destination byte offsets independently of payload
// offsets. Full scene and TinyBVH request packets retain their own protocol.
function updatePacket(records: number[][], parts: Uint8Array[], destinations: number[] = []): Uint8Array {
  let size = (PH.WORDS + records.length * WE.WORDS) * WORD_BYTES;
  for (const part of parts) size += Math.ceil(part.byteLength / WORD_BYTES) * WORD_BYTES;
  const result = new Uint8Array(size), words = new Uint32Array(result.buffer);
  words.set([VERSION.RESOURCE_WRITES, records.length, 0, 0]);
  let offset = (PH.WORDS + records.length * WE.WORDS) * WORD_BYTES;
  for (let i = 0; i < records.length; i++) {
    const source = records[i], at = PH.WORDS + i * WE.WORDS;
    words[at + WE.ID] = source[PE.ID]; words[at + WE.KIND] = source[PE.KIND]; words[at + WE.LENGTH] = parts[i].byteLength;
    words[at + WE.DESTINATION] = destinations[i] ?? 0;
    words[at + WE.WIDTH] = source[PE.WIDTH]; words[at + WE.HEIGHT] = source[PE.HEIGHT]; words[at + WE.FORMAT] = source[PE.FORMAT];
    words[at + WE.BYTE_OFFSET] = offset; result.set(parts[i], offset); offset += Math.ceil(parts[i].byteLength / WORD_BYTES) * WORD_BYTES;
  }
  return result;
}

function incrementalInstanceWrites(stage: TransformStage, dirty: ReadonlySet<number>, token: number, prepared?: PreparedScene) {
  const state = retainedScenes.get(token)!;
  const meshIndices = new Map(state.meshes.map((mesh, index) => [mesh, index]));
  prepared ??= state.prepared;
  // Only the small instance/TLAS candidate is copied; immutable BLAS and vertex
  // allocations are retained. Uploads below contain dirty records and ancestors.
  const tlas = copyTLASForRefit(state.tlas);
  const records: number[][] = [], parts: Uint8Array[] = [], destinations: number[] = [];
  if (!meshInstancesLength(stage.instances)) return {records, parts, destinations, tlas, emissive: state.emissive, rt: state.rt};
  const ranges = state.hardware ? {tlasRanges: [], instanceRanges: refitLinearInstances(tlas.instancesBuffer!, stage.instances,
    state.hardware.geometries.map(g => g.indexOffset / 3), state.prepared.geometries.map(g => state.prepared.geometryRegions.get(g)!.vertexOffset), dirty)} :
    refitTLAS(tlas, stage.instances, prepared.blases, dirty);
  for (const [id, buffer, spans] of [[RESOURCE.BVH, tlas.buffer, ranges.tlasRanges], [RESOURCE.INSTANCES, tlas.instancesBuffer ?? new ArrayBuffer(0), ranges.instanceRanges]] as const) {
    for (const span of spans) {
      records.push(resourceRecord(id, KIND.BUFFER, span.size, 0, 0, 0, 0)); parts.push(new Uint8Array(buffer.slice(span.offset, span.offset + span.size))); destinations.push(span.offset);
    }
  }
  let emissive = state.emissive, rt = state.rt;
  const changed = new Set<MeshState>();
  for (let i = 0; i < state.meshes.length; i++) if (state.meshes[i] !== stage.meshes[i]) changed.add(state.meshes[i]);
  if (state.prepared.emissiveBindings.some(b => changed.has(b.mesh))) {
    const bindings = prepared.emissiveBindings.map(b => {
      const index = meshIndices.get(b.mesh) ?? -1; return index < 0 ? b : {...b, mesh: stage.meshes[index]};
    });
    emissive = state.emissiveCache.collect(bindings, state.ordered).map(triangle => ({...triangle}));
    const lighting = prepareNativeLightSampling(state.lights, state.table, emissive, state.environmentPower);
    const uniform = makeRayTraceUniform(); new Uint8Array(uniform.buffer).set(new Uint8Array(state.rt));
    writeTraceLighting(uniform.views, lighting); rt = uniform.buffer;
    for (const [id, kind, data, width, height, format] of [
      [RESOURCE.TRACE_UNIFORM, KIND.BUFFER, new Uint8Array(rt), 0, 0, 0],
      [RESOURCE.LIGHT_UNIFORM, KIND.BUFFER, new Uint8Array(lighting.lightUniform.buffer), 0, 0, 0],
      [RESOURCE.LIGHT_SAMPLING, KIND.TEXTURE, new Uint8Array(lighting.lightData.buffer), lighting.lightWidth, lighting.lightHeight, FORMAT.RGBA32_FLOAT]] as const) {
      records.push(resourceRecord(id, kind, data.byteLength, width, height, 1, format)); parts.push(data); destinations.push(0);
    }
  }
  return {records, parts, destinations, tlas, emissive, rt};
}
function incrementalTransform(stage: TransformStage, dirty: ReadonlySet<number>, token: number): Uint8Array {
  const writes = incrementalInstanceWrites(stage, dirty, token);
  pendingTransforms.set(token, {meshes: stage.meshes, bindings: stage.bindings, instances: stage.instances,
    tlas: writes.tlas, emissive: writes.emissive, rt: writes.rt});
  return updatePacket(writes.records, writes.parts, writes.destinations);
}

// Version 1: dimensions/visibility plus linear RGBA32F environment/background.
// Map dimensions may change; adding or removing a map or changing visibility
// changes shader features and uses a full scene commit instead.
export function sceneEnvironmentParameters(bytes: Uint8Array, token: number): Uint8Array {
  pendingLighting.delete(token);
  const state = retainedScenes.get(token);
  if (!state) return new Uint8Array(new Uint32Array([2, 1, 0, 0]).buffer);
  const u = new Uint32Array(bytes.buffer, bytes.byteOffset, 12);
  const f = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  if (!u[1] !== !state.environmentWidth || !u[8] !== !state.backgroundWidth
    || u[3] !== Number(!!(state.qualityFlags & 4))) {
    return new Uint8Array(new Uint32Array([2, 2, 0, 0]).buffer);
  }
  const header = u[0] === 3 ? 24 : u[0] === 2 ? 16 : 12;
  const settings = u[0] >= 2 ? f.slice(12, 16) : new Float32Array([1, 0, 1, 0]);
  const envLength = u[1] * u[2] * 4;
  const environment = scaleEnvironment(envLength ? {width: u[1], height: u[2], data: f.slice(header, header + envLength)} : undefined, settings[0]);
  const background = u[8] * u[9] ? {width: u[8], height: u[9], data: f.slice(header + envLength)} : undefined;
  const distribution = environment ? envMapDistribution(environment) : undefined;
  const environmentPower = estimateEnvironmentPower(environment);
  const lighting = prepareNativeLightSampling(state.lights, state.table, state.emissive, environmentPower);
  const rt = makeRayTraceUniform();
  new Uint8Array(rt.buffer).set(new Uint8Array(state.rt));
  writeEnvironmentSettings(rt, settings);
  if (u[0] === 3) writeGroundedSettings(rt, f.slice(16, 22));
  if (!background && !u[3]) rt.views.backgroundColor.set(f.slice(4, 8));
  packLightingUniform(rt, lighting);
  pendingLighting.set(token, {lights: state.lights, rt: rt.buffer, environmentPower,
    maps: {environmentWidth: u[1], environmentHeight: u[2], backgroundWidth: u[8], backgroundHeight: u[9]}});
  const parts: Uint8Array[] = [], records: number[][] = [];
  function add(id: number, kind: number, data: Uint8Array, width: number, height: number, format: number) {
    records.push(resourceRecord(id, kind, data.length, width, height, kind === KIND.TEXTURE ? 1 : 0, format)); parts.push(data);
  }
  add(RESOURCE.TRACE_UNIFORM, KIND.BUFFER, new Uint8Array(rt.buffer), 0, 0, 0); add(RESOURCE.LIGHT_UNIFORM, KIND.BUFFER, new Uint8Array(lighting.lightUniform.buffer), 0, 0, 0);
  add(RESOURCE.ENVIRONMENT, KIND.TEXTURE, environment ? new Uint8Array(environment.data.buffer) : new Uint8Array(16), u[1] || 1, u[2] || 1, FORMAT.RGBA32_FLOAT);
  add(RESOURCE.ENVIRONMENT_CDF, KIND.TEXTURE, distribution ? new Uint8Array((distribution.data as Float32Array).buffer) : new Uint8Array(8),
    distribution?.width ?? 1, distribution?.height ?? 1, FORMAT.RG32_FLOAT);
  add(RESOURCE.BACKGROUND, KIND.TEXTURE, background ? new Uint8Array(background.data.buffer) : new Uint8Array(16), u[8] || 1, u[9] || 1, FORMAT.RGBA32_FLOAT);
  add(RESOURCE.LIGHT_SAMPLING, KIND.TEXTURE, new Uint8Array(lighting.lightData.buffer), lighting.lightWidth, lighting.lightHeight, FORMAT.RGBA32_FLOAT);
  return updatePacket(records, parts);
}

function packLightingUniform(rt: ReturnType<typeof makeRayTraceUniform>, lighting: Parameters<typeof writeTraceLighting>[1]) {
  writeTraceLighting(rt.views, lighting);
}
// Version1,index,reserved[2], followed by Light[28]. Attachments remain committed.
export function sceneLightParameters(bytes: Uint8Array, token: number): Uint8Array {
  pendingLighting.delete(token);
  const state = retainedScenes.get(token);
  const u = new Uint32Array(bytes.buffer, bytes.byteOffset, 32), f = new Float32Array(bytes.buffer, bytes.byteOffset, 32);
  const previous = state?.lights[u[1]];
  if (!state || !previous) return new Uint8Array(new Uint32Array([2, 1, 0, 0]).buffer);
  const kinds = ['RectLight', 'SphereLight', 'DirectionalLight', 'SpotLight'];
  if (previous.type !== kinds[u[4]]) return new Uint8Array(new Uint32Array([2, 2, 0, 0]).buffer);
  const light = lightFromRecord(u, f, 4, previous.type === 'RectLight' ? previous.texture : undefined);
  if (light.type === 'SpotLight' && previous.type === 'SpotLight') light.iesProfile = previous.iesProfile;
  const lights = state.lights.slice(); lights[u[1]] = light;
  const lighting = prepareNativeLightSampling(lights, state.table, state.emissive, state.environmentPower);
  const rt = makeRayTraceUniform(); new Uint8Array(rt.buffer).set(new Uint8Array(state.rt));
  packLightingUniform(rt, lighting);
  pendingLighting.set(token, {lights, rt: rt.buffer, environmentPower: state.environmentPower});
  return updatePacket([
    [7, 0, rt.buffer.byteLength, 0, 0, 0, 0, 0],
    [8, 0, lighting.lightUniform.byteLength, 0, 0, 0, 0, 0],
    [24, 1, lighting.lightData.byteLength, lighting.lightWidth, lighting.lightHeight, 1, 2, 0]
  ], [new Uint8Array(rt.buffer), new Uint8Array(lighting.lightUniform.buffer), new Uint8Array(lighting.lightData.buffer)]);
}

// Full descriptor: replaces the analytic light list (count, types, IES profiles,
// rect-light textures already in the material atlas). Other attachments need a full commit.
export function sceneLightListParameters(bytes: Uint8Array, token: number): Uint8Array {
  pendingLighting.delete(token);
  const state = retainedScenes.get(token);
  if (!state) return new Uint8Array(new Uint32Array([2, 1, 0, 0]).buffer);
  try {
    const u = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
    const f = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
    const textures: PixelTexture[] = [];
    for (const [texture, index] of state.textureIds) if (texture instanceof PixelTexture) textures[index] = texture;
    const lights: AnalyticLightState[] = [], lightTextures: number[] = [], profiles = new Map<string, IESProfile>();
    for (let i = 0; i < u[H.LIGHT_COUNT]; i++) {
      const light = decodeLight(bytes, u, f, u[H.LIGHT_OFFSET] + i * L.WORDS, textures, profiles);
      const texture = light.type === 'RectLight' ? light.texture : undefined;
      const atlasIndex = texture ? state.table.textures.indexOf(texture) : -1;
      if (texture && atlasIndex < 0) return new Uint8Array(new Uint32Array([2, 2, 0, 0]).buffer);
      lights.push(light); lightTextures.push(atlasIndex);
    }
    const table = state.table, committedTextures = table.lightTexturesIndices;
    table.lightTexturesIndices = lightTextures;
    const lighting = prepareNativeLightSampling(lights, table, state.emissive, state.environmentPower);
    table.lightTexturesIndices = committedTextures;
    const rt = makeRayTraceUniform(); new Uint8Array(rt.buffer).set(new Uint8Array(state.rt));
    rt.views.lightsCount[0] = lights.length;
    packLightingUniform(rt, lighting);
    pendingLighting.set(token, {lights, rt: rt.buffer, environmentPower: state.environmentPower, lightTextures});
    return updatePacket([
      [7, 0, rt.buffer.byteLength, 0, 0, 0, 0, 0],
      [8, 0, lighting.lightUniform.byteLength, 0, 0, 0, 0, 0],
      [24, 1, lighting.lightData.byteLength, lighting.lightWidth, lighting.lightHeight, 1, 2, 0]
    ], [new Uint8Array(rt.buffer), new Uint8Array(lighting.lightUniform.buffer), new Uint8Array(lighting.lightData.buffer)]);
  } catch (error) { return sceneErrorPacket(ERROR_CODE.RETAINED_SCENE, error); }
}

// Version 1, source mesh index, local instance index+1 (0=mesh world matrix),
// reserved=0, matrix[16]. Candidate meshes never mutate accepted source state.
function prepareTransformUpdate(bytes: Uint8Array, token: number, native: boolean): Uint8Array {
  pendingTransforms.delete(token); transformStages.delete(token);
  const state = retainedScenes.get(token);
  const u = new Uint32Array(bytes.buffer, bytes.byteOffset, 20), f = new Float32Array(bytes.buffer, bytes.byteOffset, 20);
  const previous = state?.meshes[u[1]];
  if (!state || !previous) return new Uint8Array(new Uint32Array([2, 1, 0, 0]).buffer);
  const mesh = new MeshState(previous.geometry, previous.materials); mesh.aovId = previous.aovId;
  const data = previous.instanceData;
  if (u[2] && (!data || u[2] > data.count)) return new Uint8Array(new Uint32Array([2, 3, 0, 0]).buffer);
  mesh.transform = u[2] ? new Float32Array(matrixStorage(previous.transform)) : f.slice(4, 20);
  if (data) {
    const transforms = data.transforms.slice();
    if (u[2]) transforms.set(f.subarray(4), (u[2] - 1) * 16);
    mesh.setInstanceState(new InstanceState({count: data.count, transforms, colors: data.colors}));
  }
  const meshes = state.meshes.slice(); meshes[u[1]] = mesh;
  const bindings = state.bindings.map(b => ({mesh: b.mesh === previous ? mesh : b.mesh, geometry: b.geometry,
    blasIndex: b.blasIndex, materialIndices: b.materialIndices, displacementScale: b.displacementScale, bvhBounds: b.bvhBounds}));
  const changedSlots = dirtyPreparedInstanceIndices(state.bindings, new Set([previous]), state.instances);
  const dirty = new Set<number>();
  for (const slot of changedSlots) {
    if (!u[2] || Array.isArray(state.instances) || state.instances.localIndices[slot] === u[2] - 1) dirty.add(slot);
  }
  const instances = updateMeshInstanceTransforms(bindings, state.instances, dirty), stage = {meshes, bindings, instances};
  if (sameInstanceMembership(state.instances, instances)) return incrementalTransform(stage, dirty, token);
  if (native) {transformStages.set(token, stage); return state.hardware ? resourcePacket([], [], 0, 0) : requestInstances(instances);}
  return packTransformUpdate(stage, buildTLAS(instances, state.blases), token);
}
function samePixelTexture(a: PixelTexture, b: PixelTexture): boolean {
  if (a.pixels.width !== b.pixels.width || a.pixels.height !== b.pixels.height || a.flipY !== b.flipY || a.uvChannel !== b.uvChannel || a.wrapS !== b.wrapS || a.wrapT !== b.wrapT
    || !Object.is(a.uvScale[0], b.uvScale[0]) || !Object.is(a.uvScale[1], b.uvScale[1])
    || !Object.is(a.uvOffset[0], b.uvOffset[0]) || !Object.is(a.uvOffset[1], b.uvOffset[1])) return false;
  const x = a.pixels.data, y = b.pixels.data;
  if (x instanceof Float32Array && y instanceof Float32Array) {
    for (let i = 0; i < x.length; i++) if (!Object.is(x[i], y[i])) return false;
    return true;
  }
  if (x instanceof Uint8Array && y instanceof Uint8Array) {
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
    return true;
  }
  return false;
}
function swapTexture(texture: TextureState | undefined, swaps: Map<TextureState, TextureState>): TextureState | undefined {
  if (!texture) return texture;
  const next = swaps.get(texture);
  return next ? next : texture;
}
function swapMaterialTextures(m: MaterialState, swaps: Map<TextureState, TextureState>) {
  m.map = swapTexture(m.map, swaps); m.alphaMap = swapTexture(m.alphaMap, swaps); m.emissiveMap = swapTexture(m.emissiveMap, swaps);
  m.normalMap = swapTexture(m.normalMap, swaps); m.metallicRoughnessMap = swapTexture(m.metallicRoughnessMap, swaps);
  m.roughnessMap = swapTexture(m.roughnessMap, swaps); m.metalnessMap = swapTexture(m.metalnessMap, swaps);
  m.transmissionMap = swapTexture(m.transmissionMap, swaps); m.thinFilmMap = swapTexture(m.thinFilmMap, swaps);
  m.displacementMap = swapTexture(m.displacementMap, swaps); m.coatWeightMap = swapTexture(m.coatWeightMap, swaps);
  m.coatRoughnessMap = swapTexture(m.coatRoughnessMap, swaps); m.fuzzColorMap = swapTexture(m.fuzzColorMap, swaps);
  m.fuzzRoughnessMap = swapTexture(m.fuzzRoughnessMap, swaps); m.specularWeightMap = swapTexture(m.specularWeightMap, swaps);
  m.specularColorMap = swapTexture(m.specularColorMap, swaps); m.anisotropyMap = swapTexture(m.anisotropyMap, swaps);
  m.coatNormalMap = swapTexture(m.coatNormalMap, swaps);
}
function swapSceneTextures(state: {source: MaterialState[]; ordered: MaterialState[]; lights: AnalyticLightState[]}, swaps: Map<TextureState, TextureState>) {
  for (const m of state.source) swapMaterialTextures(m, swaps);
  for (const m of state.ordered) swapMaterialTextures(m, swaps);
  for (const light of state.lights) if (light.type === 'RectLight') light.texture = swapTexture(light.texture, swaps);
}
function sameConstants(a: Record<string, boolean | number>, b: Record<string, boolean | number>): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const key of keys) if (a[key] !== b[key]) return false;
  return true;
}

// Full descriptor. Changed textures (same count) repack the material table,
// map info and atlas. Displacement maps, shader constant changes and atlas
// shape changes use a full scene commit instead.
export function sceneAtlasParameters(bytes: Uint8Array, token: number): Uint8Array {
  pendingLighting.delete(token);
  const state = retainedScenes.get(token);
  if (!state) return new Uint8Array(new Uint32Array([2, 1, 0, 0]).buffer);
  try {
    const u = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
    const f = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
    const previous: TextureState[] = [];
    for (const [texture, index] of state.textureIds) previous[index] = texture;
    if (previous.length !== u[H.TEXTURE_COUNT]) return new Uint8Array(new Uint32Array([2, 2, 0, 0]).buffer);
    const swaps = new Map<TextureState, TextureState>(), restore = new Map<TextureState, TextureState>();
    const textureIds = new Map<TextureState, number>();
    for (let i = 0; i < previous.length; i++) {
      const old = previous[i], fresh = decodeTexture(bytes, u, f, u[H.TEXTURE_OFFSET] + i * T.WORDS);
      if (old instanceof PixelTexture && samePixelTexture(old, fresh)) { textureIds.set(old, i); continue; }
      textureIds.set(fresh, i); swaps.set(old, fresh); restore.set(fresh, old);
    }
    for (const m of state.ordered) {
      const displacement = m.displacementMap;
      if (displacement && swaps.has(displacement)) return new Uint8Array(new Uint32Array([2, 2, 0, 0]).buffer);
    }
    const bevelSamples = (sceneConfigurations.get(token) ?? defaultSceneConfiguration()).bevelSamples;
    const geometry = state.prepared.geometry;
    const before = wgpuMaterialConstants(state.ordered, state.table, geometry, bevelSamples);
    swapSceneTextures(state, swaps);
    const table = newMaterialData(state.ordered, state.lights);
    const after = wgpuMaterialConstants(state.ordered, table, geometry, bevelSamples);
    const atlas = table.atlas, committed = state.table.atlas, layers = Math.max(2, atlas.pages.length);
    if (!sameConstants(before, after) || atlas.width !== committed.width || atlas.height !== committed.height
      || layers !== Math.max(2, committed.pages.length) || atlas.floatStorage !== committed.floatStorage) {
      swapSceneTextures(state, restore);
      return new Uint8Array(new Uint32Array([2, 2, 0, 0]).buffer);
    }
    const lighting = prepareNativeLightSampling(state.lights, table, state.emissive, state.environmentPower);
    const rt = makeRayTraceUniform(); new Uint8Array(rt.buffer).set(new Uint8Array(state.rt));
    packLightingUniform(rt, lighting);
    pendingLighting.set(token, {lights: state.lights, rt: rt.buffer, environmentPower: state.environmentPower, atlas: {table, textureIds}});
    const records: number[][] = [], parts: Uint8Array[] = [], destinations: number[] = [];
    function add(id: number, kind: number, data: Uint8Array, width: number, height: number, format: number, destination: number) {
      records.push(resourceRecord(id, kind, data.length, width, height, kind === KIND.TEXTURE ? 1 : 0, format)); parts.push(data); destinations.push(destination);
    }
    add(RESOURCE.MATERIALS, KIND.BUFFER, new Uint8Array(table.getBufferArray().buffer), 0, 0, 0, 0);
    add(RESOURCE.MAP_INFO, KIND.BUFFER, new Uint8Array(packMapInfo(table, Number(after.NUM_MAPS)).buffer), 0, 0, 0, 0);
    add(RESOURCE.TRACE_UNIFORM, KIND.BUFFER, new Uint8Array(rt.buffer), 0, 0, 0, 0);
    add(RESOURCE.LIGHT_UNIFORM, KIND.BUFFER, new Uint8Array(lighting.lightUniform.buffer), 0, 0, 0, 0);
    // Atlas layers are written one by one; the destination is the array layer.
    const pixels = packAtlas(table), layerBytes = atlas.width * atlas.height * atlas.bytesPerPixel;
    const format = atlas.floatStorage ? FORMAT.RGBA16_FLOAT : FORMAT.RGBA8_UNORM;
    for (let layer = 0; layer < layers; layer++)
      add(RESOURCE.ATLAS, KIND.TEXTURE, pixels.slice(layer * layerBytes, (layer + 1) * layerBytes), atlas.width, atlas.height, format, layer);
    add(RESOURCE.LIGHT_SAMPLING, KIND.TEXTURE, new Uint8Array(lighting.lightData.buffer), lighting.lightWidth, lighting.lightHeight, FORMAT.RGBA32_FLOAT, 0);
    return updatePacket(records, parts, destinations);
  } catch (error) { return sceneErrorPacket(ERROR_CODE.RETAINED_SCENE, error); }
}

// Version 1, source mesh index, instance count, reserved=0, linear RGB[count*3].
// Membership is unchanged, so only that batch's instance records are rewritten.
export function sceneInstanceColorParameters(bytes: Uint8Array, token: number): Uint8Array {
  pendingTransforms.delete(token); transformStages.delete(token);
  const state = retainedScenes.get(token);
  const u = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  const previous = state?.meshes[u[1]], data = previous?.instanceData;
  if (!state || !previous || !data) return new Uint8Array(new Uint32Array([2, 1, 0, 0]).buffer);
  if (u[0] !== 1 || u[2] !== data.count || u.length !== 4 + data.count * 3 || !data.colors || Array.isArray(state.instances))
    return new Uint8Array(new Uint32Array([2, 2, 0, 0]).buffer);
  try {
    const colors = new Float32Array(bytes.buffer, bytes.byteOffset + 16, data.count * 3).slice();
    const mesh = new MeshState(previous.geometry, previous.materials); mesh.aovId = previous.aovId;
    mesh.transform = new Float32Array(matrixStorage(previous.transform));
    mesh.setInstanceState(new InstanceState({count: data.count, transforms: data.transforms, colors}));
    const meshes = state.meshes.slice(); meshes[u[1]] = mesh;
    const bindings = state.bindings.map(b => ({mesh: b.mesh === previous ? mesh : b.mesh, geometry: b.geometry,
      blasIndex: b.blasIndex, materialIndices: b.materialIndices, displacementScale: b.displacementScale, bvhBounds: b.bvhBounds}));
    const dirty = dirtyPreparedInstanceIndices(state.bindings, new Set([previous]), state.instances);
    const instances = state.instances.copy();
    for (const slot of dirty) {
      const local = instances.localIndices[slot];
      for (let k = 0; k < 3; k++) instances.colors[slot * 3 + k] = colors[local * 3 + k];
    }
    return incrementalTransform({meshes, bindings, instances}, dirty, token);
  } catch (error) { return sceneErrorPacket(ERROR_CODE.RETAINED_SCENE, error); }
}
function packTransformUpdate(stage: TransformStage, tlas: FlattendBVH, token: number): Uint8Array {
  const state = retainedScenes.get(token);
  if (!state) return new Uint8Array(new Uint32Array([2, 1, 0, 0]).buffer);
  const {meshes, bindings, instances} = stage;
  if (getTraversalStackSizes(tlas, state.blases).tlas > state.tlasStack) return new Uint8Array(new Uint32Array([2, 2, 0, 0]).buffer);
  const blas = state.hardware ? new Uint8Array(state.hardware.records.buffer) : new Uint8Array(concatBLASBuffers(state.blases));
  const bvh = new Uint8Array(tlas.buffer.byteLength + blas.byteLength);
  bvh.set(new Uint8Array(tlas.buffer)); bvh.set(blas, tlas.buffer.byteLength);
  const emissive = new EmissiveTriangleCache().collect(bindings, state.ordered);
  const lighting = prepareNativeLightSampling(state.lights, state.table, emissive, state.environmentPower);
  const rt = makeRayTraceUniform(); new Uint8Array(rt.buffer).set(new Uint8Array(state.rt));
  rt.views.blasOffset[0] = tlas.buffer.byteLength / 16;
  rt.views.isEmpty[0] = Number(meshInstancesLength(instances) === 0);
  packLightingUniform(rt, lighting);
  pendingTransforms.set(token, {meshes, bindings, instances, tlas, emissive, rt: rt.buffer});
  const instanceBytes = new Uint8Array(tlas.instancesBuffer!);
  const paddedBvh = new Uint8Array(Math.max(bvh.length, WGPU_SCENE_BUFFER_MIN_BYTES)); paddedBvh.set(bvh);
  const paddedInstances = new Uint8Array(Math.max(instanceBytes.length, WGPU_SCENE_BUFFER_MIN_BYTES)); paddedInstances.set(instanceBytes);
  const metadata = nativeLayoutBytes(state.nativeLayout, rt.views.blasOffset[0], rt.views.isEmpty[0] !== 0);
  return updatePacket([
    [1, 0, paddedBvh.length, 0, 0, 0, 0, 0], [2, 0, paddedInstances.length, 0, 0, 0, 0, 0],
    [7, 0, rt.buffer.byteLength, 0, 0, 0, 0, 0], [8, 0, lighting.lightUniform.byteLength, 0, 0, 0, 0, 0],
    [24, 1, lighting.lightData.byteLength, lighting.lightWidth, lighting.lightHeight, 1, 2, 0],
    [31, 3, metadata.byteLength, 0, 0, 0, 0, 0]
  ], [paddedBvh, paddedInstances, new Uint8Array(rt.buffer), new Uint8Array(lighting.lightUniform.buffer), new Uint8Array(lighting.lightData.buffer), metadata]);
}

function prepareGeometryUpdate(bytes: Uint8Array, token: number, native: boolean): Uint8Array {
  pendingGeometry.delete(token); geometryStages.delete(token);
  const state = retainedScenes.get(token);
  if (!state) throw new Error('Missing retained geometry');
  if (!state.hardware && (sceneConfigurations.get(token)?.variants ?? 1) === 2)
    return prepareLegacyGeometryUpdate(bytes, token, native);
  const words = new Uint32Array(bytes.buffer, bytes.byteOffset, 4), values = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  const previous = state.geometries[words[1]], count = words[2], flags = words[3];
  if (!previous || count !== previous.vertexCount || !!(flags & 2) !== !!(previous.tangent && !hasGeneratedVertexTangents(previous)))
    throw new Error('Invalid retained vertex update');
  for (const binding of state.bindings) if (binding.mesh.geometry === previous) {
    for (const material of binding.mesh.materials) if (material.displacementMap && material.displacementBias !== 0)
      return new Uint8Array(new Uint32Array([2, 2, 0, 0]).buffer);
  }
  const geometry = new Geometry(previous);
  geometry.position = new Attribute(values.slice(4, 4 + count * 3), 3);
  if (flags & 1) geometry.normal = new Attribute(values.slice(4 + count * 3, 4 + count * 6), 3);
  else computeGeometryNormals(geometry);
  if (hasGeneratedVertexTangents(previous)) generateVertexTangents(geometry);
  else if (previous.tangent) geometry.tangent = new Attribute(values.slice(4 + count * (flags & 1 ? 6 : 3)), 4);
  markDeformedGeometry(geometry);
  const meshes = state.meshes.map(mesh => {
    if (mesh.geometry !== previous) return mesh;
    const next = new MeshState(geometry, mesh.materials); next.aovId = mesh.aovId; next.transform = new Float32Array(matrixStorage(mesh.transform));
    const data = mesh.instanceData; if (data) next.setInstanceState(new InstanceState({count: data.count, transforms: data.transforms, colors: data.colors}));
    return next;
  });
  const changedMeshes = new Set<MeshState>();
  for (let i = 0; i < meshes.length; i++) if (meshes[i] !== state.meshes[i]) changedMeshes.add(state.meshes[i]);
  if (!changedMeshes.size) return new Uint8Array(new Uint32Array([2, 2, 0, 0]).buffer);
  const build = prepareSceneSources({meshes: meshes.filter((mesh, i) => mesh !== state.meshes[i]), textureIds: state.textureIds});
  const geometries = state.prepared.geometries.slice(), regions = new Map(state.prepared.geometryRegions);
  const changedGeometries = new Map<Geometry, Geometry>(), displacement = new Map<Geometry, {scale: number; ranges: Float32Array}>();
  const affectedBlases: number[] = [];
  const meshIndices = new Map(state.meshes.map((mesh, index) => [mesh, index]));
  const changedBindingByBlas = new Map<number, PreparedMeshInstanceBinding>();
  const jobByGeometry = new Map(build.jobs.map(job => [job.geometry, job]));
  for (const binding of state.bindings) if (changedMeshes.has(binding.mesh)) changedBindingByBlas.set(binding.blasIndex, binding);
  for (let i = 0; i < geometries.length; i++) {
    const binding = changedBindingByBlas.get(i);
    if (!binding) continue;
    const sourceMesh = meshes[meshIndices.get(binding.mesh)!], source = build.sources.get(sourceMesh)!;
    const next = new Geometry(source.geometry), before = geometries[i];
    const old = getGeometryBvh(before);
    if (old) setGeometryBvh(next, {...old, buffer: old.buffer.slice(0)});
    if (!state.hardware && !getGeometryBvh(geometry) && old) setGeometryBvh(geometry, getGeometryBvh(next));
    const region = regions.get(before)!; regions.delete(before); regions.set(next, region); geometries[i] = next;
    changedGeometries.set(before, next); affectedBlases.push(i);
    const job = jobByGeometry.get(source.geometry)!;
    if (job.ranges) displacement.set(next, {scale: job.displacementScale, ranges: job.ranges});
  }
  if (!affectedBlases.length) return new Uint8Array(new Uint32Array([2, 2, 0, 0]).buffer);
  const bindings = state.bindings.map(binding => {
    if (!changedMeshes.has(binding.mesh)) return binding;
    const mesh = meshes[meshIndices.get(binding.mesh)!];
    return {...binding, mesh, geometry: changedGeometries.get(binding.geometry)!,
      bvhBounds: [vec3.clone(matrixStorage(binding.bvhBounds[0])), vec3.clone(matrixStorage(binding.bvhBounds[1]))] as [vec3.Vec3Array,vec3.Vec3Array]};
  });
  const geometryStates = new Map(state.prepared.geometryStates); geometryStates.delete(previous);
  geometryStates.set(geometry, {topologyVersion: geometry.topologyVersion, indices: geometry.indices.array, indexCount: attributeLength(geometry.indexArray)});
  const blases = state.blases.map(blas => ({...blas}));
  for (const index of affectedBlases) if (blases[index]) blases[index].bvh = getGeometryBvh(geometries[index])!;
  const emissiveBindings = state.prepared.emissiveBindings.map(binding => {
    if (!changedMeshes.has(binding.mesh)) return binding;
    return {...binding, mesh: meshes[meshIndices.get(binding.mesh)!], geometry: changedGeometries.get(binding.geometry)!};
  });
  const prepared: PreparedScene = {...state.prepared, geometries, geometryRegions: regions, geometryStates, instanceBindings: bindings, emissiveBindings, blases};
  // An exact kernel record avoids scriptc's narrowing-copy semantics for the
  // richer preparation record. Explicitly transfer changed BLAS references back.
  const kernel: GeometryUpdateState<MeshState> = {geometry: prepared.geometry, geometries, geometryRegions: regions, geometryStates,
    instanceBindings: bindings, blases: blases.map(blas => ({bvh: blas.bvh}))};
  const backups: {target: Float32Array; offset: number; data: Float32Array}[] = [];
  for (const index of affectedBlases) {
    const region = regions.get(geometries[index])!;
    for (const name of ['position', 'normal', 'tangent'] as const) {
      const attribute = prepared.geometry[name]; if (!attribute) continue;
      const offset = region.vertexOffset * attribute.itemSize;
      backups.push({target: attribute.array, offset, data: attribute.array.slice(offset, offset + count * attribute.itemSize)});
    }
  }
  try {
    const update = updatePreparedGeometries(kernel, new Set([geometry]), {softwareBvhs: !state.hardware, displacement});
    for (let i = 0; i < blases.length; i++) blases[i].bvh = kernel.blases[i].bvh;
    if (update.relocated || update.resized) throw new Error('Full commit required: changed software BLAS layout');
    const dirty = dirtyPreparedInstanceIndices(state.bindings, changedMeshes, state.instances);
    const instances = updateMeshInstanceTransforms(bindings, state.instances, dirty); prepared.instances = instances;
    if (!sameInstanceMembership(state.instances, instances)) throw new Error('Full commit required: changed geometry instance membership');
    const writes = incrementalInstanceWrites({meshes, bindings, instances}, dirty, token, prepared);
    const floatPatches: FloatGeometryPatch[] = backups.map(patch => ({target: patch.target, offset: patch.offset,
      data: patch.target.slice(patch.offset, patch.offset + patch.data.length)}));
    const uintPatches: UintGeometryPatch[] = [];
    function add(id: number, data: Uint8Array, destination: number, kind: number) {
      writes.records.push(resourceRecord(id, kind, data.byteLength, 0, 0, 0, 0)); writes.parts.push(data); writes.destinations.push(destination);
    }
    const layout = sceneAttributeLayout(prepared.geometry);
    for (const range of update.vertices) {
      const data = new Float32Array(range.count * layout.stride);
      packVertexAttributes(prepared.geometry, data, layout.stride, layout.offsets, range.first, range.count, true, false, 0);
      add(RESOURCE.ATTRIBUTES, new Uint8Array(data.buffer), range.first * layout.stride * WORD_BYTES, KIND.BUFFER);
    }
    if (!state.hardware) for (const range of update.blases)
      add(RESOURCE.BVH, new Uint8Array(range.blas.buffer), state.tlas.buffer.byteLength + range.offset, KIND.BUFFER);
    if (state.hardware) {
      for (const index of affectedBlases) {
        const descriptor = state.hardware.geometries[index], local = geometries[index];
        if (descriptor.procedural) {
          const detail = displacement.get(local)!;
          const bounds = displacementPrismAabbs(local, detail.scale), boundOffset = descriptor.boundsOffset * 6;
          floatPatches.push({target: state.hardware.bounds, offset: boundOffset, data: bounds});
          add(RESOURCE.DISPLACEMENT_BOUNDS, new Uint8Array(bounds.buffer), boundOffset * WORD_BYTES, KIND.METADATA);
          const start = descriptor.indexOffset / 3 * 4, records = state.hardware.records.slice(start, start + descriptor.indexCount / 3 * 4);
          for (let triangle = 0; triangle < descriptor.indexCount / 3; triangle++) records[triangle * 4 + 3] = quantizeDisplacementRange(detail.ranges[triangle * 2], detail.ranges[triangle * 2 + 1]);
          uintPatches.push({target: state.hardware.records, offset: start, data: records}); add(RESOURCE.BVH, new Uint8Array(records.buffer), start * WORD_BYTES, KIND.BUFFER);
        } else add(RESOURCE.AS_POSITIONS, new Uint8Array(hardwarePositions(local).buffer), descriptor.indexOffset * 3 * WORD_BYTES, KIND.METADATA);
      }
      add(RESOURCE.AS_CHANGED_BLASES, new Uint8Array(new Uint32Array(affectedBlases).buffer), 0, KIND.METADATA);
    }
    const sourceGeometries = state.geometries.slice(); sourceGeometries[words[1]] = geometry;
    pendingGeometry.set(token, {meshes, bindings, blases, geometries: sourceGeometries, prepared, instances,
      tlas: writes.tlas, emissive: writes.emissive, rt: writes.rt, floatPatches, uintPatches});
    return updatePacket(writes.records, writes.parts, writes.destinations);
  } finally {for (const patch of backups) patch.target.set(patch.data, patch.offset);}
}

// Version1, source geometry index, vertex count, flags (1=normals,2=authored
// XYZW tangents). Positions then optional normals/tangents, all f32. Topology and
// material indices stay fixed. Candidate preparation copies merged CPU arrays
// transiently, but never mutates accepted geometry/BVH or rebuilds material maps.
function prepareLegacyGeometryUpdate(bytes: Uint8Array, token: number, native: boolean): Uint8Array {
  pendingGeometry.delete(token); geometryStages.delete(token);
  const state = retainedScenes.get(token);
  const u = new Uint32Array(bytes.buffer, bytes.byteOffset, 4);
  const f = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  if (state === undefined) return new Uint8Array(new Uint32Array([2, 1, 0, 0]).buffer);
  const previous = state.geometries[u[1]], count = u[2], flags = u[3];
  if (previous === undefined) return new Uint8Array(new Uint32Array([2, 1, 0, 0]).buffer);
  if (count !== previous.vertexCount) return new Uint8Array(new Uint32Array([2, 1, 0, 0]).buffer);
  const affected = state.bindings.filter(b => b.mesh.geometry === previous);
  if (!affected.length || affected.some(b => b.mesh.materials.some(m => !!m.displacementMap))
    || !!(flags & 2) !== !!(previous.tangent && !hasGeneratedVertexTangents(previous))) {
    return new Uint8Array(new Uint32Array([2, 2, 0, 0]).buffer);
  }
  const oldBvh = getGeometryBvh(previous);
  if (!state.hardware && !oldBvh) return new Uint8Array(new Uint32Array([2, 2, 0, 0]).buffer);
  const geometry = new Geometry({position: previous.position, normal: previous.normal, indices: previous.indices,
    uv: previous.uv, uv1: previous.uv1, color: previous.color, tangent: previous.tangent, materialIndex: previous.materialIndex});
  geometry.position = new Attribute(previous.position.array.slice(), 3);
  geometry.normal = new Attribute(previous.normal.array.slice(), 3);
  if (hasGeneratedVertexTangents(previous)) generateVertexTangents(geometry);
  else if (previous.tangent) geometry.tangent = new Attribute(previous.tangent.array.slice(), previous.tangent.itemSize);
  if (oldBvh) setGeometryBvh(geometry, {builder: oldBvh.builder, buildSurfaceArea: oldBvh.buildSurfaceArea,
    maxDepth: oldBvh.maxDepth, maxLeafPrimitives: oldBvh.maxLeafPrimitives, layout: oldBvh.layout,
    buffer: oldBvh.buffer.slice(0)});
  const bindingsByMesh = new Map(state.bindings.map(b => [b.mesh, b]));
  const meshes = state.meshes.map(previousMesh => {
    if (previousMesh.geometry !== previous) return previousMesh;
    const mesh = new MeshState(geometry, previousMesh.materials); mesh.aovId = previousMesh.aovId;
    mesh.transform = new Float32Array(matrixStorage(previousMesh.transform));
    const data = previousMesh.instanceData;
    if (data) mesh.setInstanceState(new InstanceState({count: data.count, transforms: data.transforms, colors: data.colors}));
    return mesh;
  });
  const prepared = prepareSceneMeshes(meshes, mesh => {
    const binding = bindingsByMesh.get(mesh);
    return mesh.geometry === geometry ? {geometry, displacementScale: 0}
      : {geometry: binding!.geometry, displacementScale: binding!.displacementScale};
  }, state.hardware ? computeGeometryBounds : undefined, !state.hardware);
  if (prepared.materials.length !== state.ordered.length || prepared.materials.some((m, i) => m !== state.ordered[i])
    || (!state.hardware && !canUpdateGeometries(prepared, [geometry]))) return new Uint8Array(new Uint32Array([2, 2, 0, 0]).buffer);
  geometry.position.array.set(f.subarray(4, 4 + count * 3));
  if (flags & 1) geometry.normal.array.set(f.subarray(4 + count * 3, 4 + count * 6));
  else {
    const normal = geometry.normal;
    computeGeometryNormals(geometry); normal.array.set(geometry.normal.array); geometry.normal = normal;
  }
  if (flags & 2) geometry.tangent!.array.set(f.subarray(4 + count * (flags & 1 ? 6 : 3)));
  else if (hasGeneratedVertexTangents(geometry)) updateDynamicTangents(geometry);
  if (native && !state.hardware && !getGeometryBvh(geometry)!.buffer.byteLength) return new Uint8Array(new Uint32Array([2, 2, 0, 0]).buffer);
  geometry.markVerticesUpdated();
  if (state.hardware) {
    // Re-merge the changed CPU attributes and recompute only affected bounds.
    prepared.geometry.position.array.set(geometry.position.array, prepared.geometryRegions.get(geometry)!.vertexOffset * 3);
    prepared.geometry.normal.array.set(geometry.normal.array, prepared.geometryRegions.get(geometry)!.vertexOffset * 3);
    if (geometry.tangent) prepared.geometry.tangent!.array.set(geometry.tangent.array, prepared.geometryRegions.get(geometry)!.vertexOffset * 4);
    const bounds = computeGeometryBounds(geometry);
    for (const b of prepared.instanceBindings) if (b.geometry === geometry) b.bvhBounds = bounds;
  } else {
    const kernel: GeometryUpdateState<MeshState> = {geometry: prepared.geometry, geometries: prepared.geometries,
      geometryRegions: prepared.geometryRegions, geometryStates: prepared.geometryStates, instanceBindings: prepared.instanceBindings,
      blases: prepared.blases.map(blas => ({bvh: blas.bvh}))};
    updatePreparedGeometries(kernel, new Set([geometry]));
    for (let i = 0; i < prepared.blases.length; i++) prepared.blases[i].bvh = kernel.blases[i].bvh;
  }
  // A shared refit may request a rebuild; native rebuilds must go through C++ TinyBVH.
  if (native && !state.hardware && getGeometryBvh(geometry)?.builder !== 'tinybvh') return new Uint8Array(new Uint32Array([2, 2, 0, 0]).buffer);
  const instances = updateMeshInstanceTransforms(prepared.instanceBindings), stage = {meshes, prepared, geometry, sourceIndex: u[1], instances};
  if (native) {geometryStages.set(token, stage); return state.hardware ? resourcePacket([], [], 0, 0) : requestInstances(instances);}
  return packGeometryUpdate(stage, buildTLAS(instances, prepared.blases), token);
}
function packGeometryUpdate(stage: GeometryStage, tlas: FlattendBVH, token: number): Uint8Array {
  const state = retainedScenes.get(token);
  if (!state) return new Uint8Array(new Uint32Array([2, 1, 0, 0]).buffer);
  const {meshes, prepared, geometry, sourceIndex, instances} = stage;
  const stacks = getTraversalStackSizes(tlas, prepared.blases);
  if (stacks.tlas > state.tlasStack || stacks.blas > state.blasStack) return new Uint8Array(new Uint32Array([2, 2, 0, 0]).buffer);
  const blas = state.hardware ? new Uint8Array(state.hardware.records.buffer) : new Uint8Array(concatBLASBuffers(prepared.blases));
  const bvh = new Uint8Array(Math.max(WGPU_SCENE_BUFFER_MIN_BYTES, tlas.buffer.byteLength + blas.byteLength));
  bvh.set(new Uint8Array(tlas.buffer)); bvh.set(blas, tlas.buffer.byteLength);
  const instanceBytes = new Uint8Array(tlas.instancesBuffer!);
  const packedInstances = new Uint8Array(Math.max(instanceBytes.length, WGPU_SCENE_BUFFER_MIN_BYTES)); packedInstances.set(instanceBytes);
  const merged = prepared.geometry, offsets: number[] = []; let stride = 0;
  for (const name of ['position', 'normal', 'uv', 'uv1', 'color', 'tangent', 'materialIndex'] as const) {
    offsets.push(stride); if (merged[name]) stride += 4;
  }
  const attributes = new Float32Array(merged.vertexCount * stride);
  packVertexAttributes(merged, attributes, stride, offsets, 0, merged.vertexCount);
  const emissive = new EmissiveTriangleCache().collect(prepared.emissiveBindings, state.ordered);
  const lighting = prepareNativeLightSampling(state.lights, state.table, emissive, state.environmentPower);
  const rt = makeRayTraceUniform(); new Uint8Array(rt.buffer).set(new Uint8Array(state.rt));
  rt.views.blasOffset[0] = tlas.buffer.byteLength / 16; rt.views.isEmpty[0] = Number(meshInstancesLength(instances) === 0);
  packLightingUniform(rt, lighting);
  const geometries = state.geometries.slice(); geometries[sourceIndex] = geometry;
  pendingGeometry.set(token, {meshes, bindings: prepared.instanceBindings, blases: prepared.blases, geometries, emissive, rt: rt.buffer, prepared, instances, tlas, floatPatches: [], uintPatches: []});
  const metadata = nativeLayoutBytes(state.nativeLayout, rt.views.blasOffset[0], rt.views.isEmpty[0] !== 0);
  return updatePacket([
    [1,0,bvh.byteLength,0,0,0,0,0], [2,0,packedInstances.byteLength,0,0,0,0,0], [3,0,attributes.byteLength,0,0,0,0,0],
    [7,0,rt.buffer.byteLength,0,0,0,0,0], [8,0,lighting.lightUniform.byteLength,0,0,0,0,0],
    [24,1,lighting.lightData.byteLength,lighting.lightWidth,lighting.lightHeight,1,2,0],
    [31,3,metadata.byteLength,0,0,0,0,0], [41,3,state.hardware ? hardwarePositions(merged).byteLength : 0,0,0,0,0,0]
  ], [bvh, packedInstances, new Uint8Array(attributes.buffer), new Uint8Array(rt.buffer), new Uint8Array(lighting.lightUniform.buffer), new Uint8Array(lighting.lightData.buffer), metadata, state.hardware ? new Uint8Array(hardwarePositions(merged).buffer) : new Uint8Array(0)]);
}

// Match the browser's environment intensity semantics; alpha is not radiance.
function scaleEnvironment(image: {width: number; height: number; data: Float32Array} | undefined, intensity: number) {
  if (!image || intensity === 1) return image;
  const data = image.data.slice();
  for (let i = 0; i < data.length; i += 4) for (let c = 0; c < 3; c++) data[i + c] *= intensity;
  return {width: image.width, height: image.height, data};
}
function writeGroundedSettings(rt: ReturnType<typeof makeRayTraceUniform>, values: Float32Array) {
  rt.views.groundedBackgroundParams.set([values[0], values[1], values[2], Number(values[0] > 0)]);
  rt.views.backgroundFlags[0] = (rt.views.backgroundFlags[0] & ~4) | (values[0] > 0 ? 4 : 0);
  rt.views.groundedBackgroundCenter.set([values[3], values[4]]);
}
function writeEnvironmentSettings(rt: ReturnType<typeof makeRayTraceUniform>, values: Float32Array) {
  const c = Math.cos(values[1]), s = Math.sin(values[1]);
  rt.views.environmentRotation.set([c, 0, s === 0 ? 0 : -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]);
  rt.views.backgroundMapTransform.set([Math.cos(values[3]), Math.sin(values[3]), values[2], 0]);
}
function nativeFloatImage(texture: PixelTexture | undefined): {width: number; height: number; data: Float32Array} | undefined {
  if (!texture) return undefined;
  const data = texture.pixels.data;
  if (!(data instanceof Float32Array)) throw new Error('Environment/background requires linear RGBA32F.');
  return {width: texture.pixels.width, height: texture.pixels.height, data};
}

export function sceneTransformParameters(bytes: Uint8Array, token: number): Uint8Array {return prepareTransformUpdate(bytes, token, false);}
export function sceneGeometryParameters(bytes: Uint8Array, token: number): Uint8Array {return prepareGeometryUpdate(bytes, token, false);}
function requestInstances(instances: MeshInstances): Uint8Array {
  const data = new Uint8Array(meshInstanceBounds(instances).buffer);
  return resourcePacket([[0, 0, data.byteLength, 0, 0, 0, 0, 0]], [data], 0, 0);
}
export function nativeTransformBegin(bytes: Uint8Array, token: number): Uint8Array {
  try {return prepareTransformUpdate(bytes, token, true);}
  catch (error) {transformStages.delete(token); pendingTransforms.delete(token); return sceneErrorPacket(ERROR_CODE.TRANSFORM_BEGIN, error);}
}
export function nativeTransformFinish(bytes: Uint8Array, token: number): Uint8Array {
  try {
    const stage = transformStages.get(token), state = retainedScenes.get(token);
    if (!stage || !state) return new Uint8Array(new Uint32Array([2, 1, 0, 0]).buffer);
    const tlas = state.hardware ? linearTlas(stage.instances, stage.bindings, state.hardware) : packBuiltTLAS(stage.instances, state.blases, builtBvhs(bytes, 1)[0]);
    const output = packTransformUpdate(stage, tlas, token); transformStages.delete(token); return output;
  } catch (error) {transformStages.delete(token); pendingTransforms.delete(token); return sceneErrorPacket(ERROR_CODE.TRANSFORM_FINISH, error);}
}
export function nativeGeometryBegin(bytes: Uint8Array, token: number): Uint8Array {
  try {return prepareGeometryUpdate(bytes, token, true);}
  catch (error) {geometryStages.delete(token); pendingGeometry.delete(token); return sceneErrorPacket(ERROR_CODE.GEOMETRY_BEGIN, error);}
}
export function nativeGeometryFinish(bytes: Uint8Array, token: number): Uint8Array {
  try {
    const stage = geometryStages.get(token);
    if (!stage) return new Uint8Array(new Uint32Array([2, 1, 0, 0]).buffer);
    const state = retainedScenes.get(token)!;
    const tlas = state.hardware ? linearTlas(stage.instances, stage.prepared.instanceBindings, state.hardware) : packBuiltTLAS(stage.instances, stage.prepared.blases, builtBvhs(bytes, 1)[0]);
    const output = packGeometryUpdate(stage, tlas, token); geometryStages.delete(token); return output;
  } catch (error) {geometryStages.delete(token); pendingGeometry.delete(token); return sceneErrorPacket(ERROR_CODE.GEOMETRY_FINISH, error);}
}

export function nativeSceneBegin(bytes: Uint8Array, token: number): Uint8Array {
  try {return build_nativeSceneBegin(bytes, token);}
  catch (error) {pendingBuilds.delete(token); retainedScenes.delete(token); return sceneErrorPacket(ERROR_CODE.SCENE_BEGIN, error);}
}

export function nativeSceneBlas(bytes: Uint8Array, token: number): Uint8Array {
  try {return build_nativeSceneBlas(bytes, token);}
  catch (error) {pendingBuilds.delete(token); retainedScenes.delete(token); return sceneErrorPacket(ERROR_CODE.SCENE_BLAS, error);}
}

export function nativeSceneFinish(bytes: Uint8Array, token: number): Uint8Array {
  try {return build_nativeSceneFinish(bytes, token);}
  catch (error) {pendingBuilds.delete(token); retainedScenes.delete(token); return sceneErrorPacket(ERROR_CODE.SCENE_FINISH, error);}
}

// Independent TS reference for the two D4 kernels; not used by production preparation.
export function geometryKernelReference(bytes: Uint8Array, withBounds: number): Uint8Array {
  const input=decodeScene(bytes),u=new Uint32Array(bytes.buffer,bytes.byteOffset,bytes.length/4);
  const hints:GeometryKernelHint[]=[],counts:number[]=[];
  for(let i=0;i<input.geometries.length;i++) {
    const geometry=input.geometries[i],off=u[H.GEOMETRY_OFFSET]+i*G.WORDS,bounds=computeGeometryBounds(geometry),packed=new Float32Array(6);
    packed.set(bounds[0]);packed.set(bounds[1],3);counts.push(geometry.vertexCount);
    const generated=!!u[off+G.UV]&&!!u[off+G.NORMAL]&&!u[off+G.TANGENT];
    hints.push({vertexCount:geometry.vertexCount,bounds:withBounds?packed:undefined,tangents:generated?geometry.tangent!.array:undefined});
  }
  return encodeGeometryKernelHints(hints,counts);
}

// Per-retained-scene identity data; camera and rigid transforms do not change
// primitive correspondence or geometry content signatures.
const aovCaches = new Map<number, {primitives: AovPrimitiveCache;
  signatures: Map<Geometry, {version: number; topology: number; value: Uint32Array}>;
  hardware?: HardwareScene; hardwareIds?: Uint32Array}>();
/** Snapshot current stable identities and transforms for an independent AOV target. */
export function sceneAovParameters(bytes: Uint8Array, token: number): Uint8Array {
  try {
    const state=retainedScenes.get(token);
    if(!state || bytes.byteLength!==136) throw new Error('Invalid AOV request');
    const u=new Uint32Array(bytes.buffer,bytes.byteOffset,2);
    const camera=decodeCamera(bytes.subarray(8));
    let cache=aovCaches.get(token);
    if(!cache){cache={primitives:new AovPrimitiveCache(),signatures:new Map()};aovCaches.set(token,cache);}
    let primitiveIds: Uint32Array;
    if(state.hardware){
      if(cache.hardware!==state.hardware || !cache.hardwareIds){
        cache.hardware=state.hardware;
        cache.hardwareIds=new Uint32Array(state.prepared.geometry.indexArray.length/3);
        for(const geometry of state.hardware.geometries){
          for(let t=0;t<geometry.indexCount/3;t++)cache.hardwareIds[geometry.indexOffset/3+t]=t;
        }
      }
      primitiveIds=cache.hardwareIds;
    } else {
      primitiveIds=cache.primitives.get({blases:state.blases,geometries:state.prepared.geometries},state.tlas);
    }
    const packed=packAovScene({...state.prepared, instances:state.instances, blases:state.blases},state.tlas,camera,u[0],u[1],new AovHistory(),primitiveIds);
    const words=packed.words, floats=new Float32Array(words.buffer);
    floats.set(packed.frame.viewProjection);
    // Content revisions survive full publications. Hash shared geometry once,
    // even when one mesh contributes many linear or packed instances.
    const geometrySignatures=cache.signatures;
    const currentGeometries=new Set(state.meshes.map(mesh=>mesh.geometry));
    for(const geometry of geometrySignatures.keys())if(!currentGeometries.has(geometry))geometrySignatures.delete(geometry);
    const objectSignatures=new Map<number,Uint32Array>();
    for(const mesh of state.meshes){
      let cached=geometrySignatures.get(mesh.geometry);
      if(!cached || cached.version!==mesh.geometry.version || cached.topology!==mesh.geometry.topologyVersion){
        let topology=2166136261,vertices=2166136261;
        for(const value of mesh.geometry.indexArray)topology=Math.imul(topology^value,16777619)>>>0;
        const position=new Float32Array(mesh.geometry.position.array);
        for(const value of new Uint32Array(position.buffer))vertices=Math.imul(vertices^value,16777619)>>>0;
        cached={version:mesh.geometry.version,topology:mesh.geometry.topologyVersion,value:new Uint32Array([topology,vertices,position.length])};
        geometrySignatures.set(mesh.geometry,cached);
      }
      objectSignatures.set(mesh.aovId,cached.value);
    }
    for(let i=0;i<packed.frame.instances.length;i++) {
      const instance=packed.frame.instances[i],offset=52+i*24;
      floats.set(instance.transform,offset+4);
      words.set(objectSignatures.get(instance.object)!,offset+20);
    }
    const result=new Uint32Array(4+words.length);result.set([1,words.length,0,0]);result.set(words,4);
    return new Uint8Array(result.buffer);
  }catch(error){return sceneErrorPacket(ERROR_CODE.CONFIGURE,error);}
}
