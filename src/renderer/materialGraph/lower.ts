import type MaterialGraph from '../../scene/MaterialGraph.js';
import type OpenPBRMaterial from '../../scene/OpenPBRMaterial.js';
import type Texture from '../../scene/Texture.js';
import {normalizeGraph, type GraphInput} from './normalize.js';
import {evaluateNode, numeric, outputValue} from './evaluate.js';
import {varyingCategory} from './fold.js';
import {width} from './nodes.js';
import type {MaterialTextureName as TextureKey} from '../../scene/materialTextureNames.js';
type MaterialValues = Partial<OpenPBRMaterial>;
type TextureTransform = Pick<Texture, 'uvScale'|'uvOffset'|'uvChannel'|'flipY'|'wrapS'|'wrapT'|'colorSpace'>;

interface Coordinates {kind:'uv'; uvChannel:0|1; scale:[number,number]; offset:[number,number]}
interface ImageValue {kind:'image'; node:string; uv:Coordinates; channels:number[]; gain:number[]; color:boolean;normal?:boolean;normalScale?:[number,number]}
type Value = {kind:'constant'; value:number[]} | Coordinates | ImageValue;
export interface DirectMap {
  slot:TextureKey;
  node:string;
  /** Source channel for each output channel; -1 is zero and -2 is one. */
  channels:number[];
  transform:TextureTransform & {colorSpace:'srgb'|'linear'};
}
export interface DirectMaterial {maps:DirectMap[]; values:MaterialValues}
type ImageInfo={srgb:boolean;bounded?:boolean;wrapS?:'repeat'|'clamp-to-edge'|'mirrored-repeat';wrapT?:'repeat'|'clamp-to-edge'|'mirrored-repeat'};
const uv0=():Coordinates=>({kind:'uv',uvChannel:0,scale:[1,1],offset:[0,0]});
const component=(v:number[],i:number)=>v[i%v.length];

/** A conservative, lossless slot lowering. Missing resources still use the
 * original graph and its authored image defaults. Normal images explicitly select their
 * world tangent frame instead of the ordinary cotangent convention. */
