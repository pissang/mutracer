import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { beforeAll, expect, it, vi } from 'vitest';
import { build } from 'vite';
import type { OutputAsset, OutputChunk } from 'rollup';
import * as library from '../../src/standalone';

let main: OutputChunk, worker: OutputAsset;
const wasm = readFileSync('src/tinybvh/tinybvh.wasm');
const wasmUrl = `data:application/wasm;base64,${wasm.toString('base64')}`;

beforeAll(async () => {
  const result = await build({
    configFile: path.resolve('vite.config.ts'), logLevel: 'silent',
    build: { write: false }
  });
  if ('on' in result) throw new Error('Unexpected watch build');
  const output = (Array.isArray(result) ? result[0] : result).output;
  main = output.find(item => item.type === 'chunk' && item.isEntry) as OutputChunk;
  const assets = output.filter((item): item is OutputAsset => item.type === 'asset');
  expect(assets.map(item => item.fileName)).toEqual(['assets/bvh.worker.js']);
  worker = assets[0];
  expect(main).toBeDefined();
}, 30_000);

it('keeps UMD exports without external runtime imports', () => {
  const fetch = vi.fn();
  const context = {
    URL, fetch, location: new URL('https://example.test/mutracer.umd.js'),
    self: undefined as unknown,
    MuTracer: undefined as typeof library | undefined
  };
  context.self = context;
  runInNewContext(main.code, context);
  expect(Object.keys(context.MuTracer!).sort()).toEqual(Object.keys(library).sort());
  expect(typeof context.MuTracer!.Engine).toBe('function');
  expect(fetch).not.toHaveBeenCalled();
  expect(main.imports).toEqual([]);
  expect(main.dynamicImports).toEqual([]);
  expect(Object.keys(main.modules).some(id => /oidn-webgpu/.test(id))).toBe(true);
});

it('embeds the exact WASM bytes in both the library and worker', () => {
  expect(main.code).toContain(wasmUrl);
  expect(String(worker.source)).toContain(wasmUrl);
});

it('builds a calling-thread TinyBVH using the embedded binary', async () => {
  const requested: string[] = [];
  const context = {
    URL, performance, console, location: new URL('https://example.test/mutracer.umd.js'),
    self: undefined as unknown,
    fetch: async (url: string | URL) => {
      requested.push(String(url));
      expect(String(url)).toBe(wasmUrl);
      return new Response(wasm);
    },
    MuTracer: undefined as typeof library | undefined
  };
  context.self = context;
  runInNewContext(main.code, context);
  const { Engine, Mesh, OpenPBRMaterial, createCubeGeometry } = context.MuTracer!;
  const engine = new Engine({ canvas: {width: 1, height: 1} as HTMLCanvasElement });
  engine.bvhBuilder = 'tinybvh';
  try {
    await engine.prepare({ meshes: [new Mesh(createCubeGeometry(), new OpenPBRMaterial())], lights: [] });
    expect(requested).toEqual([wasmUrl]);
    expect(engine.getDiagnostics()?.bvh?.lastBuild?.geometryCount).toBe(1);
  } finally { engine.dispose(); }
});

it('builds a worker TinyBVH using the embedded binary', async () => {
  const requested: string[] = [];
  let finish!: (response: any) => void;
  const response = new Promise<any>(resolve => { finish = resolve; });
  const self = {
    postMessage: finish,
    onmessage: undefined as ((event: { data: object }) => void) | undefined
  };
  runInNewContext(String(worker.source), {
    self, URL, WebAssembly, performance, console,
    fetch: async (url: string | URL) => {
      requested.push(String(url));
      expect(String(url)).toBe(wasmUrl);
      return new Response(wasm);
    }
  });
  expect(requested).toEqual([]);
  self.onmessage!({ data: {
    id: 7, builder: 'tinybvh', layout: 'bvh2', dynamic: false,
    displacementScale: 0, spatialSplits: false,
    position: { array: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), itemSize: 3 },
    indices: { array: new Uint32Array([0, 1, 2]), itemSize: 1 }
  } });
  const built = await response;
  expect(built.error).toBeUndefined();
  expect(built.id).toBe(7);
  expect(built.bvh.builder).toBe('tinybvh');
  expect(built.bvh.buffer.byteLength).toBeGreaterThan(0);
  expect(requested).toEqual([wasmUrl]);
}, 10_000);
