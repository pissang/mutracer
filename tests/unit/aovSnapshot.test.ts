import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {makeShaderDataDefinitions} from 'webgpu-utils';
import {AOV_KINDS} from '../../src/renderer/aov.js';
import {WGPUAov} from '../../src/renderer/WGPUAov.js';
import {aovSnapshotShader, AOV_SNAPSHOT_BATCH_SIZE} from '../../src/renderer/wgsl/aovSnapshot.wgsl.js';

function fixture() {
  const buffers: GPUBuffer[] = [], dispatch = vi.fn(), submit = vi.fn();
  const write = vi.fn();
  const bind = vi.fn(() => ({}));
  const pipeline = vi.fn(() => ({getBindGroupLayout: () => ({})}));
  const device = {
    limits: {maxStorageBufferBindingSize: 1 << 24, maxBufferSize: 1 << 24},
    createTexture: ({size, format}: GPUTextureDescriptor) => ({width:(size as number[])[0],height:(size as number[])[1],depthOrArrayLayers:1,format,createView:()=>({}),destroy:vi.fn()}),
    createBuffer: (options: GPUBufferDescriptor) => {
      const buffer = {size: options.size, destroy: vi.fn(), unmap: vi.fn(), getMappedRange: () => new ArrayBuffer(options.size)} as unknown as GPUBuffer;
      buffers.push(buffer); return buffer;
    },
    createShaderModule: (options: GPUShaderModuleDescriptor) => {
      const parsed = makeShaderDataDefinitions(options.code);
      expect(Object.keys(parsed.storages).length).toBeLessThanOrEqual(8);
      return {};
    },
    createComputePipeline: pipeline, createRenderPipeline: pipeline, createBindGroup: bind,
    createCommandEncoder: () => ({
      beginComputePass: () => ({setPipeline() {}, setBindGroup() {}, dispatchWorkgroups: dispatch, end() {}}),
      beginRenderPass: () => ({setPipeline() {}, setBindGroup() {}, draw: dispatch, end() {}}), finish: () => ({})
    }),
    queue: {submit, writeBuffer: write, onSubmittedWorkDone: async () => {}}
  } as unknown as GPUDevice;
  const state = new WGPUAov(device); state.resize(7, 5); state.samples = 4;
  return {state, device, buffers, dispatch, submit, pipeline, bind, write};
}
beforeEach(() => {
  vi.stubGlobal('GPUShaderStage', {COMPUTE: 4, VERTEX: 1, FRAGMENT: 2});
  vi.stubGlobal('GPUTextureUsage', {STORAGE_BINDING:1,TEXTURE_BINDING:2,COPY_SRC:4,RENDER_ATTACHMENT:8});
  vi.stubGlobal('GPUBufferUsage', {STORAGE: 1, COPY_SRC: 2, COPY_DST: 4, UNIFORM: 8});
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('GPU AOV snapshots', () => {
  it('borrows raw AOV textures at their own dimensions and invalidates on restart/resize', async () => {
    const {state, dispatch} = fixture();
    const first = state.texture('depth')!;
    expect(first).toMatchObject({width:7,height:5,format:'rg32float'});
    const calls = dispatch.mock.calls.length;
    expect(state.texture('depth')).toBe(first);expect(dispatch).toHaveBeenCalledTimes(calls);
    state.reset();expect(state.texture('depth')).toBeUndefined();
    state.samples=4;expect(state.texture('depth')).toBe(first);expect(dispatch).toHaveBeenCalledTimes(calls+1);
    state.resize(10,8,true);state.samples=1;
    expect(state.texture('diffuseColor')).toMatchObject({width:10,height:8,format:'rgba8unorm-srgb'});
    await vi.waitFor(()=>expect(first.destroy).toHaveBeenCalledOnce());
    state.dispose();expect(state.texture('depth')).toBeUndefined();
  });
  it('bounds compact display AOV allocation to 40 bytes per pixel including three borrowed images', () => {
    const {state, device} = fixture();
    Object.assign(device.limits,{maxBufferSize:1e9,maxStorageBufferBindingSize:1e9});
    state.resize(3000,2000,true);state.samples=1;
    state.texture('depth');state.texture('diffuseColor');state.texture('specularColor');
    expect(state.bytes).toBe(3000*2000*40+64);
  });
  it('supports every requested subset within baseline device binding limits', () => {
    for (let mask = 1; mask < 1 << AOV_KINDS.length; mask++) {
      if ((mask & 8 && mask & 128) || (mask & 16 && mask & 256)) continue;
      const kinds = AOV_KINDS.filter((_, i) => mask & (1 << i));
      for (let i = 0; i < kinds.length; i += AOV_SNAPSHOT_BATCH_SIZE) {
        const batch = kinds.slice(i, i + AOV_SNAPSHOT_BATCH_SIZE);
        const definition = makeShaderDataDefinitions(aovSnapshotShader(batch));
        expect(Object.keys(definition.storages)).toHaveLength(2 + batch.length);
        expect(definition.uniforms.parameters.size).toBe(16);
        expect(Object.keys(definition.entryPoints)).toEqual(['main']);
      }
    }
  });
  it('deduplicates requests and reuses pipelines independent of request order while owning separate outputs', () => {
    const {state, pipeline, submit} = fixture();
    const first = state.snapshot(['id', 'depth', 'id']);
    const second = state.snapshot(['depth', 'id']);
    expect(Object.keys(first)).toEqual(['depth', 'id']);
    expect(pipeline).toHaveBeenCalledOnce();
    expect(submit).toHaveBeenCalledTimes(2);
    expect(first.id).not.toBe(second.id);
    for (const buffer of Object.values(first)) {
      expect(buffer?.size).toBe(7 * 5 * 16);
      expect(buffer).not.toBe(state.accumulation);
      expect(buffer).not.toBe(state.center);
      expect(buffer?.destroy).not.toHaveBeenCalled();
    }
  });
  it('releases partial output allocations when a later batch fails', () => {
    const {state, buffers, bind, submit} = fixture();
    bind.mockImplementationOnce(() => ({})).mockImplementationOnce(() => {throw new Error('binding failure');});
    // Seven kinds span two batches; a lobe's albedo and color are exclusive.
    expect(() => state.snapshot(AOV_KINDS.slice(0, 7))).toThrow('binding failure');
    expect(submit).not.toHaveBeenCalled();
    // Target storage belongs to the render; parameters and unfinished snapshots
    // belong to this failed operation and must not leak.
    for (const buffer of buffers.slice(3)) expect(buffer.destroy).toHaveBeenCalledOnce();
    for (const buffer of buffers.slice(0, 3)) expect(buffer.destroy).not.toHaveBeenCalled();
  });
  it('reuses only released snapshots, retires concurrent overflow and ignores double release', () => {
    const {state} = fixture();
    const first = state.snapshot(['id']), concurrent = state.snapshot(['id']);
    expect(first.id).not.toBe(concurrent.id);
    state.releaseSnapshot(first);
    state.releaseSnapshot(concurrent);
    expect(concurrent.id!.destroy).toHaveBeenCalledOnce();
    state.releaseSnapshot(concurrent);
    expect(concurrent.id!.destroy).toHaveBeenCalledOnce();
    expect(state.snapshot(['id']).id).toBe(first.id);
    expect(first.id!.destroy).not.toHaveBeenCalled();
  });
  it('retires late releases after resize without repopulating the new target pool', () => {
    const {state} = fixture();
    const old = state.snapshot(['depth']);
    state.resize(8, 6); state.samples = 1;
    state.releaseSnapshot(old);
    expect(old.depth!.destroy).toHaveBeenCalledOnce();
    expect(state.snapshot(['depth']).depth!.size).toBe(8 * 6 * 16);
  });
  it('includes pooled memory in diagnostics and retires it on dispose', async () => {
    const {state} = fixture();
    const before = state.bytes;
    const buffers = state.snapshot(['depth', 'id']);
    expect(state.bytes).toBe(before + 2 * 7 * 5 * 16);
    state.releaseSnapshot(buffers);
    expect(state.bytes).toBe(before + 2 * 7 * 5 * 16);
    state.dispose(); await Promise.resolve(); await Promise.resolve();
    expect(buffers.depth!.destroy).toHaveBeenCalledOnce();
    expect(buffers.id!.destroy).toHaveBeenCalledOnce();
    expect(state.bytes).toBe(0);
  });
  it('keeps immutable primitive metadata resident across camera edits and resets', () => {
    const {state, write} = fixture();
    const prefix = new Uint32Array(80), primitives = new Uint32Array(1000);
    state.setScene(prefix, primitives);
    expect(write).toHaveBeenCalledTimes(2);
    expect(state.scene!.size).toBe(prefix.byteLength + primitives.byteLength);
    write.mockClear();
    state.reset(); state.setScene(prefix.slice(), primitives);
    expect(write).toHaveBeenCalledOnce();
    expect(write.mock.calls[0][2].byteLength).toBe(prefix.byteLength);
    write.mockClear();
    state.setScene(prefix, primitives.slice());
    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls[1][1]).toBe(prefix.byteLength);
    write.mockClear();
    const smaller = prefix.slice(0, 60); state.setScene(smaller, primitives);
    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls[1][1]).toBe(smaller.byteLength);
    write.mockClear();
    state.dispose(); state.setScene(prefix, primitives);
    expect(write).toHaveBeenCalledTimes(2);
  });
  it('does not allocate for empty or invalid requests or unready targets', () => {
    const {state, buffers, submit} = fixture();
    const initial = buffers.length;
    expect(state.snapshot([])).toEqual({});
    expect(() => state.snapshot(['missing' as never])).toThrow();
    state.samples = 0;
    expect(() => state.snapshot(['depth'])).toThrow('not ready');
    expect(buffers).toHaveLength(initial); expect(submit).not.toHaveBeenCalled();
  });
});
