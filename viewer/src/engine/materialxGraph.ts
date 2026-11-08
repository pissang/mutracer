import {MaterialGraph, OpenPBRMaterial, type MaterialGraphInput as Input, type MaterialGraphNode as Node, type MaterialGraphType as Type, type MaterialGraphConnection as Edge} from '@meimu/mutracer';
import {normalizeGraph} from '../../../src/renderer/materialGraph/normalize';
import {evaluateGraph} from '../../../src/renderer/materialGraph/evaluate';
import {generateGraph} from '../../../src/renderer/materialGraph/codegen';
import {terminalTypes,terminalAliases,width} from '../../../src/renderer/materialGraph/nodes';
import {parseXml,type XmlElement as Element} from './materialx';
import standardSurface from './materialxStandardSurface';
import type {MaterialValues} from './materialParams';

const literal=(type:Type,value:Input['value']):Input=>({type,value});
const fields:Record<string,string>={geometryOpacity:'opacity',geometryThinWalled:'thinWalled',geometryNormal:'normal',specularRoughnessAnisotropy:'specularAnisotropy',coatRoughnessAnisotropy:'coatAnisotropy',subsurfaceScatterAnisotropy:'subsurfaceAnisotropy'};
const camel=(s:string)=>s.toLowerCase().replace(/_([a-z])/g,(_,c:string)=>c.toUpperCase());
const input=(e:Element,name:string)=>e.children.find(c=>c.tag==='input'&&c.attrs.name===name);
const child=(e:Element,name:string)=>e.children.find(c=>c.attrs.name===name && !['input','output'].includes(c.tag));
const inactiveImageInputs:Record<string,Input['value']>={layer:'',framerange:'',frameoffset:0,frameendaction:'constant'};
// Unsupported surface inputs that match the default shading frame.
const defaultFrame:Record<string,string>={coatNormal:'normal',tangent:'tangent'};
const path=(e:Element):string=>e.parent&&e.parent.tag!=='materialx'?`${path(e.parent)}/${e.attrs.name??e.tag}`:e.attrs.name??e.tag;
interface Context {prefix?:string;interfaces?:Record<string,Input>;cache:Map<Element,string>}
/** Viewer-only XML adapter. Unknown graph nodes remain authored nodes so the
 * library reports its normal located diagnostics and fallback. */
