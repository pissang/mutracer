import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createRequire} from 'node:module';
import {dirname, join} from 'node:path';

const maxHeader = 1024 ** 2;
const maxPayload = 512 * 1024 ** 2;

export class NativeError extends Error {
  constructor(message, code = 5) {
    super(message);
    this.code = code;
  }
}

class Reader {
  constructor(stream) {
    this.input = stream[Symbol.asyncIterator]();
    this.buffer = Buffer.alloc(0);
  }

  async next() {
    const event = await this.input.next();
    if (event.done) throw new NativeError('Native worker ended the stream.');
    this.buffer = event.value;
  }

  async line() {
    const parts = [];
    let length = 0;
    for (;;) {
      if (!this.buffer.length) await this.next();
      const index = this.buffer.indexOf(10);
      const cut = index < 0 ? this.buffer.length : index + 1;
      const chunk = this.buffer.subarray(0, cut);
      length += chunk.length;
      if (length > maxHeader) throw new NativeError('Worker header exceeds 1 MiB.');
      parts.push(chunk);
      this.buffer = this.buffer.subarray(cut);
      if (index >= 0) return Buffer.concat(parts, length);
    }
  }

  async exact(length) {
    const parts = [];
    let remaining = length;
    while (remaining > 0) {
      if (!this.buffer.length) await this.next();
      const cut = Math.min(remaining, this.buffer.length);
      parts.push(this.buffer.subarray(0, cut));
      this.buffer = this.buffer.subarray(cut);
      remaining -= cut;
    }
    return Buffer.concat(parts, length);
  }
}

export function binary() {
  if (process.env.MUTRACER_BIN) return process.env.MUTRACER_BIN;
  const name = process.platform === 'win32' ? 'mutracer.exe' : 'mutracer';
  const pkg = `@meimu/mutracer-cli-${process.platform}-${process.arch}`;
  try {
    const require = createRequire(import.meta.url);
    return join(dirname(require.resolve(pkg + '/package.json')), 'bin', name);
  } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
    return name;
  }
}

export class Worker {
  #next = 0;
  #queue = Promise.resolve();

  static async open() {
    const worker = new Worker();
    try {
      const {header} = await worker.request('hello', {protocol: 1});
      if (header.protocol !== 1 || !header.capabilities.includes('descriptor-v8') ||
          !header.capabilities.includes('image-decode')) {
        throw new NativeError('The native executable lacks a required protocol 1 capability.', 2);
      }
      worker.info = header;
      return worker;
    } catch (error) {
      await worker.close();
      throw error;
    }
  }

  constructor() {
    this.child = spawn(binary(), ['serve', '--stdio'], {stdio: ['pipe', 'pipe', 'inherit']});
    this.reader = new Reader(this.child.stdout);
    this.status = new Promise(resolve => {
      this.child.once('error', error => {
        this.failure = new NativeError(`Could not start native executable: ${error.message}`, 3);
        resolve();
      });
      this.child.once('close', resolve);
    });
    // Surface failures through the outstanding request.
    this.child.stdin.on('error', () => {});
  }

  request(type, fields, bytes) {
    const result = this.#queue.then(() => this.#send(type, fields, bytes));
    this.#queue = result.catch(() => {});
    return result;
  }

  async #send(type, fields, bytes) {
    const id = ++this.#next;
    const header = {type, id, ...fields};
    if (bytes) {
      if (bytes.length > maxPayload) throw new NativeError('Request payload exceeds 512 MiB.', 4);
      header.bytes = bytes.length;
    }
    const line = Buffer.from(JSON.stringify(header) + '\n');
    if (line.length > maxHeader) throw new NativeError('Request header exceeds 1 MiB.', 4);
    const write = chunk => new Promise((resolve, reject) => {
      this.child.stdin.write(chunk, error => error ? reject(error) : resolve());
    });
    try {
      await write(line);
      if (bytes) {
        const prefix = Buffer.alloc(4);
        prefix.writeUInt32LE(bytes.length);
        await write(prefix);
        await write(bytes);
      }
      for (;;) {
        const response = JSON.parse((await this.reader.line()).toString());
        if (response.id !== id) throw new NativeError('Worker response ID differs from the request.');
        if (response.type === 'progress') continue;
        if (response.type === 'error') {
          throw new NativeError(`${response.pointer ?? ''} ${response.message}`, response.code);
        }
        if (response.bytes === undefined) return {header: response};
        const length = (await this.reader.exact(4)).readUInt32LE();
        if (length !== response.bytes || length > maxPayload) throw new NativeError('Invalid native payload length.');
        return {header: response, bytes: await this.reader.exact(length)};
      }
    } catch (error) {
      if (this.failure) throw this.failure;
      if (error instanceof NativeError) throw error;
      throw new NativeError(error.message);
    }
  }

  async close() {
    this.child.stdin.end();
    let timeout;
    await Promise.race([this.status, new Promise(resolve => {
      timeout = setTimeout(() => {
        this.child.kill('SIGKILL');
        resolve();
      }, 2000);
      timeout.unref();
    })]);
    clearTimeout(timeout);
  }
}

export async function nativeCommand(args) {
  const child = spawn(binary(), args, {stdio: ['ignore', 'inherit', 'inherit']});
  const [status] = await once(child, 'exit');
  if (status !== 0) throw new NativeError(`Native command stopped with status ${status}.`, status ?? 5);
}
