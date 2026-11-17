export * from '../shaderCompilePolicy.js';

export interface GraphUpgradeGateInput {
    now: number;
    /** When the structure set last changed. */
    stableSince: number;
    debounceMs: number;
    /** Pipeline compiles running or queued; WebGPU compiles cannot be cancelled. */
    compilesInFlight: number;
    /** Predicted wall time until the upgraded variant is ready. */
    compileMs: number;
    /** No upgrade predicted to compile longer than this starts, whatever its benefit. */
    maxCompileMs: number;
    /** Predicted per-sample saving as a fraction of the current sample time. */
    gain: number;
    /** Wall ms per sample of the installed variant; undefined until measured. */
    msPerSample?: number;
    /** Samples left until the render target converges; undefined when unbounded. */
    remainingSamples?: number;
    /** Wall time already rendered since the structure set changed: the horizon when no target is known. */
    renderedMs: number;
    /** Required benefit/compile ratio. */
    margin: number;
    /** Longest horizon assumed without a known target. */
    maxHorizonMs: number;
}
export interface GraphUpgradeGate { start: boolean; reason: 'debounce' | 'ceiling' | 'compiling' | 'unmeasured' | 'benefit' | 'start'; remainingMs?: number; benefitMs?: number }

/**
 * Starts a specialized upgrade only when the structure set has been stable for the
 * debounce period, its predicted compile is under the ceiling, no other compile is in flight, and the render time it saves
 * after it arrives clearly exceeds its compile time: (remaining − compile) × gain >
 * margin × compile. Without a sample target the expected remaining time is the time
 * already rendered (capped), so an upgrade waits longer while edits are recent.
 */
export function graphUpgradeGate(input: GraphUpgradeGateInput): GraphUpgradeGate {
    if (input.now - input.stableSince < input.debounceMs) return {start: false, reason: 'debounce'};
    if (input.compileMs > input.maxCompileMs) return {start: false, reason: 'ceiling'};
    if (input.compilesInFlight > 0) return {start: false, reason: 'compiling'};
    if (input.msPerSample === undefined) return {start: false, reason: 'unmeasured'};
    const remainingMs = input.remainingSamples !== undefined && Number.isFinite(input.remainingSamples)
        ? Math.max(input.remainingSamples, 0) * input.msPerSample : Math.min(input.renderedMs, input.maxHorizonMs);
    const benefitMs = Math.max(remainingMs - input.compileMs, 0) * input.gain;
    return {start: benefitMs > input.margin * input.compileMs, reason: benefitMs > input.margin * input.compileMs ? 'start' : 'benefit', remainingMs, benefitMs};
}

export type GraphVerifyTier = 'final' | 'interim';
export interface GraphVerifyDecision {
    keep: boolean;
    /** 1 − final/interim per-sample time. */
    gain: number;
    method: 'gpu' | 'wall';
    final: number;
    interim: number;
    /** Per phase: tier, rendered samples, GPU timestamps, duration ms. */
    phases: {tier: GraphVerifyTier; samples: number; timestamps: number; ms: number}[];
}
interface VerifyPhase { tier: GraphVerifyTier; samples: number; gpu: number[]; startAt?: number; wallStart?: number; wallEnd?: number; wallSamples: number }
export interface GraphVerifyOptions { minGain: number; phaseSamples: number; minTimestamps: number; minPhaseMs: number; maxPhaseMs: number }

/**
 * Interleaved A/B of an installed upgrade against its interim on the same view:
 * phases final, interim, interim, final, final, interim (ABBA cancels drift). A phase
 * ends after one warm-up sample plus `phaseSamples` samples, `minPhaseMs` and either
 * a third of `minTimestamps` GPU timestamps or `maxPhaseMs` (Chrome reads timestamps back about
 * once per second while sampling). The medians of each tier's timestamps over its three
 * phases decide when each tier has at least half of `minTimestamps`; otherwise wall
 * time per sample decides, which Render's realtime pacing can distort. A view change
 * discards the current phase.
 */
