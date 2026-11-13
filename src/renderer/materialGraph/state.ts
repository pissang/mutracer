import {createMaterialBufferData} from '../materialParams.js';
import {packMaterialBuffer} from '../materialLayout.js';
import {MATERIAL_TEXTURE_SLOTS} from '../materialTextureSlots.js';
import {SlotTextures} from './slotTextures.js';
import {flattenGraphUnchecked} from './flatten.js';
import {graphContextDiagnostics} from './context.js';
import {graphTerminals} from './ir.js';
import {terminalTypes} from './nodes.js';
import {DEFAULT_GRAPH_COMPILE_MODEL, DEFAULT_GRAPH_TIER_BUDGET, interpreterCompileMs, planGraphTiers, type GraphCompileModel, type GraphTierBudget, type GraphTierCandidate} from './planner.js';
import {GRAPH_COMPILE_COEFFICIENTS, GRAPH_FREE_MS_PER_KB, GraphCompileCalibration, GraphUpgradeVerifier, graphCompileReferenceMs, graphCompilerBackend, graphUpgradeGain, graphUpgradeGate, type GraphCompileCoefficients, type GraphCompileObservation, type GraphCompileRole, type GraphCompilerBackend, type GraphUpgradeGate, type GraphVerifyDecision} from './tierPolicy.js';
import {materialGraphConstants} from './features.js';
import {generateGraphIR} from './generate.js';
import {graphMathShaderIR} from './specialize.js';
import {graphInterpreterHelpers, graphInterpreterShader, graphProgramFamilies, GraphOp, buildGraphProgram, graphTerminalMask, GRAPH_INSTRUCTION_FLOATS, type GraphProgram, type GraphProgramResult} from './interpreter.js';
import type OpenPBRMaterial from '../../scene/OpenPBRMaterial.js';
import Texture from '../../scene/Texture.js';
import type { MaterialGraphDiagnostic } from '../../scene/MaterialGraph.js';
import { normalizeGraph, type NormalizedGraph } from './normalize.js';
import { generateGraph } from './codegen.js';
import { MATERIAL_FLOAT_COUNT, materialLayoutFields } from '../materialLayoutSchema.js';
const alphaModeOffset = materialLayoutFields().find(field => field.name === 'alphaMode')!.offset / 4;
const emissionOffset = materialLayoutFields().find(field => field.name === 'emission')!.offset / 4;
const padding = materialLayoutFields().find(field => field.name === '_padding1')!.offset / 4;
// Interpreter records: a header vec4 and three operand vec4 rows (the first four rows of a material record).
const programRows = ['color', 'roughness', 'metallic', 'emission'].map(name => materialLayoutFields().find(field => field.name === name)!.offset / 4);
/** Internal tier selection. `auto` lets the planner choose per structure;
 * `specialized`/`interpreter` force one tier for A/B measurement. */
export type MaterialGraphTier = 'auto' | 'specialized' | 'interpreter';
/** Edit-aware tier policy constants (see docs/technical/material-graph-codegen.md). */
export interface GraphTierPolicy {
    /** Structure set stability required before a specialized upgrade compiles. */
    debounceMs: number;
    /** Required (saved render ms) / (compile ms) before an upgrade compiles. */
    margin: number;
    /** Expected remaining render time is the time already rendered, at most this, when no sample target is known. */
    maxHorizonMs: number;
    /** Final-variant budget = factor × this device's cold graph-free kernel compile... */
    finalBudgetFactor: number;
    /** ...clamped to this range of device milliseconds. */
    finalBudgetRangeMs: readonly [number, number];
    /** Graph increment allowed before every graph renders correctly, device ms. */
    correctMs: number;
    /** Initial specialized-source cap per device, KB. */
    capKB: number;
    /** A rejected upgrade lowers the device cap to this share of its specialized source, not below `minCapKB`. */
    capBackoff: number;
    minCapKB: number;
    /** Expected per-sample saving of removing all interpreter work before any verification. */
    interpreterGain: number;
    /** Minimum verified gain that keeps an upgrade. */
    minVerifiedGain: number;
    /** Rendered samples per verification phase (after one warm-up sample). */
    verifySamples: number;
    /** No upgrade predicted to compile longer than this (device ms, whole kernel) starts:
     * a WebGPU compile cannot be cancelled, an edit in the meantime discards it, and on a
     * serializing driver an edit's own compile could wait behind it. */
    maxUpgradeCompileMs: number;
    /** Compile the editing interpreter in the background after the first installation. */
    prefetch: boolean;
}
export const DEFAULT_GRAPH_TIER_POLICY: GraphTierPolicy = {debounceMs: 2000, margin: 1.5, maxHorizonMs: 60000, finalBudgetFactor: 3, finalBudgetRangeMs: [1000, 10000],
    correctMs: 1000, capKB: 120, capBackoff: 0.7, minCapKB: 16, interpreterGain: 0.2, minVerifiedGain: 0.03, verifySamples: 8, maxUpgradeCompileMs: 10000, prefetch: true};
export interface MaterialGraphPlannerOptions {
    /** Default auto. */
    tier?: MaterialGraphTier;
    /** Makes the interpreter source unique so driver caches miss; measurement only. Default 0. */
    salt?: number;
    /** Compile model in reference ms; its per-KB costs replace the backend's coefficients
     * (measurement and tests). Default: the device's backend coefficients, with
     * DEFAULT_GRAPH_COMPILE_MODEL's helper sizes. */
    model?: GraphCompileModel;
    /** Debug: plan with this backend's compile-cost shape and speed prior, e.g. 'd3d12' on a Mac. Default detected. */
    compileBackend?: GraphCompilerBackend;
    /** Fixed budgets in device ms instead of the calibrated policy budgets. Default undefined. */
    budget?: GraphTierBudget;
    /** Serve a mixed or slow final plan with an interpreter-only variant first. Default true. */
    interim?: boolean;
    /** Default DEFAULT_GRAPH_TIER_POLICY. */
    policy?: Partial<GraphTierPolicy>;
    /** Debug: fixed device compile speed factor (1 = reference platform), e.g. 3 to plan as a slow device. Default calibrated. */
    compileSpeed?: number;
    /** Measurement hook called on every installation. */
    onInstall?: (event: GraphInstallEvent) => void;
    /** Measurement hook for upgrade decisions. */
    onUpgrade?: (event: GraphUpgradeEvent) => void;
    /** Measurement hook for every ray-tracing kernel compile. */
    onCompile?: (event: GraphCompileObservation) => void;
}
export interface GraphInstallEvent { key: string; shaderKey: string; interim: boolean; role: 'serving' | 'upgrade'; specialized: number; interpreted: number; /** Planned share of interpreter work moved to specialized code. */ coverage?: number; at: number }
export interface GraphUpgradeEvent {
    /** `hold`: the gate first refused for lack of benefit; `skip`: the planned tiers equal the serving ones. */
    type: 'start' | 'hold' | 'stale' | 'installed' | 'keep' | 'rollback' | 'failed' | 'skip';
    key: string; at: number;
    gate?: GraphUpgradeGate; compileMs?: number; gain?: number; specializedKB?: number;
    verification?: GraphVerifyDecision; capKB?: number; speed?: number;
    /** Render sample target when the event fired. */
    maxSamples?: number;
}
type Planner = Required<Omit<MaterialGraphPlannerOptions, 'onInstall' | 'onUpgrade' | 'onCompile' | 'budget' | 'compileSpeed' | 'compileBackend' | 'policy'>> &
    Pick<MaterialGraphPlannerOptions, 'onInstall' | 'onUpgrade' | 'onCompile' | 'budget' | 'compileSpeed' | 'compileBackend'> & {policy: GraphTierPolicy; modelOverride: boolean};
