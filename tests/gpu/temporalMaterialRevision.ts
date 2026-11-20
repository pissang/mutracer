import {AmbientLight, Camera, Engine, Mesh, OpenPBRMaterial, Render, createPlaneGeometry,
  getRecommendedDeviceDescriptor} from '../../src/main.js';
import {TemporalDenoiser} from '../../src/temporal.js';

function check(value:unknown,message:string):asserts value{if(!value)throw new Error(message);}

async function readIds(device:GPUDevice,texture:GPUTexture,width:number,height:number,layer:number){
  const buffer=device.createBuffer({size:width*height*16,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
  try{
    const encoder=device.createCommandEncoder();
    encoder.copyTextureToBuffer({texture,origin:[0,0,layer]},{buffer,bytesPerRow:width*16},[width,height,1]);
    device.queue.submit([encoder.finish()]);await buffer.mapAsync(GPUMapMode.READ);
    return new Uint32Array(buffer.getMappedRange().slice(0));
  }finally{buffer.destroy();}
}

function probeMaterial(ids:Uint32Array,width:number,height:number,material:number,targetX:number){
  let best=-1,bestDistance=Infinity;
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const at=(y*width+x)*4;if(ids[at+2]!==material)continue;
    const distance=(x-targetX)**2+(y-height/2)**2;
    if(distance<bestDistance){best=at;bestDistance=distance;}
  }
  return best;
}

async function run(){
  const adapter=await navigator.gpu.requestAdapter();check(adapter,'WebGPU unavailable');
  const device=await adapter.requestDevice(getRecommendedDeviceDescriptor(adapter));
  const errors:string[]=[];device.addEventListener('uncapturederror',event=>errors.push((event as GPUUncapturedErrorEvent).error.message));
  const engine=new Engine({canvas:document.createElement('canvas'),device});
  const leftMaterial=new OpenPBRMaterial({baseColor:[.7,.2,.1],specularRoughness:.6});
  const rightMaterial=new OpenPBRMaterial({baseColor:[.1,.3,.8],specularRoughness:.6});
  const geometry=createPlaneGeometry(1,1,'vertical');
  const left=new Mesh(geometry,leftMaterial),right=new Mesh(geometry,rightMaterial);
  left.transform[0]=right.transform[0]=.7;left.transform[5]=right.transform[5]=.7;
  left.transform[12]=-.55;right.transform[12]=.55;
  const camera=new Camera({projection:'orthographic',left:-1.5,right:1.5,top:.75,bottom:-.75});
  camera.position=[0,0,3];camera.lookAt([0,0,0]);
  engine.scene={meshes:[left,right],lights:[new AmbientLight({intensity:1})],background:[.1,.1,.1,1]};engine.camera=camera;engine.update();
  const render=new Render(engine,{width:64,height:32,maxSamples:1});
  const temporal=new TemporalDenoiser(engine,{historyRadius:0,postRadius:1,denoiser:null,stabilizeSparkle:true});
  temporal.attach(render);
  try{
    const originalGlobal=engine._temporalRevision;
    for(let frame=0;frame<3;frame++){
      if(frame===1){leftMaterial.emissionColor=[1,.2,.05];leftMaterial.emissionLuminance=4;engine.update();}
      await render.converge({samples:1,sampleSequenceOffset:frame+11});await temporal.push(render);
    }
    const revisions=engine._temporalMaterialRevisionEntries;
    const leftRevision=revisions.find(([id])=>id===leftMaterial.aovId)?.[1];
    const rightRevision=revisions.find(([id])=>id===rightMaterial.aovId)?.[1];
    check(leftRevision===1&&rightRevision===0,`Material edit did not revise only its material identity: ${JSON.stringify(revisions)}`);
    check(engine._temporalRevision===originalGlobal,'Material edit incorrectly advanced the global scene revision.');
    const internal=temporal as any,post=internal.post;
    const identities=await readIds(device,internal.history.id,64,32,internal.history.slot(2));
    const leftAt=probeMaterial(identities,64,32,leftMaterial.aovId,20),rightAt=probeMaterial(identities,64,32,rightMaterial.aovId,44);
    check(leftAt>=0,`Left material ${leftMaterial.aovId} is absent from the temporal ID ring (${[...new Set(Array.from({length:identities.length/4},(_,i)=>identities[i*4+2]))].slice(0,20).join(',')}; slots ${post.slot(0)},${post.slot(1)},${post.slot(2)}).`);
    check(rightAt>=0,`Right material ${rightMaterial.aovId} is absent from the temporal ID ring.`);
    check(identities[leftAt+3]===1&&identities[rightAt+3]===0,'Revision stamps were not captured per material.');

    const changedByFrame=new Map<number,readonly number[]>([[0,[leftMaterial.aovId]]]);
    await post.filter(1,[0],false,undefined,changedByFrame);
    const weights=new Float32Array(await post.read(post.total,64*32*16));
    check(Math.abs(weights[leftAt+3]-1)<1e-5,`Changed material received post history weight ${weights[leftAt+3]}.`);
    check(weights[rightAt+3]>1.01,`Unchanged material lost post history weight ${weights[rightAt+3]}.`);
    for await(const frame of temporal.flush())await frame.readPixels();
    check(errors.length===0,`Uncaptured GPU errors: ${errors.join('; ')}`);
    return {leftMaterialId:leftMaterial.aovId,rightMaterialId:rightMaterial.aovId,leftRevision,rightRevision,
      changedMaterialWeight:weights[leftAt+3],unchangedMaterialWeight:weights[rightAt+3],globalRevision:engine._temporalRevision,uncapturedErrors:errors.length};
  }finally{temporal.dispose();render.dispose();engine.dispose();device.destroy();}
}

(window as any).runTemporalMaterialRevisionTests=run;
