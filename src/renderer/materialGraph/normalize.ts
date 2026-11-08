import type MaterialGraph from '../../scene/MaterialGraph.js';
import type {MaterialGraphDiagnostic as Diagnostic, MaterialGraphInput as Input, MaterialGraphNode as Node, MaterialGraphType as Type} from '../../scene/MaterialGraph.js';
import Texture from '../../scene/Texture.js';
import {nodeInputs, outputType, terminalTypes, validNodeType, width} from './nodes.js';

export interface GraphNode { id:string; category:string; type:Type; inputs:Record<string, GraphInput>; }
export interface GraphInput { type:Type; node?:number; output?:string; slot?:number; geometry?:string; }
export interface NormalizedGraph {
  key:string; hash:string; nodes:GraphNode[]; terminal:Record<string,{node:number;output:string}>;
  parameters:Input['value'][]; diagnostics:Diagnostic[];
}
export const GRAPH_IMPLEMENTATION_VERSION = 'mx-1.39.4-web-1';
export function graphHash(key:string) {
  let hash=2166136261;
  for(let i=0;i<key.length;i++) hash=Math.imul(hash^key.charCodeAt(i),16777619);
  return (hash>>>0).toString(16).padStart(8,'0');
}
/** Canonical port-ordered DFS removes author IDs, declaration order and dead nodes.
 * Exact canonical keys accompany the short hash to avoid cache collisions. */
export function normalizeGraph(graph:MaterialGraph, backend:'webgpu'|'webgl'='webgpu', capabilities='atlas'):NormalizedGraph {
  const diagnostics:Diagnostic[]=[], nodes:GraphNode[]=[], parameters:Input['value'][]=[];
  const source=new Map<string,Node>(), indices=new Map<string,number>(), visiting=new Set<string>();
  const report=(code:string,message:string,node?:string,port?:string)=>diagnostics.push({code,message,node,port});
  for(const node of graph.nodes) {
    if(source.has(node.id)) report('duplicate-node',`Duplicate node ID ${node.id}`,node.id);
    source.set(node.id,node);
  }
  const visit=(id:string):number=>{
    if(indices.has(id)) return indices.get(id)!;
    const node=source.get(id);
    if(!node){report('missing-node',`Unknown source node ${id}`,id);return -1;}
    if(visiting.has(id)){report('cycle','Material graphs must be acyclic',id);return -1;}
    visiting.add(id);
    const defaults=nodeInputs(node);
    if(!defaults) report('unsupported-node',`Unsupported MaterialX category ${node.category}`,id);
    if(!validNodeType(node)) report('unsupported-type',`Unsupported ${node.category}/${node.type}`,id);
    const inputs:Record<string,GraphInput>={};
    for(const port of Object.keys(node.inputs??{})) if(!defaults || !(port in defaults)) report('unsupported-input',`Unsupported input ${port}`,id,port);
    for(const port of Object.keys(defaults??{}).sort()) {
      const expected=defaults![port], authored=node.inputs?.[port], value=authored??expected;
      if(value.type!==expected.type) report('input-type',`Expected ${expected.type}, got ${value.type}`,id,port);
      if(value.connection) {
        const edge=value.connection, index=visit(edge.node), parent=source.get(edge.node), output=edge.output??'out';
        const type=parent&&outputType(parent,output);
        if(type!==value.type) report('connection-type',`Expected ${value.type}, got ${type??'unknown output'}`,id,port);
        inputs[port]={type:value.type,node:index,output};
      } else if(!authored && expected.value===undefined && expected.type!=='filename') {
        inputs[port]={type:expected.type,geometry:port};
      } else {
        const parameter=value.value??expected.value;
        if(value.type==='filename') {
          if(parameter!==undefined && !(parameter instanceof Texture)) report('parameter-type','Image file must be a loaded Texture',id,port);
        } else {
          const values=Array.isArray(parameter)?parameter:[parameter];
          if(values.length!==width(value.type)||values.some(v=>typeof v!=='boolean'&&(typeof v!=='number'||!Number.isFinite(v)))) report('parameter-value',`Expected finite ${value.type} parameter`,id,port);
          if(value.type==='integer' && !Number.isInteger(parameter)) report('parameter-value','Expected integer parameter',id,port);
          if(node.category==='texcoord'&&parameter!==0&&parameter!==1) report('unsupported-uv','Only UV0 and UV1 are supported',id,port);
          if(node.category==='place2d'&&port==='operationorder'&&parameter!==0&&parameter!==1) report('parameter-value','operationorder must be 0 or 1',id,port);
        }
        inputs[port]={type:value.type,slot:parameters.length}; parameters.push(parameter);
      }
    }
    visiting.delete(id); const index=nodes.length; indices.set(id,index);nodes.push({id,category:node.category,type:node.type,inputs});return index;
  };
  const terminal:NormalizedGraph['terminal']={};
  for(const port of Object.keys(graph.terminal).sort()) {
    const edge=graph.terminal[port], index=visit(edge.node), output=edge.output??'out', parent=source.get(edge.node);
    if(!terminalTypes[port]) report('unsupported-terminal',`Unsupported OpenPBR graph input ${port}`,edge.node,port);
    else if(!parent||outputType(parent,output)!==terminalTypes[port]) report('terminal-type',`Expected ${terminalTypes[port]} terminal`,edge.node,port);
    terminal[port]={node:index,output};
  }
  const key=JSON.stringify([GRAPH_IMPLEMENTATION_VERSION,backend,capabilities,nodes.map(({category,type,inputs})=>({category,type,inputs})),terminal]);
  return {key,hash:graphHash(key),nodes,terminal,parameters,diagnostics};
}
