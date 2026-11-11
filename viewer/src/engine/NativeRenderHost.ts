import Engine, { type EngineInfo, type EngineDiagnostics, type WaitForMaterialGraphsOptions } from '../../../src/Engine';
import Render, { type RenderOptions, type DenoiserOptions, type RenderStatus, type SampleEvent, type ConvergeOptions, type ConvergeResult } from '../../../src/Render';
import RenderLoop, { type RenderLoopOptions, type RenderLoopStatus } from '../../../src/RenderLoop';
import type Sync from '../../../src/Sync';
import type { ModelSource } from './loadModel';
import type { DepthSampleArea } from '../../../src/renderer/depthQuery';
import { SceneChangeDetector } from '../../../src/renderer/sceneChangeDetector';
import { NativeSceneEncoder, cameraWords } from './nativeScene';
import { NativeTransport, type NativeReply, pointerPacket } from './nativeTransport';
import type { PixelKind } from './ViewerEngine';
import { Events } from '../../../src/util/events';
import { useViewer } from '../store';
declare global {
    interface Window {
        ipc?: {
            postMessage(message: string): void;
        };
        mutracerNativeReceive?: (reply: NativeReply) => void;
    }
}
import { bindNativeDeviceChange, type NativeCapabilities } from './nativeCapabilities';
export interface NativeModelFiles {
    hostPath: string;
    files: { path: string; blob: string; size: number; lastModified: number }[];
}
export interface TargetState {
    samples: number;
    aovSamples: number;
    width: number;
    height: number;
    status: RenderStatus;
    denoising: boolean;
    frameTimeMs?: number;
}
const renderKeys = ['maxSamples', 'bounces', 'clamping', 'samplingPattern', 'alphaBlendStrategy', 'directLightCandidates', 'bevel', 'bevelSamples', 'dispersionWavelengths', 'transmissiveOutputAlphaMin', 'timeBudgetMs', 'batchSamples', 'resolutionScale', 'adaptiveResolution', 'aovs', 'aovSamples', 'aovResolution', 'caustics'] as const;
const displayKeys = ['toneMapping', 'toneMappingExposure', 'contrast', 'saturation', 'temperature', 'tint', 'channel', 'vignette', 'bloomIntensity', 'bloomThreshold', 'bloomRadius', 'shadowCatcherColor', 'shadowCatcherAlpha', 'hdrOutputEnabled', 'aovDepthRange', 'aovPositionScale', 'aovMotionScale', 'aovIdComponent'] as const;
// Three.js decomposes the native matrix to keep the camera inspector current.
// Recomposition can perturb the unit rotation, including entries near zero.
// Compare those entries at f32 precision; lens fields and translation stay exact.
function matchesNativeCamera(words: number[], native: Uint32Array | undefined) {
    if (!native) return false;
    const floats = new Float32Array(new Uint32Array(words).buffer), other = new Float32Array(native.buffer);
    return words.every((word, i) => i < 16 ? word === native[i] :
        word === native[i] || i < 28 && Math.abs(floats[i] - other[i]) <= 8 * 2 ** -23);
}
/** Viewer-private remote Engine. The inherited data/settings objects allocate no GPU. */
export class NativeRenderHost extends Engine {
    readonly transport: NativeTransport;
    readonly targets = new Map<number, NativeRender>();
    capabilities?: NativeCapabilities;
    phase: RenderLoopStatus = 'preparing';
    private detector = new SceneChangeDetector();
    private encoder = new NativeSceneEncoder(async (source) => {
        const result = await this.transport.request<{
            blob: string;
        }>('sky', source);
        return { width: source.width, height: source.height, data: new Float32Array(await this.download(result.blob)) };
    });
    private remoteInfo?: EngineInfo;
    private ready?: Promise<EngineInfo>;
    private updating?: Promise<void>;
    private syncError?: Error;
    cameraTarget?: number[];
    private lastCamera = '';
    private nativeCamera?: Uint32Array;
    private nativeCameraRevision = 0;
    private lastSettings = '';
    private serial = 0;
    private targetSerial = 0;
    private stopped = false;
    private off: (() => void)[] = [];
    private nativeDiagnostics?: EngineDiagnostics;
    private upscale = false;
    private requestedSelection: 'preview' | 'final' = 'final';
    coalesce = false;
    changing = false;
    previewId?: number;
    finalId?: number;
    onCamera?: (matrix: number[], target: number[], zoom: number) => void;
    nativeSize?: [
        number,
        number
    ];
    onResize?: () => void;
    onViewportClick?: (x: number, y: number) => void;
    constructor(canvas: HTMLCanvasElement) {
        super({ canvas });
        if (!window.ipc)
            throw new Error('Native IPC unavailable');
        this.transport = new NativeTransport(message => window.ipc!.postMessage(message), (name, value) => this.receive(name, value));
        window.mutracerNativeReceive = reply => this.transport.receive(reply);
        this.display.toBlob = async (render, options) => {
            await this.flush();
            const { blob } = await this.transport.request<{
                blob: string;
            }>('image', { target: (render as NativeRender).id });
            const png = new Blob([await this.download(blob)], { type: 'image/png' });
            if (!options?.type || options.type === 'image/png')
                return png;
            const image = await createImageBitmap(png), out = document.createElement('canvas');
            out.width = image.width;
            out.height = image.height;
            out.getContext('2d')!.drawImage(image, 0, 0);
            image.close();
            return new Promise<Blob>((resolve, reject) => out.toBlob(value => value ? resolve(value) : reject(Error('Image encoding failed')), options.type, options.quality));
        };
        this.display.addPostProcess = () => { this.upscale = true; return () => { this.upscale = false; }; };
        const bounds = () => { const r = canvas.getBoundingClientRect(); this.command('viewport', { x: r.x, y: r.y, width: r.width, height: r.height, dpr: devicePixelRatio }); };
        const observer = new ResizeObserver(bounds);
        observer.observe(canvas);
        // A docking move need not resize the canvas.
        let oldBounds = '';
        const timer = setInterval(() => { const r = canvas.getBoundingClientRect(), key = JSON.stringify([r.x, r.y, r.width, r.height, devicePixelRatio]); if (key !== oldBounds) {
            oldBounds = key;
            bounds();
        } }, 500);
        this.off.push(() => { observer.disconnect(); clearInterval(timer); });
        let held = false;
        const pointer = (op: number, e: PointerEvent) => window.ipc!.postMessage(pointerPacket(op, e.clientX, e.clientY, e.button, e.shiftKey ? 1 : 0));
        const down = (e: PointerEvent) => { if (e.button > 2)
            return; held = true; canvas.setPointerCapture(e.pointerId); pointer(0, e); };
        const move = (e: PointerEvent) => { if (held)
            pointer(1, e); };
        const up = (e: PointerEvent) => { if (held) {
            held = false;
            pointer(2, e);
        } };
        const wheel = (e: WheelEvent) => { e.preventDefault(); window.ipc!.postMessage(pointerPacket(3, e.deltaY * (e.deltaMode === 1 ? 16 : 1), 0)); };
        canvas.addEventListener('pointerdown', down);
        canvas.addEventListener('pointermove', move);
        canvas.addEventListener('pointerup', up);
        canvas.addEventListener('pointercancel', up);
        canvas.addEventListener('lostpointercapture', up);
        canvas.addEventListener('wheel', wheel, { passive: false });
        this.off.push(() => { canvas.removeEventListener('pointerdown', down); canvas.removeEventListener('pointermove', move); canvas.removeEventListener('pointerup', up); canvas.removeEventListener('pointercancel', up); canvas.removeEventListener('lostpointercapture', up); canvas.removeEventListener('wheel', wheel); });
        this.off.push(useViewer.subscribe((state, prev) => { if (state.paused !== prev.paused)
            this.command('pause', { paused: state.paused }); }));
    }
    private receive(name: string, value: unknown) {
        if (name === 'state') {
            const state = value as {
                phase: RenderLoopStatus;
                targets: Record<string, TargetState>;
                diagnostics?: EngineDiagnostics;
                viewportSize?: [
                    number,
                    number
                ];
            };
            this.phase = state.phase;
            if (this.capabilities?.layout === 'split' && state.viewportSize && (state.viewportSize[0] !== this.nativeSize?.[0] || state.viewportSize[1] !== this.nativeSize?.[1])) {
                this.nativeSize = state.viewportSize;
                this.onResize?.();
            }
            for (const [id, target] of this.targets)
                if (state.targets[id])
                    target.accept(state.targets[id]);
            if (state.diagnostics)
                this.nativeDiagnostics = state.diagnostics;
        }
        else if (name === 'camera') {
            const camera = value as {
                matrix: number[];
                target: number[];
                zoom: number;
                words?: number[];
                revision?: number;
            };
            if (camera.words?.length === 32) this.nativeCamera = Uint32Array.from(camera.words);
            if (camera.revision !== undefined) this.nativeCameraRevision = camera.revision;
            this.onCamera?.(camera.matrix, camera.target, camera.zoom);
        }
        else if (name === 'viewportClick') {
            const point = value as {
                x: number;
                y: number;
            };
            this.onViewportClick?.(point.x, point.y);
        }
        else if(name==='sample'){const sample=value as SampleEvent&{target:number};this.targets.get(sample.target)?.publishSample(sample);}
        else if(name==='progress'){const progress=value as {stage:'bvh'|'shaders';progress:number};useViewer.setState(state=>state.loading?{loading:{...state.loading,stage:progress.stage}}:{});}
        else if (name === 'error')
            this._notifyError(new Error(String(value)));
        else if (name === 'exportProgress') {
            const p = value as {
                target: number;
                stage: 'final' | 'denoising';
                samples: number;
                targetSamples: number;
            };
            this.targets.get(p.target)?.progress?.(p);
        }
    }
    command(command: string, args?: unknown) { void this.transport.request(command, args).catch(error => { if (!this.stopped)
        this._notifyError(error); }); }
    override get backend() { return this.remoteInfo?.backend; }
    override get info() { return this.remoteInfo; }
    override init() {
        return this.ready ??= this.transport.request<NativeCapabilities>('ready').then(capabilities => {
            this.capabilities = capabilities;
            useViewer.setState({ nativeCapabilities: capabilities });
            document.documentElement.dataset.nativeLayout = capabilities.layout;
            bindNativeDeviceChange(options => this.transport.request('device', options));
            this.remoteInfo = { backend: 'webgpu', adapterName: capabilities.adapterName, limits: { maxTextureDimension2D: capabilities.maxImageDimension, maxTextureArrayLayers: 256 } };
            return this.remoteInfo;
        });
    }
    async upload(data: Uint8Array | readonly Uint8Array[]) {
        const id = String(++this.serial);
        const parts = data instanceof Uint8Array ? [data] : data;
        const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
        let offset = 0;
        try {
            // WebKit copies a BufferSource into FormData. Bound that copy and
            // retain views of descriptor spans rather than another whole packet.
            let index = 0, at = 0;
            while (offset < total) {
                while (at === parts[index].byteLength) {index++; at = 0;}
                const length = Math.min(8 * 1024 * 1024, total - offset), part = parts[index];
                let body: Uint8Array;
                if (part.byteLength - at >= length) {
                    body = part.subarray(at, at + length); at += length;
                } else {
                    // Pack small records and span headers into one bounded upload.
                    // Large contiguous payloads above still use their existing view.
                    body = new Uint8Array(length);
                    let written = 0;
                    while (written < length) {
                        const count = Math.min(length - written, parts[index].byteLength - at);
                        body.set(parts[index].subarray(at, at + count), written);
                        written += count; at += count;
                        if (at === parts[index].byteLength) {index++; at = 0;}
                    }
                }
                const response = await fetch(new URL(`bridge/${id}`, document.baseURI), {
                    method: 'POST', headers: { 'X-Mutracer-Offset': String(offset), 'X-Mutracer-Length': String(total) },
                    body: body as Uint8Array<ArrayBuffer>
                });
                if (!response.ok) throw Error(`Native binary upload: ${response.status}`);
                offset += body.byteLength;
            }
            if (total === 0) {
                const response = await fetch(new URL(`bridge/${id}`, document.baseURI), { method: 'POST', body: new Uint8Array() });
                if (!response.ok) throw Error(`Native binary upload: ${response.status}`);
            }
            return id;
        } catch (error) {
            await fetch(new URL(`bridge/${id}`, document.baseURI), { method: 'DELETE' }).catch(() => {});
            throw error;
        }
    }
    async download(id: string) { const response = await fetch(new URL(`bridge/${id}`, document.baseURI)); if (!response.ok)
        throw Error(`Native binary download: ${response.status}`); return response.arrayBuffer(); }
    async readModelSource(input: string | NativeModelFiles): Promise<ModelSource> {
        const model = typeof input === 'string' ? await this.transport.request<NativeModelFiles>('files', {path: input}) : input;
        const files = await Promise.all(model.files.map(async entry => {
            const response = await fetch(new URL(`bridge/${entry.blob}`, document.baseURI));
            if (!response.ok) throw Error(`Native model read: ${response.status}`);
            const blob = await response.blob();
            if (blob.size !== entry.size) throw Error('Host model resource changed while reading');
            return {path: entry.path, file: new File([blob], entry.path.split('/').pop()!, {lastModified: entry.lastModified})};
        }));
        return {hostPath: model.hostPath, mainPath: files[0].path, base: '', files};
    }
    register(target: NativeRender) { const id = ++this.targetSerial; this.targets.set(id, target); return id; }
    selectRemote(selection: 'preview' | 'final') { this.requestedSelection = selection; }
    override update(): boolean {
        if (this.stopped || this.updating || !this.remoteInfo)
            return false;
        this.updating = this.synchronize().catch(error => { this.syncError = error; this.phase = 'error'; this.detector.reset(); this.encoder.reset(); this.lastCamera = ''; this.lastSettings = ''; this._notifyError(error); }).finally(() => { this.updating = undefined; });
        return true;
    }
    private async synchronize() {
        this.syncError = undefined;
        if (!this.camera)
            return;
        const changes = this.scene ? this.detector.detect(this.scene) : undefined;
        const sceneChanged = changes && (changes.meshes !== 'none' || changes.lights || changes.background);
        let blob: string | undefined;
        let encoded: Awaited<ReturnType<NativeSceneEncoder['prepare']>> | undefined;
        if (sceneChanged && this.scene?.meshes.length) {
            encoded = await this.encoder.prepare(this.scene, this.camera, [this.display.canvas.width, this.display.canvas.height], changes);
            blob = await this.upload(encoded.parts);
        }
        const camera = Array.from(cameraWords(this.camera)), cameraKey = JSON.stringify(camera);
        const settings = { targets: [...this.targets.values()].map(t => t.configuration()), display: Object.fromEntries(displayKeys.map(k => [k, this.display[k]])), size: [this.display.canvas.width, this.display.canvas.height], upscale: this.upscale, aspect: useViewer.getState().settings?.outputAspect, bvhBuilder: this.bvhBuilder, preview: this.previewId, final: this.finalId, selection: this.requestedSelection, coalesce: this.coalesce, changing: this.changing };
        const key = JSON.stringify(settings);
        if (matchesNativeCamera(camera, this.nativeCamera)) this.lastCamera = cameraKey;
        if (blob || sceneChanged || cameraKey !== this.lastCamera || key !== this.lastSettings) {
            await this.transport.request('commit', { blob, clear: sceneChanged && !this.scene?.meshes.length, camera: cameraKey !== this.lastCamera ? camera : undefined, cameraTarget: this.cameraTarget, cameraRevision: this.nativeCameraRevision, settings: key !== this.lastSettings ? settings : undefined });
            encoded?.accept();
            if (sceneChanged && !this.scene?.meshes.length) this.encoder.reset();
            if (sceneChanged)
                this.detector.commit();
            this.lastCamera = cameraKey;
            this.lastSettings = key;
        }
    }
    async flush() { await this.init(); await this.updating; this.update(); await this.updating; if (this.syncError)
        throw this.syncError; }
    override getDiagnostics() { return this.nativeDiagnostics; }
    override async waitForMaterialGraphs(options?: WaitForMaterialGraphsOptions): Promise<Awaited<ReturnType<Engine['waitForMaterialGraphs']>>> {
        await this.flush();
        if (options?.signal?.aborted)
            return { outcome: 'aborted' as const, state: { revision: 0, installedRevision: 0, status: 'idle' as const, diagnostics: [], topologyCount: 0 } };
        const revision = this.nativeDiagnostics?.materialGraphs?.revision;
        for (;;) {
            const result = await this.transport.request<Awaited<ReturnType<Engine['waitForMaterialGraphs']>>>('graphs');
            if (options?.signal?.aborted)
                return { ...result, outcome: 'aborted' };
            if (revision !== undefined && result.state.revision !== revision)
                return { ...result, outcome: 'superseded' };
            if (result.state.status !== 'compiling')
                return result;
            await new Promise<void>(resolve => setTimeout(resolve, 20));
        }
    }
    override async readDepthSamples(area?: DepthSampleArea) { await this.flush(); const values = await this.transport.request<number[] | null>('depth', area); return values ? new Float32Array(values) : undefined; }
    override async _pick(x: number, y: number) { await this.flush(); const result = await this.transport.request<Awaited<ReturnType<Engine['_pick']>> | 'unavailable'>('pick', { x, y }); return result === 'unavailable' ? undefined : result; }
    override dispose() { if (this.stopped)
        return; this.stopped = true; this.off.forEach(off => off()); bindNativeDeviceChange(undefined); this.transport.dispose(); delete window.mutracerNativeReceive; super.dispose(); }
}
export class NativeRender extends Render {
    readonly id: number;
    private state: TargetState = { samples: 0, aovSamples: 0, width: 0, height: 0, status: 'preparing', denoising: false };
    private remoteDenoiser: DenoiserOptions | null = null;
    private sampleEvents = new Events<{
        sample: SampleEvent;
    }>();
    private fixedSize?: [
        number,
        number
    ];
    progress?: ConvergeOptions['onProgress'];
    constructor(readonly host: NativeRenderHost, options: RenderOptions = {}) {
        const { denoiser, ...rest } = options;
        super(host, rest);
        this.id = host.register(this);
        if ('width' in options)
            this.fixedSize = [options.width!, options.height!];
        if (denoiser)
            this.remoteDenoiser = denoiser;
    }
    configuration() { return { id: this.id, settings: Object.fromEntries(renderKeys.map(k => [k, this[k]])), fixedSize: this.fixedSize, fallback: this.fallback ? (this.fallback as NativeRender).id : null, denoiser: this.remoteDenoiser && !this.fixedSize && useViewer.getState().nativeRayReconstruction && useViewer.getState().settings.fStop <= 0 ? { type: 'dlss' } : this.remoteDenoiser }; }
    accept(state: TargetState) {this.state=state;}
    publishSample(event:SampleEvent){this.sampleEvents.emit('sample',{samples:event.samples,isFirstFrame:event.isFirstFrame,frameTimeMs:event.frameTimeMs});}
    override on(event: 'sample', listener: (value: SampleEvent) => void) { return this.sampleEvents.on(event, listener); }
    override get samples() { return this.state.samples; }
    override get aovSamplesRendered() { return this.state.aovSamples; }
    override get width() { return this.fixedSize?.[0] ?? (this.state.width || super.width); }
    override get height() { return this.fixedSize?.[1] ?? (this.state.height || super.height); }
    override get status() { return this.state.status; }
    override get denoising() { return this.state.denoising; }
    override get denoiser() { return this.remoteDenoiser; }
    override setDenoiser(options: DenoiserOptions | null) { this.remoteDenoiser = options; return this.host.flush(); }
    override readPixels(kind: 'id'): Promise<{
        width: number;
        height: number;
        data: Uint32Array;
    }>;
    override readPixels(kind?: Exclude<PixelKind, 'id'>): Promise<{
        width: number;
        height: number;
        data: Float32Array;
    }>;
    override readPixels(kind: PixelKind): Promise<{
        width: number;
        height: number;
        data: Uint32Array | Float32Array;
    }>;
    override async readPixels(kind: PixelKind = 'hdr'): Promise<{
        width: number;
        height: number;
        data: Uint32Array | Float32Array;
    }> {
        await this.host.flush();
        const result = await this.host.transport.request<{
            width: number;
            height: number;
            blob: string;
        }>('pixels', { target: this.id, kind });
        const buffer = await this.host.download(result.blob);
        return { ...result, data: kind === 'id' ? new Uint32Array(buffer) : new Float32Array(buffer) };
    }
    override async converge(options: ConvergeOptions): Promise<ConvergeResult> {
        await this.host.flush();
        options.signal?.throwIfAborted();
        this.progress = options.onProgress;
        const cancel = () => this.host.command('cancel', { target: this.id });
        options.signal?.addEventListener('abort', cancel, { once: true });
        try {
            return await this.host.transport.request<ConvergeResult>('converge', { target: this.id, samples: options.samples, camera: options.camera ? Array.from(cameraWords(options.camera)) : undefined }, 0);
        }
        catch (error) {
            options.signal?.throwIfAborted();
            throw error;
        }
        finally {
            options.signal?.removeEventListener('abort', cancel);
            this.progress = undefined;
        }
    }
    override dispose() { this.host.targets.delete(this.id); this.host.command('dropTarget', { target: this.id }); this.sampleEvents.clear(); super.dispose(); }
}
export class NativeLoop extends RenderLoop {
    private syncs = new Set<Sync>();
    constructor(readonly host: NativeRenderHost, options: RenderLoopOptions) { super(host, { ...options, sync: undefined }); for (const sync of options.sync ? Array.isArray(options.sync) ? options.sync : [options.sync] : [])
        this.addSync(sync); host.previewId = (this.preview as NativeRender | undefined)?.id; host.finalId = (this.final as NativeRender).id; }
    override addSync(sync: Sync) { this.syncs.add(sync); }
    override removeSync(sync: Sync) { this.syncs.delete(sync); }
    override tick() { for (const sync of this.syncs)
        sync.update(); this.host.coalesce = this.coalesceSceneUpdates; this.host.changing = [...this.syncs].some(s => s.active); this.host.selectRemote(this.select({ changing: this.host.changing })); this.host.update(); return this.host.phase; }
    override get status() { return this.host.phase; }
    override dispose() { this.syncs.clear(); super.dispose(); }
}
