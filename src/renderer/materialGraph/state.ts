import {createMaterialBufferData} from '../materialParams.js';
import {packMaterialBuffer} from '../materialLayout.js';
import {MATERIAL_TEXTURE_SLOTS} from '../materialTextureSlots.js';
import {SlotTextures} from './slotTextures.js';
import {flattenGraphUnchecked} from './flatten.js';
import {graphContextDiagnostics} from './context.js';
import {graphTerminals} from './ir.js';
import type OpenPBRMaterial from '../../scene/OpenPBRMaterial.js';
import Texture from '../../scene/Texture.js';
import type { MaterialGraphDiagnostic } from '../../scene/MaterialGraph.js';
import { normalizeGraph, type NormalizedGraph } from './normalize.js';
import { generateGraph } from './codegen.js';
import { MATERIAL_FLOAT_COUNT, materialLayoutFields } from '../materialLayoutSchema.js';
const alphaModeOffset = materialLayoutFields().find(field => field.name === 'alphaMode')!.offset / 4;
const padding = materialLayoutFields().find(field => field.name === '_padding1')!.offset / 4;
export interface GraphPlan {
    key: string;
    materials?: readonly OpenPBRMaterial[];
    graphs: (NormalizedGraph | undefined)[];
    structures: NormalizedGraph[];
    slots?: ReadonlyMap<OpenPBRMaterial, OpenPBRMaterial>;
}
const empty = (): GraphPlan => ({ key: '', graphs: [], structures: [] });
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
                const context=graphContextDiagnostics(flattenGraphUnchecked(graph),material.unlit,material.emissionLuminance>0,material.alphaMode==='opaque',material.uvProjection!=='none');
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
        const assignmentKey = (plan: GraphPlan) => plan.graphs.map(g => g?.key ?? '').join('\n');
        const authoredChanged = (materials.some(m => !!m.graph) || this.sourceRevisions.some(item => !!item.graph)) && (materials.length !== this.sourceRevisions.length || materials.some((m, i) => m.graph !== this.sourceRevisions[i]?.graph || m.graph?.revision !== this.sourceRevisions[i]?.revision));
        this.sourceRevisions = materials.map(m => ({ graph: m.graph, revision: m.graph?.revision }));
        if (authoredChanged || key !== this.requested.key || assignmentKey({ key, graphs, structures }) !== assignmentKey(this.requested)) {
            this.revision++;
            this.readyAt = performance.now() + 32;
        }
        this.requested = { key, materials: materials.slice(), graphs, structures, slots };
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
        const chunks: number[][] = [];
        const activeGraphs = new Map((this.active.materials ?? []).map((m,i) => [m,this.active.graphs[i]]));
        for (let i = 0; i < this.materials.length; i++) {
            if(this.constantFallback.has(this.materials[i]))continue;
            const graph = this.active.materials ? activeGraphs.get(this.materials[i]) : this.active.graphs[i];
            if (!graph)
                continue;
            if ('opacity' in graph.terminal && this.materials[i].alphaMode === 'auto' && this.materials[i].alphaCutoff <= 0) buffer[i * MATERIAL_FLOAT_COUNT + alphaModeOffset] = 2;
            const generated = generateGraph(graph);
            const params: [
                unknown,
                ...unknown[]
            ] = [this.materials[i].emissionColor, this.materials[i].emissionLuminance, ...generated.parameters];
            buffer[i * MATERIAL_FLOAT_COUNT + padding] = this.active.structures.findIndex(g => g.key === graph.key) + 1;
            buffer[i * MATERIAL_FLOAT_COUNT + padding + 1] = buffer.length / MATERIAL_FLOAT_COUNT + chunks.length;
            for (const param of params) {
                const values = param instanceof Texture ? [textures.indexOf(param)] : Array.isArray(param) ? param : [param === undefined ? -1 : param === 'world' ? 1 : param === '' ? -1 : typeof param === 'string' ? 0 : Number(param)];
                chunks.push(values as number[]);
            }
        }
        const packed = new Float32Array(buffer.length + chunks.length * MATERIAL_FLOAT_COUNT);
        packed.set(buffer);
        chunks.forEach((chunk, i) => packed.set(chunk, buffer.length + i * MATERIAL_FLOAT_COUNT));
        return packed;
    }
}
