export const steps=new Set(['compiler-version','windows-msvc-runtime','aot-build','native-build','windows-dll-exit',
 'adapter-info','gpu-availability','host-tests','postprocess-shaders','jnlm-shaders','scene-picking',
 'viewer-tests','build-lib','modules-build','modules-verify','storage-verify','viewer-build','viewer-gpu-scenes',
 'raw-gpu-fixtures','viewer-gpu-surface','c-window','ray-query-contracts','c-hosts','scene-api-c-host',
 'viewer-gpu-package','scene-static','metal-gpu-host']);

export function ciOptions(args){
function option(name){
 const index=args.indexOf(name);
 if(index<0)return undefined;
 if(!args[index+1]||args[index+1].startsWith('--'))throw Error(`${name} requires a value`);
 return args[index+1];
}
function stepSet(name){
 const value=option(name);if(value===undefined)return undefined;
 const selected=new Set(value.split(',').map(v=>v.trim()).filter(Boolean));
 if(!selected.size||[...selected].some(v=>!steps.has(v)))throw Error(`Unknown ${name} steps: ${value}`);
 return selected;
}
const only=stepSet('--only'),skip=stepSet('--skip');
const filter=option('--gpu-tests'),gpuFilter=filter===undefined?undefined:new RegExp(filter);
const batch=args.includes('--batch-gpu-tests');
const subset=!!(only||skip||gpuFilter||batch);
const enabled=name=>(!only||only.has(name))&&!skip?.has(name);
return {only,skip,filter,gpuFilter,batch,subset,enabled};
}
