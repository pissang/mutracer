/// <reference types="@webgpu/types" preserve="true" />

/**
 * MuTracer: a physically based WebGPU path tracer with a
 * WebGL 2 fallback.
 *
 * Build a {@link Scene} from {@link Mesh}es and lights (or convert a Three.js
 * scene with {@link fromTHREEScene}), then call {@link Engine.update} and {@link Render.refine} once
 * per animation frame.
 *
 * @packageDocumentation
 */
export { VERSION } from './version.js';

export type {
  AlphaBlendStrategy,
  ShaderCompilationDiagnostics,
  ToneMapping
} from './renderer/RenderingPipeline.js';
export type {
  OfflineAdaptiveSamplingOptions,
  OfflineVarianceHistory
} from './renderer/OfflineAdaptiveSampling.js';
export type { OIDNModel, OIDNEngine, OIDNPrecision, OIDNHDRTransfer, OIDNDynamicTileOptions, OIDNDynamicTileSetting, OIDNAuxiliaryModelUrls } from './oidn.js';
export { DEFAULT_JNLM_OPTIONS } from './renderer/jnlm.js';
export type { JNLMOptions } from './renderer/jnlm.js';

// Scene description
export type {
  AnalyticLight,
  EquirectBackground,
  GroundedSkyboxBackground,
  Scene,
  SceneBackground,
  SceneLight
} from './scene/Scene.js';
export { default as Camera } from './scene/Camera.js';
export { default as Mesh } from './scene/Mesh.js';
export { default as InstancedMesh } from './scene/InstancedMesh.js';
export type { InstancedMeshOptions } from './scene/InstancedMesh.js';
export { default as SceneNode } from './scene/SceneNode.js';
export {
  default as Geometry,
  Attribute as GeometryAttribute
} from './scene/Geometry.js';
export type { GeometryInit } from './scene/Geometry.js';
export type { OpenPBRMaterialParams } from './scene/OpenPBRMaterial.js';
export { default as OpenPBRMaterial } from './scene/OpenPBRMaterial.js';
export type {
  MaterialAlphaMode,
  UVProjection
} from './scene/OpenPBRMaterial.js';
export { default as ProceduralSky } from './scene/ProceduralSky.js';
export type { ProceduralSkyOptions } from './scene/ProceduralSky.js';
export { default as Texture } from './scene/Texture.js';
export type { TextureDataSource, TextureWrapMode, TextureColorSpace } from './scene/Texture.js';
export type { ColorRGB, ColorRGBA, Vec2, Vec3, Mat4 } from './types.js';

// Lights
export { default as AmbientLight } from './scene/AmbientLight.js';
export { default as DirectionalLight } from './scene/DirectionalLight.js';
export { default as RectLight } from './scene/RectLight.js';
export { default as SphereLight } from './scene/SphereLight.js';
export { default as SpotLight } from './scene/SpotLight.js';
export { default as EnvironmentLight } from './scene/EnvironmentLight.js';
export {
  default as IESProfile,
  IESParseError,
  parseIESProfile
} from './scene/IESProfile.js';

// Loaders and integrations
export { loadRGBE, parseRGBE } from './util/loadRGBE.js';
export { fromTHREECamera, fromTHREEScene, THREESync } from './util/fromTHREE.js';
export type {
  FromTHREESceneOptions,
  THREESyncOptions, THREEControls,
  FromTHREECameraOptions
} from './util/fromTHREE.js';

// Geometry helpers
export {
  createCubeGeometry,
  createCurvePlaneGeometry,
  createPlaneGeometry,
  createSphereGeometry
} from './util/commonGeometry.js';
export {
  generateVertexNormals,
  generateVertexTangents
} from './util/geometry.js';
export { computeMeshesBoundingBox } from './util/mesh.js';

// BVH
export type { TinyBvhLayout } from './tinybvh/TinyBvhBuilder.js';

export type { SamplingPattern } from './renderer/sampling.js';

// Independent rendering mechanisms.
export { default as Engine } from './Engine.js';
export type { EngineParams, EngineInfo, EngineDiagnostics, PrepareOptions, BVHBuilder, DepthSampleArea, TextureAtlasLimits } from './Engine.js';
export { default as Display } from './Display.js';
export type { BlobOptions, DisplayChannel, AovIdComponent, DisplaySettings, PostProcess, PostProcessContext } from './Display.js';
export { default as Render } from './Render.js';
export type { RenderOptions, RenderSettings, CausticSettings, RefineOptions, ConvergeOptions, ConvergeResult, DenoiserOptions, Denoiser, DenoiseInput, CustomDenoiserOptions, DenoiseSchedule, JNLMDenoiserOptions, OIDNDenoiserOptions, RenderStatus, SampleEvent } from './Render.js';

export { default as Sync } from './Sync.js';
export { default as RenderLoop } from './RenderLoop.js';
export type { RenderLoopOptions, RenderLoopStatus } from './RenderLoop.js';

export {getRecommendedDeviceDescriptor} from './renderer/deviceRequirements.js';

export type {AovKind} from './renderer/aov.js';
