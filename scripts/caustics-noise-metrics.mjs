import {cornellBlotchMasks,cornellRegions,denoisedBlotchStatistics,blotchStatistics,statistics} from './caustics-compare.mjs';
import {displayLinear} from './caustics-study-color.mjs';

export function noiseMasks(width,height) {
 const masks=cornellBlotchMasks(width,height,{verticalFov:true});
 for(const name of ['underwaterBackWall','underwaterFloor']) {
  const [a,b,c,d]=cornellRegions[name],indices=[];
  for(let y=Math.round(b*height/256);y<Math.round(d*height/256);y++)
   for(let x=Math.round(width/2+(a-128)*height/256);x<Math.round(width/2+(c-128)*height/256);x++)indices.push(y*width+x);
  masks[name]=indices;
 }
 return masks;
}
const luminance=(im,i)=>(im.data[4*i]+im.data[4*i+1]+im.data[4*i+2])/3;
export function noiseRMSE(image,reference,indices) {
 if(image.width!==reference.width||image.height!==reference.height)throw Error('Noise reference must have exactly the capture resolution');
 const squared=indices.map(i=>(luminance(image,i)-luminance(reference,i))**2);
 return Math.sqrt(statistics(squared).trimmedMean)/statistics(indices.map(i=>luminance(reference,i))).trimmedMean;
}
// OIDN readPixels is in linear display space. Transform the unfiltered HDR
// reference once; never compare its radiance values directly to OIDN output.
export function noiseMetrics(raw,oidn,hdrReference,masks=noiseMasks(raw.width,raw.height)) {
 if([raw,oidn].some(im=>im.width!==hdrReference.width||im.height!==hdrReference.height))throw Error('Noise reference must have exactly the capture resolution');
 const display=displayLinear(raw),reference=displayLinear(hdrReference),rows=[];
 for(const [region,indices]of Object.entries(masks)) {
  const {before,after,correlatedCloudRelativeRMS}=denoisedBlotchStatistics(display,oidn,reference,indices,1.5*raw.height/544);
  const hdr=blotchStatistics(raw,hdrReference,indices,1.5*raw.height/544);
  rows.push({region,pixels:indices.length,rhoRaw:before.autocorrelation[1].value,
   rawD:before.cloudBandRelativeRMS,rawB:before.cloudBandRelativeRMS*Math.sqrt(Math.max(0,before.autocorrelation[1].value)),
   oidnD:after.cloudBandRelativeRMS,oidnB:correlatedCloudRelativeRMS,
   rawRMSE:noiseRMSE(display,reference,indices),oidnRMSE:noiseRMSE(oidn,reference,indices),
   hdrRMSE:noiseRMSE(raw,hdrReference,indices),hdrRho:hdr.autocorrelation[1].value,hdrRelativeBias:hdr.relativeBias});
 }
 return {display,reference,rows};
}
