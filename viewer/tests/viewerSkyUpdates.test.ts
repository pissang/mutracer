import { describe, expect, it, vi } from 'vitest';
import ProceduralSky from '../../src/scene/ProceduralSky';
vi.hoisted(() => {
  vi.stubGlobal('location', { href: 'https://viewer.example.com/', search: '', hash: '', pathname: '/' });
  vi.stubGlobal('document', { baseURI: 'https://viewer.example.com/' });
  vi.stubGlobal('window', {});
});
import { WebEngine } from '../src/engine/WebEngine';

describe('sky time updates', () => {
  it('updates the library sky immediately without queuing viewer bakes', () => {
    const sky = new ProceduralSky();
    const viewer = Object.assign(Object.create(WebEngine.prototype), {
      sky, settings: { skyTime: 14 }, cancelEnvironmentDownload: vi.fn(), applyBackground: vi.fn()
    });
    for (const time of [14, 13, 12]) { viewer.settings.skyTime = time; viewer.applySky('sky'); }
    expect(sky.time).toBe(12);
    expect(viewer.cancelEnvironmentDownload).toHaveBeenCalledTimes(3);
    expect(viewer.applyBackground).toHaveBeenCalledTimes(3);
  });
});
