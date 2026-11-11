// Both import paths use the viewer's material conversion and scene-light metadata.
import * as THREE from 'three';
import { fromTHREEScene, fromTHREECamera, EnvironmentLight, Texture } from '../../src/main';
import Camera from '../../src/scene/Camera';
import { buildNativeGltf, type NativeGltfManifest } from '../../viewer/src/engine/nativeGltf';
import { loadModelFromURL } from '../../viewer/src/engine/loadModel';
import { hostMaterials, hostThreeGeometries } from '../../viewer/src/engine/nativeResources';
import { NativeSceneEncoder } from '../../viewer/src/engine/nativeScene';
import { readModelCamera } from '../../viewer/src/engine/modelCamera';
import { groundModel } from '../../viewer/src/engine/modelGrounding';
import { SceneChangeDetector } from '../../src/renderer/sceneChangeDetector';
const save = async (name: string, body: BodyInit) => {
    const chunkSize = 32 * 1024 * 1024;
    if (body instanceof Uint8Array && body.byteLength > chunkSize) {
        for (let offset = 0; offset < body.byteLength; offset += chunkSize) {
            const response = await fetch('/evidence/' + name, { method: 'POST', headers: { 'x-mutracer-offset': String(offset) }, body: body.subarray(offset, offset + chunkSize) });
            if (!response.ok)
                throw Error('Evidence write failed');
        }
    }
    else {
        const response = await fetch('/evidence/' + name, { method: 'POST', body });
        if (!response.ok)
            throw Error('Evidence write failed');
    }
};
async function run(out: string, path: string, nativeOnly=false) {
    const manifest: NativeGltfManifest = await (await fetch('/@fs/' + out + '/manifest.json')).json();
    const native = await buildNativeGltf(manifest, { mainPath: path, base: '', files: [] }, await (await fetch('/@fs/' + out + '/compact.bin')).arrayBuffer(), async (uri) => { const response = await fetch(new URL(uri, location.origin + '/@fs/' + path)); if (!response.ok)
        throw Error('Missing environment'); return response.arrayBuffer(); }, () => { });
    const web = nativeOnly?native:await loadModelFromURL('/@fs/' + path, () => { });
    for (const model of new Set([web, native]))
        if (model.lighting?.warnings.length)
            throw Error('Incomplete import: ' + model.lighting.warnings.join(' '));
    for (const model of new Set([web, native])) {
        if (model.groundOffset)
            model.root.position.sub(new THREE.Vector3(...model.groundOffset));
        else
            groundModel(model.root);
        model.root.updateMatrixWorld(true);
    }
    const box = new THREE.Box3().setFromObject(web.root), center = box.getCenter(new THREE.Vector3()), radius = box.getBoundingSphere(new THREE.Sphere()).radius;
    const cameraFor = (model: typeof web) => {
        const curated = readModelCamera(model.root.userData.mutracerCamera);
        if (curated) {
            const camera = new Camera({ projection: 'perspective', fov: curated.fov });
            camera.position = curated.position;
            camera.lookAt(curated.target);
            return camera;
        }
        let authored: THREE.PerspectiveCamera | THREE.OrthographicCamera | undefined;
        model.root.traverse(object => { if (!authored && ((object as THREE.PerspectiveCamera).isPerspectiveCamera || (object as THREE.OrthographicCamera).isOrthographicCamera))
            authored = object as THREE.PerspectiveCamera; });
        if (authored)
            return fromTHREECamera(authored, { fStop: 0 });
        const camera = new Camera({ projection: 'perspective', fov: 35, near: .01, far: 1e6 });
        camera.position = center.clone().add(new THREE.Vector3(1, .65, 1.6).normalize().multiplyScalar(radius * 2.5)).toArray();
        camera.lookAt(center.toArray());
        return camera;
    };
    const env = new EnvironmentLight({ map: new Texture({ width: 2, height: 1, data: new Float32Array([1, .7, .5, 1, .3, .6, 1, 1]) }) });
    const results = [];
    for (const [name, model] of (nativeOnly?[['native-ui',native] as const]:[['web',web] as const,['native-ui',native] as const])) {
        model.root.updateMatrixWorld(true);
        const root = new THREE.Scene();
        root.add(model.root);
        const names = new Map<object, string>();
        const scene = fromTHREEScene(root, { convertMaterial: source => hostMaterials.get(source), onMeshConverted: (mesh, source, group) => { const sourceMaterial = Array.isArray(source.material) ? source.material[group.materialIndex ?? 0] : source.material; names.set(mesh.materials[0], sourceMaterial.name); const nativeGeometry = hostThreeGeometries.get(source.geometry); if (nativeGeometry)
                mesh.geometry = nativeGeometry.geometry; } });
        const lighting = model.lighting;
        if (lighting?.available) {
            scene.lights.push(new EnvironmentLight({ map: new Texture(lighting.environment ?? { width: 1, height: 1, data: new Float32Array([0, 0, 0, 1]) }) }));
        }
        else
            scene.lights.push(env);
        scene.background = [.05, .05, .05, 1];
        const camera = cameraFor(model);
        const encoder = new NativeSceneEncoder(async () => { throw Error('Unexpected sky'); });
        await save(name + '.bin', new Uint8Array((await encoder.encode(scene, camera, [96, 64])).buffer));
        const encoded = await encoder.prepare(scene, camera, [96, 64], new SceneChangeDetector().detect(scene));
        if (name === 'native-ui')
            await save('refs.json', JSON.stringify(encoded.refs));
        results.push({ name, meshes: scene.meshes.length, materials: new Set(scene.meshes.flatMap(m => m.materials)).size, materialNames: [...new Set(scene.meshes.flatMap(m => m.materials))].map(material => names.get(material)), warnings: model.lighting?.warnings, camera: { matrix: camera.transform, fov: camera.fov, projection: camera.projection }, environment: model.lighting?.environment ? { width: model.lighting.environment.width, height: model.lighting.environment.height } : null });
        model.revoke();
    }
    await save('browser.json', JSON.stringify(results, null, 2));
    return results;
}
(window as unknown as {
    runBenchmark: typeof run;
}).runBenchmark = run;
