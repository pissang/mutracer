import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,expect,it} from 'vitest';
import {assertNoResearchArtifacts,assertNoProductionResearchImports,isResearchSource} from '../../scripts/check-research-artifacts.mjs';
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

it('excludes research sources with either path separator without excluding neighboring directories',()=>{
 const dir=mkdtempSync(join(tmpdir(),'mutracer-release-'));dirs.push(dir);
 for(const [name,expected] of [
  ['src/research/mnee/index.ts',true],
  ['src/research-copy/index.ts',false],
  ['src/renderer/researchTransport.ts',false]
 ] as const){
  const source=join(dir,name);
  expect(isResearchSource(dir,source.replaceAll('\\','/'))).toBe(expected);
  expect(isResearchSource(dir,source.replaceAll('/','\\'))).toBe(expected);
 }
});

it('rejects research imports in the production graph while allowing transport bookkeeping',()=>{
 const dir=mkdtempSync(join(tmpdir(),'mutracer-release-'));dirs.push(dir);
 for(const name of ['src/research/mnee','src/renderer','examples'])mkdirSync(join(dir,name),{recursive:true});
 writeFileSync(join(dir,'tsconfig.json'),JSON.stringify({compilerOptions:{noLib:true},include:['src']}));
 writeFileSync(join(dir,'src/research/mnee/index.ts'),'export const value=1;');
 writeFileSync(join(dir,'src/renderer/researchTransport.ts'),'export const value=1;');
 const entry=join(dir,'src/main.ts');
 writeFileSync(entry,"export {value} from './renderer/researchTransport';");
 expect(()=>assertNoProductionResearchImports(dir)).not.toThrow();
 writeFileSync(entry,"export {value} from './research/mnee/index';");
 expect(()=>assertNoProductionResearchImports(dir)).toThrow('Production imports research modules');
});
