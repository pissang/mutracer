/// <reference lib="dom" />
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoadedModel } from '../src/engine/loadModel';
import {readURLSettings} from '../src/urlSettings';
import type { CachedModel } from '../src/engine/modelCache';

vi.hoisted(() => {
  vi.stubGlobal('location', { href: 'https://viewer.example.com/', search: '', hash: '', pathname: '/' });
  vi.stubGlobal('document', { baseURI: 'https://viewer.example.com/' });
  vi.stubGlobal('window', {});
  vi.stubGlobal('history', { replaceState: vi.fn() });
});
vi.mock('../src/engine/modelCache', () => ({
  clearMaterialEdits: vi.fn(), clearModelCache: vi.fn(), saveModelCache: vi.fn(), readMaterialEdits: vi.fn()
}));
vi.mock('../src/engine/environment', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/engine/environment')>(),
  loadHDR: vi.fn()
}));
import { ViewerEngine } from '../src/engine/ViewerEngine';
import { Environment, loadHDR, type EquirectData } from '../src/engine/environment';
import { DEFAULT_SETTINGS, VIEWER_AOVS, setSettings, useViewer, type Settings } from '../src/store';

// Exercise the real load/setModel/resetView path; replace GPU synchronization
// and persistence with inert boundaries so these tests run without a device.
function engine() {
  const viewer = Object.create(ViewerEngine.prototype);
  Object.assign(viewer, {
    initialURLSettings: readURLSettings(), loadToken: 0, envToken: 0, model: null, modelId: null, modelCameras: [],
    modelGroup: new THREE.Group(), hiddenAtLoad: new Set(), ground: new THREE.Mesh(),
    canvas: { clientWidth: 800, clientHeight: 600 }, needsResize: false,
    perspectiveCamera: new THREE.PerspectiveCamera(35, 4 / 3),
    orthographicCamera: new THREE.OrthographicCamera(),
    controls: { target: new THREE.Vector3(), update: vi.fn() },
    materials: { flush: vi.fn(), setModel: vi.fn() },
    loop: { removeSync: vi.fn(), addSync: vi.fn() }, sync: { dispose: vi.fn() },
    createSync: () => ({ dispose: vi.fn() }),
    applyStudioRig: vi.fn(), applyBackground: vi.fn(), requestAutofocus: vi.fn(),
    saveCamera: vi.fn(), restoreCamera: vi.fn(() => false)
  });
  Object.defineProperty(viewer, 'settings', { get: () => useViewer.getState().settings });
  return viewer as Pick<ViewerEngine, 'loadModel' | 'applyModelCamera' | 'fit'> & {
    // Private orchestration entry point, also used by loadPreset/loadInitialModel.
    load: (name: string, loader: () => Promise<LoadedModel>, meta: CachedModel['meta'], restored?: CachedModel) => Promise<boolean>;
    restoreCamera: ReturnType<typeof vi.fn>;
  };
}

function model(count: number): LoadedModel {
  const root = new THREE.Group();
  root.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial()));
  for (let i = 0; i < count; i++) {
    const camera = new THREE.PerspectiveCamera();
    camera.name = `View ${i + 1}`;
    root.add(camera);
  }
  return { name: 'Camera model', root, animations: [], revoke: vi.fn() };
}

beforeEach(() => {
  Object.assign(location,{search:'',hash:''});
  useViewer.setState({ settings: { ...DEFAULT_SETTINGS }, toast: null, cameras: [] });
});

describe('AOV preview settings', () => {
  it.each(['final', 'normal', 'albedo', 'shadow', 'shadowCatcher', ...VIEWER_AOVS] as const)(
    'only requests the visible %s channel on both renders', output => {
      const viewer = engine();
      const final = { aovs: [] }, preview = { aovs: [] };
      Object.assign(viewer, { engine: { display: {} }, final, preview });
      const apply = viewer as unknown as { applySettings(s: Settings, previous: Settings): void };
      const settings = { ...DEFAULT_SETTINGS, output };
      apply.applySettings(settings, settings);
      expect(final.aovs).toEqual(VIEWER_AOVS.filter(kind => kind === output));
      expect(preview.aovs).toEqual(VIEWER_AOVS.filter(kind => kind === output));
    }
  );
});

