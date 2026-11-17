import type {MaterialGraphState as CompilerState, GraphPlan, MaterialGraphCompilationState} from './state.js';
import type * as Runtime from './runtime.js';
import type OpenPBRMaterial from '../../scene/OpenPBRMaterial.js';
import {GraphCompileCalibration, graphCompilerBackend} from '../shaderCompilePolicy.js';

export type GraphState = Pick<CompilerState, keyof CompilerState>;
let runtime: typeof Runtime | undefined;
let pending: Promise<typeof Runtime> | undefined;
export function loadMaterialGraphRuntime() {
    return pending ??= import('./runtime.js').then(module => runtime = module).catch(cause => {
        pending = undefined;
        throw new Error('Failed to load Material Graph compiler/runtime.', {cause});
    });
}
export const getMaterialGraphRuntime = () => runtime;
export const graphShaderKey = (plan: GraphPlan) => plan.shaderKey ?? plan.key;
export const materialGraphShader: typeof Runtime.materialGraphShader = (...args) => runtime?.materialGraphShader(...args) ?? {};
export const materialGraphConstants: typeof Runtime.materialGraphConstants = (...args) => runtime?.materialGraphConstants(...args) ?? {...args[0]};
export const materialSurfaceAreas: typeof Runtime.materialSurfaceAreas = (...args) => runtime?.materialSurfaceAreas(...args) ?? new Map();
export const materialSlotPlan: typeof Runtime.materialSlotPlan = (...args) => runtime?.materialSlotPlan(...args);

const empty = (): GraphPlan => ({key: '', shaderKey: '', graphs: [], structures: [], specialized: [], programs: new Map(), interpreterTerminals: []});

/** Graph-free behavior while the optional module loads. Existing pipeline code
 * keeps rendering material constants/maps, and its normal graph poll observes
 * compiling/failed until the real state installs the requested graph. */
class GraphFreeState implements GraphState {
    capabilities = 'atlas';
    emissionSampling = true;
    interpreterAvailable = false;
    calibration = new GraphCompileCalibration(graphCompilerBackend());
    usage?: CompilerState['usage'];
    active = empty(); requested = empty();
    revision = 0; installedRevision = 0; generation = 0;
    compilation?: CompilerState['compilation'];
    status: MaterialGraphCompilationState['status'] = 'idle';
    diagnostics: CompilerState['diagnostics'] = [];
    phase: CompilerState['phase'] = 'none';
    lastGate?: CompilerState['lastGate'];
    materials: OpenPBRMaterial[] = [];
    request(materials: OpenPBRMaterial[]) {this.materials = materials;}
    get activeShaderKey() {return '';}
    recordFrame() {} recordGpuSample() {} tick() {} compiled() {}
    prefetch() {return undefined;} editingPlan() {return undefined;} prefetchedEditingPlan() {return undefined;}
    compileRole(): ReturnType<CompilerState['compileRole']> {return 'edit';}
    observeCompile(_plan: GraphPlan, totalBytes: number, ms: number, overlapMs: number) {
        return this.calibration.observe({totalBytes, specializedBytes: 0, interpreterBytes: 0, ms, overlapMs});
    }
    candidate() {return this.active;}
    installShader() {return false;}
    get editingInstalled() {return false;} get verifying() {return false;} get upgrading() {return false;}
    abandonUpgrade() {return false;}
    install() {return false;}
    fail(revision: number, error: unknown) {
        if (revision !== this.revision) return;
        this.status = 'failed';
        this.diagnostics = [{code: 'shader-compilation', message: error instanceof Error ? error.message : String(error)}];
    }
    get diagnosticsState(): MaterialGraphCompilationState {
        return {revision: this.revision, installedRevision: this.installedRevision, status: this.status,
            diagnostics: this.diagnostics.map(d => ({...d})), topologyCount: 0};
    }
    renderMaterials(materials: OpenPBRMaterial[]) {return materials;}
    slotCapabilities() {return [];}
    capabilityMaterials(retained: readonly OpenPBRMaterial[] = []) {return [...this.materials, ...retained];}
    textures() {return [];}
    emissionProposal() {return undefined;}
    evaluatedTerminals() {return undefined;}
    pack(buffer: Float32Array) {return buffer;}
}

/** Stable state identity for material tables retained across a module load.
 * The proxy forwards only to one live state; it never plans shader/frame work. */
export function createMaterialGraphState(onReady?: () => void): GraphState {
    const fallback = new GraphFreeState();
    let current: GraphState = runtime ? new runtime.MaterialGraphState() : fallback;
    let loading: Promise<void> | undefined;
    let failedRevision: number | undefined;
    let sources: {graph: OpenPBRMaterial['graph']; revision?: number}[] = [];
    const load = () => loading ??= loadMaterialGraphRuntime().then(module => {
        const next = new module.MaterialGraphState();
        next.capabilities = current.capabilities; next.emissionSampling = current.emissionSampling;
        next.interpreterAvailable = current.interpreterAvailable; next.usage = current.usage; next.calibration = current.calibration;
        // Loading is preparation of the same authored request, not a new edit.
        next.revision = fallback.revision - Number(fallback.materials.some(m => !!m.graph));
        next.request(fallback.materials);
        current = next;
        onReady?.();
    }).catch(error => {failedRevision = current.revision; current.fail(current.revision, error);});
    return new Proxy(fallback, {
        get(_target, property) {
            if (property === 'request') return (materials: OpenPBRMaterial[]) => {
                if (current !== fallback) {current.request(materials); return;}
                const hasGraphs = materials.some(m => !!m.graph);
                if ((hasGraphs || sources.some(s => !!s.graph)) && (materials.length !== sources.length || materials.some((m,i) => m.graph !== sources[i]?.graph || m.graph?.revision !== sources[i]?.revision))) fallback.revision++;
                sources = materials.map(m => ({graph: m.graph, revision: m.graph?.revision}));
                fallback.request(materials);
                if (failedRevision !== undefined && failedRevision !== fallback.revision) {failedRevision = undefined; loading = undefined; fallback.diagnostics = [];}
                fallback.status = failedRevision === fallback.revision ? 'failed' : hasGraphs ? 'compiling' : 'idle';
                if (!hasGraphs) fallback.installedRevision = fallback.revision;
                if (hasGraphs) void load();
            };
            // Editing prefetch explicitly requests the runtime even without a graph.
            if (property === 'editingPlan' && current === fallback) void load();
            const value = Reflect.get(current, property, current);
            return typeof value === 'function' ? value.bind(current) : value;
        },
        set(_target, property, value) {return Reflect.set(current, property, value, current);}
    });
}
