// Renders the temporal stress example in headless Chrome and writes PNG frames,
// per-frame HDR hashes and an MP4 (native `mutracer encode` via MUTRACER_BIN, or ffmpeg).
// Usage: node scripts/temporal-stress-capture.mjs OUT_DIR [--frames A-B] [--spp N]
//   [--mode offline|interactive|off] [--reflection-motion] [--accumulate-guides]
//   [--save-frames A-B,C-D] [--history-radius N] [--post-radius N] [--no-sparkle]
//   [--temporal-sample-budget N] [--sample-stride N]
//   [--no-dof] [--size WxH] [--webgl] [--no-video]
import {createServer} from 'vite';
import {mkdirSync, writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {launchChrome, delay} from './reference-runtime.mjs';

const args = process.argv.slice(2);
const flag = name => args.includes(name);
const value = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
if (!args[0] || args[0].startsWith('--')) throw new Error('Usage: node scripts/temporal-stress-capture.mjs OUT_DIR [options]');
const out = resolve(args[0]);
const settings = {
  spp: Number(value('--spp', 3)),
  mode: value('--mode', 'offline'),
  reflectionMotion: flag('--reflection-motion'),
  accumulateGuides: flag('--accumulate-guides'),
  depthOfField: !flag('--no-dof'),
  historyRadius: flag('--history-radius') ? Number(value('--history-radius')) : undefined,
  postRadius: flag('--post-radius') ? Number(value('--post-radius')) : undefined,
  stabilizeSparkle: flag('--no-sparkle') ? false : undefined,
  temporalSampleBudget: flag('--temporal-sample-budget') ? Number(value('--temporal-sample-budget')) : undefined,
  sampleStride: flag('--sample-stride') ? Number(value('--sample-stride')) : undefined
};
const size = value('--size', '1280x720');
const saveFrames = value('--save-frames', '').split(',').filter(Boolean).map(range => {
  if (!/^\d+(?:-\d+)?$/.test(range)) throw new Error(`Invalid output frame range: ${range}`);
  const [first, last = first] = range.split('-').map(Number);
  if (first > last) throw new Error(`Invalid output frame range: ${range}`);
  return [first, last];
});
mkdirSync(out, {recursive: true});

const server = await createServer({
  configFile: resolve(import.meta.dirname, '../vite.config.ts'),
  optimizeDeps: {entries: [], noDiscovery: true},
  server: {host: '127.0.0.1', port: 0, hmr: false, watch: {ignored: ['**/.native-build/**', '**/target/**']}}
});
await server.listen();
const chrome = await launchChrome();
try {
  const url = `http://127.0.0.1:${server.httpServer.address().port}/examples/temporal-stress.html?capture&size=${size}${flag('--webgl') ? '&webgl' : ''}`;
  const page = await chrome.page(url);
  try {
    for (let i = 0; i < 300 && !await page.tab.evaluate('!!window.temporalStress'); i++) await delay(100);
    const frameCount = await page.tab.evaluate('temporalStress.frameCount');
    const [first, last] = (value('--frames', `0-${frameCount - 1}`)).split('-').map(Number);
    const backend = await page.tab.evaluate(`temporalStress.open(${JSON.stringify(settings)}, ${first}, ${(last ?? first) + 1})`);
    console.log(`${backend} ${size} frames ${first}-${last ?? first}`, settings);
    const hashes = {};
    const started = performance.now();
    for (let frame; (frame = await page.tab.evaluate(`temporalStress.next(${JSON.stringify(saveFrames)})`));) {
      writeFileSync(resolve(out, `frame-${String(frame.index).padStart(4, '0')}.png`), Buffer.from(frame.png.split(',')[1], 'base64'));
      hashes[frame.index] = frame.hash;
      process.stdout.write(`\r${frame.index} ${frame.hash}`);
    }
    const seconds = (performance.now() - started) / 1000;
    const timing = await page.tab.evaluate('temporalStress.timing()');
    writeFileSync(resolve(out, 'capture.json'), JSON.stringify({backend, size, settings, frames: [first, last ?? first], saveFrames, seconds, hashes, timing}, null, 2));
    console.log(`\n${seconds.toFixed(1)} s`);
  } finally { await page.close(); }
} finally { await chrome.close(); await server.close(); }

// Encode with the native CLI's system encoder when MUTRACER_BIN is set, else ffmpeg.
if (flag('--no-video')) process.exit(0);
const video = resolve(out, 'clip.mp4');
const encoded = process.env.MUTRACER_BIN
  ? spawnSync(process.env.MUTRACER_BIN, ['encode', out, '--fps', '24', '-o', video], {stdio: 'inherit'})
  : spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', '24', '-pattern_type', 'glob', '-i', resolve(out, 'frame-*.png'),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '16', video], {stdio: 'inherit'});
if (encoded.error || encoded.status !== 0) console.log(`Encoding failed (${encoded.error?.message ?? `exit ${encoded.status}`}); frames left as PNG.`);
