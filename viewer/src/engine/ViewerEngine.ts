import {causticOptions} from '../caustics';
import {presetSettings} from '../presetSettings';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  Engine, Render, RenderLoop, Sync, ProceduralSky,
  THREESync, type DisplaySettings,
  fromTHREECamera,
} from '@meimu/mutracer';
import { VIEWER_AOVS, DEFAULT_SETTINGS, autoGroundedSkybox, resetSettings, setSettings, useViewer, showToast, writeHash, type RenderPhase, type Settings, type TreeNode } from '../store';
import { Environment, loadHDR, parseHDR, type EquirectData } from './environment';
import { ENVIRONMENT_PRESETS, MODEL_PRESETS, environmentUrl } from './presets';
import {
  createMaterialSpheres, isHDRFile, loadModelFromFiles, loadModelFromURL, loadModelFromSource,
  isModelFile, type LoadedModel, type PathedFile
} from './loadModel';
import { MATERIAL_BASE, TEXTURE_KEYS, type MaterialValues, type TextureKey } from './materialParams';
import type { MapPlan } from './materialx';
import { isMaterialXFile } from './droppedFiles';

/** MaterialX import is still experimental: only development builds offer it. */
export const MATERIALX_IMPORT = import.meta.env.DEV;
import { displacementHeightRange } from './displacementHeightRange';
import { downloadPolyHavenMap, polyHavenMaps, type TextureResolution } from './polyHaven';
import type { TextureSampling } from './modelCache';
import { clearMaterialEdits, clearModelCache, readModelCache, saveModelCache, type CachedModel } from './modelCache';
import { MaterialEditor, readPendingEdits, type PendingEdits } from './materialEditor';
import { cameraSettings, readCameraState, writeCameraState } from './cameraState';
import { readURLSettings, URL_SETTINGS_FIELDS } from '../urlSettings';
import { readModelCamera } from './modelCamera';
import { pushHistory, recordGroup } from '../history';
import { groundModel } from './modelGrounding';
import { DENOISER_FIELDS, getDenoiserOptions } from './denoiserSettings';
import { buildStudioRig, createStudioAmbient, findStudioPreset } from './studio';
import { FOCUS_AREA_SIZE, focusPull, guessMetersPerUnit, pickFocusDepth } from './areaFocus';
import { formatForAgent, generateCode } from './codeSnippet';

export interface ExportOptions {
  width: number;
  height: number;
  samples: number;
  transparent: boolean;
}

// The weights live at the server root: development serves the repository's
// copy there, `build:viewer` emits them at the root of dist-viewer/, and the
// site build (viewer under /viewer/) shares one copy with the examples.
const OIDN_WEIGHTS = new URL('/oidn/weights/', document.baseURI).href;
const get = useViewer.getState;
const set = useViewer.setState;
const INITIAL_LIGHTING = Object.fromEntries(Object.entries(readURLSettings())
  .filter(([key]) => ['lighting', 'envId', 'envIntensity', 'envRotation'].includes(key)));

type ViewCamera = THREE.PerspectiveCamera | THREE.OrthographicCamera;
const isOrthographic = (camera: THREE.Object3D): camera is THREE.OrthographicCamera =>
  (camera as THREE.OrthographicCamera).isOrthographicCamera === true;

/** f-number used when depth of field is turned on from a focus pick. */
export const DEFAULT_F_STOP = 2.8;
/** Autofocus waits this long after the view or the focus area last changed. */
const AUTOFOCUS_SETTLE_MS = 160;
/** Interval of continuous autofocus while the scene or the view keeps moving. */
const AUTOFOCUS_TRACK_MS = 280;

/**
 * Owns the MuTracer renderer, the Three.js source scene and the render loop.
 * Reads settings from the store and publishes stats, tree and selection to it;
 * it does not depend on React.
 */
