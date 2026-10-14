/**
 * Global verification-buffer budget (M10.b).
 *
 * Reconstructed chunk bytes are held only long enough to verify their hash.
 * The Phase 5 budget is 128 MiB across every concurrent reader; no worker may
 * bypass it, and permits are always returned in a finally block.
 */

export const GLOBAL_BUDGET_BYTES = 128 * 1024 * 1024;

export class MemoryBudget {
  private inUse = 0;
  private readonly waiters: Array<{ bytes: number; resolve: () => void }> = [];

  constructor(private readonly capacity = GLOBAL_BUDGET_BYTES) {}

  get usedBytes(): number {
    return this.inUse;
  }

  get availableBytes(): number {
    return this.capacity - this.inUse;
  }

  /**
   * Reserve `bytes`, waiting until they are available.
   * A request larger than the whole capacity is clamped so a single large read
   * can still proceed without deadlocking.
   */
  async acquire(bytes: number): Promise<() => void> {
    const wanted = Math.min(Math.max(0, Math.floor(bytes)), this.capacity);
    if (wanted === 0) return () => {};
    if (this.inUse + wanted <= this.capacity) {
      this.inUse += wanted;
      return this.makeRelease(wanted);
    }
    await new Promise<void>((resolve) => {
      this.waiters.push({ bytes: wanted, resolve });
    });
    this.inUse += wanted;
    return this.makeRelease(wanted);
  }

  private makeRelease(bytes: number): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inUse = Math.max(0, this.inUse - bytes);
      this.drain();
    };
  }

  private drain(): void {
    while (this.waiters.length > 0) {
      const next = this.waiters[0]!;
      if (this.inUse + next.bytes > this.capacity) return;
      this.waiters.shift();
      next.resolve();
    }
  }
}

/** One process-wide budget shared by all download readers. */
export const globalDownloadBudget = new MemoryBudget();
