import { expect, it, vi } from 'vitest';
vi.hoisted(() => { vi.stubGlobal('location', { href: 'https://viewer.test/', search: '', hash: '', pathname: '/' }); vi.stubGlobal('window', {}); });
import { MaterialEditor } from '../src/engine/materialEditor';
import { OpenPBRMaterial } from '@meimu/mutracer';

it('discards decoded images without uploading or recording history when cancelled', async () => {
  const controller = new AbortController(), close = vi.fn();
  let finish!: (image: { close: () => void }) => void;
  vi.stubGlobal('createImageBitmap', () => new Promise(resolve => { finish = resolve; }));
  const editor = Object.assign(Object.create(MaterialEditor.prototype), {
    entries: new Map([['id', { converted: new Set([new OpenPBRMaterial()]) }]]), upload: vi.fn(), commit: vi.fn()
  });
  const task = editor.setTextures('id', { map: new Blob(['image']) }, {}, 'Import', undefined, undefined, null, undefined, controller.signal);
  controller.abort(); finish({ close });
  expect(await task).toBe(false);
  expect(close).toHaveBeenCalledOnce();
  expect(editor.upload).not.toHaveBeenCalled();
  expect(editor.commit).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});
