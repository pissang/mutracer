import {afterEach, expect, it, vi} from 'vitest';
import Render from '../../src/Render';
import {renderFixture} from '../helpers/renderPipeline';

afterEach(()=>{vi.restoreAllMocks();});
it('defaults to render resolution and rejects fixed display-resolution AOVs',()=>{
  const {engine}=renderFixture();
  expect(new Render(engine).aovResolution).toBe('render');
  expect(()=>new Render(engine,{width:32,height:32,aovResolution:'display'})).toThrow('scale-based');
  const fixed=new Render(engine,{width:32,height:32});fixed.aovResolution='display';
  const listener=vi.fn();engine.on('error',listener);vi.spyOn(console,'error').mockImplementation(()=>{});
  expect(fixed.refine()).toBe('error');expect(listener).toHaveBeenCalledWith(expect.objectContaining({message:expect.stringContaining('scale-based')}));engine.dispose();
});
it('forwards display mode while preserving independent beauty dimensions',()=>{
  const {engine,targets}=renderFixture();
  const render=new Render(engine,{resolutionScale:.5,aovResolution:'display',aovs:['depth']});render.refine();
  expect(targets[0].configure).toHaveBeenCalledWith(expect.objectContaining({aovResolution:'display',aovSamples:16}));
  expect(targets[0].setSize).toHaveBeenCalledWith(400,300);engine.dispose();
});
it('falls back to render resolution and warns once on WebGL',()=>{
  const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
  const {engine,targets}=renderFixture({backend:'webgl'});
  const render=new Render(engine,{aovResolution:'display',aovs:['depth']});render.refine();render.refine();
  expect(targets[0].configure).toHaveBeenLastCalledWith(expect.objectContaining({aovResolution:'render'}));
  expect(warn).toHaveBeenCalledOnce();expect(render.getAovTexture('depth')).toBeUndefined();engine.dispose();
});
it('borrows only enabled, current AOVs and invalidates them on restart and disposal',()=>{
  const {engine,targets}=renderFixture();const render=new Render(engine,{aovs:['depth'],aovResolution:'display'});
  expect(render.getAovTexture('depth')).toBeUndefined();render.refine();
  const texture={width:800,height:600} as GPUTexture;targets[0].getAovTexture=vi.fn(()=>texture);
  expect(render.getAovTexture('depth')).toBe(texture);expect(render.getAovTexture('diffuseColor')).toBeUndefined();
  render.restart();expect(render.getAovTexture('depth')).toBeUndefined();render.dispose();expect(render.getAovTexture('depth')).toBeUndefined();engine.dispose();
});