class Reader {
    nodes:Node[]=[];
    uniformValues:MaterialValues={};
    images=new Map<string,{file:string;srgb:boolean;wrapS?:'repeat'|'clamp-to-edge'|'mirrored-repeat';wrapT?:'repeat'|'clamp-to-edge'|'mirrored-repeat'}>();
    private context:Context={cache:new Map()};
    constructor(readonly root:Element){}
    find(e:Element,name:string):Element|undefined {
        for(let scope:Element|null=e;scope;scope=scope.parent){const found=child(scope,name);if(found)return found;}
    }
    resolve(e:Element|undefined,fallback:Input,ctx=this.context):Input {
        if(!e)return fallback;
        const a=e.attrs,type=(a.type??fallback.type) as Type;
        if(a.interfacename){
            if(ctx.interfaces)return ctx.interfaces[a.interfacename]??fallback;
            let scope:Element|null=e.parent;while(scope&&scope.tag!=='nodegraph')scope=scope.parent;
            return this.resolve(scope?input(scope,a.interfacename):undefined,fallback,ctx);
        }
        if(a.nodegraph){
            const graph=child(this.root,a.nodegraph),output=graph?.children.find(c=>c.tag==='output'&&(!a.output||c.attrs.name===a.output));
            return output?this.resolve(output,fallback,ctx):this.missing(a.nodegraph,type);
        }
        if(a.nodename){
            const source=this.find(e.parent??this.root,a.nodename);
            if(!source)return this.missing(a.nodename,type);
            const edge={node:this.emit(source,ctx),...(a.output?{output:a.output}:{})};
            if(a.channels){
                const sourceType=(source.tag.startsWith('separate')?'float':source.attrs.type) as Type;
                if(sourceType==='float'&&type==='float')return {type,connection:edge};
                const id=`${path(e)}/channels`;
                if(!this.nodes.some(n=>n.id===id))this.swizzle(id,type,{type:sourceType,connection:edge},a.channels);
                return {type,connection:{node:id}};
            }
            return {type,connection:edge};
        }
        if(a.value!==undefined){
            if(type==='string'||type==='filename')return literal(type,a.value);
            if(type==='boolean')return literal(type,a.value==='true'||a.value==='1');
            const nums=a.value.split(',').map(Number);
            return literal(type,width(type)===1?nums[0]:nums);
        }
        return fallback;
    }
    private missing(name:string,type:Type):Input {
        const id=`missing/${name}`;
        if(!this.nodes.some(n=>n.id===id))this.nodes.push({id,category:'missing_node',type});
        return {type,connection:{node:id}};
    }
    emit(e:Element,ctx=this.context):string {
        const prior=ctx.cache.get(e);if(prior)return prior;
        const id=(ctx.prefix??'')+path(e);ctx.cache.set(e,id);
        const inputs:Record<string,Input>={};
        for(const port of e.children.filter(c=>c.tag==='input'))inputs[port.attrs.name]=this.resolve(port,{type:port.attrs.type as Type},ctx);
        // Exporters write image inputs the graph does not implement; at their
        // stdlib defaults they change nothing, so drop them instead of failing.
        dropInactiveInputs(e.tag,inputs);
        let type=e.attrs.type as Type;
        if(type as string==='multioutput')type=e.tag==='gltf_colorimage'?'color4':inputs.in?.type??'vector3';
        const category=e.tag==='absval'?'abs':e.tag;
        if(category==='swizzle'){
            this.swizzle(id,type,inputs.in,String(inputs.channels?.value??''));
        }else{
            this.nodes.push({id,category,type,inputs});
            if(inputs.file?.value){
                const prefix=this.inherited(e,'fileprefix');
                const colorspace=input(e,'file')?.attrs.colorspace??this.inherited(e,'colorspace');
                const wraps:Record<string,'repeat'|'clamp-to-edge'|'mirrored-repeat'>={periodic:'repeat',clamp:'clamp-to-edge',mirror:'mirrored-repeat'};
                const wrapS=wraps[String(inputs.uaddressmode?.value??'periodic')],wrapT=wraps[String(inputs.vaddressmode?.value??'periodic')];
                this.images.set(id,{file:prefix+String(inputs.file.value),srgb:type.startsWith('color')&&!['lin_rec709','lin_rec709_scene','linear'].includes(colorspace),wrapS,wrapT});
                if(wrapS&&inputs.uaddressmode)inputs.uaddressmode=literal('string','periodic');
                if(wrapT&&inputs.vaddressmode)inputs.vaddressmode=literal('string','periodic');
                // Resource loading replaces this placeholder before engine.update().
                inputs.file=literal('filename',undefined);
            }
        }
        return id;
    }
    // MaterialX 1.39 Version.cpp swizzle upgrade: literals become constants;
    // connected vectors use extract/combine, scalar sources are replicated.
    // https://github.com/AcademySoftwareFoundation/MaterialX/blob/v1.39.4/source/MaterialXCore/Version.cpp
    private swizzle(id:string,type:Type,source:Input|undefined,channels:string){
        if(!source){this.nodes.push({id,category:'invalid_swizzle',type});return;}
        const index=(c:string)=>'rgba'.includes(c)&&c!==''?'rgba'.indexOf(c):'xyzw'.includes(c)&&c!==''?'xyzw'.indexOf(c):-1;
        const n=width(type),sourceWidth=width(source.type);
        if(!source.connection&&source.value!==undefined){
            const input=Array.isArray(source.value)?source.value:[Number(source.value)];
            const values=Array.from({length:n},(_,i)=>{const c=channels[i]??'',j=index(c);return j>=0?input[j]??NaN:c==='0'||c==='1'?Number(c):input[0];});
            this.nodes.push({id,category:'constant',type,inputs:{value:literal(type,n===1?values[0]:values)}});return;
        }
        if(n===1){
            this.nodes.push(sourceWidth===1?{id,category:'dot',type,inputs:{in:source}}:{id,category:'extract',type,inputs:{in:source,index:literal('integer',Math.max(0,index(channels[0]??'')))}});return;
        }
        const parts=Array.from({length:n},(_,i):Input=>{
            const c=channels[i]??'';if(c==='0'||c==='1')return literal('float',Number(c));
            if(sourceWidth===1)return source;
            const j=index(c);if(c&&j<0)return literal('float',0);
            const node=`${id}/extract${i}`;this.nodes.push({id:node,category:'extract',type:'float',inputs:{in:source,index:literal('integer',Math.max(0,j))}});
            return {type:'float',connection:{node}};
        });
        this.nodes.push({id,category:`combine${n}`,type,inputs:Object.fromEntries(parts.map((p,i)=>[`in${i+1}`,p]))});
    }
    private inherited(e:Element,key:string):string {for(let p:Element|null=e;p;p=p.parent)if(p.attrs[key])return p.attrs[key];return '';}
    add(type:Type,category:string,inputs:Record<string,Input>,name:string):Input {
        const id=`surface/${name}`;this.nodes.push({id,type,category,inputs});return {type,connection:{node:id}};
    }
    terminals(shader:Element):Record<string,Input> {
        if(shader.tag==='standard_surface'){
            const template=parseXml(standardSurface),def=template.children.find(e=>e.tag==='nodedef')!,graph=template.children.find(e=>e.tag==='nodegraph')!;
            const interfaces=Object.fromEntries(def.children.filter(e=>e.tag==='input').map(e=>[e.attrs.name,this.resolve(input(shader,e.attrs.name),this.resolve(e,{type:e.attrs.type as Type}))]));
            const ctx:Context={prefix:`${path(shader)}/translation/`,interfaces,cache:new Map()};
            const terminals=Object.fromEntries(graph.children.filter(e=>e.tag==='output').map(e=>{
                const name=camel(e.attrs.name.replace(/_out$/,''));return [fields[name]??name,this.resolve(e,{type:e.attrs.type as Type},ctx)];
            }));
            const normal=input(shader,'normal');if(normal)terminals.normal=this.resolve(normal,{type:'vector3'});
            const handled=new Set([...def.children.filter(e=>e.tag==='input').map(e=>e.attrs.name),'normal']);
            for(const e of shader.children.filter(e=>e.tag==='input'&&!handled.has(e.attrs.name))){const name=camel(e.attrs.name);terminals[fields[name]??name]=this.resolve(e,{type:e.attrs.type as Type});}
            return terminals;
        }
        if(shader.tag==='open_pbr_surface'){
            return Object.fromEntries(shader.children.filter(e=>e.tag==='input').map(e=>{const name=camel(e.attrs.name);return [fields[name]??name,this.resolve(e,{type:e.attrs.type as Type})];}));
        }
        const gltf=shader.tag==='gltf_pbr',usd=shader.tag==='UsdPreviewSurface';
        if(!gltf&&!usd){const n=this.add('float',shader.tag,{},'unsupported');return {specularRoughness:n};}
        const mapping:Record<string,[string,Type,Input['value']]>={
            baseColor:[gltf?'base_color':'diffuseColor','color3',gltf?[1,1,1]:[0.18,0.18,0.18]],baseMetalness:[gltf?'metallic':'metallic','float',gltf?1:0],
            specularRoughness:['roughness','float',gltf?1:0.5],specularIor:['ior','float',1.5],coatWeight:[gltf?'clearcoat':'clearcoat','float',0],coatRoughness:[gltf?'clearcoat_roughness':'clearcoatRoughness','float',gltf?0:0.01],
            opacity:[gltf?'alpha':'opacity','float',1],emissionColor:[gltf?'emissive':'emissiveColor','color3',[0,0,0]],normal:['normal','vector3',undefined]
        };
        if(gltf)Object.assign(mapping,{specularColor:['specular_color','color3',[1,1,1]],specularWeight:['specular','float',1],transmissionWeight:['transmission','float',0],thinFilmWeight:['iridescence','float',0],thinFilmIor:['iridescence_ior','float',1.3],fuzzColor:['sheen_color','color3',[0,0,0]],fuzzRoughness:['sheen_roughness','float',0]});
        const result:Record<string,Input>={};
        for(const [key,[name,type,value]] of Object.entries(mapping))if(value!==undefined||input(shader,name))result[key]=this.resolve(input(shader,name),literal(type,value));
        result.coatIor=literal('float',1.5);
        result.emissionLuminance=gltf?this.resolve(input(shader,'emissive_strength'),literal('float',1)):literal('float',1);
        if(gltf){
            result.thinFilmThickness=this.add('float','multiply',{in1:this.resolve(input(shader,'iridescence_thickness'),literal('float',100)),in2:literal('float',0.001)},'filmThickness');
            const color=this.add('vector3','convert',{in:result.fuzzColor},'sheenVector');
            const sum=this.add('float','dotproduct',{in1:color,in2:literal('vector3',[1,1,1])},'sheenSum');
            result.fuzzWeight=this.add('float','ifgreater',{value1:sum,value2:literal('float',0),in1:literal('float',1),in2:literal('float',0)},'sheenWeight');
        }
        const handled=new Set(Object.values(mapping).map(([name])=>name));
        if(gltf){
            const alpha=this.resolve(input(shader,'alpha_mode'),literal('integer',0));
            if(!alpha.connection&&[0,1,2].includes(Number(alpha.value)))this.uniformValues.alphaMode=['opaque','mask','blend'][Number(alpha.value)] as 'opaque'|'mask'|'blend';
            else result.alphaMode=alpha;
            result.alphaCutoff=this.resolve(input(shader,'alpha_cutoff'),literal('float',0.5));
            for(const [name,property,type] of [['attenuation_color','transmissionColor','color3'],['attenuation_distance','transmissionDepth','float']] as const){const e=input(shader,name);if(e)result[property]=this.resolve(e,{type});}
            const thickness=input(shader,'thickness');
            if(thickness&&!thickness.attrs.nodename&&!thickness.attrs.nodegraph&&thickness.attrs.value!==undefined)this.uniformValues.thinWalled=Number(thickness.attrs.value)<=0;
            else if(thickness)result.volumeThickness=this.resolve(thickness,{type:'float'});
            for(const name of ['alpha_mode','alpha_cutoff','attenuation_color','attenuation_distance','thickness','emissive_strength','iridescence_thickness'])handled.add(name);
        }else{
            result.alphaCutoff=this.resolve(input(shader,'opacityThreshold'),literal('float',0));handled.add('opacityThreshold');
            for(const name of ['useSpecularWorkflow','opacityMode']){
                const e=input(shader,name);if(e&&e.attrs.value!=='0')result[name]=this.resolve(e,{type:'integer'});handled.add(name);
            }
            // specularColor is inactive in the supported metallic workflow.
            const workflow=input(shader,'useSpecularWorkflow');if(!workflow||workflow.attrs.value==='0')handled.add('specularColor');
        }
        for(const e of shader.children.filter(e=>e.tag==='input')){
            if(handled.has(e.attrs.name))continue;
            if((e.attrs.name==='occlusion'&&Number(e.attrs.value)===1)||(e.attrs.name==='displacement'&&Number(e.attrs.value)===0))continue;
            result[e.attrs.name]=this.resolve(e,{type:e.attrs.type as Type});
        }
        return result;
    }
}
export interface MaterialXGraphImport {
    name:string;
    shader:string;
    values:MaterialValues;
    graph?:MaterialGraph;
    images:Map<string,{file:string;srgb:boolean;wrapS?:'repeat'|'clamp-to-edge'|'mirrored-repeat';wrapT?:'repeat'|'clamp-to-edge'|'mirrored-repeat'}>;
    warnings:string[];
    coverage:'complete'|'partial'|'fallback';
}
const dynamicCategories=['image','tiledimage','gltf_image','gltf_colorimage','gltf_normalmap','texcoord','position','normal','tangent','bitangent','transformpoint','transformvector','transformnormal'];
const isDynamic=(normalized:ReturnType<typeof normalizeGraph>)=>normalized.nodes.some(n=>Object.values(n.inputs).some(i=>i.geometry)||dynamicCategories.includes(n.category));
/** True for an unsupported terminal input that cannot change the result:
 * a uniform zero, or the default world-space shading frame. */
