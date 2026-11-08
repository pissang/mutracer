/// <reference lib="webworker" />
import {HeightBaker,bakeHeightCPU,heightPNG} from './materialxBake';
import type {BakeImage,BakeNodes} from './materialxDisplacement';

export interface BakeRequest {
  id:number;
  graph:BakeNodes;
  images:{node:string;file:Blob;srgb:boolean;wrapS?:BakeImage['wrapS'];wrapT?:BakeImage['wrapT']}[];
}
let baker:Promise<HeightBaker|undefined>|undefined;
function getBaker() {
  return baker??= (async()=>{
    const adapter=await navigator.gpu?.requestAdapter();
    if(!adapter)return;
    const device=await adapter.requestDevice({requiredLimits:{maxStorageBufferBindingSize:adapter.limits.maxStorageBufferBindingSize}});
    device.lost.then(()=>{baker=undefined;});
    return new HeightBaker(device);
  })().catch(error=>{console.warn('MaterialX displacement: no WebGPU device; using CPU',error);baker=undefined;return undefined;});
}
// Serialize jobs on this worker/device. Long GPU waits and the CPU fallback
// leave the viewer's main thread free throughout the import.
let queue=Promise.resolve();
self.onmessage=(event:MessageEvent<BakeRequest>)=>{
  queue=queue.then(async()=>{
    const {id,graph}=event.data;
    try {
      const images:BakeImage[]=[];
      for(const image of event.data.images) {
        const bitmap=await createImageBitmap(image.file,{premultiplyAlpha:'none',colorSpaceConversion:'none'});
        try {
          const {width,height}=bitmap,canvas=new OffscreenCanvas(width,height),context=canvas.getContext('2d',{willReadFrequently:true})!;
          context.drawImage(bitmap,0,0);
          images.push({node:image.node,width,height,pixels:context.getImageData(0,0,width,height).data,srgb:image.srgb,wrapS:image.wrapS??'repeat',wrapT:image.wrapT??'repeat'});
        } finally {bitmap.close();}
      }
      const width=images.length?Math.max(...images.map(i=>i.width)):1024,height=images.length?Math.max(...images.map(i=>i.height)):1024;
      const gpu=await getBaker(),result=gpu?await gpu.bake(graph,images,width,height):bakeHeightCPU(graph,images,width,height);
      const png=await heightPNG(result);
      self.postMessage({id,...png,width,height,backend:result.backend,timings:result.timings});
    } catch(error) {self.postMessage({id,error:(error as Error).message});}
  });
};
