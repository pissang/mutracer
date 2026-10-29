// node scripts/caustics-compare.mjs reference.{exr,f32} candidate.f32 ... --output directory
// Float32 captures require adjacent JSON with width/height. Masks never depend on image values.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {EXRLoader} from 'three/examples/jsm/loaders/EXRLoader.js';
import {FloatType} from 'three';

export function statistics(values,trim=.001,clamp=1) {
 if(!values.length||values.some(v=>!Number.isFinite(v)))throw Error('Empty or non-finite region');
 const sorted=values.toSorted((a,b)=>a-b),n=sorted.length,k=Math.max(1,n-Math.ceil(n*trim));
 const mean=a=>a.reduce((s,v)=>s+v,0)/a.length;
 return {pixels:n,median:(sorted[Math.floor((n-1)/2)]+sorted[Math.ceil((n-1)/2)])/2,
  trimmedMean:mean(sorted.slice(0,k)),clampedMean:mean(sorted.map(v=>Math.min(clamp,v))),rawMean:mean(sorted),maximum:sorted[n-1]};
}
export function loadHdr(path) {
 const b=readFileSync(path);
 if(path.endsWith('.exr')) {
  const im=new EXRLoader().setDataType(FloatType).parse(b.buffer.slice(b.byteOffset,b.byteOffset+b.length));
  const data=new Float32Array(im.data.length);
  for(let y=0;y<im.height;y++)data.set(im.data.subarray((im.height-1-y)*im.width*4,(im.height-y)*im.width*4),y*im.width*4);
  return {width:im.width,height:im.height,data,orientation:'EXRLoader rows flipped to top-first'};
 }
 const {width,height}=JSON.parse(readFileSync(path.replace(/\.f32$/,'.json'),'utf8'));
 if(b.length!==width*height*16)throw Error('HDR dimensions do not match '+path);
 return {width,height,data:new Float32Array(b.buffer.slice(b.byteOffset,b.byteOffset+b.length)),orientation:'readPixels hdr top-first'};
}
export function boxDownsample(image,width,height) {
 const sx=image.width/width,sy=image.height/height;
 if(!Number.isInteger(sx)||!Number.isInteger(sy)||sx<1||sy<1)throw Error('Comparison requires integer box downsampling');
 const data=new Float32Array(width*height*4);
 for(let y=0;y<height;y++)for(let x=0;x<width;x++)for(let j=0;j<sy;j++)for(let i=0;i<sx;i++)for(let c=0;c<4;c++)
  data[(y*width+x)*4+c]+=image.data[((y*sy+j)*image.width+x*sx+i)*4+c]/(sx*sy);
 return {width,height,data};
}
// Area resampling for non-integer sizes. Widescreen images retain the authored
// vertical field of view; square references cover only their central viewport.
export function resampleReference(image,width,height,{verticalFov=false}={}) {
 if(image.width===width&&image.height===height)return image;
 const sx=verticalFov?image.height/height:image.width/width,sy=image.height/height;
 const left=verticalFov?(image.width-width*sx)/2:0;
 const data=new Float32Array(width*height*4);
 for(let y=0;y<height;y++)for(let x=0;x<width;x++) {
  const x0=left+x*sx,x1=x0+sx,y0=y*sy,y1=y0+sy;
  if(x0<0||x1>image.width){data.fill(NaN,(y*width+x)*4,(y*width+x+1)*4);continue;}
  for(let j=Math.floor(y0);j<Math.ceil(y1);j++)for(let i=Math.floor(x0);i<Math.ceil(x1);i++) {
   const weight=(Math.min(x1,i+1)-Math.max(x0,i))*(Math.min(y1,j+1)-Math.max(y0,j))/(sx*sy);
   for(let c=0;c<4;c++)data[(y*width+x)*4+c]+=image.data[(j*image.width+i)*4+c]*weight;
  }
 }
 return {width,height,data};
}

