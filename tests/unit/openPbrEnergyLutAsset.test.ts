import {expect, it, vi} from 'vitest';
import {createHash} from 'node:crypto';
import {getOpenPbrEnergyLutData as synchronous} from '../../src/renderer/openPbrEnergyLut';

it('decodes the asset to the synchronous native table, byte for byte', async () => {
  const lut = await import('../../src/renderer/openPbrEnergyLut.browser');
  const first = lut.initOpenPbrEnergyLut();
  expect(lut.initOpenPbrEnergyLut()).toBe(first);
  await first;
  expect(new Uint8Array(lut.getOpenPbrEnergyLutData().buffer)).toEqual(new Uint8Array(synchronous().buffer));
  // Complete 278,656-byte Float32 table.
  expect(createHash('sha256').update(new Uint8Array(lut.getOpenPbrEnergyLutData().buffer)).digest('hex'))
    .toBe('4d7750059e920788a116296128c332ed4355c5b87433dd9806a4194e7007a418');
  expect(lut.getOpenPbrEnergyLutData()).toBe(lut.getOpenPbrEnergyLutData());
});

it('reports a failed download and allows a later retry', async () => {
  vi.resetModules();
  const fresh = await import('../../src/renderer/openPbrEnergyLut.browser');
  vi.stubGlobal('fetch', async () => new Response(null, {status: 404}));
  try {await expect(fresh.initOpenPbrEnergyLut()).rejects.toThrow('loading failed: HTTP 404');}
  finally {vi.unstubAllGlobals();}
  expect(() => fresh.getOpenPbrEnergyLutData()).toThrow('not initialized');
  await fresh.initOpenPbrEnergyLut();
  expect(new Uint8Array(fresh.getOpenPbrEnergyLutData().buffer)).toEqual(new Uint8Array(synchronous().buffer));
});
