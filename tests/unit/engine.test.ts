import { afterEach, describe, expect, it, vi } from 'vitest';
import Render from '../../src/Render';
import Mesh from '../../src/scene/Mesh';
import OpenPBRMaterial from '../../src/scene/OpenPBRMaterial';
import Texture from '../../src/scene/Texture';
import SpotLight from '../../src/scene/SpotLight';
import AmbientLight from '../../src/scene/AmbientLight';
import { createCubeGeometry } from '../../src/util/commonGeometry';
import { renderFixture } from '../helpers/renderPipeline';
import { getGeometryBvh } from '../../src/renderer/geometryBvh';
import { updateMeshInstances } from '../../src/renderer/prepareMeshBVH';
import { updatePreparedGeometries } from '../../src/renderer/geometryUpdates';

describe('Engine commits inputs', () => {
  it('classifies supported new geometry as append and falls back for material structure changes', () => {
    const {engine, pipeline} = renderFixture();
    const material = new OpenPBRMaterial(), first = new Mesh(createCubeGeometry(), material);
    const scene = {meshes: [first], lights: []}; engine.scene = scene; engine.update();
    const appended = new Mesh(createCubeGeometry(), material); scene.meshes = [first, appended]; engine.update();
    expect(vi.mocked(pipeline.setMeshes).mock.calls.at(-1)![1]?.added).toHaveLength(1);
    const differentMaterial = new Mesh(createCubeGeometry(), new OpenPBRMaterial());
    scene.meshes = [first, appended, differentMaterial]; engine.update();
    expect(vi.mocked(pipeline.setMeshes).mock.calls.at(-1)![1]).toBeUndefined();
    scene.meshes = [first, appended]; engine.update();
    first.geometry.indices.array[0] = first.geometry.indices.array[1]; first.geometry.markUpdated();
    const withTopology = new Mesh(createCubeGeometry(), material); scene.meshes.push(withTopology); engine.update();
    expect(vi.mocked(pipeline.setMeshes).mock.calls.at(-1)![1]).toBeUndefined();
    engine.dispose();
  });
  it('retains renderer-built BLASes across committed poses and rebuilds edited topology', () => {
    const {engine, pipeline} = renderFixture();
    const geometry = createCubeGeometry(); geometry.dynamic = true;
    engine.scene = {meshes: [new Mesh(geometry, new OpenPBRMaterial())], lights: []};
    engine.update();
    const committed = vi.mocked(pipeline.setMeshes).mock.calls.at(-1)![0][0].geometry;
    const prepared = updateMeshInstances(vi.mocked(pipeline.setMeshes).mock.calls.at(-1)![0]);
    const bvh = getGeometryBvh(committed)!;
    const initialMinX = new Float32Array(bvh.buffer)[0];
    for (let pose = 1; pose <= 3; pose++) {
      for (let i = 0; i < geometry.position.array.length; i += 3) geometry.position.array[i] += .05;
      geometry.markVerticesUpdated(); engine.update();
      expect(getGeometryBvh(geometry)).toBeUndefined();
      expect(getGeometryBvh(committed)).toBe(bvh);
      const changed = vi.mocked(pipeline.setMeshes).mock.calls.at(-1)![1]!.geometries!;
      const update = updatePreparedGeometries(prepared, new Set(changed));
      expect(getGeometryBvh(committed)).toBe(bvh);
      expect(update.resized).toBe(false);
      expect(new Float32Array(bvh.buffer)[0]).toBeCloseTo(initialMinX + .05 * pose);
    }
    geometry.indices.array.fill(0); geometry.markUpdated(); engine.update();
    updatePreparedGeometries(prepared, new Set([committed]));
    expect(getGeometryBvh(committed)).not.toBe(bvh);
    engine.dispose();
  });
  it('invalidates an edited cached BLAS when returning to a replaced scene', () => {
    const {engine, pipeline} = renderFixture();
    const geometry = createCubeGeometry(); geometry.dynamic = true;
    const scene = {meshes: [new Mesh(geometry, new OpenPBRMaterial())], lights: []};
    engine.scene = scene; engine.update();
    const meshes = vi.mocked(pipeline.setMeshes).mock.calls.at(-1)![0];
    updateMeshInstances(meshes);
    const committed = meshes[0].geometry, bvh = getGeometryBvh(committed)!;
    const initialMinX = new Float32Array(bvh.buffer)[0];
    engine.scene = {meshes: [], lights: []}; engine.update();
    for (let i = 0; i < geometry.position.array.length; i += 3) geometry.position.array[i] += 2;
    geometry.markVerticesUpdated(); engine.scene = scene; engine.update();
    expect(getGeometryBvh(committed)).toBeUndefined();
    updateMeshInstances(vi.mocked(pipeline.setMeshes).mock.calls.at(-1)![0]);
    expect(new Float32Array(getGeometryBvh(committed)!.buffer)[0]).toBeCloseTo(initialMinX + 2);
    engine.dispose();
  });
  it('preserves the exact values of a double-precision camera matrix', () => {
    const {engine, camera, targets} = renderFixture();
    camera.transform = Array.from(camera.transform); camera.transform[12] = .123456789012345;
    engine.update(); const render = new Render(engine); render.refine();
    const submitted = vi.mocked(targets[0].trace).mock.calls[0][0];
    expect(submitted.transform[12]).toBe(.123456789012345);
    camera.transform[12] = 2; expect(submitted.transform[12]).toBe(.123456789012345); engine.dispose();
  });
  it('uploads one shared scene and keeps queued input independent of uncommitted edits', () => {
    const {engine, pipeline, camera} = renderFixture();
    const material = new OpenPBRMaterial({baseColor: [.2, .3, .4]});
    const geometry = createCubeGeometry(); const mesh = new Mesh(geometry, material);
    const scene = {meshes: [mesh], lights: [new AmbientLight({color: [.5, .5, .5]})], background: [.1, .2, .3, 1] as [number, number, number, number]};
    engine.scene = scene; engine.update();
    const uploaded = vi.mocked(pipeline.setMeshes).mock.calls.at(-1)![0];
    expect(uploaded[0]).not.toBe(mesh); expect(uploaded[0].geometry.position.array).not.toBe(geometry.position.array);
    expect(uploaded[0].materials[0].baseColor).toEqual([.2, .3, .4]);
    const a = new Render(engine), b = new Render(engine); a.refine(); b.refine();
    const uploads = vi.mocked(pipeline.setMeshes).mock.calls.length;
    material.baseColor[0] = .9; mesh.position = [4, 5, 6]; geometry.position.array[0] += 1; scene.background[0] = .7;
    camera.position = [2, 2, 2]; a.refine(); b.refine();
    expect(pipeline.setMeshes).toHaveBeenCalledTimes(uploads);
    expect(uploaded[0].position).toEqual([0, 0, 0]); expect(uploaded[0].materials[0].baseColor[0]).toBe(.2);
    geometry.markVerticesUpdated(); engine.update();
    expect(uploaded[0].position).toEqual([4, 5, 6]); expect(uploaded[0].materials[0].baseColor[0]).toBe(.9);
    expect(pipeline.setMeshes).toHaveBeenCalledTimes(uploads + 1); engine.dispose();
  });
  it('commits texture pixels with stable snapshot identity', () => {
    const {engine, pipeline} = renderFixture();
    const pixels = new Float32Array([.1, .2, .3, 1]); const texture = new Texture({width: 1, height: 1, data: pixels});
    const material = new OpenPBRMaterial(); material.map = texture;
    engine.scene = {meshes: [new Mesh(createCubeGeometry(), material)], lights: []}; engine.update();
    const uploaded = vi.mocked(pipeline.setMeshes).mock.calls.at(-1)![0][0].materials[0].map as Texture;
    const committed = uploaded.image as {data: Float32Array};
    pixels[0] = .9; expect(committed.data[0]).toBeCloseTo(.1);
    texture.markUpdated(); engine.update(); expect(committed.data[0]).toBeCloseTo(.9);
    engine.dispose();
  });
  it('switches the single resident scene and invalidates every render', () => {
    const {engine, pipeline} = renderFixture(); const a = new Render(engine), b = new Render(engine); a.refine(); b.refine();
    engine.scene = {meshes: [], lights: []}; expect(engine.update()).toBe(true);
    expect([a.samples, b.samples]).toEqual([0, 0]); expect(pipeline.setMeshes).toHaveBeenCalledTimes(2);
    a.refine(); b.refine(); expect([a.samples, b.samples]).toEqual([1, 1]); engine.dispose();
  });
  it('prepares another scene without touching current GPU inputs or revisions', async () => {
    const {engine, pipeline} = renderFixture(); const render = new Render(engine); render.refine();
    const next = {meshes: [new Mesh(createCubeGeometry(), new OpenPBRMaterial())], lights: []};
    const progress = vi.fn(); await engine.prepare(next, {onProgress: progress});
    expect(pipeline.setMeshes).toHaveBeenCalledOnce(); render.refine(); expect(render.samples).toBe(2);
    expect(progress).toHaveBeenCalled(); engine.dispose();
  });
});

