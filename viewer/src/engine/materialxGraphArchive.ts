import {MaterialGraph,Texture,type MaterialGraphNode,type MaterialGraphTerminal} from '@meimu/mutracer';
const files=new WeakMap<Texture,Blob>();
export function rememberGraphImage(texture:Texture,file:Blob){files.set(texture,file);}
export interface GraphArchive {
  nodes:MaterialGraphNode[];
  terminal:MaterialGraphTerminal;
  images:{node:string;port:string;file:Blob;options:Pick<Texture,'colorSpace'|'flipY'|'uvScale'|'uvOffset'|'uvChannel'|'wrapS'|'wrapT'>}[];
}
export function archiveGraph(graph:MaterialGraph|undefined):GraphArchive|null {
  if(!graph)return null;
  const images:GraphArchive['images']=[];
  const nodes=graph.nodes.map(node=>({...node,inputs:Object.fromEntries(Object.entries(node.inputs??{}).map(([port,input])=>{
    const texture=input.value;
    if(!(texture instanceof Texture))return [port,input];
    const file=files.get(texture);
    if(!file)throw Error(`Cannot save graph image ${node.id}.${port}`);
    images.push({node:node.id,port,file,options:{colorSpace:texture.colorSpace,flipY:texture.flipY,uvScale:[...texture.uvScale],uvOffset:[...texture.uvOffset],uvChannel:texture.uvChannel,wrapS:texture.wrapS,wrapT:texture.wrapT}});
    return [port,{...input,value:undefined}];
  }))}));
  return {nodes,terminal:graph.terminal,images};
}
export async function restoreGraph(archive:GraphArchive|null|undefined):Promise<MaterialGraph|null> {
  if(!archive)return null;
  const graph=new MaterialGraph(archive);
  await Promise.all(archive.images.map(async image=>{
    const bitmap=await createImageBitmap(image.file,{premultiplyAlpha:'none',colorSpaceConversion:'none'});
    const texture=new Texture(bitmap);Object.assign(texture,image.options);rememberGraphImage(texture,image.file);
    graph.setInput(image.node,image.port,{type:'filename',value:texture});
  }));
  return graph;
}
