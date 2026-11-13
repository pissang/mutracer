import {afterEach, describe, expect, it} from 'vitest';
import MaterialGraph, {type MaterialGraphNode} from '../../src/scene/MaterialGraph.js';
import OpenPBRMaterial from '../../src/scene/OpenPBRMaterial.js';
import {planGraphTiers, type GraphTierCandidate} from '../../src/renderer/materialGraph/planner.js';
import {MaterialGraphState, graphShaderKey, setMaterialGraphPlanner, type GraphInstallEvent} from '../../src/renderer/materialGraph/state.js';
import {materialGraphShader} from '../../src/renderer/materialGraph/shader.js';
import {materialSurfaceAreas} from '../../src/renderer/materialGraph/usage.js';
import Geometry, {Attribute} from '../../src/scene/Geometry.js';
import Mesh from '../../src/scene/Mesh.js';
import InstancedMesh from '../../src/scene/InstancedMesh.js';
import {MATERIAL_FLOAT_COUNT, materialLayoutFields} from '../../src/renderer/materialLayoutSchema.js';

const model = {msPerKB: 100, interpreterMs: 300, helperBytes: {noise: 2048}};
const budget = {budgetMs: 1000, minBenefitShare: 0.05};
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

describe('material graph tier plans', () => {
    afterEach(() => setMaterialGraphPlanner());
    const field = (name: string) => materialLayoutFields().find(f => f.name === name)!.offset / 4;

    it('builds a mixed final plan with an interpreter-only interim and installs them progressively', () => {
        const installs: GraphInstallEvent[] = [];
        // Room for the interpreter and about two specialized structures.
        setMaterialGraphPlanner({model: {msPerKB: 100, interpreterMs: 300, helperBytes: {}}, budget: {budgetMs: 600, minBenefitShare: 0.05}, onInstall: e => installs.push(e)});
        const materials = Array.from({length: 8}, (_, i) => new OpenPBRMaterial({graph: chainGraph(i + 1)}));
        const usage = new Map<unknown, number>(materials.map((m, i) => [m, i === 5 ? 1000 : i === 2 ? 500 : 1]));
        const state = new MaterialGraphState();
        state.interpreterAvailable = true;
        state.usage = () => usage;
        state.request([...materials, new OpenPBRMaterial()]);
        const final = state.requested, interim = final.interim!;
        expect(final.programs!.size).toBeGreaterThan(0);
        expect(final.specialized!.map(g => g.key)).toContain(final.graphs[5]!.key);
        expect(final.specialized!.length).toBeLessThan(8);
        expect(final.compileInterim).toBe(true);
        expect(interim.specialized).toEqual([]);
        expect(interim.programs!.size).toBe(8);
        expect(graphShaderKey(interim)).not.toBe(graphShaderKey(final));

        // One variant mixes specialized branches and the interpreter.
        const mixed = materialGraphShader(final).graph!;
        expect(mixed.interpreter).toBe(true);
        expect(mixed.declarations).toContain('mx_eval_1');
        expect(mixed.declarations).toContain('fn mx_run');

        // The interim installs first and restarts accumulation (new structures).
        const generation = state.generation;
        expect(state.installShader(graphShaderKey(interim))).toBe(true);
        expect(state.active).toBe(interim);
        expect(state.generation).toBe(generation + 1);
        expect(state.status).toBe('ready');
        const id = (packed: Float32Array, i: number) => packed[i * MATERIAL_FLOAT_COUNT + field('_padding1')];
        let packed = state.pack(new Float32Array(9 * MATERIAL_FLOAT_COUNT), []);
        for (let i = 0; i < 8; i++) expect(id(packed, i)).toBeLessThan(0);

        expect(state.upgrading).toBe(true);
        // A parameter-only request keeps the installed interim tiers.
        state.request([...materials, new OpenPBRMaterial()]);
        expect(graphShaderKey(state.active)).toBe(graphShaderKey(interim));
        expect(state.installShader(graphShaderKey(interim))).toBe(false);

        // The final variant swaps tiers without restarting accumulation.
        expect(state.installShader(graphShaderKey(state.requested))).toBe(true);
        expect(state.upgrading).toBe(false);
        expect(state.generation).toBe(generation + 1);
        packed = state.pack(new Float32Array(9 * MATERIAL_FLOAT_COUNT), []);
        const specialized = new Set(state.active.specialized!.map(g => g.key));
        for (let i = 0; i < 8; i++) {
            if (specialized.has(state.active.graphs[i]!.key)) expect(id(packed, i)).toBe(state.active.specialized!.findIndex(g => g.key === state.active.graphs[i]!.key) + 1);
            else expect(id(packed, i)).toBeLessThan(0);
        }
        expect(id(packed, 8)).toBe(0);
        // The parameter-only request also reinstalled the interim.
        expect(installs.map(e => e.interim)).toEqual([true, true, false]);
    });

    it('keeps the interim installed when the final variant fails', () => {
        setMaterialGraphPlanner({model: {msPerKB: 100, interpreterMs: 300, helperBytes: {}}, budget: {budgetMs: 600, minBenefitShare: 0.05}});
        const materials = Array.from({length: 8}, (_, i) => new OpenPBRMaterial({graph: chainGraph(i + 1)}));
        const state = new MaterialGraphState();
        state.interpreterAvailable = true;
        state.request(materials);
        const finalKey = graphShaderKey(state.requested), interim = state.requested.interim!;
        expect(state.abandonUpgrade(finalKey)).toBe(false);
        state.installShader(graphShaderKey(interim));
        expect(state.abandonUpgrade(finalKey)).toBe(true);
        expect(state.upgrading).toBe(false);
        expect(state.status).toBe('ready');
        expect(graphShaderKey(state.requested)).toBe(graphShaderKey(interim));
    });

    it('keeps tier decisions for an unchanged structure set when usage changes', () => {
        setMaterialGraphPlanner({model: {msPerKB: 100, interpreterMs: 300, helperBytes: {}}, budget: {budgetMs: 600, minBenefitShare: 0.05}});
        const materials = Array.from({length: 8}, (_, i) => new OpenPBRMaterial({graph: chainGraph(i + 1)}));
        let usage = new Map<unknown, number>(materials.map((m, i) => [m, i === 0 ? 100 : 1]));
        const state = new MaterialGraphState();
        state.interpreterAvailable = true;
        state.usage = () => usage;
        state.request(materials);
        const before = graphShaderKey(state.requested);
        usage = new Map(materials.map((m, i) => [m, i === 7 ? 100 : 1]));
        state.request(materials);
        expect(graphShaderKey(state.requested)).toBe(before);
    });

    it('specializes small sets without interpreter code by default', () => {
        const state = new MaterialGraphState();
        state.interpreterAvailable = true;
        state.request([new OpenPBRMaterial({graph: chainGraph(1)}), new OpenPBRMaterial({graph: chainGraph(2)})]);
        expect(state.requested.programs!.size).toBe(0);
        // An interim is used only if its variant is already ready; it is not compiled.
        expect(state.requested.compileInterim).toBeFalsy();
        expect(materialGraphShader(state.requested).graph!.interpreter).toBeUndefined();
    });

    it('forces one tier for measurement', () => {
        const materials = Array.from({length: 4}, (_, i) => new OpenPBRMaterial({graph: chainGraph(i + 1)}));
        setMaterialGraphPlanner({tier: 'interpreter'});
        const state = new MaterialGraphState();
        state.interpreterAvailable = true;
        state.request(materials);
        expect(state.requested.specialized).toEqual([]);
        expect(state.requested.interim).toBeUndefined();
        setMaterialGraphPlanner({tier: 'specialized', model: {msPerKB: 1e6, interpreterMs: 0, helperBytes: {}}});
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
