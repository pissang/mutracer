import { expect, it, vi } from 'vitest';
vi.hoisted(() => {
  vi.stubGlobal('location', { href: 'https://viewer.test/', search: '', hash: '', pathname: '/' });
  vi.stubGlobal('document', { baseURI: 'https://viewer.test/' });
  vi.stubGlobal('window', {});
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => { fn(0); return 1; });
});
import { ViewerEngine } from '../src/engine/ViewerEngine';
import { useViewer } from '../src/store';
import { isMaterialXDrop, materialDropTarget, textureDropError } from '../src/engine/materialDrop';

const hit = { objectId: 'other-object', materialId: 'other', name: 'Other material' };
const selected = { objectId: 'selected-object', materialId: 'selected', name: 'Selected material' };
const files = [{ path: 'new.mtlx', file: new File([''], 'new.mtlx') }];

it('uses the viewport hit, falls back on background, and keeps the panel target', () => {
  expect(materialDropTarget('viewport', hit, selected)).toBe(hit);
  expect(materialDropTarget('viewport', null, selected)).toBe(selected);
  expect(materialDropTarget('viewport', null, null)).toBeNull();
  expect(materialDropTarget('panel', hit, selected)).toBe(selected);
});
it('recognizes MaterialX with sidecars and leaves model packages on the model route', () => {
  expect(isMaterialXDrop([...files, { path: 'texture.png', file: new File([], 'texture.png') }])).toBe(true);
  expect(isMaterialXDrop([...files, { path: 'scene.gltf', file: new File([], 'scene.gltf') }])).toBe(false);
  expect(isMaterialXDrop([{ path: 'light.hdr', file: new File([], 'light.hdr') }])).toBe(false);
});
it('applies a viewport drop to the picked material and selects it', async () => {
  useViewer.setState({ material: { id: 'selected', name: 'Selected material' } as never, selection: { objectId: 'selected-object', materialId: 'selected' } });
  const engine = Object.assign(Object.create(ViewerEngine.prototype), {
    loadToken: 1, pickMaterialTarget: vi.fn(async () => hit), select: vi.fn(), importMaterialX: vi.fn()
  });
  await engine.loadFiles(files, { clientX: 120, clientY: 90 });
  expect(engine.pickMaterialTarget).toHaveBeenCalledWith(120, 90);
  expect(engine.select).toHaveBeenCalledWith('other-object', 'other');
  expect(engine.importMaterialX).toHaveBeenCalledWith('other', files);
  engine.pickMaterialTarget.mockResolvedValue(null);
  await engine.loadFiles(files, { clientX: 1, clientY: 1 });
  expect(engine.importMaterialX).toHaveBeenLastCalledWith('selected', files);
});
it('reads GPU identities without changing selection and discards a replaced scene', async () => {
  const engine = Object.assign(Object.create(ViewerEngine.prototype), {
    loadToken: 1, canvas: { getBoundingClientRect: () => ({ left: 10, top: 20, width: 100, height: 200 }) },
    engine: { _pick: vi.fn(async () => ({ object: 42, material: 84 })) },
    pickObjects: new Map([[42, hit.objectId]]), pickMaterials: new Map([[84, hit.materialId]]),
    materials: { describe: () => ({ name: hit.name }) }, select: vi.fn()
  });
  expect(await engine.pickMaterialTarget(35, 120)).toEqual(hit);
  expect(engine.engine._pick).toHaveBeenCalledWith(.25, .5);
  expect(engine.select).not.toHaveBeenCalled();
  engine.engine._pick.mockImplementation(async () => { engine.loadToken++; return { object: 42, material: 84 }; });
  expect(await engine.pickMaterialTarget(35, 120)).toBeNull();
});
it('accepts only one image in the same formats as the texture picker', () => {
  for (const [extension, type] of [['png', 'image/png'], ['jpg', 'image/jpeg'], ['webp', 'image/webp'], ['avif', 'image/avif']]) {
    expect(textureDropError([new File([], `texture.${extension}`, { type })])).toBeNull();
  }
  expect(textureDropError([new File([], 'shader.mtlx')])).toMatch(/PNG/);
  expect(textureDropError([new File([], 'texture.svg', { type: 'image/svg+xml' })])).toMatch(/PNG/);
  expect(textureDropError([new File([], 'fake.exe', { type: 'image/png' })])).toMatch(/PNG/);
  expect(textureDropError([])).toMatch(/one image/);
  expect(textureDropError([new File([], 'a.png'), new File([], 'b.png')])).toMatch(/one image/);
});
