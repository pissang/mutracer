import {afterEach, expect, it, vi} from 'vitest';
import Render from '../../src/Render';
import {createOIDNFilter, type OIDNFilterInput, type OIDNFilterOptions} from '../../src/oidn';
import {loadOIDNNetwork, type OIDNDenoiser} from '../../src/renderer/oidnNetwork';
import {renderFixture} from '../helpers/renderPipeline';

vi.mock('../../src/renderer/oidnNetwork', () => ({loadOIDNNetwork: vi.fn()}));
const usage = {STORAGE: 128, COPY_SRC: 4, COPY_DST: 8};
const image = () => ({size: 64, usage: 140, mapState: 'unmapped'}) as GPUBuffer;
const input = (): OIDNFilterInput => ({width: 2, height: 2, color: image(), output: image(), albedo: image(), normal: image()});
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

function fixture() {
  vi.stubGlobal('GPUBufferUsage', usage);
  const {engine} = renderFixture();
  const submit = vi.fn(), copy = vi.fn();
  Object.assign(engine.device!, {
    limits: {maxStorageBufferBindingSize: 1024},
    createCommandEncoder: () => ({copyBufferToBuffer: copy, finish() {}}),
  });
  Object.assign(engine.device!.queue, {submit});
  let finish: () => void;
  const network = {
    dispose: vi.fn(),
    tileExecute: vi.fn(({done}) => {
      finish = () => done({data: image(), width: 2, height: 2});
      return cancel;
    })
  };
  const cancel = vi.fn();
  vi.mocked(loadOIDNNetwork).mockReset().mockResolvedValue(network as unknown as OIDNDenoiser);
  return {engine, network, cancel, copy, submit, finish: () => finish()};
}

afterEach(() => { vi.unstubAllGlobals(); });

it('validates options before opening the engine or downloading a network', async () => {
  const {engine} = fixture();
  for (const options of [{model: 'unknown'}, {model: 'small', weightsUrl: '/custom'}, {dynamicTile: {minTileSize: 0}},
    {type: 'oidn'}, {schedule: 'converged'}, {maxTileSize: 1.5}]) {
    await expect(createOIDNFilter(engine, options as OIDNFilterOptions)).rejects.toThrow();
  }
  expect(loadOIDNNetwork).not.toHaveBeenCalled();
  engine.dispose();
});

it('validates dimensions, usage and required guides before running inference', async () => {
  const {engine, network} = fixture();
  const filter = await createOIDNFilter(engine);
  await expect(filter.denoise({...input(), width: 0})).rejects.toThrow(/dimensions/);
  await expect(filter.denoise({...input(), normal: undefined})).rejects.toThrow(/normal/);
  await expect(filter.denoise({...input(), output: {...image(), usage: usage.STORAGE}})).rejects.toThrow(/output/);
  expect(network.tileExecute).not.toHaveBeenCalled();
  filter.dispose();
  engine.dispose();
});

it('shares the loaded network with a Render and releases it after the last owner', async () => {
  const {engine, network} = fixture();
  const render = new Render(engine);
  await render.setDenoiser({type: 'oidn', model: 'standard', dynamicTile: false});
  const filter = await createOIDNFilter(engine, {dynamicTile: false});
  expect(loadOIDNNetwork).toHaveBeenCalledOnce();
  filter.dispose();
  expect(network.dispose).not.toHaveBeenCalled();
  render.dispose();
  expect(network.dispose).toHaveBeenCalledOnce();
  engine.dispose();
});

it('cancels an active call, discards its output and permits another call', async () => {
  const {engine, network, cancel, copy, finish} = fixture();
  const filter = await createOIDNFilter(engine, {weightsUrl: '/color-only', aux: false});
  const data = {...input(), albedo: undefined, normal: undefined};
  const controller = new AbortController();
  const task = filter.denoise(data, {signal: controller.signal});
  const result = expect(task).rejects.toThrow();
  await tick();
  expect(network.tileExecute).toHaveBeenCalledOnce();
  controller.abort();
  await result;
  finish();
  expect(cancel).toHaveBeenCalledOnce();
  expect(copy).not.toHaveBeenCalled();

  const next = filter.denoise(data);
  await tick();
  finish();
  await next;
  expect(copy).toHaveBeenCalledWith(expect.anything(), 0, data.output, 0, 64);
  filter.dispose();
  filter.dispose();
  await expect(filter.denoise(data)).rejects.toThrow(/disposed/);
  expect(network.dispose).toHaveBeenCalledOnce();
  engine.dispose();
});

it('rejects clearly on WebGL before loading weights', async () => {
  const {engine} = renderFixture({backend: 'webgl'});
  vi.mocked(loadOIDNNetwork).mockClear();
  await expect(createOIDNFilter(engine)).rejects.toThrow(/requires a WebGPU engine/);
  expect(loadOIDNNetwork).not.toHaveBeenCalled();
  engine.dispose();
});

it('releases its network after an active call is cancelled by disposal', async () => {
  const {engine, network, cancel, copy, finish} = fixture();
  const filter = await createOIDNFilter(engine);
  const task = expect(filter.denoise(input())).rejects.toThrow(/disposed/);
  await tick();
  filter.dispose();
  await task;
  finish();
  expect(cancel).toHaveBeenCalledOnce();
  expect(copy).not.toHaveBeenCalled();
  expect(network.dispose).toHaveBeenCalledOnce();
  engine.dispose();
});
