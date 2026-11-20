// The OIDN snapshots in the post ring hold floating-point sRGB codes (0–255).
// Read only the original snapshots so that one impulsive frame cannot propagate recursively.
const postBindings = /* wgsl */ `
struct Params { size: vec2u, slot: u32, capacity: u32, past: i32, future: i32 }
struct Camera { vp: mat4x4f, lens: vec4f }
@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var surfaces: texture_2d_array<f32>;
@group(0) @binding(2) var ids: texture_2d_array<u32>;
@group(0) @binding(3) var colors: texture_2d_array<f32>;
@group(0) @binding(4) var blurred: texture_2d_array<f32>;
@group(0) @binding(5) var<storage,read> cameras: array<Camera>;
@group(0) @binding(6) var<storage,read_write> output: array<vec4f>;

fn guide(x: vec2i, slot: u32, field: i32) -> vec4f {
  return textureLoad(surfaces, x, 3*i32(slot)+field, 0);
}
fn luminance(rgb: vec3f) -> f32 { return dot(rgb, vec3f(.2126,.7152,.0722)); }

`;

const startPostWGSL = /* wgsl */ `
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) g: vec3u) {
  if (any(g.xy>=p.size)) { return; }
  let x=vec2i(g.xy);
  let index=g.y*p.size.x+g.x;
  let pos=guide(x,p.slot,0);
  let depth=guide(x,p.slot,1);
  let normal=guide(x,p.slot,2);
  if (pos.w<=.5 || depth.w<=.5 || normal.w<=.5) { return; }
  let id=textureLoad(ids,x,i32(p.slot),0).xyz;
  let low=textureLoad(blurred,x,i32(p.slot),0).rgb;
`;

