export const UI_METRIC_NAMES = [
  "preload.start", "client.start", "shell.commit", "board.commit", "board.react-render", "workspace.commit", "board.paint-opportunity",
  "shell.paint-opportunity", "input.next-frame", "sse.connect", "sse.open", "sse.init",
  "sse.parse", "sse.apply", "board.hydrate", "board.storage-read", "board.storage-write",
  "board.storage-remove", "board.set-cards", "board.replace-card", "coordinator.hydrate",
  "navigation.response", "navigation.dom-content-loaded", "navigation.load",
  "first-paint", "first-contentful-paint", "longtask", "long-animation-frame", "event",
  "timer-lag", "sampling-gap", "capabilities", "window.resume", "runtime.summary",
] as const;
export type UiMetricName = typeof UI_METRIC_NAMES[number];
export const UI_METRIC_KINDS = ["milestone", "span", "stall", "observer", "summary", "capabilities", "discontinuity"] as const;
export type UiMetricKind = typeof UI_METRIC_KINDS[number];
export const UI_VALUE_KEYS = [
  "cards", "characters", "cached", "events", "longtask", "longAnimationFrame", "eventTiming",
  "paint", "navigation", "timerLag", "slowSpans", "maxSpanMs", "stalls", "maxStallMs",
  "dropped", "visible", "success", "reactProfiler",
] as const;
export type UiValues = Partial<Record<typeof UI_VALUE_KEYS[number], number>>;
export interface UiSpan {
  name: UiMetricName;
  startMs: number;
  durationMs: number;
}
export interface UiMetric extends UiSpan {
  kind: UiMetricKind;
  values?: UiValues;
  spans?: UiSpan[];
}
export interface UiPerformanceBatch {
  type: "performance";
  documentId: string;
  timeOrigin: number;
  records: UiMetric[];
  dropped: number;
}

export const UI_QUEUE_LIMIT = 40;
export const UI_BATCH_LIMIT = 8;
export const UI_SAMPLE_MS = 250;
export const UI_STALL_MS = 100;

const names = new Set<string>(UI_METRIC_NAMES);
const kinds = new Set<string>(UI_METRIC_KINDS);
const keys = new Set<string>(UI_VALUE_KEYS);
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function nonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function span(value: unknown): value is UiSpan {
  return record(value) && typeof value.name === "string" && names.has(value.name)
    && nonnegative(value.startMs) && nonnegative(value.durationMs)
    && Object.keys(value).every((key) => ["name", "startMs", "durationMs"].includes(key));
}

/** Reject unknown fields so browser diagnostics cannot smuggle paths or page content. */
export function isUiPerformanceBatch(value: unknown): value is UiPerformanceBatch {
  if (!record(value) || value.type !== "performance"
    || typeof value.documentId !== "string" || !/^[a-zA-Z0-9-]{1,64}$/.test(value.documentId)
    || !nonnegative(value.timeOrigin) || !Number.isSafeInteger(value.dropped) || Number(value.dropped) < 0
    || !Array.isArray(value.records) || value.records.length > UI_BATCH_LIMIT
    || !Object.keys(value).every((key) => ["type", "documentId", "timeOrigin", "records", "dropped"].includes(key))) return false;
  return value.records.every((entry: unknown) => {
    if (!record(entry) || typeof entry.name !== "string" || !names.has(entry.name)
      || typeof entry.kind !== "string" || !kinds.has(entry.kind)
      || !nonnegative(entry.startMs) || !nonnegative(entry.durationMs)
      || !Object.keys(entry).every((key) => ["name", "startMs", "durationMs", "kind", "values", "spans"].includes(key))) return false;
    if (entry.values !== undefined && (!record(entry.values)
      || !Object.entries(entry.values).every(([key, value]) => keys.has(key) && nonnegative(value)))) return false;
    return entry.spans === undefined || (Array.isArray(entry.spans) && entry.spans.length <= 6 && entry.spans.every(span));
  });
}

export class UiPerformanceRecorder {
  private readonly now: () => number;
  private readonly queue: UiMetric[] = [];
  private readonly spans: UiSpan[] = [];
  private readonly once = new Set<UiMetricName>();
  private baseline?: { mono: number; wall: number };
  private dropped = 0;
  private events = 0;
  private slowSpans = 0;
  private maxSpanMs = 0;
  private stalls = 0;
  private maxStallMs = 0;

  constructor(now: () => number) { this.now = now; }

  add(metric: UiMetric): void {
    if (this.queue.length >= UI_QUEUE_LIMIT) { this.queue.shift(); this.dropped++; }
    this.queue.push(metric);
  }

  mark(name: UiMetricName, values?: UiValues, onlyOnce = false): void {
    if (onlyOnce && this.once.has(name)) return;
    this.once.add(name);
    this.add({ kind: "milestone", name, startMs: this.now(), durationMs: 0, values });
  }

  begin(name: UiMetricName, values?: UiValues): () => void {
    const startMs = this.now();
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      const durationMs = Math.max(0, this.now() - startMs);
      this.events++;
      this.maxSpanMs = Math.max(this.maxSpanMs, durationMs);
      const measured = { name, startMs, durationMs };
      if (this.spans.length === 64) this.spans.shift();
      this.spans.push(measured);
      if (durationMs >= 16) {
        this.slowSpans++;
        this.add({ kind: "span", ...measured, values });
      }
    };
  }

  overlapping(startMs: number, endMs: number): UiSpan[] {
    return this.spans.filter((entry) => entry.startMs < endMs && entry.startMs + entry.durationMs > startMs)
      .sort((a, b) => b.durationMs - a.durationMs).slice(0, 6);
  }

  reset(wall: number): void { this.baseline = { mono: this.now(), wall }; }

  sample(wall: number, visible: boolean): boolean {
    const current = { mono: this.now(), wall };
    const previous = this.baseline;
    this.baseline = visible ? current : undefined;
    if (!visible || !previous) return false;
    const elapsed = current.mono - previous.mono;
    const wallElapsed = current.wall - previous.wall;
    if (elapsed > 5000 || elapsed < 0 || Math.abs(wallElapsed - elapsed) > 1000) {
      this.add({ kind: "discontinuity", name: "sampling-gap", startMs: Math.min(previous.mono, current.mono), durationMs: Math.max(0, elapsed) });
      return true;
    }
    const lag = elapsed - UI_SAMPLE_MS;
    if (lag < UI_STALL_MS) return false;
    this.stalls++;
    this.maxStallMs = Math.max(this.maxStallMs, lag);
    this.add({
      kind: "stall", name: "timer-lag", startMs: current.mono - lag, durationMs: lag,
      spans: this.overlapping(previous.mono, current.mono),
    });
    return false;
  }

  summarize(): void {
    this.add({
      kind: "summary", name: "runtime.summary", startMs: this.now(), durationMs: 0,
      values: { events: this.events, slowSpans: this.slowSpans, maxSpanMs: this.maxSpanMs, stalls: this.stalls, maxStallMs: this.maxStallMs },
    });
    this.events = this.slowSpans = this.maxSpanMs = this.stalls = this.maxStallMs = 0;
  }

  take(): { records: UiMetric[]; dropped: number } {
    const dropped = this.dropped;
    this.dropped = 0;
    return { records: this.queue.splice(0, UI_BATCH_LIMIT), dropped };
  }
}
