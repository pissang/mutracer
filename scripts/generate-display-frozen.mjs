// Deterministic fixed HDR/guide input matching the native OIDN firefly regression.
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
const output=resolve(process.argv[2]??'.cache/oidn-frozen');mkdirSync(output,{recursive:true});
const width=827,height=767,center=[644,463];
const hdr=new Float32Array(width*height*4),albedo=new Float32Array(hdr.length),normal=new Float32Array(hdr.length);
for(let y=0;y<height;y++)for(let x=0;x<width;x++){
 const i=(y*width+x)*4,noise=((x*17+y*31)%13)*.0005;
 hdr.set([.1+noise,.08+noise,.06+noise,1],i);albedo.set([.4,.3,.2,1],i);normal.set([0,0,1,1],i);
}
hdr.set([1.26e21,1.05e21,8.26e20],(center[1]*width+center[0])*4);
for(const [name,data] of Object.entries({hdr,albedo,normal}))writeFileSync(resolve(output,name+'.f32'),Buffer.from(data.buffer));
writeFileSync(resolve(output,'fixture.json'),JSON.stringify({width,height,center,source:'native/host/src/api/display_oidn_tests.rs deterministic synthetic fixture'},null,2));
console.log(output);
