import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readURLSettings } from '../src/urlSettings';

// Settings use only these real defaults. Avoid loading both renderer graphs on
// every resetModules(), which can outlive a test and initialize the next store.
vi.mock('@meimu/mutracer', async () => import('../../src/renderer/jnlm'));

describe('viewer URL settings', () => {
  beforeEach(() => {
    vi.resetModules();
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value)
    });
    vi.stubGlobal('location', new URL('https://viewer.example.com/viewer/'));
    vi.stubGlobal('history', {
      replaceState: vi.fn((_state, _unused, url: string) => {
        vi.stubGlobal('location', new URL(url, location.href));
      })
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('applies URL overrides after saved preferences and defaults', async () => {
    localStorage.setItem('mutracer-viewer:render:v6', JSON.stringify({ hdrOutputEnabled: false, denoise: true, maxSamples: 256, bounces: 8 }));
    vi.stubGlobal('location', new URL('https://viewer.example.com/viewer/?hdrOutputEnabled=true&maxSamples=128#denoise=false&exposure=1.5'));
    const { useViewer } = await import('../src/store');
    expect(useViewer.getState().settings).toMatchObject({
      hdrOutputEnabled: true, denoise: false, maxSamples: 128, bounces: 8, exposure: 1.5, resolutionScale: 0.5
    });
  });

  it('reads a fixed render height and scales it to the canvas', async () => {
    vi.stubGlobal('location', new URL('https://viewer.example.com/viewer/#resolutionHeight=1440'));
    const { renderResolutionScale, useViewer } = await import('../src/store');
    const { settings } = useViewer.getState();
    expect(settings.resolutionHeight).toBe(1440);
    expect(renderResolutionScale(settings, 720)).toBe(2);
    expect(renderResolutionScale({ resolutionScale: 0.5, resolutionHeight: null }, 720)).toBe(0.5);
  });

  it.each(['false', '0'])('explicit %s disables a saved HDR preference', async (value) => {
    localStorage.setItem('mutracer-viewer:render:v6', JSON.stringify({ hdrOutputEnabled: true }));
    vi.stubGlobal('location', new URL(`https://viewer.example.com/viewer/#hdrOutputEnabled=${value}`));
    const { useViewer } = await import('../src/store');
    expect(useViewer.getState().settings.hdrOutputEnabled).toBe(false);
  });

  it('preserves AOV output and mappings while ignoring the retired opt-in flag', () => {
    expect(readURLSettings('?aovsEnabled=true&output=depth&aovDepthFar=20&aovIdComponent=primitive', ''))
      .toEqual({output: 'depth', aovDepthFar: 20, aovIdComponent: 'primitive'});
    expect(readURLSettings('?aovPositionScale=0&aovMotionScale=Infinity&aovIdComponent=bad', '')).toEqual({});
  });

  it('maps the retired Shadow output to Final in links and restored settings', async () => {
    expect(readURLSettings('?output=shadow', '#output=id')).toEqual({output: 'final'});
    expect(readURLSettings('', '#output=shadow')).toEqual({output: 'final'});
    expect(readURLSettings('?output=id', '#output=shadow')).toEqual({output: 'id'});
    localStorage.setItem('mutracer-viewer:render:v6', JSON.stringify({output: 'shadow'}));
    const {useViewer, setSettings} = await import('../src/store');
    expect(useViewer.getState().settings.output).toBe('final');
    setSettings({output: 'shadow'}, {record: false});
    expect(useViewer.getState().settings.output).toBe('final');
  });

  it('gives valid query values priority over the hash', () => {
    expect(readURLSettings('?hdrOutputEnabled=1&toneMapping=aces', '#hdrOutputEnabled=false&toneMapping=linear'))
      .toEqual({ hdrOutputEnabled: true, toneMapping: 'aces' });
    expect(readURLSettings('?maxSamples=NaN', '#maxSamples=128')).toEqual({ maxSamples: 128 });
  });

  it('ignores malformed values and unrelated parameters', async () => {
    const invalid = '?hdrOutputEnabled=yes&denoise=&maxSamples=Infinity&bounces=-1&resolutionScale=0&exposure=oops&toneMapping=invalid&samplingPattern=nope&backgroundColor=red&groundedHeight=-2&model=spheres&webgl&fov=60&__proto__=bad';
    expect(readURLSettings(invalid, '')).toEqual({});
    localStorage.setItem('mutracer-viewer:render:v6', JSON.stringify({ hdrOutputEnabled: true, maxSamples: 256, toneMapping: 'aces' }));
    vi.stubGlobal('location', new URL(`https://viewer.example.com/viewer/${invalid}`));
    const { useViewer } = await import('../src/store');
    expect(useViewer.getState().settings).toMatchObject({ hdrOutputEnabled: true, maxSamples: 256, toneMapping: 'aces' });
  });

  it('reads encoded colors, nullable projection values and denoiser options', () => {
    expect(readURLSettings('?backgroundColor=%23aBcD12&groundedHeight=null&groundedRadius=20&denoiseModel=jnlm&jnlmIterations=3', ''))
      .toEqual({ backgroundColor: '#aBcD12', groundedHeight: null, groundedRadius: 20, denoiseModel: 'jnlm', jnlmIterations: 3 });
  });

  it('keeps HDR and render settings in share links and removes stale query overrides', async () => {
    vi.stubGlobal('location', new URL('https://viewer.example.com/viewer/?webgl&campaign=hdr&hdrOutputEnabled=true#model=spheres'));
    const { DEFAULT_SETTINGS, writeHash } = await import('../src/store');
    writeHash({ ...DEFAULT_SETTINGS, hdrOutputEnabled: true, maxSamples: 128, denoise: false }, 'spheres');
    expect(location.pathname).toBe('/viewer/');
    expect(new URLSearchParams(location.search).has('webgl')).toBe(true);
    expect(new URLSearchParams(location.search).get('campaign')).toBe('hdr');
    expect(new URLSearchParams(location.search).has('hdrOutputEnabled')).toBe(false);
    expect(new URLSearchParams(location.hash.slice(1)).get('model')).toBe('spheres');
    expect(readURLSettings()).toEqual({ hdrOutputEnabled: true, maxSamples: 128, denoise: false });

    // Returning to a default must remain explicit, overriding a recipient who saved true/128/false.
    writeHash(DEFAULT_SETTINGS, 'spheres');
    expect(readURLSettings()).toEqual({ hdrOutputEnabled: false, maxSamples: 64, denoise: true });
    localStorage.setItem('mutracer-viewer:render:v6', JSON.stringify({ hdrOutputEnabled: true, maxSamples: 128, denoise: false }));
    vi.resetModules();
    const { useViewer } = await import('../src/store');
    expect(useViewer.getState().settings).toMatchObject({ hdrOutputEnabled: false, maxSamples: 64, denoise: true });
  });

  it('retains explicit defaults and the model when first normalizing an incoming query', async () => {
    vi.stubGlobal('location', new URL('https://viewer.example.com/viewer/?hdrOutputEnabled=false&maxSamples=64#model=dragon'));
    const { useViewer, writeHash, hashModelPreset } = await import('../src/store');
    writeHash(useViewer.getState().settings, hashModelPreset());
    expect(location.hash).toContain('hdrOutputEnabled=false');
    expect(location.hash).toContain('maxSamples=64');
    expect(hashModelPreset()).toBe('dragon');
  });
});
