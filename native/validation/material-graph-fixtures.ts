import rayTraceCompute from '../../src/renderer/wgsl/rayTrace.compute.js';
import rayTraceFragment from '../../src/renderer/glsl/rayTrace.frag.js';
import MaterialGraph, {type MaterialGraphNode} from '../../src/scene/MaterialGraph.js';
import {nodeInputs, validNodeType} from '../../src/renderer/materialGraph/nodes.js';
import {normalizeGraph} from '../../src/renderer/materialGraph/normalize.js';
import {flattenGraph} from '../../src/renderer/materialGraph/flatten.js';
import {graphCategories, graphTypes} from '../../src/renderer/materialGraph/ir.js';

/** All supported category/type combinations, both literal and varying operands. */
export function materialGraphFixtures() {
    const fixtures: {label: string; graph: ReturnType<typeof normalizeGraph>}[] = [];
    for (const category of graphCategories) for (const type of graphTypes.slice(0,8)) for(const varying of [false,true]) {
        const node: MaterialGraphNode = {id:'test',category,type};
        if (!validNodeType(node)) continue;
        const inputs=nodeInputs(node)!;
        const nodes: MaterialGraphNode[]=[];
        if(varying) {
            const port=['in','in1','fg','value','texcoord','position'].find(port => inputs[port] && !['filename','string','integer','boolean'].includes(inputs[port].type));
            if(port) {
                nodes.push({id:'uv',category:'texcoord',type:'vector2'}, {id:'operand',category:'convert',type:inputs[port].type,inputs:{in:{type:'float',connection:{node:'x'}}}},
                    {id:'x',category:'extract',type:'float',inputs:{in:{type:'vector2',connection:{node:'uv'}},index:{type:'integer',value:0}}});
                node.inputs={[port]: {type:inputs[port].type,connection:{node:'operand'}}};
            }
        }
        nodes.push(node);
        const output=category.startsWith('separate') ? type.startsWith('color')?'outr':'outx' : category==='gltf_colorimage'?'outcolor':'out';
        const outputType=output==='out'?type:output==='outcolor'?'color3':'float';
        nodes.push({id:'result',category:'convert',type:'color3',inputs:{in:{type:outputType,connection:{node:'test',output}}}});
        const graph=normalizeGraph(new MaterialGraph({nodes,terminal:{baseColor:{node:'result'}}}));
        if(graph.diagnostics.length) throw new Error(`${category}/${type}: ${JSON.stringify(graph.diagnostics)}`);
        fixtures.push({label:`${category}-${type}-${varying?'varying':'literal'}`,graph});
    }
    fixtures.push({label:'opacity-normal',graph:normalizeGraph(new MaterialGraph({nodes:[
        {id:'uv',category:'texcoord',type:'vector2'},
        {id:'x',category:'extract',type:'float',inputs:{in:{type:'vector2',connection:{node:'uv'}}}},
        {id:'n',category:'normalmap',type:'vector3'}
    ],terminal:{normal:{node:'n'},opacity:{node:'x'}}}))});
    return fixtures;
}
export function materialGraphRequests() {
    const fixtures=materialGraphFixtures();
    const requests=fixtures.flatMap(({label,graph}) => ['webgpu','webgl'].map(backend => ({label:`${label}-${backend}`,input:new TextEncoder().encode(JSON.stringify({graph:flattenGraph(graph),backend,name:'mx_eval'}))})));
    for(const backend of ['webgpu','webgl'] as const) for(const compactVertices of [false,true]) {
        const options={hasDisplacement:false,hasAnisotropyDirections:true,hasCoatNormals:true,hasAlpha:true,hasSceneAlpha:true,compactVertices};
        const source=backend==='webgpu'?rayTraceCompute(options):rayTraceFragment(options).main;
        for(const {label,graph} of fixtures.filter(f=>['noise2d-color3-varying','fractal3d-vector3-varying','gltf_colorimage-color4-varying','extract-float-varying','splitlr-color3-varying','hsvtorgb-color3-varying','rotate3d-vector3-varying','opacity-normal'].includes(f.label))) {
            requests.push({label:`source-${label}-${backend}-${compactVertices}`,input:new TextEncoder().encode(JSON.stringify({graph:flattenGraph(graph),backend,name:'mx_eval',source}))});
        }
    }
    return requests;
}
