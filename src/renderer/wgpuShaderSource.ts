import {researchTransport} from './researchTransport.js';
import rayTraceCompute, {type RayTraceInputHooks} from './wgsl/rayTrace.compute.js';
import { WGPU_SCENE_FEATURE_BITS } from './WGPUSceneFeatures.js';
import { MATERIAL_TEXTURE_DEFINES } from './materialTextureSlots.js';

export interface WGPUShaderFeatures {
  hasDisplacement: boolean;
  debugGroup?: number;
  /** Invocation block edge; the native host matches dispatch to this value. Default 8. */
  workgroupSize?:number;
  lightTracing?: boolean;
  photonMapping?:boolean;
  photonMaxDepth?:number;
  photonDirectSubset?:boolean;
  hasAlpha: boolean;
  hasSceneAlpha: boolean;
  hasAnisotropyDirections: boolean;
  hasCoatNormals: boolean;
  blasLayoutMask: number;
  /** Environment presence changes background/MIS semantics independently of packed material data. */
  dynamicEnvironment?: boolean;
}
export const WGPU_SHADER_DEFINE_KEYS = ['NUM_MAPS', 'TLAS_STACK_SIZE', 'BLAS_STACK_SIZE', 'NUM_UNIFORM_LIGHTS'];
const constantsNotUsed = [
  ...Object.keys(WGPU_SCENE_FEATURE_BITS), 'USE_BACKGROUND', 'USE_BACKGROUND_MAP',
  'USE_GROUNDED_BACKGROUND', ...MATERIAL_TEXTURE_DEFINES, 'USE_ANISOTROPY_DIRECTIONS',
  'USE_COAT_NORMAL_FRAMES', 'HAS_ALPHA_BLEND', 'HAS_ALPHA_MASK'
];
export function wgpuPipelineConstantKeys(constants: Record<string, boolean | number>) {
  return Object.keys(constants).sort().filter(key => !WGPU_SHADER_DEFINE_KEYS.includes(key) && !constantsNotUsed.includes(key));
}
export function wgpuShaderPreamble(constants: Record<string, boolean | number>, bake = false): string {
  const defineCode = WGPU_SHADER_DEFINE_KEYS.map(key => `const ${key} = ${constants[key]};`).join('\n');
  const keys = wgpuPipelineConstantKeys(constants);
  const constantsCode = keys.map(key => {
    const value = constants[key];
    return `${bake ? 'const' : 'override'} ${key} = ${typeof value === 'boolean' ? (value ? 'true' : 'false') : value.toString()};`;
  }).join('\n');
  return `\n${defineCode}\n${constantsCode}\n`;
}
export function wgpuShaderSource(constants: Record<string, boolean | number>, features: WGPUShaderFeatures, bake = false, sceneIntersections = '', pathDiagnostic = false, inputHooks?: RayTraceInputHooks): string {
  constants = researchTransport()?.constants(constants, features) ?? constants;
  return wgpuShaderPreamble(constants, bake) + rayTraceCompute({
    ...features,
    spectral: bake ? Boolean(constants.SPECTRAL) : undefined,
    sceneCapabilities: bake && constants.SCENE_CAPABILITIES !== undefined ? Number(constants.SCENE_CAPABILITIES) : undefined,
    materialCapabilities: bake && constants.MATERIAL_CAPABILITIES !== undefined ? Number(constants.MATERIAL_CAPABILITIES) : undefined,
    lightCapabilities: bake && constants.LIGHT_CAPABILITIES !== undefined ? Number(constants.LIGHT_CAPABILITIES) : undefined
  }, sceneIntersections, pathDiagnostic, inputHooks);
}
