/// <reference lib="dom" />
import { File } from 'node:buffer';
import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadModelFromFiles, loadModelFromSource, loadModelFromURL } from '../src/engine/loadModel';
import { groundModel } from '../src/engine/modelGrounding';
import { fromTHREEScene } from '@meimu/mutracer';

const nativeFetch = globalThis.fetch;
const vertices = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
const json = {
  asset: { version: '2.0' }, buffers: [{ uri: 'mesh.bin', byteLength: vertices.byteLength }],
  bufferViews: [{ buffer: 0, byteLength: vertices.byteLength }],
  accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }],
  images: [{ uri: 'textures/base.png' }], textures: [{ source: 0 }],
  materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
  meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
  nodes: [{ mesh: 0 }], scenes: [{ nodes: [0] }], scene: 0
};

function imageBytes(mesh: THREE.Mesh) {
  return ((mesh.material as THREE.MeshStandardMaterial).map?.image as { bytes: string } | undefined)?.bytes;
}

function glb(json: unknown): ArrayBuffer {
  const text = new TextEncoder().encode(JSON.stringify(json));
  const length = Math.ceil(text.length / 4) * 4;
  const buffer = new ArrayBuffer(20 + length);
  const view = new DataView(buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, buffer.byteLength, true);
  view.setUint32(12, length, true);
  view.setUint32(16, 0x4e4f534a, true);
  new Uint8Array(buffer, 20).fill(32);
  new Uint8Array(buffer, 20).set(text);
  return buffer;
}

