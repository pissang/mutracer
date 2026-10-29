import {scheduleFrame} from './util/frame.js';
import type Engine from './Engine.js';
import type Display from './Display.js';
import Render, { type RenderOptions, type RenderStatus, type ConvergeOptions, type ConvergeResult, type SampleEvent } from './Render.js';
import type Sync from './Sync.js';
import { Events } from './util/events.js';
import { aovChannel, updateProgressiveState, loopImageState, type ProgressiveState } from './renderer/progressiveScheduler.js';

/** Presentation state; preview images never count as final completion. */
export type RenderLoopStatus = RenderStatus | 'previewing';
export interface RenderLoopOptions {
  /** Presentation settings/canvas. Default engine.display. */ display?: Display;
  /** Preview render/settings, or false to disable. Default half resolution with adaptive scale .125–.5, 80 ms budget, 2 bounces, no bevel, 1 wavelength and 2 light candidates. */ preview?: Render | RenderOptions | false;
  /** Final render/settings. Default a new Render with preview as fallback. */ final?: Render | RenderOptions;
  /** External integrations, invoked in order. Default none. */ sync?: Sync | Sync[];
  /** Idle delay for consecutive edits without explicit sync activity. Default 150 ms. */ idleMs?: number;
  /** Hold preview inference before committing the latest camera/scene. Default false. */ coalesceSceneUpdates?: boolean;
}
interface LoopEvents {
  status: {status: RenderLoopStatus; previous: RenderLoopStatus};
  sample: SampleEvent & {preview: false};
}

