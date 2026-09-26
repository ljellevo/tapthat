/**
 * One in-flight job per key, FIFO for the rest.
 *
 * Concurrent agent runs on a single working tree corrupt each other — two
 * processes editing the same files with no coordination — so serialization is a
 * correctness requirement, not throughput tuning. The key is the branch, since
 * that is what identifies the tree.
 */
export class Queue {
  private running = new Set<string>();
  private waiting = new Map<string, Array<() => void>>();

  depth(key: string): number {
    return (this.waiting.get(key)?.length ?? 0) + (this.running.has(key) ? 1 : 0);
  }

  isRunning(key: string): boolean {
    return this.running.has(key);
  }

  /** Resolves with the job's result once it is this caller's turn. */
  async run<T>(key: string, job: () => Promise<T>): Promise<T> {
    if (this.running.has(key)) {
      await new Promise<void>((resolve) => {
        const queue = this.waiting.get(key) ?? [];
        queue.push(resolve);
        this.waiting.set(key, queue);
      });
    }
    this.running.add(key);
    try {
      return await job();
    } finally {
      this.running.delete(key);
      const next = this.waiting.get(key)?.shift();
      if (next) next();
      else this.waiting.delete(key);
    }
  }
}