export class GraphUpgradeVerifier {
    static readonly ORDER: readonly GraphVerifyTier[] = ['final', 'interim', 'interim', 'final', 'final', 'interim'];
    private phases: VerifyPhase[] = [];
    private view?: number;
    decision?: GraphVerifyDecision;
    constructor(readonly options: GraphVerifyOptions = {minGain: 0.03, phaseSamples: 8, minTimestamps: 6, minPhaseMs: 250, maxPhaseMs: 4000}) {
        this.phases.push(this.phase(0));
    }
    private phase(index: number): VerifyPhase { return {tier: GraphUpgradeVerifier.ORDER[index], samples: 0, gpu: [], wallSamples: 0}; }
    /** Tier that should be installed now. */
    get tier(): GraphVerifyTier { return this.decision ? (this.decision.keep ? 'final' : 'interim') : this.phases[this.phases.length - 1].tier; }
    private get current() { return this.phases[this.phases.length - 1]; }
    private reset(view: number) { this.view = view; const phase = this.current; Object.assign(phase, this.phase(this.phases.length - 1)); }
    /** Samples rendered by `tier` up to `samples` total on `view`, at wall time `now`. */
    frame(tier: GraphVerifyTier, view: number, rendered: number, now: number) {
        if (this.decision) return;
        if (view !== this.view) this.reset(view);
        const phase = this.current;
        if (tier !== phase.tier || rendered <= 0) return;
        phase.startAt ??= now;
        phase.samples += rendered;
        // The first sample after a switch is warm-up; wall time starts after it.
        if (phase.wallStart === undefined) { if (phase.samples >= 1) phase.wallStart = now; }
        else { phase.wallEnd = now; phase.wallSamples += rendered; }
        const elapsed = now - phase.startAt;
        const enough = phase.gpu.length >= Math.ceil(this.options.minTimestamps / 3);
        if (phase.samples >= this.options.phaseSamples + 1 && elapsed >= this.options.minPhaseMs && (enough || elapsed >= this.options.maxPhaseMs)) this.advance();
    }
    /** A GPU timestamp of one sample traced by `tier` on `view`. */
    gpu(tier: GraphVerifyTier, view: number, ms: number) {
        if (this.decision || view !== this.view) return;
        const phase = this.current;
        if (tier === phase.tier && phase.samples >= 1) phase.gpu.push(ms);
    }
    private advance() {
        if (this.phases.length < GraphUpgradeVerifier.ORDER.length) { this.phases.push(this.phase(this.phases.length)); return; }
        const median = (v: number[]) => { const s = v.slice().sort((a, b) => a - b); return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
        const of = (tier: GraphVerifyTier) => this.phases.filter(p => p.tier === tier);
        // GPU timestamps decide when each tier has half of `minTimestamps` over its phases:
        // the timestamp readback can stall for a whole phase behind a deep queue, and wall
        // time under Render's realtime pacing can invert the result.
        const gpu = (['final', 'interim'] as const).every(tier => of(tier).reduce((n, p) => n + p.gpu.length, 0) >= Math.ceil(this.options.minTimestamps / 2));
        const wall = (p: VerifyPhase) => p.wallSamples ? (p.wallEnd! - p.wallStart!) / p.wallSamples : NaN;
        const value = (tier: GraphVerifyTier) => gpu ? median(of(tier).flatMap(p => p.gpu)) : of(tier).map(wall).reduce((a, b) => a + b, 0) / 3;
        const final = value('final'), interim = value('interim'), gain = 1 - final / interim;
        this.decision = {keep: Number.isFinite(gain) && gain >= this.options.minGain, gain, method: gpu ? 'gpu' : 'wall', final, interim,
            phases: this.phases.map(p => ({tier: p.tier, samples: p.samples, timestamps: p.gpu.length, ms: (p.wallEnd ?? p.startAt ?? 0) - (p.startAt ?? 0)}))};
    }
}

/** Expected fractional per-sample saving of an upgrade. `interpreterGain` is the
 * saving of removing all interpreter work; a mixed variant keeps the interpreter's
 * presence cost, so only half of its covered share counts (P2: 35 % coverage
 * saved ≈4 %). */
export function graphUpgradeGain(interpreterGain: number, interpreter: boolean, coverage: number) {
    return interpreter ? interpreterGain * coverage * 0.5 : interpreterGain;
}
