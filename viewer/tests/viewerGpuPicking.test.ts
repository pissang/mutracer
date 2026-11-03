import {expect, it, vi} from 'vitest';
vi.hoisted(() => {
  vi.stubGlobal('location', {href: 'https://viewer.example.com/', search: '', hash: '', pathname: '/'});
  vi.stubGlobal('document', {baseURI: 'https://viewer.example.com/'});
  vi.stubGlobal('window', {});
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => {fn(0); return 1;});
});
import {ViewerEngine} from '../src/engine/ViewerEngine';

function viewer(pick: () => Promise<unknown>) {
  return Object.assign(Object.create(ViewerEngine.prototype), {engine: {_pick: vi.fn(pick)},
    pickRequest: 1, pickObjects: new Map([[42, 'object-uuid']]), pickMaterials: new Map([[84, 'material-uuid']]), select: vi.fn()});
}
it('selects GPU object/material identities and clears background clicks', async () => {
  const v = viewer(async () => ({object: 42, material: 84, instance: 2}));
  await v.pickAt(.25, .5, 1);
  expect(v.select).toHaveBeenCalledWith('object-uuid', 'material-uuid');
  v.engine._pick.mockResolvedValueOnce(null);
  await v.pickAt(.5, .5, 1); expect(v.select).toHaveBeenLastCalledWith(null);
});
it('ignores results superseded by another selection or model', async () => {
  let finish!: (hit: unknown) => void;
  const v = viewer(() => new Promise(resolve => {finish = resolve;}));
  const task = v.pickAt(.25, .5, 1); v.pickRequest++;
  finish({object: 42, material: 84, instance: 0}); await task;
  expect(v.select).not.toHaveBeenCalled();
});
it('retries unavailable data briefly and preserves selection if it stays unavailable', async () => {
  const v = viewer(async () => undefined);
  v.engine._pick.mockResolvedValueOnce(undefined).mockResolvedValueOnce({object: 42, material: 84, instance: 0});
  await v.pickAt(.25, .5, 1); expect(v.select).toHaveBeenCalledOnce();
  v.select.mockClear(); await v.pickAt(.25, .5, 1);
  expect(v.select).not.toHaveBeenCalled(); expect(v.engine._pick).toHaveBeenCalledTimes(6);
});
