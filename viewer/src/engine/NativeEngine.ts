import type {ViewerEngine, ViewerEngineEvents, ExportOptions, PixelKind} from './ViewerEngine';
import type {MaterialGraphWaitResult, MaterialGraph, WaitForMaterialGraphsOptions} from '@meimu/mutracer';
import type {Vector3} from 'three';
import {DEFAULT_SETTINGS, setUi, showToast, useViewer, type SelectedMaterial, type Stats, type TreeNode} from '../store';
import type {LoadedModel, PathedFile} from './loadModel';
import type {MaterialValues, TextureKey} from './materialParams';
import type {TextureSampling} from './modelCache';
import type {TextureResolution} from './polyHaven';
import type {MaterialDropTarget} from './materialDrop';
import {MODEL_PRESETS} from './presets';
import {NativeTransport, blobBase64, pointerPacket, type NativeReply} from './nativeTransport';

declare global {
  interface Window { ipc?: {postMessage(message: string): void}; mutracerNativeReceive?: (reply: NativeReply) => void; }
}
interface SceneSnapshot { name: string; tree: TreeNode[]; materials: SelectedMaterial[]; radius: number; triangles: number; }

/** Prototype adapter. Unsupported commands report a visible error, never a successful edit. */
export class NativeEngine implements ViewerEngine {
  private transport: NativeTransport;
  private materials = new Map<string, SelectedMaterial>();
  private listeners = new Map<string, Set<(value: never) => void>>();
  private cleanups: (() => void)[] = [];
  private observer: ResizeObserver;
  private size = {width: 1, height: 1};
  private disposed = false;
  private restoringSettings = false;
  readonly maxImageDimension = 8192;
  get viewportSize() { return this.size; }

