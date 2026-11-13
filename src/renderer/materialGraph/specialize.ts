import type {MaterialShaderHooks} from '../wgsl/materialShaderHooks.js';
// MaterialX 1.39.4 operator semantics: https://github.com/AcademySoftwareFoundation/MaterialX/tree/v1.39.4/libraries/stdlib
// See THIRD_PARTY_NOTICES.md and LICENSES/MaterialX-*.txt.
import {noiseShader} from './noiseShader.js';
import { INSTANCE_VEC4_STRIDE } from '../bvhAccel.js';
import { terminalTypes, width } from './nodes.js';
import {generateGraphIR} from './generate.js';
import {graphCategories, graphTerminals, type GraphIR} from './ir.js';
import {graphInterpreterShader, graphTerminalMask} from './interpreter.js';
function terminalNames(graph: GraphIR) {
    const names: string[]=[];
    for(let i=0;i<graph.terminal.length;i+=3) names.push(graphTerminals[graph.terminal[i]]);
    return names;
}
function hasTerminal(graph: GraphIR, name: string) {return terminalNames(graph).includes(name);}
function hasCategory(graph: GraphIR, names: string[]) {
    for(let i=0;i<graph.nodes.length;i+=5) if(names.includes(graphCategories[graph.nodes[i]])) return true;
    return false;
}
const fields: Record<string, string> = { baseDiffuseRoughness: 'diffuseRoughness', opacity:'alpha' };
/** Interpreted structures in a variant: only their terminal union shapes the source. */
export interface GraphInterpreterOptions { terminals: readonly string[] }
/** Pure shared graph fragments; templates own signatures, call sites and layout.
 * Specialized structures get IDs 1..N; with `interpreter`, negative IDs address a
 * program header record in `materialsBuffer` (see `graphInterpreterShader`). */
