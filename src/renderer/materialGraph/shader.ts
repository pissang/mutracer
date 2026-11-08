// MaterialX 1.39.4 operator semantics: https://github.com/AcademySoftwareFoundation/MaterialX/tree/v1.39.4/libraries/stdlib
// See THIRD_PARTY_NOTICES.md and LICENSES/MaterialX-*.txt.
import { INSTANCE_VEC4_STRIDE } from '../bvhAccel.js';
import { terminalTypes, width } from './nodes.js';
import { generateGraph, type Backend } from './codegen.js';
import type { GraphPlan } from './state.js';
const fields: Record<string, string> = { baseDiffuseRoughness: 'diffuseRoughness' };
/** Browser-only specialization leaves the native/shared generators byte-identical.
 * Explicit anchors fail closed if a generator's material boundary changes. */
export function materialGraphShader(source: string, plan: GraphPlan, backend: Backend) {
    if (!plan.key)
        return source;
    if (backend === 'webgl')
        source = source.replace('#if defined(NUM_DIFFUSE_MAPS)', '#if 1 || defined(NUM_DIFFUSE_MAPS)');
    const wg = backend === 'webgpu', v = (n: number) => `vec${n}${wg ? 'f' : ''}`;
    const mat = wg ? '(*ma)' : 'mat', p = (field: string) => `${mat}.${fields[field] ?? field}`;
    source=source.replace('struct OpenPbrResolvedMaterial {',`struct OpenPbrResolvedMaterial {\n  ${wg?'mxGraphFrame: bool,':'bool mxGraphFrame;'}`);
    const basisAnchor='    prepared.coatBasis = prepared.basis;';
    if(!source.includes(basisAnchor))throw new Error('Material graph BSDF frame anchor changed');
    source=source.replace(basisAnchor,`    if(material.mxGraphFrame && max(material.specularAnisotropy,material.coatAnisotropy)>0.0) {
      prepared.basis = openpbr_direction_basis(prepared.basis, material.geometryTangent, material.geometryBitangent, ${v(2)}(1.0,0.0));
    }
`+basisAnchor);
    const members = Object.entries(terminalTypes).map(([name, type]) => wg ? `  ${name}: ${width(type) === 1 ? 'f32' : v(width(type))},` : `  ${width(type) === 1 ? 'float' : v(width(type))} ${name};`).join('\n');
    let declarations = wg ? `struct MXResult {\n${members}\n};\n` : `struct MXResult {\n${members}\n};\n`;
    declarations += wg ? `fn mx_parameter(base: i32, slot: i32) -> vec4f { let m = materialsBuffer[base + slot]; return vec4f(m.color, m.matType); }\n` : `vec4 mx_parameter(int base, int slot) { return fetchMatData((base + slot) * MAT_DATA_SIZE); }\n`;
    declarations += wg ? `fn mx_image(index: i32, uv: vec2f, fallback: vec4f, color: bool) -> vec4f {
  if(index < 0) { return fallback; } var texel = sampleMap(index, uv);
  if(color) { texel = vec4f(decodeMapColor(index,texel.rgb),texel.a); } return texel;
}
fn mx_rotate(p: vec2f, degrees: f32) -> vec2f { let a=degrees*0.017453292519943295; return vec2f(cos(a)*p.x-sin(a)*p.y,sin(a)*p.x+cos(a)*p.y); }
fn mx_place2d(uv:vec2f,pivot:vec2f,scale:vec2f,angle:f32,offset:vec2f,order:f32) -> vec2f {
  if(order<0.5) { return mx_rotate((uv-pivot)/scale,angle)-offset+pivot; }
  return mx_rotate(uv-pivot-offset,angle)/scale+pivot;
}
fn mx_normalmap(value:vec3f,scale:vec2f,n:vec3f,t:vec3f,b:vec3f) -> vec3f {
  var d=value*2.0-1.0; if(dot(value,value)==0.0){d=vec3f(0.0,0.0,1.0);}
  return normalize(t*d.x*scale.x+b*d.y*scale.y+n*d.z);
}
` : `vec4 mx_image(int index,vec2 uv,vec4 fallback,bool color) {
#ifdef NUM_MAPS
  if(index < 0) { return fallback; } vec4 texel = sampleMap(index,uv);
  if(color) { texel.rgb=decodeMapColor(index,texel.rgb); } return texel;
#else
  return fallback;
#endif
}
vec2 mx_rotate(vec2 p,float degrees) { float a=degrees*0.017453292519943295; return vec2(cos(a)*p.x-sin(a)*p.y,sin(a)*p.x+cos(a)*p.y); }
vec2 mx_place2d(vec2 uv,vec2 pivot,vec2 scale,float angle,vec2 offset,float order) {
  if(order<0.5) { return mx_rotate((uv-pivot)/scale,angle)-offset+pivot; }
  return mx_rotate(uv-pivot-offset,angle)/scale+pivot;
}
vec3 mx_normalmap(vec3 value,vec2 scale,vec3 n,vec3 t,vec3 b) {
  vec3 d=value*2.0-1.0;if(dot(value,value)==0.0){d=vec3(0.0,0.0,1.0);}
  return normalize(t*d.x*scale.x+b*d.y*scale.y+n*d.z);
}
`;
    // HSV thresholds follow MaterialX 1.39.4's OSL-derived operators. See
    // LICENSES/MaterialX-OSL-BSD-3-Clause.txt and THIRD_PARTY_NOTICES.md.
    if (plan.structures.some(g => g.nodes.some(n => n.category === 'rgbtohsv' || n.category === 'hsvtorgb'))) {
        declarations += wg ? `fn mx_hsvtorgb(value:vec3f) -> vec3f {
  if(value.y<0.0001){return vec3f(value.z);}
  let h=fract(value.x)*6.0;
  let wave=abs((vec3f(h)+vec3f(0.0,4.0,2.0))-6.0*floor((vec3f(h)+vec3f(0.0,4.0,2.0))/6.0)-3.0)-1.0;
  return value.z*mix(vec3f(1.0),clamp(wave,vec3f(0.0),vec3f(1.0)),vec3f(value.y));
}
fn mx_rgbtohsv(value:vec3f) -> vec3f {
  let high=max(value.x,max(value.y,value.z));let low=min(value.x,min(value.y,value.z));let delta=high-low;
  var saturation=0.0;if(high>0.0){saturation=delta/high;}if(saturation<=0.0){return vec3f(0.0,saturation,high);}
  var hue=(value.y-value.z)/delta;
  if(value.x<high){if(value.y>=high){hue=2.0+(value.z-value.x)/delta;}else{hue=4.0+(value.x-value.y)/delta;}}
  hue/=6.0;if(hue<0.0){hue+=1.0;}return vec3f(hue,saturation,high);
}
` : `vec3 mx_hsvtorgb(vec3 value) {
  if(value.y<0.0001){return vec3(value.z);}
  float h=fract(value.x)*6.0;
  vec3 wave=abs(mod(vec3(h)+vec3(0.0,4.0,2.0),6.0)-3.0)-1.0;
  return value.z*mix(vec3(1.0),clamp(wave,0.0,1.0),value.y);
}
vec3 mx_rgbtohsv(vec3 value) {
  float high=max(value.x,max(value.y,value.z)),low=min(value.x,min(value.y,value.z)),delta=high-low;
  float saturation=high>0.0?delta/high:0.0;if(saturation<=0.0){return vec3(0.0,saturation,high);}
  float hue=(value.y-value.z)/delta;
  if(value.x<high){if(value.y>=high){hue=2.0+(value.z-value.x)/delta;}else{hue=4.0+(value.x-value.y)/delta;}}
  hue/=6.0;if(hue<0.0){hue+=1.0;}return vec3(hue,saturation,high);
}
`;
    }
    plan.structures.forEach((g, index) => declarations += generateGraph(g, backend, `mx_eval_${index + 1}`).source + '\n');
    const matrix = (inverse: boolean) => {
        const columns = Array.from({ length: 4 }, (_, c) => wg ? `instancesBuffer[index * ${INSTANCE_VEC4_STRIDE} + ${c + (inverse ? 1 : 5)}]` : `fetchIns(index * ${INSTANCE_VEC4_STRIDE} + ${c + (inverse ? 1 : 5)})`);
        return wg ? `fn mx_${inverse ? 'w2l' : 'l2w'}(index:i32) -> mat4x4f { if(index<0){return mat4x4f(vec4f(1,0,0,0),vec4f(0,1,0,0),vec4f(0,0,1,0),vec4f(0,0,0,1));} return mat4x4f(${columns.join(',')}); }\n` : `mat4 mx_${inverse ? 'w2l' : 'l2w'}(int index) { if(index<0){return mat4(1.0);}return mat4(${columns.join(',')}); }\n`;
    };
    declarations += (wg ? '' : 'vec4 fetchIns(int i);\n') + matrix(true) + matrix(false);
    if (wg)
        source = source.replace('if (directionMaterial.anisotropyMapIndex >= 0.0', 'if (directionMaterial._padding1 > 0.0 || directionMaterial.anisotropyMapIndex >= 0.0');
    else
        source = source.replace('if (directionMaterial.x >= 0.0', 'if (fetchMatData(si.materialIndex * MAT_DATA_SIZE + MAT_ROW_ALPHA).x > 0.0 || directionMaterial.x >= 0.0');
    // The context travels with each getMaterial call, never mutable shader globals.
    const signature = wg ? '  vertexColor: vec3f\n) {' : '  vec3 vertexColor\n) {';
    if (!source.includes(signature))
        throw new Error('Material graph getMaterial signature anchor changed');
    source = source.replace(signature, wg ? '  vertexColor: vec3f, mx_si: ptr<function, SurfaceInteraction>\n) {' : '  vec3 vertexColor, inout SurfaceInteraction mx_si\n) {');
    source = source.replace(/getMaterial\(([^;\n]+)\.vertexColor\);/g, (_match, args: string) => {
        const si = args.slice(args.lastIndexOf(',') + 1).trim();
        return `getMaterial(${args}.vertexColor, ${wg ? (si === '(*si)' ? 'si' : `&${si}`) : si});`;
    });
    const si = wg ? '(*mx_si)' : 'mx_si';
    const init = Object.keys(terminalTypes).map(field => `    mx_result.${field} = ${field === 'normal' ? `${si}.normal` : field === 'emissionColor' ? 'mx_parameter(mx_base, 0).rgb' : field === 'emissionLuminance' ? 'mx_parameter(mx_base, 1).x' : field === 'thinFilmThickness' ? `${p(field)} * 0.001` : p(field)};`).join('\n');
    const assignment = (field: string) => {
        let value = `mx_result.${field}`;
        if (['baseWeight', 'baseMetalness', 'baseDiffuseRoughness', 'specularAnisotropy', 'transmissionWeight', 'fuzzWeight', 'fuzzRoughness', 'coatWeight', 'coatAnisotropy', 'coatDarkening', 'thinFilmWeight'].includes(field))
            value = `clamp(${value},0.0,1.0)`;
        if (['specularWeight', 'specularColor', 'transmissionColor', 'fuzzColor', 'coatColor'].includes(field))
            value = `max(${value},${width(terminalTypes[field]) === 1 ? '0.0' : v(3) + '(0.0)'})`;
        if (field === 'coatIor')
            value = `max(${value},1.0)`;
        if (field === 'coatRoughness')
            value = `clamp(${value},ROUGHNESS_MIN,1.0)`;
        if (field === 'thinFilmThickness')
            value += ' * 1000.0';
        return `      ${p(field)} = ${value};\n`;
    };
    const base = wg ? 'i32(materialsBuffer[materialIndex]._padding2)' : `int(fetchMatData(i + MAT_ROW_ALPHA).y)`;
    const id = wg ? 'i32(materialsBuffer[materialIndex]._padding1)' : `int(fetchMatData(i + MAT_ROW_ALPHA).x)`;
    let body = `\n  ${mat}.mxGraphFrame = false;\n  ${wg ? 'let' : 'int'} mx_id = ${id};\n  if(mx_id > 0) {\n    ${mat}.mxGraphFrame = true;\n    ${wg ? 'let' : 'int'} mx_base = ${base};\n    ${wg ? 'var mx_result: MXResult' : 'MXResult mx_result'};\n${init}\n`;
    plan.structures.forEach((g, index) => {
        body += `    if(mx_id == ${index + 1}) {\n      mx_result = mx_eval_${index + 1}(mx_base + 2, uv, uv1, ${si}.position, ${si}.vertexNormal, normalize(${si}.geometryTangent), normalize(${si}.geometryBitangent), mx_w2l(${si}.instanceIndex), mx_l2w(${si}.instanceIndex), mx_result);\n`;
        for (const field of Object.keys(g.terminal))
            if (!['normal', 'emissionColor', 'emissionLuminance'].includes(field))
                body += assignment(field);
        if ('normal' in g.terminal)
            body += `      ${si}.normal = mx_result.normal;\n${wg ? '' : '#ifdef USE_COAT_NORMAL_FRAMES\n'}      ${mat}.coatNormalEnabled = ${mat}.coatWeight > 0.0;\n${wg ? '' : '#endif\n'}`;
        if (['emissionColor', 'emissionLuminance', 'coatWeight', 'coatColor'].some(field => field in g.terminal))
            body += `      ${mat}.emission = mx_result.emissionColor * mx_result.emissionLuminance;\n      if(${mat}.materialType == 0) { ${mat}.emission *= mix(${v(3)}(1.0), sqrt(max(mx_result.coatColor, ${v(3)}(0.0))), clamp(mx_result.coatWeight,0.0,1.0)); }\n`;
        body += '    }\n';
    });
    body += `  }\n`;
    const anchor = '  // OpenPBR 1.1.1: coat refraction broadens all base microfacet lobes.';
    if (!source.includes(anchor))
        throw new Error('Material graph evaluation anchor changed');
    source = source.replace(anchor, body + anchor);
    // Emissive triangle sampling only needs emission. Preserve the six-argument
    // GLSL overload for constant emitters in scenes containing graph materials.
    if (!wg) {
        const boundary = '\n#if defined(NUM_NORMAL_MAPS)';
        const overload = `
void getMaterial(inout OpenPbrResolvedMaterial mat,int materialIndex,vec2 uv,vec2 uv1,int instanceIndex,vec3 vertexColor) {
  SurfaceInteraction si;si.position=vec3(0.0);si.normal=vec3(0.0,0.0,1.0);si.vertexNormal=si.normal;
  si.geometryTangent=vec3(1.0,0.0,0.0);si.geometryBitangent=vec3(0.0,1.0,0.0);si.instanceIndex=-1;
  getMaterial(mat,materialIndex,uv,uv1,instanceIndex,vertexColor,si);
}
`;
        if (!source.includes(boundary))
            throw new Error('Material graph GLSL overload anchor changed');
        source = source.replace(boundary, '\n' + overload + boundary);
    }
    // Declarations follow sampleMap and precede getMaterial for GLSL declaration order.
    const declaration = wg ? 'fn getMaterial(\n' : 'void getMaterial(\n';
    return source.replace(declaration, declarations + '\n' + declaration);
}
