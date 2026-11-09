import { Engine, Render, AmbientLight, SphereLight, Camera, Mesh, OpenPBRMaterial, MaterialGraph, Texture, UdimTexture, createPlaneGeometry } from '../../src/main.js';
const pause = () => new Promise(resolve => setTimeout(resolve, 10));
async function run() {
    const backend = 'webgpu';
    const results = [];
    const solid = (rgb: number[]) => ({ width: 4, height: 4, data: new Float32Array(Array.from({ length: 16 }, () => [...rgb, 1]).flat()) });
    const normalMap = new Texture(solid([0.75, 0.5, 1]));
    normalMap.colorSpace = 'linear';
    const udim = new UdimTexture([{ udim: 1001, image: solid([0.8, 0.2, 0.1]) }, { udim: 1002, image: solid([0.1, 0.7, 0.3]) }]);
    udim.colorSpace = 'linear';
    const normalGraph = new MaterialGraph({ nodes: [{ id: 'normal', category: 'normalmap', type: 'vector3', inputs: { in: { type: 'vector3', value: [0.75, 0.5, 1] }, scale: { type: 'float', value: 0.6 } } }], terminal: { geometryNormal: { node: 'normal' } } });
    const udimGraph = new MaterialGraph({ nodes: [{ id: 'image', category: 'tiledimage', type: 'color3', inputs: { file: { type: 'filename', value: udim } } }], terminal: { emissionColor: { node: 'image' } } });
    const anisotropy = (port:string) => new MaterialGraph({nodes:[{id:'a',category:'constant',type:'float',inputs:{value:{type:'float',value:0.6}}}],terminal:{[port]:{node:'a'}}});
    const cases=[
        {name:'lit-normal-terminal',graph:normalGraph,kind:'normal',coat:0},
        {name:'lit-coat-normal-terminal',graph:normalGraph,kind:'normal',coat:0.5},
        {name:'specular-anisotropy-terminal',graph:anisotropy('specularRoughnessAnisotropy'),kind:'specular',coat:0},
        {name:'coat-anisotropy-terminal',graph:anisotropy('coatRoughnessAnisotropy'),kind:'coat',coat:0.5},
        {name:'udim-existing-path',graph:udimGraph,kind:'udim',coat:0}
    ];
    for (const test of cases) {
        const engine = new Engine({ backend, canvas: document.createElement('canvas') });
        engine.display.setSize(64, 32);
        const material = new OpenPBRMaterial(test.kind!=='udim' ? { baseColor: [0.7, 0.4, 0.2], specularRoughness: 0.4, baseMetalness:test.kind==='specular'?1:0, coatWeight:test.coat??0, coatRoughness:0.2, graph: test.graph } : { unlit: true, emissionColor: [1, 1, 1], emissionLuminance: 1, graph: test.graph });
        const geometry = createPlaneGeometry(1, 1, 'vertical');
        if (test.kind==='udim')
            for (let i = 0; i < geometry.uv!.array.length; i += 2)
                geometry.uv!.array[i] *= 2;
        if(test.kind==='specular'||test.kind==='coat')for(let i=0;i<geometry.uv!.array.length;i+=2){const u=geometry.uv!.array[i]-0.5,v=geometry.uv!.array[i+1]-0.5;geometry.uv!.array[i]=(u-v)*Math.SQRT1_2+0.5;geometry.uv!.array[i+1]=(u+v)*Math.SQRT1_2+0.5;}
        const camera = new Camera({ projection: 'orthographic', left: -1, right: 1, top: 1, bottom: -1 });
        camera.position = [0, 0, 3];
        camera.lookAt([0, 0, 0]);
        const point = new SphereLight({radius:0,intensity:8});point.position=[2,1,3];
        engine.scene = { meshes: [new Mesh(geometry, material)], lights: test.kind==='udim'?[]:[new AmbientLight({intensity:0.15}),point], background: [0.7, 0.8, 1, 1] };
        engine.camera = camera;
        const render = new Render(engine, { bounces: 3, directLightCandidates: 1, samplingPattern: 'sobol', maxSamples: 1 });
        const settle = async () => { const start = performance.now(); engine.update(); for (;;) {
            render.refine();
            await pause();
            const state = engine.getDiagnostics()?.materialGraphs;
            if (state?.status === 'failed')
                throw new Error(JSON.stringify(state));
            if (state?.status !== 'compiling' && render.samples >= 1)
                break;
            if (performance.now() - start > 60000)
                throw new Error('capped graph timeout');
        } render.restart(); await render.converge({ samples: 16, sampleSequenceOffset: 0, timeoutMs: 60000 }); };
        try {
            await settle();
            const graphImage = await render.readPixels('hdr');
            const graph = graphImage.data.slice();
            material.graph = undefined;
            if (test.kind==='normal') {
                material.normalMap = normalMap;
                material.normalScale = [0.6, 0.6];
            }
            else if(test.kind==='specular') material.specularAnisotropy=0.6;
            else if(test.kind==='coat') material.coatAnisotropy=0.6;
            else material.emissiveMap = udim;
            await settle();
            const reference = (await render.readPixels('hdr')).data;
            await fetch(`/evidence/${backend}-${test.name}-reference.f32`, { method: 'POST', body: reference });
            const rgb=Array.from(graph).filter((_,i)=>i%4<3);
            const center=(Math.floor(graphImage.height/2)*graphImage.width+Math.floor(graphImage.width/2))*4;
            if(!graph.slice(center,center+3).some(v=>v>0.01))throw new Error(test.name+': all-black graph image');
            let maxError = 0;
            for (let i = 0; i < graph.length; i++)
                maxError = Math.max(maxError, Math.abs(graph[i] - reference[i]));
            await fetch(`/evidence/${backend}-${test.name}.f32`, { method: 'POST', body: graph });
            results.push({ name: test.name, maxError, maxRadiance:Math.max(...rgb), passed: maxError < 0.002, cappedProgress: true });
        }
        finally {
            render.dispose();
            engine.dispose();
        }
    }
    return { backend, results, passed: results.every(r => r.passed) };
}
Object.assign(window, { runBenchmark: run });