describe('imported camera choice', () => {
  it.each(['perspective', 'orthographic'] as const)('continues orbiting a transformed %s scene camera from its view around world up', async (projection) => {
    const viewer = engine();
    const data = model(0);
    const source = projection === 'perspective'
      ? new THREE.PerspectiveCamera(53, 4 / 3, 0.05, 250)
      : new THREE.OrthographicCamera(-3, 3, 2, -2, 0.05, 250);
    source.position.set(3, 2, 6);
    source.rotation.set(0.1, 0.4, 0.2);
    source.zoom = 1.25;
    source.updateProjectionMatrix();
    const parent = new THREE.Group();
    parent.position.set(1, 2, -1);
    parent.rotation.set(0.1, -0.3, 0.15);
    parent.scale.setScalar(2);
    parent.add(source);
    data.root.add(parent);
    await viewer.loadModel(data);
    const orbit = viewer as unknown as {
      beginOrbit(): void;
      applySettings(settings: Settings, previous: Settings): void;
      activeCamera(): THREE.PerspectiveCamera | THREE.OrthographicCamera;
      perspectiveCamera: THREE.PerspectiveCamera;
      controls: OrbitControls;
    };
    // OrbitControls supports updates without attaching DOM input listeners.
    const controls = new OrbitControls(orbit.perspectiveCamera);
    controls.enableDamping = true;
    orbit.controls = controls;
    Object.assign(viewer, { engine: { display: {} }, final: {}, preview: {}, focusQueryVersion: 0 });
    viewer.applyModelCamera(source.uuid);
    // Exercise the real settings path that previously disabled scene-camera input.
    controls.enabled = false;
    orbit.applySettings(useViewer.getState().settings, { ...useViewer.getState().settings, cameraIndex: -1 });
    expect(controls.enabled).toBe(true);
    controls.addEventListener('start', () => orbit.beginOrbit());
    source.updateWorldMatrix(true, false);
    const position = source.getWorldPosition(new THREE.Vector3());
    const direction = source.getWorldDirection(new THREE.Vector3());
    const sourceMatrix = source.matrixWorld.clone();
    const unsubscribe = useViewer.subscribe((state, previous) => {
      if (state.settings !== previous.settings) orbit.applySettings(state.settings, previous.settings);
    });
    try { controls.dispatchEvent({ type: 'start' }); } finally { unsubscribe(); }
    const camera = orbit.activeCamera();
    expect(useViewer.getState().settings).toMatchObject({ cameraIndex: -1, projection });
    expect(camera).not.toBe(source);
    expect(camera.position.distanceTo(position)).toBeLessThan(1e-8);
    expect(camera.getWorldDirection(new THREE.Vector3()).dot(direction)).toBeCloseTo(1, 8);
    // The authored roll is dropped so orbiting keeps the horizon level.
    expect(camera.up.toArray()).toEqual([0, 1, 0]);
    expect(new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion).y).toBeCloseTo(0, 8);
    expect(camera.zoom).toBe(source.zoom);
    expect(camera.near).toBe(source.near);
    expect(camera.far).toBe(source.far);
    expect(controls.object).toBe(camera);
    expect(controls.enabled).toBe(true);
    expect(controls.enableDamping).toBe(true);
    if (camera instanceof THREE.PerspectiveCamera) expect(camera.fov).toBe(53);
    else expect(camera.top - camera.bottom).toBe(4);
    const rotation = camera.quaternion.clone();
    controls.autoRotate = true;
    controls.update(1 / 60);
    expect(Math.abs(camera.quaternion.dot(rotation))).toBeLessThan(1);
    source.updateWorldMatrix(true, false);
    expect(source.matrixWorld.equals(sourceMatrix)).toBe(true);
    // Re-selecting the scene camera restores its authored pose.
    viewer.applyModelCamera(source.uuid);
    expect(orbit.activeCamera()).toBe(source);
  });

  it('applies scene-tree cameras by identity and Fit returns to Orbit', async () => {
    const viewer = engine(), data = model(2);
    data.root.children[1].name = data.root.children[2].name = 'Duplicate';
    await viewer.loadModel(data);
    expect(useViewer.getState().settings.groundShadow).toBe(true);
    viewer.applyModelCamera(data.root.children[2].uuid);
    expect(useViewer.getState().settings.cameraIndex).toBe(1);
    expect(useViewer.getState().toast).toBeNull();
    viewer.applyModelCamera('missing');
    expect(useViewer.getState().settings.cameraIndex).toBe(1);
    viewer.fit();
    expect(useViewer.getState().settings.cameraIndex).toBe(-1);
  });

  it('uses imported lighting and falls back to the sky for an unlit replacement', async () => {
    const viewer = engine(), data = model(0);
    data.lighting = { available: true, environment: null, warnings: [] };
    await viewer.loadModel(data);
    expect(useViewer.getState().settings).toMatchObject({ envId: 'model', envIntensity: 1, lighting: 'environment' });
    await viewer.loadModel(model(0));
    expect(useViewer.getState().settings.envId).toBe('sky');
  });

  it.each([false, true])('cancels an older HDRI and keeps the imported environment when it later settles (failure: %s)', async (failure) => {
    const viewer = engine(), scene = new THREE.Scene();
    const pixels = { width: 1, height: 1, data: new Float32Array([5, 2, 1, 1]) };
    Object.assign(viewer, {
      scene, engine: { display: {} }, final: {}, preview: {}, studioRig: new THREE.Group(),
      environment: new Environment({ ...pixels, data: new Float32Array([1, 1, 1, 1]) }),
      studioAmbient: new Environment(pixels),
      applyBackground: (ViewerEngine.prototype as unknown as { applyBackground(): void }).applyBackground
    });
    const environment = viewer as unknown as {
      applyEnvironmentPreset(id: string): Promise<void>;
      applySettings(settings: Settings, previous: Settings): void;
    };
    let resolve!: (data: EquirectData) => void;
    let reject!: (error: Error) => void;
    vi.mocked(loadHDR).mockReturnValueOnce(new Promise((yes, no) => { resolve = yes; reject = no; }));
    setSettings({ envId: 'studio_small_09' });
    const unsubscribe = useViewer.subscribe((state, previous) => {
      if (state.settings !== previous.settings) environment.applySettings(state.settings, previous.settings);
    });
    try {
      const pending = environment.applyEnvironmentPreset('studio_small_09');
      const signal = vi.mocked(loadHDR).mock.calls.at(-1)![2]!;
      expect(signal.aborted).toBe(false);
      const data = model(0);
      data.lighting = { available: true, useByDefault: true, environment: pixels, warnings: [] };
      await viewer.loadModel(data);
      const texture = scene.environment;
      expect(texture?.image.data).toEqual(pixels.data);
      expect(signal.aborted).toBe(true);
      if (failure) reject(new Error('Old environment failed'));
      else resolve({ ...pixels, data: new Float32Array([9, 9, 9, 1]) });
      await pending;
      expect(useViewer.getState().settings).toMatchObject({ lighting: 'environment', envId: 'model', envIntensity: 1 });
      expect(scene.environment).toBe(texture);
      expect(useViewer.getState().envLoading).toBeNull();
      expect(useViewer.getState().toast).toBeNull();
    } finally { unsubscribe(); }
  });

  it('rejects stale scene-lighting settings when the current model has no lights', async () => {
    const viewer = engine();
    await viewer.loadModel(model(0));
    setSettings({ envId: 'model', envIntensity: 0, envRotation: 70 });
    const settings = useViewer.getState().settings;
    (viewer as unknown as { applySettings(s: Settings, previous: Settings): void }).applySettings(settings, settings);
    expect(useViewer.getState().settings).toMatchObject({ envId: 'sky', envIntensity: 1, envRotation: 0 });
  });
  it('offers only Apply camera while retaining all cameras for manual selection', async () => {
    const viewer = engine();
    await viewer.loadModel(model(2));
    expect(useViewer.getState().cameras).toEqual(['View 1', 'View 2']);
    expect(useViewer.getState().settings.cameraIndex).toBe(-1);
    const toast = useViewer.getState().toast!;
    expect(toast.message).toContain('2 cameras');
    expect(toast.actions?.map((action) => action.label)).toEqual(['Apply camera']);
    setSettings({ cameraIndex: 1 });
    expect(useViewer.getState().settings.cameraIndex).toBe(1);
    toast.actions![0].onClick();
    expect(useViewer.getState().settings.cameraIndex).toBe(0);
  });

  it('starts replacement models in Orbit even when the previous camera index exists', async () => {
    const viewer = engine();
    await viewer.loadModel(model(2));
    const oldApply = useViewer.getState().toast!.actions![0].onClick;
    setSettings({ cameraIndex: 1 });
    await viewer.loadModel(model(2));
    expect(useViewer.getState().settings.cameraIndex).toBe(-1);
    oldApply();
    expect(useViewer.getState().settings.cameraIndex).toBe(-1);
    await viewer.loadModel(model(0));
    expect(useViewer.getState().cameras).toEqual([]);
    expect(useViewer.getState().toast).toBeNull();
  });

  it.each([false, true])('prompts on initial/cached loads only if no camera was restored (%s)', async (restored) => {
    const viewer = engine();
    viewer.restoreCamera.mockImplementation(() => {
      if (restored) setSettings({ cameraIndex: 1 });
      return restored;
    });
    const data = model(2);
    const cached: CachedModel = {
      id: 'uploaded-model', meta: { name: data.name, presetId: null, credit: null, sourceUrl: null }
    };
    await viewer.load(data.name, async () => data, cached.meta, cached);
    expect(viewer.restoreCamera).toHaveBeenCalledWith(cached.id);
    expect(useViewer.getState().settings.cameraIndex).toBe(restored ? 1 : -1);
    expect(useViewer.getState().toast !== null).toBe(!restored);
  });

  it.each([false, true])('automatically applies the first research-scene camera on fresh/cached loads (%s)', async (cached) => {
    const viewer = engine(), data = model(2);
    const saved: CachedModel = {
      id: 'preset:research-cornell-box', meta: { name: data.name, presetId: 'research-cornell-box', credit: null, sourceUrl: null }
    };
    await viewer.load(data.name, async () => data, saved.meta, cached ? saved : undefined);
    expect(useViewer.getState().settings.cameraIndex).toBe(0);
    expect(useViewer.getState().settings.groundShadow).toBe(false);
    expect(useViewer.getState().cameras).toEqual(['View 1', 'View 2']);
    expect(useViewer.getState().toast).toBeNull();
    setSettings({ groundShadow: true });
    expect(useViewer.getState().settings.groundShadow).toBe(true);
  });

  it.each([-1, 1])('preserves a restored research-scene camera choice (%s)', async (cameraIndex) => {
    const viewer = engine(), data = model(2);
    const saved: CachedModel = {
      id: 'preset:research-cornell-box', meta: { name: data.name, presetId: 'research-cornell-box', credit: null, sourceUrl: null }
    };
    viewer.restoreCamera.mockImplementation(() => {
      setSettings({ cameraIndex });
      return true;
    });
    await viewer.load(data.name, async () => data, saved.meta, saved);
    expect(useViewer.getState().settings.cameraIndex).toBe(cameraIndex);
    expect(useViewer.getState().settings.groundShadow).toBe(false);
    expect(useViewer.getState().toast).toBeNull();
  });

  it('keeps Orbit when a research scene has no camera', async () => {
    const viewer = engine(), data = model(0);
    await viewer.load(data.name, async () => data,
      { name: data.name, presetId: 'research-cornell-box', credit: null, sourceUrl: null });
    expect(useViewer.getState().settings.cameraIndex).toBe(-1);
    expect(useViewer.getState().settings.groundShadow).toBe(false);
    expect(useViewer.getState().toast).toBeNull();
  });
});