// Coordinates in a 256x256 authored-camera image, half-open. Conservative patches
// avoid box silhouettes, room edges and the light. They are not whole-surface integrals.
export const cornellRegions={underwaterBackWall:[102,100,215,160],underwaterFloor:[100,244,160,250],aboveWaterWall:[100,34,180,45],waterSurface:[100,62,180,72]};
// Perspective rays of tests/gpu/caustics.ts, camera below the horizontal glass.
// Inset the 2.5x2.5 glass footprint to 2x2 to exclude finite-radius edge leakage.
export function receiverMask(width,height) {
 const indices=[],tan=Math.tan(25*Math.PI/180),length=Math.hypot(.75,3),fy=-.75/length,fz=-3/length;
 for(let y=0;y<height;y++)for(let x=0;x<width;x++) {
  const u=(2*(x+.5)/width-1)*tan*width/height,v=(1-2*(y+.5)/height)*tan;
  const dy=fy-fz*v,dz=fz+fy*v,t=-.75/dy;
  if(t>0&&Math.abs(t*u)<1&&Math.abs(3+t*dz)<1)indices.push(y*width+x);
 }
 return indices;
}
export const receiverRegions={causticReceiver:[0,0,128,96]};
export function compare(reference,candidates,{receiver=false,trim=.001,clamp=1,masks:providedMasks,verticalFov=false}={}) {
 const {width,height}=candidates[0].image;
 if(candidates.some(c=>c.image.width!==width||c.image.height!==height))throw Error('Candidate resolutions differ');
 const ref=resampleReference(reference,width,height,{verticalFov}),rects=providedMasks?Object.fromEntries(Object.keys(providedMasks).map(k=>[k,[0,0,width,height]])):receiver?receiverRegions:cornellRegions,base=receiver?[128,96]:[256,256];
 const masks={},rows=[];
 for(const [region,rectangle]of Object.entries(rects)) {
  const rect=rectangle.map((v,i)=>Math.round(verticalFov&&i%2===0?width/2+(v-base[0]/2)*height/base[1]:v*(i%2?height/base[1]:width/base[0]))),indices=[];
  if(providedMasks)for(const index of providedMasks[region])indices.push(index);
  else if(receiver)indices.push(...receiverMask(width,height));
  else for(let y=rect[1];y<rect[3];y++)for(let x=rect[0];x<rect[2];x++)indices.push(y*width+x);
  masks[region]={rectangle:rect,pixels:indices.length,...(receiver?{indices,geometry:{floorY:0,footprintXZ:[-1,1],camera:[0,.75,3],lookAt:[0,0,0],fov:50}}:{})};
  const extract=image=>indices.map(i=>(image.data[i*4]+image.data[i*4+1]+image.data[i*4+2])/3);
  const expected=statistics(extract(ref),trim,clamp);
  for(const {path,image}of candidates) {
   const actual=statistics(extract(image),trim,clamp);
   const relativeError=Object.fromEntries(['median','trimmedMean','clampedMean','rawMean'].map(k=>[k,actual[k]/expected[k]-1]));
   const luminance=(im,i)=>Math.max(0,(im.data[i*4]+im.data[i*4+1]+im.data[i*4+2])/3);
   const logErrors=indices.map(i=>Math.pow(Math.log1p(luminance(image,i))-Math.log1p(luminance(ref,i)),2));
   let gradientError=0,gradientReference=0,edges=0;
   const mask=new Set(indices);
   for(const i of indices)for(const j of [i+1,i+width])if(mask.has(j)&&!(j===i+1&&j%width===0)){
    const a=Math.log1p(luminance(image,j))-Math.log1p(luminance(image,i));
    const b=Math.log1p(luminance(ref,j))-Math.log1p(luminance(ref,i));
    gradientError+=(a-b)*(a-b);gradientReference+=b*b;edges++;
   }
   rows.push({region,path,reference:expected,candidate:actual,relativeError,
    logRMSE:Math.sqrt(logErrors.reduce((a,b)=>a+b,0)/indices.length),
    gradientRMSE:Math.sqrt(gradientError/Math.max(1,edges)),
    relativeGradientError:Math.sqrt(gradientError/Math.max(1e-20,gradientReference))});
  }
 }
 return {width,height,metric:'linear (R+G+B)/3, no exposure scaling; each image trimmed independently',trimBrightFraction:trim,clampThreshold:clamp,
  referenceDownsample:`${reference.width/width}x${reference.height/height} box average after orientation alignment`,maskDefinition:receiver?'pixel-center camera rays intersect floor inside the inset glass footprint':'fixed half-open rectangles in authored camera; conservative patches, not complete surfaces',masks,rows};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 const args=process.argv.slice(2),outIndex=args.indexOf('--output'),output=outIndex>=0?resolve(args.splice(outIndex,2)[1]):null;
 const receiver=args.includes('--receiver');if(receiver)args.splice(args.indexOf('--receiver'),1);
 const [reference,...paths]=args;if(!reference||!paths.length)throw Error('Expected reference candidate(s) --output directory [--receiver]');
 const result=compare(loadHdr(reference),paths.map(path=>({path:resolve(path),image:loadHdr(path)})),{receiver});
 if(output){mkdirSync(output,{recursive:true});writeFileSync(resolve(output,'comparison.json'),JSON.stringify({reference:resolve(reference),...result},null,2)+'\n');
  const colors=['#e53935','#1e88e5','#43a047','#fdd835'];
  writeFileSync(resolve(output,'masks.svg'),`<svg xmlns="http://www.w3.org/2000/svg" width="${result.width}" height="${result.height}" viewBox="0 0 ${result.width} ${result.height}">${Object.entries(result.masks).map(([name,{rectangle:r,indices}],i)=>indices?`<g fill="${colors[i]}" fill-opacity=".4"><title>${name}</title>${indices.map(p=>`<rect x="${p%result.width}" y="${Math.floor(p/result.width)}" width="1" height="1"/>`).join('')}</g>`:`<g><title>${name}</title><rect x="${r[0]}" y="${r[1]}" width="${r[2]-r[0]}" height="${r[3]-r[1]}" fill="${colors[i]}" fill-opacity=".4" stroke="${colors[i]}"/></g>`).join('')}</svg>`);
 }
 console.log(JSON.stringify(result.rows.map(r=>({region:r.region,candidate:basename(r.path),relativeError:r.relativeError})),null,2));
}
