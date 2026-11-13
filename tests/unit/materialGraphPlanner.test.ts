import {afterEach, describe, expect, it} from 'vitest';
import MaterialGraph, {type MaterialGraphNode} from '../../src/scene/MaterialGraph.js';
import OpenPBRMaterial from '../../src/scene/OpenPBRMaterial.js';
import {GraphOp} from '../../src/renderer/materialGraph/interpreter.js';
import {planGraphTiers, type GraphTierCandidate} from '../../src/renderer/materialGraph/planner.js';
import {MaterialGraphState, graphShaderKey, setMaterialGraphPlanner, type GraphInstallEvent, type GraphPlan, type GraphUpgradeEvent} from '../../src/renderer/materialGraph/state.js';
import {materialGraphShader} from '../../src/renderer/materialGraph/shader.js';
import {materialSurfaceAreas} from '../../src/renderer/materialGraph/usage.js';
import Geometry, {Attribute} from '../../src/scene/Geometry.js';
import Mesh from '../../src/scene/Mesh.js';
import InstancedMesh from '../../src/scene/InstancedMesh.js';
import {MATERIAL_FLOAT_COUNT, materialLayoutFields} from '../../src/renderer/materialLayoutSchema.js';

const model = {msPerKB: 100, interpreterMs: 300, interpreterMsPerKB: 0, interpreterFreeKB: 0, helperBytes: {noise: 2048}};
// State-level plans charge the interpreter by its generated source; zero keeps budgets exact here.
const tierModel = {...model, helperBytes: {}};
const budget = {budgetMs: 1000, correctMs: 1000, minBenefitShare: 0.05};
const candidate = (key: string, usage: number, kb = 1, instructions: number | undefined = 10, helpers?: string[]): GraphTierCandidate =>
    ({key, usage, sourceBytes: kb * 1024, instructions, helpers});

describe('material graph tier planner', () => {
    it('omits the interpreter when every structure fits the budget', () => {
        const decision = planGraphTiers([candidate('a', 1, 4), candidate('b', 1, 5)], model, budget);
        expect(decision.interpreter).toBe(false);
        expect([...decision.specialized].sort()).toEqual(['a', 'b']);
        expect(decision.estimatedMs).toBeCloseTo(900);
    });

    it('charges the interpreter and fills the rest by benefit per compile ms', () => {
        // 12 KB do not fit; with the interpreter 700 ms remain for specialized code.
        const decision = planGraphTiers([
            candidate('hot', 100, 3), candidate('warm', 50, 3), candidate('big', 90, 6), candidate('cold', 1, 1), candidate('unused', 0, 0.1)
        ], model, budget);
        expect(decision.interpreter).toBe(true);
        // hot (33/KB) and warm (17/KB) rank before big (15/KB); big no longer fits, cold does.
        expect([...decision.specialized].sort()).toEqual(['cold', 'hot', 'warm']);
        expect(decision.estimatedMs).toBeLessThanOrEqual(budget.budgetMs);
        expect(decision.coverage).toBeCloseTo((10 * 151) / (10 * 241));
    });

    it('charges the interpreter by the cost passed for its families', () => {
        const set = [candidate('a', 10, 3), candidate('b', 5, 3), candidate('c', 1, 3), candidate('d', 1, 3)];
        expect(planGraphTiers(set, model, budget, 600).specialized.size).toBe(1);
        expect(planGraphTiers(set, model, budget, 100).specialized.size).toBe(3);
    });

    it('weighs usage by per-hit interpreter work, not by a fixed ratio', () => {
        const decision = planGraphTiers([candidate('long', 10, 6, 40), candidate('short', 30, 6, 5)], model, budget);
        expect([...decision.specialized]).toEqual(['long']);
    });

    it('always specializes structures the interpreter cannot run', () => {
        const decision = planGraphTiers([{...candidate('wide', 0, 2), instructions: undefined}, ...Array.from({length: 10}, (_, i) => candidate(`s${i}`, 1, 2))], model, budget);
        expect(decision.interpreter).toBe(true);
        expect(decision.specialized.has('wide')).toBe(true);
        // 300 ms interpreter + 200 ms forced leave room for two more 200 ms structures.
        expect(decision.specialized.size).toBe(3);
    });

    it('keeps every structure interpreted when specialization would cover too little work', () => {
        const decision = planGraphTiers(Array.from({length: 100}, (_, i) => candidate(`s${i}`, 1, 2)), model, budget);
        // Three structures fit, covering 3 % of the work.
        expect(decision.interpreter).toBe(true);
        expect(decision.specialized.size).toBe(0);
        expect(decision.estimatedMs).toBe(model.interpreterMs);
    });

    it('caps the total specialized source independently of the compile budget', () => {
        const set = [candidate('a', 10, 3), candidate('b', 5, 3), candidate('c', 4, 3)];
        // 9 KB fit the 1000 ms budget, but not a 7 KB cap: the interpreter takes the rest.
        const capped = planGraphTiers(set, model, {...budget, budgetMs: 2000, capKB: 7});
        expect(capped.interpreter).toBe(true);
        expect([...capped.specialized].sort()).toEqual(['a', 'b']);
        expect(capped.specializedBytes).toBe(6 * 1024);
        expect(planGraphTiers(set, model, {...budget, budgetMs: 2000}).interpreter).toBe(false);
    });

    it('counts helper libraries once and only without the interpreter', () => {
        // 3 + 3 KB plus a 2 KB library: 800 ms without the interpreter.
        const noisy = [candidate('a', 1, 3, 10, ['noise']), candidate('b', 2, 3, 10, ['noise'])];
        expect(planGraphTiers(noisy, model, {...budget, budgetMs: 800}).interpreter).toBe(false);
        // Over budget: the interpreter carries the library, but specializing both
        // would again need it inline, so one structure stays interpreted.
        const tight = planGraphTiers(noisy, model, {...budget, budgetMs: 700});
        expect(tight.interpreter).toBe(true);
        expect([...tight.specialized]).toEqual(['b']);
    });
});

