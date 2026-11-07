import {Camera,CylinderLight,DiskLight,Engine,Mesh,OpenPBRMaterial,Render,createPlaneGeometry} from '../../src/main.js';

async function run() {
  const backend=location.search.includes('webgl')?'webgl':'webgpu';
  const canvas=document.createElement('canvas');document.body.append(canvas);
  const engine=new Engine({canvas,backend});const render=new Render(engine,{bounces:1,bevel:false});
  try {
    const info=await engine.init();engine.display.setSize(48,48);
    const camera=new Camera({projection:'orthographic',left:-2,right:2,top:2,bottom:-2});camera.position=[0,4,0];camera.lookAt([0,0,0]);engine.camera=camera;
    const floor=new Mesh(createPlaneGeometry(),new OpenPBRMaterial({baseColor:[.7,.7,.7],specularWeight:0}));floor.transform[0]=floor.transform[10]=5;
    const disk=new DiskLight({radius:.5,intensity:12});disk.position=[-.8,2,0];disk.lookAt([-.8,0,0]);
    const cylinder=new CylinderLight({radius:.2,length:1,intensity:8});cylinder.position=[.8,2,0];
    const cases=[];
    for(const normalize of [false,true]){disk.normalize=normalize;cylinder.normalize=normalize;engine.scene={meshes:[floor],lights:[disk,cylinder],background:[0,0,0,1]};engine.update();render.restart();await render.converge({samples:256,timeoutMs:120000});const p=(await render.readPixels('hdr')).data;let sum=0;for(let i=0;i<p.length;i+=4)sum+=p[i]+p[i+1]+p[i+2];cases.push({normalize,mean:sum/(p.length/4*3),finite:p.every(Number.isFinite)});}
    const matrix=[];
    for(const count of [64,256,1024]){const lights=Array.from({length:count},(_,i)=>{const l=new DiskLight({radius:.03,intensity:1});l.position=[(i%32-15.5)*.1,2,(Math.floor(i/32)-15.5)*.1];l.lookAt([l.position[0],0,l.position[2]]);return l;});engine.scene={meshes:[floor],lights,background:[0,0,0,1]};const start=performance.now();engine.update();render.restart();await render.converge({samples:8,timeoutMs:120000});const elapsed=performance.now()-start;const p=(await render.readPixels('hdr')).data;let mean=0,variance=0,n=0;for(let i=0;i<p.length;i+=4){const x=(p[i]+p[i+1]+p[i+2])/3;mean+=x;variance+=x*x;n++;}mean/=n;variance=variance/n-mean*mean;matrix.push({count,elapsedMs:elapsed,samplesPerSecond:8*48*48/(elapsed/1000),mean,variance});}
    return {backend,info,cases,matrix};
  } finally {render.dispose();engine.dispose();canvas.remove();}
}
Object.assign(window,{usdLuxLights:{run}});
