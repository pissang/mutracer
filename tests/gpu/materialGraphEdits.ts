import { Engine, Render, Camera, Mesh, OpenPBRMaterial, MaterialGraph, createPlaneGeometry } from '../../src/main.js';
import type { MaterialGraphNode as Node } from '../../src/main.js';
const pause = () => new Promise(resolve => setTimeout(resolve, 10));
const color = (value: number): Node => ({ id: 'color', category: 'constant', type: 'color3', inputs: { value: { type: 'color3', value: [value, value, value] } } });
function chain(count: number, value = 0.02) {
    const nodes: Node[] = [{ id: 'uv', category: 'texcoord', type: 'vector2' }, { id: 's', category: 'separate2', type: 'vector2', inputs: { in: { type: 'vector2', connection: { node: 'uv' } } } }];
    for (let i = 0; i < count; i++)
        nodes.push({ id: `n${i}`, category: i % 2 ? 'multiply' : 'add', type: 'float', inputs: { in1: { type: 'float', connection: { node: i ? `n${i - 1}` : 's', output: i ? 'out' : 'outx' } }, in2: { type: 'float', value: i % 2 ? 0.95 : value } } });
    nodes.push({ id: 'out', category: 'convert', type: 'color3', inputs: { in: { type: 'float', connection: { node: `n${count - 1}` } } } });
    return new MaterialGraph({ nodes, terminal: { emissionColor: { node: 'out' } } });
}
async function sharing(backend: 'webgpu' | 'webgl', count: () => number) {
    const engine = new Engine({ backend, canvas: document.createElement('canvas') });
    engine.display.setSize(32, 32);
    const geometry = createPlaneGeometry(1, 1, 'vertical'), materials = Array.from({ length: 70 }, (_, i) => new OpenPBRMaterial({ graph: chain(i % 19 + 1, 0.01 + i * 0.001), unlit: true, emissionLuminance: 1 }));
    const camera = new Camera({ projection: 'orthographic', left: -1, right: 1, top: 1, bottom: -1 });
    camera.position = [0, 0, 3];
    camera.lookAt([0, 0, 0]);
    engine.scene = { meshes: materials.map(m => new Mesh(geometry, m)), lights: [] };
    engine.camera = camera;
    const render = new Render(engine, { bounces: 1 });
    const before = count(), start = performance.now();
    try {
        engine.update();
        await render.converge({ samples: 1, timeoutMs: 90000 });
        const timer = setInterval(() => render.refine(), 10);
        try {
            const result = await engine.waitForMaterialGraphs({signal: AbortSignal.timeout(90000)});
            if (result.outcome !== 'settled' || result.state.status !== 'ready') throw Error(JSON.stringify(result));
        } finally {clearInterval(timer);}
        return { materials: 70, topologies: engine.getDiagnostics()?.materialGraphs?.topologyCount, compiles: count() - before, firstMs: performance.now() - start, shader: engine.getDiagnostics()?.shaderCompilation, graph: engine.getDiagnostics()?.materialGraphs };
    }
    finally {
        render.dispose();
        engine.dispose();
    }
}
async function run() {
    const backend = 'webgpu';
    let compiles = 0;
    let failNext = false;
    const prototype = GPUDevice.prototype, original = prototype.createComputePipelineAsync;
    (prototype as any).createComputePipelineAsync = function (...args: any[]) {
        if (args[0]?.label === 'Ray Trace') {
            compiles++;
            if(failNext) {
                failNext=false;
                return Promise.reject(new Error('fixture graph pipeline failure'));
            }
        }
        return original.apply(this,args as never);
    };
    const engine = new Engine({ backend, canvas: document.createElement('canvas') });
    engine.display.setSize(32, 32);
    const graph = new MaterialGraph({ nodes: [color(0.2)], terminal: { emissionColor: { node: 'color' } } }), material = new OpenPBRMaterial({ graph, unlit: true, emissionLuminance: 1 });
    const geometry = createPlaneGeometry(1, 1, 'vertical');
    geometry.uv!.array.fill(0.37);
    const camera = new Camera({ projection: 'orthographic', left: -1, right: 1, top: 1, bottom: -1 });
    camera.position = [0, 0, 3];
    camera.lookAt([0, 0, 0]);
    engine.scene = { meshes: [new Mesh(geometry, material)], lights: [] };
    engine.camera = camera;
    const render = new Render(engine, { bounces: 1, samplingPattern: 'sobol' });
    const state = () => engine.getDiagnostics()?.materialGraphs;
    const wait = async () => {
        const timer = setInterval(() => render.refine(), 10);
        try {
            const result = await engine.waitForMaterialGraphs({signal: AbortSignal.timeout(90000)});
            if (result.outcome !== 'settled') throw Error(JSON.stringify(result));
            return result.state;
        } finally {clearInterval(timer);}
    };
    const settle = async (expected: 'ready' | 'idle' = 'ready') => {
        const start = performance.now(), result = await wait();
        if (result.status !== expected) throw Error(JSON.stringify(result));
        return performance.now() - start;
    };
    const pixel = async () => { render.restart(); await render.converge({ samples: 4, timeoutMs: 60000 }); return (await render.readPixels('hdr')).data[0]; };
    try {
        engine.update();
        await render.converge({ samples: 1, timeoutMs: 60000 });
        await settle();
        await pixel();
        const initial = compiles, beforeParameter = compiles;
        graph.setInput('color', 'value', { type: 'color3', value: [0.3, 0.3, 0.3] });
        engine.update();
        render.refine();
        await settle();
        const parameterPixel = await pixel(), parameterCompiles = compiles - beforeParameter;
        const beforeStructure = compiles, samplesAtStart = render.samples;
        const revisions: number[] = [];
        for (const category of ['mix', 'add', 'multiply']) {
            graph.setNode(category === 'mix' ? { id: 'color', category, type: 'color3', inputs: { bg: { type: 'color3', value: [0.1, 0.1, 0.1] }, fg: { type: 'color3', value: [0.8, 0.8, 0.8] } } } : { id: 'color', category, type: 'color3', inputs: { in1: { type: 'color3', value: [0.4, 0.4, 0.4] }, in2: { type: 'color3', value: [0.5, 0.5, 0.5] } } });
            engine.update();
            render.refine();
            revisions.push(state()!.revision);
            await pause();
        }
        let pendingFrames = 0, maximumPendingSamples = 0, obsoleteInstalled = false;
        const started = performance.now(), last = revisions.at(-1)!;
        let completed = false;
        const pending = wait().then(result => {completed = true; return result;});
        while (!completed) {
            if (state()?.status === 'failed')
                throw new Error(JSON.stringify(state()));
            render.refine();
            if (state()?.status === 'compiling') {
                pendingFrames++;
                maximumPendingSamples = Math.max(maximumPendingSamples, render.samples);
                obsoleteInstalled ||= revisions.slice(0, -1).includes(state()!.installedRevision);
            }
            if (performance.now() - started > 90000)
                throw new Error('structure timeout');
            await pause();
        }
        const structureState = await pending;
        if (structureState.status !== 'ready') throw Error(JSON.stringify(structureState));
        const structureMs = performance.now() - started, structureCompiles = compiles - beforeStructure, structurePixel = await pixel(), installed = state()!.installedRevision;
        const stable = structurePixel;
        graph.setNode({ id: 'color', category: 'unknown_node', type: 'color3' });
        engine.update();
        render.refine();
        await pause();
        const failure = state(), failurePixel = await pixel();
        const cacheBefore = compiles;
        material.graph = new MaterialGraph({ nodes: [color(0.9)], terminal: { emissionColor: { node: 'color' } } });
        engine.update();
        render.refine();
        const cacheMs = await settle(), cachePixel = await pixel(), cacheCompiles = compiles - cacheBefore;
        const beforeFailureCompiles = compiles;
        failNext = true;
        material.graph = new MaterialGraph({nodes:[{id:'color',category:'mix',type:'color3',inputs:{bg:{type:'color3',value:[0.2,0.2,0.2]},fg:{type:'color3',value:[0.8,0.8,0.8]},mix:{type:'float',value:0.5}}}],terminal:{emissionColor:{node:'color'}}});
        engine.update();render.refine();
        const driverFailure = await wait(), driverFailurePixel = await pixel();
        material.graph.setInput('color','mix',{type:'float',value:0.25});engine.update();render.refine();await settle();
        const retryPixel = await pixel(), retryCompiles = compiles-beforeFailureCompiles;
        engine.display.setSize(256, 256);
        material.graph = chain(26);
        engine.update();
        render.refine();
        await settle();
        const graphStart = performance.now();
        render.restart();
        await render.converge({ samples: 64, timeoutMs: 60000 });
        const graphSpp = 64 / (performance.now() - graphStart) * 1000;
        material.graph = undefined;
        engine.update();
        await render.converge({ samples: 1, timeoutMs: 60000 });
        await settle('idle');
        const plainStart = performance.now();
        render.restart();
        await render.converge({ samples: 64, timeoutMs: 60000 });
        const plainSpp = 64 / (performance.now() - plainStart) * 1000;
        const shared = await sharing(backend, () => compiles);
        return { backend, shared, driverFailure, driverFailurePixel, retryPixel, retryCompiles, initialCompiles: initial, parameterCompiles, parameterPixel, revisions, installed, structureCompiles, structureMs, pendingFrames, maximumPendingSamples, samplesAtStart, obsoleteInstalled, structurePixel, failure, failurePixel, cacheMs, cacheCompiles, cachePixel, graphSpp, plainSpp,
            passed: driverFailure?.diagnostics[0]?.code === 'shader-compilation' && driverFailurePixel === cachePixel && Math.abs(retryPixel-0.35)<0.001 && shared.topologies === 19 && parameterCompiles === 0 && Math.abs(parameterPixel - 0.3) < 0.001 && installed === last && !obsoleteInstalled && Math.abs(structurePixel - 0.2) < 0.001 && failure?.status === 'failed' && failure.diagnostics[0]?.code === 'unsupported-node' && failurePixel === stable && cacheCompiles === 0 && Math.abs(cachePixel - 0.9) < 0.001 && pendingFrames > 1 && maximumPendingSamples > 1 };
    }
    finally {
        render.dispose();
        engine.dispose();
        prototype.createComputePipelineAsync = original;
    }
}
Object.assign(window, { runBenchmark: run });
