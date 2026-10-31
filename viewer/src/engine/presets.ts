import type { EnvResolution } from '../store';
import type { ModelCamera } from './modelCamera';
import type { PresetStage } from '../presetSettings';
import { PUBLIC_MODEL_PRESETS } from './publicModelPresets';
import { RESEARCH_MODEL_PRESETS } from './researchModelPresets';

// Material swatches stay local.
const THUMBNAILS = import.meta.glob<string>('../assets/thumbnails/material-*.webp', { eager: true, query: '?url', import: 'default' });
export const thumbnailUrl = (name: string): string | undefined => THUMBNAILS[`../assets/thumbnails/${name}.webp`];

export interface ModelPreset {
  id: string;
  name: string;
  /** What the model is good for showing. */
  tag: string;
  /** `null` builds the procedural material-sphere scene. */
  url: string | null;
  thumbnail?: string;
  license: 'CC0' | 'CC-BY 3.0' | 'CC-BY 4.0' | 'CC-BY-NC 4.0' | 'CC-BY-NC-SA 4.0' | 'Mixed (see source)';
  licenseUrl?: string;
  attributionUrl?: string;
  nonCommercial?: boolean;
  /** Author attribution shown in the viewport for assets requiring credit. */
  credit: string;
  sourceUrl: string;
  sizeMB?: number;
  /** Default preview view in grounded model coordinates. */
  camera?: ModelCamera;
  /** Default stage and lighting, applied the first time the example opens. */
  stage?: PresetStage;
  category?: 'research';
}

export const MODEL_PRESETS: ModelPreset[] = [...PUBLIC_MODEL_PRESETS, ...RESEARCH_MODEL_PRESETS];

export interface EnvironmentPreset {
  id: string;
  name: string;
  /** `false` is the procedural sky. */
  polyHaven: boolean;
  thumbnail: string | null;
}

const polyHaven = (id: string, name: string): EnvironmentPreset => ({
  id, name, polyHaven: true,
  thumbnail: `https://cdn.polyhaven.com/asset_img/thumbs/${id}.png?width=256`
});

/** Poly Haven serves every HDRI at several widths; 1K is about 1.5 MB, 4K about 25 MB. */
export const ENV_RESOLUTIONS: { value: EnvResolution; label: string; size: string }[] = [
  { value: '1k', label: '1K', size: '~1.5 MB' },
  { value: '2k', label: '2K', size: '~6 MB' },
  { value: '4k', label: '4K', size: '~25 MB' }
];

export function environmentUrl(preset: EnvironmentPreset, resolution: EnvResolution) {
  return preset.polyHaven
    ? `https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/${resolution}/${preset.id}_${resolution}.hdr`
    : null;
}

/** Poly Haven HDRIs are CC0. */
export const ENVIRONMENT_PRESETS: EnvironmentPreset[] = [
  { id: 'sky', name: 'Procedural sky', polyHaven: false, thumbnail: null },
  polyHaven('studio_small_09', 'Studio'),
  polyHaven('empty_warehouse_01', 'Warehouse'),
  polyHaven('venice_sunset', 'Venice Sunset'),
  polyHaven('spruit_sunrise', 'Spruit Sunrise'),
  polyHaven('nature_reserve_forest', 'Forest'),
  polyHaven('lebombo', 'Lebombo'),
  polyHaven('snowy_field', 'Snowy Field'),
  polyHaven('moonless_golf', 'Night')
];
