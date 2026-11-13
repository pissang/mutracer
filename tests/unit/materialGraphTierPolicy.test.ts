import {describe, expect, it} from 'vitest';
import {GRAPH_FREE_MS_PER_KB, GraphCompileCalibration, GraphCompileClock, GraphUpgradeVerifier, graphCompilerBackend, graphUpgradeGate, type GraphUpgradeGateInput} from '../../src/renderer/materialGraph/tierPolicy.js';

const model = {msPerKB: 21, interpreterMsPerKB: 48, interpreterFreeKB: 3.6};
/** A graph-free kernel of 250 KB: ≈ 935 ms on the reference platform. */
const graphFree = (ms: number, overlapMs = 0) => ({totalBytes: 250 * 1024, specializedBytes: 0, interpreterBytes: 0, ms, overlapMs});

describe('graph compile calibration', () => {
    it('starts from the backend prior', () => {
        expect(graphCompilerBackend('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/131')).toBe('metal');
        expect(graphCompilerBackend('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131')).toBe('d3d12');
        expect(graphCompilerBackend('Mozilla/5.0 (X11; Linux x86_64) Chrome/131')).toBe('vulkan');
        expect(new GraphCompileCalibration('d3d12', model).speed).toBe(3);
        expect(new GraphCompileCalibration('unknown', model).speed).toBe(2);
    });

    it('replaces the prior with cold compiles of the graph-free kernel and of graph variants', () => {
        const calibration = new GraphCompileCalibration('d3d12', model);
        const reference = 250 * GRAPH_FREE_MS_PER_KB;
        const first = calibration.observe(graphFree(1.5 * reference));
        expect(first.kind).toBe('cold');
        expect(calibration.speed).toBeCloseTo(1.5);
        // A mixed variant: base + 40 KB specialized + 10 KB interpreter, 1.6× slower than the reference.
        const variant = {totalBytes: 300 * 1024, specializedBytes: 40 * 1024, interpreterBytes: 10 * 1024};
        const referenceMs = calibration.referenceMs(variant);
        expect(referenceMs).toBeCloseTo(reference + 40 * 21 + 48 * 6.4);
        calibration.observe({...variant, ms: 1.6 * referenceMs, overlapMs: 0});
        expect(calibration.speed).toBeGreaterThan(1.5);
        expect(calibration.speed).toBeLessThan(1.6);
        expect(calibration.predictMs(variant)).toBeCloseTo(calibration.speed * referenceMs);
        expect(calibration.graphFreeMs).toBeCloseTo(calibration.speed * reference);
    });

    it('ignores driver cache hits', () => {
        const calibration = new GraphCompileCalibration('metal', model);
        const hit = calibration.observe(graphFree(50));
        expect(hit.kind).toBe('cache-hit');
        expect(calibration.speed).toBe(1);
        // A slow device's cache hit is judged against its own speed.
        const slow = new GraphCompileCalibration('d3d12', model);
        expect(slow.observe(graphFree(500)).kind).toBe('cache-hit');
        expect(slow.speed).toBe(3);
    });

    it('corrects compiles queued behind another and skips mostly overlapped ones', () => {
        const reference = 250 * GRAPH_FREE_MS_PER_KB;
        const queued = new GraphCompileCalibration('metal', model);
        // 400 ms of a 2.4 s compile overlapped: half of it counts as queueing.
        const sample = queued.observe(graphFree(2 * reference + 200, 400));
        expect(sample.kind).toBe('queued');
        expect(sample.ratio).toBeCloseTo(2);
        expect(queued.speed).toBeGreaterThan(1);
        expect(queued.speed).toBeLessThan(2);
        const overlapped = new GraphCompileCalibration('metal', model);
        expect(overlapped.observe(graphFree(3000, 2500)).kind).toBe('overlapped');
        expect(overlapped.speed).toBe(1);
    });

    it('keeps a debug override fixed', () => {
        const calibration = new GraphCompileCalibration('metal', model);
        calibration.override = 3;
        calibration.observe(graphFree(250 * GRAPH_FREE_MS_PER_KB));
        expect(calibration.factor).toBe(3);
        expect(calibration.speed).toBeCloseTo(1);
    });

    it('measures the overlap of one compile with others', () => {
        const clock = new GraphCompileClock();
        const a = clock.start(0), b = clock.start(100);
        expect(clock.end(a, 1000)).toEqual({ms: 1000, overlapMs: 900});
        const c = clock.start(1200);
        expect(clock.end(b, 1500)).toEqual({ms: 1400, overlapMs: 900 + 300});
        expect(clock.end(c, 2000)).toEqual({ms: 800, overlapMs: 300});
        expect(clock.end(c, 2100)).toEqual({ms: 0, overlapMs: 0});
    });
});

