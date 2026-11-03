import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => vi.stubGlobal('location', { search: '', hash: '' }));
vi.mock('../src/engine/ViewerEngine', () => ({ getEngine: () => null }));

import { RenderPanel } from '../src/components/panels/RenderPanel';
import { DEFAULT_SETTINGS, useViewer } from '../src/store';

describe('render depth control', () => {
  it.each([['WebGPU', 50], ['WebGL 2', 20]] as const)('allows the %s backend limit of %i', (name, limit) => {
    Object.assign(useViewer.getInitialState(), {
      settings: { ...DEFAULT_SETTINGS, bounces: limit }, backend: { name }
    });
    const markup = renderToStaticMarkup(createElement(RenderPanel));
    const slider = markup.match(/role="slider"[^>]*aria-label="Bounces"[^>]*/)?.[0];
    expect(slider).toContain(`aria-valuemax="${limit}"`);
    expect(slider).toContain(`aria-valuenow="${limit}"`);
    expect(markup).toContain(`aria-label="Bounces" inputMode="decimal" value="${limit}"`);
  });
});