/** A distinct structure per `k`: a chain of k unary nodes over UV. */
function chainGraph(k: number) {
    const nodes: MaterialGraphNode[] = [
        {id: 'uv', category: 'texcoord', type: 'vector2'},
        {id: 'n0', category: 'extract', type: 'float', inputs: {in: {type: 'vector2', connection: {node: 'uv'}}, index: {type: 'integer', value: 0}}}
    ];
    for (let i = 1; i <= k; i++) nodes.push({id: `n${i}`, category: i % 2 ? 'sin' : 'cos', type: 'float', inputs: {in: {type: 'float', connection: {node: `n${i - 1}`}}}});
    return new MaterialGraph({nodes, terminal: {specularRoughness: {node: `n${k}`}}});
}

/** `chainGraph(k)` with a final multiply by `scale` (a parameter) and, with `clamp`, a clamp node (another opcode family). */
function scaledGraph(k: number, scale: number, clamp = false) {
    const base = chainGraph(k), nodes = [...base.nodes] as MaterialGraphNode[];
    nodes.push({id: 'scale', category: 'multiply', type: 'float', inputs: {in1: {type: 'float', connection: {node: `n${k}`}}, in2: {type: 'float', value: scale}}});
    if (clamp) nodes.push({id: 'clamped', category: 'clamp', type: 'float', inputs: {in: {type: 'float', connection: {node: 'scale'}}}});
    return new MaterialGraph({nodes, terminal: {specularRoughness: {node: clamp ? 'clamped' : 'scale'}}});
}

