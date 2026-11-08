import {build} from 'esbuild';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const result=await build({entryPoints:[resolve(root,'native/validation/material-graph-matrix.ts')],bundle:true,write:false,platform:'node',format:'esm'});
await import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].contents).toString('base64'));
