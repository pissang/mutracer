import type {NormalizedGraph} from './normalize.js';
import type {GraphPlan} from './state.js';
import {flattenGraph} from './flatten.js';
import {materialGraphShaderIR, graphMathShaderIR} from './specialize.js';

/** Browser snapshots and resource identities stop at the shared IR boundary. */
export function materialGraphShader(plan: GraphPlan, frames = true) {
    if (!plan.key) return {};
    return materialGraphShaderIR((plan.specialized ?? plan.structures).map(flattenGraph), frames, plan.programs?.size ? {terminals: plan.interpreterTerminals ?? [], salt: plan.interpreterSalt} : undefined);
}

/** Shared numeric helpers for rendering and UV height baking. */
export function graphMathShader(structures:readonly NormalizedGraph[]) {
    return graphMathShaderIR(structures.map(flattenGraph));
}
