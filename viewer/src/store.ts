import { create } from 'zustand';
import { DEFAULT_JNLM_OPTIONS } from '@meimu/mutracer';
import type { BVHBuilder, OIDNModel, SamplingPattern, ToneMapping, DisplayChannel, AovKind, AovIdComponent } from '@meimu/mutracer';
import type { TextureSampling } from './engine/modelCache';
import type { MaterialValues, TextureKey } from './engine/materialParams';
import { STUDIO_PRESETS } from './engine/studio';
import { DEFAULT_SKY_TIME, SKY_TIME_RANGE } from './engine/sky';
import { historyLabels, onHistoryChange, pushHistory, type HistoryItem } from './history';
import { readURLSettings, URL_SETTINGS_FIELDS } from './urlSettings';

export const VIEWER_AOVS: AovKind[] = ['depth', 'position', 'roughness', 'diffuseAlbedo', 'specularAlbedo', 'id', 'motion'];

export type EnvResolution = '1k' | '2k' | '4k';

export type LightingMode = 'environment' | 'studio';

export interface Settings {
  /** Image-based lighting from the HDRI, or rect-light studio rigs. */
  lighting: LightingMode;
  studioPreset: string;
  /** Scales every studio light; `1` is the preset as designed. */
  studioIntensity: number;
  studioRotation: number;
  /** Scales every panel; radiance compensates so exposure stays the same. */
  studioSize: number;
  /** Radiance of the dim ambient fill around the rig. */
  studioAmbient: number;
  /** Tint of the ambient fill and the studio backdrop. */
  studioAmbientColor: string;
  envId: string;
  envIntensity: number;
  envRotation: number;
  /** Local solar time of the procedural sky, in hours. */
  skyTime: number;
  envResolution: EnvResolution;
  background: 'environment' | 'grounded' | 'color' | 'transparent';
  /**
   * Grounded skybox capture height and dome radius in meters (glTF units);
   * `null` follows {@link autoGroundedSkybox}.
   */
  groundedHeight: number | null;
  groundedRadius: number | null;
  backgroundColor: string;
  groundShadow: boolean;
  groundOpacity: number;

  maxSamples: number;
  bounces: number;
  caustics: boolean;
  causticLightTracing:boolean;
  causticPhotonMapping:boolean;
  resolutionScale: number;
  /** Fixed render height that keeps the viewport's shape; overrides resolutionScale. */
  resolutionHeight: number | null;
  samplingPattern: SamplingPattern;
  bvhBuilder: BVHBuilder;
  clamping: number;
  denoise: boolean;
  /** `jnlm` is the built-in filter; the others are OIDN networks. */
  denoiseModel: OIDNModel | 'jnlm';
  denoiseWhileConverging: boolean;
  jnlmStrength: number;
  jnlmSearchRadius: number;
  jnlmPatchRadius: number;
  jnlmAlbedoBandwidth: number;
  jnlmNormalBandwidth: number;
  jnlmIterations: number;
  /** Remember the OIDN model while JNLM is selected. */
  oidnModel: OIDNModel;
  /** Zero lets OIDN choose the tile size. */
  oidnMaxTileSize: number;
  toneMapping: ToneMapping;
  /** Extended-range display on compatible WebGPU browsers. Default false. */
  hdrOutputEnabled: boolean;
  exposure: number;
  contrast: number;
  saturation: number;
  temperature: number;
  tint: number;
  bloomIntensity: number;
  bloomThreshold: number;
  bloomRadius: number;
  vignette: number;
  output: DisplayChannel;
  aovDepthFar: number;
  aovPositionScale: number;
  aovMotionScale: number;
  aovIdComponent: AovIdComponent;
  previewEnabled: boolean;
  previewMaxResolutionScale: number;