let planner: Planner = {tier: 'auto', salt: 0, model: DEFAULT_GRAPH_COMPILE_MODEL, modelOverride: false, interim: true, policy: DEFAULT_GRAPH_TIER_POLICY};
/** Internal planner overrides for measurement; omitted fields reset to their defaults. */
export function setMaterialGraphPlanner(options: MaterialGraphPlannerOptions = {}) {
    planner = {tier: options.tier ?? 'auto', salt: options.salt ?? 0, model: options.model ?? DEFAULT_GRAPH_COMPILE_MODEL, modelOverride: !!options.model,
        budget: options.budget, interim: options.interim ?? true, policy: {...DEFAULT_GRAPH_TIER_POLICY, ...options.policy}, compileSpeed: options.compileSpeed, compileBackend: options.compileBackend,
        onInstall: options.onInstall, onUpgrade: options.onUpgrade, onCompile: options.onCompile};
}
export function materialGraphPlanner(): Readonly<Planner> { return planner; }
let policyFrozen = false;
/** Measurement only: stops upgrade decisions (and verification switches) without replanning. */
export function freezeMaterialGraphPolicy(frozen: boolean) { policyFrozen = frozen; }
/** Categories that pull shared helper libraries into specialized code. */
const graphHelperCategories: Record<string, string[]> = {
    noise: ['noise2d', 'noise3d', 'fractal3d', 'cellnoise2d', 'cellnoise3d', 'worleynoise2d', 'worleynoise3d'],
    hsv: ['rgbtohsv', 'hsvtorgb', 'hsvadjust'], rotate3d: ['rotate3d']
};
/** Terminals that change neither pipeline constants nor shared hooks: an editing
 * interpreter carries all of them, so a graph connecting another one needs no compile. */
const PLAIN_TERMINALS = ['baseWeight', 'baseColor', 'baseDiffuseRoughness', 'specularWeight', 'specularColor', 'specularRoughness', 'specularIor',
    'transmissionColor', 'fuzzColor', 'fuzzRoughness', 'coatRoughness', 'coatIor', 'coatDarkening', 'thinFilmThickness', 'thinFilmIor'];
const ALL_FAMILIES: ReadonlySet<GraphOp> = new Set(Object.values(GraphOp).filter((v): v is GraphOp => typeof v === 'number' && v !== GraphOp.Store));
export const GRAPH_INTERPRETER_KEY = 'mx-interpreter-1';
/** Plans without a tier split (older snapshots, tests) are fully specialized. */
export const graphShaderKey = (plan: GraphPlan) => plan.shaderKey ?? plan.key;
/** Code layout of one compiled variant, independent of the structures it serves:
 * specialized functions in ID order (possibly for structures no longer present)
 * and the interpreter configuration. Any structure set whose structures are either
 * specialized here or interpretable within these families and terminals, and whose
 * features these constants cover, renders on the same variant. */
export interface GraphTierShape {
    shaderKey: string;
    specialized: NormalizedGraph[];
    interpreter?: {terminals: string[]; families: ReadonlySet<GraphOp>};
    /** Structures whose pipeline features the variant enables. */
    features: NormalizedGraph[];
    specializedBytes: number;
    interpreterBytes: number;
    /** Planner coverage when planned. */
    coverage?: number;
}
export interface GraphPlan {
    key: string;
    /** Shader identity: specialized structure keys plus the interpreter's terminal set. */
    shaderKey?: string;
    materials?: readonly OpenPBRMaterial[];
    graphs: (NormalizedGraph | undefined)[];
    structures: NormalizedGraph[];
    /** Structures compiled to `mx_eval_N`, in ID order. */
    specialized?: NormalizedGraph[];
    /** Interpreted structures by key. */
    programs?: ReadonlyMap<string, GraphProgram>;
    /** Whether the variant contains the interpreter (also with no program to run). Default: programs present. */
    interpreter?: boolean;
    /** Terminals written by interpreted structures. */
    interpreterTerminals?: string[];
    interpreterSalt?: number;
    /** Opcode families used by the interpreted programs; the interpreter compiles only these. */
    interpreterFamilies?: ReadonlySet<GraphOp>;
    /** Structures selecting pipeline features; default `structures`. */
    featureStructures?: NormalizedGraph[];
    shape?: GraphTierShape;
    slots?: ReadonlyMap<OpenPBRMaterial, OpenPBRMaterial>;
}
const empty = (): GraphPlan => ({ key: '', shaderKey: '', graphs: [], structures: [], specialized: [], programs: new Map(), interpreterTerminals: [] });
type PlanBase = Pick<GraphPlan, 'key' | 'materials' | 'graphs' | 'structures' | 'slots'>;
/** Upgrade lifecycle of the current structure set: `waiting` for the gate, `compiling`
 * the specialized variant, `verifying` it against the serving variant, then `done`
 * (kept), `rejected` (rolled back), `failed` or `none` (nothing to upgrade). */