export function materialGraphShaderIR(structures: GraphIR[], frames = true, interpreter?: GraphInterpreterOptions): MaterialShaderHooks {
    if (!structures.length && !interpreter) return {};
    const v = (n: number) => `vec${n}f`;
    const mat = '(*ma)', p = (field: string) => `${mat}.${fields[field] ?? field}`;
    const used = Object.keys(terminalTypes).filter(field => structures.some(g => hasTerminal(g, field)) || !!interpreter?.terminals.includes(field));
    const emission = ['emissionColor', 'emissionLuminance', 'coatWeight', 'coatColor'];
    if (used.some(field => emission.includes(field))) for (const field of emission) if (!used.includes(field)) used.push(field);
    const members = used.map(name => {const type=terminalTypes[name];return `  ${name}: ${width(type) === 1 ? 'f32' : v(width(type))},`;}).join('\n');
    let declarations = `struct MXResult {\n${members}\n};\n`;
    declarations += `fn mx_parameter(base: i32, slot: i32) -> vec4f { let m = materialsBuffer[base + slot]; return vec4f(m.color, m.matType); }\n`;
    declarations += `fn mx_image(index: i32, uv: vec2f, fallback: vec4f, color: bool) -> vec4f {
  if(index < 0) { return fallback; } var texel = sampleMap(index, uv);
  if(color) { texel = vec4f(decodeMapColor(index,texel.rgb),texel.a); } return texel;
}
`;
    declarations += graphMathShaderIR(structures, !!interpreter);
    structures.forEach((g, index) => declarations += generateGraphIR(g, `mx_eval_${index + 1}`).source + '\n');
    const matrix = (inverse: boolean) => {
        const columns = Array.from({ length: 4 }, (_, c) => `instancesBuffer[index * ${INSTANCE_VEC4_STRIDE} + ${c + (inverse ? 1 : 5)}]`);
        return `fn mx_${inverse ? 'w2l' : 'l2w'}(index:i32) -> mat4x4f { if(index<0){return mat4x4f(vec4f(1,0,0,0),vec4f(0,1,0,0),vec4f(0,0,1,0),vec4f(0,0,0,1));} return mat4x4f(${columns.join(',')}); }\n`;
    };
    declarations += matrix(true) + matrix(false);
    if (interpreter) declarations += graphInterpreterShader(used);
    const programHeader = (id: string) => `let mx_program = -${id}; let mx_header = vec4f(materialsBuffer[mx_program].color, materialsBuffer[mx_program].matType);`;
    const si = 'mx_si';
    const init = used.map(field => `    mx_result.${field} = ${field === 'normal' ? `${si}.normal` : field === 'emissionColor' ? 'mx_parameter(mx_base, 0).rgb' : field === 'emissionLuminance' ? 'mx_parameter(mx_base, 1).x' : field === 'thinFilmThickness' ? `${p(field)} * 0.001` : p(field)};`).join('\n');
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
    const base = 'i32(materialsBuffer[materialIndex]._padding2)';
    const id = 'i32(materialsBuffer[materialIndex]._padding1)';
    let body = `\n  let mx_id = ${id};\n  if(mx_id ${interpreter ? '!=' : '>'} 0) {\n${frames ? `    ${mat}.anisotropyDirectionEnabled |= 2u;` : ''}\n    let mx_base = ${base};\n    var mx_result: MXResult;\n${init}\n`;
    const tangents = frames ? `normalize(${si}.geometryTangent), normalize(${si}.geometryBitangent)` : `${v(3)}(1.0,0.0,0.0), ${v(3)}(0.0,1.0,0.0)`;
    if (interpreter) {
        const bit = (field: string) => { const [low, high] = graphTerminalMask([field]); return low ? `${low}u` : `${high * 65536}u`; };
        body += `    if(mx_id < 0) {\n      ${programHeader('mx_id')}\n      let mx_mask = u32(mx_header.w) | (u32(materialsBuffer[mx_program].emission.x) << 16u);\n`;
        body += `      mx_run(mx_program + 1, i32(mx_header.x), mx_base + 2, MXContext(uv, uv1, ${si}.position, ${si}.instanceIndex, ${si}.vertexNormal, ${tangents}), &mx_result);\n`;
        for (const field of used)
            if (!['normal', 'opacity', 'emissionColor', 'emissionLuminance'].includes(field))
                body += `      if((mx_mask & ${bit(field)}) != 0u) {\n  ${assignment(field)}      }\n`;
        if (used.includes('normal'))
            body += `      if((mx_mask & ${bit('normal')}) != 0u) { mx_normal = mx_result.normal;\n      ${mat}.coatNormalEnabled = ${mat}.coatWeight > 0.0; }\n`;
        if (used.includes('emissionColor'))
            body += `      if((mx_mask & (${emission.map(bit).join(' | ')})) != 0u) {\n      ${mat}.emission = mx_result.emissionColor * mx_result.emissionLuminance;\n      if(${mat}.materialType == 0) { ${mat}.emission *= mix(${v(3)}(1.0), sqrt(max(mx_result.coatColor, ${v(3)}(0.0))), clamp(mx_result.coatWeight,0.0,1.0)); }\n      }\n`;
        body += '    }\n';
    }
    structures.forEach((g, index) => {
        body += `    if(mx_id == ${index + 1}) {\n      mx_result = mx_eval_${index + 1}(mx_base + 2, uv, uv1, ${si}.position, ${si}.vertexNormal, ${frames ? `normalize(${si}.geometryTangent), normalize(${si}.geometryBitangent)` : `${v(3)}(1.0,0.0,0.0), ${v(3)}(0.0,1.0,0.0)`}, mx_w2l(${si}.instanceIndex), mx_l2w(${si}.instanceIndex), mx_result);\n`;
        for (const field of terminalNames(g))
            if (!['normal', 'opacity', 'emissionColor', 'emissionLuminance'].includes(field))
                body += assignment(field);
        if (hasTerminal(g, 'normal'))
            body += `      mx_normal = mx_result.normal;\n      ${mat}.coatNormalEnabled = ${mat}.coatWeight > 0.0;\n`;
        if (['emissionColor', 'emissionLuminance', 'coatWeight', 'coatColor'].some(field => hasTerminal(g,field)))
            body += `      ${mat}.emission = mx_result.emissionColor * mx_result.emissionLuminance;\n      if(${mat}.materialType == 0) { ${mat}.emission *= mix(${v(3)}(1.0), sqrt(max(mx_result.coatColor, ${v(3)}(0.0))), clamp(mx_result.coatWeight,0.0,1.0)); }\n`;
        body += '    }\n';
    });
    body += `  }\n`;
    let opacity = false;
    if(used.includes('opacity')) {
        opacity = true;
        const zero=(type:string)=>width(terminalTypes[type])===1?'0.0':`${v(width(terminalTypes[type]))}(0.0)`;
        const init=used.map(field=>`  result.${field} = ${field==='opacity'?'fallback':zero(field)};`).join('\n');
        const materialId='i32(materialsBuffer[materialIndex]._padding1)';
        const parameterBase='i32(materialsBuffer[materialIndex]._padding2)';
        let helper=`fn mx_opacity(materialIndex:i32,uv:vec2f,uv1:vec2f,position:vec3f,instanceIndex:i32,fallback:f32) -> f32 {\n  var result:MXResult;\n${init}\n`;
        if(interpreter)helper+=`  if(${materialId} < 0) { ${programHeader(materialId)} if(mx_header.y > 0.0) { mx_run(mx_program + 1 + i32(mx_header.x), i32(mx_header.y), ${parameterBase} + 2, MXContext(uv, uv1, position, instanceIndex, ${v(3)}(0.0,0.0,1.0), ${v(3)}(1.0,0.0,0.0), ${v(3)}(0.0,1.0,0.0)), &result); } }\n`;
        structures.forEach((g,i)=>{if(hasTerminal(g, 'opacity'))helper+=`  if(${materialId} == ${i+1}) { result=mx_eval_${i+1}(${parameterBase}+2,uv,uv1,position,${v(3)}(0.0,0.0,1.0),${v(3)}(1.0,0.0,0.0),${v(3)}(0.0,1.0,0.0),mx_w2l(instanceIndex),mx_l2w(instanceIndex),result); }\n`;});
        helper+='  return clamp(result.opacity,0.0,1.0);\n}\n';
        const uv=(secondary:boolean)=>`(bary.x * ${secondary?'vertexUv1':'vertexUv'}(index.x) + bary.y * ${secondary?'vertexUv1':'vertexUv'}(index.y) + bary.z * ${secondary?'vertexUv1':'vertexUv'}(index.z)) * materialsBuffer[materialIndex].uvScale`;
        helper+=`fn mx_shadow_opacity(materialIndex:i32,index:vec3i,bary:vec3f,position:vec3f,instanceIndex:i32,fallback:f32) -> f32 { return mx_opacity(materialIndex,${uv(false)},${uv(true)},(mx_l2w(instanceIndex)*vec4f(position,1.0)).xyz,instanceIndex,fallback); }\n`;
        declarations+=helper;
    }
    const lightEmission=emission.some(field=>used.includes(field));
    if(lightEmission) {
        const zero=(field:string)=>width(terminalTypes[field])===1?'0.0':`${v(width(terminalTypes[field]))}(0.0)`;
        const init=used.map(field=>`  result.${field} = ${field==='emissionColor'?'mx_parameter(base,0).rgb':field==='emissionLuminance'?'mx_parameter(base,1).x':field==='coatColor'?'data.coatColor':field==='coatWeight'?'coatWeight':zero(field)};`).join('\n');
        declarations+=`fn mx_emission(materialIndex:i32,uv:vec2f,uv1:vec2f,position:vec3f,instanceIndex:i32,fallback:vec3f) -> vec3f {
  let data=materialsBuffer[materialIndex];
  let id=i32(data._padding1); let base=i32(data._padding2);
  var coatWeight=data.coatWeight;
  if(USE_COAT_WEIGHT_MAPS && data.coatWeightMapIndex>=0.0) { let index=i32(data.coatWeightMapIndex); coatWeight*=sampleMap(index,getMapUvSet(index,uv,uv1)).r; }
  var result:MXResult;
${init}
`;
        if(interpreter)declarations+=`  if(id < 0) {
    ${programHeader('id')}
    if(mx_header.z > 0.0) {
      mx_run(mx_program + 1 + i32(mx_header.x) + i32(mx_header.y), i32(mx_header.z), base + 2, MXContext(uv, uv1, position, instanceIndex, vec3f(0,0,1), vec3f(1,0,0), vec3f(0,1,0)), &result);
      var value=result.emissionColor*result.emissionLuminance;
      if(data.matType==0.0) { value*=mix(vec3f(1),sqrt(max(result.coatColor,vec3f(0))),clamp(result.coatWeight,0.0,1.0)); }
      return value;
    }
  }
`;
        structures.forEach((g,i)=>{if(emission.some(field=>hasTerminal(g,field)))declarations+=`  if(id==${i+1}) {
    result=mx_eval_${i+1}(base+2,uv,uv1,position,vec3f(0,0,1),vec3f(1,0,0),vec3f(0,1,0),mx_w2l(instanceIndex),mx_l2w(instanceIndex),result);
    var value=result.emissionColor*result.emissionLuminance;
    if(data.matType==0.0) { value*=mix(vec3f(1),sqrt(max(result.coatColor,vec3f(0))),clamp(result.coatWeight,0.0,1.0)); }
    return value;
  }
`;});
        declarations+='  return fallback;\n}\n';
    }
    return {graph: {declarations, evaluate: body, opacity, emission:lightEmission, ...(interpreter ? {interpreter: true} : {})}};
}