  /** `-1` is the orbit camera; otherwise an index into the model's cameras. */
  cameraIndex: number;
  /** Projection of the orbit camera. */
  projection: 'perspective' | 'orthographic';
  fov: number;
  /** Lens f-number; `0` turns depth of field off. */
  fStop: number;
  /** Distance to the focus plane along the view direction, in scene units. */
  focusDistance: number;
  /** Follow the subject in the focus area instead of a fixed distance. */
  autoFocus: boolean;
  /** Scene unit length in metres; `null` follows the guess from the model size. */
  metersPerUnit: number | null;
  autoRotate: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  lighting: 'environment',
  studioPreset: 'three-point',
  studioIntensity: 1,
  studioRotation: 0,
  studioAmbient: 0.1,
  studioAmbientColor: '#ffffff',
  studioSize: 1,
  envId: 'sky',
  envIntensity: 1,
  envRotation: 0,
  skyTime: DEFAULT_SKY_TIME,
  envResolution: '1k',
  background: 'environment',
  backgroundColor: '#2a2b30',
  groundedHeight: null,
  groundedRadius: null,
  groundShadow: true,
  groundOpacity: 0.8,
  maxSamples: 64,
  bounces: 6,
  caustics: false,
  causticLightTracing:true,causticPhotonMapping:false,
  resolutionScale: 0.5,
  resolutionHeight: null,
  samplingPattern: 'sobol',
  // Dropped models can be large; TinyBVH's WebAssembly builder is faster.
  bvhBuilder: 'tinybvh',
  clamping: 0,
  denoise: true,
  denoiseModel: 'standard',
  denoiseWhileConverging: true,
  jnlmStrength: DEFAULT_JNLM_OPTIONS.strength,
  jnlmSearchRadius: DEFAULT_JNLM_OPTIONS.searchRadius,
  jnlmPatchRadius: DEFAULT_JNLM_OPTIONS.patchRadius,
  jnlmAlbedoBandwidth: DEFAULT_JNLM_OPTIONS.albedoBandwidth,
  jnlmNormalBandwidth: DEFAULT_JNLM_OPTIONS.normalBandwidth,
  jnlmIterations: DEFAULT_JNLM_OPTIONS.iterations,
  oidnModel: 'standard',
  oidnMaxTileSize: 0,
  toneMapping: 'agx',
  hdrOutputEnabled: false,
  exposure: 1,
  contrast: 1,
  saturation: 1,
  temperature: 0,
  tint: 0,
  bloomIntensity: 0,
  bloomThreshold: 1,
  bloomRadius: 0.6,
  vignette: 0,
  output: 'final',
  aovDepthFar: 10,
  aovPositionScale: 1,
  aovMotionScale: 16,
  aovIdComponent: 'object',
  previewEnabled: true,
  previewMaxResolutionScale: 0.5,
  cameraIndex: -1,
  projection: 'perspective',
  fov: 35,
  fStop: 0,
  focusDistance: 5,
  autoFocus: true,
  metersPerUnit: null,
  autoRotate: false
};

/**
 * Grounded skybox projection for a model of the given bounding radius, with
 * an optional manual height. Small models keep the typical 1.6 m tripod
 * height of an HDRI capture. Larger models raise the projection so they stay
 * on the clean ground near the capture point instead of reaching walls and
 * furniture, which the projection flattens onto the floor.
 */
export function autoGroundedSkybox(modelRadius: number, height: number | null = null) {
  const h = height ?? Math.max(1.6, 4 * modelRadius);
  return { height: h, radius: 20 * h };
}

export type RenderPhase = 'starting' | 'preparing' | 'compiling' | 'previewing' | 'converging' | 'denoising' | 'finished' | 'paused' | 'error';

export interface Stats {
  phase: RenderPhase;
  samples: number;
  elapsed: number;
  msPerSample: number;
  width: number;
  height: number;
}

export interface TreeNode {
  id: string;
  name: string;
  kind: 'group' | 'mesh' | 'light' | 'camera';
  visible: boolean;
  triangles: number;
  children: TreeNode[];
  materials: { id: string; name: string; color: string }[];
}

/** Environment map download, shown in the Lighting panel. */
export interface EnvLoadingState {
  id: string;
  name: string;
  loaded: number;
  total: number;
}

