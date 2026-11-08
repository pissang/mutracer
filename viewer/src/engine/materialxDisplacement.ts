import MaterialGraph, {type MaterialGraphInput} from '../../../src/scene/MaterialGraph';
import type Texture from '../../../src/scene/Texture';
import {normalizeGraph, type NormalizedGraph} from '../../../src/renderer/materialGraph/normalize';
import {evaluateNode, numeric, outputValue} from '../../../src/renderer/materialGraph/evaluate';

export interface DisplacementPlan {
  graph: MaterialGraph;
  mode: 'direct' | 'bake' | 'fallback';
  uvChannel: 0|1;
  reason?: string;
  direct?: {node: string; scale: number; bias: number; uvScale:[number,number]; uvOffset:[number,number]};
}

/** Displacement has a single UV domain. A shading frame or a second UV set
 * cannot be reconstructed by a height texture in that domain. */
export function planDisplacement(graph: MaterialGraph): DisplacementPlan {
  const normalized = normalizeGraph(graph), fail = (reason: string): DisplacementPlan => ({graph, mode:'fallback', uvChannel:0, reason});
  if (normalized.diagnostics.length) return fail(normalized.diagnostics.map(d => `${d.node}.${d.port ?? ''}: ${d.message}`).join('; '));
  const channels = new Set<number>();
  for (const node of normalized.nodes) {
    const spaces=['fromspace','tospace'].map(p=>node.inputs[p]?.slot===undefined?undefined:normalized.parameters[node.inputs[p].slot!]);
    const transform=/^transform(point|vector|normal)$/.test(node.category)&&spaces[0]&&spaces[1]&&spaces[0]!==spaces[1];
    if (transform||['position','normal','tangent','bitangent','gltf_normalmap'].includes(node.category) ||
      Object.values(node.inputs).some(i => i.geometry && i.geometry !== 'texcoord')) return fail(`${node.id}: displacement depends on non-UV geometry`);
    if (node.category === 'texcoord') {
      const i = node.inputs.index;
      const value=i.node===undefined?Number(normalized.parameters[i.slot!]):uniformValue(normalized,i.node)?.[0];
      if(value!==0&&value!==1)return fail(`${node.id}.index: displacement requires one fixed UV0 or UV1 set`);
      channels.add(value);
    }
    if (Object.values(node.inputs).some(i => i.geometry === 'texcoord')) channels.add(0);
  }
  if (channels.size > 1) return fail('displacement combines UV0 and UV1');
  const uvChannel = ([...channels][0] ?? 0) as 0|1;
  const direct = affineImage(normalized);
  return {graph, mode:direct ? 'direct' : 'bake', uvChannel, ...(direct ? {direct} : {})};
}

function uniformValue(graph:NormalizedGraph,index:number):number[]|undefined {
  const node=graph.nodes[index],args:Record<string,number[]>={};
  if(['texcoord','position','normal','tangent','bitangent','image','tiledimage','gltf_image','gltf_colorimage','gltf_normalmap','transformpoint','transformvector','transformnormal'].includes(node.category))return;
  for(const [port,input] of Object.entries(node.inputs)){
    if(input.geometry)return;
    const value=input.node===undefined?numeric(graph.parameters[input.slot!]):uniformValue(graph,input.node);
    if(!value)return;args[port]=input.node===undefined?value:outputValue([value],0,input.output);
  }
  return evaluateNode(node,args);
}

