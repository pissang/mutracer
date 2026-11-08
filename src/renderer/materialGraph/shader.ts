import type {Backend} from './codegen.js';
import type {GraphPlan} from './state.js';
import {flattenGraph} from './flatten.js';
import {materialGraphShaderIR} from './specialize.js';

/** Browser snapshots and resource identities stop at the shared IR boundary. */
export function materialGraphShader(source: string, plan: GraphPlan, backend: Backend) {
    return plan.key ? materialGraphShaderIR(source, plan.structures.map(flattenGraph), backend) : source;
}
