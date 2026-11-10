import {spawnSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync,readdirSync,rmSync} from 'node:fs';
import {resolve,relative,join} from 'node:path';
import {gzipSync} from 'node:zlib';
export function buildWebviewUI(root,out,env=process.env){
 const result=spawnSync(process.execPath,['node_modules/vite/bin/vite.js','build','--mode','native','--config','viewer/vite.config.ts'],{cwd:root,env,stdio:'inherit'});
 if(result.error||result.status!==0)throw result.error??Error('Native UI build failed');
 const assets=join(out,'ui');rmSync(assets,{recursive:true,force:true});mkdirSync(assets,{recursive:true});const source=join(root,'dist-viewer-native');let rawBytes=0,gzipBytes=0;
 function pack(dir){for(const entry of readdirSync(dir,{withFileTypes:true})){const path=join(dir,entry.name);if(entry.isDirectory()){pack(path);continue;}const raw=readFileSync(path),gzip=gzipSync(raw,{level:9}),destination=join(assets,relative(source,path)+'.gz');mkdirSync(resolve(destination,'..'),{recursive:true});writeFileSync(destination,gzip);rawBytes+=raw.length;gzipBytes+=gzip.length;}}
 pack(source);writeFileSync(join(out,'frontend-size.json'),JSON.stringify({rawBytes,gzipBytes},null,2)+'\n');return assets;
}
