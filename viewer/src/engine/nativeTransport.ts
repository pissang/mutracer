/** Small, versioned request/reply protocol; only low-frequency commands use JSON. */
export interface NativeReply { id?: number; result?: unknown; error?: string; event?: string; value?: unknown; }
export class NativeTransport {
  private serial = 0;
  private disposed = false;
  private pending = new Map<number, {resolve(value: unknown): void; reject(error: Error): void; timer?: ReturnType<typeof setTimeout>}>();
  constructor(private send: (message: string) => void, private event: (name: string, value: unknown) => void) {}
  request<T = void>(command: string, args: unknown = {}, timeoutMs = 120_000): Promise<T> {
    if (this.disposed) return Promise.reject(new Error('Native viewer disposed'));
    const id = ++this.serial;
    return new Promise<T>((resolve, reject) => {
      const timer = timeoutMs > 0 ? setTimeout(() => { this.pending.delete(id); reject(new Error(`Native request timed out: ${command}`)); }, timeoutMs) : undefined;
      this.pending.set(id, {resolve: value => resolve(value as T), reject, timer});
      try { this.send(JSON.stringify({version: 1, id, command, args})); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  receive(reply: NativeReply) {
    if (reply.event) this.event(reply.event, reply.value);
    if (reply.id === undefined) return;
    const pending = this.pending.get(reply.id);
    if (!pending) return;
    this.pending.delete(reply.id); clearTimeout(pending.timer);
    if (reply.error) pending.reject(new Error(reply.error)); else pending.resolve(reply.result);
  }
  dispose() {
    this.disposed = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('Native viewer disposed')); }
    this.pending.clear();
  }
}

// 20 bytes: five little-endian float32 words (operation, x, y, button, modifiers).
// Wry's IPC accepts strings; base64 is just the envelope, with no JSON parsing.
export function pointerPacket(operation: number, x: number, y: number, button = 0, modifiers = 0): string {
  const bytes = new Uint8Array(20), view = new DataView(bytes.buffer);
  [operation, x, y, button, modifiers].forEach((value, i) => view.setFloat32(i * 4, value, true));
  return '~' + btoa(String.fromCharCode(...bytes));
}
