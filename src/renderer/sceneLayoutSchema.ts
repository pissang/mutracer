import {makeRayTraceUniform} from './wgpuSceneUniform.js';

type Field = readonly [string, number];
const field = (name: string, words = 1): Field => [name, words];
function record(fields: Field[]): Record<string, number> {
  let words = 0;
  const offsets: Record<string, number> = {};
  for (const [name, length] of fields) { offsets[name] = words; words += length; }
  offsets.WORDS = words;
  return offsets;
}

// One source for native wire records, resource identities and shared WebGPU
// bindings. Descriptor offsets are u32 words; uniform offsets are bytes.
export const WORD_BYTES = 4;
export const protocolVersions = {SCENE: 4, RESOURCE_PACKET: 1, RESOURCE_WRITES: 3,TARGET_PACKET:4, GEOMETRY_KERNELS: 1};
export function sceneRecords() { return {
  HEADER: record([field('VERSION'), field('LENGTH'), field('WIDTH'), field('HEIGHT'),
    field('GEOMETRY_COUNT'), field('MESH_COUNT'), field('MATERIAL_COUNT'), field('LIGHT_COUNT'), field('TEXTURE_COUNT'),
    field('GEOMETRY_OFFSET'), field('MESH_OFFSET'), field('MATERIAL_OFFSET'), field('LIGHT_OFFSET'), field('TEXTURE_OFFSET'),
    field('CAMERA_OFFSET'), field('RESERVED'), field('BACKGROUND_COLOR', 4), field('ENVIRONMENT_TEXTURE'),
    field('BACKGROUND_TEXTURE'), field('QUALITY_FLAGS'), field('BATCH_OFFSET'), field('MESH_AOV_IDS'), field('MATERIAL_AOV_IDS'), field('ENVIRONMENT_SETTINGS'), field('GROUNDED_BACKGROUND'), field('RESERVED_END', 4)]),
  GEOMETRY: record([field('VERTEX_COUNT'), field('INDEX_COUNT'), field('POSITION'), field('INDICES'), field('NORMAL'),
    field('UV'), field('UV1'), field('COLOR'), field('TANGENT'), field('MATERIAL_INDEX'), field('RESERVED', 2)]),
  MESH: record([field('GEOMETRY'), field('MATERIAL'), field('MATERIAL_TABLE'), field('MATERIAL_COUNT'), field('TRANSFORM', 16)]),
  MATERIAL: record([field('BASE_COLOR', 3), field('ROUGHNESS'), field('METALNESS'), field('TRANSMISSION'), field('IOR'),
    field('EMISSION_COLOR', 3), field('EMISSION_LUMINANCE'), field('COAT_WEIGHT'), field('COAT_ROUGHNESS'), field('OPACITY'),
    field('THIN_WALLED'), field('MAP'), field('NORMAL_MAP'), field('METALLIC_ROUGHNESS_MAP'), field('EMISSIVE_MAP'),
    field('EXTENSION_COUNT'), field('EXTENSION_OFFSET'), field('RESERVED', 3)]),
  TEXTURE: record([field('WIDTH'), field('HEIGHT'), field('STORAGE'), field('PIXELS'), field('FLIP_Y'), field('UV_CHANNEL'),
    field('UV_SCALE', 2), field('UV_OFFSET', 2), field('WRAP_S'), field('WRAP_T')]),
  LIGHT: record([field('TYPE'), field('COLOR', 3), field('INTENSITY'), field('SIZE'), field('HEIGHT_OR_INNER'),
    field('SPREAD_OR_OUTER'), field('TEXTURE'), field('IES_OFFSET'), field('IES_BYTES'), field('RESERVED'), field('TRANSFORM', 16)]),
  CAMERA: record([field('PROJECTION'), field('FOV'), field('NEAR'), field('FAR'), field('LEFT'), field('RIGHT'), field('BOTTOM'),
    field('TOP'), field('ZOOM'), field('F_STOP'), field('FOCUS_DISTANCE'), field('SENSOR_HEIGHT'), field('METERS_PER_UNIT'),
    field('RESERVED', 3), field('TRANSFORM', 16)]),
  BATCH: record([field('COUNT'), field('TRANSFORMS'), field('COLORS'), field('RESERVED')]),
  EXTENSION: record([field('ID'), field('X'), field('Y'), field('Z')]),
  SETTINGS: record([field('STRUCT_SIZE'), field('SAMPLING_PATTERN'), field('SEED'), field('MAX_SAMPLES'),
    field('BOUNCES', 2), field('DIRECT_LIGHT_CANDIDATES', 2), field('BEVEL_SAMPLES', 2), field('CLAMPING', 2),
    field('TRANSMISSIVE_ALPHA_MIN', 2), field('SEQUENCE_OFFSET'), field('VARIANTS'),field('CAUSTIC_FLAGS'),field('LIGHT_PHOTONS'),field('PHOTON_MAP_PHOTONS'),field('PHOTON_MAP_RADIUS')]),
  WRITE_ENTRY: record([field('ID'), field('KIND'), field('LENGTH'), field('DESTINATION'), field('WIDTH'), field('HEIGHT'), field('FORMAT'), field('BYTE_OFFSET')]),
  GEOMETRY_KERNEL_HEADER: record([field('VERSION'), field('COUNT'), field('LENGTH'), field('RESERVED')]),
  GEOMETRY_KERNEL_ENTRY: record([field('SOURCE'), field('VERTEX_COUNT'), field('BOUNDS'), field('TANGENTS')]),
  PACKET_HEADER: record([field('VERSION'), field('COUNT'), field('WIDTH'), field('HEIGHT')]),
  PACKET_ENTRY: record([field('ID'), field('KIND'), field('LENGTH'), field('WIDTH'), field('HEIGHT'), field('LAYERS'), field('FORMAT'), field('BYTE_OFFSET')])
};
}
export const resourceIds = {
  AS_CHANGED_BLASES: 53,
  BVH: 1, INSTANCES: 2, ATTRIBUTES: 3, MATERIALS: 4, MAP_INFO: 5, CAMERA: 6, TRACE_UNIFORM: 7, LIGHT_UNIFORM: 8,
  COLOR: 10, NORMAL: 11, ALBEDO: 12, SHADOW_CATCHER: 13, ATLAS: 20, ENVIRONMENT: 21, ENVIRONMENT_CDF: 22,
  BACKGROUND: 23, LIGHT_SAMPLING: 24, ENERGY_LUT: 25, DISPLACEMENT: 26, SOFTWARE_SHADER: 30, METADATA: 31,
  HWRT_SHADER: 33, HIT_SHADER: 34, INDICES: 35, SOFTWARE_PATH_SHADER: 36, HWRT_PATH_SHADER: 37,
  DISPLACEMENT_BOUNDS: 38, SOFTWARE_HIT_SHADER: 39, PRIMITIVE_IDS: 40, AS_POSITIONS: 41, AS_INDICES: 42,
  PATH_EVENTS: 50, PATH_PARAMETERS: 51, QUERY_COUNTS: 52,
  SOFTWARE_FRAME_SHADER: 54, HWRT_FRAME_SHADER: 55
};
export const packetKinds = {BUFFER: 0, TEXTURE: 1, WGSL: 2, METADATA: 3};
export const samplerIds = {MATERIAL: 40};
export const textureFormats = {RGBA8_UNORM: 0, RGBA16_FLOAT: 1, RGBA32_FLOAT: 2, R32_FLOAT: 3, RG32_FLOAT: 4};
export const textureFormatInfo = [
  {id: textureFormats.RGBA8_UNORM, name: 'rgba8unorm', bytes: 4}, {id: textureFormats.RGBA16_FLOAT, name: 'rgba16float', bytes: 8}, {id: textureFormats.RGBA32_FLOAT, name: 'rgba32float', bytes: 16},
  {id: textureFormats.R32_FLOAT, name: 'r32float', bytes: 4}, {id: textureFormats.RG32_FLOAT, name: 'rg32float', bytes: 8}
];
export const rounding = {rangeScale: 255, rangeShift: 8, rangeEpsilon: 1e-6, float32Product: true, float32Difference: true};

