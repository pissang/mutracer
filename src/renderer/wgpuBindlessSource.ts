import {rayTraceBindGroupLayouts} from './sceneLayoutSchema.js';

// Browser-only adaptation of the shared generator. Fail clearly if its sampling
// boundary changes during native refactoring, instead of silently mixing layouts.
export function bindlessShaderSource(source: string, enable: string) {
  const start = source.indexOf('fn decodeMapColor(');
  const end = source.indexOf('fn getMaterialEmission(', start);
  const declarations = /@group\(1\) @binding\(0\) var mapSampler: sampler;[\s\S]*?@group\(1\) @binding\(3\) var<uniform> mapInfo: array<vec4f, NUM_MAPS \* 3>;/;
  if (start < 0 || end < start || !declarations.test(source)) throw new Error('Shared shader material sampling boundary changed.');
  return `enable ${enable};\n` + (source.slice(0, start) + sampling + source.slice(end)).replace(declarations, metadata)
    .replace(/mapInfo\[([^\]\n]+) \+ NUM_MAPS \* 2\]\.x > 0\.5/g, 'materialTextureInfo[$1].resources.z != 0u')
    .replace(/@group\((\d)\) @binding\((\d+)\)/g, (declaration, group: string, binding: string) => {
      const index = Number(group);
      return index === 0 ? declaration : `@group(${index === 1 ? 0 : index - 1}) @binding(${Number(binding) + (index === 1 ? 4 : 0)})`;
    });
}
export function bindlessBindGroupLayouts(): GPUBindGroupLayoutDescriptor[] {
  const layouts = rayTraceBindGroupLayouts().map((layout, group) => group !== 1 ? layout : {
    ...layout, entries: Array.from(layout.entries).filter(e => e.binding !== 0 && e.binding !== 1).map(e =>
      e.binding === 3 ? {binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: {type: 'read-only-storage' as const}} : e)
  });
  // Resource tables consume one of maxBindGroups. Merge scene + textures so
  // the browser optional path still fits a device exposing four groups.
  return [{label: 'Bindless scene', entries: [
    ...layouts[0].entries, ...Array.from(layouts[1].entries).map(e => ({...e, binding: e.binding + 4}))
  ]}, layouts[2], layouts[3]];
}
const metadata = /* wgsl */ `struct MaterialTextureInfo {
  uvTransform: vec4f,
  resources: vec4u,
  extent: vec4u,
};
@group(1) @binding(3) var<storage, read> materialTextureInfo: array<MaterialTextureInfo>;`;
const sampling = /* wgsl */ `fn decodeMapColor(idx: i32, c: vec3f) -> vec3f {
  if (materialTextureInfo[idx].resources.w % 2u == 1u) { return c; }
  return sRGBToLinear(c);
}
fn unpackMaterialIndex(val: i32) -> vec2f {
  return vec2f(f32(val >> 8), f32(val & 0xff) / 255.0);
}
fn getMapSize(idx: i32) -> vec2f { return vec2f(materialTextureInfo[idx].extent.xy); }
fn getMapUvSet(idx: i32, uv: vec2f, uv1: vec2f) -> vec2f {
  return select(uv, uv1, materialTextureInfo[idx].resources.z != 0u);
}
fn sampleMap(idx: i32, uv: vec2f) -> vec4f {
  let info = materialTextureInfo[idx];
  let tex = getResource<texture_2d<f32>>(info.resources.x);
  let samp = getResource<sampler>(info.resources.y);
  var value = uv * info.uvTransform.xy + info.uvTransform.zw;
  if (USE_UDIM_MAPS && info.resources.w > 1u) {
    if (value.x < 0.0 || value.y < 0.0 || value.x >= 10.0 || value.y >= 10.0) { return vec4f(0.0); }
    let halfTexel = 0.5 / vec2f(info.extent.xy);
    let cell = floor(value);
    value = (cell + clamp(fract(value), halfTexel * 10.0, 1.0 - halfTexel * 10.0)) / 10.0;
  }
  return textureSampleLevel(tex, samp, value, 0.0);
}
`;
