// Fixed-sequence HDR comparisons against equivalent source radiance and scene orientations.
import * as THREE from 'three';
import { Engine, Render } from '../../src/main.js';
import { THREESync } from '../../src/three.js';

async function run() {
  const webgl = location.search.includes('webgl');
  const engine = new Engine({canvas: document.createElement('canvas'), backend: webgl ? 'webgl' : 'webgpu'});
  engine.display.setSize(16,16);
  const render = new Render(engine);
  const source = new THREE.Scene();
  source.background = new THREE.Color(0,0,0);
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(8,8), new THREE.MeshStandardMaterial({roughness:1}));
  source.add(mesh, new THREE.AmbientLight(0xffffff,.1));
  const camera = new THREE.OrthographicCamera(-1,1,1,-1,.1,10); camera.position.z=2;
  const sync = new THREESync(engine, {scene:source,camera});
  const pixels = new Float32Array([2,.5,.25,1, .5,1,2,1, 1,.25,.5,1, .25,2,.5,1,
    .2,.3,.4,1, .5,.4,.3,1, .1,.2,.3,1, .4,.2,.1,1]);
  const original = new THREE.DataTexture(pixels,4,2,THREE.RGBAFormat,THREE.FloatType);
  const capture = async () => {
    camera.matrixWorldNeedsUpdate=true; mesh.matrixWorldNeedsUpdate=true;
    sync.update(); engine.update();
    await render.converge({samples:32,sampleSequenceOffset:0,timeoutMs:60_000});
    return (await render.readPixels('hdr')).data;
  };
  const results: {name:string;maxError:number}[]=[];
  try {
    const record = (name:string, expected:Float32Array, actual:Float32Array) => {
      const row={name,maxError:Math.max(...actual.map((value,index)=>Math.abs(value-expected[index])))};
      results.push(row); const output=document.createElement('pre');output.textContent=JSON.stringify(row);document.body.append(output);
    };
    if (location.search.includes('grounded')) {
      source.remove(...source.children.filter(child=>child!==mesh));
      mesh.position.x=100; camera.position.set(1,2,4); camera.lookAt(0,0,0);
      // Matching edge texels isolate rotation from the existing clamped longitude seam.
      const groundPixels=new Float32Array([1,.2,.3,1, 1,.2,.3,1, .1,2,4,1, 1,.2,.3,1,
        .2,.3,.4,1, .2,.3,.4,1, 3,.1,.2,1, .2,.3,.4,1]);
      for(let i=3;i<groundPixels.length;i+=4) groundPixels[i]=.75;
      const groundMap=new THREE.DataTexture(groundPixels,4,2,THREE.RGBAFormat,THREE.FloatType);
      source.environment=original;
      for (const intensity of [0,.5,2]) {
        const shifted=new Float32Array(groundPixels.length);
        for(let y=0;y<2;y++) for(let x=0;x<4;x++) for(let c=0;c<4;c++) shifted[(y*4+x)*4+c]=groundPixels[(y*4+(x+1)%4)*4+c]*(c===3?1:intensity);
        const baked=new THREE.DataTexture(shifted,4,2,THREE.RGBAFormat,THREE.FloatType);
        source.userData.mutracerGroundedSkybox={texture:baked,height:1.6,radius:30,center:[.4,-.3]};
        const expected=await capture();
        source.userData.mutracerGroundedSkybox={texture:groundMap,height:1.6,radius:30,center:[.4,-.3],rotation:Math.PI/2,intensity};
        source.backgroundRotation.set(.3,.7,-.2,'ZYX');
        record(`grounded rotation and intensity ${intensity}, ignoring backgroundRotation`,expected,await capture());
        baked.dispose();
      }
      source.userData.mutracerGroundedSkybox={texture:groundMap,height:1.6,radius:30};
      source.backgroundRotation.set(0,0,0);
      const expected=await capture();
      source.backgroundRotation.set(.2,.8,-.4,'YXZ');
      record('grounded default yaw ignores backgroundRotation',expected,await capture());
      groundMap.dispose();
    } else if (location.search.includes('rotation')) {
      mesh.material.dispose(); mesh.material=webgl?new THREE.MeshStandardMaterial({roughness:1}):new THREE.MeshPhysicalMaterial({roughness:.5,metalness:1,anisotropy:.5}); mesh.geometry.computeTangents();
      source.environment=original; source.remove(...source.children.filter(child=>child!==mesh));
      camera.matrixAutoUpdate=false; mesh.matrixAutoUpdate=false;
      const base=new THREE.Matrix4().makeTranslation(0,0,2);
      render.bounces=webgl?3:1;
      for (const kind of ['lighting','background','explicit background','backgroundRotation']) {
        const baseMesh=kind==='lighting'?new THREE.Matrix4():new THREE.Matrix4().makeTranslation(100,0,0);
        source.background=kind==='lighting'?new THREE.Color(0,0,0):kind==='explicit background'||kind==='backgroundRotation'?original:null;
        const rotations=webgl&&kind==='lighting'?[new THREE.Euler(0,Math.PI/2,0),new THREE.Euler(0,.7,0)]:[new THREE.Euler(0,Math.PI/2,0),new THREE.Euler(.3,.7,-.2,'ZYX')];
        for (const euler of rotations) {
          const inverse=new THREE.Matrix4().makeRotationFromEuler(euler).invert();
          source.environmentRotation.set(0,0,0); source.backgroundRotation.set(0,0,0);
          mesh.matrix.copy(kind==='explicit background'?baseMesh:inverse.clone().multiply(baseMesh));
          camera.matrix.copy(kind==='explicit background'?base:inverse.clone().multiply(base));
          const expected=await capture();
          mesh.matrix.copy(baseMesh); camera.matrix.copy(base);
          if (kind==='backgroundRotation') source.backgroundRotation.copy(euler);
          else source.environmentRotation.copy(euler);
          record(`${kind} rotation ${euler.order} ${euler.y}`,expected,await capture());
          if (kind==='backgroundRotation') {
            source.backgroundRotation.set(0,0,0); camera.matrix.copy(inverse.clone().multiply(base));
            record(`backgroundRotation reset ${euler.order}`,expected,await capture());
          }
        }
      }
    } else for (const intensity of [0,.5,2]) {
      source.environmentIntensity=1;
      const scaled = new THREE.DataTexture(pixels.map((value,index)=>index%4===3?value:value*intensity),4,2,THREE.RGBAFormat,THREE.FloatType);
      source.environment=scaled;
      const expected=await capture();
      source.environment=original; source.environmentIntensity=intensity;
      const actual=await capture();
      record(`environment intensity ${intensity} with ambient`,expected,actual);
      scaled.dispose();
    }
    document.querySelector('#summary')!.textContent=JSON.stringify({backend:engine.backend,passed:results.every(r=>Number.isFinite(r.maxError)&&r.maxError<.002)});
  } finally {render.dispose();sync.dispose();engine.dispose();original.dispose();mesh.geometry.dispose();mesh.material.dispose();}
}
run().catch(error=>{document.querySelector('#summary')!.textContent=String(error?.stack??error);});
