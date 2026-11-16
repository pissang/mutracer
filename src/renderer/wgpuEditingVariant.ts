import {WGPU_SCENE_FEATURE_BITS} from './WGPUSceneFeatures.js';
import {ALL_LIGHT_SHADER_CAPABILITIES, ALL_MATERIAL_SHADER_CAPABILITIES} from './shaderCapabilities.js';
import {MAX_TRAVERSAL_STACK_SIZE} from './bvhAccel.js';

/** Shared atlas packing capacity for eager editing pipelines. Larger atlases
 * retain their actual capacity and use a separate pipeline. */
export const EDITING_MAP_CAPACITY = 256;

/** An explicit source contract: no unused scene defines or insertion order from
 * scene preparation enter the universal kernel's source or signature. Vertex
 * offsets/format flags are uniforms; all legal traversal stacks fit 64 entries.
 * Transport/sampling settings still select independent algorithm variants. */
export function universalEditingConstants(scene: Record<string, boolean | number>): Record<string, boolean | number> {
  return {
    NUM_MAPS: Math.max(EDITING_MAP_CAPACITY, Number(scene.NUM_MAPS ?? 0)),
    TLAS_STACK_SIZE: MAX_TRAVERSAL_STACK_SIZE,
    BLAS_STACK_SIZE: MAX_TRAVERSAL_STACK_SIZE,
    NUM_UNIFORM_LIGHTS: 64,
    POSITION_OFF: 0,
    SAMPLING_PATTERN: scene.SAMPLING_PATTERN ?? 0,
    BEVEL_SAMPLES: scene.BEVEL_SAMPLES ?? 8,
    HAS_ALPHA: true, HAS_ALPHA_MASK: true, HAS_ALPHA_BLEND: true,
    HAS_MEDIUM: true, HAS_BEVEL: scene.HAS_BEVEL ?? false,
    USE_UV1: true, USE_ANISOTROPY_DIRECTIONS: true, USE_COAT_NORMAL_FRAMES: true,
    USE_MATERIALX_NORMAL_MAPS: true, USE_UDIM_MAPS: true,
    SPECTRAL: scene.SPECTRAL ?? false,
    USE_RR: true, RR_MAX: 12,
    ...Object.fromEntries(Object.keys(WGPU_SCENE_FEATURE_BITS).map(name => [name, true])),
    SCENE_CAPABILITIES: Object.values(WGPU_SCENE_FEATURE_BITS).reduce((bits, bit) => bits | bit, 0),
    MATERIAL_CAPABILITIES: ALL_MATERIAL_SHADER_CAPABILITIES,
    LIGHT_CAPABILITIES: ALL_LIGHT_SHADER_CAPABILITIES
  };
}
