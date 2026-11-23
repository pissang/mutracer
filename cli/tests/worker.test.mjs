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
