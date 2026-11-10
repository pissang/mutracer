// Build the independent wry prototype, with compressed UI assets in the executable.
import {spawnSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync,readdirSync,rmSync} from 'node:fs';
import {resolve,relative,join} from 'node:path';
import {gzipSync} from 'node:zlib';
import {prepareViewerCore,viewerRoot} from './viewer-core-build.mjs';
import {executable} from './platform.mjs';
const out=resolve(process.env.MUTRACER_NATIVE_OUTPUT??'.native-build/webview-viewer');
const target=resolve(process.env.CARGO_TARGET_DIR??join(out,'cargo-target'));
const {env,run}=await prepareViewerCore(out,target);
const frontend=spawnSync(process.execPath,['node_modules/vite/bin/vite.js','build','--mode','native','--config','viewer/vite.config.ts'],
  {cwd:viewerRoot,env,stdio:'inherit'});
if(frontend.status!==0)throw new Error('Native frontend build failed');
const assets=join(out,'ui'); rmSync(assets,{recursive:true,force:true}); mkdirSync(assets,{recursive:true});
const source=join(viewerRoot,'dist-viewer-native');
let rawBytes=0,gzipBytes=0;
function pack(dir){for(const entry of readdirSync(dir,{withFileTypes:true})){
  const path=join(dir,entry.name);
  if(entry.isDirectory()){pack(path);continue;}
  const raw=readFileSync(path),gzip=gzipSync(raw,{level:9});
  const destination=join(assets,relative(source,path)+'.gz');
  mkdirSync(resolve(destination,'..'),{recursive:true}); writeFileSync(destination,gzip);
  rawBytes+=raw.length;gzipBytes+=gzip.length;
}}
pack(source); writeFileSync(join(out,'frontend-size.json'),JSON.stringify({rawBytes,gzipBytes},null,2)+'\n');
// prepareViewerCore returns a closed runner with the native build environment.
const build=spawnSync('cargo',['build','--release','--locked','--manifest-path','native/webview-viewer/Cargo.toml'],
  {cwd:viewerRoot,env:{...env,MUTRACER_WEBVIEW_ASSETS:assets},stdio:'inherit'});
if(build.status!==0)throw new Error('WebView host build failed');
const binary=join(target,'release',executable('mutracer-webview-viewer'));
console.log(`WebView prototype: ${binary}`);
const args=process.argv.slice(2);
if(!args.includes('--build-only'))run(binary,args);
