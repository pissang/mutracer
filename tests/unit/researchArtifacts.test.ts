import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,expect,it} from 'vitest';
import {assertNoResearchArtifacts} from '../../scripts/check-research-artifacts.mjs';
const dirs:string[]=[];
afterEach(()=>dirs.splice(0).forEach(dir=>rmSync(dir,{recursive:true,force:true})));
it('rejects solver code and research files, including source maps, without rejecting shared R1 bookkeeping',()=>{
 const dir=mkdtempSync(join(tmpdir(),'mutracer-release-'));dirs.push(dir);
 writeFileSync(join(dir,'main.js'),'const CAUSTIC_MNEE=false; const causticMneeReceiver=false; // displacement prisms');
 expect(()=>assertNoResearchArtifacts(dir)).not.toThrow();
 writeFileSync(join(dir,'main.js.map'),JSON.stringify({sourcesContent:['fn mneeSolve() {}']}));
 expect(()=>assertNoResearchArtifacts(dir)).toThrow('mneeSolve');
 rmSync(join(dir,'main.js.map'));
 mkdirSync(join(dir,'research/mnee'),{recursive:true});writeFileSync(join(dir,'research/mnee/index.js'),'');
 expect(()=>assertNoResearchArtifacts(dir)).toThrow('research file');
});
