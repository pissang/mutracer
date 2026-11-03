import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
vi.hoisted(() => {
  vi.stubGlobal('location', { href: 'https://viewer.example.com/', search: '', hash: '', pathname: '/' });
  vi.stubGlobal('document', { baseURI: 'https://viewer.example.com/' });
  vi.stubGlobal('window', {});
  vi.stubGlobal('history', { replaceState() {} });
});
vi.mock('../src/engine/modelCache', () => ({ clearMaterialEdits: vi.fn(), clearModelCache: vi.fn() }));
import { ViewerEngine } from '../src/engine/ViewerEngine';
import { useViewer, DEFAULT_SETTINGS } from '../src/store';
import { buildScene } from '../../tools/pbrt/scene';
import { convert } from '../../tools/pbrt/convert';

describe('PBRT volumes through viewer loading', () => {
  it('preserves camera medium, adds optional fog, and clears the medium on the next model', async () => {
    const resolver = { read: async () => new TextEncoder().encode('MakeNamedMedium "fog" "string type" "homogeneous" "rgb sigma_a" [0 0 0] "rgb sigma_s" [.1 .1 .1] MediumInterface "" "fog" Camera "perspective" WorldBegin Shape "sphere"').buffer };
    const pbrt = await convert(await buildScene('main.pbrt', resolver), resolver);
    useViewer.setState({ settings: { ...DEFAULT_SETTINGS, volumes: false }, model: null });
    const scene = { volumes: [] };
    const viewer = Object.assign(Object.create(ViewerEngine.prototype), {
      loadToken: 0, sync: { scene }, settings: useViewer.getState().settings,
      materials: { flush: vi.fn() }, saveCamera: vi.fn(),
      setModel(model: unknown) { this.model = model; },
      modelBounds: () => new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1))
    });
    const model = { name: 'fog', root: pbrt.root, pbrt: { ...pbrt, warnings: [] } };
    const load = (model: unknown) => viewer.load('test', async () => model, { presetId: null, credit: null, sourceUrl: null }, undefined, false);
    expect(await load(model)).toBe(true);
    expect(scene.volumes).toHaveLength(1);
    expect(scene.volumes[0].density).toBeCloseTo(.1);
    expect(scene.volumes[0].transform).toEqual(pbrt.root.matrixWorld.elements);
    viewer.settings = { ...viewer.settings, volumes: true };
    viewer.applyVolumes();
    expect(scene.volumes).toHaveLength(2);
    viewer.settings.volumes = false;
    expect(await load({ name: 'plain', root: new THREE.Group() })).toBe(true);
    expect(scene.volumes).toEqual([]);
  });
});
