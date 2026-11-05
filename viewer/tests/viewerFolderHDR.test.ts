import { File } from 'node:buffer';
import { beforeEach, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  vi.stubGlobal('location', { href: 'https://viewer.example.com/', search: '', hash: '' });
  vi.stubGlobal('document', { baseURI: 'https://viewer.example.com/' });
  vi.stubGlobal('window', {});
});

import { ViewerEngine } from '../src/engine/ViewerEngine';
import { loadModelFromSource, type LoadedModel, type PathedFile } from '../src/engine/loadModel';

beforeEach(() => vi.stubGlobal('File', File));

const hdr = new Uint8Array([
  ...new TextEncoder().encode('#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 1 +X 1\n'),
  128, 64, 32, 129
]);

it('imports and caches an HDR referenced by a model in the dropped folder', async () => {
  const json = {
    asset: { version: '2.0' }, scenes: [{ nodes: [] }], scene: 0,
    extras: { pbrt: { light_sources: [{
      pbrt: 'infinite', gltf: 'metadata_only', source: '../kroken/environment.hdr',
      pbrt_transform: [-1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1]
    }] } }
  };
  const files = [
    { path: 'kroken/kroken.gltf', file: new File([JSON.stringify(json)], 'kroken.gltf') },
    { path: 'kroken/environment.hdr', file: new File([hdr], 'environment.hdr') }
  ] as unknown as PathedFile[];
  let loaded!: LoadedModel;
  const viewer = Object.assign(Object.create(ViewerEngine.prototype), {
    setEnvironmentData: vi.fn(), modelBackend: async () => 'webgpu',
    load: vi.fn(async (_name, loader) => { loaded = await loader(vi.fn(), new AbortController().signal); })
  });
  await viewer.loadFiles(files);
  expect(loaded.lighting).toMatchObject({ available: true, useByDefault: true, warnings: [] });
  expect(loaded.lighting?.environment?.data.slice(0, 4)).toEqual(new Float32Array([1, 0.5, 0.25, 1]));
  expect(loaded.source?.files.map(({ path }) => path)).toContain('kroken/environment.hdr');
  const restored = await loadModelFromSource(loaded.source!, vi.fn());
  expect(restored.lighting?.environment?.data).toEqual(loaded.lighting?.environment?.data);
  expect(restored.lighting?.warnings).toEqual([]);
  loaded.revoke(); restored.revoke();
});

it('still applies an HDR dropped without a model', async () => {
  const viewer = Object.assign(Object.create(ViewerEngine.prototype), { setEnvironmentData: vi.fn(), load: vi.fn() });
  await viewer.loadFiles([{ path: 'environment.hdr', file: new File([hdr], 'environment.hdr') }]);
  expect(viewer.setEnvironmentData).toHaveBeenCalledWith(expect.objectContaining({ width: 1, height: 1 }), 'custom');
  expect(viewer.load).not.toHaveBeenCalled();
});
