import type OpenPBRMaterial from '../../scene/OpenPBRMaterial.js';
import Texture from '../../scene/Texture.js';
import type { MaterialGraphDiagnostic } from '../../scene/MaterialGraph.js';
import { normalizeGraph, type NormalizedGraph } from './normalize.js';
import { generateGraph, type Backend } from './codegen.js';
import { MATERIAL_FLOAT_COUNT, materialLayoutFields } from '../materialLayoutSchema.js';
const alphaModeOffset = materialLayoutFields().find(field => field.name === 'alphaMode')!.offset / 4;
const padding = materialLayoutFields().find(field => field.name === '_padding1')!.offset / 4;
export interface GraphPlan {
    key: string;
    materials?: readonly OpenPBRMaterial[];
    graphs: (NormalizedGraph | undefined)[];
    structures: NormalizedGraph[];
}
const empty = (): GraphPlan => ({ key: '', graphs: [], structures: [] });
export interface MaterialGraphCompilationState {
    /** Latest requested revision, initially zero. */ revision: number;
    /** Latest fully valid installed revision, initially zero. */ installedRevision: number;
    /** idle before graphs; compiling includes debounce; ready or failed afterwards. */ status: 'idle' | 'compiling' | 'ready' | 'failed';
    /** Located graph or driver failures. Default empty. */ diagnostics: MaterialGraphDiagnostic[];
    /** Last installed graph program measurements; browser driver stages are combined. Default undefined. */
    compilation?: {
        sourceBytes: number;
        sourceGenerationTimeMs: number;
        moduleCreationTimeMs: number;
        totalTimeMs?: number;
    };
    /** Distinct reachable graph structures in the requested scene. Default zero. */ topologyCount: number;
}
/** Graph data is staged independently of uniforms used by the installed pipeline.
 * The existing backend pipeline caches own compilation/scheduling; this class only
 * snapshots graph parameters and guards installation by revision. */
