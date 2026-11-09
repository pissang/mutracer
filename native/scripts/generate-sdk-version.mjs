import {readFileSync, writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {sdkVersion, sdkVersionHeader} from './sdk-cmake.mjs';
const manifest = readFileSync(new URL('../host/Cargo.toml', import.meta.url), 'utf8');
const header = new URL('../include/mutracer-version.h', import.meta.url);
const expected = sdkVersionHeader(sdkVersion(manifest));
if (process.argv.includes('--check')) {
  if (readFileSync(header, 'utf8') !== expected)
    throw Error('Run node native/scripts/generate-sdk-version.mjs after changing the SDK version');
} else writeFileSync(header, expected);
console.log(`SDK version header: ${fileURLToPath(header)}`);
