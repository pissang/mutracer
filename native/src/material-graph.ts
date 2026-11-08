import MaterialState from '../../src/scene/MaterialState.js';
import type TextureState from '../../src/scene/TextureState.js';
import {GRAPH as G} from './layout.js';
import {graphTypes,graphPorts,graphTerminals,GraphSource,type GraphIR} from '../../src/renderer/materialGraph/ir.js';
import {generateGraphIR} from '../../src/renderer/materialGraph/generate.js';
import {validateGraphIR} from '../../src/renderer/materialGraph/validate.js';
import {graphContextDiagnostics} from '../../src/renderer/materialGraph/context.js';
import {MATERIAL_FLOAT_COUNT,materialLayoutFields} from '../../src/renderer/materialLayoutSchema.js';
import {NativeMaterialSnapshot as BaseSnapshot,captureNativeMaterial as captureBase,nativeMaterialMatches as matchesBase,syncNativeMaterial as syncBase} from './material-snapshot.generated.js';

export interface NativeGraph {
    ir:GraphIR;
    textures:(TextureState|undefined)[];
    authorIds:string[];
}
export interface NativeGraphDiagnostic {
    code:string;message:string;materialId:number;node:string;port:string;
}
/** Native owns canonical data, while MaterialGraph remains the browser authoring facade. */
export class NativeMaterial extends MaterialState {
    graph:NativeGraph|undefined=undefined;
    previousGraph:NativeGraph|undefined=undefined;
    effectiveGraph:NativeGraph|undefined=undefined;
    graphDiagnostics:NativeGraphDiagnostic[]=[];
}
const fallbackGraphs=new Map<number,Map<number,NativeGraph>>();
export function seedGraphFallbacks(token:number,materials:MaterialState[]) {
    const graphs=new Map<number,NativeGraph>();
    for(const material of materials)if(material instanceof NativeMaterial && material.effectiveGraph)graphs.set(material.aovId,material.effectiveGraph);
    fallbackGraphs.set(token,graphs);
}
export function releaseGraphFallbacks(token:number) {fallbackGraphs.delete(token);}
export function attachGraphFallbacks(token:number,materials:MaterialState[]) {
    const fallback=fallbackGraphs.get(token);
    for(const material of materials)if(material instanceof NativeMaterial) {material.previousGraph=fallback?.get(material.aovId);refreshNativeGraph(material);}
}
export function graphStructureKey(graph:GraphIR):string {return JSON.stringify([graph.version,graph.nodes,graph.inputs,graph.terminal]);}
export function graphHasTerminal(graph:GraphIR,name:string):boolean {const id=graphTerminals.indexOf(name);for(let i=0;i<graph.terminal.length;i+=3)if(graph.terminal[i]===id)return true;return false;}
function located(material:NativeMaterial,graph:NativeGraph,code:string,message:string,node:number,port:number,terminal=false):NativeGraphDiagnostic {
    return {code,message,materialId:material.aovId,node:graph.authorIds[node]??(node>=0?String(node):''),port:port<0?'':(terminal?graphTerminals:graphPorts)[port]??''};
}
export function refreshNativeGraph(material:NativeMaterial) {
    const graph=material.graph;
    material.graphDiagnostics=[];material.effectiveGraph=undefined;
    if(!graph)return;
    const errors=validateGraphIR(graph.ir);
    material.graphDiagnostics=errors.map(d=>located(material,graph,d.code,d.message,d.node,d.port));
    if(!errors.length)for(let j=0;j<graph.ir.inputs.length;j+=5) {
        if(graph.ir.inputs[j+2]!==GraphSource.Parameter || graphTypes[graph.ir.inputs[j+1]]!=='filename')continue;
        const value=graph.ir.parameters[graph.ir.inputs[j+3]*4];
        if(value>=graph.textures.length) {
            let owner=-1;for(let n=0;n<graph.ir.nodes.length;n+=5)if(j/5>=graph.ir.nodes[n+3]&&j/5<graph.ir.nodes[n+3]+graph.ir.nodes[n+4]){owner=n/5;break;}
            material.graphDiagnostics.push(located(material,graph,'parameter-type','Image file refers to an unknown graph texture slot',owner,graph.ir.inputs[j]));
        }
    }
    const context=graphContextDiagnostics(graph.ir,material.unlit,material.emissionLuminance>0,material.alphaMode==='opaque',material.uvProjection!=='none');
    material.graphDiagnostics.push(...context.map(d=>located(material,graph,d.code,d.message,d.node,d.port,true)));
    if(!material.graphDiagnostics.length) {material.effectiveGraph=graph;material.previousGraph=undefined;return;}
    if(context.some(d=>d.code==='unsupported-emission-graph'||d.code==='unsupported-opacity-projection'))return;
    const previous=material.previousGraph;
    if(previous) {
        const errors=graphContextDiagnostics(previous.ir,material.unlit,material.emissionLuminance>0,material.alphaMode==='opaque',material.uvProjection!=='none');
        if(!errors.length)material.effectiveGraph=previous;
        else for(const d of errors)if(!material.graphDiagnostics.some(current=>current.code===d.code&&current.node===(previous.authorIds[d.node]??String(d.node))&&current.port===graphTerminals[d.port]))material.graphDiagnostics.push(located(material,previous,d.code,d.message,d.node,d.port,true));
    }
}
export function inheritNativeGraph(next:MaterialState,previous:MaterialState) {
    if(next instanceof NativeMaterial) {next.previousGraph=previous instanceof NativeMaterial?previous.effectiveGraph:undefined;refreshNativeGraph(next);}
}
export function nativeGraphFrame(material:MaterialState):boolean {return material instanceof NativeMaterial && !!material.effectiveGraph?.ir.terminal.length;}
export function nativeGraphOpacity(material:MaterialState):boolean {return material instanceof NativeMaterial && !!material.effectiveGraph && graphHasTerminal(material.effectiveGraph.ir,'opacity');}
export function nativeGraphTextures(materials:MaterialState[]):TextureState[] {
    const textures:TextureState[]=[];
    for(const material of materials)if(material instanceof NativeMaterial)for(const texture of material.effectiveGraph?.textures??[])if(texture&&!textures.includes(texture))textures.push(texture);
    return textures;
}
export interface NativeGraphPlan {key:string;structures:GraphIR[];diagnostics:NativeGraphDiagnostic[]}
export function nativeGraphPlan(materials:MaterialState[]):NativeGraphPlan {
    const graphs:GraphIR[]=[],keys:string[]=[],diagnostics:NativeGraphDiagnostic[]=[];
    for(const material of materials)if(material instanceof NativeMaterial) {
        diagnostics.push(...material.graphDiagnostics);
        const graph=material.effectiveGraph?.ir;
        if(graph?.terminal.length) {const key=graphStructureKey(graph);if(!keys.includes(key)){keys.push(key);graphs.push(graph);}}
    }
    const sorted=keys.slice().sort(),structures:GraphIR[]=[];
    for(const key of sorted)structures.push(graphs[keys.indexOf(key)]);
    return {key:sorted.join('\n'),structures,diagnostics};
}
const fields=materialLayoutFields();
const alpha=fields.find(f=>f.name==='alphaMode')!.offset/4,padding=fields.find(f=>f.name==='_padding1')!.offset/4;
/** Browser-compatible parameter records; no graph returns the original allocation. */
export function packNativeGraphs(buffer:Float32Array,materials:MaterialState[],textures:TextureState[]):Float32Array {
    const plan=nativeGraphPlan(materials);
    if(!plan.key)return buffer;
    const keys=plan.structures.map(graphStructureKey),chunks:number[][]=[];
    for(let i=0;i<materials.length;i++) {
        const material=materials[i];
        if(!(material instanceof NativeMaterial)||!material.effectiveGraph?.ir.terminal.length)continue;
        const graph=material.effectiveGraph,ir={...graph.ir,parameters:graph.ir.parameters.slice()};
        for(let j=0;j<ir.inputs.length;j+=5) {
            if(ir.inputs[j+2]!==GraphSource.Parameter || graphTypes[ir.inputs[j+1]]!=='filename')continue;
            const slot=ir.inputs[j+3]*4,texture=graph.textures[ir.parameters[slot]];
            if(texture&&!textures.includes(texture))throw new Error('Graph texture is outside the retained material atlas');
            ir.parameters[slot]=texture?textures.indexOf(texture):-1;
        }
        const generated=generateGraphIR(ir,'webgpu');
        if(graphHasTerminal(ir,'opacity')&&material.alphaMode==='auto'&&material.alphaCutoff<=0)buffer[i*MATERIAL_FLOAT_COUNT+alpha]=2;
        buffer[i*MATERIAL_FLOAT_COUNT+padding]=keys.indexOf(graphStructureKey(ir))+1;
        buffer[i*MATERIAL_FLOAT_COUNT+padding+1]=buffer.length/MATERIAL_FLOAT_COUNT+chunks.length;
        chunks.push(material.emissionColor.slice(),[material.emissionLuminance]);
        for(let j=0;j<generated.parameters.length;j+=4)chunks.push(generated.parameters.slice(j,j+4));
    }
    const result=new Float32Array(buffer.length+chunks.length*MATERIAL_FLOAT_COUNT);result.set(buffer);
    for(let i=0;i<chunks.length;i++)result.set(chunks[i],buffer.length+i*MATERIAL_FLOAT_COUNT);
    return result;
}
export function decodeNativeGraph(u:Uint32Array,f:Float32Array,at:number,textures:TextureState[]):NativeGraph|undefined {
    if(!at)return undefined;
    const read=(count:number,offset:number,stride:number)=>{
        const n=u[at+count]*stride,start=u[at+offset];
        if(start>u.length||n>u.length-start||n&&start<32)throw new Error('Graph span is out of bounds');
        return Array.from(u.subarray(start,start+n));
    };
    if(at+G.WORDS>u.length)throw new Error('Graph header is out of bounds');
    read(G.PARAMETER_COUNT,G.PARAMETERS,4);
    const parameters=Array.from(f.subarray(u[at+G.PARAMETERS],u[at+G.PARAMETERS]+u[at+G.PARAMETER_COUNT]*4));
    const ir:GraphIR={version:u[at+G.VERSION],nodes:read(G.NODE_COUNT,G.NODES,5),inputs:read(G.INPUT_COUNT,G.INPUTS,5),terminal:read(G.TERMINAL_COUNT,G.TERMINALS,3),parameters};
    const ids:string[]=[];const base=u[at+G.AUTHOR_IDS];
    if(base)for(let i=0;i<u[at+G.NODE_COUNT];i++) {
        if(base+i*2+2>u.length)throw new Error('Graph author table is out of bounds');
        const offset=u[base+i*2],length=u[base+i*2+1];
        if(offset*4+length>u.byteLength)throw new Error('Graph author text is out of bounds');
        ids.push(new TextDecoder().decode(new Uint8Array(u.buffer,u.byteOffset+offset*4,length)));
    }
    return {ir,textures:read(G.TEXTURE_COUNT,G.TEXTURES,1).map(id=>id===0xffffffff?undefined:textures[id]),authorIds:ids};
}
function signature(material:MaterialState):string {return material instanceof NativeMaterial&&material.graph?JSON.stringify([material.graph.ir,material.graph.authorIds]):'';}
export class NativeMaterialSnapshot extends BaseSnapshot {graphSignature='';graphTextures:(TextureState|undefined)[]=[];}
export function captureNativeMaterial(material:MaterialState,snapshot:NativeMaterialSnapshot):NativeMaterialSnapshot {
    captureBase(material,snapshot);snapshot.graphSignature=signature(material);snapshot.graphTextures=material instanceof NativeMaterial?material.graph?.textures.slice()??[]:[];return snapshot;
}
export function nativeMaterialMatches(material:MaterialState,snapshot:NativeMaterialSnapshot):boolean {
    if(!matchesBase(material,snapshot)||signature(material)!==snapshot.graphSignature)return false;
    const textures=material instanceof NativeMaterial?material.graph?.textures??[]:[];
    return textures.length===snapshot.graphTextures.length&&textures.every((t,i)=>t===snapshot.graphTextures[i]);
}
export function syncNativeMaterial(target:MaterialState,source:MaterialState) {
    syncBase(target,source);
    if(target instanceof NativeMaterial) {
        target.graph=source instanceof NativeMaterial?source.graph:undefined;
        target.previousGraph=source instanceof NativeMaterial?source.previousGraph:undefined;
        target.effectiveGraph=source instanceof NativeMaterial?source.effectiveGraph:undefined;
        target.graphDiagnostics=source instanceof NativeMaterial?source.graphDiagnostics:[];
    }
}

export function swapNativeGraphTextures(material:MaterialState,swaps:Map<TextureState,TextureState>) {
    if(!(material instanceof NativeMaterial))return;
    const swap=(graph:NativeGraph|undefined):NativeGraph|undefined=>graph?{...graph,textures:graph.textures.map(t=>t?(swaps.get(t)??t):undefined)}:undefined;
    material.graph=swap(material.graph);material.previousGraph=swap(material.previousGraph);material.effectiveGraph=swap(material.effectiveGraph);
}
