import {describe, expect, it} from 'vitest';
import MaterialGraph, {type MaterialGraphInput as Input, type MaterialGraphType as Type} from '../../src/scene/MaterialGraph.js';
import {normalizeGraph} from '../../src/renderer/materialGraph/normalize.js';
import {evaluateGraph} from '../../src/renderer/materialGraph/evaluate.js';
import Texture from '../../src/scene/Texture.js';
import noiseReference from '../fixtures/material-graph-noise.json';
import {evaluateNoise} from '../../src/renderer/materialGraph/noise.js';
import {MaterialGraphState} from '../../src/renderer/materialGraph/state.js';
import OpenPBRMaterial from '../../src/scene/OpenPBRMaterial.js';
import {MATERIAL_FLOAT_COUNT,materialLayoutFields} from '../../src/renderer/materialLayoutSchema.js';
import {generateGraph} from '../../src/renderer/materialGraph/codegen.js';
const f=(value:number):Input=>({type:'float',value});
const v=(value:number[],type:Type='vector3'):Input=>({type,value});
function run(category:string, inputs:Record<string,Input>, type:Type='float') {
    const graph=normalizeGraph(new MaterialGraph({nodes:[{id:'n',category,type,inputs},{id:'c',category:'convert',type:'color3',inputs:{in:{type,connection:{node:'n'}}}}],terminal:{baseColor:{node:'c'}}}));
    expect(graph.diagnostics).toEqual([]);
    for(const backend of ['webgpu','webgl'] as const) generateGraph(graph,backend);
    return evaluateGraph(graph).baseColor;
}
describe('MaterialX adjustment and geometry nodes',()=>{
    it.each([
        ['dot',{in:f(0.7),note:{type:'string',value:'author note'}},0.7],
        ['extract',{in:v([0.2,0.4,0.6]),index:{type:'integer',value:2}},0.6],
        ['invert',{in:f(0.3),amount:f(0.8)},0.5],
        ['remap',{in:f(3),inlow:f(1),inhigh:f(5),outlow:f(-2),outhigh:f(6)},2],
        ['range',{in:f(-0.25),gamma:f(2)},-0.5],
        ['range',{in:f(-0.25),gamma:f(2),doclamp:{type:'boolean',value:true}},0],
        ['smoothstep',{in:f(0.25)},0.15625],
        ['smoothstep',{in:f(0.5),low:f(0.5),high:f(0.5)},1],
        ['smoothstep',{in:f(0.2),low:f(0.5),high:f(0.5)},0],
        ['contrast',{in:f(0.2),amount:f(2),pivot:f(0.5)},-0.1],
        ['ramplr',{valuel:f(0.2),valuer:f(0.8),texcoord:v([-1,2],'vector2')},0.2],
        ['ramptb',{valuet:f(0.2),valueb:f(0.8),texcoord:v([-1,2],'vector2')},0.8],
        ['ramp4',{valuetl:f(0),valuetr:f(0.4),valuebl:f(0.8),valuebr:f(1),texcoord:v([0.5,0.5],'vector2')},0.55],
        ['splitlr',{valuel:f(0.2),valuer:f(0.8),texcoord:v([0.5,0],'vector2')},0.8],
        ['splittb',{valuet:f(0.2),valueb:f(0.8),texcoord:v([0,0.49],'vector2')},0.2],
        ['burn',{fg:f(0),bg:f(0.7),mix:f(0)},0],
        ['dodge',{fg:f(1),bg:f(0.7),mix:f(0)},0],
        ['screen',{fg:f(0.2),bg:f(0.3)},0.44],
        ['overlay',{fg:f(0.2),bg:f(0.8)},0.68],
        ['difference',{fg:f(0.2),bg:f(0.8)},0.6],
        ['plus',{fg:f(0.2),bg:f(0.8)},1],
        ['minus',{fg:f(0.2),bg:f(0.8)},0.6],
        ['atan2',{iny:f(1),inx:f(-1)},3*Math.PI/4],
        ['tan',{in:f(Math.PI/4)},1],['asin',{in:f(1)},Math.PI/2],['acos',{in:f(-1)},Math.PI],
    ] as [string,Record<string,Input>,number][])('%s matches stdlib', (c,a,want)=>{
        run(c,a).forEach(x=>expect(x).toBeCloseTo(want,7));
    });
    it('supports scalar and per-component adjustment variants',()=>{
        for(const type of ['color3','color4','vector2','vector3','vector4'] as Type[]) {
            const n=type.endsWith('2')?2:type.endsWith('4')?4:3, val=Array(n).fill(0.25);
            for(const [category,extra,want] of [
                ['invert',{amount:f(1)},0.75],['remap',{outhigh:f(2)},0.5],
                ['range',{gamma:f(2)},0.5],['smoothstep',{},0.15625],['contrast',{amount:f(2)},0]
            ] as [string,Record<string,Input>,number][]) {
                run(category,{in:v(val,type),...extra},type).slice(0,Math.min(n,3)).forEach(x=>expect(x).toBeCloseTo(want));
                const per=Object.fromEntries(Object.entries(extra).map(([k,a])=>[k,v(Array(n).fill(a.value),type)]));
                run(category,{in:v(val,type),...per},type).slice(0,Math.min(n,3)).forEach(x=>expect(x).toBeCloseTo(want));
            }
        }
    });
    it('uses ACEScg luminance and preserves alpha',()=>{
        expect(run('luminance',{in:v([1,0,0],'color3')},'color3')).toEqual(Array(3).fill(0.2722287));
        const graph=normalizeGraph(new MaterialGraph({nodes:[{id:'l',category:'luminance',type:'color4',inputs:{in:v([0,1,0,0.2],'color4')}},{id:'alpha',category:'extract',type:'float',inputs:{in:{type:'color4',connection:{node:'l'}},index:{type:'integer',value:3}}}],terminal:{opacity:{node:'alpha'}}}));
        expect(graph.diagnostics).toEqual([]);expect(evaluateGraph(graph).opacity).toEqual([0.2]);
    });
    it('rotates in degrees about a normalized axis',()=>{
        const x=run('rotate2d',{in:v([1,0],'vector2'),amount:f(90)},'vector2');
        expect(x[0]).toBeCloseTo(0);expect(x[1]).toBeCloseTo(-1);
        const y=run('rotate3d',{in:v([1,0,0]),amount:f(90),axis:v([0,0,2])},'vector3');
        expect(y[0]).toBeCloseTo(0);expect(y[1]).toBeCloseTo(-1);
    });
    it('transforms points, vectors and inverse-transpose normals',()=>{
        const objectToWorld=[2,0,0,0,0,3,0,0,0,0,4,0,5,6,7,1];
        const worldToObject=[0.5,0,0,0,0,1/3,0,0,0,0,0.25,0,-2.5,-2,-1.75,1];
        for(const [category,want] of [['transformpoint',[7,9,11]],['transformvector',[2,3,4]],['transformnormal',[0.5,1/3,0.25]]] as const){
            const graph=normalizeGraph(new MaterialGraph({nodes:[{id:'n',category,type:'vector3',inputs:{in:v([1,1,1]),fromspace:{type:'string',value:'object'},tospace:{type:'string',value:'world'}}}],terminal:{normal:{node:'n'}}}));
            expect(graph.diagnostics).toEqual([]);
            const expected=category==='transformnormal'?want.map(x=>x/Math.hypot(...want)):want;
            expect(evaluateGraph(graph,{objectToWorld,worldToObject}).normal).toEqual(expected);
            graph.parameters[graph.nodes[0].inputs.tospace.slot!]='object';
            expect(evaluateGraph(graph,{objectToWorld,worldToObject}).normal).toEqual(category==='transformnormal'?Array(3).fill(1/Math.sqrt(3)):[1,1,1]);
        }
    });
    it('keeps parameter edits out of structural hashes',()=>{
        const graph=new MaterialGraph({nodes:[{id:'n',category:'range',type:'float'}],terminal:{specularRoughness:{node:'n'}}});
        const first=normalizeGraph(graph);graph.setInput('n','gamma',f(2));graph.setInput('n','doclamp',{type:'boolean',value:true});
        const second=normalizeGraph(graph);expect(second.key).toBe(first.key);
        for(const backend of ['webgpu','webgl'] as const)expect(generateGraph(first,backend).source).toBe(generateGraph(second,backend).source);
    });
});