// Compile the reference estimator separately for pixel-exact A/B comparisons.
const vetoShader = /* wgsl */ `${postBindings}
fn glintSupport(q: vec2f, slot: u32, currentY: f32, contrast: f32) -> f32 {
  let near=vec2i(floor(q+.5));
  var peak=0.;
  for(var dy=-1;dy<=1;dy++){
    for(var dx=-1;dx<=1;dx++){
      let at=clamp(near+vec2i(dx,dy),vec2i(0),vec2i(p.size)-1);
      let color=luminance(textureLoad(colors,at,i32(slot),0).rgb);
      let low=luminance(textureLoad(blurred,at,i32(slot),0).rgb);
      let strength=smoothstep(.45,.8,(color-low)/max(contrast,1.));
      peak=max(peak,strength*smoothstep(-8.,0.,color-currentY));
    }
  }
  return peak;
}

${startPostWGSL}
  let current=output[index];
  let currentY=luminance(current.rgb);
  let contrast=max(0.,currentY-luminance(low));
  // Anchor the half-precision world position to its known current pixel.
  let currentClip=cameras[p.slot].vp*vec4f(pos.xyz,1.);
  let projected=(currentClip.xy/currentClip.w*vec2f(.5,-.5)+.5)*vec2f(p.size)-.5;
  let phaseError=vec2f(x)-projected;
  var supported=0.;
  var witnesses=0.;
  var nearMax=-1.;
  var nearCount=0u;
  var sum=vec3f(0);
  var mass=0.0;
  var secondMoment=0.0;
  var maxY=-1.;
  var maxContribution=vec3f(0.);
  var maxWeight=0.;
  var usable=0u;

  for (var dt=-p.past; dt<=p.future; dt++) {
    if (dt==0) { continue; }
    let slot=u32((i32(p.slot)+dt+i32(p.capacity))%i32(p.capacity));
    let m=cameras[slot].vp;
    let clip=((pos.x*m[0]+pos.y*m[1])+pos.z*m[2])+m[3];
    if (clip.w<=0) { continue; }
    let q=(clip.xy/clip.w*vec2f(.5,-.5)+.5)*vec2f(p.size)-.5+phaseError;
    if (any(q<vec2f(0)) || any(q>vec2f(p.size-1u))) { continue; }

    // A real specular peak may migrate across a subpixel silhouette. A nearby
    // moving highlight can veto correction, but cannot supply color/history.
    if(abs(dt)==1 && contrast>3.){
      supported=max(supported,glintSupport(q,slot,currentY,contrast));
    }
    let origin=vec2i(floor(q));
    let phase=fract(q);
    var witness=0.;
    var rgb=vec3f(0);
    var lowSum=vec3f(0);
    var coverage=0.0;
    for (var dy=0; dy<2; dy++) {
      for (var dx=0; dx<2; dx++) {
        let y=min(origin+vec2i(dx,dy),vec2i(p.size)-1);
        if (any(textureLoad(ids,y,i32(slot),0).xyz!=id)) { continue; }
        let otherPos=guide(y,slot,0);
        let otherDepth=guide(y,slot,1);
        let otherNormal=guide(y,slot,2);
        let minDot=mix(.72,.95,smoothstep(.45,1.,length(vec2f(y)-q)));
        if (otherPos.w<=.5 || otherDepth.w<=.5 || otherNormal.w<=.5 ||
            abs(otherDepth.x-clip.w)>.015*max(otherDepth.x,clip.w) ||
            dot(normal.xyz,otherNormal.xyz)<minDot) { continue; }
        let weight=select(1-phase.x,phase.x,dx==1)*select(1-phase.y,phase.y,dy==1);
        coverage+=weight;
        let color=textureLoad(colors,y,i32(slot),0).rgb;
        let localLow=textureLoad(blurred,y,i32(slot),0).rgb;
        rgb+=weight*color;
        lowSum+=weight*localLow;
        if(weight>.16 && luminance(color)>=currentY-3. &&
            luminance(color-localLow)>=max(6.,.75*contrast)){witness=1.;}
      }
    }
    if (coverage<.2) { continue; }
    let neighbor=rgb/coverage;
    let difference=dot(abs(lowSum/coverage-low),vec3f(1./3.));
    witnesses+=witness*select(.25,1.,abs(dt)<=1);
    if(abs(dt)==1){
      nearCount++;
      nearMax=max(nearMax,luminance(neighbor));
    }
    let weight=coverage*exp(-pow(f32(abs(dt))/3.,2.))/(1.+pow(difference/18.,2.));
    if(weight>.08){usable++;}
    if(luminance(neighbor)>maxY){
      maxY=luminance(neighbor);
      maxContribution=weight*neighbor;
      maxWeight=weight;
    }
    sum+=weight*neighbor;
    mass+=weight;
    secondMoment+=weight*luminance(neighbor)*luminance(neighbor);
  }
  if (mass<=0.0) { return; }

  var mean=sum/mass;
  if(usable>=4u && witnesses<.5 && mass-maxWeight>1.){
    mean=mix(mean,(sum-maxContribution)/(mass-maxWeight),.65);
  }
  let residual=luminance(current.rgb)-luminance(mean);
  let spread=sqrt(max(0.,secondMoment/mass-pow(luminance(sum/mass),2.)));
  // Correct a bright local peak only to the extent that its positive residual
  // exceeds the temporal spread. A stable edge can have large spatial contrast.
  let excess=max(0.,residual-max(2.,.9*spread));
  let local=luminance(current.rgb)-luminance(low);
  let isolated=nearCount==select(1u,2u,p.future>0 && p.past>0) && currentY-nearMax>10.;
  let reliability=select(1.,.45,isolated);
  let strength=(1.-smoothstep(.5,2.,witnesses*reliability))*mass/(.30+mass)*clamp(excess/max(residual,.01),0.,1.)*
    smoothstep(0.,7.,local);
  let allowed=mix(strength,min(strength,.6/max(abs(residual),1.)),supported);
  output[index]=vec4f(mix(current.rgb,mean,allowed),current.a);
}
`;

export async function createSparklePost(device:GPUDevice) {
  const module=device.createShaderModule({label:'Direct window impulse correction',code:vetoShader});
  const errors=(await module.getCompilationInfo()).messages.filter(message=>message.type==='error');
  if (errors.length) throw Error(errors.map(message=>message.message).join('\n'));
  const pipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:'main'}});
  const params=device.createBuffer({size:32,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});

  return {
    dispose() { params.destroy(); },
    filter(post:any,frame:number,neighbors:number[]) {
      const past=frame-Math.min(frame,...neighbors);
      const future=Math.max(frame,...neighbors)-frame;
      device.queue.writeBuffer(params,0,new Uint32Array([post.width,post.height,post.slot(frame),post.capacity,past,future]));
      const resources=[params,post.surface,post.id,post.display,post.blurred,post.meta,post.output];
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
