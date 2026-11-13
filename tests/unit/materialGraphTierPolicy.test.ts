import {describe, expect, it} from 'vitest';
import {GRAPH_COMPILE_COEFFICIENTS, GRAPH_FREE_MS_PER_KB, GraphCompileCalibration, GraphCompileClock, GraphUpgradeVerifier, graphCompilerBackend, graphUpgradeGate, nextGraphCompile, type GraphUpgradeGateInput} from '../../src/renderer/materialGraph/tierPolicy.js';

/** A graph-free kernel of 250 KB: ≈ 958 ms on the reference platform. */
const graphFree = (ms: number, overlapMs = 0) => ({totalBytes: 250 * 1024, specializedBytes: 0, interpreterBytes: 0, ms, overlapMs});
const reference = 250 * GRAPH_FREE_MS_PER_KB;

describe('graph compile calibration', () => {
    it('selects the compile shape and prior by backend, pessimistic when unmeasured', () => {
        expect(graphCompilerBackend('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/131')).toBe('metal');
        expect(graphCompilerBackend('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131')).toBe('d3d12');
        expect(graphCompilerBackend('Mozilla/5.0 (X11; Linux x86_64) Chrome/131')).toBe('vulkan');
        const metal = new GraphCompileCalibration('metal'), d3d12 = new GraphCompileCalibration('d3d12');
        expect([metal.speed, d3d12.speed, new GraphCompileCalibration('unknown').speed]).toEqual([1, 1.5, 2]);
        // The graph-free kernel costs the same in reference units everywhere; graph code does not.
        const specialized = {totalBytes: 360 * 1024, specializedBytes: 110 * 1024, interpreterBytes: 0};
        expect(d3d12.referenceMs(graphFree(0))).toBeCloseTo(metal.referenceMs(graphFree(0)));
        expect(d3d12.referenceMs(specialized) / metal.referenceMs(specialized)).toBeGreaterThan(10);
        for (const backend of ['vulkan', 'unknown'] as const) {
            const c = GRAPH_COMPILE_COEFFICIENTS[backend];
            expect(c.msPerKB).toBeGreaterThanOrEqual(GRAPH_COMPILE_COEFFICIENTS.d3d12.msPerKB);
            expect(c.interpreterMsPerKB).toBeGreaterThanOrEqual(GRAPH_COMPILE_COEFFICIENTS.d3d12.interpreterMsPerKB);
        }
    });

    it('learns the device speed from graph-free and interpreter compiles without changing the shape', () => {
        const calibration = new GraphCompileCalibration('d3d12');
        expect(calibration.observe(graphFree(2 * reference)).kind).toBe('cold');
        expect(calibration.speed).toBeCloseTo(2);
        // An interpreter variant 2.2× slower than the reference shape.
        const interpreter = {totalBytes: 260 * 1024, specializedBytes: 0, interpreterBytes: 10 * 1024};
        calibration.observe({...interpreter, ms: 2.2 * calibration.referenceMs(interpreter), overlapMs: 0});
        expect(calibration.speed).toBeGreaterThan(2);
        expect(calibration.speed).toBeLessThan(2.2);
        expect(calibration.predictMs(interpreter)).toBeCloseTo(calibration.speed * calibration.referenceMs(interpreter));
        expect(calibration.graphFreeMs).toBeCloseTo(calibration.speed * reference);
        expect(calibration.specializedFactor).toBe(1);
    });

    it('raises the specialized cost after a far slower specialized compile, never the speed', () => {
        const calibration = new GraphCompileCalibration('metal');
        calibration.observe(graphFree(reference));
        // A Metal-shaped prediction for 100 KB specialized, observed 20× slower in its specialized part.
        const variant = {totalBytes: 350 * 1024, specializedBytes: 100 * 1024, interpreterBytes: 0};
        const ms = reference + 20 * 100 * GRAPH_COMPILE_COEFFICIENTS.metal.msPerKB;
        calibration.observe({...variant, ms, overlapMs: 0});
        expect(calibration.speed).toBeCloseTo(1);
        expect(calibration.specializedFactor).toBeCloseTo(20);
        expect(calibration.predictMs(variant)).toBeCloseTo(ms);
        // A faster specialized compile does not lower it again.
        calibration.observe({...variant, ms: reference + 2000, overlapMs: 0});
        expect(calibration.specializedFactor).toBeCloseTo(20);
    });

    it('ignores driver cache hits', () => {
        const calibration = new GraphCompileCalibration('metal');
        const hit = calibration.observe(graphFree(50));
        expect(hit.kind).toBe('cache-hit');
        expect(calibration.speed).toBe(1);
        // A slow device's cache hit is judged against its own speed.
        const slow = new GraphCompileCalibration('unknown');
        expect(slow.observe(graphFree(400)).kind).toBe('cache-hit');
        expect(slow.speed).toBe(2);
    });

    it('corrects compiles queued behind another and skips mostly overlapped ones', () => {
        const queued = new GraphCompileCalibration('metal');
        // 400 ms of a 2.1 s compile overlapped: half of it counts as queueing.
        const sample = queued.observe(graphFree(2 * reference + 200, 400));
        expect(sample.kind).toBe('queued');
        expect(sample.ratio).toBeCloseTo(2);
        expect(queued.speed).toBeGreaterThan(1);
        expect(queued.speed).toBeLessThan(2);
        const overlapped = new GraphCompileCalibration('metal');
        expect(overlapped.observe(graphFree(3000, 2500)).kind).toBe('overlapped');
        expect(overlapped.speed).toBe(1);
    });

    it('keeps a debug override fixed and switches backends for simulation', () => {
        const calibration = new GraphCompileCalibration('metal');
        calibration.override = 3;
        calibration.observe(graphFree(reference));
        expect(calibration.factor).toBe(3);
        expect(calibration.speed).toBeCloseTo(1);
        calibration.useBackend('d3d12');
        expect(calibration.coefficients).toBe(GRAPH_COMPILE_COEFFICIENTS.d3d12);
        // The measured speed stays; only the shape changes.
        expect(calibration.speed).toBeCloseTo(1);
        // Before any cold compile the simulated backend's prior applies.
        const fresh = new GraphCompileCalibration('metal');
        fresh.useBackend('d3d12');
        expect(fresh.speed).toBe(1.5);
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

describe('graph compile queue', () => {
    const job = (role: 'edit' | 'upgrade' | 'prefetch') => ({role});
    it('starts edits before background compiles and keeps a slot free for edits', () => {
        // An upgrade queued before an edit: the edit starts first.
        expect(nextGraphCompile([job('upgrade'), job('edit')], 0, 2, 1)).toBe(1);
        expect(nextGraphCompile([job('edit'), job('upgrade'), job('edit')], 0, 2, 1)).toBe(2);
        // Background work alone starts only into an idle compiler...
        expect(nextGraphCompile([job('prefetch')], 0, 2, 1)).toBe(0);
        expect(nextGraphCompile([job('prefetch')], 1, 2, 1)).toBe(-1);
        // ...so an edit arriving while an upgrade runs takes the reserved slot at once.
        expect(nextGraphCompile([job('edit')], 1, 2, 1)).toBe(0);
        expect(nextGraphCompile([job('edit')], 2, 2, 1)).toBe(-1);
        expect(nextGraphCompile([], 0, 2, 1)).toBe(-1);
    });
});

describe('graph upgrade gate', () => {
    const input = (overrides: Partial<GraphUpgradeGateInput>): GraphUpgradeGateInput => ({now: 10000, stableSince: 0, debounceMs: 2000, compilesInFlight: 0, compileMs: 1000, maxCompileMs: 10000,
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

    it('never starts a compile predicted over the ceiling, whatever its benefit', () => {
        const long = input({compileMs: 12000, remainingSamples: 1e7});
        expect(graphUpgradeGate(long)).toMatchObject({start: false, reason: 'ceiling'});
        expect(graphUpgradeGate({...long, maxCompileMs: 15000}).start).toBe(true);
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
