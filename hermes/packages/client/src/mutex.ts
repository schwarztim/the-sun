export class ClientDedupMutex {
  private inflight = new Map<string, Promise<unknown>>();
  async runDedup<T>(key: string, job: () => Promise<T>): Promise<T> {
    const existing = this.inflight.get(key) as Promise<T> | undefined;
    if (existing) return existing;
    const p = (async () => { try { return await job(); } finally { this.inflight.delete(key); } })();
    this.inflight.set(key, p);
    return p;
  }
}
