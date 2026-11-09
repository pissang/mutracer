import type {MaterialGraphDiagnosticCode} from '../../scene/MaterialGraph.js';
import {GraphSource,graphCategories,graphGeometry,graphTerminals,type GraphIR} from './ir.js';
import type {IRDiagnostic} from './validate.js';

/** Shared material/opacity restrictions, independent of author objects and hosts. */
export function graphContextDiagnostics(graph:GraphIR,unlit:boolean,emissive:boolean,opaque:boolean,projected:boolean) {
    const diagnostics:(IRDiagnostic & {code: MaterialGraphDiagnosticCode})[]=[];
    const terminal=(name:string)=>{const id=graphTerminals.indexOf(name);for(let i=0;i<graph.terminal.length;i+=3)if(graph.terminal[i]===id)return graph.terminal[i+1];return -1;};
    const hasTerminal=(name:string)=>{const id=graphTerminals.indexOf(name);for(let i=0;i<graph.terminal.length;i+=3)if(graph.terminal[i]===id)return true;return false;};
    if(!unlit && (hasTerminal('emissionColor') || hasTerminal('emissionLuminance') || emissive && (hasTerminal('coatColor')||hasTerminal('coatWeight')))) {
        const port=['emissionColor','emissionLuminance','coatColor','coatWeight'].find(p=>hasTerminal(p))!;
        diagnostics.push({node:terminal(port),port:graphTerminals.indexOf(port),code:'unsupported-emission-graph',message:'Graph emission and graph coat absorption on emissive surfaces currently require an unlit material.'});
    }
    const root=terminal('opacity');
    if(root>=0 && !opaque) {
        const seen:boolean[]=new Array<boolean>(graph.nodes.length/5).fill(false), stack=[root];let usesUv=false;
        while(stack.length) {
            const index=stack.pop()!;
            if(index<0 || index>=seen.length || seen[index])continue;
            seen[index]=true;
            const at=index*5, category=graph.nodes[at]>=0&&graph.nodes[at]<graphCategories.length?graphCategories[graph.nodes[at]]:'',first=graph.nodes[at+3],count=graph.nodes[at+4];
            if(first<0 || count<0 || first+count>graph.inputs.length/5)continue;
            let frame=['normal','tangent','bitangent','normalmap','gltf_normalmap','transformnormal'].includes(category);
            usesUv ||= category==='texcoord';
            for(let j=first;j<first+count;j++) {
                const input=j*5;
                if(graph.inputs[input+2]===GraphSource.Geometry) {
                    const source=graph.inputs[input+3],geometry=source>=0&&source<graphGeometry.length?graphGeometry[source]:'';
                    usesUv ||= geometry==='texcoord';
                    frame ||= geometry!=='texcoord' && geometry!=='objectPosition';
                }
            }
            if(frame)diagnostics.push({code:'unsupported-opacity-context',message:'Opacity graphs support UV and position inputs; shading-frame inputs are not available to shadow traversal.',node:index,port:graphTerminals.indexOf('opacity')});
            for(let j=first+count-1;j>=first;j--)if(graph.inputs[j*5+2]===GraphSource.Node)stack.push(graph.inputs[j*5+3]);
        }
        if(usesUv && projected)diagnostics.push({code:'unsupported-opacity-projection',message:'UV-dependent opacity graphs require material uvProjection none; use graph coordinates for procedural coverage.',node:root,port:graphTerminals.indexOf('opacity')});
    }
    return diagnostics;
}