export interface LoadingState {
  name: string;
  stage: 'download' | 'parse' | 'bvh' | 'shaders';
  loaded: number;
  total: number;
}

export interface AnimationState {
  clips: string[];
  clip: number;
  playing: boolean;
  time: number;
  duration: number;
  speed: number;
  loop: boolean;
}

export interface SelectedMaterial {
  id: string;
  name: string;
  meshName: string;
  users: number;
  values: MaterialValues;
  textures: string[];
  /** Texture in each slot, as a thumbnail URL; `''` when it cannot be drawn. */
  maps: Partial<Record<TextureKey, string>>;
  sampling: Partial<Record<TextureKey, TextureSampling>>;
  /** Suggested local-unit slider range for the selected mesh, without limiting typed values. */
  displacementRange: { min: number; max: number; step: number };
}

/**
 * Autofocus area in viewport coordinates (0..1 from the top left) and the
 * state of the last measurement, shown by the focus frame.
 */
export interface FocusAreaState {
  x: number;
  y: number;
  status: 'idle' | 'focusing' | 'locked' | 'missed';
  /** Increments with each measurement so the frame replays its animation. */
  attempt: number;
}

/** Lens derived from the active camera, for display. */
export interface LensInfo {
  /** Focal length in millimetres; `0` for orthographic views. */
  focalLength: number;
  /** Scene unit guessed from the model size, in metres. */
  guessedMetersPerUnit: number;
}

export type InspectorTab = 'environment' | 'material' | 'camera' | 'render';

export type ToastTone = 'info' | 'success' | 'warning' | 'error';

export interface ViewerState {
  settings: Settings;
  stats: Stats;
  backend: { name: 'WebGPU' | 'WebGL 2' | null; adapter: string };
  model: { name: string; presetId: string | null; credit: string | null; sourceUrl: string | null } | null;
  tree: TreeNode[];
  sceneInfo: { meshes: number; triangles: number; materials: number };
  cameras: string[];
  modelLighting: { available: boolean; warnings: string[] } | null;
  loading: LoadingState | null;
  envLoading: EnvLoadingState | null;
  /** Bounding radius of the loaded model in scene units. */
  modelRadius: number;
  error: string | null;
  toast: { id: number; message: string; tone: ToastTone; actions?: { label: string; onClick(): void }[] } | null;
  animation: AnimationState | null;
  selection: { objectId: string | null; materialId: string | null };
  material: SelectedMaterial | null;
  /** Labels of the material edits that undo and redo would apply. */
  history: { undo: string | null; redo: string | null };
  selectionRect: { x: number; y: number; w: number; h: number; label: string } | null;
  pickingFocus: boolean;
  focusArea: FocusAreaState;
  lens: LensInfo;
  paused: boolean;
  ui: {
    tab: InspectorTab; left: boolean; right: boolean; hidden: boolean; focusFrame: boolean;
    /** Viewport debug overlay expanded. */
    debug: boolean;
    exportOpen: boolean; codeOpen: boolean; helpOpen: boolean; textureBrowser: boolean;
    examplesPinned: boolean; examplesOpen: boolean; examplesCollection: 'models' | 'research' | null;
    mobileTab: InspectorTab | 'scene';
  };
  export: { stage: 'pilot' | 'final' | 'denoising'; samples: number; target: number } | null;
}

const UI_KEY = 'mutracer-viewer:ui';
const RENDER_KEY = 'mutracer-viewer:render:v6';
const RENDER_FIELDS: (keyof Settings)[] = [
  'envResolution', 'maxSamples', 'bounces', 'caustics', 'causticLightTracing','causticPhotonMapping', 'resolutionScale', 'resolutionHeight', 'samplingPattern', 'bvhBuilder', 'denoise', 'denoiseModel', 'denoiseWhileConverging',
  'jnlmStrength', 'jnlmSearchRadius', 'jnlmPatchRadius', 'jnlmAlbedoBandwidth', 'jnlmNormalBandwidth', 'jnlmIterations',
  'oidnModel', 'oidnMaxTileSize',
  'toneMapping', 'hdrOutputEnabled', 'previewEnabled', 'previewMaxResolutionScale'
];

