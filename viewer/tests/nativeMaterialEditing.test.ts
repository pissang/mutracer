import * as THREE from 'three';
import { afterAll, expect, it, vi } from 'vitest';
vi.hoisted(() => { vi.stubGlobal('location', { hash: '', href: 'https://viewer.example.com/' }); });
afterAll(() => vi.unstubAllGlobals());
import { Texture, OpenPBRMaterial } from '@meimu/mutracer';
import { MaterialEditor } from '../src/engine/materialEditor';
import { hostTextures } from '../src/engine/nativeResources';
import { undo, redo } from '../src/history';
it('edits native texture sampling without pixels and restores its host identity through undo/redo', () => {
    const texture = new Texture({ width: 4096, height: 2048 } as Texture['image']);
    Object.defineProperty(texture, 'udim', { value: true });
    texture.flipY = true;
    texture.colorSpace = 'srgb';
    texture.uvOffset = [.2, .3];
    texture.uvChannel = 1;
    const reference = { model: 3, id: 4, storage: 0, preview: { width: 1, height: 1, data: new Uint8Array([255, 0, 0, 255]) } };
    hostTextures.set(texture, reference);
    const material = new OpenPBRMaterial({ map: texture }), sourceMaterial = new THREE.MeshStandardMaterial();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), sourceMaterial);
    const editor = new MaterialEditor(() => { });
    editor.setModel(mesh, null);
    editor.onConverted(sourceMaterial, material, mesh.uuid);
    try {
        editor.setTextureSampling(sourceMaterial.uuid, 'map', { uvScale: [2, 3], wrapS: 'clamp-to-edge' }, 'Sampling');
        const edited = material.map!;
        expect(edited).not.toBe(texture);
        expect(edited.image).toBe(texture.image);
        expect(hostTextures.get(edited)).toBe(reference);
        expect(edited.uvScale).toEqual([2, 3]);
        expect(texture.uvScale).toEqual([1, 1]);
        expect(edited.wrapS).toBe('clamp-to-edge');
        expect(edited.uvOffset).toEqual([.2, .3]);
        expect(edited.uvChannel).toBe(1);
        expect(edited.udim).toBe(true);
        expect(edited.flipY).toBe(true);
        undo();
        expect(material.map).toBe(texture);
        redo();
        expect(material.map).toBe(edited);
        expect(hostTextures.get(material.map!)).toBe(reference);
    }
    finally {
        editor.setModel(null, null);
        mesh.geometry.dispose();
        sourceMaterial.dispose();
    }
});