interface BindingSchema {name: string; resource: number; kind: 'buffer' | 'texture' | 'sampler'; layout: GPUBindGroupLayoutEntry}
const buffer = (name: string, resource: number, binding: number, type: GPUBufferBindingType): BindingSchema =>
  ({name, resource, kind: 'buffer', layout: {binding, visibility: 4, buffer: {type}}});
const texture = (name: string, resource: number, binding: number, array = false, filter = false): BindingSchema =>
  ({name, resource, kind: 'texture', layout: {binding, visibility: 4, texture: {viewDimension: array ? '2d-array' : '2d', sampleType: filter ? 'float' : 'unfilterable-float'}}});
export const bindGroups = [
  {name: 'SCENE', label: 'Buffers', bindings: [buffer('BVH', resourceIds.BVH, 0, 'read-only-storage'), buffer('INSTANCES', resourceIds.INSTANCES, 1, 'read-only-storage'),
    buffer('ATTRIBUTES', resourceIds.ATTRIBUTES, 2, 'read-only-storage'), buffer('MATERIALS', resourceIds.MATERIALS, 3, 'read-only-storage')]},
  {name: 'TEXTURES', label: 'Textures', bindings: [
    {name: 'SAMPLER', resource: samplerIds.MATERIAL, kind: 'sampler', layout: {binding: 0, visibility: 4, sampler: {}}} as BindingSchema,
    texture('ATLAS', resourceIds.ATLAS, 1, true, true), buffer('MAP_INFO', resourceIds.MAP_INFO, 3, 'uniform'), texture('ENVIRONMENT', resourceIds.ENVIRONMENT, 4),
    texture('ENVIRONMENT_CDF', resourceIds.ENVIRONMENT_CDF, 5), texture('BACKGROUND', resourceIds.BACKGROUND, 6), texture('LIGHT_SAMPLING', resourceIds.LIGHT_SAMPLING, 8),
    texture('ENERGY_LUT', resourceIds.ENERGY_LUT, 9), texture('DISPLACEMENT', resourceIds.DISPLACEMENT, 10)]},
  {name: 'FRAME', label: 'Uniforms', bindings: [buffer('CAMERA', resourceIds.CAMERA, 0, 'uniform'), buffer('TRACE_UNIFORM', resourceIds.TRACE_UNIFORM, 1, 'uniform'), buffer('LIGHT_UNIFORM', resourceIds.LIGHT_UNIFORM, 2, 'uniform')]},
  {name: 'OUTPUT', label: 'Ray Trace Out Buffers', bindings: [buffer('COLOR', resourceIds.COLOR, 0, 'storage'), buffer('NORMAL', resourceIds.NORMAL, 1, 'storage'), buffer('ALBEDO', resourceIds.ALBEDO, 2, 'storage'), buffer('SHADOW_CATCHER', resourceIds.SHADOW_CATCHER, 3, 'storage')]}
];
export const hwrtBindings = {ACCELERATION: 4, INDICES: 5, DIAGNOSTIC: 7, PATH_PARAMETERS: 8};
export function rayTraceBindGroupLayouts(): GPUBindGroupLayoutDescriptor[] {
  return bindGroups.map(group => ({label: group.label, entries: group.bindings.map(binding => binding.layout)}));
}

