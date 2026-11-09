import type {NormalizedGraph} from './normalize.js';
import type {Backend} from './codegen.js';
import type {GraphPlan} from './state.js';
import {flattenGraph} from './flatten.js';
import {materialGraphShaderIR, graphMathShaderIR} from './specialize.js';

/** Browser snapshots and resource identities stop at the shared IR boundary. */
export function materialGraphShader(source: string, plan: GraphPlan, backend: Backend) {
    return plan.key ? materialGraphShaderIR(source, plan.structures.map(flattenGraph), backend) : source;
}

/** Shared numeric helpers for rendering and UV height baking. */
export function graphMathShader(structures:readonly NormalizedGraph[], backend:Backend) {
    return graphMathShaderIR(structures.map(flattenGraph),backend);
}
