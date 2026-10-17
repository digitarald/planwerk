interface AssessmentJob<T> {
  owner: string;
  run(): Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

/** Bound model work independently of state delivery, sharing identical facts. */
export class AssessmentLane<T> {
  private active = 0;
  private readonly queued: AssessmentJob<T>[] = [];
  private readonly pending = new Map<string, Promise<T>>();
  private readonly activeOwners = new Set<string>();
  private readonly concurrency: number;
  private readonly queueLimit: number;

  constructor(concurrency = 2, queueLimit = 128) {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || !Number.isSafeInteger(queueLimit) || queueLimit < 1) {
      throw new RangeError("Assessment concurrency and queue limit must be positive integers");
    }
    this.concurrency = concurrency;
    this.queueLimit = queueLimit;
  }

  run(owner: string, revision: string, run: () => Promise<T>): Promise<T> {
    const key = JSON.stringify([owner, revision]);
    const existing = this.pending.get(key);
    if (existing) return existing;
    for (let index = this.queued.length - 1; index >= 0; index--) {
      if (this.queued[index].owner !== owner) continue;
      const [superseded] = this.queued.splice(index, 1);
      superseded.reject(new Error("Assessment superseded by newer facts"));
    }
    if (this.queued.length >= this.queueLimit) {
      return Promise.reject(new Error("Assessment queue is full; retry on the next reconciliation"));
    }
    const promise = new Promise<T>((resolve, reject) => {
      this.queued.push({ owner, run, resolve, reject });
    });
    this.pending.set(key, promise);
    const clear = () => { this.pending.delete(key); };
    void promise.then(clear, clear);
    this.drain();
    return promise;
  }

  private drain(): void {
    while (this.active < this.concurrency && this.queued.length) {
      const index = this.queued.findIndex((job) => !this.activeOwners.has(job.owner));
      if (index === -1) break;
      const [job] = this.queued.splice(index, 1);
      this.active++;
      this.activeOwners.add(job.owner);
      void Promise.resolve().then(job.run).then(job.resolve, job.reject).finally(() => {
        this.active--;
        this.activeOwners.delete(job.owner);
        this.drain();
      });
    }
  }
}