describe('initial link and preset precedence',()=>{
 it.each([false,true])('keeps explicit incoming values on initial and refreshed loads (cached=%s)',async restored=>{
  Object.assign(location,{search:'?causticLightTracing=true',hash:'#caustics=false&causticLightTracing=false&causticPhotonMapping=false&groundShadow=true&maxSamples=128&bounces=12&denoise=false&denoiseModel=small'});
  const viewer=engine(),url=readURLSettings();
  setSettings(url);
  const meta={presetId:'research-cornell-caustic',credit:null,sourceUrl:null};
  const data=model(1);
  await viewer.load('Cornell',async()=>data,meta,restored?{id:'preset:research-cornell-caustic',meta:{name:'Cornell',...meta}}:undefined);
  expect(useViewer.getState().settings).toMatchObject(url);
  // A second engine represents refreshing the normalized share link.
  const refreshed=engine();setSettings({...DEFAULT_SETTINGS,...readURLSettings()});
  await refreshed.load('Cornell',async()=>model(1),meta);
  expect(useViewer.getState().settings).toMatchObject(url);
 });
 it('consumes initial overrides so switching models still resets Cornell caustics',async()=>{
  Object.assign(location,{hash:'#caustics=true&causticLightTracing=false&causticPhotonMapping=true'});
  const viewer=engine();setSettings(readURLSettings());
  const meta={presetId:'research-cornell-caustic',credit:null,sourceUrl:null};
  await viewer.load('Cornell',async()=>model(1),meta);
  expect(useViewer.getState().settings).toMatchObject({caustics:true,causticLightTracing:false,causticPhotonMapping:true});
  await viewer.load('Spheres',async()=>model(0),{...meta,presetId:'spheres'});
  expect(useViewer.getState().settings).toMatchObject({caustics:false,causticLightTracing:true,causticPhotonMapping:false});
  await viewer.load('Cornell',async()=>model(1),meta);
  expect(useViewer.getState().settings).toMatchObject({caustics:true,causticLightTracing:true,causticPhotonMapping:true});
 });
 it('applies a link edited in an open viewer over the scene it loads',async()=>{
  const viewer=engine() as ReturnType<typeof engine>&Pick<ViewerEngine,'openURL'|'loadPreset'>;
  const meta=(presetId:string)=>({presetId,credit:null,sourceUrl:null});
  viewer.loadPreset=async id=>viewer.load(id,async()=>model(1),meta(id));
  await viewer.load('Spheres',async()=>model(0),meta('spheres'));
  useViewer.setState({model:{name:'Spheres',...meta('spheres')}});
  Object.assign(location,{hash:'#model=research-cornell-caustic&caustics=true&causticLightTracing=false&causticPhotonMapping=false'});
  await viewer.openURL('research-cornell-caustic');
  expect(useViewer.getState().settings).toMatchObject({caustics:true,causticLightTracing:false,causticPhotonMapping:false});
  // The same scene only takes the edited settings.
  useViewer.setState({model:{name:'Cornell',...meta('research-cornell-caustic')}});
  Object.assign(location,{hash:'#model=research-cornell-caustic&causticPhotonMapping=true'});
  const load=vi.spyOn(viewer,'loadPreset');
  await viewer.openURL('research-cornell-caustic');
  expect(load).not.toHaveBeenCalled();
  expect(useViewer.getState().settings).toMatchObject({causticLightTracing:false,causticPhotonMapping:true});
 });
 it('keeps incoming authored-lighting overrides on a fresh initial load only',async()=>{
  Object.assign(location,{hash:'#lighting=studio&envId=sky&envIntensity=2&envRotation=35'});
  const viewer=engine(),data=model(0);data.lighting={available:true,environment:null,warnings:[]};
  await viewer.loadModel(data);
  expect(useViewer.getState().settings).toMatchObject({lighting:'studio',envId:'sky',envIntensity:2,envRotation:35});
  const replacement=model(0);replacement.lighting=data.lighting;
  await viewer.loadModel(replacement);
  expect(useViewer.getState().settings).toMatchObject({lighting:'environment',envId:'model',envIntensity:1,envRotation:0});
 });
});
