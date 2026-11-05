import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderFixture } from '../../tests/helpers/renderPipeline';
import Render from '../../src/Render';

vi.hoisted(() => {
  vi.stubGlobal('location', { href: 'https://viewer.example.com/', search: '', hash: '', pathname: '/' });
  vi.stubGlobal('document', { baseURI: 'https://viewer.example.com/' });
  vi.stubGlobal('window', {});
  vi.stubGlobal('history', { replaceState: vi.fn() });
});

import { ViewerEngine } from '../src/engine/ViewerEngine';
import { DEFAULT_SETTINGS, useViewer } from '../src/store';

beforeEach(() => {
  useViewer.setState({ settings: { ...DEFAULT_SETTINGS, cameraIndex: 0, fStop: 2.8 }, export: null });
});
afterEach(() => { vi.restoreAllMocks(); });

describe('image export camera', () => {
  it.each(['perspective', 'orthographic'] as const)('keeps a parented %s camera in the viewport world-space view', async projection => {
    const { engine, operations } = renderFixture();
    const final = new Render(engine);
    const source = projection === 'perspective'
      ? new THREE.PerspectiveCamera(53, 4 / 3, 0.05, 250)
      : new THREE.OrthographicCamera(-2, 4, 3, -1, 0.05, 250);
    source.position.set(3, 2, 6);
    source.rotation.set(0.1, 0.4, 0.2);
    source.zoom = 1.25;
    source.updateProjectionMatrix();
    const parent = new THREE.Group();
    parent.position.set(10, -3, 5);
    parent.rotation.set(0.1, -0.3, 0.15);
    parent.scale.set(2, 3, 1.5);
    parent.add(source);
    source.updateWorldMatrix(true, false);
    const expectedWorld = source.matrixWorld.elements.slice();
    const expectedProjection = source.projectionMatrix.elements.slice();
    const blob = new Blob(['png'], {type: 'image/png'});
    const encode = vi.spyOn(engine.display, 'toBlob').mockResolvedValue(blob);
    const viewer = Object.create(ViewerEngine.prototype) as ViewerEngine;
    Object.assign(viewer, {
      upscalePass: Object.assign(vi.fn(),{dispose:vi.fn()}),
      engine, final, modelCameras: [source], settings: useViewer.getState().settings,
      sync: {update: vi.fn()}, viewSync: {update: vi.fn()}, applyBackground: vi.fn()
    });
    try {
      expect(await viewer.renderImage({width: 320, height: 180, samples: 2, transparent: false})).toBe(blob);
      const drawn = operations.filter(operation => operation.kind === 'draw');
      expect(drawn.length).toBeGreaterThan(0);
      for (const { camera } of drawn) {
        expect(camera!.transform).toEqual(new Float32Array(expectedWorld));
        expect(camera!.fStop).toBe(2.8);
        expect(camera!.zoom).toBe(source.zoom);
        if (projection === 'perspective') expect(camera!.aspect).toBe(16 / 9);
        else {
          expect(camera!.right - camera!.left).toBeCloseTo(4 * 16 / 9);
          expect((camera!.right + camera!.left) / 2).toBe(1);
          expect([camera!.top, camera!.bottom]).toEqual([3, -1]);
        }
      }
      expect(encode).toHaveBeenCalledOnce();
      expect(source.parent).toBe(parent);
      expect(source.matrixWorld.elements).toEqual(expectedWorld);
      expect(source.projectionMatrix.elements).toEqual(expectedProjection);
      expect(useViewer.getState().export).toBeNull();
    } finally { engine.dispose(); }
  });
});
