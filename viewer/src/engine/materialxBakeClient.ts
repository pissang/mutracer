import type {BakeRequest} from './materialxBake.worker';
import type {BakeResult} from './materialxBake';

export interface BakedHeight {
  file:Blob;
  scale:number;
  bias:number;
  maxError:number;
  width:number;
  height:number;
  backend:BakeResult['backend'];
  timings:BakeResult['timings'];
}
let worker:Worker|undefined,serial=0;
const pending=new Map<number,{resolve:(result:BakedHeight)=>void;reject:(error:Error)=>void}>();
export function bakeDisplacement(request:Omit<BakeRequest,'id'>):Promise<BakedHeight> {
  if(!worker) {
    worker=new Worker(new URL('./materialxBake.worker.ts',import.meta.url),{type:'module'});
    worker.onmessage=(event:MessageEvent<BakedHeight&{id:number;error?:string}>)=>{
      const job=pending.get(event.data.id);pending.delete(event.data.id);
      if(event.data.error)job?.reject(Error(event.data.error));else job?.resolve(event.data);
    };
    worker.onerror=event=>{
      for(const job of pending.values())job.reject(Error(event.message));pending.clear();
      worker?.terminate();worker=undefined;
    };
  }
  const id=++serial;
  return new Promise((resolve,reject)=>{
    pending.set(id,{resolve,reject});
    worker!.postMessage({...request,cpuOnly:import.meta.env.MODE==='native',graph:{nodes:request.graph.nodes,terminal:request.graph.terminal},id});
  });
}