/** Pure MaterialX helpers shared by surface rendering and UV height baking. */
export function graphMathShaderIR(structures:readonly GraphIR[], all = false) {
    let declarations=`fn mx_rotate(p: vec2f, degrees: f32) -> vec2f { let a=degrees*0.017453292519943295; return vec2f(cos(a)*p.x-sin(a)*p.y,sin(a)*p.x+cos(a)*p.y); }
fn mx_place2d(uv:vec2f,pivot:vec2f,scale:vec2f,angle:f32,offset:vec2f,order:f32) -> vec2f {
  if(order<0.5) { return mx_rotate((uv-pivot)/scale,angle)-offset+pivot; }
  return mx_rotate(uv-pivot-offset,angle)/scale+pivot;
}
fn mx_normalmap(value:vec3f,scale:vec2f,n:vec3f,t:vec3f,b:vec3f) -> vec3f {
  var d=value*2.0-1.0; if(dot(value,value)==0.0){d=vec3f(0.0,0.0,1.0);}
  return normalize(t*d.x*scale.x+b*d.y*scale.y+n*d.z);
}
`;
    // HSV thresholds follow MaterialX 1.39.4's OSL-derived operators. See
    // LICENSES/MaterialX-OSL-BSD-3-Clause.txt and THIRD_PARTY_NOTICES.md.
    if (all || structures.some(g => hasCategory(g, ['rgbtohsv','hsvtorgb','hsvadjust']))) {
        declarations += `fn mx_hsvtorgb(value:vec3f) -> vec3f {
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
`;
    }
    if(all || structures.some(g=>hasCategory(g, ['noise2d','noise3d','fractal3d','cellnoise2d','cellnoise3d','worleynoise2d','worleynoise3d']))) declarations += noiseShader();
    if(all || structures.some(g => hasCategory(g, ['rotate3d']))) {
        declarations += `fn mx_rotate3d(p:vec3f,degrees:f32,axis:vec3f) -> vec3f {
  let n=normalize(axis);let a=degrees*0.017453292519943295;let c=cos(a);let s=sin(a);
  return p*c-cross(n,p)*s+n*dot(n,p)*(1.0-c);
}
`;
    }
    return declarations;
}
