export interface IdempotencyEntry<T> {
  requestId: string;
  operation: string;
  createdAt: number;
  promise: Promise<T>;
}

export interface IdempotencyLedgerOptions {
  maxEntries?: number;
  ttlMs?: number;
  now?: () => number;
}

/**
 * Process-local command ledger. Keeping the in-flight promise is important:
 * concurrent retries share one side effect instead of merely replaying its result.
 */
export class IdempotencyLedger<T> {
  private readonly entries = new Map<string, IdempotencyEntry<T>>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: IdempotencyLedgerOptions = {}) {
    this.maxEntries = options.maxEntries ?? 256;
    this.ttlMs = options.ttlMs ?? 10 * 60 * 1000;
    this.now = options.now ?? Date.now;
  }

  run(requestId: string, operation: string, task: () => Promise<T>): Promise<T> {
    if (!requestId) throw new Error("requestId is required");
    this.prune();
    const key = `${operation}\u0000${requestId}`;
    const existing = this.entries.get(key);
    if (existing) return existing.promise;
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    const promise = Promise.resolve().then(task);
    this.entries.set(key, { requestId, operation, createdAt: this.now(), promise });
    return promise;
  }

  has(requestId: string, operation: string): boolean {
    this.prune();
    return this.entries.has(`${operation}\u0000${requestId}`);
  }

  forget(requestId: string, operation: string, promise: Promise<T>): void {
    const key = `${operation}\u0000${requestId}`;
    if (this.entries.get(key)?.promise === promise) this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  private prune(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [key, entry] of this.entries) {
      if (entry.createdAt <= cutoff) this.entries.delete(key);
    }
  }
}
