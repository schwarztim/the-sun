type Job<T> = () => Promise<T>;

interface Chain {
  tail: Promise<unknown>;
}

export class KeyedMutex {
  private chains = new Map<string, Chain>();
  private inflight = new Map<string, Promise<unknown>>();

  async run<T>(key: string, job: Job<T>): Promise<T> {
    const prev = this.chains.get(key)?.tail ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });
    const next = prev.then(() => gate);
    this.chains.set(key, { tail: next });

    await prev.catch(() => undefined);
    try {
      return await job();
    } finally {
      release();
      queueMicrotask(() => {
        if (this.chains.get(key)?.tail === next) {
          this.chains.delete(key);
        }
      });
    }
  }

  async runDedup<T>(key: string, job: Job<T>): Promise<T> {
    const existing = this.inflight.get(key) as Promise<T> | undefined;
    if (existing) return existing;
    const p = (async () => {
      try {
        return await job();
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, p);
    return p;
  }
}
