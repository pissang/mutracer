import * as THREE from 'three';
import { convert } from '../../../tools/pbrt/convert';
import { prefetchResources } from '../../../tools/pbrt/prefetch';
import { decodeImage } from '../../../tools/pbrt/image-browser';
import { SCENES_BASE, type Inspection, type Warning } from '../../../tools/pbrt/source';
import type { Scene } from '../../../tools/pbrt/scene';
import type { ModelSource, LoadedModel, LoadProgress, ModelBackend } from './loadModel';
import { fetchWithProgress } from './fetchWithProgress';
import catalog from './pbrt-catalog.json';
import { confirmPbrtImport } from './pbrtBudget';
export const isPBRT = (path: string) => /\.pbrt(?:\.gz)?(?:[?#].*)?$/i.test(path);
export async function loadPBRT(source: ModelSource, onProgress: LoadProgress, signal?: AbortSignal, backend: ModelBackend = 'webgpu', downloadedMain?: ArrayBuffer): Promise<LoadedModel> {
  const worker = new Worker(new URL('./pbrt.worker.ts', import.meta.url), { type: 'module' });
  let nextId = 0;
  const pending = new Map<number, { resolve(value: unknown): void; reject(reason: Error): void }>();
  worker.onmessage = event => {
    const task = pending.get(event.data.id); if (!task) return; pending.delete(event.data.id);
    event.data.error ? task.reject(new Error(event.data.error)) : task.resolve(event.data.result);
  };
  worker.onerror = event => { for (const task of pending.values()) task.reject(new Error(`PBRT worker failed: ${event.message}`)); pending.clear(); };
  const call = <T>(command: string, data: Record<string, unknown> = {}, transfer: Transferable[] = []): Promise<T> => new Promise((resolve, reject) => {
    const id = nextId++; pending.set(id, { resolve: value => resolve(value as T), reject }); worker.postMessage({ id, command, ...data }, transfer);
  });
  const abort = () => { for (const task of pending.values()) task.reject(new Error('Scene loading cancelled')); pending.clear(); worker.terminate(); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    signal?.throwIfAborted(); onProgress('parse');
    const sizes = Object.fromEntries(Object.entries(catalog.sizes).map(([path, size]) => [new URL(path, SCENES_BASE).href, size]));
    const report = await call<Inspection>('inspect', { source, sizes, mainBytes: downloadedMain }, downloadedMain ? [downloadedMain] : []);
    await confirmPbrtImport(report, !!source.base, signal); signal?.throwIfAborted();
    onProgress('download', 0, report.totalBytes);
    const built = await call<{ scene: Scene; files: ModelSource['files'] }>('build');
    const files = new Map([...source.files, ...built.files].map(item => [item.path, item]));
    let loaded = [...files.values()].reduce((sum, item) => sum + item.file.size, 0);
    const inFlight = new Map<string, number>();
    const reads = new Map<string, Promise<ArrayBuffer>>();
    const resolver = { read(path: string): Promise<ArrayBuffer> {
      if (reads.has(path)) return reads.get(path)!;
      const promise = (async () => {
        const existing = files.get(path); if (existing) return existing.file.arrayBuffer();
        if (!source.base) throw new Error(`Include ${path} with the dropped folder`);
        const data = await fetchWithProgress(path, received => { inFlight.set(path, received); onProgress('download', loaded + [...inFlight.values()].reduce((a,b)=>a+b,0), report.totalBytes); }, signal);
        inFlight.delete(path);
        loaded += data.byteLength; files.set(path, { path, file: new File([data], path.split('/').pop()!) });
        onProgress('download', loaded + [...inFlight.values()].reduce((a,b)=>a+b,0), report.totalBytes); return data;
      })().finally(() => reads.delete(path)); reads.set(path, promise); return promise;
    } };
    await prefetchResources(report.resources, resolver);
    const converted = await convert(built.scene, resolver, decodeImage, (value, total) => onProgress('parse', value, total), async bytes => {
      const result = await call<{ attributes: Record<string, { array: Float32Array; itemSize: number }>; index?: Uint32Array | Uint16Array }>('ply', { bytes }, [bytes]);
      const g = new THREE.BufferGeometry();
      for (const [name, attr] of Object.entries(result.attributes)) g.setAttribute(name, new THREE.BufferAttribute(attr.array, attr.itemSize));
      if (result.index) g.setIndex(new THREE.BufferAttribute(result.index, 1)); return g;
    }, typeof backend === 'function' ? await backend() : backend);
    source.files = [...files.values()];
    const warnings = built.scene.warnings;
    return { name: source.files.find(item => item.path === source.mainPath)?.file.name ?? source.mainPath.split('/').pop()!, root: converted.root, animations: [], source,
      pbrt: { settings: converted.settings, warnings },
      lighting: { available: true, useByDefault: true, environment: converted.environment && { ...converted.environment, data: converted.environment.data as Float32Array }, warnings: warnings.map(formatWarning) }, revoke() {} };
  } catch (error) {
    if (error instanceof RangeError || /memory|allocation/i.test(String(error))) throw new Error(`PBRT scene could not fit the browser memory budget: ${(error as Error).message}`);
    throw error;
  } finally { signal?.removeEventListener('abort', abort); worker.terminate(); }
}
export function formatWarning(w: Warning) { const path = w.file.startsWith(SCENES_BASE) ? decodeURIComponent(w.file.slice(SCENES_BASE.length)) : w.file; return `${path}:${w.line} · ${w.statement}: ${w.handling}${w.count ? ` (${w.count} occurrences, through line ${w.lastLine})` : ''}`; }
