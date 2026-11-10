import { Engine, Render, RenderLoop, type RenderOptions, type RenderLoopOptions } from '@meimu/mutracer';
import { NativeRenderHost, NativeRender, NativeLoop } from './NativeRenderHost';
export const isNative = () => import.meta.env.MODE === 'native';
export const createRenderEngine = (canvas: HTMLCanvasElement): Engine => isNative() ? new NativeRenderHost(canvas) : new Engine({ canvas, backend: new URLSearchParams(location.search).has('webgl') ? 'webgl' : 'auto' });
export const createRender = (engine: Engine, options: RenderOptions): Render => engine instanceof NativeRenderHost ? new NativeRender(engine, options) : new Render(engine, options);
export const createRenderLoop = (engine: Engine, options: RenderLoopOptions): RenderLoop => engine instanceof NativeRenderHost ? new NativeLoop(engine, options) : new RenderLoop(engine, options);