export function planDirectMaterial(graph:MaterialGraph, images:Map<string,ImageInfo>,material:MaterialValues={},diagnose?:(reason:string)=>void):DirectMaterial|undefined {
  const reject=(reason:string)=>{diagnose?.(reason);return undefined;};
  const g=normalizeGraph(graph);if(g.diagnostics.length)return reject('invalid-graph');
  // Emitters need the installed graph proposal as well as their evaluated coat.
  if(!material.unlit && (['emissionColor','emissionLuminance'].some(p=>p in g.terminal) || (material.emissionLuminance ?? 0)>0 && ['coatColor','coatWeight'].some(p=>p in g.terminal)))return reject('emission-context');
  const values:(Value|undefined)[]=[],failures:(string|undefined)[]=[];
  const read=(input:GraphInput):Value|undefined=>{
    if(input.geometry)return input.geometry==='texcoord'?uv0():undefined;
    if(input.node===undefined)return {kind:'constant',value:numeric(g.parameters[input.slot!])};
    const v=values[input.node];if(!v)return;
    if(!input.output||input.output==='out')return v;
    if(v.kind==='constant')return {kind:'constant',value:outputValue([v.value],0,input.output)};
    if(v.kind!=='image')return;
    const indices=input.output==='outcolor'?[0,1,2]:['xyzwrgba'.indexOf(input.output.slice(3))%4];
    return {...v,channels:indices.map(i=>v.channels[i]),gain:indices.map(i=>v.gain[i])};
  };
  for(const n of g.nodes){
    const args=Object.fromEntries(Object.entries(n.inputs).map(([p,i])=>[p,read(i)]));
    const constants:Record<string,number[]>={};
    for(const [p,v] of Object.entries(args))if(v?.kind==='constant')constants[p]=v.value;
    let result:Value|undefined;
    if(!varyingCategory(n.category)&&Object.values(args).every(v=>v?.kind==='constant')){
      result={kind:'constant',value:evaluateNode(n,constants).map(Math.fround)};
    }else if(n.category==='texcoord'&&constants.index&&(constants.index[0]===0||constants.index[0]===1)){
      result={...uv0(),uvChannel:constants.index[0]};
    }else if(['image','tiledimage'].includes(n.category)&&args.texcoord?.kind==='uv'&&images.has(n.id)){
      const uv={...args.texcoord,scale:[...args.texcoord.scale] as [number,number],offset:[...args.texcoord.offset] as [number,number]};
      if(n.category==='tiledimage'){
        if(!['uvtiling','uvoffset','realworldimagesize','realworldtilesize'].every(p=>constants[p])){values.push(undefined);failures.push('dynamic-tiledimage');continue;}
        for(let i=0;i<2;i++){
          const ratio=constants.realworldtilesize[i]/constants.realworldimagesize[i];
          uv.scale[i]*=constants.uvtiling[i]*ratio;uv.offset[i]=(uv.offset[i]*constants.uvtiling[i]-constants.uvoffset[i])*ratio;
        }
      }
      result={kind:'image',node:n.id,uv,channels:Array.from({length:width(n.type)},(_,i)=>i),gain:Array(width(n.type)).fill(1),color:n.type.startsWith('color')};
    }else if(n.category==='normalmap'&&args.in?.kind==='image'&&!args.in.normal&&constants.scale?.every(Number.isFinite)&&
      ['normal','tangent','bitangent'].every(p=>{
        const input=n.inputs[p];if(input?.geometry===p)return true;
        const source=input?.node===undefined?undefined:g.nodes[input.node];
        if(source?.category!==p)return false;
        const space=read(source.inputs.space),index=source.inputs.index&&read(source.inputs.index);
        return space?.kind==='constant'&&space.value[0]===1&&(!index||index.kind==='constant'&&index.value[0]===0);
      })){
      const v=args.in;if(v.channels.length===3&&v.gain.every(x=>x===1))result={...v,normal:true,normalScale:[constants.scale[0],component(constants.scale,1)]};
    }else if(n.category==='dot')result=args.in;
    else if(['ifgreater','ifequal'].includes(n.category)&&constants.value1&&constants.value2){
      result=(n.category==='ifgreater'?constants.value1[0]>constants.value2[0]:constants.value1[0]===constants.value2[0])?args.in1:args.in2;
    }
    else if(n.category==='convert'&&args.in?.kind==='image'&&!args.in.normal&&!['boolean','integer'].includes(n.type)){
      const v=args.in,count=width(n.type);
      result={...v,channels:Array.from({length:count},(_,i)=>v.channels.length===1?v.channels[0]:v.channels[i]??(i===3?-2:-1)),gain:Array.from({length:count},(_,i)=>v.gain.length===1?v.gain[0]:v.gain[i]??1)};
    }else if(n.category.startsWith('separate')&&args.in?.kind==='image'&&!args.in.normal)result=args.in;
    else if(n.category==='extract'&&args.in?.kind==='image'&&!args.in.normal&&constants.index){
      const i=constants.index[0],v=args.in;if(Number.isInteger(i)&&i>=0&&i<v.channels.length)result={...v,channels:[v.channels[i]],gain:[v.gain[i]]};
    }else if(n.category==='place2d'&&args.texcoord?.kind==='uv'&&constants.rotate?.[0]===0&&['pivot','scale','offset','operationorder'].every(p=>constants[p])){
      const uv=args.texcoord,scale:[number,number]=[0,0],offset:[number,number]=[0,0];
      for(let i=0;i<2;i++){
        scale[i]=uv.scale[i]/constants.scale[i];
        offset[i]=(uv.offset[i]-constants.pivot[i]-(constants.operationorder[0]===1?constants.offset[i]:0))/constants.scale[i]+constants.pivot[i]-(constants.operationorder[0]===1?0:constants.offset[i]);
      }
      result={...uv,scale,offset};
    }else if(n.category==='mix'&&constants.mix&&(args.fg?.kind==='image'&&constants.bg?.every(x=>x===0)||args.bg?.kind==='image'&&constants.fg?.every(x=>x===0))){
      const foreground=args.fg?.kind==='image',v=(foreground?args.fg:args.bg) as ImageValue;
      if(!v.normal)result={...v,gain:v.gain.map((x,i)=>x*(foreground?component(constants.mix,i):1-component(constants.mix,i)))};
    }else if(n.category==='mix'&&args.mix?.kind==='image'&&!args.mix.normal&&constants.bg?.every(x=>x===0)&&constants.fg){
      const v=args.mix;
      result={...v,gain:v.gain.map((x,i)=>x*component(constants.fg,i))};
    }else if(['multiply','divide','add','subtract'].includes(n.category)){
      const a=args.in1,b=args.in2,v=a?.kind!=='constant'?a:b,c=a?.kind==='constant'?a:b?.kind==='constant'?b:undefined;
      if(v&&c?.kind==='constant'&&v.kind==='uv'){
        const scale=[...v.scale] as [number,number],offset=[...v.offset] as [number,number];let valid=true;
        for(let i=0;i<2;i++){
          const x=component(c.value,i);
          if(n.category==='multiply'){scale[i]*=x;offset[i]*=x;}
          else if(n.category==='divide'&&a===v&&x!==0){scale[i]/=x;offset[i]/=x;}
          else if(n.category==='add')offset[i]+=x;
          else if(n.category==='subtract'){scale[i]*=a===v?1:-1;offset[i]=a===v?offset[i]-x:x-offset[i];}
          else valid=false;
        }
        if(valid)result={...v,scale,offset};
      }else if(v?.kind==='image'&&!v.normal&&c?.kind==='constant'&&(n.category==='multiply'||n.category==='divide'&&a===v&&c.value.every(x=>x!==0))){
        result={...v,gain:v.gain.map((x,i)=>n.category==='multiply'?x*component(c.value,i):x/component(c.value,i))};
      }
    }
    values.push(result);
    failures.push(result?undefined:Object.values(n.inputs).flatMap(input=>input.node===undefined?[]:[failures[input.node]]).find(Boolean)??('operation:'+n.category));
  }
  const plan:DirectMaterial={maps:[],values:{}};
  const slots:Record<string,[TextureKey,number[]]>={baseColor:['map',[0,1,2]],specularRoughness:['roughnessMap',[1]],baseMetalness:['metalnessMap',[2]],transmissionWeight:['transmissionMap',[0]],normal:['normalMap',[0,1,2]],coatWeight:['coatWeightMap',[0]],specularWeight:['specularWeightMap',[3]],specularColor:['specularColorMap',[0,1,2]],fuzzColor:['fuzzColorMap',[0,1,2]],fuzzRoughness:['fuzzRoughnessMap',[3]]};
  const colorSlots=new Set<TextureKey>(['map','specularColorMap','fuzzColorMap']);
  for(const [terminal,edge] of Object.entries(g.terminal)){
    const target=slots[terminal],v=read({type:g.nodes[edge.node].type,...edge});
    if(!target)return reject('terminal:'+terminal);
    if(v?.kind!=='image')return reject(failures[edge.node]??('operation:'+g.nodes[edge.node].category));
    if((terminal==='normal')!==!!v.normal)return reject('normal-frame');
    const [slot,targets]=target,image=images.get(v.node)!;
    if(!v.uv.scale.concat(v.uv.offset,v.gain).every(Number.isFinite))return reject('nonfinite-transform');
    // Scalar slots sample stored channels without color decoding. Decoding an
    // sRGB channel before interpolation would change the graph's result.
    if(!colorSlots.has(slot)&&v.color&&image.srgb)return reject('srgb-scalar');
    if(v.gain.some(x=>x<0||x>1))return reject('gain-range');
    if((colorSlots.has(slot)||slot==='normalMap')?v.channels.length!==3:v.channels.length!==1)return reject('channel-width');
    if(colorSlots.has(slot)&&v.color&&image.srgb&&v.channels.some(c=>c<0||c>2))return reject('srgb-swizzle');
    if(['coatWeightMap','specularWeightMap','specularColorMap','fuzzColorMap','fuzzRoughnessMap'].includes(slot)&&!image.bounded)return reject('unbounded-image');
    const channels=[-1,-1,-1,-2];targets.forEach((c,i)=>{channels[c]=v.channels[i];});
    plan.maps.push({slot,node:v.node,channels,transform:{uvScale:v.uv.scale,uvOffset:v.uv.offset,uvChannel:v.uv.uvChannel,flipY:true,wrapS:image.wrapS??'repeat',wrapT:image.wrapT??'repeat',colorSpace:v.color&&image.srgb?'srgb':'linear',}});
    if(slot!=='normalMap')(plan.values as Record<string,unknown>)[terminal]=colorSlots.has(slot)?v.gain:v.gain[0];
    if(slot==='map')plan.values.mapAlphaUsage='opaque';
    if(slot==='normalMap')plan.values.normalScale=v.normalScale!;
  }
  if(!plan.maps.some(m=>m.slot==='normalMap')&&(Number(material.specularAnisotropy)>0||Number(material.coatAnisotropy)>0))return reject('anisotropy-frame');
  return plan.maps.length?plan:undefined;
}
