import {spawn,spawnSync} from 'node:child_process';
import {delimiter,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {nativeToolchainEnv,viewerPlatform,windows} from './platform.mjs';
import {prepareDxc} from './fetch-dxc.mjs';
import {prepareViewerCore,viewerRoot} from './viewer-core-build.mjs';

export const subsecondVersion='0.7.10';

export function viewerDevOptions(args,environment=process.env,cwd=viewerRoot) {
  const {values,positionals}=parseArgs({args,allowPositionals:true,options:{
    help:{type:'boolean',short:'h'},port:{type:'string'},
  }});
  if(positionals.length>1)throw new Error('Expected at most one .gltf/.glb model path.');
  if(values.port!==undefined&&(!/^\d+$/.test(values.port)||Number(values.port)<1||Number(values.port)>65535))
    throw new Error('--port must be an integer from 1 to 65535.');
  const out=resolve(cwd,environment.MUTRACER_NATIVE_OUTPUT??resolve(viewerRoot,'.native-build/viewer-dev'));
  const target=resolve(cwd,environment.CARGO_TARGET_DIR??resolve(out,'cargo-target'));
  const env={...nativeToolchainEnv(environment),CARGO_TARGET_DIR:target};
  const dx=environment.MUTRACER_DX??'dx';
  const command=dx.includes('/')||dx.includes('\\')?resolve(cwd,dx):dx;
  // dx 0.7 splits --args on whitespace, including quoted filenames. Pass the
  // optional startup path intact through the dev-only initialization instead.
  delete env.MUTRACER_VIEWER_DEV_MODEL;
  if(positionals[0])env.MUTRACER_VIEWER_DEV_MODEL=resolve(cwd,positionals[0]);
  return {help:values.help??false,out,target,env,command,args:[
    'serve','--platform','desktop','--hot-patch','--locked','--features','hot-reload',
    '--interactive','false','--open','true','--always-on-top','false','--addr','127.0.0.1',
    ...(values.port===undefined?[]:['--port',values.port]),
  ]};
}

export function checkDxVersion(command,env) {
  const result=spawnSync(command,['--version'],{env,encoding:'utf8'});
  if(result.error||result.status!==0||!new RegExp(`^dioxus ${subsecondVersion.replaceAll('.','\\.')}(?:\\s|$)`).test(result.stdout.trim())) {
    const detail=result.error?.message||result.stderr?.trim()||result.stdout?.trim();
    throw new Error(`Native viewer hot reload requires dx ${subsecondVersion}. Install with: cargo install dioxus-cli --version ${subsecondVersion} --locked${detail?`\n${detail}`:''}`);
  }
}

async function main() {
  const options=viewerDevOptions(process.argv.slice(2));
  if(options.help) {
    console.log(`Usage: npm run native:viewer:dev -- [--port PORT] [MODEL.gltf|MODEL.glb]

Requires dx ${subsecondVersion} (cargo install dioxus-cli --version ${subsecondVersion} --locked).
MUTRACER_DX selects a dx executable; MUTRACER_NATIVE_OUTPUT and CARGO_TARGET_DIR select build directories.
UI function edits retain the current scene and GPU resources. Restart for state layout, SDK or AOT changes.`);
    return;
  }
  viewerPlatform();
  checkDxVersion(options.command,options.env);
  const {env}=await prepareViewerCore(options.out,options.target,options.env);
  // The development app needs the same DXC runtime as the packaged Windows app.
  if(windows)env.PATH=resolve(prepareDxc(),'bin/x64')+delimiter+env.PATH;
  // Run directly, without a shell, so paths and tool overrides remain literal.
  const child=spawn(options.command,options.args,{cwd:resolve(viewerRoot,'native/viewer'),env,stdio:'inherit'});
  const stop=signal=>child.kill(signal);
  const interrupt=()=>stop('SIGINT'),terminate=()=>stop('SIGTERM');
  process.on('SIGINT',interrupt);
  process.on('SIGTERM',terminate);
  try {
    process.exitCode=await new Promise((done,reject)=>{
      child.once('error',reject);
      child.once('close',(code,signal)=>done(code??(signal==='SIGINT'?130:signal==='SIGTERM'?143:1)));
    });
  } finally {
    process.off('SIGINT',interrupt);
    process.off('SIGTERM',terminate);
  }
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  main().catch(error=>{console.error(error.message);process.exitCode=1;});
}