export type GraphUpgradePhase = 'none' | 'waiting' | 'compiling' | 'verifying' | 'done' | 'rejected' | 'failed';
export interface MaterialGraphCompilationState {
    /** Engine-wide graph request counter, initially zero; independent of MaterialGraph.revision. */ revision: number;
    /** Latest fully valid engine-wide installed request, initially zero. Failed requests may install valid materials without advancing it. */ installedRevision: number;
    /** Idle when no graph program is needed; compiling includes debounce; ready or failed otherwise. Default idle. */ status: 'idle' | 'compiling' | 'ready' | 'failed';
    /** Located graph or driver failures. Default empty. */ diagnostics: MaterialGraphDiagnostic[];
    /** Last installed graph program measurements; browser driver stages are combined. Default undefined. */
    compilation?: {
        /** Generated source size in bytes. */
        sourceBytes: number;
        /** Source generation duration in milliseconds. */
        sourceGenerationTimeMs: number;
        /** Driver module creation duration in milliseconds. */
        moduleCreationTimeMs: number;
        /** Total compilation duration in milliseconds. Default undefined until measured. */
        totalTimeMs?: number;
    };
    /** Distinct structures requiring graph evaluation; texture-slot plans are excluded. Default zero. */ topologyCount: number;
}
/** Graph data is staged independently of uniforms used by the installed pipeline.
 * The existing backend pipeline caches own compilation/scheduling; this class only
 * snapshots graph parameters and guards installation by revision. */