export function rayTraceUniformOffsets() {
const uniform = makeRayTraceUniform();
const rayTraceUniform = Object.fromEntries(Object.entries(uniform.views).map(([name, view]) =>
  [name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/([A-Z])([A-Z][a-z])/g, '$1_$2').toUpperCase(), view.byteOffset]));
rayTraceUniform.BYTES = uniform.buffer.byteLength;
return rayTraceUniform;
}
export const uniformSizes = {CAMERA_BYTES: 144, LIGHT_BYTES: 64 * 6 * 4 * WORD_BYTES};

// The primary-surface ABI, shared by the trace hook, resolve shader and Rust.
export const framePixelFields = [
  ['noisyColor', 'noisy_color', 'vec4f', 'Linear HDR radiance, alpha 1.'],
  ['normalRoughness', 'normal_roughness', 'vec4f', 'Oriented world shading normal xyz, specular roughness w.'],
  ['positionDepth', 'position_depth', 'vec4f', 'World position xyz, linear camera-forward depth w.'],
  ['geometricNormal', 'geometric_normal', 'vec4f', 'Original unflipped geometric normal xyz, zero w.'],
  ['baseColorMetalness', 'base_color_metalness', 'vec4f', 'Resolved base color; not a directional diffuse reflectance.'],
  ['transmission', 'transmission', 'vec4f', 'Transmission color RGB, transmission weight w.'],
  ['roughnessIor', 'roughness_ior', 'vec4f', 'Roughness xy, incident IOR z and transmitted IOR w.'],
  ['absorption', 'absorption', 'vec4f', 'Medium extinction RGB and medium type w.'],
  ['identity', 'identity', 'vec4u', 'Publication-local instance/primitive indices, thin-wall flag, validity.'],
  ['barycentricsFace', 'barycentrics_face', 'vec4f', 'Barycentrics xy, front-face boolean z, resolved material index w.'],
  ['unclampedRadiance', 'unclamped_radiance', 'vec4f', 'Radiance before per-sample clamping, alpha 1.'],
  ['rngState', 'rng_state', 'vec4u', 'Final RNG words for reproducibility, opaque to consumers.'],
  ['rngDimensions', 'rng_dimensions', 'vec4u', 'Counter, bounce, sample index and seed.'],
  ['diffuseAlbedo', 'diffuse_albedo', 'vec4f', 'Directional reflectance RGB, zero w; REFLECTANCE validity is required.'],
  ['specularAlbedo', 'specular_albedo', 'vec4f', 'Directional reflectance RGB, zero w; REFLECTANCE validity is required.'],
] as const;
