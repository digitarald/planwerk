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
}

interface SchedulerOptions {
  intervalMs: number;
  run(generation: SchedulerGeneration): Promise<void>;
  onError(error: unknown): void;
}

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
      if (internal.activeTick) await internal.activeTick;
      while (internal.tasks.size > 0) {
        await Promise.allSettled(Array.from(internal.tasks));
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

  private requestTick(
    generation: InternalGeneration,
    options: SchedulerOptions,
  ): void {
    if (!this.isCurrent(generation) || generation.activeTick) return;

    const tick = Promise.resolve()
      .then(() => options.run(generation))
      .catch(options.onError)
      .finally(() => {
        if (generation.activeTick === tick) {
          generation.activeTick = null;
        }
      });
    generation.activeTick = tick;
  }
}
