// Own the MuTracer SDK's dynamic-library identity after Cargo links dependencies.
// oidn-webgpu-native 0.1.1 propagated its SONAME/install_name; keep the SDK
// identity explicit even though 0.2.0 scopes those flags to its own cdylib.
import {spawnSync} from 'node:child_process';
import {copyFileSync, existsSync} from 'node:fs';
import {resolve} from 'node:path';
export function finalizeHostLibrary(target) {
  const mac=process.platform==='darwin', windows=process.platform==='win32';
  const directory=resolve(target,'release');
  // Cargo keeps the Rust crate name for rlib/cdylib/staticlib outputs. Publish
  // C aliases without moving Cargo's tracked artifacts or changing Rust imports.
  const name=windows?'mutracer.dll':'libmutracer.'+(mac?'dylib':'so');
  const library=resolve(directory,name);
  copyFileSync(resolve(directory,windows?'mutracer_native.dll':`libmutracer_native.${mac?'dylib':'so'}`),library);
  copyFileSync(resolve(directory,windows?'mutracer_native.lib':'libmutracer_native.a'),
    resolve(directory,windows?'mutracer.lib':'libmutracer.a'));
  if(windows) {
    // Cargo's import library embeds mutracer_native.dll. Keep that development
    // DLL beside it; the distributable SDK relinks its own mutracer.dll import lib.
    for(const [source,destination] of [['mutracer_native.dll.lib','mutracer.dll.lib'],['mutracer_native.pdb','mutracer.pdb']])
      if(existsSync(resolve(directory,source)))copyFileSync(resolve(directory,source),resolve(directory,destination));
    return;
  }
  const run=(command,args)=>{
    const result=spawnSync(command,args,{encoding:'utf8'});
    if(result.error||result.status!==0)throw result.error??Error(`${command}: ${result.stderr}`);
    return result.stdout;
  };
  if(mac) {
    run('/usr/bin/install_name_tool',['-id',`@rpath/${name}`,library]);
    // Editing Mach-O load commands invalidates its linker-generated signature.
    run('/usr/bin/codesign',['--force','--sign','-',library]);
    if(run('/usr/bin/otool',['-D',library]).trim().split('\n').at(-1)!==`@rpath/${name}`)
      throw Error('MuTracer SDK dynamic library identity was not preserved');
  }else {
    run('patchelf',['--set-soname',name,library]);
    if(run('patchelf',['--print-soname',library]).trim()!==name)
      throw Error('MuTracer SDK ELF SONAME was not preserved');
  }
}
