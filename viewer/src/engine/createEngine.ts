import {WebEngine} from './WebEngine';
export const createEngine = (canvas: HTMLCanvasElement) => new WebEngine(canvas);
