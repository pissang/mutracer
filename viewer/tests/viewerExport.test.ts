import * as THREE from 'three';
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderFixture } from '../../tests/helpers/renderPipeline';
import Render from '../../src/Render';

vi.hoisted(() => {
  vi.stubGlobal('location', { href: 'https://viewer.example.com/', search: '', hash: '', pathname: '/' });
  vi.stubGlobal('document', { baseURI: 'https://viewer.example.com/' });
  vi.stubGlobal('window', {});
  vi.stubGlobal('history', { replaceState: vi.fn() });
});

import { WebEngine } from '../src/engine/WebEngine';
import { EXR_MIME } from '../src/engine/exrExport';
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
    const viewer = Object.create(WebEngine.prototype) as WebEngine;
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

describe('EXR export', () => {
  it('exports the viewport HDR with associated alpha and the correct row order', async () => {
    const viewer = Object.create(WebEngine.prototype) as WebEngine;
    const readPixels = vi.fn().mockResolvedValue({
      width: 1, height: 2, data: new Float32Array([8, 4, 2, 0.25, 3, 2, 1, 1])
    });
    Object.assign(viewer, { displayed: {readPixels}, settings: {...DEFAULT_SETTINGS, background: 'transparent'} });
    const blob = await viewer.captureImage(EXR_MIME);
    expect(readPixels.mock.calls).toEqual([['hdr']]);
    expect(blob.type).toBe(EXR_MIME);
    const image = new EXRLoader().setDataType(THREE.FloatType).parse(await blob.arrayBuffer());
    expect([image.width, image.height]).toEqual([1, 2]);
    // EXRLoader returns bottom-up rows for Three.js textures.
    expect(Array.from(image.data)).toEqual([3, 2, 1, 1, 2, 1, 0.5, 0.25]);
  });

  it('renders an opaque beauty EXR with the requested dimensions while a diagnostic is selected', async () => {
    const { engine, targets, canvas } = renderFixture();
    const final = new Render(engine);
    const compose = vi.spyOn(engine.display, 'toBlob');
    const read = vi.spyOn(Render.prototype, 'readPixels').mockResolvedValue({
      width: 3, height: 2, data: new Float32Array(24).fill(2)
    });
    const viewer = Object.create(WebEngine.prototype) as WebEngine;
    const settings = {...useViewer.getState().settings, output: 'centerDepth' as const, background: 'transparent' as const};
    useViewer.setState({settings});
    const applyBackground = vi.fn(() => Reflect.get(viewer, 'settings').background);
    Object.assign(viewer, {
      engine, final, settings, modelCameras: [new THREE.PerspectiveCamera()],
      upscalePass: Object.assign(vi.fn(), {dispose: vi.fn()}),
      sync: {update: vi.fn()}, viewSync: {update: vi.fn()}, applyBackground
    });
    try {
      const blob = await viewer.renderImage({width: 3, height: 2, samples: 2, transparent: false, format: 'exr'});
      const image = new EXRLoader().setDataType(THREE.FloatType).parse(await blob.arrayBuffer());
      expect([image.width, image.height]).toEqual([3, 2]);
      expect(Array.from(image.data.slice(0, 4))).toEqual([2, 2, 2, 1]);
      expect(read.mock.calls).toEqual([['hdr']]);
      expect(targets[0].configure).toHaveBeenLastCalledWith(expect.objectContaining({aovs: []}));
      expect(compose).not.toHaveBeenCalled();
      expect(applyBackground.mock.results.map(result => result.value)).toEqual(['environment', 'transparent']);
      expect([canvas.width, canvas.height]).toEqual([800, 600]);
      expect(useViewer.getState().export).toBeNull();
    } finally { engine.dispose(); }
  });
});
