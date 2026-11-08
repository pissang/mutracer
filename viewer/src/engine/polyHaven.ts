import type { TextureKey } from './materialParams';
import { fetchWithProgress } from './fetchWithProgress';

/** A Poly Haven texture set (CC0). */
export interface PolyHavenTexture {
  id: string;
  name: string;
  categories: string[];
  tags: string[];
  downloads: number;
}

export type TextureResolution = '1k' | '2k' | '4k';

export const TEXTURE_RESOLUTIONS: { value: TextureResolution; label: string; size: string }[] = [
  { value: '1k', label: '1K', size: '~3 MB per set' },
  { value: '2k', label: '2K', size: '~12 MB per set' },
  { value: '4k', label: '4K', size: '~45 MB per set' }
];

const API = 'https://api.polyhaven.com';

export const polyHavenThumbnail = (id: string) =>
  `https://cdn.polyhaven.com/asset_img/thumbs/${id}.png?width=256&height=256`;

interface AssetEntry {
  name: string;
  categories?: string[];
  tags?: string[];
  download_count?: number;
}

let catalog: Promise<PolyHavenTexture[]> | null = null;

/** Every Poly Haven texture, most downloaded first. Fetched once per session. */
export function listPolyHavenTextures(): Promise<PolyHavenTexture[]> {
  catalog ??= fetchJson<Record<string, AssetEntry>>(`${API}/assets?t=textures`)
    .then((assets) => Object.entries(assets)
      .map(([id, a]) => ({ id, name: a.name, categories: a.categories ?? [], tags: a.tags ?? [], downloads: a.download_count ?? 0 }))
      .sort((a, b) => b.downloads - a.downloads))
    .catch((error) => {
      catalog = null;
      throw error;
    });
  return catalog;
}

/** Matches every word of the query against the name, categories and tags. */
export function filterTextures<T extends PolyHavenTexture>(textures: T[], query: string, category: string | null) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return textures.filter((t) => {
    if (category && !t.categories.includes(category)) return false;
    if (!words.length) return true;
    const text = [t.name, t.id, ...t.categories, ...t.tags].join(' ').toLowerCase();
    return words.every((w) => text.includes(w));
  });
}

/** The categories with the most textures, for quick filters. */
export function topCategories(textures: PolyHavenTexture[], count: number) {
  const counts = new Map<string, number>();
  for (const t of textures) for (const c of t.categories) counts.set(c, (counts.get(c) ?? 0) + 1);
  return [...counts].filter(([c]) => !c.startsWith('collection')).sort((a, b) => b[1] - a[1]).slice(0, count).map(([c]) => c);
}

type FileTree = Record<string, Record<string, Record<string, { url: string; size: number }>>>;

/** The image URLs of a texture set, by material slot, plus whether it has a metal map. */
export interface PolyHavenMaps {
  urls: Partial<Record<TextureKey, string>>;
  metal: boolean;
}

/**
 * Picks the JPG maps for the viewer's slots. The `arm` map packs AO, roughness
 * and metalness in R, G and B, which is the glTF metallic-roughness layout.
 */
export async function polyHavenMaps(id: string, resolution: TextureResolution, displacement = false): Promise<PolyHavenMaps> {
  let request = fileTrees.get(id);
  if (!request) {
    request = fetchJson<FileTree>(`${API}/files/${encodeURIComponent(id)}`);
    fileTrees.set(id, request);
    request.catch(() => fileTrees.delete(id));
  }
  const files = await request;
  const jpg = (map: string) => {
    const sizes = files[map];
    if (!sizes) return undefined;
    // Not every set ships every width; fall back to the nearest smaller one.
    const order = ['8k', '4k', '2k', '1k'];
    for (const r of order.slice(order.indexOf(resolution))) if (sizes[r]?.jpg) return sizes[r].jpg.url;
    return undefined;
  };
  const urls: PolyHavenMaps['urls'] = {
    map: jpg('Diffuse'),
    normalMap: jpg('nor_gl')
  };
  const arm = jpg('arm');
  if (displacement) urls.displacementMap = jpg('Displacement');
  if (arm) urls.metallicRoughnessMap = arm;
  else {
    urls.roughnessMap = jpg('Rough');
    urls.metalnessMap = jpg('Metal');
  }
  for (const key of Object.keys(urls) as TextureKey[]) if (!urls[key]) delete urls[key];
  return { urls, metal: Boolean(files.Metal) };
}

const fileTrees = new Map<string, Promise<FileTree>>();

/** Recently downloaded maps, so switching back to a set is instant. */
const maps = new Map<string, Blob>();
const MAP_CACHE_BYTES = 160 * 1048576;

/** Downloads one map image, from memory when it was downloaded recently. */
export async function downloadPolyHavenMap(
  url: string, onProgress?: (loaded: number, total: number) => void, signal?: AbortSignal
): Promise<Blob> {
  const cached = maps.get(url);
  if (cached) {
    // Refresh its place as the most recently used.
    maps.delete(url);
    maps.set(url, cached);
    onProgress?.(cached.size, cached.size);
    return cached;
  }
  const blob = new Blob([await fetchWithProgress(url, onProgress, signal)], { type: 'image/jpeg' });
  maps.set(url, blob);
  let bytes = 0;
  for (const b of maps.values()) bytes += b.size;
  for (const [key, b] of maps) {
    if (bytes <= MAP_CACHE_BYTES) break;
    maps.delete(key);
    bytes -= b.size;
  }
  return blob;
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText || 'request failed'}: ${url}`);
  return response.json() as Promise<T>;
}
