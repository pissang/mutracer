/** Shader compiler families with different compile-cost shapes. Chrome uses Metal
 * on macOS, D3D12 (DXC) on Windows and Vulkan elsewhere. */
export type GraphCompilerBackend = 'metal' | 'd3d12' | 'vulkan' | 'unknown';

/** Device compile speed `s` before this device's first cold kernel compile. `s` scales
 * the graph-free kernel, which compiles at the same per-KB cost on every backend in
 * reference units: Metal 1 (Apple M4 Max), D3D12 1.5 (RTX 4060 Laptop, windows-1),
 * unmeasured backends 2. The graph-free kernel always compiles first, so the prior
 * rarely decides anything. */
export const GRAPH_COMPILE_SPEED_PRIORS: Readonly<Record<GraphCompilerBackend, number>> = {metal: 1, d3d12: 1.5, vulkan: 2, unknown: 2};

export function graphCompilerBackend(userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent): GraphCompilerBackend {
    if (/Windows/.test(userAgent)) return 'd3d12';
    if (/Macintosh|Mac OS X|iPhone|iPad/.test(userAgent)) return 'metal';
    if (/Linux|Android|CrOS/.test(userAgent)) return 'vulkan';
    return 'unknown';
}

/** Whole-kernel compile cost per backend in reference milliseconds (multiplied by the
 * device speed `s`): graph-free kernel per KB, specialized graph code per KB, and
 * interpreter source per KB beyond a free part. */
export interface GraphCompileCoefficients {
    graphFreeMsPerKB: number;
    msPerKB: number;
    interpreterMsPerKB: number;
    interpreterFreeKB: number;
}
/** The graph-free kernel compiles at ≈3.8 ms per KB on the reference platform
 * (248 KB in ≈0.95 s cold, P0). */
export const GRAPH_FREE_MS_PER_KB = 3.83;
const D3D12: GraphCompileCoefficients = {graphFreeMsPerKB: GRAPH_FREE_MS_PER_KB, msPerKB: 450, interpreterMsPerKB: 300, interpreterFreeKB: 3.3};
/**
 * Compile-cost shape per backend. Metal: P0–P2 (specialized 21 ms/KB, interpreter
 * 48 ms/KB beyond 3.6 KB). D3D12: windows-1 relative to each run's own graph-free
 * compile (s ≈ 1.5): specialized code costs ≈450 ms/KB (≈1.7 s per grid structure,
 * linear up to 173 KB), interpreter source ≈300 ms/KB beyond 3.3 KB (6.6 KB → +1.0,
 * 10.8 KB → +2.2 reference s). Unmeasured backends assume D3D12's costs: a wrong
 * pessimistic guess only keeps the interpreter, a wrong optimistic one starts
 * minute-long compiles.
 */
export const GRAPH_COMPILE_COEFFICIENTS: Readonly<Record<GraphCompilerBackend, GraphCompileCoefficients>> = {
    metal: {graphFreeMsPerKB: GRAPH_FREE_MS_PER_KB, msPerKB: 21, interpreterMsPerKB: 48, interpreterFreeKB: 3.6},
    d3d12: D3D12, vulkan: D3D12, unknown: D3D12
};
/** Graph-free megakernel size used before the first kernel of this device compiles. */
export const GRAPH_FREE_DEFAULT_BYTES = 248_000;

/** Source composition of one ray-tracing kernel. */
export interface GraphCompileSource {
    /** Whole WGSL module. */
    totalBytes: number;
    /** Specialized graph code (functions, dispatch branches, helper libraries). */
    specializedBytes: number;
    /** Generated interpreter source; 0 without the interpreter. */
    interpreterBytes: number;
}
/** Compile time of `source` in reference ms (device ms at `s` = 1). */
export function graphCompileReferenceMs(c: GraphCompileCoefficients, source: GraphCompileSource) {
    const graphBytes = source.specializedBytes + source.interpreterBytes;
    return Math.max(source.totalBytes - graphBytes, 0) / 1024 * c.graphFreeMsPerKB + source.specializedBytes / 1024 * c.msPerKB +
        (source.interpreterBytes ? c.interpreterMsPerKB * Math.max(0, source.interpreterBytes / 1024 - c.interpreterFreeKB) : 0);
}

