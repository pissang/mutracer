import {describe, expect, it, vi} from 'vitest';
vi.hoisted(() => {
  vi.stubGlobal('location', {href: 'https://viewer.example.com/', search: '', hash: '', pathname: '/'});
  vi.stubGlobal('document', {baseURI: 'https://viewer.example.com/'});
  vi.stubGlobal('window', {});
});
import {WebEngine} from '../src/engine/WebEngine';
import {useViewer} from '../src/store';

// Exercise the UI boundary without creating a GPU device.
const adapter = (fields: object) => Object.assign(Object.create(WebEngine.prototype), fields) as WebEngine;
describe('viewer engine boundary', () => {
  it('subscribes to both render channels and releases both listeners', () => {
    const offPreview = vi.fn(), offFinal = vi.fn(), push = vi.fn();
    const preview = {on: vi.fn(() => offPreview)}, final = {on: vi.fn(() => offFinal)};
    const off = adapter({preview, final}).on('sample', push);
    expect(preview.on).toHaveBeenCalledWith('sample', push);
    expect(final.on).toHaveBeenCalledWith('sample', push);
    off();
    expect(offPreview).toHaveBeenCalledOnce();
    expect(offFinal).toHaveBeenCalledOnce();
  });
  it('reads the displayed channel and exposes dimensions without renderer objects', async () => {
    const readPixels = vi.fn(async () => ({width: 2, height: 1, data: new Float32Array(8)}));
    const viewer = adapter({engine: {display: {canvas: {width: 400, height: 200}}, info: {limits: {maxTextureDimension2D: 4096}}}, displayed: {readPixels}});
    expect(viewer.viewportSize).toEqual({width: 400, height: 200});
    expect(viewer.maxImageDimension).toBe(4096);
    await viewer.readPixels('normal');
    expect(readPixels).toHaveBeenCalledWith('normal');
  });
  it('publishes progress and stats changes, then unsubscribes', () => {
    const viewer = adapter({}), progress = vi.fn(), stats = vi.fn();
    const stop = [viewer.on('progress', progress), viewer.on('stats', stats)];
    const before = useViewer.getState();
    useViewer.setState({loading: {name: 'sample', stage: 'bvh', loaded: 0, total: 0}, stats: {...before.stats, samples: 7}});
    expect(stats).toHaveBeenCalledWith(expect.objectContaining({samples: 7}));
    expect(progress).toHaveBeenCalledOnce();
    stop.forEach(off => off());
    useViewer.setState({loading: before.loading, stats: before.stats});
    expect(progress).toHaveBeenCalledOnce();
  });
});
