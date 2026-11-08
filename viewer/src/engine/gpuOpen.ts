import { fetchWithProgress } from './fetchWithProgress';
import { filterTextures } from './polyHaven';

export const GPUOPEN_API = '/api/gpuopen/';
export const GPUOPEN_PACKAGE_LIMIT = 128 * 1048576;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export interface GpuOpenMaterial {
  id: string; name: string; author: string; license: string; year: string;
  categories: string[]; tags: string[]; downloads: number;
  packages: string[]; render: string | null;
}
export interface GpuOpenPackage { id: string; label: string; size: string; bytes: number; url: string }
export interface GpuOpenLicense { name: string; description: string }
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid GPUOpen data');
  return value as Record<string, unknown>;
};
const string = (value: unknown) => typeof value === 'string' ? value : '';
const ids = (value: unknown) => Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string' && UUID.test(id)) : [];
export function parseGpuOpenPage(value: unknown) {
  const data = record(value);
  if (!Array.isArray(data.results) || typeof data.count !== 'number' || !Number.isSafeInteger(data.count) || data.count < 0 || data.count > 10000) throw new Error('Invalid GPUOpen catalog');
  return { results: data.results.map(record), count: data.count };
}
export function parseGpuOpenMaterial(value: unknown, categories: Map<string, string>, tags: Map<string, string>): GpuOpenMaterial {
  const data = record(value), id = string(data.id), name = string(data.title);
  if (!UUID.test(id) || !name) throw new Error('Invalid GPUOpen material');
  return {
    id, name, author: string(data.author) || 'Unknown author', license: string(data.license),
    year: string(data.created_date).slice(0, 4), downloads: 0,
    categories: [categories.get(string(data.category)) ?? 'Uncategorized'],
    tags: ids(data.tags).map(id => tags.get(id) ?? '').filter(Boolean),
    packages: ids(data.packages), render: ids(data.renders_order)[0] ?? ids(data.renders)[0] ?? null
  };
}
export function parseGpuOpenPackage(value: unknown): GpuOpenPackage {
  const data = record(value), id = string(data.id), label = string(data.label), size = string(data.size);
  if (!UUID.test(id) || !label) throw new Error('Invalid GPUOpen package');
  const url = new URL(string(data.file_url));
  if (url.href !== `https://api.matlib.gpuopen.com/api/packages/${id}/download/`) throw new Error('Invalid GPUOpen package URL');
  const match = /^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB)$/i.exec(size);
  const bytes = match ? Number(match[1]) * 1024 ** ['B', 'KB', 'MB', 'GB'].indexOf(match[2].toUpperCase()) : Infinity;
  return { id, label, size, bytes, url: `${GPUOPEN_API}packages/${id}/download/` };
}
export const gpuOpenSource = (id: string) => `https://matlib.gpuopen.com/main/materials/all?material=${encodeURIComponent(id)}`;
export const gpuOpenThumbnail = (id: string) => `https://api.matlib.gpuopen.com/api/renders/${id}/download_thumbnail/`;
export const filterGpuOpenMaterials = filterTextures;
export const canDownloadGpuOpen = (material: GpuOpenMaterial) => ['MIT Public Domain', 'CC0 Public Domain'].includes(material.license);
export const defaultGpuOpenPackage = (packages: GpuOpenPackage[]) =>
  packages.find(p => /^1k\s+8b$/i.test(p.label) && p.bytes <= GPUOPEN_PACKAGE_LIMIT) ?? packages.find(p => p.bytes <= GPUOPEN_PACKAGE_LIMIT);

async function json(path: string, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(`${GPUOPEN_API}${path}`, { signal });
  if (!response.ok) throw new Error(`GPUOpen request failed (${response.status})`);
  return response.json();
}
async function list(path: string, signal?: AbortSignal) {
  const all: Record<string, unknown>[] = [];
  for (let offset = 0; ; ) {
    const page = parseGpuOpenPage(await json(`${path}/?limit=1000&offset=${offset}`, signal));
    all.push(...page.results); offset += page.results.length;
    if (offset >= page.count) return all;
    if (!page.results.length) throw new Error('Incomplete GPUOpen catalog');
  }
}
let catalog: Promise<{ materials: GpuOpenMaterial[]; licenses: GpuOpenLicense[] }> | undefined;
export function listGpuOpenMaterials() {
  return catalog ??= Promise.all([list('materials'), list('categories'), list('tags'), list('licenses')]).then(([materials, categories, tags, licenses]) => {
    const titles = (values: Record<string, unknown>[]) => new Map(values.map(v => [string(v.id), string(v.title)]));
    const c = titles(categories), t = titles(tags);
    return { materials: materials.map(m => parseGpuOpenMaterial(m, c, t)),
      licenses: licenses.map(l => ({ name: string(l.name), description: string(l.description).replace(/\\n/g, '\n') })) };
  }).catch(error => { catalog = undefined; throw error; });
}
export async function gpuOpenPackages(material: GpuOpenMaterial, signal?: AbortSignal) {
  return Promise.all(material.packages.map(async id => parseGpuOpenPackage(await json(`packages/${id}/`, signal))));
}
export async function downloadGpuOpenPackage(pkg: GpuOpenPackage, progress: (loaded: number, total: number) => void, signal: AbortSignal) {
  if (pkg.bytes > GPUOPEN_PACKAGE_LIMIT) throw new Error('Package exceeds the 128 MB limit');
  const data = await fetchWithProgress(pkg.url, progress, signal);
  signal.throwIfAborted();
  return [{ file: new File([data], `${pkg.id}.zip`, { type: 'application/zip' }), path: `${pkg.id}.zip` }];
}
