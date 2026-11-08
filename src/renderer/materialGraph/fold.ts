import {validateGraphIR,type IRDiagnostic} from './validate.js';
import {GraphSource,graphCategories,graphOutputs,graphPorts,graphTypes,type GraphIR} from './ir.js';
import {width} from './types.js';
import {evaluateNumericNode,type Numeric} from './numeric.js';
/** Resource/hit-context nodes cannot be folded without a shading context. */
export function varyingCategory(category:string):boolean {return ['gltf_image','gltf_colorimage','gltf_normalmap','image','tiledimage','texcoord','position','normal','tangent','bitangent','transformpoint','transformvector','transformnormal'].includes(category);}
/** Fold one terminal independently: unreachable author errors do not poison it. */
export function foldGraphTerminal(graph:GraphIR,terminal:number):{value:Numeric;diagnostics:IRDiagnostic[]} {
    const at=terminal*3,root=graph.terminal[at+1],count=graph.nodes.length/5;
    if(!Number.isInteger(root)||root<0||root>=count)return {value:[],diagnostics:[{code:'missing-node',message:'Unknown terminal source',node:root,port:-1}]};
    const reachable=Array<boolean>(count).fill(false),stack=[root];
    while(stack.length) {
        const node=stack.pop()!;if(reachable[node])continue;reachable[node]=true;
        const first=graph.nodes[node*5+3],length=graph.nodes[node*5+4];
        if(first<0||length<0||first+length>graph.inputs.length/5)return {value:[],diagnostics:[{code:'invalid-ir-layout',message:'Invalid node input range',node,port:-1}]};
        for(let i=first;i<first+length;i++)if(graph.inputs[i*5+2]===GraphSource.Node){const parent=graph.inputs[i*5+3];if(parent>=0&&parent<node)stack.push(parent);}
    }
    const ir:GraphIR={version:graph.version,nodes:[],inputs:[],terminal:[],parameters:graph.parameters},indices:number[]=[];
    for(let n=0;n<count;n++)if(reachable[n]) {
        indices.push(n);const first=graph.nodes[n*5+3],length=graph.nodes[n*5+4],input=ir.inputs.length/5;
        for(let i=first;i<first+length;i++){const record=graph.inputs.slice(i*5,i*5+5);if(record[2]===GraphSource.Node)record[3]=indices.indexOf(record[3]);ir.inputs.push(...record);}
        ir.nodes.push(graph.nodes[n*5],graph.nodes[n*5+1],graph.nodes[n*5+2],input,length);
    }
    ir.terminal=[graph.terminal[at],indices.indexOf(root),graph.terminal[at+2]];
    const diagnostics=validateGraphIR(ir);for(const d of diagnostics)if(d.node>=0)d.node=indices[d.node];
    if(diagnostics.length)return {value:[],diagnostics};
    const values:Numeric[]=[];
    const output=(value:Numeric,id:number)=>{const name=graphOutputs[id];return !value.length||name==='out'?value:name==='outcolor'?value.slice(0,3):[value['xyzwrgba'.indexOf(name.slice(3))%4]];};
    for(let n=0;n<ir.nodes.length/5;n++) {
        const category=graphCategories[ir.nodes[n*5]],type=graphTypes[ir.nodes[n*5+2]],inputs:Record<string,Numeric>={};let uniform=!varyingCategory(category);
        for(let i=ir.nodes[n*5+3];i<ir.nodes[n*5+3]+ir.nodes[n*5+4];i++) {
            const port=graphPorts[ir.inputs[i*5]],source=ir.inputs[i*5+3],kind=ir.inputs[i*5+2];
            const value=kind===GraphSource.Parameter?ir.parameters.slice(source*4,source*4+width(graphTypes[ir.inputs[i*5+1]])):kind===GraphSource.Node?output(values[source],ir.inputs[i*5+4]):[];
            inputs[port]=value;if(!value.length)uniform=false;
        }
        values.push(uniform?evaluateNumericNode(category,type,inputs).map(Math.fround):[]);
    }
    return {value:output(values[indices.indexOf(root)],ir.terminal[2]),diagnostics:[]};
}