function readStorage<T>(key: string): Partial<T> {
  try {
    return JSON.parse(localStorage.getItem(key) || '{}') as Partial<T>;
  } catch {
    return {};
  }
}

function writeStorage(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage can be unavailable (private mode); preferences are optional.
  }
}

export function writeHash(settings: Settings, modelPreset: string | null) {
  const search = new URLSearchParams(location.search);
  const previous = new URLSearchParams(location.hash.slice(1));
  const params = new URLSearchParams();
  if (modelPreset) params.set('model', modelPreset);
  for (const key of URL_SETTINGS_FIELDS) {
    // Keep explicit defaults (especially false), so they still override the recipient's preferences.
    if (settings[key] !== DEFAULT_SETTINGS[key] || search.has(key) || previous.has(key)) params.set(key, String(settings[key]));
    // Move overrides to the hash so later UI edits cannot leave a stale query override behind.
    search.delete(key);
  }
  const hash = params.toString();
  const query = search.toString();
  history.replaceState(null, '', location.pathname + (query ? `?${query}` : '') + (hash ? `#${hash}` : ''));
}

export const hashModelPreset = () => new URLSearchParams(location.hash.slice(1)).get('model');

function validateSettings(settings: Settings): Settings {
  const allowed: ToneMapping[] = ['agx', 'aces', 'cineon', 'reinhard', 'linear'];
  const oidnModels: OIDNModel[] = ['standard', 'small', 'cleanAuxLarge'];
  const denoiseModel = settings.denoiseModel === 'jnlm' || oidnModels.includes(settings.denoiseModel) ? settings.denoiseModel : DEFAULT_SETTINGS.denoiseModel;
  const number = (key: keyof Settings, min: number, max: number, integer = false) => {
    const value = settings[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_SETTINGS[key] as number;
    const clamped = Math.min(max, Math.max(min, value));
    return integer ? Math.round(clamped) : clamped;
  };
  return {
    ...settings,
    caustics: settings.caustics === true,
    causticLightTracing: settings.causticLightTracing===true,causticPhotonMapping:settings.causticPhotonMapping===true,
    output: settings.output === 'shadow' ? 'final' : settings.output,
    lighting: settings.lighting === 'studio' ? 'studio' : 'environment',
    studioPreset: STUDIO_PRESETS.some((p) => p.id === settings.studioPreset) ? settings.studioPreset : DEFAULT_SETTINGS.studioPreset,
    studioIntensity: number('studioIntensity', 0, 20),
    studioAmbient: number('studioAmbient', 0, 2),
    studioSize: number('studioSize', 0.1, 4),
    skyTime: number('skyTime', SKY_TIME_RANGE[0], SKY_TIME_RANGE[1]),
    studioAmbientColor: /^#[0-9a-f]{6}$/i.test(settings.studioAmbientColor) ? settings.studioAmbientColor : DEFAULT_SETTINGS.studioAmbientColor,
    toneMapping: allowed.includes(settings.toneMapping) ? settings.toneMapping : 'agx',
    hdrOutputEnabled: settings.hdrOutputEnabled === true,
    fStop: settings.fStop > 0 ? number('fStop', 0.5, 64) : 0,
    metersPerUnit: typeof settings.metersPerUnit === 'number' && settings.metersPerUnit > 0 && Number.isFinite(settings.metersPerUnit)
      ? settings.metersPerUnit : null,
    bvhBuilder: settings.bvhBuilder === 'builtin' ? 'builtin' : 'tinybvh',
    denoiseModel,
    oidnModel: denoiseModel !== 'jnlm' ? denoiseModel : oidnModels.includes(settings.oidnModel) ? settings.oidnModel : 'standard',
    oidnMaxTileSize: [0, 256, 512, 1024, 2048].includes(settings.oidnMaxTileSize) ? settings.oidnMaxTileSize : 0,
    jnlmStrength: number('jnlmStrength', 0.1, 3),
    jnlmSearchRadius: number('jnlmSearchRadius', 1, 16, true),
    jnlmPatchRadius: number('jnlmPatchRadius', 0, 3, true),
    jnlmAlbedoBandwidth: number('jnlmAlbedoBandwidth', 0.0001, 10),
    jnlmNormalBandwidth: number('jnlmNormalBandwidth', 0.0001, 10),
    jnlmIterations: number('jnlmIterations', 1, 4, true)
  };
}

const storedUi = readStorage<ViewerState['ui']>(UI_KEY);

export const useViewer = create<ViewerState>(() => ({
  settings: validateSettings({ ...DEFAULT_SETTINGS, ...readStorage<Settings>(RENDER_KEY), ...readURLSettings() }),
  stats: { phase: 'starting', samples: 0, elapsed: 0, msPerSample: 0, width: 0, height: 0 },
  backend: { name: null, adapter: '' },
  model: null,
  tree: [],
  sceneInfo: { meshes: 0, triangles: 0, materials: 0 },
  cameras: [],
  modelLighting: null,
  loading: null,
  envLoading: null,
  modelRadius: 1,
  error: null,
  toast: null,
  animation: null,
  selection: { objectId: null, materialId: null },
  material: null,
  history: { undo: null, redo: null },
  selectionRect: null,
  pickingFocus: false,
  focusArea: { x: 0.5, y: 0.5, status: 'idle', attempt: 0 },
  lens: { focalLength: 0, guessedMetersPerUnit: 1 },
  paused: false,
  ui: {
    tab: storedUi.tab ?? 'material',
    left: storedUi.left ?? true,
    right: storedUi.right ?? true,
    hidden: false,
    focusFrame: storedUi.focusFrame !== false,
    debug: storedUi.debug === true,
    exportOpen: false,
    codeOpen: false,
    helpOpen: false,
    textureBrowser: false,
    examplesPinned: storedUi.examplesPinned === true,
    examplesOpen: false,
    examplesCollection: null,
    mobileTab: storedUi.tab ?? 'material'
  },
  export: null
}));

/** Camera settings follow the view and are not undoable. */
const UNDOABLE_EXCLUDED = new Set<keyof Settings>(['cameraIndex', 'projection', 'fov', 'fStop', 'focusDistance', 'autoFocus', 'metersPerUnit', 'autoRotate']);

const SETTING_LABELS: Partial<Record<keyof Settings, string>> = {
  lighting: 'Lighting mode', studioPreset: 'Studio preset', studioIntensity: 'Studio intensity', studioRotation: 'Studio rotation',
  studioSize: 'Studio light size', studioAmbient: 'Studio ambient', studioAmbientColor: 'Ambient color', envId: 'Environment',
  envIntensity: 'Environment intensity', envRotation: 'Environment rotation', skyTime: 'Time of day', envResolution: 'Environment resolution',
  background: 'Background', backgroundColor: 'Background color', groundedHeight: 'Grounded height', groundedRadius: 'Grounded radius',
  groundShadow: 'Ground shadow', groundOpacity: 'Ground opacity', maxSamples: 'Samples', resolutionScale: 'Resolution', resolutionHeight: 'Resolution',
  bvhBuilder: 'BVH builder', denoise: 'Denoise', denoiseModel: 'Denoiser', denoiseWhileConverging: 'Denoise while converging',
  toneMapping: 'Tone mapping', hdrOutputEnabled: 'HDR output', bloomIntensity: 'Bloom intensity', bloomThreshold: 'Bloom threshold',
  bloomRadius: 'Bloom radius', previewEnabled: 'Interactive preview', previewMaxResolutionScale: 'Preview resolution',
  samplingPattern: 'Sampling pattern', oidnModel: 'OIDN model', oidnMaxTileSize: 'OIDN tile size', temperature: 'Temperature',
  jnlmStrength: 'JNLM strength', jnlmSearchRadius: 'JNLM search radius', jnlmPatchRadius: 'JNLM patch radius',
  jnlmAlbedoBandwidth: 'JNLM albedo tolerance', jnlmNormalBandwidth: 'JNLM normal tolerance', jnlmIterations: 'JNLM passes'
};

/** Undo label of a settings change; "clamping" -> "Clamping" when no label is defined. */
function settingLabel(keys: (keyof Settings)[]) {
  if (keys.length > 1 && keys.every((k) => k === 'groundedHeight' || k === 'groundedRadius')) return 'Grounded projection';
  if (keys.length > 1 && keys.every((k) => k.startsWith('jnlm'))) return 'JNLM settings';
  if (keys.includes('oidnMaxTileSize') && keys.length > 1) return 'OIDN settings';
  const key = keys[0];
  const label = SETTING_LABELS[key] ?? key.replace(/[A-Z]/g, (c) => ` ${c.toLowerCase()}`);
  return label[0].toUpperCase() + label.slice(1);
}

function applySettings(patch: Partial<Settings>) {
  useViewer.setState((s) => ({ settings: validateSettings({ ...s.settings, ...patch }) }));
}

/**
 * Changes settings from the UI. Lighting and render changes are undo steps;
 * pass `record: false` for programmatic changes.
 */
export function setSettings(patch: Partial<Settings>, { record = true } = {}) {
  const previous = useViewer.getState().settings;
  applySettings(patch);
  if (!record) return;
  const next = useViewer.getState().settings;
  // An uploaded environment ('custom') cannot be restored from settings alone.
  const keys = (Object.keys(patch) as (keyof Settings)[]).filter((key) => !UNDOABLE_EXCLUDED.has(key) &&
    previous[key] !== next[key] && !(key === 'envId' && (previous.envId === 'custom' || next.envId === 'custom')));
  if (!keys.length) return;
  const pick = (settings: Settings) => Object.fromEntries(keys.map((key) => [key, settings[key]])) as Partial<Settings>;
  pushHistory(new SettingsEdit(keys, pick(previous), pick(next)));
}

/** Restores every setting to its default; the lighting and render part is an undo step. */
export function resetSettings() {
  setSettings(DEFAULT_SETTINGS);
}

class SettingsEdit implements HistoryItem {
  readonly scope = 'settings';
  readonly label: string;
  readonly mergeKey: string;
  constructor(private readonly keys: (keyof Settings)[], private readonly before: Partial<Settings>, private after: Partial<Settings>) {
    this.label = settingLabel(keys);
    this.mergeKey = `settings:${[...keys].sort().join(',')}`;
  }
  undo() { applySettings(this.before); }
  redo() { applySettings(this.after); }
  merge(next: HistoryItem) {
    if (!(next instanceof SettingsEdit)) return true;
    this.after = next.after;
    return this.keys.some((key) => this.before[key] !== this.after[key]);
  }
}

onHistoryChange(() => useViewer.setState({ history: historyLabels() }));

export function setUi(patch: Partial<ViewerState['ui']>) {
  useViewer.setState((s) => ({ ui: { ...s.ui, ...patch } }));
}

export const RESOLUTION_HEIGHTS = [720, 1080, 1440, 2160];

/** The render scale for a canvas of this height. A fixed height can supersample small viewports. */
export function renderResolutionScale(s: Pick<Settings, 'resolutionScale' | 'resolutionHeight'>, canvasHeight: number) {
  return s.resolutionHeight === null ? s.resolutionScale : s.resolutionHeight / Math.max(1, canvasHeight);
}

let toastId = 0;
export function showToast(message: string, tone: ToastTone = 'info', actions?: NonNullable<ViewerState['toast']>['actions']) {
  useViewer.setState({ toast: { id: ++toastId, message, tone, actions } });
}

useViewer.subscribe((state, prev) => {
  if (state.ui !== prev.ui) {
    const { tab, left, right, focusFrame, debug, examplesPinned } = state.ui;
    writeStorage(UI_KEY, { tab, left, right, focusFrame, debug, examplesPinned });
  }
  if (state.settings !== prev.settings) {
    writeStorage(RENDER_KEY, Object.fromEntries(RENDER_FIELDS.map((key) => [key, state.settings[key]])));
  }
});
