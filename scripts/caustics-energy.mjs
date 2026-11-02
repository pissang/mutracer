// node scripts/caustics-energy.mjs reference.f32 candidate.f32 [output.json]
// Only the fixed floor patch below the glass is an energy comparison region.
import {writeFileSync} from 'node:fs';
import {compare,loadHdr} from './caustics-compare.mjs';
const [reference,candidate,output]=process.argv.slice(2);
if(!reference||!candidate)throw Error('Expected reference.f32 candidate.f32 [output.json]');
const result=compare(loadHdr(reference),[{path:candidate,image:loadHdr(candidate)}],{receiver:true});
console.log(JSON.stringify(result,null,2));if(output)writeFileSync(output,JSON.stringify(result,null,2)+'\n');
