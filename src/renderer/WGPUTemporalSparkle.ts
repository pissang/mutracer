import type {TemporalPostGPU} from './WGPUTemporalPost.js';
import {vetoShader} from './temporalSparkleShader.js';
export async function createSparklePost(device:GPUDevice) {
  const module=device.createShaderModule({label:'Direct window impulse correction',code:vetoShader});
  const errors=(await module.getCompilationInfo()).messages.filter(message=>message.type==='error');
  if (errors.length) throw Error(errors.map(message=>message.message).join('\n'));
  const pipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:'main'}});
  const params=device.createBuffer({size:32,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});

  return {
    dispose() { params.destroy(); },
    filter(post:TemporalPostGPU,frame:number,neighbors:number[]) {
      const past=frame-Math.min(frame,...neighbors);
      const future=Math.max(frame,...neighbors)-frame;
      const history = post.history;
      device.queue.writeBuffer(params,0,new Uint32Array([post.width,post.height,post.slot(frame),post.capacity,past,future,post.materialCapacity+1,history.slot(frame)]));
      const resources=[params,history.surface,history.id,post.display,post.blurred,history.meta,post.output,history.motion,post.changedMaterials];
      const group=device.createBindGroup({
        layout:pipeline.getBindGroupLayout(0),
        entries:resources.map((value,binding)=>({
          binding,resource:value instanceof GPUBuffer ? {buffer:value} : value.createView({dimension:'2d-array'})
        }))
      });
      const encoder=device.createCommandEncoder();
      const pass=encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0,group);
      pass.dispatchWorkgroups(Math.ceil(post.width/8),Math.ceil(post.height/8));
      pass.end();
      device.queue.submit([encoder.finish()]);
    }
  };
}
