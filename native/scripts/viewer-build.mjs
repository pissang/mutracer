import {mkdirSync,copyFileSync,cpSync,writeFileSync,renameSync,readFileSync,rmSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {executable,viewerPlatform} from './platform.mjs';
import {prepareViewerCore,viewerRoot as root} from './viewer-core-build.mjs';
import {prepareDxc} from './fetch-dxc.mjs';
import {bundleWindowsRuntime} from './windows-redist.mjs';
const out=resolve(process.env.MUTRACER_NATIVE_OUTPUT??resolve(root,'.native-build/viewer'));
const target=resolve(process.env.CARGO_TARGET_DIR??resolve(out,'cargo-target'));
const platform=viewerPlatform(),mac=platform==='macos-arm64';
const {run}=await prepareViewerCore(out,target);
run('cargo',['build','--release','--locked','--manifest-path','native/viewer/Cargo.toml',...(process.env.MUTRACER_VIEWER_DLSS==='1'?['--features','dlss-rr']:[])]);
const app=resolve(out,mac?'MuTracer.app':'MuTracer'),contents=mac?resolve(app,'Contents'):app;
const bin=mac?resolve(contents,'MacOS'):contents,resources=mac?resolve(contents,'Resources'):contents;
mkdirSync(bin,{recursive:true});mkdirSync(resources,{recursive:true});
// Optional NGX components are staged only by dlss-build after this build. A
// regular build into a previously used directory must not retain those DLLs
// after replacing their license directory or produce a misleading launcher.
for(const name of ['mutracer_ngx.dll','nvngx_dlssd.dll','MuTracer-DLSS.cmd','dlss-build.json'])
  rmSync(resolve(bin,name),{force:true});
const staged=resolve(bin,'.mutracer-viewer.build');
copyFileSync(resolve(target,'release',executable('mutracer-viewer')),staged);
renameSync(staged,resolve(bin,executable('mutracer-viewer')));
copyFileSync(resolve(root,'native/viewer/assets/sample.glb'),resolve(resources,'sample.glb'));
for (const name of ['rt_hdr_alb_nrm_small.tza','rt_hdr_calb_cnrm_large.tza','rt_alb_large.tza','rt_nrm_large.tza'])
  copyFileSync(resolve(root,'oidn/weights',name),resolve(resources,name));
if(mac) {
  // Modern macOS masks the full-bleed artwork itself. An icon stack avoids
  // the extra gray enclosure applied to legacy icons on macOS 26 and later.
  const document=resolve(out,'MuTracer.icon');
  mkdirSync(resolve(document,'Assets'),{recursive:true});
  try {
    copyFileSync(resolve(root,'native/viewer/assets/macos-icon.json'),resolve(document,'icon.json'));
    copyFileSync(resolve(root,'site/src/assets/mutracer-logo-render.png'),resolve(document,'Assets/artwork.png'));
    run('/usr/bin/xcrun',['actool',document,'--compile',resources,'--platform','macosx',
      '--minimum-deployment-target','14.0','--app-icon','MuTracer',
      '--output-partial-info-plist',resolve(out,'icon-info.plist')]);
  } finally {rmSync(document,{recursive:true,force:true});}
  const icon=resolve(root,'native/viewer/assets/macos-icon.png'),png=readFileSync(icon);
  if(png.readUInt32BE(16)!==1024||png.readUInt32BE(20)!==1024)throw new Error('macOS app icon requires a 1024px master.');
  // Supply both standard and Retina representations, including small Finder icons.
  // https://developer.apple.com/library/archive/documentation/Xcode/Reference/xcode_ref-Asset_Catalog_Format/IconSetType.html
  const iconset=resolve(out,'MuTracer.iconset');
  rmSync(iconset,{recursive:true,force:true});mkdirSync(iconset);
  try {
    for(const size of [16,32,128,256,512])for(const scale of [1,2]) {
      const pixels=String(size*scale),name=`icon_${size}x${size}${scale===2?'@2x':''}.png`;
      run('/usr/bin/sips',['-z',pixels,pixels,icon,'--out',resolve(iconset,name)]);
    }
    run('/usr/bin/iconutil',['-c','icns',iconset,'-o',resolve(resources,'MuTracer.icns')]);
  } finally {rmSync(iconset,{recursive:true,force:true});}
  writeFileSync(resolve(contents,'Info.plist'),`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>mutracer-viewer</string>
<key>CFBundleIdentifier</key><string>com.meimu.mutracer.native-viewer</string>
<key>CFBundleName</key><string>MuTracer</string>
<key>CFBundleIconFile</key><string>MuTracer.icns</string>
<key>CFBundleIconName</key><string>MuTracer</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>0.0.0</string>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>\n`);
}
// Discard obsolete SDK files when rebuilding into an older app directory.
if(mac)rmSync(resolve(contents,'Frameworks'),{recursive:true,force:true});
else for(const name of readdirSync(contents))if(/^(?:lib)?OpenImageDenoise|^tbb|^libtbb/.test(name))rmSync(resolve(contents,name),{force:true});
// Mirror component notice paths, including shared renderer attribution, in the
// standalone package.
const licenses=resolve(resources,'licenses');
rmSync(licenses,{recursive:true,force:true});
for(const component of ['', 'native', 'native/viewer']) {
  const destination=resolve(licenses,component);mkdirSync(destination,{recursive:true});
  cpSync(resolve(root,component,'LICENSES'),resolve(destination,'LICENSES'),{recursive:true});
  copyFileSync(resolve(root,component,'THIRD_PARTY_NOTICES.md'),resolve(destination,'THIRD_PARTY_NOTICES.md'));
}
copyFileSync(resolve(root,'LICENSE'),resolve(licenses,'LICENSE'));
if(process.platform==='win32') {
  bundleWindowsRuntime(bin,licenses);
  const dxc=prepareDxc(),notices=resolve(licenses,'DXC');mkdirSync(notices,{recursive:true});
  for(const name of ['dxcompiler.dll','dxil.dll'])copyFileSync(resolve(dxc,'bin/x64',name),resolve(bin,name));
  for(const name of ['LICENSE-LLVM.txt','LICENSE-MS.txt','LICENSE-MIT.txt'])copyFileSync(resolve(dxc,name),resolve(notices,name));
}
if(mac)run('/usr/bin/codesign',['--force','--sign','-',app]);
console.log(`Native app: ${app}`);
const args=process.argv.slice(2);if(!args.includes('--build-only')) {
  if(mac)run('/usr/bin/open',['-n',app,...(args.length?['--args',...args.map(a=>resolve(a))]:[])]);
  else run(resolve(bin,executable('mutracer-viewer')),args);
}
