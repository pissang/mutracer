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
    render.aovs = ['depth', 'position', 'roughness', 'id', 'motion', 'diffuseAlbedo', 'specularAlbedo'];
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
      const currentMotion=await render.readPixels('motion');
      check(!!capturedMotion&&capturedMotion.every((v,i)=>Math.abs(v-currentMotion.data[i])<.00001),'Custom motion differs from readback');
      await render.setDenoiser(null);
    }
    camera.position.x=.25;camera.updateMatrixWorld();engine.camera=fromTHREECamera(camera);engine.update();
    await render.converge({samples:4});const cameraMotion=await render.readPixels('motion');
    const focal=32*.5/Math.tan(Math.PI/8), expected=focal*.25/4;
    const validCamera=Array.from({length:cameraMotion.width*cameraMotion.height},(_,i)=>i*4).filter(o=>cameraMotion.data[o+3]===3);
    check(validCamera.length>100,'Camera motion has no valid history');
    check(validCamera.every(o=>Math.abs(cameraMotion.data[o]-expected)<.001&&Math.abs(cameraMotion.data[o+1])<.001),'Camera motion mismatch');
    mesh.position.x=.25;sync.update();engine.scene=sync.scene;engine.update();
    await render.converge({samples:4});const objectMotion=await render.readPixels('motion');
    const validObject=Array.from({length:objectMotion.width*objectMotion.height},(_,i)=>i*4).filter(o=>objectMotion.data[o+3]===3);
    check(validObject.length>100,'Rigid motion has no valid history');
    check(validObject.every(o=>Math.abs(objectMotion.data[o]+expected)<.001),'Rigid motion mismatch');
    mesh.rotation.z+=.1;sync.update();engine.scene=sync.scene;engine.update();
    await render.converge({samples:4});const rotationMotion=await render.readPixels('motion');let rotationValid=0;
    for(let y=0;y<32;y++)for(let x=0;x<48;x++){
      const o=(y*48+x)*4;if(rotationMotion.data[o+3]!==3)continue;
      const wx=.25+(x+.5-24)*4/focal,wy=(16-y-.5)*4/focal,c=Math.cos(-.1),s=Math.sin(-.1);
      const px=.25+c*(wx-.25)-s*wy,py=s*(wx-.25)+c*wy;
      check(Math.abs(rotationMotion.data[o]-((px-.25)*focal/4+24-x-.5))<.001 && Math.abs(rotationMotion.data[o+1]-(16-py*focal/4-y-.5))<.001,'Rigid rotation motion mismatch');rotationValid++;
    }
    check(rotationValid>100,'Rigid rotation has no valid history');
    source.geometry.position.array[0]-=.1;source.geometry.markVerticesUpdated();engine.update();
    await render.converge({samples:4});check((await render.readPixels('motion')).data.every((v,i)=>i%4!==3||v===0),'Deformation history must be invalid');
    source.aovId=303;engine.update();await render.converge({samples:4});
    check((await render.readPixels('motion')).data.every((v,i)=>i%4!==3||v===0),'New identity history must be invalid');
    const ortho=new THREE.OrthographicCamera(-3,3,2,-2,.1,100);ortho.position.z=4;ortho.updateMatrixWorld();
    engine.camera=fromTHREECamera(ortho);engine.update();await render.converge({samples:4});
    check((await render.readPixels('motion')).data.every((v,i)=>i%4!==3||v===0),'Projection change history must be invalid');
    ortho.position.x=.25;ortho.updateMatrixWorld();engine.camera=fromTHREECamera(ortho);engine.update();await render.converge({samples:4});
    const orthoMotion=await render.readPixels('motion');const orthoValid=Array.from({length:orthoMotion.width*orthoMotion.height},(_,i)=>i*4).filter(o=>orthoMotion.data[o+3]===3);
    check(orthoValid.length>100&&orthoValid.every(o=>Math.abs(orthoMotion.data[o]-2)<.001),'Orthographic motion mismatch');
    source.materials[0].coatWeight=.5;engine.update();await render.converge({samples:4});
    const coatedDiffuse=await render.readPixels('diffuseAlbedo');
    check(coatedDiffuse.data[3]===1&&coatedDiffuse.data[0]>0,'Isotropic coat must have valid reflectance');
    source.materials[0].coatAnisotropy=.5;engine.update();await render.converge({samples:4});
    const unsupportedRoughness=await render.readPixels('roughness'),unsupportedDiffuse=await render.readPixels('diffuseAlbedo');
    check(unsupportedRoughness.data.every((v,i)=>i%4!==2||v===1),'Unsupported anisotropic coat flag missing');
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
        check(occlusionMotion.data[(y*48+x)*4+3]===0,`Far same-object disocclusion must be invalid at ${x},${y}; motion=${Array.from(occlusionMotion.data.slice((y*48+x)*4,(y*48+x)*4+4))}; old depth=${farPreviousDepth.data[(y*48+Math.floor(oldPixel))*4]}; current depth=${farDepth.data[(y*48+x)*4]}`);disoccluded++;
      }
    }
    check(disoccluded>0,'Far occlusion fixture did not cover disocclusion');
    if (errors.length) throw new Error(errors.join('\n'));
    return {customCalls,disoccluded,rotationValid,motion:{cameraExpected:expected,cameraValid:validCamera.length,objectValid:validObject.length},hdr: Array.from(after.data), backend: engine.backend, adapter: info.adapterName, hdrIdentical: true, depth: Array.from(depth.data.slice(0,4)), ids: Array.from(ids.data.slice(0,4)), roughness: Array.from(roughness.data.slice(0,4)), pixels: {diffuse:Array.from(diffuse.data),specular:Array.from(specular.data),id: Array.from(ids.data), depth: Array.from(depth.data), position: Array.from(position.data)}};
  } finally {render.dispose(); engine.dispose(); sync.dispose();}
}
Object.assign(window, {captureAovs});
captureAovs().then(async result => {if (location.search.includes('evidence')) await fetch(`http://localhost:3015/${result.backend}`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(result)});Object.assign(window,{aovResult: result}); document.querySelector('#result')!.textContent = JSON.stringify(result);}).catch(e => {document.querySelector('#result')!.textContent = String(e); console.error(e);});