/** One `createComputePipelineAsync` of the ray-tracing kernel. */
export interface GraphCompileSample extends GraphCompileSource {
    /** Wall time around the pipeline request. */
    ms: number;
    /** Part of `ms` during which another pipeline compile was in flight. */
    overlapMs: number;
}
export type GraphCompileSampleKind = 'cold' | 'queued' | 'cache-hit' | 'overlapped';
export interface GraphCompileObservation extends GraphCompileSample {
    kind: GraphCompileSampleKind;
    /** Prediction for this source at `s` = 1 before this observation. */
    referenceMs: number;
    /** Observed / predicted (corrected ms / (s × reference ms)) before this observation. */
    ratio: number;
    /** Device speed factor after this observation. */
    speed: number;
    /** Device specialized-cost factor after this observation. */
    specializedFactor: number;
}

/** A compile far below the prediction came from a driver or browser cache. */
const CACHE_HIT_RATIO = 0.25;
/** Overlapped time counted as queueing: on Metal two compiles run in parallel
 * and slow each other by ≈15 % (P2), a serializing driver would charge all of it. */
const QUEUE_SHARE = 0.5;
/** A sample mostly spent next to another compile says little about this one. */
const MAX_OVERLAP = 0.6;
/** A specialized compile this far above its prediction raises the device's specialized cost. */
const SPECIALIZED_SURPRISE = 1.5;
const SPEED_RANGE: readonly [number, number] = [0.2, 20];
const SPECIALIZED_FACTOR_MAX = 100;

/**
 * Per-device compile model: compile ms ≈ s × (graph-free + specialized + interpreter
 * terms of the backend's coefficients), with the specialized term multiplied by a
 * device factor (initially 1). `s` starts at the backend prior and follows cold
 * compiles without specialized code (graph-free kernels and interpreter variants,
 * which compile anyway) in log space, so it scales machine speed without changing the
 * shape. A specialized compile far above its prediction raises the specialized
 * factor to match it; nothing is compiled to measure. Cache hits and mostly
 * overlapped compiles are ignored, partly overlapped ones corrected. Memory only.
 */
export class GraphCompileCalibration {
    speed: number;
    prior: number;
    /** Debug override: a fixed factor that observations do not change (simulate slow devices). */
    override?: number;
    coefficients: GraphCompileCoefficients;
    /** Multiplies the backend's specialized cost on this device; raised by surprising specialized compiles. */
    specializedFactor = 1;
    readonly observations: GraphCompileObservation[] = [];
    /** Specialized-source cap of this device in KB, lowered when a verified upgrade is
     * not faster; undefined until the first rollback (policy default). */
    capKB?: number;
    /** Source size of the last graph-free kernel, for the cold base estimate. */
    graphFreeBytes = GRAPH_FREE_DEFAULT_BYTES;
    private cold = 0;
    constructor(public backend: GraphCompilerBackend) {
        this.speed = this.prior = GRAPH_COMPILE_SPEED_PRIORS[backend];
        this.coefficients = GRAPH_COMPILE_COEFFICIENTS[backend];
    }
    /** Debug: plan with another backend's shape (and its prior until a cold compile is seen). */
    useBackend(backend: GraphCompilerBackend) {
        if (backend === this.backend) return;
        this.backend = backend;
        this.coefficients = GRAPH_COMPILE_COEFFICIENTS[backend];
        this.prior = GRAPH_COMPILE_SPEED_PRIORS[backend];
        if (!this.cold) this.speed = this.prior;
        this.specializedFactor = 1;
    }
    get factor() { return this.override ?? this.speed; }
    /** Backend coefficients with this device's specialized factor, in reference ms. */
    get shape(): GraphCompileCoefficients { return {...this.coefficients, msPerKB: this.coefficients.msPerKB * this.specializedFactor}; }
    referenceMs(source: GraphCompileSource) { return graphCompileReferenceMs(this.shape, source); }
    predictMs(source: GraphCompileSource) { return this.factor * this.referenceMs(source); }
    /** Cold graph-free kernel compile on this device. */
    get graphFreeMs() { return this.factor * this.graphFreeBytes / 1024 * this.coefficients.graphFreeMsPerKB; }
    observe(sample: GraphCompileSample): GraphCompileObservation {
        if (!sample.specializedBytes && !sample.interpreterBytes) this.graphFreeBytes = sample.totalBytes;
        const referenceMs = Math.max(this.referenceMs(sample), 1);
        const corrected = sample.ms - QUEUE_SHARE * sample.overlapMs, ratio = corrected / (this.speed * referenceMs);
        let kind: GraphCompileSampleKind = sample.overlapMs > 0 ? 'queued' : 'cold';
        if (sample.overlapMs > MAX_OVERLAP * sample.ms) kind = 'overlapped';
        else if (ratio < CACHE_HIT_RATIO) kind = 'cache-hit';
        else if (!sample.specializedBytes) {
            // The first cold sample mostly replaces the prior; later ones average.
            const weight = Math.max(1 / (++this.cold), 0.3) * (kind === 'queued' ? 0.5 : 1);
            const log = Math.log(this.speed) + weight * Math.log(Math.max(ratio, 1e-3));
            this.speed = Math.min(Math.max(Math.exp(log), SPEED_RANGE[0]), SPEED_RANGE[1]);
        } else if (ratio > SPECIALIZED_SURPRISE) {
            // Attribute the excess to the specialized code: solve for its factor.
            const other = graphCompileReferenceMs({...this.coefficients, msPerKB: 0}, sample);
            const specialized = graphCompileReferenceMs({graphFreeMsPerKB: 0, msPerKB: this.coefficients.msPerKB, interpreterMsPerKB: 0, interpreterFreeKB: 0}, sample);
            const implied = (corrected / this.speed - other) / Math.max(specialized, 1e-3);
            this.specializedFactor = Math.min(Math.max(this.specializedFactor, implied), SPECIALIZED_FACTOR_MAX);
        }
        const observation = {...sample, kind, referenceMs, ratio, speed: this.speed, specializedFactor: this.specializedFactor};
        this.observations.push(observation);
        if (this.observations.length > 64) this.observations.shift();
        return observation;
    }
}

