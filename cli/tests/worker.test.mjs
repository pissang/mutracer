import {mkdtemp, chmod, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, test} from 'node:test';
import assert from 'node:assert/strict';
import {Worker} from '../src/worker.mjs';

const originalBinary = process.env.MUTRACER_BIN;
afterEach(() => {
  if (originalBinary === undefined) delete process.env.MUTRACER_BIN;
  else process.env.MUTRACER_BIN = originalBinary;
});

test('forwards each structured native warning once', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mutracer-worker-'));
  const executable = join(directory, 'worker.mjs');
  const warning = {
    code: 'unsupported-transport',
    pointer: '',
    message: 'A graph material falls back under caustic transport.',
    hint: 'Disable lightTracing and photonMapping.',
  };
  await writeFile(executable, `#!/usr/bin/env node
import readline from 'node:readline';
const input = readline.createInterface({input: process.stdin});
input.on('line', line => {
  const request = JSON.parse(line);
  const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
  if (request.type === 'hello') {
    send({type: 'ok', id: request.id, protocol: 1, capabilities: ['descriptor-v8', 'image-decode']});
  } else {
    const warning = ${JSON.stringify(warning)};
    send({type: 'progress', id: request.id, warning});
    send({type: 'progress', id: request.id, warning});
    send({type: 'ok', id: request.id});
  }
});
`);
  await chmod(executable, 0o755);
  process.env.MUTRACER_BIN = executable;
  const nativeWorker = await Worker.open();
  const warnings = [];
  const errors = [];
  const originalError = console.error;
  console.error = message => errors.push(message);
  try {
    nativeWorker.onWarning = value => warnings.push(value);
    await nativeWorker.request('check', {frame: 0, t: 0});
    assert.deepEqual(warnings, [warning]);
    assert.equal(errors.length, 1);
  } finally {
    console.error = originalError;
    await nativeWorker.close();
    await rm(directory, {recursive: true, force: true});
  }
});

test('sends only the camera record when nothing else in the descriptor changes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mutracer-worker-'));
  const executable = join(directory, 'worker.mjs');
  const log = join(directory, 'requests.jsonl');
  await writeFile(executable, `#!/usr/bin/env node
import {appendFileSync} from 'node:fs';
let pending = Buffer.alloc(0), header;
process.stdin.on('data', chunk => {
  pending = Buffer.concat([pending, chunk]);
  for (;;) {
    if (!header) {
      const end = pending.indexOf(10);
      if (end < 0) return;
      header = JSON.parse(pending.subarray(0, end));
      pending = pending.subarray(end + 1);
    }
    const size = header.bytes === undefined ? 0 : 4 + header.bytes;
    if (pending.length < size) return;
    pending = pending.subarray(size);
    appendFileSync(${JSON.stringify(log)}, JSON.stringify(header) + '\\n');
    const capabilities = ['descriptor-v8', 'image-decode', 'descriptor-camera'];
    process.stdout.write(JSON.stringify({type: 'ok', id: header.id, protocol: 1, capabilities}) + '\\n');
    header = undefined;
  }
});
`);
  await chmod(executable, 0o755);
  process.env.MUTRACER_BIN = executable;
  const nativeWorker = await Worker.open();
  try {
    const base = new Uint8Array(1024);
    const moved = base.slice();
    moved[64 * 4 + 20] = 1;
    const edited = moved.slice();
    edited[900] = 1;
    const camera = [256, 384];
    await nativeWorker.scene(base, camera);
    await nativeWorker.scene(moved, camera);
    await nativeWorker.scene(moved, camera);
    await nativeWorker.scene(edited, camera);
    await nativeWorker.request('scene', {format: 'descriptor-v8'}, edited);
    await nativeWorker.scene(edited, camera);
    const {readFile} = await import('node:fs/promises');
    const requests = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line)).slice(1);
    assert.deepEqual(requests.map(({type, bytes}) => [type, bytes]), [
      ['scene', 1024], ['camera', 128], ['camera', 128], ['scene', 1024], ['scene', 1024], ['scene', 1024],
    ]);
  } finally {
    await nativeWorker.close();
    await rm(directory, {recursive: true, force: true});
  }
});