describe('graph upgrade gate', () => {
    const input = (overrides: Partial<GraphUpgradeGateInput>): GraphUpgradeGateInput => ({now: 10000, stableSince: 0, debounceMs: 2000, compilesInFlight: 0, compileMs: 1000,
        gain: 0.2, msPerSample: 10, remainingSamples: 2000, renderedMs: 10000, margin: 2, maxHorizonMs: 60000, ...overrides});

    it('waits for a stable structure set and an idle compiler', () => {
        expect(graphUpgradeGate(input({stableSince: 9000})).reason).toBe('debounce');
        expect(graphUpgradeGate(input({compilesInFlight: 1})).reason).toBe('compiling');
        expect(graphUpgradeGate(input({msPerSample: undefined})).reason).toBe('unmeasured');
    });

    it('starts only when the saved render time clearly exceeds the compile time', () => {
        // (2000 × 10 − 1000) × 0.2 = 3800 > 2 × 1000.
        expect(graphUpgradeGate(input({})).start).toBe(true);
        // (500 × 10 − 1000) × 0.2 = 800.
        const short = graphUpgradeGate(input({remainingSamples: 500}));
        expect(short).toMatchObject({start: false, reason: 'benefit', remainingMs: 5000, benefitMs: 800});
        // A slow compiler needs more remaining time for the same saving.
        expect(graphUpgradeGate(input({compileMs: 4000})).start).toBe(false);
    });

    it('expects as much remaining time as already rendered without a sample target', () => {
        const unbounded = {remainingSamples: undefined};
        expect(graphUpgradeGate(input({...unbounded, renderedMs: 5000})).start).toBe(false);
        expect(graphUpgradeGate(input({...unbounded, renderedMs: 20000})).start).toBe(true);
        expect(graphUpgradeGate(input({...unbounded, renderedMs: 1e6})).remainingMs).toBe(60000);
    });
});

describe('graph upgrade verification', () => {
    /** Renders the six phases; `time(tier)` gives the per-sample GPU (and wall) time. */
    function run(verifier: GraphUpgradeVerifier, time: (tier: 'final' | 'interim') => number, timestamps = true, view = () => 1) {
        let now = 0;
        for (let i = 0; i < 200 && !verifier.decision; i++) {
            const tier = verifier.tier, ms = time(tier);
            now += ms;
            verifier.frame(tier, view(), 1, now);
            if (timestamps) verifier.gpu(tier, view(), ms);
        }
        return verifier.decision;
    }

    it('keeps a clearly faster upgrade and alternates tiers in ABBA order', () => {
        const verifier = new GraphUpgradeVerifier({minGain: 0.03, phaseSamples: 4, minTimestamps: 3, minPhaseMs: 30, maxPhaseMs: 100});
        const order: string[] = [];
        const decision = run(verifier, tier => { if (order.at(-1) !== tier) order.push(tier); return tier === 'final' ? 9 : 10; });
        expect(order).toEqual(['final', 'interim', 'final', 'interim']);
        expect(decision).toMatchObject({keep: true, method: 'gpu'});
        expect(decision!.gain).toBeCloseTo(0.1);
        expect(verifier.tier).toBe('final');
    });

    it('rolls back below the minimum gain', () => {
        const verifier = new GraphUpgradeVerifier({minGain: 0.03, phaseSamples: 4, minTimestamps: 3, minPhaseMs: 30, maxPhaseMs: 100});
        expect(run(verifier, tier => tier === 'final' ? 9.8 : 10)).toMatchObject({keep: false});
        expect(verifier.tier).toBe('interim');
    });

    it('falls back to wall time per sample without enough timestamps', () => {
        const verifier = new GraphUpgradeVerifier({minGain: 0.03, phaseSamples: 4, minTimestamps: 3, minPhaseMs: 30, maxPhaseMs: 100});
        const decision = run(verifier, tier => tier === 'final' ? 8 : 10, false);
        expect(decision).toMatchObject({keep: true, method: 'wall'});
        expect(decision!.gain).toBeCloseTo(0.2);
    });

    it('discards the current phase when the view changes', () => {
        const verifier = new GraphUpgradeVerifier({minGain: 0.03, phaseSamples: 4, minTimestamps: 3, minPhaseMs: 30, maxPhaseMs: 100});
        let frames = 0;
        // A camera move during the first phase with a very slow sample: it must not count.
        const decision = run(verifier, tier => { frames++; return frames === 3 ? 1000 : tier === 'final' ? 9 : 10; }, true, () => frames < 3 ? 1 : 2);
        expect(decision?.gain).toBeCloseTo(0.1);
    });
});