function inactive(nodes:Node[],port:string,edge:Edge){
    if(port in terminalTypes)return false;
    const source=nodes.find(n=>n.id===edge.node);
    if(!source)return false;
    if(source.category===defaultFrame[port]){
        const space=source.inputs?.space;
        return !!space&&!space.connection&&space.value==='world';
    }
    const probe=Object.keys(terminalTypes).find(k=>terminalTypes[k]===source.type);
    if(!probe)return false;
    const normalized=normalizeGraph(new MaterialGraph({nodes,terminal:{[probe]:edge}}));
    return !normalized.diagnostics.length&&!isDynamic(normalized)&&evaluateGraph(normalized)[probe].every(v=>v===0);
}
const dropInactiveInputs=(category:string,inputs:Record<string,Input>)=>{
    // MaterialX 1.38 normalmap defaults to tangent space, which is the
    // library node's implicit behavior. Object space remains unsupported.
    if(category==='normalmap'&&inputs.space&&!inputs.space.connection&&inputs.space.value==='tangent')delete inputs.space;
    for(const [port,value] of Object.entries(inactiveImageInputs))if(inputs[port]&&!inputs[port].connection&&inputs[port].value===value)delete inputs[port];
};
/** Removes inputs that have no effect from a graph saved by an earlier
 * importer, so restored materials match a fresh import. */