// Preserve the original image bytes for scalar image * scale + bias. More
// general coordinate transforms and channel selections go through the baker.
function affineImage(graph: NormalizedGraph): DisplacementPlan['direct'] {
  type Value = {constant:number[]} | NonNullable<DisplacementPlan['direct']>;
  const values: (Value | undefined)[] = [];
  const coordinates:({scale:number[];offset:number[]}|undefined)[]=[];
  for (const [index, node] of graph.nodes.entries()) {
    const args: Record<string, number[]> = {};
    let uniform = true;
    for (const [port, i] of Object.entries(node.inputs)) {
      if (i.node !== undefined) {
        const v = values[i.node];
        if (v && 'constant' in v) args[port] = outputValue([v.constant], 0, i.output);
        else uniform = false;
      } else if (i.geometry) uniform = false;
      else args[port] = numeric(graph.parameters[i.slot!]);
    }
    if (['image','tiledimage','texcoord'].includes(node.category)) uniform = false;
    if (uniform) { values[index] = {constant:evaluateNode(node,args)}; continue; }
    if(node.category==='texcoord')coordinates[index]={scale:[1,1],offset:[0,0]};
    const uv=node.inputs.texcoord,placed=uv?.geometry==='texcoord'?{scale:[1,1],offset:[0,0]}:uv?.node!==undefined?coordinates[uv.node]:undefined;
    if (['image','tiledimage'].includes(node.category) && node.type === 'float' && placed) {
      const scale=[...placed.scale],offset=[...placed.offset];
      if(node.category==='tiledimage')for(let i=0;i<2;i++){
        const ratio=args.realworldtilesize[i]/args.realworldimagesize[i];
        scale[i]*=args.uvtiling[i]*ratio;offset[i]=(offset[i]*args.uvtiling[i]-args.uvoffset[i])*ratio;
      }
      values[index] = {node:node.id, scale:1, bias:0,uvScale:scale as [number,number],uvOffset:offset as [number,number]}; continue;
    }
    const get = (port:string) => node.inputs[port]?.node !== undefined ? values[node.inputs[port].node!] : args[port] ? {constant:args[port]} : undefined;
    const a = get('in1'), b = get('in2');
    const ca=node.inputs.in1?.node===undefined?undefined:coordinates[node.inputs.in1.node],cb=node.inputs.in2?.node===undefined?undefined:coordinates[node.inputs.in2.node];
    const coordinate=ca??cb,constant=a&&'constant' in a?a.constant:b&&'constant' in b?b.constant:undefined;
    if(coordinate&&constant){
      const scale=[...coordinate.scale],offset=[...coordinate.offset];
      let valid=true;
      for(let i=0;i<2;i++){
        const c=constant[i%constant.length];
        if(node.category==='multiply'){scale[i]*=c;offset[i]*=c;}
        else if(node.category==='divide'&&ca&&c!==0){scale[i]/=c;offset[i]/=c;}
        else if(node.category==='add')offset[i]+=c;
        else if(node.category==='subtract'){if(ca)offset[i]-=c;else{scale[i]*=-1;offset[i]=c-offset[i];}}
        else valid=false;
      }
      if(valid)coordinates[index]={scale,offset};
    }
    if (a && b) {
      const linear = 'node' in a ? a : 'node' in b ? b : undefined;
      const constant = 'constant' in a ? a.constant[0] : 'constant' in b ? b.constant[0] : undefined;
      if (linear && constant !== undefined) {
        if (node.category === 'multiply') values[index] = {...linear,scale:linear.scale*constant,bias:linear.bias*constant};
        if (node.category === 'add') values[index] = {...linear,bias:linear.bias+constant};
        if (node.category === 'subtract') values[index] = 'node' in a ? {...linear,bias:linear.bias-constant} : {...linear,scale:-linear.scale,bias:constant-linear.bias};
        if (node.category === 'divide' && 'node' in a && constant !== 0) values[index] = {...linear,scale:linear.scale/constant,bias:linear.bias/constant};
      }
    }
    if(node.category==='mix'){
      const fg=get('fg'),bg=get('bg'),mix=get('mix');
      if(fg&&bg&&mix){
        if('node' in mix&&'constant' in fg&&'constant' in bg){
          const span=fg.constant[0]-bg.constant[0];values[index]={...mix,scale:mix.scale*span,bias:mix.bias*span+bg.constant[0]};
        }else if('constant' in mix){
          const t=mix.constant[0];
          if('node' in fg&&'constant' in bg)values[index]={...fg,scale:fg.scale*t,bias:fg.bias*t+bg.constant[0]*(1-t)};
          if('node' in bg&&'constant' in fg)values[index]={...bg,scale:bg.scale*(1-t),bias:bg.bias*(1-t)+fg.constant[0]*t};
        }
      }
    }
    const source=get('in');
    if(source&&'node' in source){
      if(node.category==='invert'&&args.amount)values[index]={...source,scale:-source.scale,bias:args.amount[0]-source.bias};
      if((node.category==='remap'||node.category==='range'&&args.gamma?.[0]===1&&!args.doclamp?.[0])&&args.inlow&&args.inhigh&&args.outlow&&args.outhigh){
        const factor=(args.outhigh[0]-args.outlow[0])/(args.inhigh[0]-args.inlow[0]);
        if(Number.isFinite(factor))values[index]={...source,scale:source.scale*factor,bias:(source.bias-args.inlow[0])*factor+args.outlow[0]};
      }
    }
    if (node.category === 'dot') values[index] = get('in');
  }
  const last = values[graph.terminal.specularRoughness.node];
  return last && 'node' in last ? last : undefined;
}

/** PNG/red is the existing viewer's portable height format. The exact extrema
 * map to 0/255; rounding contributes at most (max-min)/510 height units. */
export function quantizeHeight(heights: Float32Array) {
  let min = Infinity, max = -Infinity;
  for (const h of heights) {
    if (!Number.isFinite(h)) throw Error('Displacement produced a non-finite height');
    min = Math.min(min,h); max = Math.max(max,h);
  }
  if (!heights.length) throw Error('Displacement produced no heights');
  const scale = max-min, pixels = new Uint8ClampedArray(heights.length*4);
  for (let i=0;i<heights.length;i++) {
    pixels[i*4] = pixels[i*4+1] = pixels[i*4+2] = scale ? Math.round((heights[i]-min)/scale*255) : 0;
    pixels[i*4+3] = 255;
  }
  return {pixels,scale,bias:min,maxError:scale/510};
}

export type BakeImage = {node:string; width:number; height:number; pixels:Uint8ClampedArray; srgb:boolean; wrapS:Texture['wrapS']; wrapT:Texture['wrapT']};
export type BakeNodes = {nodes:MaterialGraph['nodes']; terminal:MaterialGraph['terminal']};
export type BakeParameter = MaterialGraphInput['value'];