describe('viewer cached model loading', () => {
  beforeEach(() => {
    vi.stubGlobal('File', File);
    vi.stubGlobal('location', { href: 'https://viewer.example.com/' });
    vi.stubGlobal('self', { URL });
    vi.stubGlobal('ProgressEvent', class { constructor(public type: string, public init: unknown) {} });
    vi.stubGlobal('createImageBitmap', vi.fn(async (blob: Blob) => ({ width: 1, height: 1, bytes: await blob.text(), close() {} })));
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  function network(main: string | ArrayBuffer) {
    const requests: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL, options?: RequestInit) => {
      const address = typeof request === 'string' ? request : request instanceof URL ? request.href : request.url;
      if (address.startsWith('blob:')) return nativeFetch(request, options);
      requests.push(address);
      if (address.endsWith('mesh.bin')) return new Response(vertices.buffer);
      if (address.endsWith('base.png')) return new Response('texture pixels');
      return new Response(main);
    }));
    return requests;
  }

  it.each(['gltf', 'glb'])('downloads %s dependencies once and restores geometry and textures without network', async (extension) => {
    let main: string | ArrayBuffer = JSON.stringify(json);
    if (extension === 'glb') main = glb(json);
    const requests = network(main);
    const loaded = await loadModelFromURL(`https://example.com/models/scene.${extension}`, vi.fn());
    expect(requests).toHaveLength(3);
    expect(loaded.source?.files).toHaveLength(3);
    const mesh = loaded.root.children[0] as THREE.Mesh;
    expect(Array.from(mesh.geometry.getAttribute('position').array)).toEqual(Array.from(vertices));
    expect(imageBytes(mesh)).toBe('texture pixels');

    loaded.revoke();
    requests.length = 0;
    const restored = await loadModelFromSource(loaded.source!, vi.fn());
    expect(requests).toEqual([]);
    const restoredMesh = restored.root.children[0] as THREE.Mesh;
    expect(Array.from(restoredMesh.geometry.getAttribute('position').array)).toEqual(Array.from(vertices));
    expect(imageBytes(restoredMesh)).toBe('texture pixels');
    restored.revoke();
  });


  it('parses downloaded main bytes without reading them back through File.arrayBuffer', async () => {
    network(glb(json));
    const names: string[] = [], original = File.prototype.arrayBuffer;
    const read = vi.spyOn(File.prototype, 'arrayBuffer').mockImplementation(function(this: File) {names.push(this.name); return original.call(this);});
    const model = await loadModelFromURL('https://example.com/scene.glb', vi.fn());
    expect(names).not.toContain('scene.glb');
    model.revoke(); read.mockRestore();
  });
  it('preserves dropped folder paths and resolves nested texture files', async () => {
    const requests = network('unexpected network');
    const files = [
      { path: 'folder/scene.gltf', file: new File([JSON.stringify(json)], 'scene.gltf') },
      { path: 'folder/mesh.bin', file: new File([new Uint8Array(vertices.buffer)], 'mesh.bin') },
      { path: 'folder/textures/base.png', file: new File(['local pixels'], 'base.png') }
    ] as unknown as Parameters<typeof loadModelFromFiles>[0];
    const model = await loadModelFromFiles(files, vi.fn());
    expect(model.source?.files.map(({ path }) => path)).toEqual(files.map(({ path }) => path));
    expect(requests).toEqual([]);
    expect(imageBytes(model.root.children[0] as THREE.Mesh)).toBe('local pixels');
    model.revoke();
  });

  it('keeps all cameras in an imported GLB, including parent transforms after grounding', async () => {
    const data = {
      ...json,
      cameras: [
        { name: 'Front', type: 'perspective', perspective: { yfov: Math.PI / 4, znear: 0.1 } },
        { name: 'Plan', type: 'orthographic', orthographic: { xmag: 2, ymag: 3, znear: 0.1, zfar: 100 } }
      ],
      nodes: [
        { mesh: 0 }, { translation: [5, 2, 0], children: [2, 3] },
        { camera: 0, translation: [0, 1, 4] }, { camera: 1, translation: [0, 4, 0] }
      ],
      scenes: [{ nodes: [0, 1] }]
    };
    network(glb(data));
    const model = await loadModelFromURL('https://example.com/scene.glb', vi.fn());
    const cameras: THREE.Camera[] = [];
    model.root.traverse((object) => { if ((object as THREE.Camera).isCamera) cameras.push(object as THREE.Camera); });
    expect(cameras.map((camera) => camera.name)).toEqual(['Front', 'Plan']);
    const before = cameras.map((camera) => camera.getWorldPosition(new THREE.Vector3()));
    groundModel(model.root);
    cameras.forEach((camera, i) => {
      expect(camera.getWorldPosition(new THREE.Vector3()).toArray()).toEqual(before[i].clone().add(model.root.position).toArray());
    });
    expect((cameras[0] as THREE.PerspectiveCamera).fov).toBeCloseTo(45);
    expect((cameras[1] as THREE.OrthographicCamera).top).toBe(3);
    model.revoke();
  });

  it.each(['gltf', 'glb'])('imports standard %s directional, point and spot lights with their node transforms', async (extension) => {
    const data = {
      ...json, extensionsUsed: ['KHR_lights_punctual'],
      extensions: { KHR_lights_punctual: { lights: [
        { type: 'directional', color: [1, 0.5, 0.25], intensity: 3 },
        { type: 'point', intensity: 7 },
        { type: 'spot', intensity: 5, spot: { innerConeAngle: 0.1, outerConeAngle: 0.4 } }
      ] } },
      nodes: [{ mesh: 0 }, { translation: [1, 2, 3], children: [2, 3, 4] },
        ...[0, 1, 2].map((light) => ({ extensions: { KHR_lights_punctual: { light } } }))],
      scenes: [{ nodes: [0, 1] }]
    };
    network(extension === 'glb' ? glb(data) : JSON.stringify(data));
    const model = await loadModelFromURL(`https://example.com/scene.${extension}`, vi.fn());
    expect(model.lighting?.available).toBe(true);
    groundModel(model.root);
    const scene = new THREE.Scene(); scene.add(model.root);
    const lights = fromTHREEScene(scene).lights;
    expect(lights.map((light) => light.type)).toEqual(['DirectionalLight', 'SphereLight', 'SpotLight']);
    expect(lights.map((light) => light.intensity)).toEqual([3, 7, 5]);
    expect(lights[0].color).toEqual([1, 0.5, 0.25]);
    expect(lights[1].position).toEqual([0.5, 2, 3]);
    model.revoke();
  });

  it('caches metadata environment maps beside the model and reloads them without network', async () => {
    const data = { ...json, extras: { pbrt: { light_sources: [
      { pbrt: 'infinite', gltf: 'metadata_only', source: 'textures/sky.pfm' }
    ] } } };
    const requests = network(JSON.stringify(data));
    const previousFetch = globalThis.fetch;
    const header = new TextEncoder().encode('PF\n1 1\n-1\n');
    const pfm = new Uint8Array(header.length + 12); pfm.set(header);
    const view = new DataView(pfm.buffer, header.length); [1, 2, 3].forEach((value, i) => view.setFloat32(i * 4, value, true));
    vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL, options?: RequestInit) => {
      if (String(request).endsWith('sky.pfm')) return new Response(pfm);
      return previousFetch(request, options);
    }));
    const progress = vi.fn();
    const model = await loadModelFromURL('https://example.com/room/gltf/scene.gltf', progress);
    const stages = progress.mock.calls.map(([stage]) => stage);
    const firstParse = stages.indexOf('parse');
    expect(firstParse).toBeGreaterThan(0);
    expect(stages.slice(firstParse)).not.toContain('download');
    const downloaded = progress.mock.calls.filter(([stage]) => stage === 'download').map(([, loaded]) => loaded);
    expect(downloaded).toEqual([...downloaded].sort((a, b) => a - b));
    expect(downloaded.at(-1)).toBe(model.source!.files.reduce((sum, { file }) => sum + file.size, 0));
    expect(fetchSpyURLs()).toEqual([
      'https://example.com/room/gltf/scene.gltf',
      'https://example.com/room/gltf/mesh.bin',
      'https://example.com/room/gltf/textures/base.png',
      'https://example.com/room/source/textures/sky.pfm'
    ]);
    expect(model.source!.files.some((entry) => entry.path === 'https://example.com/room/source/textures/sky.pfm')).toBe(true);
    expect(model.lighting?.environment?.data.slice(0, 4)).toEqual(new Float32Array([1, 2, 3, 1]));
    model.revoke(); requests.length = 0;
    const fetchSpy = vi.mocked(fetch); fetchSpy.mockClear();
    const cached = await loadModelFromSource(model.source!, vi.fn());
    expect(requests).toEqual([]);
    expect(fetchSpy.mock.calls.every(([address]) => (address instanceof Request ? address.url : String(address)).startsWith('blob:'))).toBe(true);
    expect(cached.lighting?.environment?.data).toEqual(model.lighting?.environment?.data);
    cached.revoke();
  });

  function fetchSpyURLs() {
    return vi.mocked(fetch).mock.calls.map(([request]) => request instanceof Request ? request.url : String(request))
      .filter((address) => !address.startsWith('blob:'));
  }

  it('does not download a missing optional environment again during parsing', async () => {
    const data = { ...json, extras: { pbrt: { light_sources: [
      { pbrt: 'infinite', gltf: 'metadata_only', source: 'missing.pfm' }
    ] } } };
    network(JSON.stringify(data));
    const previousFetch = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL, options?: RequestInit) => {
      if (String(request).endsWith('missing.pfm')) return new Response(null, { status: 404 });
      return previousFetch(request, options);
    }));
    const model = await loadModelFromURL('https://example.com/room/gltf/scene.gltf', vi.fn());
    expect(fetchSpyURLs().filter((address) => address.endsWith('missing.pfm'))).toHaveLength(1);
    expect(model.lighting?.warnings[0]).toContain('404');
    expect(model.lighting?.environment).toBeNull();
    model.revoke();
  });

  it('releases dependency blob URLs when parsing fails', async () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    const files = [
      { path: 'bad.gltf', file: new File(['invalid'], 'bad.gltf') },
      { path: 'mesh.bin', file: new File([new Uint8Array(vertices.buffer)], 'mesh.bin') }
    ] as unknown as Parameters<typeof loadModelFromFiles>[0];
    await expect(loadModelFromFiles(files, vi.fn())).rejects.toThrow();
    expect(revoke).toHaveBeenCalledOnce();
  });
});
