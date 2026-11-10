import {NativeEngine} from './NativeEngine';
export const createEngine = (canvas: HTMLCanvasElement) => new NativeEngine(canvas);