// Reference numbers captured from the unmodified MaterialX 1.39.4
// libraries/stdlib/genglsl/lib/mx_noise.glsl, rendered to an RGBA32F target.
describe('MaterialX OSL noise reference',()=>{
    it.each(noiseReference)('$category / $n at $p, style $style', row=>{
        const a={amplitude:[1],pivot:[0],octaves:[3],lacunarity:[2],diminish:[0.5],jitter:[1],style:[row.style]};
        const actual=evaluateNoise(row.category,row.p,row.n,a);
        actual.forEach((x,i)=>expect(Math.abs(x-row.reference[i])).toBeLessThan(3e-6));
    });
    it('scales amplitude, adds pivot, and returns zero for zero octaves',()=>{
        expect(evaluateNoise('noise2d',[0.37,0.61],1,{amplitude:[0],pivot:[0.4]})).toEqual([0.4]);
        expect(evaluateNoise('fractal3d',[0.37,0.61,0.29],4,{amplitude:[1],octaves:[0],lacunarity:[2],diminish:[0.5]})).toEqual([0,0,0,0]);
    });
});
describe('opacity graph commits',()=>{
    it('resolves auto graph coverage conservatively and retains explicit opaque',()=>{
        const graph=new MaterialGraph({nodes:[{id:'a',category:'constant',type:'float',inputs:{value:f(0.3)}}],terminal:{geometryOpacity:{node:'a'}}});
        const material=new OpenPBRMaterial({graph}),state=new MaterialGraphState('webgpu');state.request([material]);
        expect(state.diagnostics).toEqual([]);state.install(state.requested,state.revision);
        const offset=materialLayoutFields().find(f=>f.name==='alphaMode')!.offset/4;
        expect(state.pack(new Float32Array(MATERIAL_FLOAT_COUNT),[])[offset]).toBe(2);
        material.alphaMode='opaque';state.request([material]);
        expect(state.pack(new Float32Array(MATERIAL_FLOAT_COUNT),[])[offset]).toBe(0);
        const key=normalizeGraph(graph).key;graph.setInput('a','value',f(0.9));expect(normalizeGraph(graph).key).toBe(key);
    });
    it('rejects unsupported material projection for UV-dependent opacity',()=>{
        const graph=new MaterialGraph({nodes:[{id:'uv',category:'texcoord',type:'vector2'},{id:'a',category:'extract',type:'float',inputs:{in:{type:'vector2',connection:{node:'uv'}}}}],terminal:{opacity:{node:'a'}}});
        const state=new MaterialGraphState('webgpu'),material=new OpenPBRMaterial({graph});state.request([material]);state.install(state.requested,state.revision);material.uvProjection='triplanar';state.request([material]);expect(state.diagnostics).toContainEqual(expect.objectContaining({code:'unsupported-opacity-projection',port:'opacity'}));expect(state.requested.graphs[0]).toBeUndefined();expect(state.pack(new Float32Array(MATERIAL_FLOAT_COUNT),[])).toEqual(new Float32Array(MATERIAL_FLOAT_COUNT));
    });
    it('locates frame-dependent shadow coverage rather than accepting inconsistent shadows',()=>{
        const graph=new MaterialGraph({nodes:[{id:'n',category:'normal',type:'vector3'},{id:'a',category:'extract',type:'float',inputs:{in:{type:'vector3',connection:{node:'n'}}}}],terminal:{opacity:{node:'a'}}});
        const state=new MaterialGraphState('webgpu');state.request([new OpenPBRMaterial({graph})]);
        expect(state.diagnostics).toContainEqual(expect.objectContaining({code:'unsupported-opacity-context',node:'n',port:'opacity'}));
        state.request([new OpenPBRMaterial({graph,alphaMode:'opaque'})]);expect(state.diagnostics).toEqual([]);
    });
});

