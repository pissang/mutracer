// Fixed-seed scenes authored by the same GLTFLoader/THREESync used by WebEngine.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { Engine, Render, THREESync, MaterialGraph, Texture, RectLight, EnvironmentLight, OpenPBRMaterial } from '../../src/main';
import { NativeSceneEncoder } from '../../viewer/src/engine/nativeScene';
import { parseMaterialXGraph } from '../../viewer/src/engine/materialxGraph';
const save = async (name: string, body: BodyInit) => { const r = await fetch('/evidence/' + name, { method: 'POST', body }); if (!r.ok)
    throw Error('Evidence write failed'); };
async function run() {
    const params = new URLSearchParams(location.search);
    const samples = Number(params.get("spp") ?? 16);
    if (!Number.isInteger(samples) || samples < 1 || samples > 16384) throw Error("SPP must be 1..16384");
    const backend = params.has("webgl") ? "webgl" : "webgpu";
    const canvas = document.querySelector('canvas')!;
    canvas.width = 96;
    canvas.height = 64;
    const source = new THREE.Scene(), camera = new THREE.PerspectiveCamera(35, 1.5, .01, 1000);
    camera.position.set(3, 2, 5);
    camera.lookAt(0, 0, 0);
    const gltf = await new GLTFLoader().loadAsync('/examples/assets/chess.glb');
    source.add(gltf.scene);
    const box = new THREE.Box3().setFromObject(gltf.scene), center = box.getCenter(new THREE.Vector3()), radius = box.getBoundingSphere(new THREE.Sphere()).radius;
    camera.position.copy(center).add(new THREE.Vector3(1, .65, 1.6).normalize().multiplyScalar(radius * 3));
    camera.lookAt(center);
    const engine = new Engine({ canvas, backend }), sync = new THREESync(engine, { scene: source, camera });
    sync.update();
    const env = new Texture({ width: 2, height: 2, data: new Float32Array([2, .5, .2, 1, .2, 1, 3, 1, .05, .1, .2, 1, 1, 1, 1, 1]) });
    const light = new RectLight({ size: [radius * 2, radius * 2], intensity: 2 });
    light.position = [center.x + radius, center.y + radius * 2, center.z + radius];
    light.lookAt([center.x, center.y, center.z]);
    engine.scene!.lights = [new EnvironmentLight({ map: env }), light];
    engine.scene!.background = [.05, .05, .05, 1];
    const render = new Render(engine, { width: 96, height: 64, maxSamples: samples, bounces: 3, samplingPattern: 'sobol', denoiser: null });
    const cases = ['gltf', 'materialx', 'hdr-studio', 'denoised'];
    const results = [];
    for (const name of cases) {
        if (name === 'materialx') {
            const imported = parseMaterialXGraph(`<?xml version="1.0"?><materialx version="1.39"><constant name="paint" type="color3"><input name="value" type="color3" value="0.15,0.45,0.75"/></constant><noise3d name="noise" type="float"/><open_pbr_surface name="surface" type="surfaceshader"><input name="base_color" type="color3" nodename="paint"/><input name="specular_roughness" type="float" nodename="noise"/></open_pbr_surface><surfacematerial name="paint_material" type="material"><input name="surfaceshader" type="surfaceshader" nodename="surface"/></surfacematerial></materialx>`);
            if (!imported.graph)
                throw Error('MaterialX fixture did not produce a graph');
            engine.scene!.meshes[0].materials[0].graph = imported.graph;
        }
        if (name === 'hdr-studio')
            engine.scene!.background = env;
        if (name === 'denoised')
            await render.setDenoiser({ type: 'oidn', model: 'standard', schedule: 'converged', weightsBaseUrl: new URL('/oidn/weights/', location.href).href });
        engine.update();
        await render.converge({ samples });
        const encoder = new NativeSceneEncoder(async () => { throw Error('No sky in fixture'); });
        const words = await encoder.encode(engine.scene!, engine.camera!, [96, 64]);
        await save(name + '.bin', new Uint8Array(words.buffer));
        for (const kind of ['hdr', 'normal', 'albedo', 'denoised'] as const) {
            const image = await render.readPixels(kind);
            await save(name + '-' + kind + '.f32', new Uint8Array(image.data.buffer));
            // These silhouette pixels have only a few geometry hits. UNORM8
            // coverage used to round to zero and leave sum/hits in HDR readback.
            if (kind === 'hdr' && samples >= 1024 && (name === 'gltf' || name === 'materialx')) {
                for (const [x, y] of [[24, 27], [74, 34], [74, 50]]) {
                    const rgb = image.data.subarray((y * 96 + x) * 4, (y * 96 + x) * 4 + 3);
                    if (!rgb.every(v => Number.isFinite(v) && v >= 0 && v < .2))
                        throw Error(`Unnormalized background at ${x},${y}: ${Array.from(rgb)}`);
                }
            }
        }
        await save(name + '.png', await engine.display.toBlob(render));
        results.push({ name, samples: render.samples, width: render.width, height: render.height });
    }
    render.dispose();
    sync.dispose();
    engine.dispose();
    await save('browser.json', JSON.stringify(results, null, 2));
    return results;
}
(window as unknown as {
    runBenchmark: typeof run;
}).runBenchmark = run;
