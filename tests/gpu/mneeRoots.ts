// Fixed-receiver root enumeration, independent of the render's Newton start count.
// Executes the production solver, intersection code and seed distribution.
import {wgpuShaderSource} from '../../src/renderer/wgpuShaderSource.js';
import {mneeDiagnostics} from '../../src/research/mnee/index.js';
export async function enumerateRoots(viewer:any,batches=4) {
 const pass=mneeDiagnostics.rootPass as any;if(!pass)throw Error('Root probe pass was not captured');
 const device=viewer.engine.device as GPUDevice,constants=pass._prevPipelineConstants;
 const features={hasDisplacement:pass._hasDisplacement,hasAlpha:Boolean(constants.HAS_ALPHA_BLEND),hasSceneAlpha:Boolean(constants.HAS_ALPHA),hasAnisotropyDirections:Boolean(constants.USE_ANISOTROPY_DIRECTIONS),hasCoatNormals:Boolean(constants.USE_COAT_NORMAL_FRAMES),blasLayoutMask:pass._blasLayoutMask,dynamicEnvironment:true,mnee:true,mneeDebugGroup:0,mneeSeeds:4,mneeDamping:!!mneeDiagnostics.mneeDamping,mneeMaxDepth:20,workgroupSize:1};
 const source=wgpuShaderSource(constants,features,true).replace('fn main(', 'fn unusedBeauty(');
 const groups=pass._rayTraceBindGroups as GPUBindGroup[],layout=device.createPipelineLayout({bindGroupLayouts:groups.map((_,i)=>pass._rayTracePipeline.getBindGroupLayout(i))});
 const targets=pass.getOutputBuffer(),count=128*128,size=count*16;
 const readbacks=[0,1,2].map(()=>device.createBuffer({size,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ}));
 const emitter=viewer.modelGroup.getObjectByName('07_Light');
 // The mesh positions are already in world coordinates after matrixWorld.
 const positions=emitter.geometry.attributes.position;const center=[0,0,0];
 for(let i=0;i<positions.count;i++)for(let k=0;k<3;k++)center[k]+=positions.array[i*3+k]/positions.count;
 const matrix=emitter.matrixWorld.elements,y=[0,1,2].map(k=>matrix[k]*center[0]+matrix[4+k]*center[1]+matrix[8+k]*center[2]+matrix[12+k]);
 const results=[];
 for(const pixel of [[64,60],[90,70],[65,124]]) {
  const accepted:any[]=[],failures=Array(15).fill(0);let receiver:number[]=[];const checkpoints:number[]=[];
  for(let batch=0;batch<batches;batch++) {
   const code=source+`\n@compute @workgroup_size(1) fn rootProbe(@builtin(global_invocation_id) id:vec3u){
    let index=id.x;if(index>=${count}u){return;}
    samplingPixel=vec2u(index+${batch*count}u,${pixel[0]+pixel[1]*128}u);pixelSampleIndex=17u;samplingBounce=0u;hashedCounter=0u;
    rng_initialize(samplingPixel,i32(sampleSeed(17u,rtUniform.sequenceSeed)));
    var ray=initCameraRay((vec2f(${pixel[0]+.5},${128-pixel[1]-.5}))/128.0);
    var si:SurfaceInteraction;var material:OpenPbrResolvedMaterial;var prefix=0u;
    for(var depth=0u;depth<8u;depth++){
     si.triangleIndex=-1;intersectScene(ray,&si,0,true,depth>0u);
     if(!si.hit){outColor[index]=vec4f(0.0);return;}
     getMaterial(&material,si.materialIndex,si.uv,si.uv1,si.instanceIndex,si.vertexColor);
     let view=-ray.d;var n=si.normal;var ndv=dot(n,view);
     if(dot(si.faceNormal,view)>=0.0&&ndv<0.0){n=si.faceNormal;ndv=dot(n,view);}
     material.inside=ndv<=0.0&&!material.thinWalled;material.relativeIor=select(material.specularIor,1.0/material.specularIor,ndv>0.0);
     if(!isCausticSpecular(material)){prefix=depth;break;}
     let direction=refract(ray.d,select(-n,n,ndv>=0.0),material.relativeIor);
     if(dot(direction,direction)<0.5){outColor[index]=vec4f(0.0);return;}
     initRay(&ray,si.position+EPS*direction,direction);
    }
    samplingBounce=prefix;si.wavelength=0.0;si.mediumExtinction=vec3f(0.0);
    let view=-ray.d;let normal=select(-si.normal,si.normal,dot(si.normal,view)>=0.0);
    let prepared=openpbr_prepare(si.tangent,material,view,normal);
    var ls:LightSampleRec;ls.sourceType=1u;ls.sourceIndex=0u;ls.isDelta=false;ls.normal=vec3f(0.0,-1.0,0.0);
    let light=vec3f(${y.join(',')});ls.direction=normalize(light-si.position);ls.dist=distance(light,si.position);ls.emission=vec3f(1.0);ls.pdf=1.0;
    var root=vec3f(INF);let value=mneeSolve(si,prepared,ls,1u,&root);
    let valid=all(root!=vec3f(INF));var reason=0u;for(var k=1u;k<=10u;k++){if(mneeCounters[k]>0u){reason=k;}}
    var kind=0.0;
    if(valid){var hit:SurfaceInteraction;hit.triangleIndex=-1;var connection:Ray;let direction=normalize(root-si.position);initRay(&connection,si.position+EPS*direction,direction);intersectScene(connection,&hit,0,true,true);kind=select(1.0,2.0,dot(si.position-root,hit.faceNormal)*dot(light-root,hit.faceNormal)>0.0);}
    outColor[index]=vec4f(select(vec3f(0.0),root,valid),kind);
    outNormal[index]=vec4f(value,f32(reason));outAlbedo[index]=vec4f(si.position,f32(prefix));
   }`;
   const module=device.createShaderModule({code}),pipeline=await device.createComputePipelineAsync({layout,compute:{module,entryPoint:'rootProbe'}});
   const encoder=device.createCommandEncoder();const compute=encoder.beginComputePass();compute.setPipeline(pipeline);groups.forEach((group,i)=>compute.setBindGroup(i,group));compute.dispatchWorkgroups(count);compute.end();
   [targets.color,targets.normal,targets.albedo].forEach((buffer:GPUBuffer,i:number)=>encoder.copyBufferToBuffer(buffer,0,readbacks[i],0,size));device.queue.submit([encoder.finish()]);
   await Promise.all(readbacks.map(buffer=>buffer.mapAsync(GPUMapMode.READ)));
   const [roots,values,receivers]=readbacks.map(buffer=>new Float32Array(buffer.getMappedRange()));receiver=Array.from(receivers.slice(0,4));
   for(let i=0;i<count;i++){const reason=values[i*4+3];if(Number.isInteger(reason)&&reason>=0&&reason<15)failures[reason]++;if(roots[i*4+3]>0)accepted.push({reflection:roots[i*4+3]>1,position:Array.from(roots.slice(i*4,i*4+3)),weight:(values[i*4]+values[i*4+1]+values[i*4+2])/3});}
   readbacks.forEach(buffer=>buffer.unmap());checkpoints.push(accepted.length);
  }
  function cluster(tolerance:number,records=accepted){const roots:any[]=[];for(const record of records){let root=roots.find(r=>r.reflection===record.reflection&&Math.hypot(...r.position.map((v:number,i:number)=>v-record.position[i]))<tolerance);if(!root){root={position:record.position,reflection:record.reflection,hits:0,weight:0};roots.push(root);}root.hits++;root.weight+=record.weight;}return roots.map(root=>{const p=root.hits/(batches*count),weight=root.weight/root.hits;return {...root,weight,basinProbability:p,sms64Coverage:1-Math.pow(1-p,64)};}).sort((a,b)=>b.weight-a.weight);}
  const roots=cluster(.001),totalWeight=roots.reduce((sum,r)=>sum+r.weight,0);
  results.push({pixel,receiver,candidates:batches*count,accepted:accepted.length,failures,roots,rootsAt1e4:cluster(.0001).length,discoveryHistory:checkpoints.map((n,i)=>({candidates:(i+1)*count,roots:cluster(.001,accepted.slice(0,n)).length})),estimatedSms64WeightFraction:roots.reduce((sum,r)=>sum+r.weight*r.sms64Coverage,0)/totalWeight,totalUnitEmitterWeight:totalWeight});
 }
 readbacks.forEach(buffer=>buffer.destroy());
 return {solver:'production mneeSolve; one independent area seed per enumeration trial; render Newton start count stays four',camera:'top-first image pixel center, Y flipped for GPU camera UV; deterministic transmission prefix',emitter:y,tolerance:.001,iterations:10,damping:!!mneeDiagnostics.mneeDamping,results};
}