describe('glTF MaterialX image nodes',()=>{
 it.each([0,1])('applies glTF UV transforms in operation order %s',order=>{
  const texture=new Texture({width:1,height:1,data:new Uint8Array([128,128,255,255])});
  const g=normalizeGraph(new MaterialGraph({nodes:[{id:'image',category:'gltf_image',type:'color3',inputs:{file:{type:'filename',value:texture},texcoord:v([0.25,0.75],'vector2'),scale:v([2,3],'vector2'),offset:v([0.1,0.2],'vector2'),operationorder:{type:'integer',value:order}}}],terminal:{baseColor:{node:'image'}}}));
  expect(g.diagnostics).toEqual([]);const actual=evaluateGraph(g,{sample:(_t,uv)=>[...uv,0,1]}).baseColor;
  expect(actual[0]).toBeCloseTo(order===0?0.6:0.7);expect(actual[1]).toBeCloseTo(order===0?0.05:-0.35);
 });
 it('exposes independent color and alpha ports with both factors',()=>{
  const g=normalizeGraph(new MaterialGraph({nodes:[{id:'image',category:'gltf_colorimage',type:'color4',inputs:{default:v([0.2,0.4,0.6,0.8],'color4'),color:v([2,2,2,0.5],'color4'),geomcolor:v([0.5,0.5,0.5,0.5],'color4')}}],terminal:{baseColor:{node:'image',output:'outcolor'},opacity:{node:'image',output:'outa'}}}));
  expect(g.diagnostics).toEqual([]);const result=evaluateGraph(g);expect(result.baseColor).toEqual([0.2,0.4,0.6]);expect(result.opacity).toEqual([0.2]);
 });
 it('decodes the normal-map default in the surface frame',()=>{
  const g=normalizeGraph(new MaterialGraph({nodes:[{id:'normal',category:'gltf_normalmap',type:'vector3'}],terminal:{normal:{node:'normal'}}}));
  expect(g.diagnostics).toEqual([]);expect(evaluateGraph(g).normal).toEqual([0,0,1]);
 });
});
