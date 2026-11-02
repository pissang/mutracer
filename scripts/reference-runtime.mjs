import {spawn} from 'node:child_process';
import {existsSync, mkdtempSync, rmSync, openSync, closeSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';

export const delay = ms => new Promise(done => setTimeout(done, ms));
class CDP {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.ready = new Promise((ok, fail) => {this.socket.onopen = ok; this.socket.onerror = fail;});
    this.socket.onmessage = event => {
      const message = JSON.parse(event.data);
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      message.error ? pending.reject(Error(JSON.stringify(message.error))) : pending.resolve(message.result);
    };
    this.socket.onclose = () => {
      for (const pending of this.pending.values()) pending.reject(Error('Chrome disconnected'));
      this.pending.clear();
    };
  }
  async call(method, params = {}) {
    await this.ready;
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, {resolve, reject});
      this.socket.send(JSON.stringify({id, method, params}));
    });
  }
  async evaluate(expression) {
    const result = await this.call('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true});
    if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  close() {this.socket.close();}
}
export async function launchChrome() {
  const executable = process.env.MUTRACER_CHROME ?? (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : 'google-chrome');
  const profile = mkdtempSync(resolve(tmpdir(), 'mutracer-reference-chrome-'));
  const logFd=process.env.MUTRACER_CHROME_LOG?openSync(process.env.MUTRACER_CHROME_LOG,'a'):undefined;
  const child = spawn(executable, [...(logFd!==undefined?['--enable-logging=stderr']:[]),'--user-data-dir=' + profile, '--remote-debugging-port=0',
    '--remote-allow-origins=*', '--no-first-run', '--no-default-browser-check', '--disable-background-timer-throttling',
    '--js-flags=--expose-gc', '--headless=new', 'about:blank'], {stdio:logFd!==undefined?['ignore','ignore',logFd]:'ignore'});
  if(logFd!==undefined)closeSync(logFd);
  let launchError;
  child.on('error', error => {launchError = error;});
  const close = async () => {
    if (child.exitCode === null) {
      const exited = new Promise(done => child.once('exit', done));
      child.kill('SIGTERM');
      await Promise.race([exited, delay(5000)]);
      if (child.exitCode === null) {child.kill('SIGKILL'); await exited;}
    }
    rmSync(profile, {recursive: true, force: true});
  };
  try {
    const portFile = resolve(profile, 'DevToolsActivePort');
    for (let i = 0; i < 200 && !existsSync(portFile); i++) {
      if (launchError || child.exitCode !== null) throw launchError ?? Error('Chrome exited');
      await delay(100);
    }
    const {readFileSync} = await import('node:fs');
    const port = Number(readFileSync(portFile, 'utf8').split('\n')[0]);
    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    const browser = new CDP(version.webSocketDebuggerUrl);
    return {
      async page(url) {
        const {browserContextId} = await browser.call('Target.createBrowserContext');
        const {targetId} = await browser.call('Target.createTarget', {url, browserContextId, newWindow: true});
        let target;
        for (let i = 0; i < 100; i++) {
          target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.id === targetId);
          if (target?.webSocketDebuggerUrl) break;
          await delay(100);
        }
        const tab = new CDP(target.webSocketDebuggerUrl);
        await tab.call('Page.enable');
        await tab.call('Page.bringToFront');
        return {tab, async close() {tab.close(); await browser.call('Target.disposeBrowserContext', {browserContextId});}};
      },
      async close() {browser.close(); await close();},
    };
  } catch (error) {await close(); throw error;}
}
