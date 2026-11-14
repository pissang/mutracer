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
    /** Cost of the interpreter when its source size is unknown (all families). */
    interpreterMs: number;
    /** Interpreter compile time per KB of its source (cases and helper libraries)... */
    interpreterMsPerKB: number;
    /** ...beyond this many KB, which compile at no measurable cost. */
    interpreterFreeKB: number;
    /** Size of each helper library, counted once when no interpreter is present
     * (the interpreter variant always contains every helper). */
    helperBytes: Readonly<Record<string, number>>;
    /** Source each specialized noise node inlines (the lattice loop of `mx_noise_channels`); helper libraries count once, their calls do not. */
    noiseNodeBytes?: number;
}

export interface GraphTierBudget {
    /** Allowed graph increment of the final (optimized) variant over the
     * graph-free kernel, in milliseconds. */
    budgetMs: number;
    /** Increment allowed before the scene first renders every graph correctly. A
     * final variant estimated above it, or one containing the interpreter, is
     * preceded by the interpreter-only variant. */
    correctMs: number;
    /** A mixed variant is built only if the structures it specializes carry at
     * least this share of the estimated interpreter work; otherwise the presence
     * of extra code on every hit outweighs the gain and all structures stay interpreted. */
    minBenefitShare: number;
    /** Total specialized source allowed in one variant, in KB, independent of the
     * compile budget: specialized code slows every hit of the megakernel (P0:
     * +110 KB ≈ 1.07×, +220 KB ≈ 1.15×, +665 KB ≈ 1.49× of baked). Default unlimited. */
    capKB?: number;
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
    /** Specialized source of the chosen variant in bytes. */
    specializedBytes: number;
}

/** Calibrated on the reference platform: specialized code adds 19–21 ms per KB
 * both alone and next to the interpreter; the interpreter-only variant adds
 * ≈0.57 s with every opcode family, ≈48 ms per KB of interpreter source beyond
 * 3.6 KB (0.14 s for the 9 families of the simple harness class). A mixed variant specializing 35 % of the interpreter work on a
 * uniform sphere grid was only ≈4 % faster than the interpreter alone, so a
 * mixed variant needs at least 20 % coverage. */
export const DEFAULT_GRAPH_COMPILE_MODEL: GraphCompileModel = {msPerKB: 21, interpreterMs: 600, interpreterMsPerKB: 48, interpreterFreeKB: 3.6, helperBytes: {noise: noiseShader().length, hsv: 900, rotate3d: 250}, noiseNodeBytes: 1000};
export const DEFAULT_GRAPH_TIER_BUDGET: GraphTierBudget = {budgetMs: 1000, correctMs: 1000, minBenefitShare: 0.2};

export function specializedBytes(candidates: readonly GraphTierCandidate[], model: GraphCompileModel, interpreter: boolean) {
    let bytes = 0;
    const helpers = new Set<string>();
    for (const c of candidates) {
        bytes += c.sourceBytes;
        if (!interpreter) for (const h of c.helpers ?? []) helpers.add(h);
    }
    for (const h of helpers) bytes += model.helperBytes[h] ?? 0;
    return bytes;
}
export function specializedCompileMs(candidates: readonly GraphTierCandidate[], model: GraphCompileModel, interpreter: boolean) {
    return specializedBytes(candidates, model, interpreter) / 1024 * model.msPerKB;
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
 * Structures the interpreter cannot run are always specialized. `budget.capKB`
 * limits the total specialized source on top of the compile budget.
 */
export function interpreterCompileMs(sourceBytes: number, model: GraphCompileModel) {
    return model.interpreterMsPerKB * Math.max(0, sourceBytes / 1024 - model.interpreterFreeKB);
}

/** `interpreterMs` overrides the model's fixed interpreter cost, e.g. with the
 * cost of only the opcode families the candidates need. */
export function planGraphTiers(candidates: readonly GraphTierCandidate[], model = DEFAULT_GRAPH_COMPILE_MODEL, budget = DEFAULT_GRAPH_TIER_BUDGET, interpreterMs = model.interpreterMs): GraphTierDecision {
    const forced = candidates.filter(c => c.instructions === undefined);
    const allMs = specializedCompileMs(candidates, model, false), capBytes = (budget.capKB ?? Infinity) * 1024;
    if ((allMs <= budget.budgetMs && specializedBytes(candidates, model, false) <= capBytes) || forced.length === candidates.length)
        return {specialized: new Set(candidates.map(c => c.key)), interpreter: false, estimatedMs: allMs, coverage: 1, specializedBytes: specializedBytes(candidates, model, false)};
    const specialized = new Set(forced.map(c => c.key));
    let usedMs = interpreterMs + specializedCompileMs(forced, model, true), usedBytes = specializedBytes(forced, model, true);
    const benefit = (c: GraphTierCandidate) => (c.instructions ?? 0) * Math.max(c.usage, 0);
    const optional = candidates.filter(c => c.instructions !== undefined);
    const total = optional.reduce((sum, c) => sum + benefit(c), 0);
    const cost = (c: GraphTierCandidate) => Math.max(specializedCompileMs([c], model, true), 1e-3);
    const ranked = optional.filter(c => benefit(c) > 0).sort((a, b) => benefit(b) / cost(b) - benefit(a) / cost(a) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    let gained = 0;
    const chosen: string[] = [];
    for (const c of ranked) {
        const ms = cost(c);
        if (usedMs + ms > budget.budgetMs || usedBytes + c.sourceBytes > capBytes) continue;
        usedMs += ms; usedBytes += c.sourceBytes; gained += benefit(c); chosen.push(c.key);
    }
    // Specializing every interpretable structure would drop the interpreter, but
    // then the full set is over budget (allMs above); keep the last pick interpreted.
    if (chosen.length && chosen.length === optional.length) {
        const last = optional.find(c => c.key === chosen.pop())!;
        usedMs -= cost(last); usedBytes -= last.sourceBytes; gained -= benefit(last);
    }
    const coverage = total > 0 ? gained / total : 0;
    if (coverage >= budget.minBenefitShare) for (const key of chosen) specialized.add(key);
    else { usedMs = interpreterMs + specializedCompileMs(forced, model, true); usedBytes = specializedBytes(forced, model, true); }
    return {specialized, interpreter: true, estimatedMs: usedMs, coverage: coverage >= budget.minBenefitShare ? coverage : 0, specializedBytes: usedBytes};
}