export class ViewerEngine {
  readonly engine: Engine;
  readonly preview: Render;
  readonly final: Render;
  readonly loop: RenderLoop;
  private readonly viewSync: Sync;
  private displayed?: Render;
  private readonly canvas: HTMLCanvasElement;
  private readonly scene = new THREE.Scene();
  private readonly perspectiveCamera = new THREE.PerspectiveCamera(35, 1, 0.01, 1000);
  private readonly orthographicCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 1000);
  private readonly controls: OrbitControls;
  private readonly ground: THREE.Mesh;
  private readonly modelGroup = new THREE.Group();
  private readonly sky = new ProceduralSky({ time: get().settings.skyTime });
  private readonly environment = new Environment({ data: new Float32Array([0, 0, 0, 1]), width: 1, height: 1 });
  private modelEnvironment: Environment | null = null;
  private readonly studioAmbient = new Environment(createStudioAmbient());
  private readonly studioRig = new THREE.Group();
  private sync: THREESync;
  private model: LoadedModel | null = null;
  private modelCameras: ViewCamera[] = [];
  /** Objects hidden in the loaded file, restored by {@link resetAll}. */
  private hiddenAtLoad = new Set<string>();
  private polyHavenPicks = 0;
  private readonly materials = new MaterialEditor((materialId) => {
    // Show the material an undo or redo changed.
    if (get().selection.materialId === materialId) return;
    const meshId = this.materials.firstMesh(materialId);
    if (meshId) this.select(meshId, materialId);
  });
  private mixer: THREE.AnimationMixer | null = null;
  private action: THREE.AnimationAction | null = null;
  private settings: Settings;
  private raf = 0;
  private lastTime = 0;
  private lastPublish = 0;
  private sampleStart = 0;
  private lastSamples = 0;
  private lastSampleTime = 0;
  private needsResize = true;
  private loadToken = 0;
  private modelId: string | null = null;
  private cameraSaveTimer: ReturnType<typeof setTimeout> | undefined;
  private envToken = 0;
  private envAbort?: AbortController;
  private dragging = false;
  private awaitingFirstSample = false;
  private exporting = false;
  private exportAbort: AbortController | null = null;
  private denoiserUpdateTimer?: ReturnType<typeof setTimeout>;
  private pointerDown: { x: number; y: number } | null = null;
  /** Focus pull in progress; the settings hold its target only once it ends. */
  private pull: { from: number; to: number; start: number } | null = null;
  /** The current focus pull writes its target to the settings. */
  private writingFocus = false;
  private autofocusPending = true;
  private lastViewChange = 0;
  private lastAutofocus = 0;
  private focusQueryInFlight = false;
  private focusQueryVersion = 0;
  private manualFocus: { x: number; y: number } | null = null;
  private disposed = false;
  private readonly unsubscribe: () => void;
  private readonly resizeObserver: ResizeObserver;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.settings = get().settings;
    this.engine = new Engine({canvas, backend: new URLSearchParams(location.search).has('webgl') ? 'webgl' : 'auto'});
    this.preview = new Render(this.engine, {resolutionScale: .5, timeBudgetMs: 80, adaptiveResolution: {targetFrameMs: 80, minScale: .125}, maxSamples: 1,
      bounces: 2, bevel: false, dispersionWavelengths: 1, directLightCandidates: 2});
    this.final = new Render(this.engine, {fallback: this.preview, batchSamples: true});
    this.engine.on('error', error => showToast(`Rendering failed: ${error.message}`, 'error'));

    this.scene.add(this.modelGroup);
    this.studioRig.name = 'Studio lights';
    this.scene.add(this.studioRig);
    this.scene.environment = this.environment.texture;
    const groundMaterial = new THREE.MeshStandardMaterial({ color: 0x808080, roughness: 1 });
    groundMaterial.userData.mutracerShadowCatcher = true;
    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), groundMaterial);
    this.ground.name = 'Ground';
    this.scene.add(this.ground);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.2;
    this.controls.addEventListener('start', () => {
      this.dragging = true;
      this.beginOrbit();
    });
    this.controls.addEventListener('change', () => {
      if (get().paused) set({ paused: false });
    });
    this.controls.addEventListener('end', () => { this.dragging = false; });
    this.controls.addEventListener('change', this.scheduleCameraSave);
    this.controls.addEventListener('change', this.requestAutofocus);
    this.camera.position.set(3, 2, 5);

    this.sync = this.createSync();
    const owner = this;
    this.viewSync = new class extends Sync {
      update() {
        if (this.engine.camera) this.engine.camera.copy(owner.lensCamera(owner.activeCamera(), owner.advanceFocus(performance.now())));
      }
      get active() { return !!get().animation?.playing || owner.pull !== null; }
    }(this.engine);
    this.loop = new RenderLoop(this.engine, {preview: this.preview, final: this.final, sync: [this.sync, this.viewSync]});
    this.loop.select = ({changing}) => this.settings.previewEnabled && changing ? 'preview' : 'final';
    this.applySettings(this.settings, null);
    void this.engine.init().then(info => {
      if (this.disposed) return;
      set({ backend: { name: info.backend === 'webgpu' ? 'WebGPU' : 'WebGL 2', adapter: shortAdapterName(info.adapterName) } });
      return this.updateDenoiser();
    }).catch(() => {});
    this.unsubscribe = useViewer.subscribe((state, prev) => {
      if (state.settings !== prev.settings) {
        const before = this.settings;
        this.settings = state.settings;
        this.applySettings(state.settings, before);
        this.scheduleCameraSave();
      }
      if (state.focusArea.x !== prev.focusArea.x || state.focusArea.y !== prev.focusArea.y) this.requestAutofocus();
    });

    this.resizeObserver = new ResizeObserver(() => { this.needsResize = true; });
    this.resizeObserver.observe(canvas);
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('pagehide', this.saveCamera);
    window.addEventListener('pagehide', this.flushMaterials);

    this.raf = requestAnimationFrame(this.frame);
  }

  dispose() {
    this.disposed = true;
    ++this.focusQueryVersion;
    clearTimeout(this.denoiserUpdateTimer);
    this.saveCamera();
    ++this.loadToken;
    this.cancelEnvironmentDownload();
    window.removeEventListener('pagehide', this.saveCamera);
    window.removeEventListener('pagehide', this.flushMaterials);
    this.materials.flush();
    cancelAnimationFrame(this.raf);
    this.unsubscribe();
    this.resizeObserver.disconnect();
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.controls.dispose();
    this.clearModel();
    this.loop.dispose(); this.sync.dispose(); this.viewSync.dispose();
    this.environment.dispose();
    this.studioAmbient.dispose();
    this.engine.dispose();
  }

  // ---------------------------------------------------------------- loading

  /** Explicit links win; otherwise reopen the sole cached model. */
  async loadInitialModel(presetId: string | null) {
    const token = ++this.loadToken;
    const cached = await readModelCache();
    if (token !== this.loadToken) return;
    if (cached && (!presetId || cached.meta.presetId === presetId)) {
      const { meta } = cached;
      const loaded = await this.load(meta.name, (progress) => cached.source
        ? loadModelFromSource(cached.source, progress)
        : Promise.resolve(createMaterialSpheres()), meta, cached, false);
      if (loaded || token + 1 !== this.loadToken) return;
      await clearModelCache();
      if (token + 1 !== this.loadToken) return;
      if (!meta.presetId && meta.sourceUrl) {
        return this.load(meta.name, (progress) => loadModelFromURL(meta.sourceUrl!, progress), meta, cached);
      }
    }
    return this.loadPreset(presetId ?? 'spheres', true);
  }

  async loadPreset(id: string, restoreCamera = false) {
    const preset = MODEL_PRESETS.find((p) => p.id === id) ?? MODEL_PRESETS[0];
    // CC-BY models are credited in the viewport; CC0 ones only in the Examples menu.
    const meta = { presetId: preset.id, credit: preset.license !== 'CC0' ? `${preset.name} · ${preset.credit}` : null, sourceUrl: preset.sourceUrl };
    const restored = restoreCamera ? { id: `preset:${preset.id}`, meta: { name: preset.name, ...meta } } : undefined;
    return this.load(preset.name, async (progress) => {
      const model = preset.url ? await loadModelFromURL(preset.url, progress) : createMaterialSpheres();
      if (preset.category === 'research' && model.lighting) model.lighting.useByDefault = true;
      if (preset.camera) model.root.userData.mutracerCamera = preset.camera;
      return model;
    }, meta, restored);
  }

  /** Shows a model built in code (used by the thumbnail generator). */
  loadModel(model: LoadedModel) {
    return this.load(model.name, async () => model, { presetId: null, credit: null, sourceUrl: null });
  }

  loadUrl(url: string) {
    if (isHDRFile(url.split('?')[0])) return this.loadEnvironmentFromURL(url);
    return this.load(url.split('/').pop() || url, (progress) => loadModelFromURL(url, progress),
      { presetId: null, credit: null, sourceUrl: url });
  }

  async loadFiles(files: PathedFile[]) {
    if (MATERIALX_IMPORT && files.some((f) => isMaterialXFile(f.path)) && !files.some((f) => isModelFile(f.path))) {
      const material = get().material;
      if (!material) return showToast('Select a material to apply the MaterialX file to', 'error');
      return this.importMaterialX(material.id, files);
    }
    const hdr = files.find((f) => isHDRFile(f.path));
    const models = files.filter((f) => !isHDRFile(f.path));
    if (hdr) {
      try {
        this.setEnvironmentData(parseHDR(await hdr.file.arrayBuffer()), 'custom');
      } catch (error) {
        showToast(`Could not read ${hdr.file.name}: ${(error as Error).message}`, 'error');
      }
    }
    if (!models.some((f) => /\.(glb|gltf)$/i.test(f.path))) {
      if (!hdr) showToast(MATERIALX_IMPORT ? 'Drop a .glb, a .gltf with its files, an .hdr environment, or a MaterialX .mtlx or .zip'
        : 'Drop a .glb, a .gltf with its files, or an .hdr environment', 'error');
      return;
    }
    const main = models.find((f) => /\.(glb|gltf)$/i.test(f.path))!;
    return this.load(main.file.name, (progress) => loadModelFromFiles(models, progress),
      { presetId: null, credit: null, sourceUrl: null });
  }

  private async load(
    name: string,
    loader: (progress: (stage: 'download' | 'parse', loaded?: number, total?: number) => void) => Promise<LoadedModel>,
    meta: { presetId: string | null; credit: string | null; sourceUrl: string | null },
    restored?: CachedModel,
    persist = true
  ) {
    const token = ++this.loadToken;
    this.awaitingFirstSample = false;
    set({ loading: { name, stage: 'download', loaded: 0, total: 0 }, toast: null });
    let model: LoadedModel;
    try {
      model = await loader((stage, loaded = 0, total = 0) => {
        if (token === this.loadToken) set({ loading: { name, stage, loaded, total } });
      });
    } catch (error) {
      if (token !== this.loadToken) return;
      set({ loading: null });
      showToast(`Could not load ${name}: ${(error as Error).message}`, 'error');
      return false;
    }
    const id = restored?.id ?? (meta.presetId ? `preset:${meta.presetId}` : crypto.randomUUID());
    // Material edits survive reloads of the cached model; any other load replaces them.
    const edits = restored && token === this.loadToken ? await readPendingEdits(id) : null;
    if (token !== this.loadToken) {
      model.revoke();
      return false;
    }
    model.name = name;
    this.saveCamera();
    this.materials.flush();
    this.modelId = null; // Fit must not overwrite the saved view before restoration.
    this.setModel(model, edits);
    const cameraRestored = restored ? this.restoreCamera(id) : false;
    const researchScene = MODEL_PRESETS.find((preset) => preset.id === meta.presetId)?.category === 'research';
    const presetPatch = presetSettings(meta.presetId, researchScene, !!restored, DEFAULT_SETTINGS);
    if (presetPatch) setSettings(presetPatch, { record: false });
    const authoredLighting = model.lighting?.available && model.lighting.useByDefault !== false;
    if (authoredLighting && !cameraRestored) {
      set({ settings: { ...get().settings, lighting: 'environment', envId: 'model', envIntensity: 1, envRotation: 0,
        ...(restored ? INITIAL_LIGHTING : {}) } });
      // A pending custom HDRI can exist even when the selection was already 'model'.
      if (get().settings.envId === 'model') this.cancelEnvironmentDownload();
    } else if ((!model.lighting?.available || !cameraRestored && !authoredLighting) && get().settings.envId === 'model') {
      set({ settings: { ...get().settings, envId: 'sky', envIntensity: 1, envRotation: 0 } });
    }
    this.modelId = id;
    this.materials.modelId = id;
    if (!edits) void clearMaterialEdits();
    set({
      model: { name, ...meta },
      loading: { name, stage: 'bvh', loaded: 0, total: 0 }
    });
    this.awaitingFirstSample = true;
    writeHash(this.settings, meta.presetId);
    if (!cameraRestored && this.modelCameras.length) {
      if (researchScene) {
        setSettings({ cameraIndex: 0 });
      } else {
        const count = this.modelCameras.length;
        // An old prompt must never select a camera in a replacement model.
        const valid = () => token === this.loadToken && model === this.model;
        showToast(`This model includes ${count === 1 ? 'a camera' : `${count} cameras`}. Apply ${count === 1 ? 'it' : 'the first'}?`, 'info', [
          { label: 'Apply camera', onClick: () => { if (valid()) setSettings({ cameraIndex: 0 }); } }
        ]);
      }
    }
    this.saveCamera();
    if (persist) {
      if (model.source || meta.presetId) await saveModelCache({ id, meta: { name, ...meta }, source: model.source });
      else await clearModelCache();
    }
    return true;
  }

  private setModel(model: LoadedModel, edits: PendingEdits | null = null) {
    this.clearModel();
    this.model = model;
    if (model.lighting?.available) this.modelEnvironment = new Environment(model.lighting.environment ?? {
      width: 1, height: 1, data: new Float32Array([0, 0, 0, 1])
    });
    const root = model.root;
    this.materials.setModel(root, edits);
    // Stand the model on the ground at the origin; keep its units.
    groundModel(root);
    this.modelGroup.add(root);
    root.updateMatrixWorld(true);
    this.hiddenAtLoad.clear();
    root.traverse((object) => { if (!object.visible) this.hiddenAtLoad.add(object.uuid); });

    const bounds = this.modelBounds();
    const radius = Math.max(bounds.getBoundingSphere(new THREE.Sphere()).radius, 1e-3);
    this.ground.scale.setScalar(radius * 12);
    const extent = bounds.getSize(new THREE.Vector3());
    set({ modelRadius: radius, lens: { ...get().lens, guessedMetersPerUnit: guessMetersPerUnit(Math.max(extent.x, extent.y, extent.z)) } });
    this.pull = null;
    this.requestAutofocus();
    this.applyStudioRig();
    this.applyBackground();

    this.modelCameras = [];
    root.traverse((object) => {
      if ((object as THREE.PerspectiveCamera).isPerspectiveCamera || isOrthographic(object)) this.modelCameras.push(object as ViewCamera);
    });

    if (model.animations.length) {
      this.mixer = new THREE.AnimationMixer(root);
      this.selectClip(0);
    } else {
      set({ animation: null });
    }

    this.loop.removeSync(this.sync); this.sync.dispose();
    this.sync = this.createSync(); this.loop.addSync(this.sync);
    this.loop.removeSync(this.viewSync); this.loop.addSync(this.viewSync);
    this.resetView();
    const tree = [this.buildTree(root, model.name)];
    let triangles = 0;
    let meshes = 0;
    root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) { meshes++; triangles += triangleCount(o as THREE.Mesh); }
    });
    const materialIds = new Set<string>();
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) for (const m of toArray(mesh.material)) materialIds.add(m.uuid);
    });
    set({
      tree,
      sceneInfo: { meshes, triangles, materials: materialIds.size },
      cameras: this.modelCameras.map((c, i) => c.name || `Camera ${i + 1}`),
      modelLighting: model.lighting ? { available: model.lighting.available, warnings: model.lighting.warnings } : null,
      selection: { objectId: null, materialId: null },
      material: null,
      selectionRect: null
    });
  }

  /** Frames the model, or uses the view stored with it. */
  private resetView() {
    this.fit();
    const defaultCamera = this.model && readModelCamera(this.model.root.userData.mutracerCamera);
    if (defaultCamera) {
      useViewer.setState((s) => ({ settings: { ...s.settings, projection: 'perspective', fov: defaultCamera.fov, cameraIndex: -1 } }));
      this.perspectiveCamera.fov = defaultCamera.fov;
      this.perspectiveCamera.updateProjectionMatrix();
      this.lookAt(new THREE.Vector3(...defaultCamera.position), new THREE.Vector3(...defaultCamera.target));
    }
  }

  /**
   * Restores default lighting, render and camera settings, the loaded
   * materials and object visibility, and the initial view. Everything but
   * the camera is one undo step.
   */
  resetAll() {
    recordGroup('Reset all', () => {
      resetSettings();
      this.materials.resetAll();
      this.resetVisibility();
    });
    this.resetView();
  }

  private resetVisibility() {
    const changed: { id: string; visible: boolean }[] = [];
    this.model?.root.traverse((object) => {
      const visible = !this.hiddenAtLoad.has(object.uuid);
      if (object.visible !== visible) changed.push({ id: object.uuid, visible });
    });
    if (!changed.length) return;
    const apply = (show: boolean) => { for (const { id, visible } of changed) this.setVisible(id, show ? visible : !visible); };
    apply(true);
    pushHistory({ label: 'Visibility', scope: 'material', undo: () => apply(false), redo: () => apply(true) });
  }

  private clearModel() {
    this.modelEnvironment?.dispose();
    this.modelEnvironment = null;
    if (!this.model) return;
    this.mixer?.stopAllAction();
    this.mixer = null;
    this.action = null;
    this.modelGroup.remove(this.model.root);
    const disposed = new Set<unknown>();
    this.model.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry.dispose();
      for (const material of toArray(mesh.material)) {
        if (disposed.has(material)) continue;
        disposed.add(material);
        for (const value of Object.values(material)) {
          if ((value as THREE.Texture)?.isTexture) (value as THREE.Texture).dispose();
        }
        material.dispose();
      }
    });
    this.model.revoke();
    this.model = null;
    this.materials.setModel(null, null);
  }

  private createSync() {
    this.materials.clearConversions();
    const owner = this;
    return new THREESync(this.engine, {
      scene: this.scene, get camera() {return owner.activeCamera();}, controls: this.controls,
      get environment() { return owner.settings.lighting !== 'studio' && owner.settings.envId === 'sky' ? owner.sky : undefined; },
      get updateControls() {return owner.settings.cameraIndex < 0;},
      onMeshConverted: (mesh, source, group) => {
        if (source === this.ground) return;
        const material = toArray(source.material)[group.materialIndex ?? 0];
        if (material) this.materials.onConverted(material, mesh.materials[0], source.uuid, !!mesh.geometry.uv);
      }
    });
  }

  // ------------------------------------------------------------ environment

  private async applyEnvironmentPreset(id: string) {
    const preset = ENVIRONMENT_PRESETS.find((p) => p.id === id);
    if (!preset) {
      this.cancelEnvironmentDownload();
      return; // Scene lighting or custom pixels are already available.
    }
    const url = environmentUrl(preset, this.settings.envResolution);
    if (!url) {
      this.applySky(id);
      return;
    }
    const name = `${preset.name} ${this.settings.envResolution.toUpperCase()}`;
    try {
      await this.downloadEnvironment(url, id, name);
    } catch (error) {
      showToast(`Could not load ${preset.name}: ${(error as Error).message}. Using the procedural sky.`, 'error');
      useViewer.setState((s) => ({ settings: { ...s.settings, envId: 'sky' } }));
    }
  }

  private applySky(_id: string) {
    this.cancelEnvironmentDownload();
    this.sky.time = this.settings.skyTime;
    this.applyBackground();
  }

  private async loadEnvironmentFromURL(url: string) {
    try {
      await this.downloadEnvironment(url, 'custom', url.split('?')[0].split('/').pop() || 'Environment');
    } catch (error) {
      showToast(`Could not load environment: ${(error as Error).message}`, 'error');
    }
  }

  /** Downloads an .hdr with progress. Resolves quietly when a newer request supersedes it. */
  private async downloadEnvironment(url: string, id: string, name: string) {
    this.cancelEnvironmentDownload();
    const token = this.envToken;
    const controller = new AbortController();
    this.envAbort = controller;
    const current = () => token === this.envToken;
    set({ envLoading: { id, name, loaded: 0, total: 0 } });
    try {
      const data = await loadHDR(url, (loaded, total) => {
        if (current()) set({ envLoading: { id, name, loaded, total } });
      }, controller.signal);
      if (current()) this.setEnvironmentData(data, id);
    } catch (error) {
      if (current()) {
        set({ envLoading: null });
        throw error;
      }
    } finally {
      if (this.envAbort === controller) this.envAbort = undefined;
    }
  }

  private cancelEnvironmentDownload() {
    this.envToken++;
    this.envAbort?.abort();
    this.envAbort = undefined;
    set({ envLoading: null });
  }

  private setEnvironmentData(data: EquirectData, id: string) {
    this.cancelEnvironmentDownload();
    this.environment.setSource(data);
    this.applyBackground();
    if (get().settings.envId !== id) useViewer.setState((s) => ({ settings: { ...s.settings, envId: id } }));
  }

  /** Also selects the lighting: studio mode swaps the HDRI for a dim ambient fill. */
  private applyBackground() {
    const { background, backgroundColor, groundedHeight, groundedRadius, lighting } = this.settings;
    const studio = lighting === 'studio';
    const environment = studio ? this.studioAmbient : this.settings.envId === 'model' && this.modelEnvironment ? this.modelEnvironment : this.environment;
    const intensity = studio ? this.settings.studioAmbient : this.settings.envIntensity;
    const rotation = studio ? 0 : this.settings.envRotation;
    environment.apply(this.scene, intensity, rotation);
    this.studioRig.visible = studio;
    this.scene.userData.mutracerHiddenBackground = background === 'transparent';
    // Projects the environment onto a ground disc and dome around the model.
    // The studio ambient is a plain gradient, so it is shown as a backdrop.
    const grounded = autoGroundedSkybox(get().modelRadius, groundedHeight);
    this.scene.userData.mutracerGroundedSkybox = background === 'grounded' && !studio ? {
      texture: this.settings.envId === 'sky' ? this.sky : environment.texture,
      intensity,
      rotation: this.scene.environmentRotation.y,
      height: grounded.height,
      radius: groundedRadius ?? grounded.radius,
      groundHeight: 0
    } : undefined;
    // An omitted background follows the environment's intensity and orientation.
    this.scene.background = background === 'color' ? new THREE.Color(backgroundColor) : null;
  }

  /** Rebuilds the studio rect lights around the current model. */
  private applyStudioRig() {
    const { studioPreset, studioIntensity, studioRotation, studioSize } = this.settings;
    const sphere = this.modelBounds().getBoundingSphere(new THREE.Sphere());
    for (const light of [...this.studioRig.children]) {
      this.studioRig.remove(light);
      (light as THREE.RectAreaLight).dispose();
    }
    const lights = buildStudioRig(findStudioPreset(studioPreset), sphere, studioIntensity, studioRotation, studioSize);
    if (lights.length) this.studioRig.add(...lights);
  }

  // ---------------------------------------------------------------- settings

  private applySettings(s: Settings, prev: Settings | null) {
    // Old links, saved settings or undo must not select an empty lighting setup.
    if (s.envId === 'model' && this.model && !this.model.lighting?.available) {
      setSettings({ envId: 'sky', envIntensity: 1, envRotation: 0 }, { record: false });
      return;
    }
    const changed = (key: keyof Settings) => !prev || prev[key] !== s[key];
    const r = this.final, display = this.engine.display;
    this.engine.bvhBuilder = s.bvhBuilder;
    r.aovs = this.preview.aovs = VIEWER_AOVS.filter(kind => kind === s.output);
    r.maxSamples = s.maxSamples; r.bounces = s.bounces; r.resolutionScale = s.resolutionScale;
    r.caustics = this.preview.caustics = causticOptions(s);
    r.samplingPattern = s.samplingPattern; r.clamping = s.clamping;
    this.preview.bounces = Math.min(2, s.bounces);
    this.preview.samplingPattern = s.samplingPattern; this.preview.clamping = s.clamping;
    r.fallback = s.previewEnabled ? this.preview : null;
    this.loop.coalesceSceneUpdates = s.previewEnabled && s.denoiseWhileConverging;
    this.preview.resolutionScale = s.previewMaxResolutionScale;
    this.preview.adaptiveResolution = {targetFrameMs: 80, minScale: Math.min(.125, s.previewMaxResolutionScale)};
    const displaySettings: DisplaySettings = {
      toneMapping: s.toneMapping, toneMappingExposure: s.exposure,
      hdrOutputEnabled: s.hdrOutputEnabled,
      contrast: s.contrast, saturation: s.saturation,
      temperature: s.temperature, tint: s.tint,
      bloomIntensity: s.bloomIntensity, bloomThreshold: s.bloomThreshold, bloomRadius: s.bloomRadius,
      vignette: s.vignette, channel: s.output, shadowCatcherAlpha: s.groundOpacity,
      aovDepthRange: [0, s.aovDepthFar], aovPositionScale: s.aovPositionScale,
      aovMotionScale: s.aovMotionScale, aovIdComponent: s.aovIdComponent,
    };
    Object.assign(display, displaySettings);
    this.ground.visible = s.groundShadow;
    this.controls.autoRotate = s.autoRotate;
    this.controls.enabled = true;

    if ((changed('envId') || changed('envResolution') || (changed('skyTime') && s.envId === 'sky')) && s.envId !== 'custom') void this.applyEnvironmentPreset(s.envId);
    if (changed('studioPreset') || changed('studioIntensity') || changed('studioRotation') || changed('studioSize')) this.applyStudioRig();
    if (changed('studioAmbientColor')) {
      // THREE.Color converts the sRGB hex to linear RGB.
      const tint = new THREE.Color(s.studioAmbientColor);
      this.studioAmbient.setTint([tint.r, tint.g, tint.b]);
    }
    if (changed('lighting') || changed('envId') || changed('background') || changed('backgroundColor') || changed('groundedHeight') ||
      changed('groundedRadius') || changed('envIntensity') || changed('envRotation') ||
      changed('studioAmbient') || changed('studioAmbientColor')) this.applyBackground();
    if (changed('cameraIndex')) this.needsResize = true;
    // A focus distance set elsewhere (the slider, fitting) ends a running pull.
    if (prev && changed('focusDistance') && !this.writingFocus) {
      this.pull = null;
      this.manualFocus = null;
      ++this.focusQueryVersion;
    }
    // End manual picking when its controls disappear, so the next scene click
    // selects the object. Autofocus is positioned by dragging its center handle.
    if ((!(s.fStop > 0) || s.autoFocus) && get().pickingFocus) set({ pickingFocus: false });
    // Aperture changes blur, but do not change the subject's depth. Only
    // enabling the lens needs a new measurement; scrubbing f-number does not.
    if ((!prev || (prev.fStop <= 0 && s.fStop > 0)) || changed('autoFocus') || changed('fov') || changed('cameraIndex') || changed('projection')) {
      ++this.focusQueryVersion;
      this.requestAutofocus();
    }
    if (changed('fov')) {
      this.perspectiveCamera.fov = s.fov;
      this.perspectiveCamera.updateProjectionMatrix();
    }
    if (prev && changed('projection')) {
      this.switchProjection(prev.projection === 'orthographic' ? this.orthographicCamera : this.perspectiveCamera);
    }
    if (DENOISER_FIELDS.some(changed)) {
      clearTimeout(this.denoiserUpdateTimer);
      // Shape changes compile a filter shader. Apply the settled slider value.
      if (prev && !changed('denoise') && !changed('denoiseModel')) {
        this.denoiserUpdateTimer = setTimeout(() => void this.updateDenoiser(), 180);
      } else {
        void this.updateDenoiser();
      }
    }
    if (s.autoRotate && s.cameraIndex >= 0) this.beginOrbit();
    if (prev && URL_SETTINGS_FIELDS.some(changed)) {
      writeHash(s, get().model?.presetId ?? null);
    }
  }

  private updateDenoiser() {
    if (!this.engine.backend) return;
    const final = getDenoiserOptions(this.settings, this.engine.backend === 'webgpu', OIDN_WEIGHTS);
    const preview = this.settings.previewEnabled ? getDenoiserOptions(this.settings, this.engine.backend === 'webgpu', OIDN_WEIGHTS, true) : null;
    const failed = (error: Error) => showToast(`Denoiser failed to load: ${error.message}`, 'error');
    this.final.setDenoiser(final).catch(failed); this.preview.setDenoiser(preview).catch(failed);
  }

  // ----------------------------------------------------------------- camera

  /** The orbit camera for the current projection. */
  private get camera(): ViewCamera {
    return this.settings.projection === 'orthographic' ? this.orthographicCamera : this.perspectiveCamera;
  }

  /**
   * Hands the orbit controls from `from` to the camera of the current
   * projection. The orthographic view keeps the size of the perspective
   * view's focus plane at the orbit target, and back.
   */
  private switchProjection(from: ViewCamera) {
    const to = this.camera;
    if (from === to) return;
    // Settle damping on the old camera first.
    this.controls.enableDamping = false;
    this.controls.update();
    this.controls.enableDamping = true;

    const target = this.controls.target;
    const direction = from.position.clone().sub(target);
    const distance = direction.length();
    direction.divideScalar(distance || 1);
    const tanHalfFov = Math.tan(THREE.MathUtils.degToRad(this.perspectiveCamera.fov) / 2);
    let toDistance: number;
    if (isOrthographic(to)) {
      to.top = (distance * tanHalfFov) / from.zoom;
      to.bottom = -to.top;
      // Zooming does not dolly an orthographic camera, so keep it outside the model.
      const bounds = this.modelBounds().getBoundingSphere(new THREE.Sphere());
      toDistance = Math.max(distance, target.distanceTo(bounds.center) + bounds.radius * 1.1);
    } else {
      toDistance = (from as THREE.OrthographicCamera).top / from.zoom / tanHalfFov;
    }
    const scale = toDistance / Math.max(distance, 1e-6);
    to.position.copy(target).addScaledVector(direction, toDistance);
    to.up.copy(from.up);
    to.zoom = 1;
    to.near = from.near * scale;
    to.far = from.far * scale;
    setAspect(to, this.viewAspect());
    this.controls.object = to;
    this.controls.update();
    this.needsResize = true;
  }

  private viewAspect() {
    return this.canvas.clientWidth / Math.max(1, this.canvas.clientHeight);
  }

  private scheduleCameraSave = () => {
    if (this.modelId && this.cameraSaveTimer === undefined) this.cameraSaveTimer = setTimeout(this.saveCamera, 200);
  };

  private saveCamera = () => {
    clearTimeout(this.cameraSaveTimer);
    this.cameraSaveTimer = undefined;
    if (!this.modelId) return;
    writeCameraState({
      modelId: this.modelId,
      position: this.camera.position.toArray(), target: this.controls.target.toArray(), up: this.camera.up.toArray(),
      near: this.camera.near, far: this.camera.far, zoom: this.camera.zoom,
      orthoHalfHeight: this.orthographicCamera.top,
      settings: cameraSettings(this.settings)
    });
  };

  private restoreCamera(modelId: string) {
    const saved = readCameraState(modelId);
    if (!saved) return false;
    // Flush any damping from fitting without rotating the saved view.
    this.controls.autoRotate = false;
    this.controls.enableDamping = false;
    this.controls.update();
    // Applying the settings switches the controls to the saved projection.
    useViewer.setState((s) => ({ settings: {
      ...s.settings, ...saved.settings,
      cameraIndex: saved.settings.cameraIndex < this.modelCameras.length ? saved.settings.cameraIndex : -1
    } }));
    const camera = this.camera;
    camera.position.fromArray(saved.position);
    // Earlier versions saved a tilted up after orbiting from a scene camera.
    camera.up.set(0, 1, 0);
    this.controls.target.fromArray(saved.target);
    camera.near = saved.near;
    camera.far = saved.far;
    camera.zoom = saved.zoom;
    if (saved.orthoHalfHeight) {
      this.orthographicCamera.top = saved.orthoHalfHeight;
      this.orthographicCamera.bottom = -saved.orthoHalfHeight;
    }
    setAspect(camera, this.viewAspect());
    this.controls.enableDamping = false;
    this.controls.update();
    this.controls.enableDamping = true;
    this.controls.autoRotate = this.settings.autoRotate;
    this.needsResize = true;
    return true;
  }

  private activeCamera(): ViewCamera {
    return this.modelCameras[this.settings.cameraIndex] ?? this.camera;
  }

  /** Starts an orbit gesture at the authored camera's current world-space view. */
  private beginOrbit() {
    const source = this.modelCameras[this.settings.cameraIndex];
    if (!source) return;
    source.updateWorldMatrix(true, false);
    const position = source.getWorldPosition(new THREE.Vector3());
    const quaternion = source.getWorldQuaternion(new THREE.Quaternion());
    const direction = source.getWorldDirection(new THREE.Vector3());
    const center = this.modelBounds().getCenter(new THREE.Vector3());
    const depth = center.clone().sub(position).dot(direction);
    const distance = depth > 1e-4 ? depth : Math.max(center.distanceTo(position), 1e-3);
    const autoRotate = this.settings.autoRotate;
    const damping = this.controls.enableDamping;
    this.controls.autoRotate = false;
    this.controls.enableDamping = false;
    this.controls.update();
    // Switch projection before copying the view, so its framing conversion
    // cannot replace the authored pose. Keep the source camera untouched.
    setSettings({ cameraIndex: -1, projection: isOrthographic(source) ? 'orthographic' : 'perspective',
      ...(!isOrthographic(source) ? { fov: source.fov } : {}) });
    if (isOrthographic(source)) this.orthographicCamera.copy(source, false);
    else this.perspectiveCamera.copy(source, false);
    const camera = this.camera;
    camera.position.copy(position);
    camera.quaternion.copy(quaternion);
    // OrbitControls orbits around world +Y; a tilted up would roll every
    // later frame. The view direction is kept and only authored roll is dropped.
    camera.up.set(0, 1, 0);
    camera.matrixAutoUpdate = true;
    camera.matrixWorldAutoUpdate = true;
    setAspect(camera, this.viewAspect());
    this.controls.object = camera;
    this.controls.target.copy(position).addScaledVector(direction, distance);
    this.controls.autoRotate = false;
    this.controls.enableDamping = false;
    this.controls.update();
    camera.updateMatrixWorld(true);
    this.controls.enableDamping = damping;
    this.controls.autoRotate = autoRotate;
    this.needsResize = true;
    this.requestAutofocus();
  }

  /** Applies a camera identified by its scene-tree object, including duplicate names. */
  applyModelCamera(objectId: string) {
    const index = this.modelCameras.findIndex((camera) => camera.uuid === objectId);
    if (index < 0) return;
    setSettings({ cameraIndex: index });
    set({ toast: null });
  }

  private modelBounds() {
    const box = new THREE.Box3();
    this.modelGroup.traverseVisible((o) => {
      if ((o as THREE.Mesh).isMesh) box.expandByObject(o, false);
    });
    return box.isEmpty() ? new THREE.Box3(new THREE.Vector3(-1, 0, -1), new THREE.Vector3(1, 1, 1)) : box;
  }

  /**
   * Frames the visible model's bounding box from a three-quarter view.
   * `aspect` overrides the viewport's, e.g. for a render at another size;
   * `margin` is the fraction of the frame the model may fill.
   */
  fit(aspect?: number, margin = 0.85) {
    // Fitting also leaves the selected model camera. A reload restores the saved
    // camera only after the new model has been fitted.
    setSettings({ cameraIndex: -1 });
    if (this.needsResize) this.resize();
    const box = this.modelBounds();
    const center = box.getCenter(new THREE.Vector3());
    const radius = box.getBoundingSphere(new THREE.Sphere()).radius;
    const direction = new THREE.Vector3(0.55, 0.38, 1).normalize();
    const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), direction).normalize();
    const up = new THREE.Vector3().crossVectors(direction, right);
    const frameAspect = aspect ?? (this.viewAspect() || 1);
    const tanV = Math.tan(THREE.MathUtils.degToRad(this.perspectiveCamera.fov) / 2) * margin;
    const tanH = tanV * frameAspect;
    // Closest distance at which every box corner projects inside the frame,
    // and the orthographic half height that holds every corner.
    let distance = 0;
    let halfHeight = 0;
    const corner = new THREE.Vector3();
    for (let i = 0; i < 8; i++) {
      corner.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).sub(center);
      const depth = corner.dot(direction);
      distance = Math.max(distance, depth + Math.abs(corner.dot(right)) / tanH, depth + Math.abs(corner.dot(up)) / tanV);
      halfHeight = Math.max(halfHeight, Math.abs(corner.dot(right)) / frameAspect / margin, Math.abs(corner.dot(up)) / margin);
    }
    const camera = this.camera;
    camera.position.copy(center).addScaledVector(direction, distance);
    camera.near = Math.max((distance - radius) / 20, distance / 1000, 1e-4);
    camera.far = (distance + radius) * 100;
    camera.zoom = 1;
    if (isOrthographic(camera)) {
      camera.top = halfHeight;
      camera.bottom = -halfHeight;
    }
    setAspect(camera, this.viewAspect());
    this.controls.target.copy(center);
    this.controls.update();
    useViewer.setState((s) => ({ settings: { ...s.settings, focusDistance: Number(distance.toFixed(3)) } }));
  }

  /** Places the orbit camera explicitly. */
  lookAt(position: THREE.Vector3, target: THREE.Vector3) {
    this.camera.position.copy(position);
    this.controls.target.copy(target);
    this.controls.update();
    const distance = position.distanceTo(target);
    useViewer.setState((s) => ({ settings: { ...s.settings, cameraIndex: -1, focusDistance: Number(distance.toFixed(3)) } }));
  }

  // ------------------------------------------------------------------ focus

  /** The MuTracer camera for a view, with the lens settings applied. */
  private lensCamera(camera: ViewCamera, focusDistance: number) {
    return fromTHREECamera(camera, {
      fStop: this.settings.fStop,
      focusDistance,
      metersPerUnit: this.settings.metersPerUnit ?? get().lens.guessedMetersPerUnit
    });
  }

  private publishLens(camera: ViewCamera) {
    const focalLength = isOrthographic(camera) ? 0 : camera.getFocalLength() * camera.zoom;
    const lens = get().lens;
    if (Math.abs(focalLength - lens.focalLength) > 0.05) set({ lens: { ...lens, focalLength } });
  }

  private requestAutofocus = () => {
    this.autofocusPending = true;
    this.lastViewChange = performance.now();
  };

  /**
   * Focuses on the point under viewport coordinates `x`, `y` (0..1 from the
   * top left), turning depth of field on. With autofocus the focus area
   * moves there; otherwise the focus pulls to that point once.
   */
  pickFocus(x: number, y: number) {
    const camera = this.activeCamera();
    if (isOrthographic(camera)) return;
    if (!(this.settings.fStop > 0)) setSettings({ fStop: DEFAULT_F_STOP });
    if (this.settings.autoFocus) {
      set({ focusArea: { ...get().focusArea, x, y } });
      this.requestAutofocus();
      this.lastViewChange = 0;
      return;
    }
    this.manualFocus = { x, y };
    ++this.focusQueryVersion;
  }

  /**
   * Measures the focus area once the view settles, or periodically while
   * the view or the animation keeps moving, and pulls focus to it.
   */
  private updateAutofocus(now: number) {
    const camera = this.activeCamera();
    if (this.disposed || this.focusQueryInFlight || !(this.settings.fStop > 0) || isOrthographic(camera)) return;
    if (!this.settings.autoFocus) {
      if (this.manualFocus) this.queryFocus(this.manualFocus, now, false, false);
      return;
    }
    this.manualFocus = null;
    const tracking = (this.settings.autoRotate && this.settings.cameraIndex < 0) || get().animation?.playing;
    if (tracking ? now - this.lastAutofocus < AUTOFOCUS_TRACK_MS
      : !this.autofocusPending || this.dragging || now - this.lastViewChange < AUTOFOCUS_SETTLE_MS) return;
    const area = get().focusArea;
    this.queryFocus(area, now, true, !!tracking);
  }

  /** One compact asynchronous GPU query; late results never replace a new target. */
  private queryFocus(area: { x: number; y: number }, now: number, automatic: boolean, tracking: boolean) {
    const version = this.focusQueryVersion;
    const loadToken = this.loadToken;
    const viewChange = this.lastViewChange;
    const camera = this.activeCamera();
    const projection = camera.projectionMatrix.clone();
    this.focusQueryInFlight = true;
    void this.engine.readDepthSamples({ x: area.x, y: area.y, size: automatic ? FOCUS_AREA_SIZE : 0.004 })
      .then((samples) => {
        if (this.disposed || version !== this.focusQueryVersion || loadToken !== this.loadToken ||
          !(this.settings.fStop > 0) || automatic !== this.settings.autoFocus ||
          camera !== this.activeCamera() || !projection.equals(camera.projectionMatrix)) return;
        const currentArea = get().focusArea;
        if (automatic ? currentArea.x !== area.x || currentArea.y !== area.y ||
          (!tracking && viewChange !== this.lastViewChange) : this.manualFocus !== area) return;
        // Preparation/compilation or a busy renderer: retry on a later frame.
        if (!samples) return;
        if (automatic) {
          this.autofocusPending = false;
          this.lastAutofocus = now;
        } else {
          this.manualFocus = null;
        }
        const depth = pickFocusDepth(Array.from(samples).filter(d => Number.isFinite(d) && d > 0), samples.length);
        if (depth === null) {
          if (automatic) set({ focusArea: { ...currentArea, status: 'missed', attempt: currentArea.attempt + 1 } });
          return;
        }
        // Start the pull on completion, so readback latency cannot skip it.
        this.startPull(depth, performance.now(), !tracking);
      })
      .catch((error) => {
        if (this.disposed || loadToken !== this.loadToken) return;
        // Retry at the tracking interval without flooding the GPU on failure.
        this.lastAutofocus = performance.now();
        this.lastViewChange = this.lastAutofocus;
        console.warn('Focus depth query failed.', error);
      })
      .finally(() => { this.focusQueryInFlight = false; });
  }

  private startPull(target: number, now: number, announce = true) {
    const current = this.advanceFocus(now);
    const area = get().focusArea;
    if (Math.abs(Math.log(target / current)) < 0.004) {
      this.pull = null;
      this.commitFocus(target);
      if (announce || area.status !== 'locked') set({ focusArea: { ...area, status: 'locked', attempt: area.attempt + 1 } });
      return;
    }
    this.pull = { from: current, to: target, start: now };
    if (announce || area.status !== 'focusing') set({ focusArea: { ...area, status: 'focusing', attempt: area.attempt + (announce ? 1 : 0) } });
  }

  /** Focus distance of this frame; ends a finished pull. */
  private advanceFocus(now: number) {
    if (!this.pull) return this.settings.focusDistance;
    const { from, to, start } = this.pull;
    const { distance, done } = focusPull(from, to, now - start);
    if (done) {
      this.pull = null;
      this.commitFocus(to);
      const area = get().focusArea;
      if (area.status === 'focusing') set({ focusArea: { ...area, status: 'locked' } });
    }
    return distance;
  }

  private commitFocus(distance: number) {
    this.writingFocus = true;
    try {
      useViewer.setState((s) => ({ settings: { ...s.settings, focusDistance: Number(distance.toPrecision(5)) } }));
    } finally {
      this.writingFocus = false;
    }
  }

  // ---------------------------------------------------------------- picking

  private onPointerDown = (event: PointerEvent) => {
    this.pointerDown = event.button === 0 ? { x: event.clientX, y: event.clientY } : null;
  };

  private onPointerUp = (event: PointerEvent) => {
    const down = this.pointerDown;
    this.pointerDown = null;
    if (!down || Math.hypot(event.clientX - down.x, event.clientY - down.y) > 4) return;
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1
    );
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(ndc, this.activeCamera());
    if (get().pickingFocus) {
      set({ pickingFocus: false });
      const x = (event.clientX - rect.left) / rect.width;
      const y = (event.clientY - rect.top) / rect.height;
      this.pickFocus(x, y);
      return;
    }
    const hit = raycaster.intersectObject(this.modelGroup, true).find((h) => isVisible(h.object));
    if (!hit) return this.select(null);
    const materials = toArray((hit.object as THREE.Mesh).material);
    const material = materials[hit.face?.materialIndex ?? 0] ?? materials[0];
    this.select(hit.object.uuid, material?.uuid ?? null);
  };

  select(objectId: string | null, materialId?: string | null) {
    const object = objectId ? this.modelGroup.getObjectByProperty('uuid', objectId) : null;
    if (objectId && !object) return;
    if (materialId === undefined && object && (object as THREE.Mesh).isMesh) {
      materialId = toArray((object as THREE.Mesh).material)[0]?.uuid ?? null;
    }
    set({ selection: { objectId, materialId: materialId ?? null } });
    this.publishMaterial(materialId ?? null, object?.name);
    if (materialId && window.matchMedia('(max-width: 768px)').matches === false) {
      useViewer.setState((s) => ({ ui: { ...s.ui, tab: 'material' } }));
    }
  }

  selectMaterial(materialId: string, objectId: string) {
    this.select(objectId, materialId);
  }

  private publishMaterial(materialId: string | null, meshName?: string) {
    const description = materialId ? this.materials.describe(materialId) : null;
    const objectId = get().selection.objectId;
    const mesh = objectId ? this.modelGroup.getObjectByProperty('uuid', objectId) as THREE.Mesh | undefined : undefined;
    set({ material: materialId && description ? {
      id: materialId, meshName: meshName ?? '', ...description,
      displacementRange: displacementHeightRange(mesh?.geometry)
    } : null });
  }

  /**
   * Edits a material; each call is an undo step. Calls with the same
   * `mergeKey` in quick succession (a slider drag) collapse into one step.
   */
  setMaterialValues(materialId: string, values: MaterialValues, label = 'Edit material', mergeKey?: string) {
    this.materials.setValues(materialId, values, label, mergeKey);
  }

  setMaterialTextureSampling(materialId: string, slot: TextureKey, patch: Partial<TextureSampling>, label: string, mergeKey?: string) {
    this.materials.setTextureSampling(materialId, slot, patch, label, mergeKey);
  }

  /** Replaces the texture in a slot with an image file, or removes it with `null`. */
  async setMaterialTexture(materialId: string, slot: TextureKey, file: Blob | null, label: string) {
    try {
      await this.materials.setTexture(materialId, slot, file, label);
    } catch (error) {
      showToast(`Could not read the image: ${(error as Error).message}`, 'error');
    }
  }

  /**
   * Downloads a Poly Haven texture set and applies it to a material, each map
   * as soon as it arrives so the set previews early; the whole pick is one
   * undo step. Slots the set has no map for are cleared, and the factors the
   * maps multiply are set to neutral values so the textures show as authored.
   * Returns whether every map was applied.
   */
  async applyPolyHavenTexture(
    materialId: string, id: string, name: string, resolution: TextureResolution,
    onProgress?: (loaded: number, total: number) => void, signal?: AbortSignal, displacement = false
  ) {
    try {
      const { urls, metal } = await polyHavenMaps(id, resolution, displacement && this.engine.backend === 'webgpu');
      if (signal?.aborted) return false;
      const entries = Object.entries(urls) as [TextureKey, string][];
      const loaded = new Array<number>(entries.length).fill(0);
      const totals = new Array<number>(entries.length).fill(0);
      const report = () => onProgress?.(loaded.reduce((a, b) => a + b, 0), totals.reduce((a, b) => a + b, 0));
      const merge = { key: `${materialId}:polyhaven:${++this.polyHavenPicks}`, ms: Infinity };
      // The maps carry the color, roughness and metalness; the other layers would hide them.
      const values: MaterialValues = {
        ...MATERIAL_BASE, baseColor: [1, 1, 1], baseMetalness: metal ? 1 : 0,
        ...(urls.metallicRoughnessMap || urls.roughnessMap ? { specularRoughness: 1 } : {})
      };
      // The first map to land also clears the slots of the previous set.
      let pending: Partial<Record<TextureKey, Blob | null>> | null = {
        map: null, normalMap: null, metallicRoughnessMap: null, roughnessMap: null, metalnessMap: null, displacementMap: null
      };
      // Maps are applied in arrival order, one at a time.
      let applying = Promise.resolve();
      await Promise.all(entries.map(async ([slot, url], i) => {
        const blob = await downloadPolyHavenMap(url, (bytes, total) => {
          loaded[i] = bytes;
          totals[i] = total;
          report();
        }, signal);
        applying = applying.then(async () => {
          if (signal?.aborted) return;
          const first = pending;
          pending = null;
          await this.materials.setTextures(materialId, { ...first, [slot]: blob },
            first ? values : {},
            `${name} textures`, merge);
        });
        await applying;
      }));
      return !signal?.aborted;
    } catch (error) {
      if (!signal?.aborted) showToast(`Could not load ${name} from Poly Haven: ${(error as Error).message}`, 'error');
      return false;
    }
  }

  /**
   * Imports a MaterialX document, with its textures or as a zip, into a
   * material as one undo step. The import replaces the whole material: every
   * value starts from the neutral base and every texture slot is set or cleared.
   */
  async importMaterialX(materialId: string, files: PathedFile[]) {
    let name = files[0]?.file.name ?? 'MaterialX';
    try {
      // Loaded on demand, so production bundles leave the importer and fflate out.
      const [{ parseMaterialX }, { loadMapImage, readMaterialXPackage }] = await Promise.all([import('./materialx'), import('./materialxFiles')]);
      const pkg = await readMaterialXPackage(files);
      const material = parseMaterialX(pkg.text);
      name = material.name;
      const warnings = [...material.warnings];
      const maps: Partial<Record<TextureKey, Blob | null>> = Object.fromEntries(TEXTURE_KEYS.map((key) => [key, null]));
      await Promise.all((Object.entries(material.maps) as [TextureKey, MapPlan][]).map(async ([slot, plan]) => {
        try {
          maps[slot] = await loadMapImage(plan, pkg);
        } catch (error) {
          warnings.push(`texture ${(error as Error).message}`);
        }
      }));
      // MaterialX images have their origin at the bottom left.
      await this.materials.setTextures(materialId, maps, { ...MATERIAL_BASE, ...material.values }, `${name} MaterialX`,
        undefined, { uvScale: material.uvScale, flipY: true });
      showToast(warnings.length ? `Imported ${name}. Not supported: ${warnings.join('; ')}` : `Imported ${name}`);
      return true;
    } catch (error) {
      showToast(`Could not import ${name}: ${(error as Error).message}`, 'error');
      return false;
    }
  }

  resetMaterial(materialId: string) {
    this.materials.reset(materialId);
  }

  private flushMaterials = () => this.materials.flush();

  setVisible(objectId: string, visible: boolean) {
    const object = this.modelGroup.getObjectByProperty('uuid', objectId);
    if (!object) return;
    object.visible = visible;
    const update = (nodes: TreeNode[]): TreeNode[] => nodes.map((node) =>
      node.id === objectId ? { ...node, visible } : { ...node, children: update(node.children) });
    set({ tree: update(get().tree) });
  }

  private buildTree(object: THREE.Object3D, name?: string): TreeNode {
    const mesh = object as THREE.Mesh;
    const kind: TreeNode['kind'] = mesh.isMesh ? 'mesh' : (object as THREE.Light).isLight ? 'light'
      : (object as THREE.Camera).isCamera ? 'camera' : 'group';
    return {
      id: object.uuid,
      name: name ?? (object.name || defaultName(kind)),
      kind,
      visible: object.visible,
      triangles: mesh.isMesh ? triangleCount(mesh) : 0,
      materials: mesh.isMesh ? toArray(mesh.material).map((m) => ({
        id: m.uuid,
        name: m.name || 'Material',
        color: (m as THREE.MeshStandardMaterial).color ? '#' + (m as THREE.MeshStandardMaterial).color.getHexString() : '#888'
      })) : [],
      children: object.children.filter((child) => !child.userData.mutracerMetadataLightTarget).map((child) => this.buildTree(child))
    };
  }

  private updateSelectionRect() {
    const id = get().selection.objectId;
    const object = id ? this.modelGroup.getObjectByProperty('uuid', id) : null;
    if (!object || !isVisible(object)) {
      if (get().selectionRect) set({ selectionRect: null });
      return;
    }
    const box = new THREE.Box3().setFromObject(object);
    const camera = this.activeCamera();
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const corner = new THREE.Vector3();
    for (let i = 0; i < 8; i++) {
      corner.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z);
      corner.project(camera);
      if (corner.z > 1) {
        if (get().selectionRect) set({ selectionRect: null });
        return;
      }
      minX = Math.min(minX, corner.x); maxX = Math.max(maxX, corner.x);
      minY = Math.min(minY, corner.y); maxY = Math.max(maxY, corner.y);
    }
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    const rect = {
      x: Math.round(((minX + 1) / 2) * w), y: Math.round(((1 - maxY) / 2) * h),
      w: Math.round(((maxX - minX) / 2) * w), h: Math.round(((maxY - minY) / 2) * h),
      label: object.name || 'Object'
    };
    const prev = get().selectionRect;
    if (!prev || prev.x !== rect.x || prev.y !== rect.y || prev.w !== rect.w || prev.h !== rect.h) set({ selectionRect: rect });
  }

  // -------------------------------------------------------------- animation

  selectClip(index: number) {
    if (!this.mixer || !this.model) return;
    this.mixer.stopAllAction();
    const clip = this.model.animations[index];
    this.action = this.mixer.clipAction(clip);
    this.action.reset().play();
    this.action.paused = false;
    this.mixer.setTime(0);
    const loop = get().animation?.loop ?? true;
    this.action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
    this.action.clampWhenFinished = true;
    set({
      animation: {
        clips: this.model.animations.map((c, i) => c.name || `Clip ${i + 1}`),
        clip: index, playing: false, time: 0, duration: clip.duration,
        speed: get().animation?.speed ?? 1, loop
      }
    });
  }

  setAnimation(patch: Partial<{ playing: boolean; time: number; speed: number; loop: boolean }>) {
    const anim = get().animation;
    if (!anim || !this.action || !this.mixer) return;
    if (patch.time !== undefined) {
      this.action.time = Math.min(Math.max(patch.time, 0), anim.duration);
      this.mixer.update(0);
    }
    if (patch.loop !== undefined) this.action.setLoop(patch.loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
    if (patch.playing && !anim.loop && this.action.time >= anim.duration - 1e-3) {
      this.action.reset().play();
    }
    set({ animation: { ...anim, ...patch, time: this.action.time } });
  }

  // ----------------------------------------------------------------- export

  /** Downloads the displayed viewport at its current size without restarting accumulation. */
  async downloadViewportImage() {
    if (this.exporting) return;
    try {
      const samples = this.displaySamples(this.displayed ?? this.final);
      if (samples === 0) throw new Error('The viewport has not rendered an image yet');
      const blob = await this.captureImage();
      this.downloadImage(blob, samples, 'viewport');
    } catch (error) {
      showToast(`Export failed: ${(error as Error).message}`, 'error');
    }
  }

  async exportImage(options: ExportOptions) {
    if (this.exporting) return;
    try {
      const blob = await this.renderImage(options);
      this.downloadImage(blob, options.samples);
    } catch (error) {
      if ((error as Error).name !== 'AbortError') showToast(`Export failed: ${(error as Error).message}`, 'error');
    }
  }

  private downloadImage(blob: Blob, samples: number, suffix?: string) {
    const link = document.createElement('a');
    const base = (get().model?.name ?? 'mutracer').replace(/\.[^.]+$/, '');
    link.download = `mutracer-${base}${suffix ? `-${suffix}` : ''}-${samples}spp.png`;
    const url = URL.createObjectURL(blob);
    link.href = url;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    showToast(`Saved ${link.download}`);
  }

  captureImage(type = 'image/png', quality?: number): Promise<Blob> {
    return this.engine.display.toBlob(this.displayed ?? this.final, {type, quality});
  }

  /** Renders an independent fixed-size image without resizing the viewport. */
  async renderImage(options: ExportOptions, type = 'image/png', quality?: number): Promise<Blob> {
    if (this.exporting) throw new Error('A render is already running');
    this.exporting = true; this.exportAbort = new AbortController();
    const background = this.settings.background;
    const source = this.activeCamera();
    source.updateWorldMatrix(true, false);
    const camera = source.clone();
    // A detached clone must retain the model camera's full parent transform.
    camera.matrixAutoUpdate = false;
    camera.matrix.copy(source.matrixWorld);
    setAspect(camera, options.width / options.height);
    let image: Render | undefined;
    set({export: {stage: 'final', samples: 0, target: options.samples}});
    try {
      if (options.transparent && background !== 'transparent') { this.settings = {...this.settings, background: 'transparent'}; this.applyBackground(); }
      this.sync.update(); this.viewSync.update(); this.engine.update();
      image = new Render(this.engine, {width: options.width, height: options.height,
        aovs: this.final.aovs, aovSamples: this.final.aovSamples,
        maxSamples: options.samples, bounces: this.final.bounces, clamping: this.final.clamping, caustics: this.final.caustics,
        samplingPattern: this.final.samplingPattern, bevel: this.final.bevel, bevelSamples: this.final.bevelSamples,
        dispersionWavelengths: this.final.dispersionWavelengths, directLightCandidates: this.final.directLightCandidates,
        alphaBlendStrategy: this.final.alphaBlendStrategy, transmissiveOutputAlphaMin: this.final.transmissiveOutputAlphaMin,
        denoiser: this.final.denoiser ? {...this.final.denoiser, schedule: 'converged'} : null});
      const clayCamera = this.lensCamera(camera, this.pull?.to ?? this.settings.focusDistance);
      await image.converge({samples: options.samples, camera: clayCamera, signal: this.exportAbort.signal, previewIntervalMs: 250,
        onProgress: ({stage, samples, targetSamples}) => set({export: {stage, samples, target: targetSamples}})});
      return await this.engine.display.toBlob(image, {type, quality});
    } finally {
      image?.dispose(); this.settings = get().settings; this.applyBackground();
      this.sync.update(); this.viewSync.update(); this.engine.update();
      this.exporting = false; this.exportAbort = null; set({export: null});
    }
  }

  cancelExport() {
    this.exportAbort?.abort();
  }

  /** The current scene and settings as a standalone MuTracer program. */
  code() {
    const s = this.settings, state = get();
    const camera = this.activeCamera();
    camera.updateWorldMatrix(true, false);
    const position = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld);
    const focusDistance = this.pull?.to ?? s.focusDistance;
    // Model cameras have no orbit target; aim at the focus plane.
    const target = s.cameraIndex < 0 ? this.controls.target.clone()
      : camera.getWorldDirection(new THREE.Vector3()).multiplyScalar(focusDistance).add(position);
    const preset = state.model?.presetId ? MODEL_PRESETS.find((p) => p.id === state.model!.presetId) : undefined;
    const env = ENVIRONMENT_PRESETS.find((p) => p.id === s.envId);
    const grounded = autoGroundedSkybox(state.modelRadius, s.groundedHeight);
    const anim = state.animation;
    const metadataLights: NonNullable<Parameters<typeof generateCode>[0]['metadataLights']> = [];
    this.model?.root.traverse((object) => {
      if (!object.userData.mutracerMetadataLight) return;
      const light = object as THREE.DirectionalLight;
      metadataLights.push({ color: [light.color.r, light.color.g, light.color.b], intensity: light.intensity,
        position: light.getWorldPosition(new THREE.Vector3()).toArray(), target: light.target.getWorldPosition(new THREE.Vector3()).toArray() });
    });
    return generateCode({
      settings: s,
      webgpu: this.engine.backend === 'webgpu',
      modelUrl: preset ? preset.url : state.model?.sourceUrl ?? null,
      environmentUrl: env ? environmentUrl(env, s.envResolution) : null,
      blackEnvironment: s.envId === 'model' && !this.model?.lighting?.environment,
      metadataLights,
      camera: {
        projection: isOrthographic(camera) ? 'orthographic' : 'perspective',
        fov: isOrthographic(camera) ? 0 : camera.fov,
        halfHeight: isOrthographic(camera) ? (camera.top - camera.bottom) / 2 : 0,
        zoom: camera.zoom, near: camera.near, far: camera.far,
        position: position.toArray(), target: target.toArray(), up: camera.up.toArray()
      },
      focusDistance,
      metersPerUnit: s.metersPerUnit ?? state.lens.guessedMetersPerUnit,
      groundSize: this.ground.scale.x,
      grounded: { height: grounded.height, radius: s.groundedRadius ?? grounded.radius },
      studioLights: (this.studioRig.children as THREE.RectAreaLight[]).map((light) => ({
        name: light.name, intensity: light.intensity, width: light.width, height: light.height,
        position: light.position.toArray(), quaternion: light.quaternion.toArray() as [number, number, number, number]
      })),
      animation: anim?.playing ? { clip: anim.clip, speed: anim.speed, loop: anim.loop } : null
    });
  }

  /** {@link code} as Markdown with the viewer state, for coding agents. */
  agentMarkdown() {
    const s = this.settings, model = get().model;
    // The view fit rewrites the focus distance; it only matters with depth of field.
    const changed = Object.fromEntries((Object.keys(s) as (keyof Settings)[])
      .filter((key) => s[key] !== DEFAULT_SETTINGS[key] && !(key === 'focusDistance' && !(s.fStop > 0)))
      .map((key) => [key, s[key]]));
    return formatForAgent(this.code(), {
      modelName: model?.name ?? null,
      credit: model?.credit ?? null,
      viewerUrl: model?.presetId ? location.href : null,
      changedSettings: changed
    });
  }

  // ------------------------------------------------------------ render loop

  private resize() {
    this.needsResize = false;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const height = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    const size = this.engine.display.canvas;
    if (size.width !== width || size.height !== height) this.engine.display.setSize(width, height);
    setAspect(this.activeCamera(), this.viewAspect());
  }

  private frame = (now: number) => {
    this.raf = requestAnimationFrame(this.frame);
    const dt = Math.min((now - (this.lastTime || now)) / 1000, 0.1);
    this.lastTime = now;
    if (this.exporting) return;
    if (this.needsResize) this.resize();

    const anim = get().animation;
    if (anim?.playing && this.mixer && this.action) {
      this.mixer.update(dt * anim.speed);
      const finished = !anim.loop && this.action.time >= anim.duration - 1e-3;
      if (now - this.lastPublish > 100 || finished) {
        set({ animation: { ...anim, time: this.action.time, playing: !finished } });
      }
    }

    if (get().paused) {
      this.publishStats('paused', now, true);
      this.updateSelectionRect();
      return;
    }
    const phase = this.loop.tick();
    this.publishLens(this.activeCamera());
    const shown = phase === 'previewing' ? this.preview : this.final;
    if (this.displaySamples(shown) > 0) this.displayed = shown;
    // Query only after the renderer uploads the current animation pose and
    // camera. Readback runs alongside subsequent frames.
    if (phase !== 'preparing' && phase !== 'compiling' && phase !== 'error') {
      this.updateAutofocus(now);
    }
    this.publishStats(phase, now, false);
    this.updateSelectionRect();
  };

  private displaySamples(render: Render): number {
    return VIEWER_AOVS.some(kind => kind === this.settings.output) ? render.aovSamplesRendered : render.samples;
  }

  private publishStats(phase: RenderPhase, now: number, force: boolean) {
    const samples = phase === 'previewing' ? 0 : this.displaySamples(this.final);
    // Restarted accumulation (an edit, a camera move or an animation frame).
    if (samples < this.lastSamples || samples <= 1) this.sampleStart = now;
    // Time stops at the last added sample, so it freezes once rendering finishes.
    if (samples !== this.lastSamples) this.lastSampleTime = now;
    this.lastSamples = samples;
    if (this.awaitingFirstSample) {
      const loading = get().loading;
      // Preparation keeps the previous scene's accumulation alive. Only a
      // rendering phase can confirm that the newly loaded model has a sample.
      const hasNewSample = (samples > 0 && (phase === 'converging' || phase === 'denoising' || phase === 'finished')) ||
        (phase === 'previewing' && (this.displayed ? this.displaySamples(this.displayed) : 0) > 0);
      if (hasNewSample || phase === 'error') {
        this.awaitingFirstSample = false;
        set({ loading: null });
      } else if (loading) {
        const stage = phase === 'compiling' ? 'shaders'
          : phase === 'preparing' ? 'bvh' : loading.stage;
        if (loading.stage !== stage) set({ loading: { ...loading, stage } });
      }
    }
    const prev = get().stats;
    if (!force && phase === prev.phase && now - this.lastPublish < 120) return;
    this.lastPublish = now;
    const elapsed = samples > 1 ? Math.max(0, this.lastSampleTime - this.sampleStart) / 1000 : 0;
    const size = {width: this.final.width, height: this.final.height};
    if (prev.phase === phase && prev.samples === samples && prev.elapsed === elapsed &&
      prev.width === size.width && prev.height === size.height) return;
    set({
      stats: {
        phase, samples, elapsed,
        msPerSample: samples > 1 ? (elapsed * 1000) / (samples - 1) : 0,
        width: size.width, height: size.height
      }
    });
  }

}

