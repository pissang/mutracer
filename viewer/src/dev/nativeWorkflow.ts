// Opt-in real-window evidence driver. Uses the same public viewer actions as UI.
import type {WebEngine} from '../engine/WebEngine';
import {NativeRenderHost} from '../engine/NativeRenderHost';
import {setSettings,useViewer} from '../store';
import type {TreeNode} from '../store';
const pause=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
export async function run(engine:WebEngine){
 if(!(engine.engine instanceof NativeRenderHost))throw Error('Native workflow needs the native host');
 const host=engine.engine,results:string[]=[],started=performance.now();
 const settled=async()=>{await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);await host.flush();for(let i=0;i<1200;i++){if(await host.transport.request<boolean>('settled'))return;await pause(50);}throw Error('Scene did not settle');};
 const artifact=async(label:string,kind:'png'|'f32'|'json',data:Uint8Array)=>host.transport.request('artifact',{label,kind,blob:await host.upload(data)});
 const capture=async(label:string)=>{await settled();const image=await engine.readPixels('hdr');await artifact(label,'f32',new Uint8Array(image.data.buffer));await artifact(label,'png',new Uint8Array(await(await engine.captureImage()).arrayBuffer()));await artifact(label,'json',new TextEncoder().encode(JSON.stringify({width:image.width,height:image.height,samples:useViewer.getState().stats.samples,seed:0})));results.push(label);};
 try{
  for(let i=0;i<1200&&!useViewer.getState().model;i++)await pause(50);
  setSettings({maxSamples:16,previewEnabled:false,denoise:false,autoRotate:false});
  if(new URLSearchParams(location.search).has('recovered')) {
   await settled();const toast=useViewer.getState().toast;
   await host.transport.request('workflowDone',{passed:!!toast?.message.includes('interface restarted'),cases:['recovery'],toast});return;
  }
  await capture('gltf');
  if((window as Window & {mutracerImportOnly?:boolean}).mutracerImportOnly) {
   await host.transport.request('workflowDone',{passed:true,cases:results,importAndRenderMs:performance.now()-started,model:useViewer.getState().model,stats:useViewer.getState().stats});return;
  }
  const first=(nodes:TreeNode[]):string|undefined=>{for(const node of nodes){if(node.materials[0])return node.materials[0].id;const nested=first(node.children);if(nested)return nested;}};
  const id=first(useViewer.getState().tree);if(!id)throw Error('No material in workflow scene');
  const text=`<?xml version="1.0"?><materialx version="1.39"><noise3d name="noise" type="float"/><open_pbr_surface name="surface" type="surfaceshader"><input name="base_color" type="color3" value="0.15,0.45,0.75"/><input name="specular_roughness" type="float" nodename="noise"/></open_pbr_surface><surfacematerial name="paint_material" type="material"><input name="surfaceshader" type="surfaceshader" nodename="surface"/></surfacematerial></materialx>`;
  const file=new File([text],'workflow.mtlx');if(!await engine.importMaterialX(id,[{path:file.name,file}]))throw Error('MaterialX import failed');await capture('materialx');
  const header=new TextEncoder().encode('#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 2 +X 4\n'),pixels=new Uint8Array(32);for(let i=0;i<32;i+=4)pixels.set([128,80,32,130],i);
  const hdr=new File([header,pixels],'workflow.hdr');await engine.loadFiles([{path:hdr.name,file:hdr}]);setSettings({background:'environment',lighting:'environment'});await capture('hdr');
  setSettings({lighting:'studio'});await capture('studio');
  setSettings({denoise:true,denoiseModel:'standard',denoiseWhileConverging:false});await capture('denoised');
  const output=await engine.renderImage({width:96,height:64,samples:16,transparent:true});await artifact('independent-export','png',new Uint8Array(await output.arrayBuffer()));results.push('independent-export');
  await host.transport.request('workflowDone',{passed:true,cases:results});
 }catch(error){await host.transport.request('workflowDone',{passed:false,cases:results,error:String(error)});}
}
