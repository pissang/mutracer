import * as THREE from 'three';
import {Engine, Render} from '../../src/main.js';
import { THREESync, fromTHREECamera } from '../../src/three.js';
async function captureAovs() {
  const engine = new Engine({canvas: document.createElement('canvas'), backend: location.search.includes('webgl') ? 'webgl' : 'webgpu'});
  const render = new Render(engine, {width: 48, height: 32, bounces: 1});
  const root = new THREE.Scene(), mesh: THREE.Mesh<THREE.BufferGeometry> = new THREE.Mesh(new THREE.PlaneGeometry(20,20), new THREE.MeshStandardMaterial({roughness: .4, metalness: .2}));
  mesh.rotation.z=.17; root.add(mesh, new THREE.AmbientLight());
  const camera = new THREE.PerspectiveCamera(45, 1.5, .1, 100); camera.position.z = 4; camera.updateMatrixWorld();
  const sync = new THREESync(engine, {scene: root}); sync.update();
  engine.scene = sync.scene; engine.camera = fromTHREECamera(camera); engine.update();
  const errors: string[] = []; engine.on('error', e => errors.push(e.message));
  try {
    const info = await engine.init();
    engine.device?.addEventListener('uncapturederror', event => errors.push((event as GPUUncapturedErrorEvent).error.message));
    await render.converge({samples: 4}); const before = await render.readPixels('hdr');
    const source = sync.scene!.meshes[0]; source.aovId = 0xfffffffe; source.materials[0].aovId = 0x800001ff; engine.update();
    render.aovs = ['depth', 'position', 'roughness', 'id', 'motion', 'diffuseAlbedo', 'specularAlbedo', 'centerDepth'];
    await render.converge({samples: 4}); const after = await render.readPixels('hdr');
    const depth = await render.readPixels('depth'), position = await render.readPixels('position'), ids = await render.readPixels('id'), roughness = await render.readPixels('roughness');
    const check = (ok: boolean, message: string) => {if (!ok) throw new Error(message);};
    check(before.data.every((v,i) => Object.is(v, after.data[i])), 'AOV changed beauty');
    check(depth.data.every((v,i) => i%4 !== 0 || Math.abs(v-4) < .001), 'Depth mismatch');
    check(position.data.every((v,i) => i%4 !== 2 || Math.abs(v) < .001), 'Position mismatch');
    check(ids.data.every((v,i) => i%4 === 0 ? v === 0xfffffffe : i%4 === 2 ? v === 0x800001ff : i%4 === 1 ? v === 0 : v < 2), 'ID mismatch');
    check(roughness.data.every((v,i) => i%4 !== 0 || Math.abs(v-.4) < .001), 'Roughness mismatch');
    const diffuse=await render.readPixels('diffuseAlbedo'),specular=await render.readPixels('specularAlbedo');
    check(diffuse.data.every(Number.isFinite)&&specular.data.every(Number.isFinite),'Nonfinite reflectance');
    check(diffuse.data[3]===1&&specular.data[3]===1&&diffuse.data[0]>0&&specular.data[0]>0,'Invalid reflectance coverage');
    const initialMotion=await render.readPixels('motion');check(initialMotion.data.every(v=>v===0),'First motion must be invalid');
    let customCalls=0; let capturedMotion: Float32Array | undefined;
    if(engine.backend==='webgpu'){
      const expectedAovs = {depth, position, roughness, diffuseAlbedo: diffuse, specularAlbedo: specular, id: ids, motion: initialMotion};
      const requested = Object.keys(expectedAovs) as (keyof typeof expectedAovs)[];
      await render.setDenoiser({type:'custom',aovs:requested,denoiser:{async denoise(input){
        const bytes=input.width*input.height*16;
        const staging=input.device.createBuffer({size:bytes*requested.length,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST});
        try {
          const encoder=input.device.createCommandEncoder();encoder.copyBufferToBuffer(input.color,0,input.output,0,bytes);
          requested.forEach((kind,index)=>{
            check(!!input.aovs?.[kind],`Requested GPU AOV missing: ${kind}`);
            encoder.copyBufferToBuffer(input.aovs![kind]!,0,staging,bytes*index,bytes);
          });
          input.device.queue.submit([encoder.finish()]);
          await staging.mapAsync(GPUMapMode.READ);const mapped=staging.getMappedRange();
          requested.forEach((kind,index)=>{
            const actual=kind==='id'?new Uint32Array(mapped,bytes*index,bytes/4):new Float32Array(mapped,bytes*index,bytes/4);
            const expected=expectedAovs[kind].data;
            if(kind==='motion') capturedMotion=Float32Array.from(actual);
            else check(actual.every((v,i)=>kind==='id'?v===expected[i]:Math.abs(v-expected[i])<.00001),`Custom ${kind} differs from readback`);
          });
          customCalls++;
        } finally {if(staging.mapState==='mapped')staging.unmap();staging.destroy();}
      }}});
      await render.converge({samples:4});check(customCalls>0,'Custom filter was not called');
      await render.setDenoiser(null);
    }
    camera.position.x=.25;camera.updateMatrixWorld();engine.camera=fromTHREECamera(camera);engine.update();
    if(engine.backend==='webgpu'){
      await render.setDenoiser({type:'custom',aovs:['motion'],denoiser:{async denoise(input){
        const bytes=input.width*input.height*16;
        const staging=input.device.createBuffer({size:bytes,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST});
        try {
          const encoder=input.device.createCommandEncoder();
          encoder.copyBufferToBuffer(input.color,0,input.output,0,bytes);
          if(!input.aovs?.motion)throw new Error('Requested GPU AOV missing: motion');
          encoder.copyBufferToBuffer(input.aovs.motion,0,staging,0,bytes);
          input.device.queue.submit([encoder.finish()]);
          await staging.mapAsync(GPUMapMode.READ);capturedMotion=Float32Array.from(new Float32Array(staging.getMappedRange()));
          customCalls++;
        } finally {if(staging.mapState==='mapped')staging.unmap();staging.destroy();}
      }}});
    }
    await render.converge({samples:4});const cameraMotion=await render.readPixels('motion');
    const focal=32*.5/Math.tan(Math.PI/8), expected=focal*.25/4;
    const validCamera=Array.from({length:cameraMotion.width*cameraMotion.height},(_,i)=>i*4).filter(o=>cameraMotion.data[o+3]===3);
    check(validCamera.length>100,'Camera motion has no valid history');
    check(validCamera.every(o=>Math.abs(cameraMotion.data[o]-expected)<.001&&Math.abs(cameraMotion.data[o+1])<.001),'Camera motion mismatch');
    if(engine.backend==='webgpu'){
      check(!!capturedMotion&&capturedMotion.every((v,i)=>Math.abs(v-cameraMotion.data[i])<.00001),'Custom motion differs from readback');
      await render.setDenoiser(null);
    }
    const cameraDepth=await render.readPixels('centerDepth');
    camera.position.z=3.5;camera.updateMatrixWorld();engine.camera=fromTHREECamera(camera);engine.update();
    await render.converge({samples:4});const dollyMotion=await render.readPixels('motion'),dollyDepth=await render.readPixels('centerDepth');
    const dollyValid=Array.from({length:dollyMotion.width*dollyMotion.height},(_,i)=>i*4).filter(o=>dollyMotion.data[o+3]===3);
    const dollyDepthRelativeError=Math.max(...dollyValid.map(o=>Math.abs(dollyMotion.data[o+2]-4)/4));
    check(dollyValid.length>100,'Dolly motion has no valid history');
    check(dollyDepthRelativeError<1e-4,'Dolly previous depth mismatch');
    check(dollyValid.some(o=>Math.abs(dollyMotion.data[o+2]-dollyDepth.data[o])>.4),'Dolly depth did not differ from current depth');
    check(cameraDepth.data.some((v,i)=>i%4===0&&Math.abs(v-4)<.001),'Previous camera depth fixture mismatch');
    mesh.position.x=.25;sync.update();engine.scene=sync.scene;engine.update();
    await render.converge({samples:4});const objectMotion=await render.readPixels('motion');
    const rigidExpected=focal*.25/3.5;
    const validObject=Array.from({length:objectMotion.width*objectMotion.height},(_,i)=>i*4).filter(o=>objectMotion.data[o+3]===3);
    check(validObject.length>100,'Rigid motion has no valid history');
    check(validObject.every(o=>Math.abs(objectMotion.data[o]+rigidExpected)<.001),'Rigid motion mismatch');
    mesh.position.z=.25;sync.update();engine.scene=sync.scene;engine.update();
    await render.converge({samples:4});const axialMotion=await render.readPixels('motion'),axialDepth=await render.readPixels('centerDepth');
    const axialValid=Array.from({length:axialMotion.width*axialMotion.height},(_,i)=>i*4).filter(o=>axialMotion.data[o+3]===3);
    const axialDepthRelativeError=Math.max(...axialValid.map(o=>Math.abs(axialMotion.data[o+2]-3.5)/3.5));
    check(axialValid.length>100,'Rigid axial motion has no valid history');
    check(axialDepthRelativeError<1e-4,'Rigid previous depth mismatch');
    check(axialValid.some(o=>Math.abs(axialMotion.data[o+2]-axialDepth.data[o])>.2),'Rigid previous depth did not differ from current depth');
    mesh.rotation.z+=.1;sync.update();engine.scene=sync.scene;engine.update();
    await render.converge({samples:4});const rotationMotion=await render.readPixels('motion');let rotationValid=0;
    for(let y=0;y<32;y++)for(let x=0;x<48;x++){
      const o=(y*48+x)*4;if(rotationMotion.data[o+3]!==3)continue;
      const distance=3.25,wx=.25+(x+.5-24)*distance/focal,wy=(16-y-.5)*distance/focal,c=Math.cos(-.1),s=Math.sin(-.1);
      const px=.25+c*(wx-.25)-s*wy,py=s*(wx-.25)+c*wy;
      check(Math.abs(rotationMotion.data[o]-((px-.25)*focal/distance+24-x-.5))<.001 && Math.abs(rotationMotion.data[o+1]-(16-py*focal/distance-y-.5))<.001,'Rigid rotation motion mismatch');rotationValid++;
    }
    check(rotationValid>100,'Rigid rotation has no valid history');
    source.geometry.position.array[0]-=.1;source.geometry.markVerticesUpdated();engine.update();
    await render.converge({samples:4});check((await render.readPixels('motion')).data.every((v,i)=>i%4!==3||v===0),'Deformation history must be invalid');
    source.aovId=303;engine.update();await render.converge({samples:4});
    check((await render.readPixels('motion')).data.every((v,i)=>i%4!==3||v===0),'New identity history must be invalid');
    const ortho=new THREE.OrthographicCamera(-3,3,2,-2,.1,100);ortho.position.z=4;ortho.updateMatrixWorld();
    engine.camera=fromTHREECamera(ortho);engine.update();await render.converge({samples:4});
    check((await render.readPixels('motion')).data.every((v,i)=>i%4!==3||v===0),'Projection change history must be invalid');
    ortho.position.x=.25;ortho.position.z=3.6;ortho.updateMatrixWorld();engine.camera=fromTHREECamera(ortho);engine.update();await render.converge({samples:4});
    const orthoMotion=await render.readPixels('motion'),orthoDepth=await render.readPixels('centerDepth');const orthoValid=Array.from({length:orthoMotion.width*orthoMotion.height},(_,i)=>i*4).filter(o=>orthoMotion.data[o+3]===3);
    check(orthoValid.length>100&&orthoValid.every(o=>Math.abs(orthoMotion.data[o]-2)<.001),'Orthographic motion mismatch');
    const orthoDepthRelativeError=Math.max(...orthoValid.map(o=>Math.abs(orthoMotion.data[o+2]-3.75)/3.75));
    check(orthoDepthRelativeError<1e-4,'Orthographic previous depth mismatch');
    check(orthoValid.some(o=>Math.abs(orthoMotion.data[o+2]-orthoDepth.data[o])>.3),'Orthographic previous depth did not differ from current depth');
    mesh.geometry=new THREE.PlaneGeometry(1.5,1.5);mesh.position.set(0,0,0);mesh.rotation.set(0,0,0);sync.update();engine.scene=sync.scene;
    camera.position.set(0,0,4);camera.lookAt(0,0,0);camera.updateMatrixWorld();engine.camera=fromTHREECamera(camera);engine.update();
    await render.converge({samples:4});camera.position.x=.1;camera.updateMatrixWorld();engine.camera=fromTHREECamera(camera);engine.update();await render.converge({samples:4});
    const backgroundIds=await render.readPixels('id'),backgroundMotion=await render.readPixels('motion');let backgroundPixels=0;
    for(let o=0;o<backgroundIds.data.length;o+=4)if(backgroundIds.data[o]===0xffffffff){
      check(backgroundMotion.data[o+2]===0&&backgroundMotion.data[o+3]===0,'Background motion must have zero depth and validity');backgroundPixels++;
    }
    check(backgroundPixels>0,'Background fixture did not leave uncovered pixels');
    source.materials[0].coatWeight=.5;engine.update();await render.converge({samples:4});
    const unsupportedRoughness=await render.readPixels('roughness'),unsupportedDiffuse=await render.readPixels('diffuseAlbedo');
    check(unsupportedRoughness.data.every((v,i)=>i%4!==2||unsupportedRoughness.data[i+1]===0||v===1),'Unsupported coat flag missing');
    check(unsupportedDiffuse.data.every(v=>v===0),'Unsupported reflectance must have zero validity');
    // Two disconnected surfaces in one object must reject disoccluded history,
    // even where perspective NDC depths differ by less than 0.001.
    const farGeometry=new THREE.BufferGeometry();
    farGeometry.setAttribute('position',new THREE.Float32BufferAttribute([
      -100,-100,0,100,-100,0,100,100,0,-100,100,0,
      -3,-20,10,3,-20,10,3,20,10,-3,20,10],3));
    farGeometry.setIndex([0,1,2,0,2,3,4,5,6,4,6,7]);farGeometry.computeVertexNormals();
    mesh.geometry=farGeometry;mesh.position.set(0,0,0);mesh.rotation.z=0;sync.update();engine.scene=sync.scene;
    camera.position.set(0,0,110);camera.far=1000;camera.updateProjectionMatrix();camera.updateMatrixWorld();
    engine.camera=fromTHREECamera(camera);engine.update();await render.converge({samples:4});
    const farPreviousDepth=await render.readPixels('depth');
    camera.position.x=18;camera.updateMatrixWorld();engine.camera=fromTHREECamera(camera);engine.update();await render.converge({samples:4});
    const occlusionMotion=await render.readPixels('motion'),farDepth=await render.readPixels('depth');let disoccluded=0;
    for(let y=0;y<32;y++)for(let x=0;x<48;x++){
      const slope=(x+.5-24)/focal,currentFront=18+slope*100;
      const behind=18+slope*110,oldPixel=behind*focal/110+24;
      const oldFront=(Math.floor(oldPixel)+.5-24)*100/focal;
      if(Math.abs(currentFront)>3 && Math.abs(oldFront)<3 && Math.abs((15.5-y)*100/focal)<18){
      const offset=(y*48+x)*4;
      check(occlusionMotion.data[offset+3]===0&&occlusionMotion.data[offset+2]===0,`Far same-object disocclusion must be invalid at ${x},${y}; motion=${Array.from(occlusionMotion.data.slice(offset,offset+4))}; old depth=${farPreviousDepth.data[(y*48+Math.floor(oldPixel))*4]}; current depth=${farDepth.data[(y*48+x)*4]}`);disoccluded++;
      }
    }
    check(disoccluded>0,'Far occlusion fixture did not cover disocclusion');
    // A ground plane seen at grazing angles must keep exact, valid motion.
    // Half a pixel of depth slope there exceeds a fixed relative tolerance.
    mesh.geometry=new THREE.PlaneGeometry(400,400);mesh.rotation.set(-Math.PI/2,0,0);mesh.position.set(0,0,0);
    sync.update();engine.scene=sync.scene;
    camera.position.set(0,.3,4);camera.lookAt(0,0,0);camera.updateMatrixWorld();
    engine.camera=fromTHREECamera(camera);engine.update();await render.converge({samples:4});
    const previousCamera=camera.clone();
    camera.position.x+=.03;camera.position.z-=.05;camera.updateMatrixWorld();
    engine.camera=fromTHREECamera(camera);engine.update();await render.converge({samples:4});
    const grazingMotion=await render.readPixels('motion');
    let grazingSurface=0,grazingValid=0,grazingError=0,grazingDepthRelativeError=0;
    const ray=new THREE.Vector3(),hit=new THREE.Vector3();
    for(let y=0;y<32;y++)for(let x=0;x<48;x++){
      ray.set((x+.5)/48*2-1,1-(y+.5)/32*2,.5).unproject(camera).sub(camera.position).normalize();
      if(ray.y>=-1e-4)continue;
      hit.copy(camera.position).addScaledVector(ray,-camera.position.y/ray.y);
      const old=hit.clone().project(previousCamera),px=(old.x+1)/2*48,py=(1-old.y)/2*32;
      if(px<.5||px>47.5||py<.5||py>31.5)continue;
      grazingSurface++;const o=(y*48+x)*4;
      if(grazingMotion.data[o+3]!==3)continue;grazingValid++;
      const previousForward=previousCamera.getWorldDirection(new THREE.Vector3());
      const expectedPreviousDepth=hit.clone().sub(previousCamera.position).dot(previousForward);
      grazingDepthRelativeError=Math.max(grazingDepthRelativeError,Math.abs(grazingMotion.data[o+2]-expectedPreviousDepth)/expectedPreviousDepth);
      grazingError=Math.max(grazingError,Math.abs(grazingMotion.data[o]-(px-x-.5)),Math.abs(grazingMotion.data[o+1]-(py-y-.5)));
    }
    check(grazingSurface>200,'Grazing fixture covers too few pixels');
    check(grazingValid>=grazingSurface*.98,`Grazing motion lost history: ${grazingValid}/${grazingSurface}`);
    check(grazingError<.01,`Grazing motion mismatch: ${grazingError}`);
    check(grazingDepthRelativeError<1e-4,`Grazing previous depth mismatch: ${grazingDepthRelativeError}`);
    if (errors.length) throw new Error(errors.join('\n'));
    return {customCalls,disoccluded,rotationValid,grazing:{surface:grazingSurface,valid:grazingValid,maxError:grazingError,previousDepthRelativeError:grazingDepthRelativeError},motion:{cameraExpected:expected,cameraValid:validCamera.length,objectValid:validObject.length,dollyPreviousDepthRelativeError:dollyDepthRelativeError,rigidPreviousDepthRelativeError:axialDepthRelativeError,orthographicPreviousDepthRelativeError:orthoDepthRelativeError},hdr: Array.from(after.data), backend: engine.backend, adapter: info.adapterName, hdrIdentical: true, depth: Array.from(depth.data.slice(0,4)), ids: Array.from(ids.data.slice(0,4)), roughness: Array.from(roughness.data.slice(0,4)), pixels: {diffuse:Array.from(diffuse.data),specular:Array.from(specular.data),id: Array.from(ids.data), depth: Array.from(depth.data), position: Array.from(position.data)}};
  } finally {render.dispose(); engine.dispose(); sync.dispose();}
}
Object.assign(window, {captureAovs});
captureAovs().then(async result => {if (location.search.includes('evidence')) await fetch(`http://localhost:3015/${result.backend}`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(result)});Object.assign(window,{aovResult: result}); document.querySelector('#result')!.textContent = JSON.stringify(result);}).catch(e => {document.querySelector('#result')!.textContent = String(e); console.error(e);});