export class MaterialGraphState {
    capabilities = 'atlas';
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
    constructor(readonly backend: Backend) { }
    request(materials: OpenPBRMaterial[]) {
        this.materials = materials;
        this.compileFailed = false;
        this.constantFallback.clear();
        const diagnostics: MaterialGraphDiagnostic[] = [];
        const previousGraphs = new Map((this.active.materials ?? []).map((m,i) => [m,this.active.graphs[i]]));
        const graphs = materials.map((material, index) => {
            if (!material.graph)
                return undefined;
            const graph = normalizeGraph(material.graph, this.backend, this.capabilities);
            if (!material.unlit && (['emissionColor', 'emissionLuminance'].some(port => port in graph.terminal) || material.emissionLuminance > 0 && ['coatColor', 'coatWeight'].some(port => port in graph.terminal))) {
                const port=['emissionColor','emissionLuminance','coatColor','coatWeight'].find(p=>p in graph.terminal)!;
                graph.diagnostics.push({ node:graph.nodes[graph.terminal[port].node]?.id, port, code: 'unsupported-emission-graph', message: 'Graph emission and graph coat absorption on emissive surfaces currently require an unlit material.' });
                // A formerly valid unlit graph cannot remain installed after
                // switching to an unsupported lit-emitter context.
                this.constantFallback.add(material);
            }
            if ('opacity' in graph.terminal) {
                const seen=new Set<number>();
                const check=(index:number) => { if(seen.has(index)||index<0)return;seen.add(index);const node=graph.nodes[index];
                    if(['normal','tangent','bitangent','normalmap','gltf_normalmap','transformnormal'].includes(node.category)||Object.values(node.inputs).some(i=>i.geometry&&i.geometry!=='texcoord'&&i.geometry!=='objectPosition'))graph.diagnostics.push({code:'unsupported-opacity-context',message:'Opacity graphs support UV and position inputs; shading-frame inputs are not available to shadow traversal.',node:node.id,port:'opacity'});
                    for(const i of Object.values(node.inputs))if(i.node!==undefined)check(i.node);
                };
                check(graph.terminal.opacity.node);
            }
            diagnostics.push(...graph.diagnostics.map(d => ({...d,materialId:material.aovId})));
            // Preserve the successful graph for this slot after validation failure.
            return this.constantFallback.has(material) ? undefined : graph.diagnostics.length ? (this.active.materials ? previousGraphs.get(material) : this.active.graphs[index]) : graph;
        });
        const structures = Array.from(new Map(graphs.filter((g): g is NormalizedGraph => !!g && !!Object.keys(g.terminal).length).map(g => [g.key, g])).values()).sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
        const key = structures.map(g => g.key).join('\n');
        const assignmentKey = (plan: GraphPlan) => plan.graphs.map(g => g?.key ?? '').join('\n');
        const authoredChanged = (materials.some(m => !!m.graph) || this.sourceRevisions.some(item => !!item.graph)) && (materials.length !== this.sourceRevisions.length || materials.some((m, i) => m.graph !== this.sourceRevisions[i]?.graph || m.graph?.revision !== this.sourceRevisions[i]?.revision));
        this.sourceRevisions = materials.map(m => ({ graph: m.graph, revision: m.graph?.revision }));
        if (authoredChanged || key !== this.requested.key || assignmentKey({ key, graphs, structures }) !== assignmentKey(this.requested)) {
            this.revision++;
            this.readyAt = performance.now() + 32;
        }
        this.requested = { key, materials: materials.slice(), graphs, structures };
        this.diagnostics = diagnostics;
        if (key === this.active.key) {
            this.install(this.requested, this.revision);
            this.status = diagnostics.length ? 'failed' : key ? 'ready' : 'idle';
        }
        else
            this.status = 'compiling';
    }
    /** Returning active during debounce keeps the existing backend fast path. */
    candidate(hasPipeline: boolean): GraphPlan {
        return hasPipeline && performance.now() >= this.readyAt && !this.compileFailed ? this.requested : this.active;
    }
    install(plan: GraphPlan, revision: number) {
        if (revision !== this.revision || plan.key !== this.requested.key)
            return false;
        const changed = plan.key !== this.active.key || plan.graphs.some((g, i) => g?.key !== this.active.graphs[i]?.key);
        this.active = this.requested;
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
    textures(): Texture[] {
        const textures = new Set<Texture>();
        for (const plan of [this.active, this.requested])
            for (const graph of plan.graphs)
                for (const value of graph?.parameters ?? [])
                    if (value instanceof Texture)
                        textures.add(value);
        return [...textures];
    }
    pack(buffer: Float32Array, textures: readonly Texture[]) {
        if (!this.active.key)
            return buffer;
        const chunks: number[][] = [];
        const activeGraphs = new Map((this.active.materials ?? []).map((m,i) => [m,this.active.graphs[i]]));
        for (let i = 0; i < this.materials.length; i++) {
            if(this.constantFallback.has(this.materials[i]))continue;
            const graph = this.active.materials ? activeGraphs.get(this.materials[i]) : this.active.graphs[i];
            if (!graph)
                continue;
            if ('opacity' in graph.terminal && this.materials[i].alphaMode === 'auto' && this.materials[i].alphaCutoff <= 0) buffer[i * MATERIAL_FLOAT_COUNT + alphaModeOffset] = 2;
            const generated = generateGraph(graph, this.backend);
            const params: [
                unknown,
                ...unknown[]
            ] = [this.materials[i].emissionColor, this.materials[i].emissionLuminance, ...generated.parameters];
            buffer[i * MATERIAL_FLOAT_COUNT + padding] = this.active.structures.findIndex(g => g.key === graph.key) + 1;
            buffer[i * MATERIAL_FLOAT_COUNT + padding + 1] = buffer.length / MATERIAL_FLOAT_COUNT + chunks.length;
            for (const param of params) {
                const values = param instanceof Texture ? [textures.indexOf(param)] : Array.isArray(param) ? param : [param === undefined ? -1 : param === 'world' ? 1 : typeof param === 'string' ? 0 : Number(param)];
                chunks.push(values as number[]);
            }
        }
        const packed = new Float32Array(buffer.length + chunks.length * MATERIAL_FLOAT_COUNT);
        packed.set(buffer);
        chunks.forEach((chunk, i) => packed.set(chunk, buffer.length + i * MATERIAL_FLOAT_COUNT));
        return packed;
    }
}
