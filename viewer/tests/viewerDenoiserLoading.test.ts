import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  vi.stubGlobal('location', { href: 'https://viewer.example.com/', search: '', hash: '' });
  vi.stubGlobal('document', { baseURI: 'https://viewer.example.com/' });
  vi.stubGlobal('window', {});
});

import { ViewerEngine } from '../src/engine/ViewerEngine';
import { OIDNLoadingStatus } from '../src/components/OIDNLoadingStatus';
import { DEFAULT_SETTINGS, useViewer } from '../src/store';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function viewer(backend = 'webgpu') {
  const final = deferred(), preview = deferred();
  const engine = Object.assign(Object.create(ViewerEngine.prototype), {
    engine: { backend }, settings: { ...DEFAULT_SETTINGS }, denoiserUpdateToken: 0, disposed: false,
    final: { setDenoiser: vi.fn(() => final.promise) },
    preview: { setDenoiser: vi.fn(() => preview.promise) }
  });
  return { engine, final, preview };
}

beforeEach(() => useViewer.setState({ oidnLoading: false, toast: null }));

describe('OIDN loading state', () => {
  it('stays visible until both final and preview denoisers are ready', async () => {
    const { engine, final, preview } = viewer();
    const ready = engine.updateDenoiser();
    expect(useViewer.getState().oidnLoading).toBe(true);
    final.resolve();
    await final.promise;
    expect(useViewer.getState().oidnLoading).toBe(true);
    preview.resolve();
    await ready;
    expect(useViewer.getState().oidnLoading).toBe(false);
  });

  it('clears loading and reports a failure after the remaining load settles', async () => {
    const { engine, final, preview } = viewer();
    const ready = engine.updateDenoiser();
    final.reject(new Error('Weights unavailable'));
    await Promise.resolve();
    expect(useViewer.getState().oidnLoading).toBe(true);
    preview.resolve();
    await ready;
    expect(useViewer.getState().oidnLoading).toBe(false);
    expect(useViewer.getState().toast).toMatchObject({ tone: 'error', message: 'Denoiser failed to load: Weights unavailable' });
  });

  it('ignores completion and errors from a superseded request', async () => {
    const { engine, final, preview } = viewer();
    const old = engine.updateDenoiser();
    const nextFinal = deferred(), nextPreview = deferred();
    engine.final.setDenoiser.mockReturnValue(nextFinal.promise);
    engine.preview.setDenoiser.mockReturnValue(nextPreview.promise);
    engine.settings.denoiseModel = 'small';
    const current = engine.updateDenoiser();
    final.reject(new Error('Old request failed')); preview.resolve();
    await old;
    expect(useViewer.getState()).toMatchObject({ oidnLoading: true, toast: null });
    nextFinal.resolve(); nextPreview.resolve();
    await current;
    expect(useViewer.getState().oidnLoading).toBe(false);
  });

  it.each(['off', 'jnlm', 'webgl'])('does not show OIDN loading for %s', async (mode) => {
    const { engine, final, preview } = viewer(mode === 'webgl' ? 'webgl' : 'webgpu');
    if (mode === 'off') engine.settings.denoise = false;
    if (mode === 'jnlm') engine.settings.denoiseModel = 'jnlm';
    const ready = engine.updateDenoiser();
    expect(useViewer.getState().oidnLoading).toBe(false);
    final.resolve(); preview.resolve();
    await ready;
  });

  it('clears loading immediately when OIDN is disabled during a load', async () => {
    const { engine, final, preview } = viewer();
    const old = engine.updateDenoiser();
    engine.settings.denoise = false;
    engine.final.setDenoiser.mockResolvedValue(undefined);
    engine.preview.setDenoiser.mockResolvedValue(undefined);
    await engine.updateDenoiser();
    expect(useViewer.getState().oidnLoading).toBe(false);
    final.reject(new Error('Cancelled')); preview.resolve();
    await old;
    expect(useViewer.getState().toast).toBeNull();
  });

  it('ignores pending completion after disposal', async () => {
    const { engine, final, preview } = viewer();
    const ready = engine.updateDenoiser();
    engine.disposed = true;
    useViewer.setState({ oidnLoading: false });
    final.reject(new Error('Disposed')); preview.resolve();
    await ready;
    expect(useViewer.getState()).toMatchObject({ oidnLoading: false, toast: null });
  });
});

describe('OIDN loading indicator', () => {
  const initial = { ...useViewer.getInitialState() };
  afterEach(() => Object.assign(useViewer.getInitialState(), initial));

  it.each([false, true])('shows a live status only while loading (%s)', (oidnLoading) => {
    Object.assign(useViewer.getInitialState(), { oidnLoading });
    const markup = renderToStaticMarkup(createElement(OIDNLoadingStatus));
    if (oidnLoading) {
      expect(markup).toContain('role="status"');
      expect(markup).toContain('Loading OIDN…');
    } else expect(markup).toBe('');
  });
});
