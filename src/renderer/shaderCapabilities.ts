import {wgpuSceneFeatureFlags, WGPU_SCENE_FEATURE_BITS} from './WGPUSceneFeatures.js';

export const MATERIAL_SHADER_CAPABILITIES = {transmission: 1, metal: 2} as const;
export const LIGHT_SHADER_CAPABILITIES = {
  SphereLight: 1, RectLight: 2, SpotLight: 4, DirectionalLight: 8, emissive: 16, DiskLight: 32, CylinderLight: 64
} as const;
export const ALL_MATERIAL_SHADER_CAPABILITIES = 3;
export const ALL_LIGHT_SHADER_CAPABILITIES = 127;

export function lightShaderCapabilities(types: readonly string[], emissiveCount: number) {
  let mask = emissiveCount > 0 ? LIGHT_SHADER_CAPABILITIES.emissive : 0;
  for (const type of types) {
    switch (type) {
      case 'SphereLight': mask |= LIGHT_SHADER_CAPABILITIES.SphereLight; break;
      case 'RectLight': mask |= LIGHT_SHADER_CAPABILITIES.RectLight; break;
      case 'SpotLight': mask |= LIGHT_SHADER_CAPABILITIES.SpotLight; break;
      case 'DirectionalLight': mask |= LIGHT_SHADER_CAPABILITIES.DirectionalLight; break;
      case 'DiskLight': mask |= LIGHT_SHADER_CAPABILITIES.DiskLight; break;
      case 'CylinderLight': mask |= LIGHT_SHADER_CAPABILITIES.CylinderLight; break;
    }
  }
  return mask;
}

export function updateSceneShaderCapabilities(constants: Record<string, boolean | number>) {
  constants.SCENE_CAPABILITIES = wgpuSceneFeatureFlags(constants);
}

export interface ShaderCapabilities {
  SCENE_CAPABILITIES: number;
  MATERIAL_CAPABILITIES: number;
  LIGHT_CAPABILITIES: number;
}

export function shaderCapabilitiesInclude(supported: ShaderCapabilities, required: ShaderCapabilities) {
  return (supported.SCENE_CAPABILITIES & required.SCENE_CAPABILITIES) === required.SCENE_CAPABILITIES &&
    (supported.MATERIAL_CAPABILITIES & required.MATERIAL_CAPABILITIES) === required.MATERIAL_CAPABILITIES &&
    (supported.LIGHT_CAPABILITIES & required.LIGHT_CAPABILITIES) === required.LIGHT_CAPABILITIES;
}

/** Retain support, not the scene's active flags. Commit only after compilation succeeds. */
export function retainedShaderCapabilities(constants: Record<string, boolean | number>, previous?: ShaderCapabilities): ShaderCapabilities {
  let scene = wgpuSceneFeatureFlags(constants) | (previous?.SCENE_CAPABILITIES ?? 0);
  // Metalness is a continuous base-material edit, including the first change
  // from a dielectric to a metal. Keep that support in every base variant.
  const material = MATERIAL_SHADER_CAPABILITIES.metal |
    Number(constants.MATERIAL_CAPABILITIES ?? 0) | (previous?.MATERIAL_CAPABILITIES ?? 0);
  const commonSurface = WGPU_SCENE_FEATURE_BITS.HAS_COAT | WGPU_SCENE_FEATURE_BITS.HAS_FUZZ;
  // Activate this small group on first use, keeping a plain scene's initial
  // pipeline lean. Thin film, media, dispersion and alpha remain independent.
  if ((scene & commonSurface) !== 0) {
    scene |= commonSurface;
  }
  return {
    SCENE_CAPABILITIES: scene,
    MATERIAL_CAPABILITIES: material,
    LIGHT_CAPABILITIES: Number(constants.LIGHT_CAPABILITIES ?? 0) | (previous?.LIGHT_CAPABILITIES ?? 0)
  };
}
