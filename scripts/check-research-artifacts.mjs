import {existsSync,readFileSync,readdirSync,statSync} from 'node:fs';
import {resolve,relative,extname,dirname,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';
const project=resolve(dirname(fileURLToPath(import.meta.url)),'..');
// R1 partition constants and receiver markers are shared transport bookkeeping.
// These names identify the solver, its seeds, textures and probe instrumentation.
export const researchIdentifiers=/\b(?:MneeFrame|mneeSolve|mneeContribution|mneeFail|sampleMneeLight|mneeCounters|mneeTrace|mneeLightData|mneeSeedCount|mneeDebugGroup|smsRoulette|CausticSeedCache|CAUSTIC_SEED_COUNT|CAUSTIC_SEED_OFFSET|captureRoots|rootPass)\b/;
function files(root){return statSync(root).isDirectory()?readdirSync(root).sort().flatMap(name=>files(resolve(root,name))):[root];}
export function assertNoResearchArtifacts(root){
 const violations=[];
 for(const file of files(resolve(root))){
  const name=relative(resolve(root),file).replaceAll('\\','/');
  if(/(?:^|\/)research\//.test(name)||/(?:^|\/)mnee\.(?:wgsl|glsl)/.test(name))violations.push(`${name}: research file`);
  if(!['.js','.ts','.map','.json','.html','.wgsl','.glsl','.a','.dylib','.dll','.exe'].includes(extname(file)))continue;
  const source=readFileSync(file,'utf8'),match=source.match(researchIdentifiers);
  if(match)violations.push(`${name}: ${match[0]}`);
  if(/(?:src|lib)[/\\]research[/\\]/.test(source))violations.push(`${name}: research source path`);
 }
 if(violations.length)throw Error(`Research code in ${root}:\n${violations.join('\n')}`);
}
export function assertNoProductionResearchImports(root=project){
 const config=ts.readConfigFile(resolve(root,'tsconfig.json'),ts.sys.readFile);
 const parsed=ts.parseJsonConfigFileContent(config.config,ts.sys,root);
 const entries=['src/main.ts','src/oidn.ts','native/src/render-core.ts','viewer/src/main.tsx',
  ...files(resolve(root,'examples')).filter(p=>p.endsWith('.ts')).map(p=>relative(root,p))]
  .map(p=>resolve(root,p)).filter(existsSync);
 const program=ts.createProgram(entries,{...parsed.options,noEmit:true});
 const researchRoot=resolve(root,'src/research')+sep;
 const unexpected=program.getSourceFiles().filter(file=>file.fileName.startsWith(researchRoot));
 if(unexpected.length)throw Error(`Production imports research modules:\n${unexpected.map(file=>relative(root,file.fileName)).join('\n')}`);
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 assertNoProductionResearchImports();
 const targets=process.argv.slice(2);
 for(const target of targets.length?targets:['lib','dist','dist-site','dist-viewer'])if(existsSync(target)){assertNoResearchArtifacts(target);console.log(`No research code: ${target}`);}
}
