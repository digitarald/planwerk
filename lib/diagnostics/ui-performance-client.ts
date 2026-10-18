import { UiPerformanceRecorder, UI_SAMPLE_MS, type UiMetricName, type UiValues } from "./ui-performance.ts";

declare global {
  interface Window {
    __PLANWERK_DESKTOP__?: boolean;
    __PLANWERK_PERFORMANCE_DISABLED__?: boolean;
    __PLANWERK_MONITOR_VISIBLE__?: boolean;
    __PLANWERK_PRELOAD_MS__?: number;
    __electrobunSendToHost?: (message: unknown) => void;
  }
}

let recorder: UiPerformanceRecorder | undefined;
let dispose: (() => void) | undefined;
let visibilityGeneration = 0;
const noEnd = () => {};
function current(): UiPerformanceRecorder | undefined {
  if (typeof window === "undefined" || !window.__PLANWERK_DESKTOP__ || window.__PLANWERK_PERFORMANCE_DISABLED__) return;
  return recorder ??= new UiPerformanceRecorder(() => performance.now());
}

export function uiMark(name: UiMetricName, values?: UiValues, once = false): void {
  current()?.mark(name, values, once);
}

export function uiElapsed(name: UiMetricName, startMs: number, values?: UiValues): void {
  current()?.add({ kind: "milestone", name, startMs, durationMs: Math.max(0, performance.now() - startMs), values });
}

export function uiReactRender(actualDuration: number, startTime: number): void {
  const target = current();
  if (!target) return;
  target.mark("capabilities", { reactProfiler: 1 }, true);
  if (actualDuration >= 16) target.add({
    kind: "span", name: "board.react-render", startMs: startTime, durationMs: actualDuration,
  });
}

export function uiSpan(name: UiMetricName, values?: UiValues): () => void {
  return current()?.begin(name, values) ?? noEnd;
}

export function uiMeasure<T>(name: UiMetricName, work: () => T, values?: UiValues): T {
  const end = uiSpan(name, values);
  try { return work(); } finally { end(); }
}

export function uiAfterPaint(name: UiMetricName, values?: UiValues): () => void {
  const target = current();
  if (!target || document.visibilityState !== "visible" || window.__PLANWERK_MONITOR_VISIBLE__ === false) return noEnd;
  const startMs = performance.now();
  const generation = visibilityGeneration;
  let second = 0;
  let cancelled = false;
  const first = requestAnimationFrame(() => {
    second = requestAnimationFrame(() => {
      if (!cancelled && generation === visibilityGeneration
        && document.visibilityState === "visible" && window.__PLANWERK_MONITOR_VISIBLE__ !== false) {
        target.add({ kind: "milestone", name, startMs, durationMs: performance.now() - startMs, values });
      }
    });
  });
  return () => { cancelled = true; cancelAnimationFrame(first); cancelAnimationFrame(second); };
}

