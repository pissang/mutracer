import {materialGraphShaderIR} from '../../../src/renderer/materialGraph/specialize.js';
import {generateGraphIR} from '../../../src/renderer/materialGraph/generate.js';
import type {GraphIR} from '../../../src/renderer/materialGraph/ir.js';

/** Execute the shared IR emitter through the same byte ABI as other AOT contracts. */
export function materialGraphParameters(bytes: Uint8Array): Uint8Array {
    const request = JSON.parse(new TextDecoder().decode(bytes)) as {graph: GraphIR; backend: 'webgpu' | 'webgl'; name: string; source?: string};
    if(request.source !== undefined) return new TextEncoder().encode(materialGraphShaderIR(request.source,[request.graph],request.backend));
    return new TextEncoder().encode(JSON.stringify(generateGraphIR(request.graph, request.backend, request.name)));
}
