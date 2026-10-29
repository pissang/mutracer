/** Shared by resident targets so switching images cannot reset queued work. */
export class GPUTraceQueue {
  private pendingMs = 0;
  private pending = new Set<Promise<void>>();

  constructor(private queue: GPUQueue) {}

  get hasPending(): boolean { return this.pending.size > 0; }

  available(budgetMs: number): number {
    return Math.max(0, budgetMs - this.pendingMs);
  }

  whenAvailable(): Promise<boolean> {
    const pending = this.pending.values().next().value;
    return pending ? pending.then(() => true) : Promise.resolve(false);
  }

  track(estimatedMs: number): void {
    this.pendingMs += estimatedMs;
    // Fence each sample, rather than the entire batch: a later display tick can
    // replace completed samples while the tail of the previous batch still runs.
    const retire = () => {
      this.pendingMs = Math.max(0, this.pendingMs - estimatedMs);
      this.pending.delete(completion);
      // Subtracting estimates leaves rounding residue. An empty queue must
      // admit a sample as long as the budget, or nothing would wake it again.
      if (!this.pending.size) this.pendingMs = 0;
    };
    const completion = this.queue.onSubmittedWorkDone().then(retire, retire);
    this.pending.add(completion);
  }
}
