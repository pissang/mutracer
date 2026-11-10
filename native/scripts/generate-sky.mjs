import {build} from 'esbuild';
import {readFileSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const result=await build({entryPoints:[fileURLToPath(new URL('../../src/renderer/wgsl/proceduralSky.compute.ts',import.meta.url))],bundle:true,write:false,format:'esm',platform:'node'});
const {proceduralSkyWGSL}=await import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].text).toString('base64'));
const target=new URL('../webview-viewer/src/sky.wgsl',import.meta.url);
if(process.argv.includes('--check')) {
  if(readFileSync(target,'utf8')!==proceduralSkyWGSL)throw new Error('Regenerate native sky shader');
} else writeFileSync(target,proceduralSkyWGSL);
