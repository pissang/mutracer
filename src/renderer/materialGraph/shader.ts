import type {NormalizedGraph} from './normalize.js';
import type {GraphPlan} from './state.js';
import {graphCompilerBackend} from './tierPolicy.js';
import {flattenGraph} from './flatten.js';
import {materialGraphShaderIR, graphMathShaderIR} from './specialize.js';

/** Browser snapshots and resource identities stop at the shared IR boundary. */
export function materialGraphShader(plan: GraphPlan, frames = true) {
    // Without graphs only the universal editing interpreter is compiled, so a first graph renders at once.
    if (!plan.key && !plan.shape?.universal) return {};
    return materialGraphShaderIR((plan.specialized ?? plan.structures).map(flattenGraph), frames, (plan.interpreter ?? !!plan.programs?.size) ? {terminals: plan.interpreterTerminals ?? [], salt: plan.interpreterSalt, families: plan.interpreterFamilies, emission: plan.interpreterEmission, opacity: plan.interpreterOpacity, operandLoop: graphCompilerBackend() === 'd3d12'} : undefined, true);
}

/** Shared numeric helpers for rendering and UV height baking. */
export function graphMathShader(structures:readonly NormalizedGraph[]) {
    return graphMathShaderIR(structures.map(flattenGraph));
}