export function pruneInactiveInputs(nodes:Node[],terminal:Record<string,Edge>){
    const pruned=nodes.map(n=>{if(!n.inputs)return n;const inputs={...n.inputs};dropInactiveInputs(n.category,inputs);return {...n,inputs};});
    return {nodes:pruned,terminal:Object.fromEntries(Object.entries(terminal).filter(([port,edge])=>!inactive(pruned,port,edge)))};
}
/** Parses one material; resource loading remains owned by the viewer package loader. */
export function parseMaterialXGraph(text:string,materialName?:string):MaterialXGraphImport {
    const root=parseXml(text);if(root.tag!=='materialx')throw Error('Not a MaterialX document');
    const material=root.children.find(e=>e.tag==='surfacematerial'&&(!materialName||e.attrs.name===materialName));if(!material)throw Error('No surface material found');
    const r=new Reader(root),surface=input(material,'surfaceshader'),shader=surface?.attrs.nodename?r.find(root,surface.attrs.nodename):undefined;if(!shader)throw Error('No surface shader found');
    const defaults=new OpenPBRMaterial();
    const authored=r.terminals(shader),terminal:Record<string,Edge>={},values:MaterialValues={...r.uniformValues},warnings:string[]=[];
    for(const [name,a] of Object.entries(authored)){
        const port=terminalAliases[name]??name,type=terminalTypes[port]??a.type;
        let edge=a.connection;
        if(!edge){const n=`surface/value/${name}`;r.nodes.push({id:n,category:'constant',type:a.type,inputs:{value:a}});edge={node:n};}
        // Use a supported terminal of the same type for CPU folding. This also
        // folds uniform values for material fields outside the dynamic subset.
        let probe=Object.keys(terminalTypes).find(k=>terminalTypes[k]===type);
        if(type==='boolean'||type==='integer'){const id=`surface/fold/${name}`;r.nodes.push({id,category:'convert',type:'float',inputs:{in:{type,connection:edge}}});edge={node:id};probe='specularRoughness';}
        const normalized=normalizeGraph(new MaterialGraph({nodes:r.nodes,terminal:{[probe??port]:edge}}));
        const dynamic=isDynamic(normalized);
        const property=fields[name]??name, defaultValue=(defaults as unknown as Record<string,unknown>)[property];
        const canStore=['number','boolean'].includes(typeof defaultValue)||Array.isArray(defaultValue);
        if(!normalized.diagnostics.length&&!dynamic&&canStore&&port!=='normal'){
            const folded=evaluateGraph(normalized)[probe??port];
            (values as Record<string,unknown>)[property]=a.type==='boolean'?Boolean(folded[0]):width(a.type)===1?folded[0]:folded;
        }else if(inactive(r.nodes,port,edge)){
            // An unsupported input left at zero, or at the default frame, has no effect.
        }else terminal[port]=edge;
    }
    const graph=Object.keys(terminal).length?new MaterialGraph({nodes:r.nodes,terminal}):undefined;
    if(graph){
        const state=new OpenPBRMaterial();Object.assign(state,values);state.graph=graph;
        const normalized=normalizeGraph(graph);
        warnings.push(...normalized.diagnostics.map(d=>`${d.node??''}${d.port?'.'+d.port:''}: ${d.message}`));
        if(!state.unlit && (['emissionColor','emissionLuminance'].some(p=>p in normalized.terminal)||state.emissionLuminance>0&&['coatColor','coatWeight'].some(p=>p in normalized.terminal)))warnings.push('Lit emission graphs use the constant material fallback.');
        if(!normalized.diagnostics.length)generateGraph(normalized,'webgpu');
    }
    return {name:material.attrs.name??'MaterialX',shader:shader.tag,values,graph,images:r.images,warnings,coverage:warnings.length?(Object.keys(values).length?'partial':'fallback'):'complete'};
}
