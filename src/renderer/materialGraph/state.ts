import {createMaterialBufferData} from '../materialParams.js';
import {packMaterialBuffer} from '../materialLayout.js';
import {MATERIAL_TEXTURE_SLOTS} from '../materialTextureSlots.js';
import {SlotTextures} from './slotTextures.js';
import {flattenGraphUnchecked} from './flatten.js';
import {graphContextDiagnostics} from './context.js';
import {graphTerminals} from './ir.js';
import {terminalTypes} from './nodes.js';
import {DEFAULT_GRAPH_COMPILE_MODEL, DEFAULT_GRAPH_TIER_BUDGET, planGraphTiers, type GraphCompileModel, type GraphTierBudget, type GraphTierCandidate} from './planner.js';
import {generateGraphIR} from './generate.js';
import {buildGraphProgram, graphTerminalMask, GRAPH_INSTRUCTION_FLOATS, type GraphProgram, type GraphProgramResult} from './interpreter.js';
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
export interface MaterialGraphPlannerOptions {
    /** Default auto. */
    tier?: MaterialGraphTier;
    /** Makes the interpreter source unique so driver caches miss; measurement only. Default 0. */
    salt?: number;
    /** Default DEFAULT_GRAPH_COMPILE_MODEL. */
    model?: GraphCompileModel;
    /** Default DEFAULT_GRAPH_TIER_BUDGET. */
    budget?: GraphTierBudget;
    /** Compile the interpreter-only variant first when the final variant is mixed. Default true. */
    interim?: boolean;
    /** Measurement hook called on every installation. */
    onInstall?: (event: GraphInstallEvent) => void;
}
export interface GraphInstallEvent { key: string; shaderKey: string; interim: boolean; specialized: number; interpreted: number; /** Planned share of interpreter work moved to specialized code. */ coverage?: number; at: number }
let planner: Required<Omit<MaterialGraphPlannerOptions, 'onInstall'>> & Pick<MaterialGraphPlannerOptions, 'onInstall'> =
    {tier: 'auto', salt: 0, model: DEFAULT_GRAPH_COMPILE_MODEL, budget: DEFAULT_GRAPH_TIER_BUDGET, interim: true};
