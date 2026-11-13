import {noiseShader} from './noiseShader.js';

/** Per-structure inputs of the tier planner. */
export interface GraphTierCandidate {
    key: string;
    /** Interpreter instructions per evaluation (surface + opacity + emission);
     * undefined when the structure cannot be interpreted and must be specialized. */
    instructions?: number;
    /** Relative hit weight of the structure, e.g. the world-space area of its surfaces. */
    usage: number;
    /** Specialized WGSL added by this structure's `mx_eval_N` and dispatch branches, in bytes. */
    sourceBytes: number;
    /** Shared helper libraries this structure needs when specialized (noise, hsv, ...). */
    helpers?: readonly string[];
}

/** Compile-time model of the WebGPU megakernel on the reference platform (Apple
 * M4 Max, Chrome Metal, cold caches). Values are graph increments over the
 * graph-free kernel in milliseconds. */
export interface GraphCompileModel {
    /** Pipeline compile time per KB of added specialized WGSL. */
    msPerKB: number;
    /** Fixed cost of the interpreter (its evaluator and the generic dispatch). */
    interpreterMs: number;
    /** Size of each helper library, counted once when no interpreter is present
     * (the interpreter variant always contains every helper). */
    helperBytes: Readonly<Record<string, number>>;
}

export interface GraphTierBudget {
    /** Allowed graph increment over the graph-free kernel, in milliseconds. */
    budgetMs: number;
    /** A mixed variant is built only if the structures it specializes carry at
     * least this share of the estimated interpreter work; otherwise the presence
     * of extra code on every hit outweighs the gain and all structures stay interpreted. */
    minBenefitShare: number;
}

export interface GraphTierDecision {
    /** Structures compiled to inline code. */
    specialized: Set<string>;
    /** Whether the variant contains the interpreter. */
    interpreter: boolean;
    /** Estimated compile increment of the chosen variant. */
    estimatedMs: number;
    /** Share of the estimated interpreter work moved to specialized code (1 without interpreter). */
    coverage: number;
}

/** Calibrated on the reference platform: specialized code adds 19–21 ms per KB
 * both alone and next to the interpreter; the interpreter-only variant adds
 * ≈0.57 s. A mixed variant specializing 35 % of the interpreter work on a
 * uniform sphere grid was only ≈4 % faster than the interpreter alone, so a
 * mixed variant needs at least 20 % coverage. */
export const DEFAULT_GRAPH_COMPILE_MODEL: GraphCompileModel = {msPerKB: 21, interpreterMs: 600, helperBytes: {noise: noiseShader().length, hsv: 900, rotate3d: 250}};
export const DEFAULT_GRAPH_TIER_BUDGET: GraphTierBudget = {budgetMs: 1000, minBenefitShare: 0.2};

export function specializedCompileMs(candidates: readonly GraphTierCandidate[], model: GraphCompileModel, interpreter: boolean) {
    let bytes = 0;
    const helpers = new Set<string>();
    for (const c of candidates) {
        bytes += c.sourceBytes;
        if (!interpreter) for (const h of c.helpers ?? []) helpers.add(h);
    }
    for (const h of helpers) bytes += model.helperBytes[h] ?? 0;
    return bytes / 1024 * model.msPerKB;
}

/**
 * Chooses the tier of each structure for one megakernel variant.
 *
 * Benefit of specializing a structure = interpreter instructions per hit × usage:
 * the interpreter's extra cost is linear in executed instructions, while the
 * frame's traversal cost (which sets the interpreter/baked ratio of a scene) is
 * the same for both tiers, so no fixed interpreter ratio enters the decision.
 * Cost = estimated compile time of its specialized source. If every structure
 * fits the budget without an interpreter, the interpreter is omitted entirely
 * (its presence slows every hit). Otherwise the interpreter's fixed cost is
 * charged and the remaining budget is filled greedily by benefit per ms.
 * Structures the interpreter cannot run are always specialized.
 */
export function planGraphTiers(candidates: readonly GraphTierCandidate[], model = DEFAULT_GRAPH_COMPILE_MODEL, budget = DEFAULT_GRAPH_TIER_BUDGET): GraphTierDecision {
    const forced = candidates.filter(c => c.instructions === undefined);
    const allMs = specializedCompileMs(candidates, model, false);
    if (allMs <= budget.budgetMs || forced.length === candidates.length)
        return {specialized: new Set(candidates.map(c => c.key)), interpreter: false, estimatedMs: allMs, coverage: 1};
    const specialized = new Set(forced.map(c => c.key));
    let usedMs = model.interpreterMs + specializedCompileMs(forced, model, true);
    const benefit = (c: GraphTierCandidate) => (c.instructions ?? 0) * Math.max(c.usage, 0);
    const optional = candidates.filter(c => c.instructions !== undefined);
    const total = optional.reduce((sum, c) => sum + benefit(c), 0);
    const cost = (c: GraphTierCandidate) => Math.max(specializedCompileMs([c], model, true), 1e-3);
    const ranked = optional.filter(c => benefit(c) > 0).sort((a, b) => benefit(b) / cost(b) - benefit(a) / cost(a) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    let gained = 0;
    const chosen: string[] = [];
    for (const c of ranked) {
        const ms = cost(c);
        if (usedMs + ms > budget.budgetMs) continue;
        usedMs += ms; gained += benefit(c); chosen.push(c.key);
    }
    // Specializing every interpretable structure would drop the interpreter, but
    // then the full set is over budget (allMs above); keep the last pick interpreted.
    if (chosen.length && chosen.length === optional.length) {
        const last = optional.find(c => c.key === chosen.pop())!;
        usedMs -= cost(last); gained -= benefit(last);
    }
    const coverage = total > 0 ? gained / total : 0;
    if (coverage >= budget.minBenefitShare) for (const key of chosen) specialized.add(key);
    else usedMs = model.interpreterMs + specializedCompileMs(forced, model, true);
    return {specialized, interpreter: true, estimatedMs: usedMs, coverage: coverage >= budget.minBenefitShare ? coverage : 0};
}
