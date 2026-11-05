import {afterEach, describe, expect, it, vi} from 'vitest';
import {DisplayPostProcess} from '../../src/renderer/DisplayPostProcess';
import Render from '../../src/Render';
import type {PostProcess} from '../../src/Display';
import {renderFixture} from '../helpers/renderPipeline';

afterEach(() => {vi.restoreAllMocks(); vi.unstubAllGlobals();});
function fixture() {
  vi.stubGlobal('GPUTextureUsage', {TEXTURE_BINDING: 1, RENDER_ATTACHMENT: 2, STORAGE_BINDING: 4, COPY_SRC: 8, COPY_DST: 16});
  const encoder = {copyTextureToTexture: vi.fn(), finish: vi.fn(() => ({}))};
  const device = {limits: {maxTextureDimension2D: 8192}, createTexture: vi.fn(({size, format}) => ({...size, depthOrArrayLayers: 1, mipLevelCount: 1, sampleCount: 1, format, destroy: vi.fn()})),
    createCommandEncoder: vi.fn(() => encoder), queue: {submit: vi.fn(), onSubmittedWorkDone: vi.fn(async () => {})}} as unknown as GPUDevice;
  const chain = new DisplayPostProcess(device);
  const input = {width: 32, height: 16, format: 'rgba8unorm'} as GPUTexture;
  return {chain, device, encoder, input};
}
describe('display GPU passes', () => {
  it('chains distinct inputs/outputs in order, reuses two images and submits once', () => {
    const {chain, device, input, encoder} = fixture();
    const contexts: Parameters<PostProcess>[0][] = [];
    const pass: PostProcess = ctx => contexts.push(ctx);
    const render = {} as Render;
    chain.run(input, [pass, pass, pass], render);
    expect(contexts.map(ctx => ctx.input)).toEqual([input, contexts[0].output, contexts[1].output]);
    expect(contexts[0].output).toBe(contexts[2].output);
    for (const ctx of contexts) {expect(ctx.input).not.toBe(ctx.output);expect(ctx).toMatchObject({device, encoder, render, width: 32, height: 16});}
    expect(chain.output).toBe(contexts[2].output);
    expect(device.queue.submit).toHaveBeenCalledOnce();
    chain.run(input, [pass], render); expect(device.createTexture).toHaveBeenCalledTimes(2);
    chain.run(input, [], render); expect(chain.output).toBeUndefined();
  });
  it('resizes several times using each previous output and the current canvas', () => {
    const {chain, input} = fixture();
    const contexts: Parameters<PostProcess>[0][] = [];
    const pass: PostProcess = ctx => contexts.push(ctx);
    const first = vi.fn((_: unknown, display: {width: number; height: number}) => display);
    chain.run(input, [pass, pass, pass], {} as Render, {width: 100, height: 60}, [
      {outputSize: first}, {outputSize: size => ({width: size.width / 2, height: size.height / 2})}, {outputSize: (_, display) => display}
    ]);
    expect(first).toHaveBeenCalledWith({width: 32, height: 16}, {width: 100, height: 60});
    expect(contexts.map(ctx => [ctx.output.width, ctx.output.height])).toEqual([[100,60], [50,30], [100,60]]);
    expect(contexts[0].output).toBe(contexts[2].output);
    expect(contexts[2]).toMatchObject({width: 32, height: 16});
  });
  it.each([0, -1, NaN, Infinity, 1.5, 8193])('discards the entire chain for invalid dimension %s', width => {
    const {chain, input, device} = fixture(); const pass = vi.fn();
    expect(() => chain.run(input, [pass, pass], {} as Render, input, [{}, {outputSize: () => ({width, height: 1})}])).toThrow(RangeError);
    expect(pass).not.toHaveBeenCalled(); expect(device.queue.submit).not.toHaveBeenCalled(); expect(chain.output).toBeUndefined();
  });
  it('crops a fixed render before a resizing export pass', () => {
    const {chain, input, encoder} = fixture(); const pass = vi.fn();
    chain.run(input, [pass], {} as Render, {width: 100, height: 60}, [{outputSize: (_, display) => display}], {width: 29, height: 13});
    expect(encoder.copyTextureToTexture).toHaveBeenCalledWith({texture: input, origin: {x: 1, y: 1}}, {texture: pass.mock.calls[0][0].input}, {width: 29, height: 13});
    expect(pass.mock.calls[0][0].input).toMatchObject({width: 29, height: 13});
    expect(chain.output).toMatchObject({width: 100, height: 60});
  });
  it('discards all commands on an exception and skips the rest of the chain', () => {
    const {chain, device, input} = fixture();
    chain.run(input, [() => {}], {} as Render);
    vi.mocked(device.queue.submit).mockClear();
    const last = vi.fn(), error = new Error('bad pass');
    expect(() => chain.run(input, [() => {}, () => {throw error;}, last], {} as Render)).toThrow(error);
    expect(last).not.toHaveBeenCalled();expect(device.queue.submit).not.toHaveBeenCalled(); expect(chain.output).toBeUndefined();
  });
  it('reallocates after size/format changes and retires only after queued work', async () => {
    const {chain, device, input} = fixture(); let done!: () => void;
    vi.mocked(device.queue.onSubmittedWorkDone).mockReturnValue(new Promise<undefined>(resolve => {done = () => resolve(undefined);}));
    chain.run(input, [() => {}], {} as Render);
    const old = chain.output!;
    chain.run({...input, width: 64, format: 'rgba16float'} as GPUTexture, [() => {}], {} as Render);
    expect(old.destroy).not.toHaveBeenCalled(); expect(chain.getMemoryBytes()).toBe(64 * 16 * 8); // one pass needs one image
    done();await vi.waitFor(() => expect(old.destroy).toHaveBeenCalledOnce());
    chain.dispose(); expect(chain.output).toBeUndefined();expect(chain.getMemoryBytes()).toBe(0);
  });
});
describe('Display pass registration', () => {
  function setup(backend: 'webgpu' | 'webgl' = 'webgpu') {
    const value = renderFixture({backend}); const render = new Render(value.engine);render.refine();
    const {chain, input} = fixture();
    value.targets[0].applyPostProcesses = vi.fn((passes, selected, options, crop) => {if (backend === 'webgpu') chain.run(input, passes, selected, value.engine.display.canvas, options, crop);});
    value.targets[0].getOutputTexture = vi.fn(() => chain.output ?? input);
    return {...value, render, chain, input};
  }
  it('runs each registration on each present, removes duplicate registrations independently, and never traces', () => {
    const {engine, render, targets} = setup(); const pass = vi.fn();
    const remove = engine.display.addPostProcess(pass);engine.display.addPostProcess(pass);
    engine.display.present(render);expect(pass).toHaveBeenCalledTimes(2);
    remove();remove();engine.display.present(render);expect(pass).toHaveBeenCalledTimes(3);
    expect(targets[0].trace).toHaveBeenCalledOnce();engine.dispose();
  });
  it('runs on toBlob, supplies the selected fallback, and leaves raw readbacks untouched', async () => {
    const {engine, render, targets} = setup();const final = new Render(engine, {fallback: render});
    const pass = vi.fn(); engine.display.addPostProcess(pass);engine.display.present(final);
    expect(pass.mock.calls[0][0].render).toBe(render);
    await render.readPixels();expect(pass).toHaveBeenCalledOnce();
    vi.stubGlobal('ImageData', class {});
    vi.stubGlobal('document', {createElement: () => ({width: 0, height: 0, getContext: () => ({putImageData() {}}), toBlob: (done: (blob: Blob) => void) => done(new Blob())})});
    await engine.display.toBlob(render);expect(pass).toHaveBeenCalledTimes(2);expect(targets[0].readPresentation).toHaveBeenCalledOnce();engine.dispose();
  });
  it('exports the chain size after cropping fixed renders and preserves the crop on failure', async () => {
    vi.spyOn(console,'error').mockImplementation(()=>{});
    const {engine,targets}=renderFixture();const render=new Render(engine,{width:29,height:13});render.refine();
    const {chain,input,encoder}=fixture();
    targets[0].applyPostProcesses=(passes,selected,options,crop)=>chain.run(input,passes,selected,engine.display.canvas,options,crop);
    targets[0].readPresentation=async()=>{const image=chain.output??input;return {width:image.width,height:image.height,data:new Float32Array(image.width*image.height*4)};};
    const images: {width:number;height:number}[]=[];
    vi.stubGlobal('ImageData',class {constructor(_:unknown,width:number,height:number){images.push({width,height});}});
    vi.stubGlobal('document',{createElement:()=>({width:0,height:0,getContext:()=>({putImageData(){}}),toBlob:(done:(blob:Blob)=>void)=>done(new Blob())})});
    engine.display.setSize(100,60);
    const size=vi.fn((previous:{width:number;height:number},display:{width:number;height:number})=>display);
    const remove=engine.display.addPostProcess(()=>{}, {outputSize:size});
    await engine.display.toBlob(render);
    expect(size).toHaveBeenCalledWith({width:29,height:13},{width:100,height:60});
    expect(images.at(-1)).toEqual({width:100,height:60});
    expect(encoder.copyTextureToTexture).toHaveBeenCalled();remove();
    engine.display.addPostProcess(()=>{throw new Error('bad export');});await engine.display.toBlob(render);
    expect(images.at(-1)).toEqual({width:29,height:13});engine.dispose();
  });
  it('reports errors and still presents the pre-hook image', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const {engine, render, targets, chain} = setup();const error = new Error('display failed'), listener = vi.fn(), last = vi.fn();
    engine.on('error', listener);engine.display.addPostProcess(() => {throw error;});engine.display.addPostProcess(last);
    expect(engine.display.present(render)).toBe(render);expect(listener).toHaveBeenCalledWith(error);
    expect(last).not.toHaveBeenCalled();expect(chain.output).toBeUndefined();expect(targets[0].present).toHaveBeenCalledOnce();engine.dispose();
  });
  it('warns once on WebGL, skips callbacks and exposes no GPU textures', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); const {engine, render} = setup('webgl');
    const pass = vi.fn();engine.display.addPostProcess(pass);engine.display.addPostProcess(pass);
    engine.display.present(render);engine.display.present(render);
    expect(warn).toHaveBeenCalledOnce();expect(pass).not.toHaveBeenCalled();expect(render.getOutputTexture('hdr')).toBeUndefined();engine.dispose();
  });
  it('returns no texture before a complete target or after disposal and forwards both kinds', () => {
    const {engine, render, targets, input} = setup(); const untouched = new Render(engine);
    expect(untouched.getOutputTexture('hdr')).toBeUndefined();expect(render.getOutputTexture('hdr')).toBe(input);
    expect(render.getOutputTexture('display')).toBe(input);expect(targets[0].getOutputTexture).toHaveBeenLastCalledWith('display');
    render.restart();expect(render.getOutputTexture('hdr')).toBeUndefined();
    render.dispose();expect(render.getOutputTexture('hdr')).toBeUndefined();engine.dispose();
  });
});
