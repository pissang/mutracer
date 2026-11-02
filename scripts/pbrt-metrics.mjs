/** Mark ID discontinuities, then dilate by one pixel. Single-sample IDs cannot
 * assign antialiased coverage reliably to either side of these boundaries. */
export function idBoundaryMask(ids, width, height) {
  const boundary = new Uint8Array(width*height), mask = new Uint8Array(width*height);
  for(let y=0;y<height;y++) for(let x=0;x<width;x++) {
    const i=y*width+x;
    for(const [dx,dy] of [[1,0],[0,1]]) {
      if(x+dx>=width || y+dy>=height) continue;
      const j=(y+dy)*width+x+dx;
      if([0,1,2].some(c=>ids[i*4+c]!==ids[j*4+c])) boundary[i]=boundary[j]=1;
    }
  }
  for(let y=0;y<height;y++) for(let x=0;x<width;x++) if(boundary[y*width+x]) {
    for(let dy=-1;dy<=1;dy++) for(let dx=-1;dx<=1;dx++) {
      if(x+dx>=0 && x+dx<width && y+dy>=0 && y+dy<height) mask[(y+dy)*width+x+dx]=1;
    }
  }
  return mask;
}
export function comparePixels({mu,reference,ids,noiseA,noiseB,width,height,approximateMaterialIds=[],sceneComparable=true}) {
  const excluded = new Set(approximateMaterialIds), regions = [], boundary = idBoundaryMask(ids,width,height);
  const isApproximate = id => !sceneComparable || excluded.has(id);
  const measure = (name,x0,y0,x1,y1,approximate,materialId,excludeBoundary=false) => {
    let count=0,abs=0,square=0,signal=0,noiseSquare=0;
    const sumA=[0,0,0],sumB=[0,0,0],noiseVariance=[0,0,0];
    for(let y=y0;y<y1;y++) for(let x=x0;x<x1;x++) {
      const pixel=y*width+x,offset=pixel*4;
      if(excludeBoundary && boundary[pixel] || isApproximate(ids[offset+2])!==approximate || materialId!==undefined && ids[offset+2]!==materialId) continue;
      count++;
      for(let c=0;c<3;c++) {
        const a=mu[offset+c],b=reference[offset+c],d=a-b;
        sumA[c]+=a;sumB[c]+=b;abs+=Math.abs(d);square+=d*d;signal+=b*b;
        if(noiseA) {
          const variance=((a-noiseA[offset+c])**2+(b-noiseB[offset+c])**2)/2;
          noiseVariance[c]+=variance;noiseSquare+=variance;
        }
      }
    }
    if(!count) return;
    const bias=sumA.map((v,c)=>(v-sumB[c])/count);
    // A difference of two replicas estimates twice each estimator's variance.
    // Sum pixel variances before sqrt; a squared region-sum difference is only
    // one unstable observation, not the variance of the region's mean.
    const se=noiseA?noiseVariance.map(v=>Math.sqrt(v)/count):undefined;
    const z=se?.map((v,c)=>Math.abs(bias[c])/Math.max(1e-12,v));
    regions.push({name,approximate,pixels:count,boundaryExcluded:excludeBoundary,
      meanMu:sumA.map(v=>v/count),meanReference:sumB.map(v=>v/count),
      relativeMeanError:sumA.map((v,c)=>(v-sumB[c])/Math.max(1e-10,sumB[c])),
      relativeRMSE:Math.sqrt(square/Math.max(1e-20,signal)),
      noiseRelativeRMSE:noiseA?Math.sqrt(noiseSquare/Math.max(1e-20,signal)):undefined,
      noiseStandardError:se,meanBias:bias,meanBiasZScore:z,mae:abs/(count*3)});
  };
  measure('comparable',0,0,width,height,false);measure('approximate',0,0,width,height,true);
  for(let y=0;y<4;y++) for(let x=0;x<4;x++) measure(`tile-${x}-${y}`,Math.floor(x*width/4),Math.floor(y*height/4),Math.floor((x+1)*width/4),Math.floor((y+1)*height/4),false,undefined,true);
  for(const id of new Set(Array.from(ids).filter((_,i)=>i%4===2))) measure(`material-${id}`,0,0,width,height,isApproximate(id),id,true);
  const frame=regions.find(r=>r.name==='comparable');
  const frameErrors=noiseA && frame && frame.relativeRMSE>frame.noiseRelativeRMSE*(1+6*Math.sqrt(2/(frame.pixels*3)))?['comparable']:[];
  const regionErrors=noiseA?regions.filter(r=>r.boundaryExcluded && !r.approximate && r.meanBiasZScore.some(z=>z>6)).map(r=>r.name):[];
  const status=errors=>!sceneComparable?'not-comparable':!noiseA?'unassessed-noise':errors.length?'mismatch':'within-estimated-noise';
  return {regions,comparisonErrors:[...frameErrors,...regionErrors],frameStatus:status(frameErrors),regionStatus:status(regionErrors),excludedBoundaryPixels:boundary.reduce((a,b)=>a+b,0)};
}
