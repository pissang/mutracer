// Names at the native toolchain/OS boundary; renderer data stays platform-neutral.
import {delimiter,resolve,dirname} from 'node:path';
import {spawnSync} from 'node:child_process';
export const windows = process.platform === 'win32';
// Git Bash's GNU tar treats a Windows drive letter as a remote archive host.
export const nativeTar = windows ? resolve(process.env.SystemRoot??'C:\\Windows','System32/tar.exe') : 'tar';
export const executable = name => name + (windows ? '.exe' : '');
export const archiveName = name => name + (windows ? '.lib' : '.lib.a');
export const cCompiler = process.env.CC ?? (windows ? 'cl.exe' : 'cc');
export const cLinkFlags = windows
  ? ['ws2_32.lib','bcrypt.lib','crypt32.lib','iphlpapi.lib','userenv.lib','ntdll.lib','advapi32.lib','legacy_stdio_definitions.lib']
  : ['-lm'];

export function cCompilerArgs(args,platform=process.platform) {
  if(platform!=='win32')return args;
  const result=['/nologo','/std:c11','/MD','/W3','/WX','/D_CRT_SECURE_NO_WARNINGS','/D_CRT_NONSTDC_NO_WARNINGS'];
  const libraries=[];let directory;
  for(let i=0;i<args.length;i++) {
    const arg=args[i];
    if(['-Wall','-Wextra','-Werror','-std=c11','-lm','-pthread'].includes(arg))continue;
    if(arg==='-O2'){result.push('/O2');continue;}
    if(arg==='-o') {const output=args[++i];result.push(`/Fe${output}`,`/Fo${dirname(output)}${process.platform==='win32'?'\\':'/'}`);continue;}
    if(arg==='-I'){result.push(`/I${args[++i]}`);continue;}
    if(arg.startsWith('-D')){result.push('/D'+arg.slice(2));continue;}
    if(arg==='-L'){directory=args[++i];continue;}
    if(arg.startsWith('-L')){directory=arg.slice(2);continue;}
    if(arg.startsWith('-Wl,-rpath,'))continue;
    if(arg==='-lmutracer'){libraries.push(directory?resolve(directory,'mutracer.dll.lib'):'mutracer.dll.lib');continue;}
    if(arg.startsWith('-l')){libraries.push(arg.slice(2)+'.lib');continue;}
    if(arg.startsWith('-'))throw Error(`Unsupported MSVC C flag: ${arg}`);
    result.push(arg);
  }
  const system=['ws2_32.lib','bcrypt.lib','crypt32.lib','iphlpapi.lib','userenv.lib','ntdll.lib','advapi32.lib','legacy_stdio_definitions.lib'];
  return [...result,...libraries,...system.filter(name=>!result.includes(name)&&!libraries.includes(name))];
}
export function spawnNative(command,args,options={}) {
  return spawnSync(command,command===cCompiler?cCompilerArgs(args):args,
    {...options,env:nativeToolchainEnv(options.env??process.env)});
}


export function nativeToolchainEnv(environment=process.env) {
  const env={...environment};
  if(windows) {
    const path=Object.keys(env).find(key=>key.toLowerCase()==='path');
    const previous=path?env[path]:'';
    for(const key of Object.keys(env))if(key.toLowerCase()==='path')delete env[key];
    // Normalize Path even outside a Developer shell: object spreads lose
    // process.env's case-insensitive lookup before scripts prepend directories.
    env.PATH=previous;
    env.RUSTUP_TOOLCHAIN??='stable-x86_64-pc-windows-msvc';
    env.CC??='cl.exe';env.CXX??='cl.exe';
    if(env.VCToolsInstallDir) {
      const tools=resolve(env.VCToolsInstallDir,'bin/Hostx64/x64');
      // Git Bash prepends its Unix link.exe; select the MSVC linker explicitly.
      env.PATH=tools+delimiter+previous;
      env.CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER??=resolve(tools,'link.exe');
    }
  }
  return env;
}

// C consumers live outside Cargo's release directory; the Windows loader does
// not honor the rpath used by the Unix builds. Keep each target's DLL explicit.
export function hostLibraryEnv(target,environment=process.env) {
  const env=nativeToolchainEnv(environment);
  if(windows)env.PATH=resolve(target,'release')+delimiter+env.PATH;
  return env;
}

export function viewerPlatform() {
  if (process.platform === 'darwin' && process.arch === 'arm64') return 'macos-arm64';
  if (process.platform === 'linux' && process.arch === 'x64') return 'linux-x64';
  if (windows && process.arch === 'x64') return 'windows-x64';
  throw new Error(`Unsupported native viewer platform: ${process.platform}/${process.arch}`);
}
