// Reads MaterialX packages: a .mtlx with its texture files, or a .zip of them
// (the MatLib download format), and turns texture plans into image blobs.
import {rememberGraphImage} from './materialxGraphArchive';
import { unzipSync } from 'fflate';
import type { PathedFile } from './droppedFiles';
import { bakeChannels, type MapPlan } from './materialx';

const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', avif: 'image/avif' };

/** Normalizes `a/./b/../c` and backslashes; drops a leading `./`. */
export function normalizePath(path: string) {
  const parts: string[] = [];
  for (const part of path.replace(/\\/g, '/').split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return parts.join('/');
}

export interface MaterialXPackage {
  /** Path of the document inside the package. */
  path: string;
  text: string;
  /** Finds a texture referenced by the document. */
  resolve(file: string): Blob | undefined;
}

/**
 * Collects the package files, expanding zips, and picks the shallowest .mtlx.
 * Texture lookups are relative to the document, then case-insensitive (MatLib
 * documents and file names differ in case), then by file name alone.
 */
export async function readMaterialXPackage(files: PathedFile[]): Promise<MaterialXPackage> {
  const all = new Map<string, Blob>();
  for (const { file, path } of files) {
    if (/\.zip$/i.test(path)) {
      const entries = unzipSync(new Uint8Array(await file.arrayBuffer()), {
        filter: (entry) => !entry.name.endsWith('/') && !entry.name.startsWith('__MACOSX/')
      });
      for (const [name, data] of Object.entries(entries)) {
        all.set(normalizePath(name), new Blob([data as Uint8Array<ArrayBuffer>], { type: MIME[extension(name)] ?? '' }));
      }
    } else {
      all.set(normalizePath(path), file);
    }
  }
  const documents = [...all.keys()].filter((p) => /\.mtlx$/i.test(p))
    .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
  if (!documents.length) throw new Error('No .mtlx file found');
  const path = documents[0];
  const text = await all.get(path)!.text();
  const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
  const lower = new Map([...all].map(([p, blob]) => [p.toLowerCase(), blob]));
  const byName = new Map([...all].map(([p, blob]) => [p.slice(p.lastIndexOf('/') + 1).toLowerCase(), blob]));
  return {
    path,
    text,
    resolve(file) {
      const relative = normalizePath(dir + file);
      const name = relative.slice(relative.lastIndexOf('/') + 1).toLowerCase();
      return all.get(relative) ?? lower.get(relative.toLowerCase()) ?? byName.get(name);
    }
  };
}

const extension = (path: string) => path.slice(path.lastIndexOf('.') + 1).toLowerCase();

const decode = (blob: Blob) => createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });

/** The image for a map: the file itself, or a PNG baked from image channels. */
export async function loadMapImage(plan: MapPlan, pkg: MaterialXPackage): Promise<Blob> {
  const main = pkg.resolve(plan.file);
  if (!main) throw new Error(`missing ${plan.file}`);
  if (!plan.bake) return main.type ? main : new Blob([main], { type: MIME[extension(plan.file)] ?? 'image/png' });
  const size = await decode(main);
  const { width, height } = size;
  size.close();
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d', { willReadFrequently: true })!;
  const sources = new Map<string, Uint8ClampedArray>();
  for (const file of new Set(plan.bake.map((b) => b.file))) {
    const blob = pkg.resolve(file);
    if (!blob) throw new Error(`missing ${file}`);
    const image = await decode(blob);
    context.clearRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);
    image.close();
    sources.set(file, context.getImageData(0, 0, width, height).data);
  }
  const pixels = bakeChannels(plan.bake, sources, width * height);
  context.putImageData(new ImageData(pixels as Uint8ClampedArray<ArrayBuffer>, width, height), 0, 0);
  return canvas.convertToBlob({ type: 'image/png' });
}

/** Loads graph images without baking the connected network into texture slots. */
export async function loadGraphImages(material: import('./materialxGraph').MaterialXGraphImport, pkg:MaterialXPackage):Promise<string[]> {
  const {Texture}=await import('@meimu/mutracer');
  const warnings:string[]=[];
  await Promise.all([...material.images].map(async ([node,plan])=>{
    const blob=pkg.resolve(plan.file);
    if(!blob){warnings.push(`${node}.file: missing ${plan.file}; using the image default`);return;}
    try{
      const bitmap=await decode(blob),texture=new Texture(bitmap as unknown as HTMLCanvasElement);
      texture.colorSpace=plan.srgb?'srgb':'linear';texture.flipY=true;
      if(plan.wrapS)texture.wrapS=plan.wrapS;if(plan.wrapT)texture.wrapT=plan.wrapT;
      rememberGraphImage(texture,blob);
      for(const graph of [material.graph,material.displacement?.graph])if(graph?.nodes.some(n=>n.id===node))graph.setInput(node,'file',{type:'filename',value:texture});
    }catch(error){warnings.push(`${node}.file: ${(error as Error).message}; using the image default`);}
  }));
  return warnings;
}

/** Produces an ordinary cached/undoable height upload. No graph is evaluated
 * during traversal; the imported scalar height is frozen in UV space. */
export async function loadMaterialXDisplacement(material:import('./materialxGraph').MaterialXGraphImport,pkg:MaterialXPackage) {
  const plan=material.displacement;
  if(!plan)return;
  if(plan.mode==='fallback')return {file:null,values:{displacementScale:0,displacementBias:0},warnings:[plan.reason!]};
  if(plan.direct) {
    const image=material.images.get(plan.direct.node),file=image&&pkg.resolve(image.file);
    if(!file)return {file:null,values:{displacementScale:0,displacementBias:0},warnings:[`${plan.direct.node}.file: missing displacement image`]};
    return {file,values:{displacementScale:plan.direct.scale,displacementBias:plan.direct.bias},transform:{uvScale:plan.direct.uvScale,uvOffset:plan.direct.uvOffset,flipY:true,uvChannel:plan.uvChannel,wrapS:image.wrapS,wrapT:image.wrapT},warnings:[]};
  }
  const {bakeDisplacement}=await import('./materialxBakeClient');
  const reachable=new Set((await import('../../../src/renderer/materialGraph/normalize')).normalizeGraph(plan.graph).nodes.map(n=>n.id));
  const images=[...material.images].filter(([node])=>reachable.has(node)).flatMap(([node,image])=>{
    const file=pkg.resolve(image.file);return file?[{...image,node,file}]:[];
  });
  const graph={nodes:plan.graph.nodes.map(n=>({...n,inputs:Object.fromEntries(Object.entries(n.inputs??{}).map(([port,i])=>[port,i.type==='filename'?{...i,value:undefined}:i]))})),terminal:plan.graph.terminal};
  const result=await bakeDisplacement({graph,images});
  console.debug('MaterialX displacement bake',{material:material.name,backend:result.backend,width:result.width,height:result.height,maxQuantizationError:result.maxError,...result.timings});
  return {file:result.file,values:{displacementScale:result.scale,displacementBias:result.bias},transform:{uvScale:[1,1] as [number,number],flipY:true,uvChannel:plan.uvChannel,wrapS:'repeat' as const,wrapT:'repeat' as const},warnings:[]};
}
