export interface SchedulerGeneration {
  readonly id: number;
  readonly signal: AbortSignal;
}

interface InternalGeneration extends SchedulerGeneration {
  readonly abortController: AbortController;
  activeTick: Promise<void> | null;
  drain: Promise<void> | null;
  interval: ReturnType<typeof setInterval> | null;
  readonly tasks: Set<Promise<unknown>>;
  stopRequested: boolean;
  retired: boolean;
  requested: boolean;
  options: SchedulerOptions;
}

interface SchedulerOptions {
  intervalMs: number;
  run(generation: SchedulerGeneration): Promise<void>;
  onError(error: unknown): void;
  drainTimeoutMs?: number;
}

/**
 * Serializes ticks within a generation. Bounded stop retires authority, not
 * unsettled tasks; cross-generation mutation exclusivity relies on
 * OperationAdmission retaining slots until real settlement or quarantine.
 */
export class SerializedGenerationScheduler {
  private current: InternalGeneration | null = null;
  private generationId = 0;
  private lifecycle: Promise<void> = Promise.resolve();

  start(options: SchedulerOptions): SchedulerGeneration {
    if (this.current) {
      throw new Error("A scheduler generation is already running");
    }

    const abortController = new AbortController();
    const generation: InternalGeneration = {
      id: ++this.generationId,
      signal: abortController.signal,
      abortController,
      activeTick: null,
      drain: null,
      interval: null,
      tasks: new Set(),
      stopRequested: false,
      retired: false,
      requested: false,
      options,
    };
    this.current = generation;

    this.lifecycle = this.lifecycle.then(() => {
      if (!this.isCurrent(generation)) return;
      generation.interval = setInterval(
        () => this.requestTick(generation, options),
        options.intervalMs,
      );
      this.requestTick(generation, options);
    });

    generation.signal.addEventListener(
      "abort",
      () => {
        if (generation.interval) {
          clearInterval(generation.interval);
          generation.interval = null;
        }
      },
      { once: true },
    );

    return generation;
  }

  stop(generation: SchedulerGeneration | null = this.current): Promise<void> {
    if (!generation) return this.lifecycle;
    const internal = generation as InternalGeneration;
    if (internal.drain) return internal.drain;

    internal.stopRequested = true;
    if (this.current === internal) this.current = null;
    internal.abortController.abort();

    const drain = this.lifecycle.then(async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          (async () => {
            if (internal.activeTick) await internal.activeTick;
            while (internal.tasks.size > 0) {
              await Promise.allSettled(Array.from(internal.tasks));
            }
          })(),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, internal.options.drainTimeoutMs ?? 1_000);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      internal.retired = true;
    });
    internal.drain = drain;
    this.lifecycle = drain;
    return drain;
  }

  isRunning(): boolean {
    return this.current !== null;
  }

  isCurrent(generation: SchedulerGeneration): boolean {
    const internal = generation as InternalGeneration;
    return (
      this.current === internal &&
      !internal.stopRequested &&
      !internal.retired
    );
  }

  isTickInProgress(generation: SchedulerGeneration): boolean {
    return (generation as InternalGeneration).activeTick !== null;
  }

  track<T>(
    generation: SchedulerGeneration,
    task: Promise<T>,
  ): Promise<T> {
    const internal = generation as InternalGeneration;
    if (internal.retired) return task;
    internal.tasks.add(task);
    const remove = () => {
      internal.tasks.delete(task);
    };
    void task.then(remove, remove);
    return task;
  }

  requestRun(generation: SchedulerGeneration | null = this.current): void {
    if (!generation || !this.isCurrent(generation)) return;
    const internal = generation as InternalGeneration;
    internal.requested = true;
    this.requestTick(internal, internal.options);
  }

  private requestTick(
    generation: InternalGeneration,
    options: SchedulerOptions,
  ): void {
    if (!this.isCurrent(generation) || generation.activeTick) return;
    generation.requested = false;

    const tick = Promise.resolve()
      .then(() => {
        if (this.isCurrent(generation)) return options.run(generation);
      })
      .catch(options.onError)
      .finally(() => {
        if (generation.activeTick === tick) {
          generation.activeTick = null;
          if (generation.requested) this.requestTick(generation, options);
        }
      });
    generation.activeTick = tick;
  }
}