/** Internal planner overrides for measurement; omitted fields reset to their defaults. */
export function setMaterialGraphPlanner(options: MaterialGraphPlannerOptions = {}) {
    planner = {tier: options.tier ?? 'auto', salt: options.salt ?? 0, model: options.model ?? DEFAULT_GRAPH_COMPILE_MODEL,
        budget: options.budget ?? DEFAULT_GRAPH_TIER_BUDGET, interim: options.interim ?? true, onInstall: options.onInstall};
}
/** Categories that pull shared helper libraries into specialized code. */
const graphHelperCategories: Record<string, string[]> = {
    noise: ['noise2d', 'noise3d', 'fractal3d', 'cellnoise2d', 'cellnoise3d', 'worleynoise2d', 'worleynoise3d'],
    hsv: ['rgbtohsv', 'hsvtorgb', 'hsvadjust'], rotate3d: ['rotate3d']
};
export const GRAPH_INTERPRETER_KEY = 'mx-interpreter-1';
/** Plans without a tier split (older snapshots, tests) are fully specialized. */
export const graphShaderKey = (plan: GraphPlan) => plan.shaderKey ?? plan.key;
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
    /** Terminals written by interpreted structures. */
    interpreterTerminals?: string[];
    interpreterSalt?: number;
    /** Interpreter-only plan of the same structures, installed while this plan's mixed variant compiles. */
    interim?: GraphPlan;
    /** Whether to compile the interim variant (rather than only use it when ready). */
    compileInterim?: boolean;
    slots?: ReadonlyMap<OpenPBRMaterial, OpenPBRMaterial>;
}
const empty = (): GraphPlan => ({ key: '', shaderKey: '', graphs: [], structures: [], specialized: [], programs: new Map(), interpreterTerminals: [] });
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
    /** Tier decisions stay fixed for a structure set, so usage changes (transforms,
     * visibility) never recompile; a new set is planned again. */
    private tiers?: {key: string; planner: typeof planner; specialized: Set<string>; coverage?: number};
    private sourceCache = new Map<string, Pick<GraphTierCandidate, 'sourceBytes' | 'helpers'>>();
    private decideTiers(key: string, structures: NormalizedGraph[], materials: OpenPBRMaterial[], graphs: (NormalizedGraph | undefined)[]) {
        if (this.tiers?.key === key && this.tiers.planner === planner) return this.tiers.specialized;
        let specialized: Set<string>, coverage: number | undefined;
        if (planner.tier === 'specialized' || !this.interpreterAvailable || !structures.length) specialized = new Set(structures.map(g => g.key));
        else if (planner.tier === 'interpreter') specialized = new Set(structures.filter(g => !this.program(g)).map(g => g.key));
        else {
            const weights = this.usage?.(), usage = new Map<string, number>();
            const equal = !weights || !materials.some((m, i) => graphs[i] && (weights.get(m) ?? 0) > 0);
            graphs.forEach((g, i) => { if (g) usage.set(g.key, (usage.get(g.key) ?? 0) + (equal ? 1 : weights.get(materials[i]) ?? 0)); });
            const candidates = structures.map(g => {
                const program = this.program(g);
                return {key: g.key, usage: usage.get(g.key) ?? 0, ...this.source(g),
                    instructions: program ? [program.surface, program.opacity, program.emission].reduce((n, e) => n + e.instructions.length / GRAPH_INSTRUCTION_FLOATS, 0) : undefined};
            });
            ({specialized, coverage} = planGraphTiers(candidates, planner.model, planner.budget));
        }
        this.tiers = {key, planner, specialized, coverage};
        return specialized;
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
    private withTiers(base: Pick<GraphPlan, 'key' | 'materials' | 'graphs' | 'structures' | 'slots'>, specializedKeys: ReadonlySet<string>): GraphPlan {
        const programs = new Map<string, GraphProgram>();
        for (const g of base.structures) { const program = specializedKeys.has(g.key) ? undefined : this.program(g); if (program) programs.set(g.key, program); }
        const specialized = base.structures.filter(g => !programs.has(g.key));
        const interpreterTerminals = Object.keys(terminalTypes).filter(name => base.structures.some(g => programs.has(g.key) && name in g.terminal));
        const shaderKey = [...specialized.map(g => g.key), ...(programs.size ? [`${GRAPH_INTERPRETER_KEY}:${interpreterTerminals.join(',')}:${planner.salt}`] : [])].join('\n');
        return {...base, shaderKey, specialized, programs, interpreterTerminals, interpreterSalt: planner.salt};
    }
    private program(graph: NormalizedGraph) {
        let result = this.programCache.get(graph.key);
        if (!result) this.programCache.set(graph.key, result = buildGraphProgram(flattenGraphUnchecked(graph)));
        return result.program;
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
        const specializedKeys = this.decideTiers(key, structures, materials, graphs);
        const base = { key, materials: materials.slice(), graphs, structures, slots };
        const final = this.withTiers(base, specializedKeys);
        // The interpreter-only variant installs first while a mixed variant compiles,
        // and also bridges any later structure set while its own variant is ready.
        const interim = planner.tier === 'auto' && specializedKeys.size ? this.withTiers(base, new Set()) : undefined;
        const assignmentKey = (plan: GraphPlan) => plan.graphs.map(g => g?.key ?? '').join('\n');
        const authoredChanged = (materials.some(m => !!m.graph) || this.sourceRevisions.some(item => !!item.graph)) && (materials.length !== this.sourceRevisions.length || materials.some((m, i) => m.graph !== this.sourceRevisions[i]?.graph || m.graph?.revision !== this.sourceRevisions[i]?.revision));
        this.sourceRevisions = materials.map(m => ({ graph: m.graph, revision: m.graph?.revision }));
        if (authoredChanged || key !== this.requested.key || assignmentKey({ ...empty(), key, graphs, structures }) !== assignmentKey(this.requested)) {
            this.revision++;
            this.readyAt = performance.now() + 32;
        }
        this.requested = { ...final, ...(interim && interim.programs!.size && graphShaderKey(interim) !== graphShaderKey(final) ? {interim, compileInterim: planner.interim && final.programs!.size > 0} : {}) };
        this.diagnostics = diagnostics;
        if (key === this.active.key) {
            // Same structures: keep the installed tiers (and its variant) for these parameters.
            const installed = graphShaderKey(this.active) === graphShaderKey(this.requested) ? this.requested : this.requested.interim && graphShaderKey(this.active) === graphShaderKey(this.requested.interim) ? this.requested.interim : this.withTiers(base, new Set((this.active.specialized ?? []).map(g => g.key)));
            this.install(installed, this.revision);
            this.status = diagnostics.length ? 'failed' : key ? 'ready' : 'idle';
        }
        else
            this.status = 'compiling';
    }
    /** Returning active during debounce keeps the existing backend fast path. */
    candidate(hasPipeline: boolean): GraphPlan {
        return hasPipeline && performance.now() >= this.readyAt && !this.compileFailed ? this.requested : this.active;
    }
    /** Installs the requested plan, or its interpreter-only interim, whose shader
     * key matches a ready variant. False when nothing changes. */
    installShader(shaderKey: string): boolean {
        const plan = [this.requested, this.requested.interim].find(p => p && graphShaderKey(p) === shaderKey);
        if (!plan || plan.key === this.active.key && graphShaderKey(this.active) === shaderKey) return false;
        return this.install(plan, this.revision);
    }
    install(plan: GraphPlan, revision: number) {
        if (revision !== this.revision || plan.key !== this.requested.key)
            return false;
        // A tier switch of unchanged structures keeps accumulation: both tiers evaluate
        // the same graph (block-level MAD 0), so only structure/assignment changes count.
        const changed = plan.key !== this.active.key || plan.graphs.some((g, i) => g?.key !== this.active.graphs[i]?.key);
        this.active = plan;
        planner.onInstall?.({key: plan.key, shaderKey: graphShaderKey(plan), interim: plan === this.requested.interim, specialized: plan.specialized?.length ?? plan.structures.length, interpreted: plan.programs?.size ?? 0, coverage: this.tiers?.key === plan.key ? this.tiers.coverage : undefined, at: performance.now()});
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
