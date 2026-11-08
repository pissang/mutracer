import {foldGraphTerminal} from '../../../src/renderer/materialGraph/fold.js';
import {validateGraphIR} from '../../../src/renderer/materialGraph/validate.js';
import {materialGraphShaderIR} from '../../../src/renderer/materialGraph/specialize.js';
import {generateGraphIR} from '../../../src/renderer/materialGraph/generate.js';
import type {GraphIR} from '../../../src/renderer/materialGraph/ir.js';

/** Execute the shared IR emitter through the same byte ABI as other AOT contracts. */
export function materialGraphParameters(bytes: Uint8Array): Uint8Array {
    const request = JSON.parse(new TextDecoder().decode(bytes)) as {graph: GraphIR; backend?: 'webgpu' | 'webgl'; name?: string; source?: string;fold?:boolean;validate?:boolean};
    if(request.validate)return new TextEncoder().encode(JSON.stringify(validateGraphIR(request.graph)));
    if(request.fold){const results=[];for(let i=0;i<request.graph.terminal.length/3;i++)results.push(foldGraphTerminal(request.graph,i));return new TextEncoder().encode(JSON.stringify(results));}
    if(request.source !== undefined) return new TextEncoder().encode(materialGraphShaderIR(request.source,[request.graph],request.backend??'webgpu'));
    return new TextEncoder().encode(JSON.stringify(generateGraphIR(request.graph, request.backend??'webgpu', request.name??'mx_eval')));
}
