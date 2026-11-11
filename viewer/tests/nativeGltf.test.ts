import { describe, it, expect } from 'vitest';
import { Camera, Geometry, Mesh, OpenPBRMaterial, Texture, fromTHREEScene } from '../../src/main';
import { Attribute } from '../../src/scene/Geometry';
import { SceneChangeDetector } from '../../src/renderer/sceneChangeDetector';
import * as THREE from 'three';
import { NativeSceneEncoder } from '../src/engine/nativeScene';
import { buildNativeGltf, type NativeGltfManifest } from '../src/engine/nativeGltf';
import { HEADER as H } from '../../native/src/layout';
import { hostGeometries, hostThreeGeometries, hostMaterials, hostTextures } from '../src/engine/nativeResources';
const encoder = () => new NativeSceneEncoder(async () => { throw Error('unexpected sky'); });
describe('native glTF scene manifest', () => {
    it('keeps geometry and images native while preserving hierarchy, camera, material edits and resource references', async () => {
        const geometry = new Geometry({ position: new Attribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3) });
        const material = new OpenPBRMaterial({ emissionColor: [.1, .2, .3], emissionLuminance: 4, baseColor: [.2, .4, .6], map: new Texture({ width: 1, height: 1, data: new Uint8Array([255, 255, 255, 255]) }) });
        const sourceMesh = new Mesh(geometry, material);
        sourceMesh.position = [1, 2, 0];
        const descriptor = await encoder().encode({ meshes: [sourceMesh], lights: [] }, new Camera({ projection: 'perspective' }), [1, 1]);
        // Native import leaves scene lighting to the shared viewer rather than adding an environment texture.
        descriptor[H.TEXTURE_COUNT] = 1;
        descriptor[H.ENVIRONMENT_TEXTURE] = 0;
        descriptor[H.BACKGROUND_TEXTURE] = 0;
        const manifest: NativeGltfManifest = { id: 7, descriptor: 'unused', groundOffset: [1, -2, 3], warnings: [],
            document: { extras: { pbrt: { light_sources: [] } }, asset: { version: '2.0' }, materials: [{ alphaMode: 'BLEND', extras: { mutracerOpenPBR: { thinWalled: true, specularColor: [.2, .3, .4] } } }], nodes: [{ name: 'Parent', translation: [1, 0, 0], children: [1, 2] }, { name: 'Object', translation: [0, 2, 0], mesh: 0 }, { name: 'View', camera: 0, extensions:{KHR_lights_punctual:{light:0}}, translation: [0, 0, 5] }], extensions:{KHR_lights_punctual:{lights:[{type:'point',intensity:2}]}}, cameras: [{ type: 'perspective', perspective: { yfov: Math.PI / 4, znear: .01, zfar: 100 } }], scenes: [{ nodes: [0] }], scene: 0 },
            materialNames: ['Paint'], meshes: [{ node: 1, name: 'Triangle', geometry: 0, material: 0, first: 0, count: 1 }],
            geometries: [{ min: [0, 0, 0], max: [1, 1, 0], vertices: 3000000, indices: 3000000, uv: true, uv1: false }],
            textures: [{ width: 4096, height: 2048, storage: 0, preview: { width: 1, height: 1, data: [255, 0, 0, 255] } }] };
        let released = false;
        const model = await buildNativeGltf(manifest, { hostPath: '/scene.glb', files: [], mainPath: 'scene.glb', base: '' }, descriptor.buffer, async () => { throw Error('unexpected resource'); }, () => { released = true; });
        const mesh = model.root.getObjectByName('Triangle') as THREE.Mesh;
        expect(mesh.getWorldPosition(new THREE.Vector3()).toArray()).toEqual([1, 2, 0]);
        expect(mesh.parent?.name).toBe('Object');
        expect(mesh.geometry.boundingBox?.max.toArray()).toEqual([1, 1, 0]);
        const camera = model.root.getObjectsByProperty('isPerspectiveCamera',true)[0] as THREE.PerspectiveCamera;
        expect(model.root.getObjectsByProperty('isPointLight',true)).toHaveLength(1);
        expect(camera.getWorldPosition(new THREE.Vector3()).toArray()).toEqual([1,0,5]);
        expect(camera.fov).toBeCloseTo(45);
        expect(camera.near).toBe(.01);
        const retained = hostThreeGeometries.get(mesh.geometry)!;
        expect(retained.geometry.position.array).toHaveLength(0);
        expect(hostGeometries.get(retained.geometry)?.vertices).toBe(3000000);
        const converted = hostMaterials.get(mesh.material as THREE.Material)!;
        expect(converted.baseColor[1]).toBeCloseTo(.4);
        expect(converted.geometryThinWalled).toBe(true);
        expect(converted.specularColor).toEqual([.2, .3, .4]);
        expect(model.lighting?.available).toBe(true);
        expect(converted.alphaMode).toBe('blend');
        expect(converted.mapAlphaUsage).toBe('alpha');
        expect(converted.normalScale[1]).toBe(-1);
        manifest.geometries[0].tangent = true;
        const withTangents = await buildNativeGltf(manifest, { files: [], mainPath: 'tangent.glb', base: '' }, descriptor.buffer, async () => { throw Error('resource'); }, () => { });
        const tangentMesh = withTangents.root.getObjectByName('Triangle') as THREE.Mesh;
        expect(hostMaterials.get(tangentMesh.material as THREE.Material)!.normalScale[1]).toBe(1);
        expect(converted.map?.image.width).toBe(4096);
        expect(hostTextures.get(converted.map!)?.preview.data).toEqual(new Uint8Array([255, 0, 0, 255]));
        const root = new THREE.Scene();
        root.add(model.root);
        const scene = fromTHREEScene(root, { convertMaterial: source => hostMaterials.get(source), onMeshConverted: (target, source) => {
                const geometry = hostThreeGeometries.get(source.geometry);
                if (geometry)
                    target.geometry = geometry.geometry;
            } });
        converted.specularRoughness = .8;
        const update = await encoder().prepare(scene, new Camera({ projection: 'perspective' }), [100, 100], new SceneChangeDetector().detect(scene));
        expect(update.refs.geometries).toEqual([{ index: 0, model: 7, id: 0 }]);
        expect(update.refs.textures).toEqual([{ index: 0, model: 7, id: 0 }]);
        expect(scene.meshes[0].materials[0].specularRoughness).toBe(.8);
        expect(model.groundOffset).toEqual([1, -2, 3]);
        model.revoke();
        expect(released).toBe(true);
    });
    it('keeps decoded instance matrices in binary and groups instances under their source node', async () => {
        const geometry = new Geometry({ position: new Attribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3) }), material = new OpenPBRMaterial();
        const first = new Mesh(geometry, material), second = new Mesh(geometry, material);
        first.position = [1, 2, 0];
        second.position = [3, 2, 0];
        const descriptor = await encoder().encode({ meshes: [first, second], lights: [] }, new Camera({ projection: 'perspective' }), [1, 1]);
        descriptor[H.TEXTURE_COUNT] = 0;
        const manifest: NativeGltfManifest = { id: 2, descriptor: 'unused', groundOffset: [0, 0, 0], warnings: [], materialNames: ['Paint'], textures: [],
            geometries: [{ min: [0, 0, 0], max: [1, 1, 0], vertices: 3, indices: 3, uv: false, uv1: false }],
            document: { nodes: [{ name: 'Batch', translation: [1, 2, 0], extensions: { EXT_mesh_gpu_instancing: { attributes: { TRANSLATION: 0 } } } }], scenes: [{ nodes: [0] }] },
            meshes: [{ node: 0, name: 'Instances', geometry: 0, material: 0, first: 0, count: 2 }] };
        const model = await buildNativeGltf(manifest, { files: [], mainPath: 'scene.glb', base: '' }, descriptor.buffer, async () => { throw Error('resource'); }, () => { });
        const batch = model.root.getObjectByName('Instances') as THREE.InstancedMesh;
        expect(batch.isInstancedMesh).toBe(true);
        expect(batch.count).toBe(2);
        const matrix = new THREE.Matrix4();
        batch.getMatrixAt(1, matrix);
        expect(new THREE.Vector3().setFromMatrixPosition(matrix).toArray()).toEqual([2, 0, 0]);
        const root = new THREE.Scene();
        root.add(model.root);
        const scene = fromTHREEScene(root, { convertMaterial: source => hostMaterials.get(source), onMeshConverted: (mesh, source) => { mesh.geometry = hostThreeGeometries.get(source.geometry)!.geometry; } });
        expect(scene.meshes[0].instanceData?.count).toBe(2);
        expect(scene.meshes[0].geometry.position.array).toHaveLength(0);
    });
});
