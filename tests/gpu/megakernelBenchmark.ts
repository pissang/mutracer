import {Engine,Render,Camera,Mesh,OpenPBRMaterial,AmbientLight,SphereLight,createSphereGeometry,createPlaneGeometry,THREESync} from '../../src/main.js';
import {createMaterialSpheres} from '../../viewer/src/engine/loadModel.js';
import * as THREE from 'three';
const pause=()=>new Promise(resolve=>setTimeout(resolve,5));
const median=(values:number[])=>{const sorted=values.slice().sort((a,b)=>a-b);return sorted.length?sorted[Math.floor(sorted.length/2)]:undefined;};

/** Fixed scene, sample stream and hot pipelines; timings report rather than gate. */
async function benchmark(scene:'simple'|'spheres',repeats:number) {
    const engine=new Engine({canvas:document.createElement('canvas'),backend:'webgpu',textureBinding:'atlas'});
    engine.display.setSize(512,320);engine.bvhBuilder='builtin';
    let sync:THREESync|undefined;
    if(scene==='spheres') {
        const model=createMaterialSpheres(),root=new THREE.Scene();root.add(model.root);
        sync=new THREESync(engine,{scene:root});sync.update();
    }else {
        const geometry=createSphereGeometry(64,32);
        const a=new Mesh(geometry,new OpenPBRMaterial({baseColor:[.6,.3,.2],specularRoughness:.4}));
        const b=new Mesh(geometry,new OpenPBRMaterial({baseColor:[.5,.5,.5],specularRoughness:.5}));
        a.transform[12]=-.7;b.transform[12]=.7;
        for(const mesh of [a,b])mesh.transform[0]=mesh.transform[5]=mesh.transform[10]=.6;
        const floor=new Mesh(createPlaneGeometry(),new OpenPBRMaterial({baseColor:[.7,.7,.7],specularRoughness:.8}));
        floor.transform[0]=floor.transform[10]=5;floor.transform[13]=-.6;
        engine.scene={meshes:[a,b,floor],lights:[]};
    }
    const light=new SphereLight({radius:.5,intensity:15});light.position=[-2,4,3];
    engine.scene={...engine.scene!,lights:[new AmbientLight({intensity:.3}),light],background:[.7,.8,1,1]};
    const camera=new Camera({projection:'perspective',fov:35});
    camera.position=scene==='spheres'?[0,3.5,6]:[0,1.5,4];camera.lookAt(scene==='spheres'?[0,.3,-.2]:[0,0,0]);engine.camera=camera;
    const render=new Render(engine,{bounces:6,directLightCandidates:1,samplingPattern:'sobol',maxSamples:64,denoiser:null});
    try {
        engine.update();
        for(let i=0;i<3;i++)await render.converge({samples:64,sampleSequenceOffset:0,timeoutMs:120000});
        const timeTo64SamplesMs:number[]=[];
        for(let i=0;i<repeats;i++) {
            const start=performance.now();await render.converge({samples:64,sampleSequenceOffset:0,timeoutMs:120000});
            timeTo64SamplesMs.push(performance.now()-start);
        }
        const image=await render.readPixels('hdr');
        const digest=await crypto.subtle.digest('SHA-256',image.data as Float32Array<ArrayBuffer>);
        render.maxSamples=4096;render.restart();const gpuSampleTimesMs:number[]=[];
        for(let i=0;i<50;i++) {render.refine();await pause();const time=render.gpuSampleTimeMs;if(time!==undefined)gpuSampleTimesMs.push(time);}
        return {scene,width:512,height:320,samples:64,bounces:6,directLightCandidates:1,samplingPattern:'sobol',sampleSequenceOffset:0,
            timeTo64SamplesMs:median(timeTo64SamplesMs),gpuSampleTimeMs:median(gpuSampleTimesMs)??null,
            wallTimesMs:timeTo64SamplesMs,gpuSampleTimesMs,
            hdrSha256:[...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,'0')).join(''),
            adapter:engine.getDiagnostics()?.adapterName,userAgent:navigator.userAgent};
    }finally{render.dispose();sync?.dispose();engine.dispose();}
}
Object.assign(window,{runMegakernelBenchmark:benchmark});