export class MaterialGraphState {
    capabilities = 'atlas';
    /** Browser transport opts out while graph evaluation is disabled. */
    emissionSampling = true;
    private readonly slotTextures = new SlotTextures();
    private hasSlotHistory = false;
    active = empty();
    requested = empty();
    revision = 0;
    installedRevision = 0;
    generation = 0;
    compilation?: MaterialGraphCompilationState['compilation'];
    status: MaterialGraphCompilationState['status'] = 'idle';
    diagnostics: MaterialGraphDiagnostic[] = [];
    private readyAt = 0;
    private compileFailed = false;
    private constantFallback = new Set<OpenPBRMaterial>();
    private sourceRevisions: {
        graph: OpenPBRMaterial['graph'];
        revision: number | undefined;
    }[] = [];
    private materials: OpenPBRMaterial[] = [];
    private programCache = new Map<string, GraphProgramResult>();
    /** Relative hit weight per material (world-space surface area), read when a new
     * structure set is planned. Default (or an all-zero result) weighs materials equally. */
    usage?: () => ReadonlyMap<unknown, number>;
    /** Backends with the WGSL interpreter (WebGPU) enable tier planning; otherwise
     * every structure is specialized. Default false. */
    interpreterAvailable = false;
    /** Compile speed of this device; shared by the passes of one device. Default: a
     * calibration with this platform's prior. */
    calibration = new GraphCompileCalibration(graphCompilerBackend());
    /** Tier decisions stay fixed for a structure set, so usage changes (transforms,
     * visibility) never recompile; a new set is planned again. */
    private tiers?: {key: string; planner: Planner; model: GraphCompileModel; capKB: number; shape: GraphTierShape; interpreter: boolean; estimatedMs: number};
    private sourceCache = new Map<string, Pick<GraphTierCandidate, 'sourceBytes' | 'helpers'>>();
    // Policy state of the current structure set (`planKey`).
    private planKey = '';
    private base: PlanBase = {key: '', graphs: [], structures: []};
    private serving?: GraphTierShape;
    private upgrade?: GraphTierShape;
    phase: GraphUpgradePhase = 'none';
    private stableSince = 0;
    private held = false;
    private verifier?: GraphUpgradeVerifier;
    /** Last gate evaluation, for diagnostics. */
    lastGate?: GraphUpgradeGate;
    /** Measured per-sample saving of removing interpreter work in this scene, once verified. */
    private learnedGain?: number;
    private rejected = new Set<string>();
    /** Editing interpreters compiled in the background, by shader key. */
    private prefetched = new Map<string, GraphTierShape>();
    private seenTerminals = new Set<string>(PLAIN_TERMINALS);
    // Render progress reported by the backend.
    private view = -1;
    private viewStart = 0;
    private samples = 0;
    private maxSamples = Infinity;
    private wall: {at: number; samples: number; key: string}[] = [];
    private get policy() { return planner.policy; }
    private get speed() { if (planner.compileBackend) this.calibration.useBackend(planner.compileBackend); return planner.compileSpeed ?? this.calibration.factor; }
    private get capKB() { return this.calibration.capKB ?? this.policy.capKB; }
    /** Compile-cost shape in reference ms: the backend's coefficients with this device's
     * specialized factor, or the planner model's costs when one is given. */
    private get coefficients(): GraphCompileCoefficients {
        if (planner.compileBackend) this.calibration.useBackend(planner.compileBackend);
        const m = planner.model;
        return planner.modelOverride ? {graphFreeMsPerKB: GRAPH_FREE_MS_PER_KB, msPerKB: m.msPerKB, interpreterMsPerKB: m.interpreterMsPerKB, interpreterFreeKB: m.interpreterFreeKB} : this.calibration.shape;
    }
    /** Device-scaled compile model and budgets. */
    private deviceBudget(): {model: GraphCompileModel; budget: GraphTierBudget} {
        const s = this.speed, c = this.coefficients, m = planner.model;
        const interpreterScale = c.interpreterMsPerKB / (m.interpreterMsPerKB || GRAPH_COMPILE_COEFFICIENTS.metal.interpreterMsPerKB);
        const model = {...m, msPerKB: c.msPerKB * s, interpreterMs: m.interpreterMs * s * (planner.modelOverride ? 1 : interpreterScale), interpreterMsPerKB: c.interpreterMsPerKB * s, interpreterFreeKB: c.interpreterFreeKB};
        if (planner.budget) return {model, budget: {capKB: this.capKB, ...planner.budget}};
        const [low, high] = this.policy.finalBudgetRangeMs;
        const graphFreeMs = s * this.calibration.graphFreeBytes / 1024 * c.graphFreeMsPerKB;
        return {model, budget: {...DEFAULT_GRAPH_TIER_BUDGET, budgetMs: Math.min(Math.max(this.policy.finalBudgetFactor * graphFreeMs, low), high),
            correctMs: this.policy.correctMs, capKB: this.capKB}};
    }
    /** Predicted device ms of a whole-kernel compile of `shape`. */
    private compileMs(shape: GraphTierShape) {
        return this.speed * graphCompileReferenceMs(this.coefficients, {totalBytes: this.calibration.graphFreeBytes + shape.specializedBytes + shape.interpreterBytes,
            specializedBytes: shape.specializedBytes, interpreterBytes: shape.interpreterBytes});
    }
    private interpreterBytes(terminals: readonly string[], families: ReadonlySet<GraphOp>) {
        return graphInterpreterShader(terminals, 0, families).length + graphMathShaderIR([], false, graphInterpreterHelpers(families)).length;
    }
    private shape(specialized: NormalizedGraph[], interpreter: GraphTierShape['interpreter'], features: NormalizedGraph[], coverage?: number): GraphTierShape {
        const familyKey = interpreter ? [...interpreter.families].sort((a, b) => a - b).join('.') : '';
        const shaderKey = [...specialized.map(g => g.key), ...(interpreter ? [`${GRAPH_INTERPRETER_KEY}:${interpreter.terminals.join(',')}:${familyKey}:${planner.salt}`] : [])].join('\n');
        const helpers = new Set<string>();
        let specializedBytes = 0;
        for (const g of specialized) { const source = this.source(g); specializedBytes += source.sourceBytes; if (!interpreter) for (const h of source.helpers ?? []) helpers.add(h); }
        for (const h of helpers) specializedBytes += planner.model.helperBytes[h] ?? 0;
        return {shaderKey, specialized, interpreter, features, specializedBytes, interpreterBytes: interpreter ? this.interpreterBytes(interpreter.terminals, interpreter.families) : 0, coverage};
    }
    private interpreterConfig(structures: readonly NormalizedGraph[], full = false): NonNullable<GraphTierShape['interpreter']> {
        const families = new Set<GraphOp>(full ? ALL_FAMILIES : []), terminals = new Set<string>(full ? this.seenTerminals : []);
        for (const g of structures) { const program = this.program(g); if (program) { graphProgramFamilies(program, families); for (const t in g.terminal) terminals.add(t); } }
        return {terminals: Object.keys(terminalTypes).filter(t => terminals.has(t)), families};
    }
    /** Plans the final tiers of a structure set within the device's budgets. */
    private decideTiers(key: string, structures: NormalizedGraph[], materials: OpenPBRMaterial[], graphs: (NormalizedGraph | undefined)[]) {
        const {model, budget} = this.deviceBudget();
        if (this.tiers?.key === key && this.tiers.planner === planner && this.tiers.model.msPerKB === model.msPerKB && this.tiers.model.interpreterMsPerKB === model.interpreterMsPerKB &&
            this.tiers.capKB === this.capKB) return this.tiers;
        let specialized: Set<string>, coverage: number | undefined, estimatedMs = 0, interpreter = false;
        if (planner.tier === 'specialized' || !this.interpreterAvailable || !structures.length) specialized = new Set(structures.map(g => g.key));
        else if (planner.tier === 'interpreter') { specialized = new Set(structures.filter(g => !this.program(g)).map(g => g.key)); interpreter = specialized.size < structures.length; }
        else {
            const weights = this.usage?.(), usage = new Map<string, number>();
            const equal = !weights || !materials.some((m, i) => graphs[i] && (weights.get(m) ?? 0) > 0);
            graphs.forEach((g, i) => { if (g) usage.set(g.key, (usage.get(g.key) ?? 0) + (equal ? 1 : weights.get(materials[i]) ?? 0)); });
            const candidates = structures.map(g => {
                const program = this.program(g);
                return {key: g.key, usage: usage.get(g.key) ?? 0, ...this.source(g),
                    instructions: program ? [program.surface, program.opacity, program.emission].reduce((n, e) => n + e.instructions.length / GRAPH_INSTRUCTION_FLOATS, 0) : undefined};
            });
            // Charge the interpreter for the opcode families of every interpretable
            // structure (an upper bound for the ones left on it).
            const config = this.interpreterConfig(structures);
            const decision = planGraphTiers(candidates, model, budget, interpreterCompileMs(this.interpreterBytes(config.terminals, config.families), model));
            ({specialized, coverage, estimatedMs, interpreter} = decision);
        }
        const chosen = structures.filter(g => specialized.has(g.key) || !this.program(g));
        const shape = this.shape(chosen, interpreter || chosen.length < structures.length ? this.interpreterConfig(structures.filter(g => !chosen.includes(g))) : undefined, structures, coverage);
        this.tiers = {key, planner, model, capKB: this.capKB, shape, interpreter: !!shape.interpreter, estimatedMs};
        return this.tiers;
    }
    /** Specialized source estimate: the generated function plus its dispatch branches. */
    private source(graph: NormalizedGraph) {
        let result = this.sourceCache.get(graph.key);
        if (!result) {
            const ir = flattenGraphUnchecked(graph), categories = new Set(graph.nodes.map(n => n.category)), terminals = Object.keys(graph.terminal);
            const helpers = Object.entries(graphHelperCategories).filter(([, names]) => names.some(n => categories.has(n))).map(([name]) => name);
            const dispatch = 320 + 60 * terminals.length + ('opacity' in graph.terminal ? 260 : 0) + (terminals.some(t => ['emissionColor', 'emissionLuminance', 'coatWeight', 'coatColor'].includes(t)) ? 360 : 0);
            this.sourceCache.set(graph.key, result = {sourceBytes: generateGraphIR(ir, 'mx_eval_1').source.length + dispatch, helpers});
        }
        return result;
    }
    private plan(base: PlanBase, shape: GraphTierShape): GraphPlan {
        const specializedKeys = new Set(shape.specialized.map(g => g.key)), programs = new Map<string, GraphProgram>();
        for (const g of base.structures) { const program = specializedKeys.has(g.key) ? undefined : this.program(g); if (program) programs.set(g.key, program); }
        return {...base, shaderKey: shape.shaderKey, specialized: shape.specialized, programs, interpreter: !!shape.interpreter,
            interpreterTerminals: shape.interpreter?.terminals ?? [], interpreterFamilies: shape.interpreter?.families, interpreterSalt: planner.salt,
            featureStructures: shape.features === base.structures ? undefined : shape.features, shape};
    }
    private program(graph: NormalizedGraph) {
        let result = this.programCache.get(graph.key);
        if (!result) this.programCache.set(graph.key, result = buildGraphProgram(flattenGraphUnchecked(graph)));
        return result.program;
    }
    /** Whether `structures` render on the variant of `shape` without a compile. */
    private fits(shape: GraphTierShape, base: PlanBase) {
        const specialized = new Set(shape.specialized.map(g => g.key)), families = new Set<GraphOp>();
        for (const g of base.structures) {
            if (specialized.has(g.key)) continue;
            const program = shape.interpreter && this.program(g);
            if (!program || Object.keys(g.terminal).some(t => !shape.interpreter!.terminals.includes(t))) return false;
            graphProgramFamilies(program, families);
        }
        if ([...families].some(f => !shape.interpreter!.families.has(f))) return false;
        const features = (structures: NormalizedGraph[]) => JSON.stringify(materialGraphConstants({}, {...base, key: 'x', structures, featureStructures: undefined}));
        return features([...shape.features, ...base.structures]) === features(shape.features);
    }
    /** Chooses the variant that renders a new structure set correctly first. */
    private chooseServing(base: PlanBase, materials: OpenPBRMaterial[]): GraphTierShape {
        const {key, structures, graphs} = base;
        for (const g of structures) if (this.program(g)) for (const t in g.terminal) this.seenTerminals.add(t);
        if (planner.tier !== 'auto' || !this.interpreterAvailable) return this.decideTiers(key, structures, materials, graphs).shape;
        const installed = this.active.key ? this.active.shape : undefined;
        // Incremental edit: the installed variant keeps its specialized code and runs
        // new or changed structures as interpreter programs.
        if (installed && this.fits(installed, base)) return installed;
        // A background-compiled editing interpreter that covers the edit.
        for (const shape of this.prefetched.values()) if (this.fits(shape, base)) return shape;
        const correctMs = planner.budget?.correctMs ?? this.policy.correctMs, {model} = this.deviceBudget();
        if (installed || this.generation > 0) {
            // A structural edit: every opcode family, the plain terminals and every
            // terminal seen this session, so later edits fit without a compile, unless
            // that is predicted over the correct-frame budget (then only this set's families).
            const forced = structures.filter(g => !this.program(g)), features = [...(installed?.features ?? []), ...structures.filter(g => !installed?.features.includes(g))];
            const full = this.interpreterConfig(structures, true);
            const config = interpreterCompileMs(this.interpreterBytes(full.terminals, full.families), model) <= correctMs ? full : this.interpreterConfig(structures);
            return this.shape(forced, config, Array.from(new Map(features.map(g => [g.key, g])).values()));
        }
        // Initial load: a small fully specialized set compiles directly; otherwise the
        // interpreter (only the families this set needs) renders it correctly first.
        const tiers = this.decideTiers(key, structures, materials, graphs);
        if (!tiers.interpreter && tiers.estimatedMs <= correctMs || !planner.interim) return tiers.shape;
        return this.shape(structures.filter(g => !this.program(g)), this.interpreterConfig(structures), structures);
    }
    request(materials: OpenPBRMaterial[]) {
        this.materials = materials;
        this.compileFailed = false;
        this.constantFallback.clear();
        const diagnostics: MaterialGraphDiagnostic[] = [];
        const slots = new Map<OpenPBRMaterial, OpenPBRMaterial>();
        const previousGraphs = new Map((this.active.materials ?? []).map((m,i) => [m,this.active.graphs[i]]));
        const graphs = materials.map((material, index) => {
            if (!material.graph)
                return undefined;
            const graph = normalizeGraph(material.graph, this.capabilities);
            const validateContext=(graph:NormalizedGraph,retained=false)=>{
                const before=graph.diagnostics.length;
                const context=graphContextDiagnostics(flattenGraphUnchecked(graph),material.unlit,material.emissionLuminance>0,material.alphaMode==='opaque',material.uvProjection!=='none',true);
                for(const d of context) {
                    const port=graphTerminals[d.port];
                    graph.diagnostics.push({code:d.code,message:d.message,node:graph.nodes[d.node]?.id,port});
                    if(d.code==='unsupported-emission-graph'||d.code==='unsupported-opacity-projection')this.constantFallback.add(material);
                }
                if(retained&&graph.diagnostics.length>before)this.constantFallback.add(material);
            };
            validateContext(graph);
            const lowered = graph.diagnostics.length ? undefined : this.slotTextures.lower(material);
            if (lowered) { this.hasSlotHistory = true; slots.set(material, lowered); return undefined; }
            if (graph.diagnostics.length && !this.constantFallback.has(material)) {
                const retainedSlots = this.active.slots?.get(material);
                if (retainedSlots) slots.set(material, retainedSlots);
            }
            const previous=this.active.materials?previousGraphs.get(material):this.active.graphs[index];
            if(graph.diagnostics.length&&previous&&!this.constantFallback.has(material)){
                // A failed replacement may retain a graph authored for an older
                // material context. Validate it without mutating the installed snapshot.
                const retained={...previous,diagnostics:[] as MaterialGraphDiagnostic[]};
                validateContext(retained,true);
                diagnostics.push(...retained.diagnostics.filter(d=>!graph.diagnostics.some(current=>current.code===d.code&&current.node===d.node&&current.port===d.port)).map(d=>({...d,materialId:material.aovId})));
            }
            diagnostics.push(...graph.diagnostics.map(d => ({...d,materialId:material.aovId})));
            // Preserve the successful graph for this slot after validation failure.
            return this.constantFallback.has(material) ? undefined : graph.diagnostics.length ? previous : graph;
        });
        this.slotTextures.finish();
        const structures = Array.from(new Map(graphs.filter((g): g is NormalizedGraph => !!g && !!Object.keys(g.terminal).length).map(g => [g.key, g])).values()).sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
        const key = structures.map(g => g.key).join('\n');
        const base: PlanBase = { key, materials: materials.slice(), graphs, structures, slots };
        this.base = base;
        if (key !== this.planKey || !this.serving || this.tiers?.planner !== planner) {
            // A new structure set: serve it on a variant that renders it correctly now and
            // decide about a specialized upgrade only once the set has been stable.
            const now = performance.now();
            if (this.phase === 'compiling' && key !== this.planKey) this.emit('stale', {});
            this.planKey = key;
            this.stableSince = now;
            this.held = false;
            this.verifier = undefined;
            this.serving = this.chooseServing(base, materials);
            this.upgrade = undefined;
            this.phase = planner.tier === 'auto' && this.interpreterAvailable && structures.length && !this.rejected.has(key) ? 'waiting' : 'none';
        }
        const assignmentKey = (plan: GraphPlan) => plan.graphs.map(g => g?.key ?? '').join('\n');
        const authoredChanged = (materials.some(m => !!m.graph) || this.sourceRevisions.some(item => !!item.graph)) && (materials.length !== this.sourceRevisions.length || materials.some((m, i) => m.graph !== this.sourceRevisions[i]?.graph || m.graph?.revision !== this.sourceRevisions[i]?.revision));
        this.sourceRevisions = materials.map(m => ({ graph: m.graph, revision: m.graph?.revision }));
        if (authoredChanged || key !== this.requested.key || assignmentKey({ ...empty(), key, graphs, structures }) !== assignmentKey(this.requested)) {
            this.revision++;
            this.readyAt = performance.now() + 32;
        }
        this.requested = this.plan(base, this.target());
        this.diagnostics = diagnostics;
        if (key === this.active.key) {
            // Same structures: keep the installed tiers (and its variant) for these parameters.
            const installed = this.active.shape?.shaderKey === this.requested.shaderKey ? this.requested : this.active.shape ? this.plan(base, this.active.shape) : this.requested;
            this.install(installed, this.revision);
            this.status = diagnostics.length ? 'failed' : key ? 'ready' : 'idle';
        }
        else
            this.status = 'compiling';
    }
    /** Shape the backend should install now. */
    private target(): GraphTierShape {
        const upgrade = this.upgrade && (this.phase === 'compiling' || this.phase === 'done' || this.phase === 'verifying' && this.verifier!.tier === 'final');
        return upgrade ? this.upgrade! : this.serving!;
    }
    private emit(type: GraphUpgradeEvent['type'], details: Partial<GraphUpgradeEvent>) {
        planner.onUpgrade?.({type, key: this.planKey, at: performance.now(), capKB: this.capKB, speed: this.speed, maxSamples: this.maxSamples, ...details});
    }
    /** Shader key of the installed graph variant; empty without graphs. */
    get activeShaderKey() { return this.active.key ? graphShaderKey(this.active) : ''; }
    /** Render progress: `rendered` new samples, `samples` of `maxSamples` in total, on accumulation `view`. */
    recordFrame(rendered: number, samples: number, maxSamples: number, view: number, now = performance.now()) {
        if (!this.active.key) return;
        if (view !== this.view) { this.view = view; this.viewStart = now; this.wall = []; }
        // A new render target can change the upgrade decision; report a refusal again.
        if (maxSamples !== this.maxSamples) this.held = false;
        this.samples = samples; this.maxSamples = maxSamples;
        const key = graphShaderKey(this.active);
        if (rendered > 0) {
            if (this.wall.length && this.wall[this.wall.length - 1].key !== key) this.wall = [];
            this.wall.push({at: now, samples, key});
            while (this.wall.length > 2 && now - this.wall[1].at > 1000) this.wall.shift();
        }
        const tier = this.verifyTier(key);
        if (tier) this.verifier?.frame(tier, view, rendered, now);
    }
    /** GPU time of one full sample traced with the variant `shaderKey`. */
    recordGpuSample(shaderKey: string, view: number, ms: number) {
        const tier = this.verifyTier(shaderKey);
        if (tier) this.verifier?.gpu(tier, view, ms);
    }
    private verifyTier(shaderKey: string) {
        return shaderKey === this.upgrade?.shaderKey ? 'final' : shaderKey === this.serving?.shaderKey ? 'interim' : undefined;
    }
    private get msPerSample() {
        const first = this.wall[0], last = this.wall[this.wall.length - 1];
        return first && last.samples - first.samples >= 2 ? (last.at - first.at) / (last.samples - first.samples) : undefined;
    }
    /**
     * Advances the upgrade policy; called by the backend before it selects a variant.
     * Starts the specialized upgrade when the gate allows it and alternates the
     * installed tier while an installed upgrade is verified.
     */
    tick(compilesInFlight: number, now = performance.now()) {
        if (!this.serving || this.active.key !== this.planKey || !this.planKey || policyFrozen) return;
        if (this.phase === 'waiting') {
            if (now - this.stableSince < this.policy.debounceMs) return;
            this.upgrade ??= this.decideTiers(this.planKey, this.base.structures, this.materials, this.base.graphs).shape;
            if (this.upgrade.shaderKey === this.serving.shaderKey) { this.phase = 'none'; this.upgrade = undefined; this.emit('skip', {}); return; }
            const compileMs = this.compileMs(this.upgrade);
            const gain = graphUpgradeGain(this.learnedGain ?? this.policy.interpreterGain, !!this.upgrade.interpreter, this.upgrade.coverage ?? 1);
            this.lastGate = graphUpgradeGate({now, stableSince: this.stableSince, debounceMs: this.policy.debounceMs, compilesInFlight, compileMs, maxCompileMs: this.policy.maxUpgradeCompileMs, gain,
                msPerSample: this.msPerSample, remainingSamples: Number.isFinite(this.maxSamples) ? this.maxSamples - this.samples : undefined,
                renderedMs: now - Math.max(this.stableSince, this.viewStart), margin: this.policy.margin, maxHorizonMs: this.policy.maxHorizonMs});
            if (!this.lastGate.start) {
                if ((this.lastGate.reason === 'benefit' || this.lastGate.reason === 'ceiling') && !this.held) { this.held = true; this.emit('hold', {gate: this.lastGate, compileMs, gain, specializedKB: this.upgrade.specializedBytes / 1024}); }
                return;
            }
            this.phase = 'compiling';
            this.emit('start', {gate: this.lastGate, compileMs, gain, specializedKB: this.upgrade.specializedBytes / 1024});
            this.requested = this.plan(this.base, this.upgrade);
        } else if (this.phase === 'verifying') {
            const decision = this.verifier!.decision;
            if (decision) {
                const upgrade = this.upgrade!;
                // Learn this scene's interpreter cost from the measured gain.
                const share = upgrade.interpreter ? 0.5 * (upgrade.coverage ?? 1) : 1;
                if (share > 0 && Number.isFinite(decision.gain)) this.learnedGain = Math.min(Math.max(decision.gain / share, 0), 0.6);
                if (decision.keep) { this.phase = 'done'; this.serving = upgrade; }
                else {
                    this.phase = 'rejected';
                    this.rejected.add(this.planKey);
                    if (upgrade.specializedBytes > 0) this.calibration.capKB = Math.max(this.policy.minCapKB, Math.min(this.capKB, this.policy.capBackoff * upgrade.specializedBytes / 1024));
                }
                this.emit(decision.keep ? 'keep' : 'rollback', {verification: decision, specializedKB: upgrade.specializedBytes / 1024});
            }
            const target = this.target();
            if (target.shaderKey !== this.requested.shaderKey) this.requested = this.plan(this.base, target);
        }
    }
    /**
     * After the first graph installation, the editing interpreter (every opcode family) is
     * compiled once in the background while the installed variant serves, so later
     * structural edits find it ready. Returns that plan once, when nothing else compiles;
     * it has the installed variant's pipeline features. Skipped when its predicted
     * increment exceeds the final-variant budget (the most background compile time a
     * structure set may cost): an edit then compiles only its own families.
     */
    prefetch(compilesInFlight: number): GraphPlan | undefined {
        const installed = this.active.shape;
        if (compilesInFlight > 0 || !this.policy.prefetch || planner.tier !== 'auto' || !this.interpreterAvailable || !installed || this.active.key !== this.planKey || this.phase === 'compiling') return;
        const full = this.interpreterConfig(this.base.structures, true);
        if (installed.interpreter && installed.interpreter.families.size >= ALL_FAMILIES.size && full.terminals.every(t => installed.interpreter!.terminals.includes(t))) return;
        const {model, budget} = this.deviceBudget();
        if (interpreterCompileMs(this.interpreterBytes(full.terminals, full.families), model) > Math.max(budget.budgetMs, budget.correctMs)) return;
        const shape = this.shape(this.base.structures.filter(g => !this.program(g)), full, installed.features);
        if (this.prefetched.has(shape.shaderKey)) return;
        this.prefetched.set(shape.shaderKey, shape);
        return this.plan(this.base, shape);
    }
    /** Scheduling class of a compile for `plan`: `edit` renders the requested structures
     * correctly (never waits behind background work), `upgrade` is the gated specialized
     * variant, `prefetch` the background editing interpreter. */
    compileRole(plan: GraphPlan): GraphCompileRole {
        const key = graphShaderKey(plan);
        if (this.upgrade && key === this.upgrade.shaderKey && key !== this.serving?.shaderKey) return 'upgrade';
        return this.prefetched.has(key) && key !== this.serving?.shaderKey ? 'prefetch' : 'edit';
    }
    /** Compile sample of the ray-tracing kernel for `plan` (calibration input). */
    observeCompile(plan: GraphPlan, totalBytes: number, ms: number, overlapMs: number) {
        const shape = plan.key ? plan.shape : undefined;
        const observation = this.calibration.observe({totalBytes, specializedBytes: shape ? shape.specializedBytes : 0, interpreterBytes: shape ? shape.interpreterBytes : 0, ms, overlapMs});
        planner.onCompile?.(observation);
        return observation;
    }
    /** Candidate installation; returning active during debounce keeps the existing backend fast path. */
    candidate(hasPipeline: boolean): GraphPlan {
        return hasPipeline && performance.now() >= this.readyAt && !this.compileFailed ? this.requested : this.active;
    }
    /** Installs the requested plan whose shader key matches a ready variant. False when nothing changes. */
    installShader(shaderKey: string): boolean {
        if (this.requested.shaderKey !== shaderKey && graphShaderKey(this.requested) !== shaderKey) return false;
        if (this.requested.key === this.active.key && graphShaderKey(this.active) === shaderKey) return false;
        return this.install(this.requested, this.revision);
    }
    /** An installed upgrade is being compared with the serving variant. */
    get verifying() { return this.phase === 'verifying'; }
    /** An upgrade is compiling or being verified: keep polling converged targets. */
    get upgrading() { return this.active.key === this.planKey && (this.phase === 'compiling' || this.phase === 'verifying'); }
    /** A failed upgrade keeps the serving variant instead of failing the graphs. */
    abandonUpgrade(shaderKey: string): boolean {
        if (this.phase !== 'compiling' || this.upgrade?.shaderKey !== shaderKey) return false;
        this.phase = 'failed';
        this.emit('failed', {});
        this.requested = this.plan(this.base, this.serving!);
        return true;
    }
    install(plan: GraphPlan, revision: number) {
        if (revision !== this.revision || plan.key !== this.requested.key)
            return false;
        // A tier switch of unchanged structures keeps accumulation: both tiers evaluate
        // the same graph (block-level MAD 0), so only structure/assignment changes count.
        const changed = plan.key !== this.active.key || plan.graphs.some((g, i) => g?.key !== this.active.graphs[i]?.key);
        this.active = plan;
        const role = plan.shape && plan.shape === this.upgrade && this.phase !== 'done' ? 'upgrade' : 'serving';
        if (role === 'upgrade' && this.phase === 'compiling') {
            this.phase = 'verifying';
            this.verifier = new GraphUpgradeVerifier({minGain: this.policy.minVerifiedGain, phaseSamples: this.policy.verifySamples, minTimestamps: 6, minPhaseMs: 250, maxPhaseMs: 4000});
            this.emit('installed', {});
        }
        const interim = role === 'serving' && plan.key === this.planKey && (this.phase === 'waiting' || this.phase === 'compiling' || this.phase === 'verifying');
        planner.onInstall?.({key: plan.key, shaderKey: graphShaderKey(plan), interim, role, specialized: plan.structures.length - (plan.programs?.size ?? 0), interpreted: plan.programs?.size ?? 0, coverage: plan.shape?.coverage, at: performance.now()});
        if(!this.diagnostics.length)this.installedRevision = revision;
        if (changed)
            this.generation++;
        this.status = this.diagnostics.length ? 'failed' : plan.key ? 'ready' : 'idle';
        return true;
    }
    fail(revision: number, error: unknown) {
        if (revision !== this.revision)
            return;
        this.status = 'failed';
        this.compileFailed = true;
        this.diagnostics = [{ code: 'shader-compilation', message: error instanceof Error ? error.message : String(error) }];
    }
    get diagnosticsState(): MaterialGraphCompilationState { return { revision: this.revision, installedRevision: this.installedRevision, status: this.status, compilation: this.compilation && {...this.compilation}, diagnostics: this.diagnostics.map(d => ({...d})), topologyCount: this.requested.structures.length }; }
    renderMaterials(materials: OpenPBRMaterial[]): OpenPBRMaterial[] {
        return materials.map(material => {
            const snapshot = this.requested.slots?.get(material) ?? (material.graph ? this.active.slots?.get(material) : undefined);
            return this.constantFallback.has(material) || !snapshot ? material : this.slotTextures.apply(material, snapshot);
        });
    }
    slotCapabilities(): OpenPBRMaterial[] {
        return [...new Set([...(this.active.slots?.values() ?? []), ...(this.requested.slots?.values() ?? [])])].map(material => this.slotTextures.getCapabilities(material));
    }
    capabilityMaterials(retained: readonly OpenPBRMaterial[] = []): OpenPBRMaterial[] {
        return [...this.materials, ...retained, ...this.slotCapabilities()];
    }
    textures(): Texture[] {
        const textures = new Set<Texture>();
        for (const plan of [this.active, this.requested])
            for (const graph of plan.graphs)
                for (const value of graph?.parameters ?? [])
                    if (value instanceof Texture)
                        textures.add(value);
        if (this.hasSlotHistory) {
            for (const material of [...this.materials, ...(this.active.slots?.values() ?? []), ...(this.requested.slots?.values() ?? [])])
                for (const slot of MATERIAL_TEXTURE_SLOTS) {
                    const texture = material[slot.property];
                    if (texture) textures.add(texture);
                }
        }
        return [...textures];
    }
    emissionProposal(material: OpenPBRMaterial): number[] | undefined {
        if(!this.emissionSampling || material.unlit || material.shadowCatcher || this.constantFallback.has(material))return;
        const i=this.active.materials?.indexOf(material) ?? this.materials.indexOf(material);
        const graph=this.active.graphs[i];
        if(!graph || !['emissionColor','emissionLuminance','coatColor','coatWeight'].some(p=>p in graph.terminal))return;
        if(!('emissionColor' in graph.terminal || 'emissionLuminance' in graph.terminal) && material.emissionLuminance<=0)return;
        const rgb=material.emissionColor.map(c=>Math.max(c*material.emissionLuminance,0));
        return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722>1e-8 ? rgb : [1,1,1];
    }
    pack(buffer: Float32Array, textures: readonly Texture[]) {
        if (this.hasSlotHistory) {
            // Pipeline installation can remove a terminal that the previous slot
            // plan overrode. Restore authored rows before applying graph outputs;
            // the resource table stages both authored and retained slot images.
            const materials = this.materials.map(material => {
                const snapshot = this.active.slots?.get(material);
                return this.constantFallback.has(material) || !snapshot ? material : this.slotTextures.apply(material, snapshot);
            });
            const data = createMaterialBufferData(materials);
            for (const slot of MATERIAL_TEXTURE_SLOTS) data[slot.index] = materials.map(material => {
                const texture = material[slot.property];
                const index = texture ? textures.indexOf(texture) : -1;
                return slot.property === 'normalMap' && index >= 0 && texture?.normalMapFrame === 'materialx' ? index + .5 : index;
            });
            buffer = packMaterialBuffer(data);
        }
        if (!this.active.key)
            return buffer;
        const chunks: ArrayLike<number>[] = [];
        const interpreted: [number, string][] = [];
        const activeGraphs = new Map((this.active.materials ?? []).map((m,i) => [m,this.active.graphs[i]]));
        for (let i = 0; i < this.materials.length; i++) {
            if(this.constantFallback.has(this.materials[i]))continue;
            const graph = this.active.materials ? activeGraphs.get(this.materials[i]) : this.active.graphs[i];
            if (!graph)
                continue;
            const proposal=this.emissionProposal(this.materials[i]);
            if(proposal)buffer.set(proposal,i*MATERIAL_FLOAT_COUNT+emissionOffset);
            if ('opacity' in graph.terminal && this.materials[i].alphaMode === 'auto' && this.materials[i].alphaCutoff <= 0) buffer[i * MATERIAL_FLOAT_COUNT + alphaModeOffset] = 2;
            const generated = generateGraph(graph);
            const params: [
                unknown,
                ...unknown[]
            ] = [this.materials[i].emissionColor, this.materials[i].emissionLuminance, ...generated.parameters];
            if (this.active.programs?.has(graph.key)) interpreted.push([i, graph.key]);
            else buffer[i * MATERIAL_FLOAT_COUNT + padding] = (this.active.specialized ?? this.active.structures).findIndex(g => g.key === graph.key) + 1;
            buffer[i * MATERIAL_FLOAT_COUNT + padding + 1] = buffer.length / MATERIAL_FLOAT_COUNT + chunks.length;
            for (const param of params) {
                const values = param instanceof Texture ? [textures.indexOf(param)] : Array.isArray(param) ? param : [param === undefined ? -1 : param === 'world' ? 1 : param === '' ? -1 : typeof param === 'string' ? 0 : Number(param)];
                chunks.push(values as number[]);
            }
        }
        // Programs follow the parameter records; materials address their structure's
        // header record with a negative topology ID.
        const headers = new Map<string, number>();
        for (const [key, program] of this.active.programs ?? []) {
            headers.set(key, buffer.length / MATERIAL_FLOAT_COUNT + chunks.length);
            const entries = [program.surface, program.opacity, program.emission];
            const header = new Float32Array(MATERIAL_FLOAT_COUNT), [low, high] = graphTerminalMask(program.surface.terminals);
            header.set([...entries.map(e => e.instructions.length / GRAPH_INSTRUCTION_FLOATS), low], programRows[0]);
            header[programRows[1]] = high;
            chunks.push(header);
            for (const entry of entries) for (let at = 0; at < entry.instructions.length; at += GRAPH_INSTRUCTION_FLOATS) {
                const record = new Float32Array(MATERIAL_FLOAT_COUNT);
                programRows.forEach((row, r) => record.set(entry.instructions.slice(at + r * 4, at + r * 4 + 4), row));
                chunks.push(record);
            }
        }
        for (const [i, key] of interpreted) buffer[i * MATERIAL_FLOAT_COUNT + padding] = -headers.get(key)!;
        const packed = new Float32Array(buffer.length + chunks.length * MATERIAL_FLOAT_COUNT);
        packed.set(buffer);
        chunks.forEach((chunk, i) => packed.set(chunk, buffer.length + i * MATERIAL_FLOAT_COUNT));
        return packed;
    }
}
