/**
 * Global verification-buffer budget (M10.b).
 *
 * Reconstructed chunk bytes are held only long enough to verify their hash.
 * The Phase 5 budget is 128 MiB across every concurrent reader; no worker may
 * bypass it, and permits are always returned in a finally block.
 *
 * DL-1 remediation: reservations are accounted ATOMICALLY. A waiter's bytes
 * are counted synchronously when the drain decides to grant them — never
 * later in a microtask — so one drain pass can never over-commit the budget
 * to multiple waiters that only fit jointly.
 */

export const GLOBAL_BUDGET_BYTES = 128 * 1024 * 1024;

interface Waiter {
  bytes: number;
  /** Called with the already-accounted reservation; must not re-add bytes. */
  grant: () => void;
}

export class MemoryBudget {
  private inUse = 0;
  private peak = 0;
  private readonly waiters: Waiter[] = [];

  constructor(private readonly capacity = GLOBAL_BUDGET_BYTES) {}

  get usedBytes(): number {
    return this.inUse;
  }

  /**
   * Highest simultaneous reservation observed since the last reset.
   *
   * Exposed so a test can PROVE the prefetch pipeline never exceeded its bound
   * instead of trusting the code to be correct.
   */
  get peakBytes(): number {
    return this.peak;
  }

  /** Forget the observed peak (test helper; never affects live reservations). */
  resetPeak(): void {
    this.peak = this.inUse;
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
    // Fast path: capacity is free right now — account immediately.
    if (this.waiters.length === 0 && this.inUse + wanted <= this.capacity) {
      this.account(wanted);
      return this.makeRelease(wanted);
    }
    // Queue path: the drain accounts the bytes synchronously before resolving,
    // so any later waiter in the same pass sees the true committed total.
    await new Promise<void>((resolve) => {
      this.waiters.push({
        bytes: wanted,
        grant: () => {
          this.account(wanted);
          resolve();
        },
      });
    });
    return this.makeRelease(wanted);
  }

  /** Commit bytes to the budget and record the peak. Single accounting point. */
  private account(wanted: number): void {
    this.inUse += wanted;
    if (this.inUse > this.peak) this.peak = this.inUse;
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

  /**
   * Grant queued waiters strictly in FIFO order while capacity truly holds.
   * Each grant is accounted before the next waiter is examined (DL-1 fix).
   */
  private drain(): void {
    while (this.waiters.length > 0) {
      const next = this.waiters[0]!;
      if (this.inUse + next.bytes > this.capacity) return;
      this.waiters.shift();
      next.grant();
    }
  }
}

/** One process-wide budget shared by all download readers. */
export const globalDownloadBudget = new MemoryBudget();