  constructor(canvas: HTMLCanvasElement) {
    if (!window.ipc) throw new Error('Native IPC is unavailable');
    const send = (message: string) => window.ipc!.postMessage(message);
    this.transport = new NativeTransport(send, (name, value) => this.receive(name, value));
    window.mutracerNativeReceive = reply => this.transport.receive(reply);
    useViewer.setState({settings: {...DEFAULT_SETTINGS, denoise: false, groundShadow: false, background: 'color', envId: 'native', resolutionScale: .5}, backend: {name: 'Native', adapter: ''}});
    this.cleanups.push(useViewer.subscribe((state, previous) => {
      if (state.settings !== previous.settings && !this.restoringSettings) {
        const patch = Object.fromEntries(Object.entries(state.settings).filter(([key, value]) => value !== previous.settings[key as keyof typeof state.settings]));
        if (Object.keys(patch).length) void this.transport.request('settings', patch).catch(error => {
          if (this.disposed) return;
          if (useViewer.getState().settings === state.settings) {
            this.restoringSettings = true; useViewer.setState({settings: previous.settings}); this.restoringSettings = false;
          }
          this.report(error);
        });
      }
      if (state.paused !== previous.paused) this.command('pause', {paused: state.paused});
    }));
    let previousBounds = '';
    const bounds = () => {
      const rect = canvas.getBoundingClientRect();
      this.size = {width: Math.max(1, Math.round(rect.width * devicePixelRatio)), height: Math.max(1, Math.round(rect.height * devicePixelRatio))};
      const bounds = {x: rect.x, y: rect.y, width: rect.width, height: rect.height, dpr: devicePixelRatio};
      const key = JSON.stringify(bounds);
      if (key !== previousBounds) { previousBounds = key; this.command('viewport', bounds); }
    };
    this.observer = new ResizeObserver(bounds);
    this.observer.observe(canvas);
    // Docking may move the slot without changing its dimensions.
    window.addEventListener('resize', bounds);
    const timer = setInterval(bounds, 500);
    this.cleanups.push(() => { clearInterval(timer); window.removeEventListener('resize', bounds); });
    let held = false;
    const pointer = (operation: number, event: PointerEvent) => send(pointerPacket(operation, event.clientX, event.clientY, event.button, event.shiftKey ? 1 : 0));
    const down = (event: PointerEvent) => { if (event.button > 2) return; held = true; if (event.isTrusted) canvas.setPointerCapture(event.pointerId); pointer(0, event); event.preventDefault(); };
    const move = (event: PointerEvent) => { if (held) pointer(1, event); };
    const up = (event: PointerEvent) => { if (!held) return; held = false; pointer(2, event); };
    const wheel = (event: WheelEvent) => { event.preventDefault(); send(pointerPacket(3, event.deltaY * (event.deltaMode === 1 ? 16 : 1), 0)); };
    const menu = (event: Event) => event.preventDefault();
    canvas.addEventListener('pointerdown', down); canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up); canvas.addEventListener('pointercancel', up); canvas.addEventListener('lostpointercapture', up);
    canvas.addEventListener('wheel', wheel, {passive: false}); canvas.addEventListener('contextmenu', menu);
    this.cleanups.push(() => {
      canvas.removeEventListener('pointerdown', down); canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', up); canvas.removeEventListener('pointercancel', up); canvas.removeEventListener('lostpointercapture', up);
      canvas.removeEventListener('wheel', wheel); canvas.removeEventListener('contextmenu', menu);
    });
  }
  private report(error: unknown) {
    if (this.disposed) return;
    const value = error instanceof Error ? error : new Error(String(error));
    showToast(value.message, 'error'); this.emit('error', value);
  }
  private command(command: string, args?: unknown) { void this.transport.request(command, args).catch(error => this.report(error)); }
  private unavailable(capability: string) { this.report(new Error(`Native prototype: ${capability} is not available yet`)); }
  private emit<K extends keyof ViewerEngineEvents>(name: K, value: ViewerEngineEvents[K]) {
    this.listeners.get(name)?.forEach(listener => listener(value as never));
  }
  private receive(name: string, value: unknown) {
    if (name === 'scene') {
      const scene = value as SceneSnapshot;
      this.materials = new Map(scene.materials.map(material => [material.id, material]));
      useViewer.setState({model: {name: scene.name, presetId: null, credit: null, sourceUrl: null}, tree: scene.tree,
        modelRadius: scene.radius, sceneInfo: {meshes: scene.tree.length, triangles: scene.triangles, materials: scene.materials.length},
        animation: null, cameras: [], modelLighting: null});
      if (scene.tree[0]) this.select(scene.tree[0].id);
    } else if (name === 'presented') {
      const timing = value as {sentAt: number; hostMs: number};
      this.command('measurement', {...timing, roundTripMs: performance.now() - timing.sentAt});
    } else if (name === 'stats') {
      const stats = value as Stats;
      useViewer.setState({stats, ...(stats.samples > 0 ? {loading: null} : {})}); this.emit('stats', stats);
    } else if (name === 'material') {
      const material = value as SelectedMaterial; this.materials.set(material.id, material);
      if (useViewer.getState().selection.materialId === material.id) useViewer.setState({material});
    } else if (name === 'backend') useViewer.setState({backend: {name: 'Native', adapter: String(value)}});
    else if (name === 'progress') { useViewer.setState({loading: value as ViewerEngineEvents['progress']}); this.emit('progress', value as ViewerEngineEvents['progress']); }
    else if (name === 'sample') this.emit('sample', value as ViewerEngineEvents['sample']);
    else if (name === 'error') this.report(value);
  }
  on<K extends keyof ViewerEngineEvents>(name: K, listener: (value: ViewerEngineEvents[K]) => void) {
    let group = this.listeners.get(name); if (!group) this.listeners.set(name, group = new Set());
    group.add(listener as (value: never) => void); return () => { group.delete(listener as (value: never) => void); };
  }
  dispose() { this.disposed = true; this.observer.disconnect(); this.cleanups.forEach(off => off()); this.transport.dispose(); this.listeners.clear(); delete window.mutracerNativeReceive; }
  async loadInitialModel(_presetId: string | null) {
    try {
      const settings = await this.transport.request<{maxSamples: number}>('ready');
      if (!this.disposed) useViewer.setState(state => ({settings: {...state.settings, ...settings}}));
    } catch (error) { this.report(error); }
  }
  async openURL(presetId: string | null) { if (presetId) await this.loadPreset(presetId); }
  async loadPreset(id: string) {
    const preset = MODEL_PRESETS.find(p => p.id === id);
    if (!preset?.url) { this.unavailable('procedural presets'); return; }
    await this.loadUrl(preset.url);
  }
  async loadModel(_model: LoadedModel) { this.unavailable('procedural scene upload'); }
  async loadUrl(url: string) {
    try {
      const response = await fetch(url); if (!response.ok) throw new Error(`Model download: ${response.status}`);
      await this.loadBlob(await response.blob(), url.split('/').pop() ?? 'model.glb');
    } catch (error) { this.report(error); }
  }
  private async loadBlob(blob: Blob, name: string) {
    useViewer.setState({loading: {name, stage: 'parse', loaded: 0, total: blob.size}});
    try { await this.transport.request('loadBytes', {name, bytes: await blobBase64(blob)}); }
    catch (error) { useViewer.setState({loading: null}); this.report(error); }
  }
  async loadFiles(files: PathedFile[]) {
    if (files.length !== 1 || !/\.(glb|gltf)$/i.test(files[0].path)) { this.unavailable('multi-file glTF, HDR and MaterialX import'); return; }
    await this.loadBlob(files[0].file, files[0].path);
  }
  resetAll() { this.command('sample'); }
  fit() { this.command('fit'); }
  lookAt(position: Vector3, target: Vector3) { this.command('lookAt', {position: position.toArray(), target: target.toArray()}); }
  applyModelCamera(_id: string) { this.unavailable('authored cameras'); }
  pickFocus(_x: number, _y: number) { this.unavailable('focus picking'); }
  async pickMaterialTarget(_x: number, _y: number): Promise<MaterialDropTarget | null> { return null; }
  select(objectId: string | null, materialId?: string | null) {
    const object = useViewer.getState().tree.find(node => node.id === objectId);
    const id = materialId === undefined ? object?.materials[0]?.id ?? null : materialId;
    useViewer.setState({selection: {objectId, materialId: id}, material: id ? this.materials.get(id) ?? null : null});
    if (id) setUi({tab: 'material', right: true});
  }
  selectMaterial(materialId: string, objectId: string) { this.select(objectId, materialId); }
  setVisible(objectId: string, visible: boolean) { this.command('visible', {objectId, visible}); useViewer.setState(state => ({tree: state.tree.map(node => node.id === objectId ? {...node, visible} : node)})); }
  setMaterialValues(materialId: string, values: MaterialValues) { this.command('material', {materialId, values, sentAt: performance.now()}); }
  resetMaterial(materialId: string) { this.command('resetMaterial', {materialId}); }
  setMaterialTextureSampling(_id: string, _slot: TextureKey, _patch: Partial<TextureSampling>, _label: string) { this.unavailable('texture sampling'); }
  async setMaterialTexture(_id: string, _slot: TextureKey, _file: Blob | null, _label: string) { this.unavailable('texture replacement'); }
  async setMaterialXHeight(_id: string, _name: string) { this.unavailable('MaterialX height'); return false; }
  disconnectMaterialGraphInput(_id: string, _terminal: string, _label: string) { this.unavailable('material graphs'); }
  materialGraph(_id: string): MaterialGraph | undefined { return undefined; }
  setMaterialGraph(_id: string, _graph: MaterialGraph | null, _label: string) { this.unavailable('material graphs'); }
  clearMaterialGraph(_id: string, _label: string) { this.unavailable('material graphs'); }
  async setMaterialGraphImage(_id: string, _node: string, _port: string, _file: Blob, _label: string) { this.unavailable('graph images'); }
  async applyPolyHavenTexture(_id: string, _asset: string, _name: string, _resolution: TextureResolution) { this.unavailable('Poly Haven textures'); return false; }
  async importMaterialX(_id: string, _files: PathedFile[]) { this.unavailable('MaterialX import'); return false; }
  selectClip(_index: number) { this.unavailable('animation'); }
  setAnimation(_patch: Partial<{playing: boolean; time: number; speed: number; loop: boolean}>) { this.unavailable('animation'); }
  async downloadViewportImage() {
    try { await this.transport.request('savePng'); } catch (error) { this.report(error); }
  }
  async exportImage(_options: ExportOptions) { this.unavailable('independent export'); }
  async captureImage(): Promise<Blob> {
    const base64 = await this.transport.request<string>('capture');
    return new Blob([Uint8Array.from(atob(base64), c => c.charCodeAt(0))], {type: 'image/png'});
  }
  async renderImage(_options: ExportOptions): Promise<Blob> { throw new Error('Native prototype: independent export is not available yet'); }
  cancelExport() { this.unavailable('export cancellation'); }
  async readPixels(kind: PixelKind = 'hdr') {
    const image = await this.transport.request<{width: number; height: number; data: number[]}>('readPixels', {kind});
    return {...image, data: kind === 'id' ? new Uint32Array(image.data) : new Float32Array(image.data)};
  }
  getDiagnostics() { return undefined; }
  async waitForMaterialGraphs(options?: WaitForMaterialGraphsOptions): Promise<MaterialGraphWaitResult> {
    return {outcome: options?.signal?.aborted ? 'aborted' : 'unavailable', state: {revision: 0, installedRevision: 0, status: 'idle', diagnostics: [], topologyCount: 0}};
  }
  code() { return '// Native prototype: scene code export is not available yet.'; }
  agentMarkdown() { return this.code(); }
}