const toArray = <T>(value: T | T[]): T[] => (Array.isArray(value) ? value : [value]);

function isVisible(object: THREE.Object3D) {
  for (let o: THREE.Object3D | null = object; o; o = o.parent) if (!o.visible) return false;
  return true;
}

function triangleCount(mesh: THREE.Mesh) {
  const geometry = mesh.geometry;
  return Math.floor((geometry.index ? geometry.index.count : geometry.getAttribute('position')?.count ?? 0) / 3);
}

/** "ANGLE (Apple, ANGLE Metal Renderer: Apple M3 Max, …)" -> "Apple M3 Max". */
function shortAdapterName(name: string) {
  const renderer = /Renderer: ([^,)]+)/.exec(name)?.[1];
  const angle = /^ANGLE \(([^,]+), ([^,(]+)/.exec(name);
  return (renderer ?? angle?.[2] ?? name).trim();
}

function defaultName(kind: TreeNode['kind']) {
  return kind === 'mesh' ? 'Mesh' : kind === 'light' ? 'Light' : kind === 'camera' ? 'Camera' : 'Group';
}

let current: ViewerEngine | null = null;
/** The engine of the mounted viewport, for UI actions. */
export const getEngine = () => current;
export const setEngine = (engine: ViewerEngine | null) => { current = engine; };

declare global {
  interface Window {
    /** Scripting entry point for coding agents and the console. */
    mutracerViewer?: { code(): string | null; agentMarkdown(): string | null };
  }
}
window.mutracerViewer = { code: () => current?.code() ?? null, agentMarkdown: () => current?.agentMarkdown() ?? null };

/** Sets the frame aspect, keeping an orthographic camera's height and center. */
function setAspect(camera: ViewCamera, aspect: number) {
  if (isOrthographic(camera)) {
    const halfWidth = ((camera.top - camera.bottom) / 2) * aspect;
    const centerX = (camera.left + camera.right) / 2;
    camera.left = centerX - halfWidth;
    camera.right = centerX + halfWidth;
  } else {
    camera.aspect = aspect;
  }
  camera.updateProjectionMatrix();
}
