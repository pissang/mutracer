import {aovDisplayShader} from '../../src/renderer/wgsl/aovDisplay.wgsl.ts';
import aovResolveShader, {aovBorrowDepthShader, aovBorrowReflectanceShader} from '../../src/renderer/wgsl/aovResolve.wgsl.ts';
import {compactAovResolveCode} from '../../src/renderer/wgsl/aovCompact.wgsl.ts';
import {readFileSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
const bundle=await build({entryPoints:[fileURLToPath(new URL('../src/display-shader.ts',import.meta.url))],bundle:true,write:false,format:'esm',platform:'node'});
const {nativeDisplayShader,nativeDisplayEffectsShader}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
for (const [name, result] of [['aov-display.wgsl',compactAovResolveCode(aovDisplayShader('rgba8unorm'))],['aov-display-hdr.wgsl',compactAovResolveCode(aovDisplayShader('rgba16float'))],['aov-resolve.wgsl',compactAovResolveCode(aovResolveShader)],['aov-borrow-depth.wgsl',compactAovResolveCode(aovBorrowDepthShader)],['aov-borrow-reflectance.wgsl',compactAovResolveCode(aovBorrowReflectanceShader)],['display.wgsl',nativeDisplayShader()],['display-effects.wgsl',nativeDisplayEffectsShader()],['display-hdr.wgsl',nativeDisplayEffectsShader(true)]]) {
 const target=new URL('../host/src/'+name,import.meta.url);
 if(process.argv.includes('--check')) {if(readFileSync(target,'utf8')!==result)throw new Error('Regenerate native display shader: '+name);}
 else writeFileSync(target,result);
}
