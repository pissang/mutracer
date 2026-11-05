import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => vi.stubGlobal('location', { search: '', hash: '' }));

// Rendering this panel needs no running GPU engine.
vi.mock('../src/engine/ViewerEngine', () => ({ getEngine: () => null }));

import { EnvironmentPanel } from '../src/components/panels/EnvironmentPanel';
import { DEFAULT_SETTINGS, useViewer } from '../src/store';

describe('scene-lighting choice', () => {
  it.each([null, false, true])('offers the choice only with available scene lighting (%s)', (available) => {
    // Zustand renders its initial snapshot on the server.
    Object.assign(useViewer.getInitialState(), {
      settings: { ...DEFAULT_SETTINGS, lighting: 'environment', envId: 'sky' },
      modelLighting: available === null ? null : { available, warnings: [] }
    });
    const markup = renderToStaticMarkup(createElement(EnvironmentPanel));
    expect(markup.includes('Scene lighting')).toBe(available === true);
    expect(markup).toContain('Upload .hdr');
    expect(markup).toContain('Environment map');
  });
});
