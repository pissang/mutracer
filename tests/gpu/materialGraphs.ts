import { Engine, Render, Camera, Mesh, OpenPBRMaterial, MaterialGraph, Texture, UdimTexture, createPlaneGeometry } from '../../src/main.js';
import type { MaterialGraphNode as Node, MaterialGraphInput as Input, MaterialGraphType as Type } from '../../src/main.js';
import { normalizeGraph } from '../../src/renderer/materialGraph/normalize.js';
import { evaluateGraph } from '../../src/renderer/materialGraph/evaluate.js';
import { generateGraph } from '../../src/renderer/materialGraph/codegen.js';
const wait = () => new Promise(resolve => setTimeout(resolve, 10));
const f = (value: number): Input => ({ type: 'float', value });
const v = (value: number[], type?: Type): Input => ({ type: type ?? (value.length === 2 ? 'vector2' : 'vector3'), value });
const edge = (node: string, type: Type = 'float', output = 'out'): Input => ({ type, connection: { node, output } });
const uv = [0.37, 0.61], normal = [0, 0, 1];
function testGraph(category: string, inputs: Record<string, Input> = {}, type: Type = 'float') {
    const nodes: Node[] = [{ id: 'uv', category: 'texcoord', type: 'vector2' }, { id: 'separate', category: 'separate2', type: 'vector2', inputs: { in: edge('uv', 'vector2') } }, { id: 'node', category, type, inputs }];
    const result = category.startsWith('separate') ? edge('node', 'float', type.startsWith('color') ? 'outr' : 'outx') : edge('node', type);
    nodes.push({ id: 'out', category: 'convert', type: 'color3', inputs: { in: result } });
    return new MaterialGraph({ nodes, terminal: { emissionColor: { node: 'out' } } });
}
const dynamic = edge('separate', 'float', 'outx');
function cases() {
    const rows: {
        name: string;
        graph: MaterialGraph;
        sample?: (texture: Texture, uv: number[]) => number[];
    }[] = [];
    const add = (name: string, category: string, inputs: Record<string, Input> = {}, type: Type = 'float') => rows.push({ name, graph: testGraph(category, inputs, type) });
    add('constant', 'constant', { value: f(0.3) });
    for (const c of ['add', 'subtract', 'multiply', 'divide', 'modulo', 'power', 'min', 'max'])
        add(c, c, { in1: dynamic, in2: f(c === 'subtract' ? 0.1 : c === 'modulo' ? 0.25 : 0.8) });
    for (const c of ['abs', 'floor', 'ceil', 'round', 'sin', 'cos', 'sqrt', 'exp', 'ln', 'sign'])
        add(c, c, { in: dynamic });
    for(const category of ['ramplr','ramptb','ramp4','splitlr','splittb'])add(category,category,{...((category==='ramplr'||category==='splitlr')?{valuel:f(0.2),valuer:f(0.9)}:(category==='ramptb'||category==='splittb')?{valuet:f(0.2),valueb:f(0.9)}:{valuetl:f(0.1),valuetr:f(0.4),valuebl:f(0.8),valuebr:f(0.2)}),texcoord:edge('uv','vector2')});
    for(const c of ['burn','dodge','screen','overlay','difference','plus','minus'])add(c,c,{fg:dynamic,bg:f(0.7),mix:f(0.8)});
    for(const category of ['noise2d','noise3d','fractal3d','cellnoise2d','cellnoise3d','worleynoise2d','worleynoise3d']){
        const types:Type[]=category.startsWith('cell')?['float']:category.startsWith('worley')?['float','vector2','vector3']:['float','vector2','vector3','vector4'];
        for(const type of types){
            const graph=testGraph(category,category.endsWith('2d')?{texcoord:edge('uv','vector2')}:{position:edge('pos','vector3')},type);
            graph.setNode({id:'pos',category:'convert',type:'vector3',inputs:{in:edge('uv','vector2')}});
            if(!category.startsWith('cell')&&!category.startsWith('worley'))graph.setInput('node','pivot',f(0.5));
            if(category==='fractal3d')graph.setNode({...graph.nodes.find(n=>n.id==='node')!,inputs:{position:edge('pos','vector3'),octaves:{type:'integer',value:3}}});
            rows.push({name:category+'-'+type,graph});
        }
    }
    add('dot','dot',{in:dynamic,note:{type:'string',value:'annotation'}});
    add('extract','extract',{in:edge('uv','vector2'),index:{type:'integer',value:1}});
    add('invert','invert',{in:dynamic});
    add('remap','remap',{in:dynamic,inlow:f(0.1),inhigh:f(0.8),outlow:f(0.2),outhigh:f(0.9)});
    add('range','range',{in:dynamic,gamma:f(2),doclamp:{type:'boolean',value:true}});
    add('smoothstep','smoothstep',{in:dynamic,low:f(0.1),high:f(0.8)});
    add('contrast','contrast',{in:dynamic,amount:f(1.3),pivot:f(0.2)});
    add('atan2','atan2',{iny:dynamic,inx:f(0.8)});
    for(const c of ['tan','asin','acos'])add(c,c,{in:dynamic});
    add('rotate2d','rotate2d',{in:edge('uv','vector2'),amount:f(25)},'vector2');
    for(const c of ['rotate3d','transformpoint','transformvector','transformnormal','luminance']){
        const graph=testGraph(c,{in:edge('color',c==='luminance'?'color3':'vector3'),...(c==='rotate3d'?{amount:f(25),axis:v([0,0,2])}:{})},c==='luminance'?'color3':'vector3');
        graph.setNode({id:'color',category:'convert',type:c==='luminance'?'color3':'vector3',inputs:{in:edge('uv','vector2')}});
        rows.push({name:c,graph});
    }
    const lumaAlpha=testGraph('extract',{in:edge('luma','color4'),index:{type:'integer',value:3}});
    lumaAlpha.setNode({id:'luma',category:'luminance',type:'color4',inputs:{in:edge('rgba','color4')}}).setNode({id:'rgba',category:'combine4',type:'color4',inputs:{in1:f(0.2),in2:f(0.4),in3:f(0.6),in4:dynamic}});
    rows.push({name:'luminance-alpha',graph:lumaAlpha});
    add('mix', 'mix', { bg: dynamic, fg: f(0.8), mix: f(0.4) });
    add('clamp', 'clamp', { in: dynamic, low: f(0.1), high: f(0.3) });
    for (const c of ['ifgreater', 'ifequal'])
        add(c, c, { value1: dynamic, value2: f(0.3), in1: f(0.8), in2: f(0.2) });
    add('texcoord', 'texcoord', {}, 'vector2');
    add('place2d-SRT', 'place2d', { texcoord: edge('uv', 'vector2'), pivot: v([0.1, 0.2]), scale: v([1.2, 0.9]), rotate: f(20), offset: v([0.05, 0.03]) }, 'vector2');
    add('place2d-TRS', 'place2d', { texcoord: edge('uv', 'vector2'), pivot: v([0.1, 0.2]), scale: v([1.2, 0.9]), rotate: f(20), offset: v([0.05, 0.03]), operationorder: { type: 'integer', value: 1 } }, 'vector2');
    add('convert', 'convert', { in: dynamic }, 'color4');
    add('separate3', 'separate3', { in: v([0.2, 0.4, 0.6], 'color3') }, 'color3');
    add('separate4', 'separate4', { in: v([0.2, 0.4, 0.6, 0.8], 'vector4') }, 'vector4');
    for (const n of [2, 3, 4])
        add(`combine${n}`, `combine${n}`, Object.fromEntries(Array.from({ length: n }, (_, i) => [`in${i + 1}`, i === 0 ? dynamic : f(0.2 + i * 0.1)])), `vector${n}` as Type);
    add('normalize', 'normalize', { in: edge('uv', 'vector2') }, 'vector2');
    add('dotproduct', 'dotproduct', { in1: edge('uv', 'vector2'), in2: v([0.2, 0.3]) });
    add('crossproduct', 'crossproduct', { in1: v([1, 0, 0]), in2: v([0, 0.5, 0]) }, 'vector3');
    for (const c of ['normal', 'tangent', 'bitangent', 'position']) {
        const graph = testGraph(c, { space: { type: 'string', value: 'world' } }, 'vector3');
        if (c === 'position')
            graph.setNode({ id: 'node', category: 'dotproduct', type: 'float', inputs: { in1: edge('position', 'vector3'), in2: v([0, 0, 1]) } }).setNode({ id: 'position', category: 'position', type: 'vector3', inputs: { space: { type: 'string', value: 'world' } } }).setNode({ id: 'out', category: 'convert', type: 'color3', inputs: { in: edge('node') } });
        rows.push({ name: c, graph });
    }
    for (const category of ['rgbtohsv', 'hsvtorgb']) {
        const graph = testGraph(category, {in: edge('color', 'color3')}, 'color3');
        graph.setNode({id:'color',category:'combine3',type:'color3',inputs:{in1:edge('separate','float','outx'),in2:edge('separate','float','outy'),in3:f(0.8)}});
        rows.push({name:category,graph});
    }
    for (const n of [3,4]) {
        const graph = testGraph(`separate${n}`, {in:edge('color',`color${n}` as Type)}, `color${n}` as Type);
        graph.setNode({id:'color',category:'convert',type:`color${n}` as Type,inputs:{in:edge('uv','vector2')}});
        rows.push({name:`dynamic-separate${n}`,graph});
    }
    const cross = testGraph('crossproduct', {in1:edge('color','vector3'),in2:v([0.2,0.3,0.4])},'vector3');
    cross.setNode({id:'color',category:'convert',type:'vector3',inputs:{in:edge('uv','vector2')}});
    rows.push({name:'dynamic-crossproduct',graph:cross});
    add('normalmap', 'normalmap', { in: v([0.75, 0.5, 1]), scale: f(0.6) }, 'vector3');
    const image = { width: 2, height: 2, data: new Float32Array([0.2, 0.4, 0.6, 1, 0.2, 0.4, 0.6, 1, 0.2, 0.4, 0.6, 1, 0.2, 0.4, 0.6, 1]) };
    const texture = new Texture(image);
    texture.colorSpace = 'linear';
    for (const category of ['image', 'tiledimage','gltf_image','gltf_normalmap'])
        rows.push({ name: category, graph: testGraph(category, { file: { type: 'filename', value: texture } }, category==='gltf_normalmap'?'vector3':'color3'), sample: () => [0.2, 0.4, 0.6, 1] });
    const gltfColor=testGraph('gltf_colorimage',{file:{type:'filename',value:texture}},'color4');gltfColor.setNode({id:'out',category:'convert',type:'color3',inputs:{in:edge('node','color3','outcolor')}});rows.push({name:'gltf_colorimage',graph:gltfColor,sample:()=>[0.2,0.4,0.6,1]});
    const udim = new UdimTexture([{ udim: 1001, image }, { udim: 1002, image: { ...image, data: image.data.map((v, i) => i % 4 === 0 ? 0.8 : v) } }]);
    udim.colorSpace = 'linear';
    rows.push({ name: 'tiledimage-UDIM', graph: testGraph('tiledimage', { file: { type: 'filename', value: udim }, uvoffset: v([-1, 0]) }, 'color3'), sample: () => [0.8, 0.4, 0.6, 1] });
    const nodes: Node[] = [{ id: 'uv', category: 'texcoord', type: 'vector2' }, { id: 's', category: 'separate2', type: 'vector2', inputs: { in: edge('uv', 'vector2') } }];
    const count=Number(new URLSearchParams(location.search).get('chain')??26);
    for (let i = 0; i < count; i++)
        nodes.push({ id: `n${i}`, category: i % 2 ? 'multiply' : 'add', type: 'float', inputs: { in1: edge(i ? `n${i - 1}` : 's', 'float', i ? 'out' : 'outx'), in2: f(i % 2 ? 0.95 : 0.02) } });
    nodes.push({ id: 'out', category: 'convert', type: 'color3', inputs: { in: edge(`n${count-1}`) } });
    rows.push({ name: `${count+3}-node-chain`, graph: new MaterialGraph({ nodes, terminal: { emissionColor: { node: 'out' } } }) });
    return rows;
}
async function run() {
    const backend = location.search.includes('webgl') ? 'webgl' : 'webgpu', engine = new Engine({ backend, canvas: document.createElement('canvas') });
    engine.display.setSize(24, 24);
    const material = new OpenPBRMaterial({ unlit: true, emissionColor: [0.2, 0.4, 0.6], emissionLuminance: 1 });
    const geometry = createPlaneGeometry(1, 1, 'vertical');
    for (let i = 0; i < geometry.uv!.array.length; i += 2)
        geometry.uv!.array.set(uv, i);
    const mesh = new Mesh(geometry, material), camera = new Camera({ projection: 'orthographic', left: -1, right: 1, top: 1, bottom: -1 });
    camera.position = [0, 0, 3];
    camera.lookAt([0, 0, 0]);
    engine.scene = { meshes: [mesh], lights: [] };
    engine.camera = camera;
    const render = new Render(engine, { bounces: 1, samplingPattern: 'sobol' });
    const rows: unknown[] = [];
    const settle = async (graph: boolean) => {
        const start = performance.now();
        engine.update();
        await render.converge({ samples: 1, timeoutMs: 90000 });
        while (graph ? engine.getDiagnostics()?.materialGraphs?.status !== 'ready' : engine.getDiagnostics()?.materialGraphs?.status === 'compiling') {
            if (engine.getDiagnostics()?.materialGraphs?.status === 'failed')
                throw new Error(JSON.stringify(engine.getDiagnostics()?.materialGraphs));
            if (performance.now() - start > 90000)
                throw new Error('Graph timeout ' + JSON.stringify(engine.getDiagnostics()));
            render.refine();
            await wait();
        }
        render.restart();
        await render.converge({ samples: 4, sampleSequenceOffset: 0, timeoutMs: 90000 });
        return performance.now() - start;
    };
    try {
        await settle(false);
        const selected = cases();
        const assetsUrl=new URLSearchParams(location.search).get('assets');
        if (assetsUrl) {
            const assets = await (await fetch(assetsUrl)).json();
            selected.length = 0;
            for (const asset of assets) {
                for (const node of asset.nodes)
                    for (const input of Object.values(node.inputs ?? {}) as Input[])
                        if (input.type === 'filename') {
                            const normal = String(input.value).includes('normal'), rgba = normal ? [0.5, 0.5, 1, 1] : [0.2, 0.4, 0.6, 1];
                            const texture = new Texture({ width: 2, height: 2, data: new Float32Array([...rgba, ...rgba, ...rgba, ...rgba]) });
                            texture.colorSpace = 'linear';
                            input.value = texture;
                        }
                selected.push({ name: asset.name, graph: new MaterialGraph(asset), sample: (texture: Texture) => Array.from((texture.image as any).data.slice(0, 4)) });
            }
        }
        const filter = new URLSearchParams(location.search).get('filter');
        for (const test of selected.filter(test => !filter || new RegExp(filter).test(test.name))) {
            const graph = normalizeGraph(test.graph, backend);
            if (graph.diagnostics.length)
                throw new Error(test.name + JSON.stringify(graph.diagnostics));
            const expected = evaluateGraph(graph, { uv, uv1: [0, 0], normal, tangent: [1, 0, 0], bitangent: [0, 1, 0], position: [0, 0, 0], sample: test.sample }).emissionColor;
            const start = performance.now(), generated = generateGraph(graph, backend), codegenMs = performance.now() - start;
            material.graph = test.graph;
            let lastBeat=performance.now(),maxEventLoopGapMs=0;const heartbeat=setInterval(()=>{const now=performance.now();maxEventLoopGapMs=Math.max(maxEventLoopGapMs,now-lastBeat);lastBeat=now;},10);
            const firstMs = await settle(true);maxEventLoopGapMs=Math.max(maxEventLoopGapMs,performance.now()-lastBeat);const maxCompileEventLoopGapMs=maxEventLoopGapMs;
            const diagnostics = engine.getDiagnostics(), pixels = (await render.readPixels('hdr')).data.slice();
            maxEventLoopGapMs=Math.max(maxEventLoopGapMs,performance.now()-lastBeat);clearInterval(heartbeat);
            material.graph = undefined;
            material.emissionColor = expected as [
                number,
                number,
                number
            ];
            await settle(false);
            const reference = (await render.readPixels('hdr')).data;
            await fetch(`/evidence/${backend}-${test.name}-reference.f32`, { method: 'POST', body: reference });
            let maxError = 0, finite = true;
            for (let i = 0; i < pixels.length; i++) {
                maxError = Math.max(maxError, Math.abs(pixels[i] - reference[i]));
                finite &&= Number.isFinite(pixels[i]);
            }
            await fetch(`/evidence/${backend}-${test.name}.f32`, { method: 'POST', body: pixels });
            const row = { name: test.name, nodes: graph.nodes.length, hash: graph.hash, codegenMs, generatedBytes: generated.source.length, firstMs, maxCompileEventLoopGapMs, maxEventLoopGapMs, expected, maxError, finite, passed: finite && maxError < 0.003, shader: diagnostics?.shaderCompilation, compilation: diagnostics?.materialGraphs?.compilation };
            rows.push(row);
            await fetch(`/evidence/${backend}-matrix-partial.json`, { method: 'POST', body: JSON.stringify(rows, null, 2) });
        }
        return { backend, rows, passed: rows.every((row: any) => row.passed) };
    }
    finally {
        render.dispose();
        engine.dispose();
    }
}
Object.assign(window, { runBenchmark: run });
