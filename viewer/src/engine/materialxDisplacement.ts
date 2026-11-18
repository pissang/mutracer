import type MaterialGraph from '../../../src/scene/MaterialGraph';
import type {MaterialGraphInput} from '../../../src/scene/MaterialGraph';
import type Texture from '../../../src/scene/Texture';
export {planDisplacement} from '../../../src/materialx/displacement';

/** PNG/red is the existing viewer's portable height format. The exact extrema
 * map to 0/255; rounding contributes at most (max-min)/510 height units. */
export function quantizeHeight(heights: Float32Array) {
  let min = Infinity, max = -Infinity;
  for (const h of heights) {
    if (!Number.isFinite(h)) throw Error('Displacement produced a non-finite height');
    min = Math.min(min,h); max = Math.max(max,h);
  }
  if (!heights.length) throw Error('Displacement produced no heights');
  const scale = max-min, pixels = new Uint8ClampedArray(heights.length*4);
  for (let i=0;i<heights.length;i++) {
    pixels[i*4] = pixels[i*4+1] = pixels[i*4+2] = scale ? Math.round((heights[i]-min)/scale*255) : 0;
    pixels[i*4+3] = 255;
  }
  return {pixels,scale,bias:min,maxError:scale/510};
}

export type BakeImage = {node:string; width:number; height:number; pixels:Uint8ClampedArray; srgb:boolean; wrapS:Texture['wrapS']; wrapT:Texture['wrapT']};
export type BakeNodes = {nodes:MaterialGraph['nodes']; terminal:MaterialGraph['terminal']};
export type BakeParameter = MaterialGraphInput['value'];