it('reports shared shader progress only when compilation advances', () => {
  const {engine, pipeline} = renderFixture(); const progress = vi.fn(); engine.on('progress', progress);
  const compilation = {status: 'compiling' as const, completedPipelineCount: 1, pipelineCount: 2};
  vi.mocked(pipeline.getDiagnostics).mockReturnValue({shaderCompilation: compilation} as ReturnType<typeof pipeline.getDiagnostics>);
  const render = new Render(engine); render.refine(); render.refine();
  expect(progress).toHaveBeenCalledOnce(); expect(progress).toHaveBeenCalledWith({stage: 'shaders', progress: .5});
  compilation.completedPipelineCount = 2; render.refine(); expect(progress).toHaveBeenLastCalledWith({stage: 'shaders', progress: 1}); engine.dispose();
});


describe('Engine validation', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
  it('clamps invalid lights and emits one error without failing refinement', () => {
    const {engine, pipeline} = renderFixture();
    const error = vi.fn(); engine.on('error', error);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const light = new SpotLight({intensity: -1});
    engine.scene = {meshes: [], lights: [light]};
    const render = new Render(engine, {maxSamples: 1});
    engine.update(); expect(render.refine()).toBe('finished');
    engine.update(); expect(render.refine()).toBe('finished');
    expect(light.intensity).toBe(0);
    expect(pipeline.setLights).toHaveBeenLastCalledWith([expect.objectContaining({intensity: 0})]);
    expect(error).toHaveBeenCalledOnce(); expect(error.mock.calls[0][0]).toBeInstanceOf(Error);
    expect(engine.lastError).toBeUndefined(); engine.dispose();
  });
});