export function installUiPerformance(): () => void {
  dispose?.();
  const target = current();
  if (!target) return noEnd;
  const documentId = crypto.randomUUID();
  const observers: PerformanceObserver[] = [];
  const cleanups: Array<() => void> = [];
  const visible = () => document.visibilityState === "visible" && window.__PLANWERK_MONITOR_VISIBLE__ !== false;
  let visibleSince = visible() ? 0 : performance.now();
  let stopped = false;
  let pendingInput = false;
  let inputFrame = 0;
  let sampleTimer: ReturnType<typeof setInterval> | undefined;
  const startSampling = () => {
    clearInterval(sampleTimer);
    sampleTimer = visible() ? setInterval(() => {
      if (target.sample(Date.now(), visible())) reset();
    }, UI_SAMPLE_MS) : undefined;
  };
  const flush = () => {
    const batch = target.take();
    if (!batch.records.length && !batch.dropped) return;
    try {
      if (!window.__electrobunSendToHost) throw new Error("Native performance channel unavailable");
      window.__electrobunSendToHost({ type: "performance", documentId, timeOrigin: performance.timeOrigin, ...batch });
    } catch (error) {
      console.warn("[performance] Could not deliver browser metrics:", error);
    }
  };
  const listen = (source: Window | Document, name: string, handler: EventListener) => {
    source.addEventListener(name, handler, { passive: true });
    cleanups.push(() => source.removeEventListener(name, handler));
  };
  const reset = () => {
    visibilityGeneration++;
    visibleSince = performance.now();
    cancelAnimationFrame(inputFrame);
    pendingInput = false;
    target.reset(Date.now());
    target.mark("window.resume", { visible: Number(visible()) });
    startSampling();
  };
  listen(document, "visibilitychange", reset);
  listen(window, "planwerk-visibility", reset);
  listen(window, "pageshow", reset);
  listen(window, "pagehide", () => { flush(); });
  target.reset(Date.now());
  target.mark("client.start", undefined, true);
  if (window.__PLANWERK_PRELOAD_MS__ !== undefined) {
    target.add({ kind: "milestone", name: "preload.start", startMs: window.__PLANWERK_PRELOAD_MS__, durationMs: 0 });
  }
  const supported = typeof PerformanceObserver === "undefined" ? [] : PerformanceObserver.supportedEntryTypes ?? [];
  const capabilities: UiValues = { timerLag: 1 };
  const observe = (type: string, key: keyof UiValues, handle: (entry: PerformanceEntry) => void) => {
    capabilities[key] = 0;
    if (!supported.includes(type)) return;
    try {
      const observer = new PerformanceObserver((list) => {
        if (!stopped) for (const entry of list.getEntries()) handle(entry);
      });
      const options: PerformanceObserverInit & { durationThreshold?: number } = { type, buffered: true };
      if (type === "event") options.durationThreshold = 100;
      observer.observe(options);
      observers.push(observer);
      capabilities[key] = 1;
    } catch (error) {
      console.warn("[performance] Could not observe", type, error);
    }
  };
  for (const [type, key] of [["longtask", "longtask"], ["long-animation-frame", "longAnimationFrame"], ["event", "eventTiming"]] as const) {
    observe(type, key, (entry) => {
      if (!visible() || entry.startTime < visibleSince) return;
      target.add({
        kind: "observer", name: type, startMs: entry.startTime, durationMs: entry.duration,
        spans: target.overlapping(entry.startTime, entry.startTime + entry.duration),
      });
    });
  }
  observe("paint", "paint", (entry) => {
    if (entry.name === "first-paint" || entry.name === "first-contentful-paint") {
      target.add({ kind: "milestone", name: entry.name, startMs: entry.startTime, durationMs: entry.duration });
    }
  });
  observe("navigation", "navigation", (entry) => {
    const navigation = entry as PerformanceNavigationTiming;
    for (const [name, durationMs] of [
      ["navigation.response", navigation.responseStart],
      ["navigation.dom-content-loaded", navigation.domContentLoadedEventEnd],
      ["navigation.load", navigation.loadEventEnd],
    ] as const) {
      if (Number.isFinite(durationMs) && durationMs > 0) target.add({ kind: "milestone", name, startMs: 0, durationMs });
    }
  });
  target.add({ kind: "capabilities", name: "capabilities", startMs: performance.now(), durationMs: 0, values: capabilities });
  const input = (event: Event) => {
    if (!event.isTrusted || !visible() || pendingInput) return;
    pendingInput = true;
    const startMs = performance.now();
    const frame = requestAnimationFrame(() => {
      const next = requestAnimationFrame(() => {
        pendingInput = false;
        if (visible() && startMs >= visibleSince) target.add({
          kind: "milestone", name: "input.next-frame", startMs, durationMs: performance.now() - startMs,
        });
      });
      inputFrame = next;
    });
    inputFrame = frame;
  };
  listen(window, "pointerdown", input);
  listen(window, "keydown", input);
  startSampling();
  const flushTimer = setInterval(flush, 3000);
  const summaryTimer = setInterval(() => { if (visible()) target.summarize(); }, 30_000);
  const cleanup = () => {
    if (stopped) return;
    stopped = true;
    for (const observer of observers) observer.disconnect();
    for (const cleanup of cleanups) cleanup();
    clearInterval(sampleTimer);
    clearInterval(flushTimer);
    clearInterval(summaryTimer);
    cancelAnimationFrame(inputFrame);
    flush();
    recorder = undefined;
    if (dispose === cleanup) dispose = undefined;
  };
  dispose = cleanup;
  return cleanup;
}
