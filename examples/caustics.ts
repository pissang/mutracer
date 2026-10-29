import * as THREE from 'three';
import {OrbitControls} from 'three/examples/jsm/controls/OrbitControls.js';
import {Engine,RenderLoop,THREESync,Mesh,OpenPBRMaterial,SpotLight,createPlaneGeometry,createSphereGeometry} from '@meimu/mutracer';
import {showStatus} from './shared/status';
const canvas=document.querySelector<HTMLCanvasElement>('#main')!;
const engine=new Engine({canvas,backend:location.search.includes('webgl')?'webgl':'auto'});
const floor=new Mesh(createPlaneGeometry(),new OpenPBRMaterial({baseColor:[.6,.6,.6]}));
floor.transform[0]=floor.transform[10]=6;
const glass=new Mesh(createSphereGeometry(64,32),new OpenPBRMaterial({transmissionWeight:1,specularRoughness:0,specularIor:1.5}));
glass.position=[0,.85,0];glass.transform[0]=glass.transform[5]=glass.transform[10]=.8;
const light=new SpotLight({intensity:120,radius:0,innerAngle:25,outerAngle:35});
light.position=[-1.5,3,0];light.lookAt([0,0,0]);
engine.scene={meshes:[floor,glass],lights:[light],background:[0,0,0,1]};
const camera=new THREE.PerspectiveCamera(50,1,.1,100);camera.position.set(3,2.6,4);camera.lookAt(0,0,0);
const controls=new OrbitControls(camera,canvas);const sync=new THREESync(engine,{camera,controls});
const loop=new RenderLoop(engine,{sync,final:{bounces:8,maxSamples:1024,caustics:{lightTracing:true}}});
document.querySelector<HTMLInputElement>('#caustics')!.onchange=event=>{
  const enabled=(event.target as HTMLInputElement).checked;
  loop.final.caustics={lightTracing:enabled};
};
function resize(){engine.display.setSize(canvas.clientWidth,canvas.clientHeight);camera.aspect=canvas.clientWidth/canvas.clientHeight;camera.updateProjectionMatrix();}
addEventListener('resize',resize);resize();
function frame(){showStatus(document.querySelector('#status')!,engine,loop.final,loop.tick());requestAnimationFrame(frame);}frame();
addEventListener('pagehide',()=>{loop.dispose();sync.dispose();controls.dispose();engine.dispose();});
