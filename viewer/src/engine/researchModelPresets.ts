import type { ModelPreset } from './presets';
import presets from './model-presets.json';

export const RESEARCH_SCENES_SOURCE = 'https://github.com/ErfanMo77/gltf-research-scenes';

// Keep manifests and relative resources on the same revision across download origins.
const RESEARCH_SCENES_REVISION = 'ad46a7ecb3c8b0874d58aae93df69be5d51e960a';
const researchPresets = presets.filter((preset) => 'category' in preset && preset.category === 'research') as ModelPreset[];
export const RESEARCH_MODEL_PRESETS = researchPresets.map((preset) => ({
  ...preset,
  url: preset.url?.replace('/main/', `/${RESEARCH_SCENES_REVISION}/`) ?? null
}));