describe('material graph tier plans', () => {
    afterEach(() => setMaterialGraphPlanner());
    const field = (name: string) => materialLayoutFields().find(f => f.name === name)!.offset / 4;
    const id = (packed: Float32Array, i: number) => packed[i * MATERIAL_FLOAT_COUNT + field('_padding1')];
    const policy = {debounceMs: 1000, margin: 2, interpreterGain: 0.3};
    const mixed = {model: tierModel, budget: {budgetMs: 600, correctMs: 600, minBenefitShare: 0.05}, policy, compileSpeed: 1};
    const newState = () => { const state = new MaterialGraphState(); state.interpreterAvailable = true; return state; };
    /** Renders `samples` samples at `ms` wall time each on the installed variant. */
    const render = (state: MaterialGraphState, samples: number, ms: number, start: number, maxSamples = 1e5) => {
        for (let i = 1; i <= samples; i++) state.recordFrame(1, i, maxSamples, 1, start + i * ms);
        return start + samples * ms;
    };

    it('serves a mixed set with the interpreter first and compiles the upgrade only through the gate', () => {
        const installs: GraphInstallEvent[] = [], upgrades: GraphUpgradeEvent[] = [];
        setMaterialGraphPlanner({...mixed, onInstall: e => installs.push(e), onUpgrade: e => upgrades.push(e)});
        const materials = Array.from({length: 8}, (_, i) => new OpenPBRMaterial({graph: chainGraph(i + 1)}));
        const usage = new Map<unknown, number>(materials.map((m, i) => [m, i === 5 ? 1000 : i === 2 ? 500 : 1]));
        const state = newState();
        state.usage = () => usage;
        state.request([...materials, new OpenPBRMaterial()]);
        const serving = state.requested;
        expect(serving.specialized).toEqual([]);
        expect(serving.programs!.size).toBe(8);
        // The serving interpreter compiles only the opcode families its programs use.
        expect([...serving.interpreterFamilies!].sort()).toEqual([GraphOp.Unary, GraphOp.Extract, GraphOp.Geometry].sort());
        expect(materialGraphShader(serving).graph!.declarations).not.toContain('mx_fractal');
        expect(state.phase).toBe('waiting');
        const generation = state.generation;
        expect(state.installShader(graphShaderKey(serving))).toBe(true);
        expect(state.generation).toBe(generation + 1);
        let packed = state.pack(new Float32Array(9 * MATERIAL_FLOAT_COUNT), []);
        for (let i = 0; i < 8; i++) expect(id(packed, i)).toBeLessThan(0);

        // Debounce, then the gate needs a measured sample time and enough remaining render time.
        const t0 = performance.now();
        state.tick(0, t0 + 10);
        expect(state.lastGate).toBeUndefined();
        // 10 samples left at 10 ms do not repay a ≈1 s compile.
        let now = render(state, 10, 10, t0 + 1000, 20);
        state.tick(0, now);
        expect(state.lastGate?.reason).toBe('benefit');
        expect(state.requested.shaderKey).toBe(serving.shaderKey);
        now = render(state, 400, 10, now);
        state.tick(1, now);
        expect(state.lastGate?.reason).toBe('compiling');
        state.tick(0, now);
        expect(state.phase).toBe('compiling');
        const final = state.requested;
        expect(final.programs!.size).toBeGreaterThan(0);
        expect(final.specialized!.map(g => g.key)).toContain(final.graphs[5]!.key);
        const variant = materialGraphShader(final).graph!;
        expect(variant.interpreter).toBe(true);
        expect(variant.declarations).toContain('mx_eval_1');
        expect(upgrades.map(e => e.type)).toEqual(['hold', 'start']);

        // The upgrade swaps tiers without restarting accumulation, then is verified.
        expect(state.installShader(graphShaderKey(final))).toBe(true);
        expect(state.generation).toBe(generation + 1);
        expect(state.phase).toBe('verifying');
        packed = state.pack(new Float32Array(9 * MATERIAL_FLOAT_COUNT), []);
        for (let i = 0; i < 8; i++) {
            const at = final.specialized!.findIndex(g => g.key === final.graphs[i]!.key);
            if (at >= 0) expect(id(packed, i)).toBe(at + 1); else expect(id(packed, i)).toBeLessThan(0);
        }
        expect(id(packed, 8)).toBe(0);
        expect(installs.map(e => e.role)).toEqual(['serving', 'upgrade']);
    });

    /** Installs the serving plan and starts and installs the upgrade of a mixed 8-structure set. */
    function upgraded(onUpgrade?: (e: GraphUpgradeEvent) => void) {
        setMaterialGraphPlanner({...mixed, onUpgrade});
        const materials = Array.from({length: 8}, (_, i) => new OpenPBRMaterial({graph: chainGraph(i + 1)}));
        const state = newState();
        state.request(materials);
        state.installShader(graphShaderKey(state.requested));
        const serving = state.requested;
        let now = render(state, 400, 10, performance.now() + 1000);
        state.tick(0, now);
        const final = state.requested;
        state.installShader(graphShaderKey(final));
        return {state, materials, serving, final, now};
    }
    /** Runs the verification phases with GPU timestamps `finalMs` / `interimMs`. */
    function verify(state: MaterialGraphState, serving: GraphPlan, final: GraphPlan, finalMs: number, interimMs: number, now: number) {
        for (let phase = 0; phase < 6 && state.phase === 'verifying'; phase++) {
            const key = graphShaderKey(state.active);
            for (let i = 0; i < 9; i++) {
                now += 40;
                state.recordFrame(1, 500 + phase * 9 + i, Infinity, 1, now);
                state.recordGpuSample(key, 1, key === graphShaderKey(final) ? finalMs : interimMs);
            }
            state.tick(0, now);
            if (graphShaderKey(state.requested) !== key) expect(state.installShader(graphShaderKey(state.requested))).toBe(true);
        }
        expect(graphShaderKey(serving)).not.toBe(graphShaderKey(final));
        return now;
    }

    it('keeps a verified upgrade that is faster than the serving variant', () => {
        const events: GraphUpgradeEvent[] = [];
        const {state, serving, final, now} = upgraded(e => events.push(e));
        verify(state, serving, final, 9, 10, now);
        expect(state.phase).toBe('done');
        expect(graphShaderKey(state.active)).toBe(graphShaderKey(final));
        expect(events.at(-1)?.type).toBe('keep');
        expect(events.at(-1)?.verification?.gain).toBeCloseTo(0.1);
        expect(events.at(-1)?.verification?.method).toBe('gpu');
    });

    it('rolls back an upgrade that is not clearly faster, lowers the cap and does not retry the set', () => {
        const events: GraphUpgradeEvent[] = [];
        const {state, materials, serving, final, now} = upgraded(e => events.push(e));
        verify(state, serving, final, 9.9, 10, now);
        expect(state.phase).toBe('rejected');
        expect(graphShaderKey(state.requested)).toBe(graphShaderKey(serving));
        // The last verification phase already runs the serving variant.
        expect(graphShaderKey(state.active)).toBe(graphShaderKey(serving));
        expect(events.at(-1)?.type).toBe('rollback');
        // 0.7 × the rejected specialized source, but not below the 16 KB floor.
        expect(state.calibration.capKB).toBe(Math.max(16, 0.7 * final.shape!.specializedBytes / 1024));
        // The same structure set is not upgraded again (no flip-flop).
        state.request(materials);
        state.tick(0, now + 1e6);
        expect(state.phase).toBe('rejected');
    });

    it('discards a stale upgrade when the structure set changes while it compiles', () => {
        const events: GraphUpgradeEvent[] = [];
        setMaterialGraphPlanner({...mixed, onUpgrade: e => events.push(e)});
        const materials = Array.from({length: 8}, (_, i) => new OpenPBRMaterial({graph: chainGraph(i + 1)}));
        const state = newState();
        state.request(materials);
        state.installShader(graphShaderKey(state.requested));
        const serving = state.requested;
        state.tick(0, render(state, 400, 10, performance.now() + 1000));
        const final = state.requested;
        expect(state.phase).toBe('compiling');
        // A ninth structure fits the installed interpreter: no compile, the upgrade is stale.
        state.request([...materials, new OpenPBRMaterial({graph: chainGraph(9)})]);
        expect(events.map(e => e.type)).toEqual(['start', 'stale']);
        expect(graphShaderKey(state.requested)).toBe(graphShaderKey(serving));
        expect(state.installShader(graphShaderKey(final))).toBe(false);
        expect(state.phase).toBe('waiting');
    });

    it('never compiles for parameter edits on either tier', () => {
        for (const tier of ['specialized', 'interpreter'] as const) {
            setMaterialGraphPlanner({tier});
            const materials = [new OpenPBRMaterial({graph: scaledGraph(1, 2)}), new OpenPBRMaterial({graph: scaledGraph(2, 3)})];
            const state = newState();
            state.request(materials);
            const key = graphShaderKey(state.requested);
            state.installShader(key);
            const generation = state.generation, revision = state.revision;
            materials[0].graph = scaledGraph(1, 5);
            state.request(materials);
            // Same variant, installed synchronously; only the material buffer changes.
            expect(graphShaderKey(state.requested)).toBe(key);
            expect(graphShaderKey(state.active)).toBe(key);
            expect(state.status).toBe('ready');
            expect(state.revision).toBe(revision + 1);
            expect(state.installedRevision).toBe(state.revision);
            expect(state.generation).toBe(generation);
            const packed = state.pack(new Float32Array(2 * MATERIAL_FLOAT_COUNT), []);
            expect([...packed]).toContain(5);
        }
    });

    it('runs structural edits on the installed variant: specialized code stays, new structures are interpreted', () => {
        setMaterialGraphPlanner(mixed);
        const materials = Array.from({length: 8}, (_, i) => new OpenPBRMaterial({graph: chainGraph(i + 1)}));
        const state = newState();
        state.request(materials);
        state.installShader(graphShaderKey(state.requested));
        state.tick(0, render(state, 400, 10, performance.now() + 1000));
        const final = state.requested;
        state.installShader(graphShaderKey(final));
        const specialized = final.specialized!.map(g => g.key);
        // Replace one interpreted structure with a new one and remove a specialized one.
        const removed = materials.findIndex(m => specialized.includes(final.graphs[materials.indexOf(m)]!.key));
        const edited = materials.map((m, i) => i === removed ? new OpenPBRMaterial() : m);
        edited.push(new OpenPBRMaterial({graph: chainGraph(12)}));
        state.request(edited);
        const plan = state.requested;
        expect(graphShaderKey(plan)).toBe(graphShaderKey(final));
        expect(state.installShader(graphShaderKey(plan))).toBe(true);
        const packed = state.pack(new Float32Array(edited.length * MATERIAL_FLOAT_COUNT), []);
        edited.forEach((m, i) => {
            const graph = plan.graphs[i];
            if (!graph) return;
            const at = specialized.indexOf(graph.key);
            // Specialized structures keep their function IDs (a removed one stays as dead code).
            if (at >= 0) expect(id(packed, i)).toBe(at + 1); else expect(id(packed, i)).toBeLessThan(0);
        });
        expect(id(packed, edited.length - 1)).toBeLessThan(0);
        expect(state.phase).toBe('waiting');
    });

    it('switches structural edits to the full interpreter when a new opcode family does not fit', () => {
        setMaterialGraphPlanner(mixed);
        const state = newState();
        state.request([new OpenPBRMaterial({graph: chainGraph(1)}), new OpenPBRMaterial({graph: chainGraph(2)})]);
        // A small set is specialized directly.
        expect(state.requested.programs!.size).toBe(0);
        expect(materialGraphShader(state.requested).graph!.interpreter).toBeUndefined();
        state.installShader(graphShaderKey(state.requested));
        state.request([new OpenPBRMaterial({graph: chainGraph(1)}), new OpenPBRMaterial({graph: scaledGraph(2, 2, true)})]);
        const full = state.requested;
        expect(full.specialized).toEqual([]);
        expect(full.interpreterFamilies!.has(GraphOp.Noise)).toBe(true);
        expect(full.interpreterTerminals).toContain('baseColor');
        state.installShader(graphShaderKey(full));
        // Later edits with other families and plain terminals fit without a compile.
        const color = new MaterialGraph({nodes: [{id: 'uv', category: 'texcoord', type: 'vector2'}, {id: 'n', category: 'noise2d', type: 'color3', inputs: {texcoord: {type: 'vector2', connection: {node: 'uv'}}}}],
            terminal: {baseColor: {node: 'n'}}});
        state.request([new OpenPBRMaterial({graph: color}), new OpenPBRMaterial({graph: scaledGraph(3, 1)})]);
        expect(graphShaderKey(state.requested)).toBe(graphShaderKey(full));
    });

    it('prefetches the editing interpreter once after the first structural edit', () => {
        setMaterialGraphPlanner(mixed);
        const materials = Array.from({length: 8}, (_, i) => new OpenPBRMaterial({graph: chainGraph(i + 1)}));
        const state = newState();
        state.request(materials);
        state.installShader(graphShaderKey(state.requested));
        expect(state.prefetch(0)).toBeUndefined();
        // An edit that fits the installed (trimmed) interpreter.
        state.request([...materials.slice(1), new OpenPBRMaterial({graph: chainGraph(9)})]);
        state.installShader(graphShaderKey(state.requested));
        expect(state.prefetch(1)).toBeUndefined();
        const prefetch = state.prefetch(0)!;
        expect(prefetch.interpreterFamilies!.has(GraphOp.Noise)).toBe(true);
        expect(state.prefetch(0)).toBeUndefined();
        // A later edit with a new family uses exactly the prefetched variant.
        state.request([...materials.slice(1), new OpenPBRMaterial({graph: scaledGraph(9, 2, true)})]);
        expect(graphShaderKey(state.requested)).toBe(graphShaderKey(prefetch));
    });

    it('limits the editing interpreter to the set families when all families are predicted over the correct-frame budget', () => {
        setMaterialGraphPlanner({...mixed, model: {...tierModel, interpreterMsPerKB: 48, interpreterFreeKB: 3.6}, compileSpeed: 20});
        const state = newState();
        state.request([new OpenPBRMaterial({graph: chainGraph(1)})]);
        state.installShader(graphShaderKey(state.requested));
        state.request([new OpenPBRMaterial({graph: scaledGraph(2, 2)})]);
        expect([...state.requested.interpreterFamilies!].sort()).toEqual([GraphOp.Unary, GraphOp.Binary, GraphOp.Extract, GraphOp.Geometry].sort());
    });

    it('keeps tier decisions for an unchanged structure set when usage changes', () => {
        setMaterialGraphPlanner({...mixed, interim: false});
        const materials = Array.from({length: 8}, (_, i) => new OpenPBRMaterial({graph: chainGraph(i + 1)}));
        let usage = new Map<unknown, number>(materials.map((m, i) => [m, i === 0 ? 100 : 1]));
        const state = newState();
        state.usage = () => usage;
        state.request(materials);
        const before = graphShaderKey(state.requested);
        usage = new Map(materials.map((m, i) => [m, i === 7 ? 100 : 1]));
        state.request(materials);
        expect(graphShaderKey(state.requested)).toBe(before);
    });

    it('keeps the serving variant when the upgrade fails', () => {
        setMaterialGraphPlanner(mixed);
        const state = newState();
        state.request(Array.from({length: 8}, (_, i) => new OpenPBRMaterial({graph: chainGraph(i + 1)})));
        const serving = graphShaderKey(state.requested);
        state.installShader(serving);
        state.tick(0, render(state, 400, 10, performance.now() + 1000));
        const final = graphShaderKey(state.requested);
        expect(state.abandonUpgrade(serving)).toBe(false);
        expect(state.abandonUpgrade(final)).toBe(true);
        expect(state.phase).toBe('failed');
        expect(state.upgrading).toBe(false);
        expect(state.status).toBe('ready');
        expect(graphShaderKey(state.requested)).toBe(serving);
    });

    it('forces one tier for measurement', () => {
        const materials = Array.from({length: 4}, (_, i) => new OpenPBRMaterial({graph: chainGraph(i + 1)}));
        setMaterialGraphPlanner({tier: 'interpreter'});
        const state = newState();
        state.request(materials);
        expect(state.requested.specialized).toEqual([]);
        expect(state.phase).toBe('none');
        setMaterialGraphPlanner({tier: 'specialized', model: {...tierModel, msPerKB: 1e6}});
        state.request(materials);
        expect(state.requested.programs!.size).toBe(0);
    });
});

describe('material graph usage weights', () => {
    it('sums world-space area per material over visible meshes and instances', () => {
        // Two unit right triangles: slot 0 and slot 1.
        const geometry = new Geometry({position: new Attribute(new Float32Array([0,0,0, 1,0,0, 0,1,0, 0,0,0, 1,0,0, 0,0,1]), 3),
            materialIndex: new Attribute(new Int32Array([0,0,0,1,1,1]), 1)});
        const a = new OpenPBRMaterial(), b = new OpenPBRMaterial(), c = new OpenPBRMaterial();
        const scaled = new Mesh(geometry, [a, b]);
        scaled.transform[0] = scaled.transform[5] = scaled.transform[10] = 2;
        const instanced = new InstancedMesh(geometry, [a], {count: 3});
        const hidden = new Mesh(geometry, [c]);
        hidden.visible = false;
        const areas = materialSurfaceAreas([scaled, instanced, hidden]);
        // Scale 2 → area ×4; a single-material mesh uses its material for every slot.
        expect(areas.get(a)).toBeCloseTo(0.5 * 4 + 3 * 1);
        expect(areas.get(b)).toBeCloseTo(0.5 * 4);
        expect(areas.has(c)).toBe(false);
    });
});
