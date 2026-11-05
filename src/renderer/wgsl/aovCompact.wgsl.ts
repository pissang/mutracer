// Display-resolution reflectance/depth uses 24 B/px: float depth/hit count
// and two half-packed vec4 reflectances. The default layout stays 64 B/px.
export const aovCompactStorage = /* wgsl */ `
override AOV_COMPACT: bool = false;
fn aovUnpack(value: vec2u) -> vec4f {return vec4f(unpack2x16float(value.x),unpack2x16float(value.y));}
fn aovPack(value: vec4f) -> vec2u {return vec2u(pack2x16float(value.xy),pack2x16float(value.zw));}
`;

export function compactAovReadShader(code: string, declaration: string, type: string): string {
  return aovCompactStorage + code.replace(declaration, `@group(0) @binding(0) var<storage,read> accumulation: array<u32>;
fn loadAov(source: u32) -> ${type} {
  if(AOV_COMPACT){let o=source*6u;return ${type}(vec4f(bitcast<f32>(accumulation[o]),0,0,0),
    vec4f(0,0,0,bitcast<f32>(accumulation[o+1u])),aovUnpack(vec2u(accumulation[o+2u],accumulation[o+3u])),aovUnpack(vec2u(accumulation[o+4u],accumulation[o+5u])));}
  let o=source*16u;
  return ${type}(bitcast<vec4f>(vec4u(accumulation[o],accumulation[o+1u],accumulation[o+2u],accumulation[o+3u])),
    bitcast<vec4f>(vec4u(accumulation[o+4u],accumulation[o+5u],accumulation[o+6u],accumulation[o+7u])),
    bitcast<vec4f>(vec4u(accumulation[o+8u],accumulation[o+9u],accumulation[o+10u],accumulation[o+11u])),
    bitcast<vec4f>(vec4u(accumulation[o+12u],accumulation[o+13u],accumulation[o+14u],accumulation[o+15u])));
}`).split(`let pixel=accumulation[source];`).join(`let pixel=loadAov(source);`).replace(`let pixel = accumulation[index];`, `let pixel = loadAov(index);`);
}

/** Reads compact or default accumulation in an AOV resolve or display shader, selected by the AOV_COMPACT override. */
export function compactAovResolveCode(code: string): string {
  return code.includes(`struct DisplayAovAccum`)
    ? compactAovReadShader(code, `@group(0) @binding(0) var<storage, read> accumulation: array<DisplayAovAccum>;`, `DisplayAovAccum`)
    : compactAovReadShader(code, `@group(0) @binding(0) var<storage,read> accumulation: array<AovResolvedAccumulation>;`, `AovResolvedAccumulation`);
}