/** Scheduling class of a ray-tracing kernel compile: `edit` renders the requested
 * structures correctly, `upgrade` is a gated specialized variant, `prefetch` the
 * background editing interpreter. */
export type GraphCompileRole = 'edit' | 'upgrade' | 'prefetch';
/**
 * Index of the queued compile to start, or -1. The most recently queued edit first (a
 * dragged slider's last value is the one in use); background compiles only while
 * `reserved` slots stay free, so an edit never waits behind one in this queue (a
 * running WebGPU compile cannot be cancelled).
 */
export function nextGraphCompile(queue: readonly {role: GraphCompileRole}[], active: number, maxActive: number, reserved: number) {
    if (active >= maxActive) return -1;
    const edit = queue.findLastIndex(job => job.role === 'edit');
    if (edit >= 0) return edit;
    return active < maxActive - reserved ? queue.length - 1 : -1;
}

/** Compile intervals of one device: the overlap of a finished compile with others. */
export class GraphCompileClock {
    private running = new Map<number, number>();
    private finished: [number, number][] = [];
    private next = 0;
    start(now: number) { const id = this.next++; this.running.set(id, now); return id; }
    get inFlight() { return this.running.size; }
    /** Ends a compile; returns its duration and the time another compile was in flight. */
    end(id: number, now: number) {
        const start = this.running.get(id);
        if (start === undefined) return {ms: 0, overlapMs: 0};
        this.running.delete(id);
        const intervals: [number, number][] = [...this.finished.filter(([, e]) => e > start), ...[...this.running.values()].map(s => [s, now] as [number, number])];
        // Union of the other intervals clipped to this one.
        const clipped = intervals.map(([s, e]) => [Math.max(s, start), Math.min(e, now)] as [number, number]).filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0]);
        let overlapMs = 0, until = start;
        for (const [s, e] of clipped) { if (e > until) { overlapMs += e - Math.max(s, until); until = e; } }
        this.finished.push([start, now]);
        if (this.finished.length > 16) this.finished.shift();
        return {ms: now - start, overlapMs};
    }
}

/** Inputs of the upgrade decision for one structure set. */
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
 * phases decide when every phase has at least one; otherwise wall
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
        const gpu = this.phases.every(p => p.gpu.length > 0);
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