/** Built-in interactive policy implemented entirely through the first-layer API. */
export default class RenderLoop {
  readonly preview: Render | undefined;
  readonly final: Render;
  readonly display: Display;
  /** Selection policy. Default changing ? preview : final; absent previews select final. */
  select: (info: {changing: boolean}) => 'preview' | 'final' = ({changing}) => changing ? 'preview' : 'final';
  /** Heuristic idle delay. Default 150 ms. */ idleMs: number;
  /** Defer engine commits while preview inference is pending. Default false. */ coalesceSceneUpdates: boolean;
  private _changing = false;
  private _status: RenderLoopStatus = 'preparing';
  private _events = new Events<LoopEvents>();
  private _syncs = new Set<Sync>();
  private _owned = new Set<Render>();
  private _policy: ProgressiveState = {previousChanged: false, lastContinuousChange: -Infinity, changing: false};
  private _running = false;
  private _busy = false;
  private _disposed = false;
  private _cancelScheduled?: () => void;
  private _refillGeneration = 0;
  private _cancelRefillFrame?: () => void;
  private _warnedTick = false;
  /** Render whose next presentation is waiting for a complete preview frame. */
  private _previewFrameOwner?: Render;
  private _presented?: Render;
  private _finishedImage?: string;
  private _motion?: {render: Render; phase: 'moving' | 'priming' | 'settling' | 'settled'};
  private _unsubscribe: () => void;
  constructor(readonly engine: Engine, options: RenderLoopOptions = {}) {
    // Validate foreign objects before allocating owned resources.
    const syncs = options.sync ? (Array.isArray(options.sync) ? options.sync : [options.sync]) : [];
    for (const sync of syncs) this._checkEngine(sync.engine);
    for (const render of [options.preview, options.final]) if (render instanceof Render) this._checkEngine(render.engine);
    this.display = options.display ?? engine.display;
    this.idleMs = options.idleMs ?? 150;
    this.coalesceSceneUpdates = options.coalesceSceneUpdates ?? false;
    try {
      if (options.preview !== false) this.preview = this._render(options.preview, {
        resolutionScale: .5, timeBudgetMs: 80, adaptiveResolution: {targetFrameMs: 80, minScale: .125},
        bounces: 2, bevel: false, dispersionWavelengths: 1, directLightCandidates: 2,
      });
      this.final = this._render(options.final, {fallback: this.preview ?? null});
    } catch (error) {for (const render of this._owned) render.dispose(); throw error;}
    for (const sync of syncs) this.addSync(sync);
    this._unsubscribe = this.final.on('sample', event => this._events.emit('sample', {...event, preview: false}));
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this._visibility);
  }
  private _render(value: Render | RenderOptions | undefined, defaults: RenderOptions): Render {
    if (value instanceof Render) return value;
    const settings = {...defaults, ...value};
    if (value && 'width' in value) {
      if (!('resolutionScale' in value)) delete settings.resolutionScale;
      if (!('adaptiveResolution' in value)) delete settings.adaptiveResolution;
    }
    const render = new Render(this.engine, settings as RenderOptions); this._owned.add(render); return render;
  }
  private _checkEngine(engine: Engine): void { if (engine !== this.engine) throw new Error('RenderLoop renders and syncs must belong to the same engine.'); }
  private _assertAlive(): void { if (this._disposed) throw new Error('RenderLoop is disposed.'); }
  /** Whether an explicit integration or consecutive edits indicate motion. Default false. */ get changing(): boolean { return this._changing; }
  /** Complete final beauty samples; preview and AOV-only sampling are excluded. Default 0. */ get samples(): number { return this.status === 'previewing' ? 0 : this.final.samples; }
  /** Current presented/execution state. Default preparing. */ get status(): RenderLoopStatus { return this._status; }
  /** Subscribes to status transitions or complete final samples; returns unsubscribe. */
  on<K extends keyof LoopEvents>(event: K, listener: (value: LoopEvents[K]) => void): () => void { return this._events.on(event, listener); }
  /** Adds an integration on this engine. Duplicate registrations are ignored. */
  addSync(sync: Sync): void { this._assertAlive(); this._checkEngine(sync.engine); this._syncs.add(sync); }
  /** Removes an integration without disposing it. */ removeSync(sync: Sync): void { this._syncs.delete(sync); }
  private _setStatus(status: RenderLoopStatus): RenderLoopStatus {
    if (status !== this._status) { const previous = this._status; this._status = status; this._events.emit('status', {status, previous}); }
    return status;
  }
  private _present(render: Render): Render | undefined {
    const shown = this.display.present(render);
    if (shown) this._presented = shown;
    return shown;
  }
  /** Executes one manual tick. Calls during start are ignored with one warning. */
  tick(): RenderLoopStatus {
    this._assertAlive();
    if (this._running) { if (!this._warnedTick) {this._warnedTick = true; console.warn('RenderLoop.tick() is ignored while start() is active.');} return this.status; }
    return this._tick();
  }
  private _tick(): RenderLoopStatus {
    this._cancelRefill();
    const refillGeneration = this._refillGeneration;
    if (this._busy || (typeof document !== 'undefined' && document.hidden)) return this.status;
    for (const sync of this._syncs) sync.update();
    const aov = aovChannel(this.display.channel);
    const refine = (render: Render) => render.refine(aov, {
      batchSamples: render.batchSamples && !this.changing && render !== this.preview,
      targetBatchTimeMs: 4,
    });
    const samples = (render: Render) => aov ? render.aovSamplesRendered : render.samples;
    const owner = this._previewFrameOwner;
    const pendingPreview = !!owner && (owner === this.preview || !owner._completeFor(this.display.channel));
    const tracingPreview = pendingPreview && this.preview?.status === 'converging' && samples(this.preview) === 0;
    const holding = tracingPreview || (!aov && this.coalesceSceneUpdates && pendingPreview && !!this.preview?.denoising);
    // Inference belongs to a presentation, not merely to a background render.
    // A fallback result must never replace an already available final image.
    if (pendingPreview && !holding && this.preview) this._present(this.preview);
    if (!holding) this._previewFrameOwner = undefined;
    const changed = holding ? false : this.engine.update();
    const active = [...this._syncs].some(sync => sync.active);
    this._policy = updateProgressiveState(this._policy, changed, active, performance.now(), this.idleMs);
    this._changing = this._policy.changing;
    const selected = this.select({changing: this.changing});
    if (holding && this.preview) {
      // Finish this image against its committed camera while syncs collect the
      // latest input. Restarting its first tile on every edit starves presentation.
      if (tracingPreview) {
        const status = refine(this.preview);
        if (status === 'error') { this._previewFrameOwner = undefined; return this._setStatus('error'); }
        if ((!this.coalesceSceneUpdates || !this.preview.denoising) && this._present(this.preview)) this._previewFrameOwner = undefined;
      }
      return this._setStatus('previewing');
    }
    const current = selected === 'preview' && this.preview ? this.preview : this.final;
    const idle = !changed && !this.changing;
    if (aov !== 'motion') this._motion = undefined;
    else if (this._motion?.render !== current) {
      // Targets have independent histories. Prime every target switch, even
      // when a final small camera edit coincides with leaving preview.
      this._motion = {render: current, phase: this._motion ? 'priming' : 'moving'};
    } else if ((!idle && this._motion.phase !== 'priming') || (!current._completeFor('motion') && this._motion.phase === 'settled')) {
      this._motion.phase = 'moving';
    }
    const motion = this._motion;
    const imageState = loopImageState(this.final, this.display);
    if (idle && current === this.final && this.status === 'finished' && this.final.status === 'finished' && imageState === this._finishedImage && (!motion || motion.phase === 'settled')) return this.status;
    // Invalidate a completed filter before refinement when display settings changed.
    if (this.status === 'finished' && imageState !== this._finishedImage && this.final.samples > 0) this._present(this.final);
    // Motion describes successive images. One unchanged image retires the last
    // displacement; afterwards leave the finished target idle as usual.
    if (motion?.phase === 'moving' && idle && current._completeFor('motion')) {
      current._restartAovs(); motion.phase = 'settling';
    }
    let status = refine(current);
    if (motion?.phase === 'priming' && status === 'finished') {
      current._restartAovs(); motion.phase = 'settling'; status = refine(current);
    }
    if (motion?.phase === 'settling' && status === 'finished') motion.phase = 'settled';
    // Keep the canvas on the last completed image while filtering the next
    // preview; presenting its raw sample here would overwrite the denoise above.
    const waitingForPreview = !!this.preview && ((current === this.preview && status === 'converging' && samples(current) === 0) || (!aov && this.coalesceSceneUpdates && this.preview.denoising)) &&
      (current === this.preview || (!current._completeFor(this.display.channel) && current.fallback === this.preview));
    if (waitingForPreview) this._previewFrameOwner = current;
    else this._present(current);
    // Execution may already be tracing final tiles while the canvas still shows
    // preview. Only a successful presentation transfers ownership of the image.
    const previewing = waitingForPreview || (!aov && current === this.preview && current.denoising) || (!!this.preview && this._presented === this.preview);
    const next = status === 'error' ? 'error' : previewing ? 'previewing' : status;
    this._finishedImage = next === 'finished' ? loopImageState(this.final, this.display) : undefined;
    if (refillGeneration === this._refillGeneration && !aov && idle && current === this.final && !previewing) this._scheduleRefill();
    return this._setStatus(next);
  }
  private _cancelRefill(): void {
    this._refillGeneration++;
    this._cancelRefillFrame?.(); this._cancelRefillFrame = undefined;
  }
  private _scheduleRefill(): void {
    const device = this.engine.device;
    if (!device || !this._canRefill()) return;
    const generation = this._refillGeneration;
    // A manual tick grants work only until the next display frame. If the host
    // stops ticking (pause/export), it cannot leave a background render running.
    this._cancelRefillFrame = scheduleFrame(() => this._cancelRefill());
    const refill = () => {
      if (generation !== this._refillGeneration || device !== this.engine.device ||
        this._disposed || this._busy || (typeof document !== 'undefined' && document.hidden) ||
        aovChannel(this.display.channel) ||
        !this._canRefill() || [...this._syncs].some(sync => sync.active) ||
        this.select({changing: false}) !== 'final') return;
      const status = this.final.refine(undefined, {targetBatchTimeMs: 4, deferResolve: true});
      if (status === 'error') {this._cancelRefill(); this._setStatus('error'); return;}
      if (status === 'converging') wait();
    };
    const wait = () => {void this.final.whenReadyToRefine().then(queued => {if (queued) refill();}, () => {});};
    // Keep only a short chunk ahead of input. GPU completion, rather than the
    // display refresh rate, paces the next chunk; presentation stays on rAF.
    wait();
  }
  private _canRefill(): boolean {
    const time = this.final.gpuSampleTimeMs;
    return this.final.batchSamples && !this.final.denoising && this.final.samples > 0 &&
      // The backend limits queued work. A long sample can still refill one tile
      // on GPU completion without waiting for the next presentation frame.
      this.final.status === 'converging' && time !== undefined;
  }
  private _schedule(): void {
    if (!this._running || this._busy || this._cancelScheduled !== undefined || (typeof document !== 'undefined' && document.hidden)) return;
    this._cancelScheduled = scheduleFrame(() => { this._cancelScheduled = undefined; try {this._tick();} finally {this._schedule();} });
  }
  private _visibility = (): void => {
    if (document.hidden) {this._cancelFrame(); this._cancelRefill();} else this._schedule();
  };
  private _cancelFrame(): void { this._cancelScheduled?.(); this._cancelScheduled = undefined; }
  /** Starts an idempotent loop; uses a 16 ms timer without rAF. Hidden pages pause automatically. */ start(): void { this._assertAlive(); this._running = true; this._schedule(); }
  /** Stops scheduling without discarding accumulated images. */ stop(): void { this._running = false; this._cancelFrame(); this._cancelRefill(); }
  /** Pauses ticks, converges final, presents it, and resumes a previously running loop. */
  async converge(options: ConvergeOptions): Promise<ConvergeResult> {
    this._assertAlive(); if (this._busy) throw new Error('RenderLoop convergence is already running.');
    this._busy = true; this._previewFrameOwner = undefined; this._cancelFrame(); this._cancelRefill();
    try {
      for (const sync of this._syncs) sync.update(); this.engine.update();
      this._setStatus('preparing');
      const result = await this.final.converge({...options, onProgress: progress => {
        this._setStatus(progress.stage === 'denoising' ? 'denoising' : this.final.status);
        options.onProgress?.(progress);
      }});
      this._present(this.final); this._setStatus('finished'); return result;
    } catch (error) {this._setStatus('error'); throw error;}
    finally {this._busy = false; this._schedule();}
  }
  /** Stops the loop and releases renders it created. Supplied renders/syncs remain owned by the caller. */
  dispose(): void {
    if (this._disposed) return;
    this.stop(); this._disposed = true; this._unsubscribe(); this._events.clear(); this._syncs.clear();
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this._visibility);
    for (const render of this._owned) render.dispose(); this._owned.clear();
  }
}
