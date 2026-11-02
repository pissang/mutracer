import { FEATURE_COVERAGE, type Coverage } from './coverage';
import { PbrtError, parse, type Statement } from './parser';
export interface Resolver {
  read(path: string): Promise<ArrayBuffer>;
  size?(path: string): Promise<number | undefined>;
}
export interface Warning { statement: string; file: string; line: number; handling: string; code: string; count?: number; lastLine?: number }
export interface Resource { path: string; bytes?: number; kind: 'text' | 'geometry' | 'texture' | 'spectrum' | 'other' }
export const SCENES_COMMIT = '30cf4a0346ae5a80a2d7a530a3ef7d0fa4f70572';
export const SCENES_BASE = `https://raw.githubusercontent.com/mmp/pbrt-v4-scenes/${SCENES_COMMIT}/`;

/** PBRT resolves every filename against the top-level scene, including nested
 * Includes (src/pbrt/util/file.cpp); it does not change directory per Include. */
export function resolvePath(path: string, entry: string): string {
  if (/^[a-z]+:\/\//i.test(entry)) return new URL(/^[a-z]+:\/\//i.test(path) ? path : encodeURI(path).replace(/[?#]/g, encodeURIComponent), entry).href;
  if (/^[a-z]+:\/\//i.test(path)) return path;
  const prefix = path.startsWith('/') ? '' : entry.slice(0, entry.lastIndexOf('/') + 1);
  const parts: string[] = [];
  for (const part of `${prefix}${path}`.split('/')) {
    if (part === '..' && !parts.length && (prefix + path).startsWith('/')) continue;
    if (part === '..' && parts.length && parts[parts.length - 1] !== '..') parts.pop();
    else if (part === '..' || part && part !== '.') parts.push(part);
  }
  return `${(prefix + path).startsWith('/') ? '/' : ''}${parts.join('/')}`;
}

export function urlResolver(signal?: AbortSignal): Resolver {
  return {
    async read(path) { const response = await fetch(path, { signal }); if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`); return response.arrayBuffer(); },
    async size(path) {
      const response = await fetch(path, { method: 'HEAD', signal });
      if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
      const length = response.headers.get('content-length');
      return length === null ? undefined : Number(length);
    }
  };
}

export async function decompress(bytes: ArrayBuffer): Promise<ArrayBuffer> {
  if (new Uint8Array(bytes)[0] !== 0x1f || new Uint8Array(bytes)[1] !== 0x8b) return bytes;
  if (typeof DecompressionStream !== 'undefined') return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  const { gunzipSync } = await import('fflate');
  const output = gunzipSync(new Uint8Array(bytes));
  return output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength) as ArrayBuffer;
}

/** Split only at directive tokens outside strings, comments and arrays. Compressed
 * curve Includes can exceed V8's single-string limit, so decode incrementally. */
export async function* parseBytes(bytes: ArrayBuffer, file: string): AsyncGenerator<Statement> {
  let stream = new Blob([bytes]).stream();
  const magic = new Uint8Array(bytes, 0, Math.min(2, bytes.byteLength));
  if (magic[0] === 0x1f && magic[1] === 0x8b) {
    if (typeof DecompressionStream === 'undefined') stream = new Blob([await decompress(bytes)]).stream();
    else stream = stream.pipeThrough(new DecompressionStream('gzip'));
  }
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
  let pending = '', quoted = false, escaped = false, comment = false, brackets = 0, wordStart = true, line = 1, startLine = 1;
  try {
    for (;;) {
      const { value: text, done } = await reader.read();
      if (done) break;
      let start = 0;
      for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (!comment && !quoted && brackets === 0 && wordStart && c >= 'A' && c <= 'Z' && !/ActiveTransform\s*$/.test(pending.slice(-128) + text.slice(Math.max(start, i - 128), i))) {
          pending += text.slice(start, i);
          yield* parse(pending, file, startLine);
          pending = ''; start = i; startLine = line;
        }
        if (comment) { if (c === '\n') comment = false; }
        else if (quoted) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; }
        else if (c === '#') comment = true;
        else if (c === '"') quoted = true;
        else if (c === '[') brackets++;
        else if (c === ']') brackets--;
        if (c === '\n') line++;
        wordStart = /\s/.test(c);
      }
      pending += text.slice(start);
    }
    yield* parse(pending, file, startLine);
  } finally { await reader.cancel(); reader.releaseLock(); }
}

export async function* walk(entry: string, resolver: Resolver, resources = new Map<string, Resource>()): AsyncGenerator<Statement> {
  const stack = new Set<string>();
  async function* visit(path: string): AsyncGenerator<Statement> {
    if (stack.has(path)) throw new PbrtError('Cyclic Include/Import', { file: path, line: 1, column: 1 });
    if (stack.size >= 128) throw new PbrtError('Include/Import nesting exceeds 128', { file: path, line: 1, column: 1 });
    stack.add(path);
    const bytes = await resolver.read(path);
    resources.set(path, { path, bytes: bytes.byteLength, kind: 'text' });
    for await (const statement of parseBytes(bytes, path)) {
      yield statement;
      if (statement.kind === 'Include' || statement.kind === 'Import') {
        yield* visit(resolvePath(String(statement.args[0]), entry));
        // Synthetic marker lets the state machine isolate Import state.
        if (statement.kind === 'Import') yield { ...statement, kind: 'ImportEnd' };
      }
    }
    stack.delete(path);
  }
  yield* visit(entry);
}

const category: Record<string, string> = { Material: 'materials', MakeNamedMaterial: 'materials', Shape: 'shapes', LightSource: 'lights', AreaLightSource: 'lights', MakeNamedMedium: 'media', Texture: 'textures', Camera: 'cameras' };
export interface Inspection {
  entry: string; features: Record<string, Record<string, number>>; resources: Resource[];
  totalBytes: number; unknownSizes: number; warnings: Warning[]; coverage: Record<string, Record<string, Coverage>>;
}
export async function inspect(entry: string, resolver: Resolver): Promise<Inspection> {
  const resources = new Map<string, Resource>();
  const features: Inspection['features'] = { statements: {} };
  const warnings: Warning[] = [];
  const warningGroups = new Map<string, Warning>();
  const warn = (warning: Warning) => {
    const key = `${warning.file}:${warning.statement}:${warning.code}`;
    const existing = warningGroups.get(key);
    if (existing) { existing.count = (existing.count ?? 1) + 1; existing.lastLine = warning.line; }
    else { warningGroups.set(key, warning); warnings.push(warning); }
  };
  const count = (group: string, key: string) => { features[group] ??= {}; features[group][key] = (features[group][key] ?? 0) + 1; };
  for await (const s of walk(entry, resolver, resources)) {
    if (s.kind === 'ImportEnd') continue;
    count('statements', s.kind);
    if (category[s.kind]) {
      const group = category[s.kind], type = String(s.kind === 'Texture' ? s.args[2] : s.kind.startsWith('MakeNamed') ? s.params.type?.values[0] ?? '<missing type>' : s.args[0]);
      count(group, type);
      const mode = FEATURE_COVERAGE[group]?.[type] ?? 'approximate';
      if (mode !== 'supported') warn({ statement: s.kind, file: s.file, line: s.line, code: `${group}-${type}`, handling: `${type}: ${mode}` });
    }
    for (const parameter of Object.values(s.params)) {
      const isFile = parameter.type === 'string' && /^(filename|normalmap|bsdffile|lensfile)$/.test(parameter.name) && !['Film', 'Option'].includes(s.kind);
      const spectrum = parameter.type === 'spectrum' && parameter.values.some((value) => typeof value === 'string' && /\.(spd|txt)$/i.test(value));
      if (!isFile && !spectrum) continue;
      for (const value of parameter.values) if (typeof value === 'string' && value) {
        const path = resolvePath(value, entry);
        if (!resources.has(path)) resources.set(path, { path, kind: spectrum ? 'spectrum' : s.kind === 'Shape' ? 'geometry' : 'texture' });
      }
    }
    if (s.kind === 'Option' || s.kind === 'ActiveTransform' || s.kind === 'TransformTimes' ||
      s.kind === 'ColorSpace' && s.args[0] !== 'srgb') warn({
      statement: s.kind, file: s.file, line: s.line, code: 'approximation',
      handling: s.kind === 'ColorSpace' ? 'Uses sRGB' : s.kind === 'Option' ? 'Renderer option ignored' : 'Uses the start transform; no motion blur'
    });
  }
  const list = [...resources.values()];
  // Limit metadata requests; no binary assets are downloaded by inspect.
  let next = 0;
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (next < list.length) {
      const item = list[next++];
      if (item.bytes === undefined && resolver.size) item.bytes = await resolver.size(item.path);
    }
  }));
  const coverage = Object.fromEntries(Object.entries(features).filter(([group]) => group !== 'statements').map(([group, values]) => [group, Object.fromEntries(Object.keys(values).map(type => [type, FEATURE_COVERAGE[group]?.[type] ?? 'approximate']))]));
  return { entry, features, coverage, resources: list, totalBytes: list.reduce((sum, item) => sum + (item.bytes ?? 0), 0), unknownSizes: list.filter((item) => item.bytes === undefined).length, warnings };
}
