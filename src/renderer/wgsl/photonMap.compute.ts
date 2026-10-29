export const PHOTON_BYTES = 20;
export const PHOTON_GRID_SIZE = 262144;
export const PHOTON_SCAN_BLOCK = 256;
/** Default photon-map batch: pixel count / 4, capped at 2^18. */
export function defaultPhotonMapPhotons(width: number, height: number) {
  return Math.min(2 ** 18, Math.max(1, Math.round((width * height) / 4)));
}
/** Power-of-two hash capacity, bounded independently of large photon batches. */
export function photonBucketCount(photons: number) {
  return Math.min(PHOTON_GRID_SIZE, 2 ** Math.ceil(Math.log2(Math.max(256, photons * 2))));
}
/** Shared texture address contract; payload is stored once, indices twice. */
export function photonLayout(count: number) {
  const buckets = photonBucketCount(count);
  const coarseHeaders = 8;
  const fineHeaders = coarseHeaders + buckets * 2;
  const coarseIndices = fineHeaders + buckets * 2;
  const fineIndices = coarseIndices + count;
  const directions = fineIndices + count;
  return {buckets, coarseHeaders, fineHeaders, coarseIndices, fineIndices, directions, texels: directions + count};
}
/** Batch-local hash buckets: count, two-level parallel prefix sum, then parallel scatter. */
export const photonGridCompute = /* wgsl */ `
  struct Bucket {
    count: atomic<u32>,
    offset: u32,
    cursor: atomic<u32>,
    padding: u32,
  }
  struct Parameters {
    radius: f32,
    count: u32,
    screenPixels: f32,
    skipQuery: f32,
    buckets: u32,
    fineRadius: f32,
    padding1: u32,
    padding2: u32,
  }
  @group(0)@binding(0)var photons:texture_2d<u32>;
  @group(0)@binding(1)var<storage,read_write>grid:array<Bucket>;
  @group(0)@binding(2)var<uniform>parameters:Parameters;
  @group(0)@binding(4)var headers:texture_storage_2d<r32uint,write>;
  fn hashCell(cell:vec3i)->u32 {
    let p=bitcast<vec3u>(cell);
    return ((p.x*73856093u)^(p.y*19349663u)^(p.z*83492791u))&(parameters.buckets-1u);
  }
  fn hashPhoton(p:vec3f,layer:u32)->u32 {
    let radius=select(parameters.radius,parameters.fineRadius,layer==1u);
    let cellSize=select(radius,2.0*radius,layer==1u);
    return hashCell(vec3i(floor(p/cellSize)));
  }
  fn gridStart(layer:u32)->u32 {
    return layer*(parameters.buckets+parameters.buckets/256u);
  }
  fn storeIndex(i:u32,value:u32) {
    let width=textureDimensions(headers).x;
    textureStore(headers,vec2i(vec2u(i%width,i/width)),vec4u(value));
  }
  fn photonRecord(i:u32)->vec4u {
    let width=textureDimensions(photons).x;
    return textureLoad(photons,vec2i(vec2u(i%width,i/width)),0);
  }
  fn photonPosition(i:u32)->vec3f {
    return bitcast<vec3f>(photonRecord(i).xyz);
  }
  @compute @workgroup_size(64)
  fn count(@builtin(global_invocation_id)id:vec3u) {
    if(id.x+id.y*4194240u>=parameters.count) {
      return;
    }
    let index=id.x+id.y*4194240u;
    if(photonRecord(index).w==0u) {
      return;
    }
    for(var layer=0u;layer<2u;layer++) {
      atomicAdd(&grid[gridStart(layer)+hashPhoton(photonPosition(index),layer)].count,1u);
    }
  }
  // Each block scans 256 buckets; the next workgroup scans chunks of block totals.
  var<workgroup> scan:array<u32,256>;
  fn inclusiveScan(local:u32,value:u32)->u32 {
    scan[local]=value;
    workgroupBarrier();
    for(var stride=1u;stride<256u;stride*=2u) {
      var previous=0u;
      if(local>=stride) {
        previous=scan[local-stride];
      }
      workgroupBarrier();
      scan[local]+=previous;
      workgroupBarrier();
    }
    return scan[local];
  }
  @compute @workgroup_size(256)
  fn scanBlocks(@builtin(local_invocation_index)local:u32,@builtin(workgroup_id)group:vec3u) {
    let index=gridStart(group.y)+group.x*256u+local;
    let count=atomicLoad(&grid[index].count);
    let prefix=inclusiveScan(local,count);
    grid[index].offset=prefix-count;
    if(local==255u) {
      atomicStore(&grid[gridStart(group.y)+parameters.buckets+group.x].count,prefix);
    }
  }
  @compute @workgroup_size(256)
  fn scanSums(@builtin(local_invocation_index)local:u32,@builtin(workgroup_id)group:vec3u) {
    let blocks=parameters.buckets/256u;
    let chunk=(blocks+255u)/256u;
    let first=local*chunk;
    let start=gridStart(group.y)+parameters.buckets;
    var count=0u;
    for(var i=first;i<min(first+chunk,blocks);i++) {
      count+=atomicLoad(&grid[start+i].count);
    }
    let prefix=inclusiveScan(local,count);
    var offset=prefix-count;
    for(var i=first;i<min(first+chunk,blocks);i++) {
      grid[start+i].offset=offset;
      offset+=atomicLoad(&grid[start+i].count);
    }
    if(local==255u&&group.y==0u) {
      storeIndex(0u,bitcast<u32>(parameters.radius));
      storeIndex(1u,prefix);
      storeIndex(2u,bitcast<u32>(parameters.screenPixels));
      storeIndex(3u,bitcast<u32>(parameters.skipQuery));
      storeIndex(4u,parameters.count);
      storeIndex(5u,parameters.buckets);
      storeIndex(6u,bitcast<u32>(parameters.fineRadius));
    }
  }
  @compute @workgroup_size(64)
  fn scatter(@builtin(global_invocation_id)id:vec3u) {
    let invocation=id.x+id.y*4194240u;
    for(var layer=0u;layer<2u;layer++) {
      let start=gridStart(layer);
      if(invocation<parameters.buckets) {
        let offset=grid[start+invocation].offset+grid[start+parameters.buckets+invocation/256u].offset;
        storeIndex(8u+layer*parameters.buckets*2u+invocation*2u,offset);
        storeIndex(9u+layer*parameters.buckets*2u+invocation*2u,atomicLoad(&grid[start+invocation].count));
      }
      if(invocation<parameters.count&&photonRecord(invocation).w!=0u) {
        let bucket=hashPhoton(photonPosition(invocation),layer);
        let index=grid[start+bucket].offset+grid[start+parameters.buckets+bucket/256u].offset+atomicAdd(&grid[start+bucket].cursor,1u);
        storeIndex(8u+parameters.buckets*4u+layer*parameters.count+index,invocation);
      }
    }
  }
`;
/** Packed photon payload: position f32 x3, RGBE8 flux, two octahedral directions. */
export const photonPackingWgsl = /* wgsl */ `
  fn photonOctSign(v:vec2f)->vec2f {
    return select(vec2f(-1.0),vec2f(1.0),v>=vec2f(0.0));
  }
  fn photonEncodeOct(n:vec3f)->vec2f {
    let p=n/(abs(n.x)+abs(n.y)+abs(n.z));
    let uv=select(p.xy,(vec2f(1.0)-abs(p.yx))*photonOctSign(p.xy),p.z<0.0);
    return uv*.5+.5;
  }
  fn photonDecodeOct(uv:vec2f)->vec3f {
    let p=uv*2.0-1.0;
    var n=vec3f(p,1.0-abs(p.x)-abs(p.y));
    if(n.z<0.0) {
      n=vec3f((vec2f(1.0)-abs(n.yx))*photonOctSign(n.xy),n.z);
    }
    return normalize(n);
  }
  // An eight-bit exponent avoids RGB9E5's limited range for very dim/bright lights.
  // Flux is stored before dividing by emitted count, preserving tiny large batches.
  fn photonEncodeFlux(value:vec3f)->u32 {
    let peak=max(max(value.x,value.y),value.z);
    if(!(peak>0.0)) {
      return 0u;
    }
    let exponent=clamp(i32(floor(log2(peak)))+1,-126,127);
    let rgb=vec3u(clamp(round(value*exp2(-f32(exponent))*255.0),vec3f(0.0),vec3f(255.0)));
    return rgb.x|(rgb.y<<8u)|(rgb.z<<16u)|(u32(exponent+127)<<24u);
  }
  fn photonDecodeFlux(value:u32)->vec3f {
    if(value==0u) {
      return vec3f(0.0);
    }
    return vec3f(f32(value&255u),f32((value>>8u)&255u),f32((value>>16u)&255u))*exp2(f32(i32(value>>24u)-127))/255.0;
  }
`;
export const photonQueryWgsl = /* wgsl */ `${photonPackingWgsl}
  @group(1)@binding(11)var photonMapData:texture_2d<u32>;
  @group(1)@binding(12)var photonMapGrid:texture_2d<u32>;
  fn photonLoad(i:u32)->vec4u {
    let width=textureDimensions(photonMapData).x;
    return textureLoad(photonMapData,vec2i(vec2u(i%width,i/width)),0);
  }
  fn photonIndexWord(i:u32)->u32 {
    let width=textureDimensions(photonMapGrid).x;
    return textureLoad(photonMapGrid,vec2i(vec2u(i%width,i/width)),0).x;
  }
  fn photonHash(cell:vec3i)->u32 {
    let p=bitcast<vec3u>(cell);
    return ((p.x*73856093u)^(p.y*19349663u)^(p.z*83492791u))&(photonIndexWord(5u)-1u);
  }
  // Approximate a specular prefix by the camera-space depth of its first diffuse
  // receiver. Orthographic footprints do not grow with distance. Grazing surfaces
  // expand the disk conservatively; the progressive world radius remains the cap.
  fn photonPixelFootprint(si:SurfaceInteraction)->f32 {
    let inverse=cameraUniform.viewProjectionInv;
    let a=inverse*vec4f(0.0,0.0,-1.0,1.0);
    let b=inverse*vec4f(2.0/rtUniform.outputSize.x,0.0,-1.0,1.0);
    let origin=a.xyz/a.w;
    let offset=b.xyz/b.w;
    let eye=cameraUniform.viewInv[3].xyz;
    let forward=normalize(cameraUniform.viewInv[2].xyz);
    let depth=abs(dot(si.position-eye,forward));
    let nearDepth=max(abs(dot(origin-eye,forward)),1e-8);
    let perspective=abs(inverse[2].w)>1e-8;
    let footprint=length(offset-origin)*select(1.0,depth/nearDepth,perspective);
    let cosine=abs(dot(si.faceNormal,normalize(si.position-eye)));
    return max(1e-8,footprint/sqrt(max(.0625,cosine)));
  }
  fn photonContribution(si:SurfaceInteraction,prepared:OpenPbrPreparedBsdf,primary:bool,visible:bool)->vec3f {
    if(samplingBounce>CAUSTIC_PHOTON_MAX_DEPTH||isCausticSpecular(prepared.material)||prepared.material.materialType==SHADOW_CATCHER) {
      return vec3f(0.0);
    }
    if(CAUSTIC_LIGHT_TRACING&&primary) {
      return vec3f(0.0);
    }
    let globalRadius=bitcast<f32>(photonIndexWord(0u));
    let screenPixels=bitcast<f32>(photonIndexWord(2u));
    if(!(globalRadius>0.0)||bitcast<f32>(photonIndexWord(3u))==1.0||(bitcast<f32>(photonIndexWord(3u))==2.0&&visible)) {
      return vec3f(0.0);
    }
    var radius=globalRadius;
    if(visible&&screenPixels>0.0) {
      radius=min(radius,photonPixelFootprint(si)*screenPixels);
    }
    let layer=select(0u,1u,visible&&screenPixels>0.0);
    let cellSize=select(globalRadius,2.0*bitcast<f32>(photonIndexWord(6u)),layer==1u);
    let firstCell=vec3i(floor((si.position-vec3f(radius))/cellSize));
    let lastCell=vec3i(floor((si.position+vec3f(radius))/cellSize));
    let buckets=photonIndexWord(5u);
    let headerStart=8u+layer*buckets*2u;
    let indexStart=8u+buckets*4u+layer*photonIndexWord(4u);
    let emitted=f32(photonIndexWord(4u));
    var sum=vec3f(0.0);
    for(var z=firstCell.z;z<=lastCell.z;z++) {
      for(var y=firstCell.y;y<=lastCell.y;y++) {
        for(var x=firstCell.x;x<=lastCell.x;x++) {
          let queryCell=vec3i(x,y,z);
          // Reject cube corners before loading their photon lists. Padding keeps
          // the bound conservative when cell multiplication rounds in f32.
          let cellMin=vec3f(queryCell)*cellSize;
          let padding=max(vec3f(cellSize*1e-5),abs(cellMin)*1e-6);
          let closest=clamp(si.position,cellMin-padding,cellMin+vec3f(cellSize)+padding);
          if(distance(closest,si.position)>=radius) { continue; }
          let bucket=photonHash(queryCell);
          let offset=photonIndexWord(headerStart+bucket*2u);
          let count=photonIndexWord(headerStart+1u+bucket*2u);
          for(var i=offset;i<offset+count;i++) {
            let index=photonIndexWord(indexStart+i);
            let record=photonLoad(index);
            let position=bitcast<vec3f>(record.xyz);
            // Hash collisions and neighboring buckets never count a photon twice.
            if(any(vec3i(floor(position/cellSize))!=queryCell)||distance(position,si.position)>=radius) {
              continue;
            }
            let directions=photonIndexWord(8u+buckets*4u+u32(emitted)*2u+index);
            let normal=photonDecodeOct(vec2f(f32(directions&255u)/255.0,f32((directions>>8u)&127u)/127.0));
            if(dot(normal,si.faceNormal)<0.9) {
              continue;
            }
            if(CAUSTIC_MNEE&&samplingBounce<=CAUSTIC_MNEE_MAX_DEPTH&&(directions&32768u)!=0u&&prepared.material.baseWeight*(1.0-prepared.material.baseMetalness)*(1.0-prepared.material.transmissionWeight)>0.0&&prepared.material.subsurfaceWeight==0.0) {
              continue;
            }
            let incoming=photonDecodeOct(vec2f(f32((directions>>16u)&255u),f32(directions>>24u))/255.0);
            let cosine=abs(dot(si.faceNormal,incoming));
            if(cosine<=0.0) {
              continue;
            }
            var flux=photonDecodeFlux(record.w)/emitted;
            if(SPECTRAL) {
              flux=sampling_spectral_rgb_filter(flux,si.wavelength);
            }
            var pdf:f32;
            let response=openpbr_eval_prepared(prepared,incoming,&pdf);
            sum+=response*flux/cosine;
          }
        }
      }
    }
    return sum/(PI*radius*radius);
  }
`;

/** Evidence-only per-query counters; no extra bindings or public render options. */
export function photonQuerySource(debugGroup = -1) {
  if (debugGroup < 50) return photonQueryWgsl;
  const selected = debugGroup === 50 ? 'visible' : `!visible&&samplingBounce==${debugGroup - 51}u`;
  return 'var<private> photonQueryStats:vec3f;\n' + photonQueryWgsl
    .replace('var sum=vec3f(0.0);', 'var sum=vec3f(0.0);var reads=0u;var passed=0u;')
    .replace('let index=photonIndexWord(indexStart+i);', 'reads++;let index=photonIndexWord(indexStart+i);')
    .replace('let directions=photonIndexWord', 'passed++;let directions=photonIndexWord')
    .replace('return sum/(PI*radius*radius);', `if(${selected}){photonQueryStats=vec3f(f32(reads),f32(passed),1.0);}return sum/(PI*radius*radius);`);
}
