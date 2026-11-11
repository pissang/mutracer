import { SceneChangeDetector } from '../../src/renderer/sceneChangeDetector';
import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NativeSceneEncoder, cameraWords, descriptorDelta, descriptorDeltaParts } from '../src/engine/nativeScene';
import { Camera, Geometry, Mesh, InstancedMesh, OpenPBRMaterial, Texture, MaterialGraph, RectLight, EnvironmentLight } from '../../src/main';
import { HEADER as H, MATERIAL as M, GEOMETRY as G, TEXTURE as T } from '../../native/src/layout';
import { decodeMaterial, decodeGeometry, decodeTexture } from '../../native/src/scene-records';
import { Attribute } from '../../src/scene/Geometry';
import properties from '../../native/schemas/material-properties.json';
const encoder = () => new NativeSceneEncoder(async () => { throw Error('unexpected sky'); });
function fixture() {
    const geometry = new Geometry({ position: new Attribute(new Float32Array([-1, 0, 0, 1, 0, 0, 0, 1, 0]), 3), uv: new Attribute(new Float32Array([0, 0, 1, 0, .5, 1]), 2) });
    const material = new OpenPBRMaterial({ baseColor: [.2, .4, .8], specularRoughness: .23, shadowCatcher: true });
    const texture = new Texture({ width: 1, height: 1, data: new Uint8Array([64, 128, 255, 255]) });
    texture.colorSpace = 'linear';
    material.map = texture;
    material.roughnessMap = texture;
    const mesh = new Mesh(geometry, material);
    mesh.aovId = 42;
    material.aovId = 73;
    return { scene: { meshes: [mesh], lights: [new EnvironmentLight({ map: new Texture({ width: 1, height: 1, data: new Float32Array([1, 2, 3, 1]) }) }), new RectLight({ size: [2, 3] })] }, camera: new Camera({ projection: 'perspective' }), geometry, material };
}
function save(name: string, words: Uint32Array) { const dir = process.env.MUTRACER_WEBVIEW_DESCRIPTOR_FIXTURES; if (dir) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name + '.bin'), new Uint8Array(words.buffer));
} }
describe('native scene v8 boundary', () => {
    it('round trips geometry, every material property, shared color/data images and IDs through native decoders', async () => {
        const { scene, camera, geometry, material } = fixture(), words = await encoder().encode(scene, camera, [320, 192]), floats = new Float32Array(words.buffer), bytes = new Uint8Array(words.buffer);
        const textures = Array.from({ length: words[H.TEXTURE_COUNT] }, (_, i) => decodeTexture(bytes, words, floats, words[H.TEXTURE_OFFSET] + i * T.WORDS));
        const decoded = decodeMaterial(words, floats, words[H.MATERIAL_OFFSET], textures);
        for (const p of properties) {
            if (p.type === 'texture')
                continue;
            const key = p.key === 'opacity' ? 'geometryOpacity' : p.key === 'thinWalled' ? 'geometryThinWalled' : p.key;
            const value = p.key === 'displacementStepSize' ? Math.abs(material.displacementScale) / 32 : material[key as keyof OpenPBRMaterial];
            expect(JSON.stringify(decoded[key as keyof typeof decoded]), p.key).toBe(JSON.stringify(typeof value === 'number' ? Math.fround(value) : Array.isArray(value) ? value.map(Math.fround) : value));
        }
        const g = decodeGeometry(words, floats, words[H.GEOMETRY_OFFSET], undefined);
        expect(g.position.array).toEqual(geometry.position.array);
        expect(g.indices.array).toEqual(Uint32Array.from(geometry.indices.array));
        expect(words[words[H.MESH_AOV_IDS]]).toBe(42);
        expect(words[words[H.MATERIAL_AOV_IDS]]).toBe(73);
        expect(textures[0].pixels.data).toBeInstanceOf(Float32Array);
        expect(textures[1].pixels.data).toBeInstanceOf(Uint8Array);
        expect(words[H.LENGTH]).toBe(words.length);
        expect(words[H.GEOMETRY_OFFSET] + G.WORDS).toBe(words[H.MESH_OFFSET]);
        save('basic', words);
    });
    it('preserves graph IR, UTF-8 author IDs, instances and camera lens data', async () => {
        const { scene, camera, material, geometry } = fixture();
        material.graph = new MaterialGraph({ nodes: [{ id: '颜色 🌈', category: 'constant', type: 'color3', inputs: { value: { type: 'color3', value: [.1, .3, .5] } } }], terminal: { baseColor: { node: '颜色 🌈' } } });
        scene.meshes = [new InstancedMesh(geometry, material, { count: 2, transforms: new Float32Array([...camera.transform, ...camera.transform]) })];
        camera.fStop = 2.8;
        camera.metersPerUnit = .01;
        const words = await encoder().encode(scene, camera, [320, 192]), f = new Float32Array(words.buffer);
        const decoded = decodeMaterial(words, f, words[H.MATERIAL_OFFSET], []);
        expect((decoded as unknown as {
            graph: {
                authorIds: string[];
            };
        }).graph.authorIds).toEqual(['颜色 🌈']);
        expect(words[H.BATCH_OFFSET]).toBeGreaterThan(0);
        expect(new Float32Array(cameraWords(camera).buffer)[9]).toBeCloseTo(2.8);
        expect(words[words[words[H.MATERIAL_OFFSET] + M.GRAPH]]).toBe(1);
        save('graph-instances', words);
    });
    it('applies incremental edits exactly like a fresh descriptor without resending geometry', async () => {
        const {scene, camera, geometry, material} = fixture(), enc = encoder(), detector = new SceneChangeDetector();
        let committed: Uint32Array | undefined;
        const check = async (delta?: boolean) => {
            const update = await enc.prepare(scene, camera, [320,192], detector.detect(scene));
            const packet = new Uint8Array(update.parts.reduce((n,p) => n + p.byteLength, 0));
            let at = 0; for (const part of update.parts) {packet.set(part,at); at += part.byteLength;}
            const u = new Uint32Array(packet.buffer);
            if (delta !== undefined) expect(u[1]).toBe(delta ? 0 : 1);
            const next = u[1] ? new Uint32Array(u[2]) : committed!.slice();
            at = 4; for (let i = 0; i < u[3]; i++) {const offset=u[at++], length=u[at++]; next.set(u.subarray(at,at+length),offset); at+=length;}
            expect(next).toEqual(await encoder().encode(scene,camera,[320,192]));
            update.accept(); detector.commit(); committed = next;
            return packet.byteLength;
        };
        await check(false);
        material.specularRoughness = .7;
        expect(await check(true)).toBeLessThan(128);
        scene.meshes[0].position = [1,2,3]; await check(true);
        scene.meshes[0].visible = false; await check(true);
        scene.lights[1].intensity = 7; await check(true);
        const texture = material.map!;
        (texture.image as {data:Uint8Array}).data[0] = 29; texture.markUpdated(); await check(true);
        material.graph = new MaterialGraph({nodes:[{id:'color',category:'constant',type:'color3',inputs:{value:{type:'color3',value:[.3,.4,.5]}}}],terminal:{baseColor:{node:'color'}}}); await check(false);
        material.graph.setInput('color','value',{type:'color3',value:[.1,.2,.3]}); await check(true);
        geometry.position.array[0] = -2; geometry.markUpdated(); await check(true);
        const instances = new InstancedMesh(geometry, material, {count:2, colors:new Float32Array([1,1,1,1,1,1])});
        scene.meshes = [instances]; await check(false);
        instances.transforms[12] = 3; instances.markTransformsUpdated(); await check(true);
        instances.colors![1] = .25; instances.markColorsUpdated(); await check(true);
        material.map = new Texture({width:1,height:1,data:new Uint8Array([2,3,4,255])}); await check(false);
        material.baseColor = [.9,.8,.7]; await check(true);
        scene.lights = []; await check(false);
        material.baseMetalness = .33; await check(true);
    });
    it('keeps a material edit packet bounded for a large geometry and image', async () => {
        const {scene,camera,material} = fixture(), enc = encoder(), detector = new SceneChangeDetector();
        scene.meshes[0].geometry = new Geometry({position:new Attribute(new Float32Array(3 * 300000),3)});
        material.map = new Texture({width:1024,height:1024,data:new Uint8Array(1024*1024*4)});
        material.map.colorSpace = 'linear';
        const initial = await enc.prepare(scene,camera,[32,32],detector.detect(scene));
        expect(initial.parts.some(part => part.buffer === scene.meshes[0].geometry.position.array.buffer)).toBe(true);
        initial.accept(); detector.commit();
        material.baseMetalness = .9;
        const edited = await enc.prepare(scene,camera,[32,32],detector.detect(scene));
        expect(new Uint32Array(edited.parts[0].buffer)[1]).toBe(0);
        expect(edited.parts.reduce((n,p)=>n+p.byteLength,0)).toBeLessThan(128);
    });
    it('streams full descriptors as views without duplicating the payload', () => {
        const next = new Uint32Array([3, 7, 11, 19]);
        const parts = descriptorDeltaParts(undefined, next);
        expect(parts[2].buffer).toBe(next.buffer);
        expect(Array.from(parts[2])).toEqual(Array.from(new Uint8Array(next.buffer)));
        expect(parts.reduce((n, p) => n + p.length, 0)).toBe(next.byteLength + 24);
    });
    it('encodes changed ranges and full replacements without losing trailing bytes', () => {
        function apply(old: Uint32Array | undefined, p: Uint8Array) { const u = new Uint32Array(p.buffer), next = u[1] ? new Uint32Array(u[2]) : old!.slice(); let at = 4; for (let i = 0; i < u[3]; i++) {
            const dst = u[at++], n = u[at++];
            next.set(u.subarray(at, at + n), dst);
            at += n;
        } return next; }
        const a = new Uint32Array(2048), b = a.slice();
        b[0] = 3;
        b[2000] = 6;
        const full = descriptorDelta(undefined, a), delta = descriptorDelta(a, b);
        expect(delta.byteLength).toBeLessThan(80);
        expect(apply(apply(undefined, full), delta)).toEqual(b);
        const shorter = new Uint32Array([3, 4]);
        expect(apply(b, descriptorDelta(b, shorter))).toEqual(shorter);
    });
});
