import assert from "node:assert/strict";
import test from "node:test";
import { isUiPerformanceBatch, UiPerformanceRecorder, UI_BATCH_LIMIT, UI_QUEUE_LIMIT, type UiMetric } from "./ui-performance.ts";

function fixture() {
  let mono = 0;
  const recorder = new UiPerformanceRecorder(() => mono);
  const all = () => {
    const result: UiMetric[] = [];
    let dropped = 0;
    for (;;) {
      const batch = recorder.take();
      dropped += batch.dropped;
      result.push(...batch.records);
      if (!batch.records.length) return { records: result, dropped };
    }
  };
  return { recorder, set: (value: number) => { mono = value; }, all };
}

test("visible stalls include the slow application span, not network wait", () => {
  const { recorder, set, all } = fixture();
  recorder.reset(0);
  set(250);
  recorder.sample(250, true);
  set(480);
  const end = recorder.begin("sse.parse", { characters: 1000 });
  set(680);
  end();
  recorder.sample(680, true);
  const stall = all().records.find((entry) => entry.kind === "stall")!;
  assert.equal(stall.startMs, 500);
  assert.equal(stall.durationMs, 180);
  assert.equal(stall.startMs + stall.durationMs, 680);
  assert.deepEqual(stall.spans, [{ name: "sse.parse", startMs: 480, durationMs: 200 }]);
});

test("hidden windows, resume, sleep and clock changes never masquerade as hangs", () => {
  const { recorder, set, all } = fixture();
  recorder.reset(0);
  set(1000);
  recorder.sample(1000, false);
  set(2000);
  recorder.sample(2000, true);
  set(2250);
  recorder.sample(2250, true);
  set(10_000);
  recorder.sample(10_000, true);
  set(10_250);
  recorder.sample(100_000, true);
  const records = all().records;
  assert.equal(records.filter((entry) => entry.kind === "stall").length, 0);
  assert.equal(records.filter((entry) => entry.kind === "discontinuity").length, 2);
  assert.deepEqual(records.filter((entry) => entry.kind === "discontinuity")
    .map(({ startMs, durationMs }) => ({ startMs, durationMs })), [
    { startMs: 2250, durationMs: 7750 },
    { startMs: 10_000, durationMs: 250 },
  ]);
});

test("a backwards monotonic clock records a zero-length gap at the current sample", () => {
  const { recorder, set, all } = fixture();
  set(1000);
  recorder.reset(1000);
  set(500);
  assert.equal(recorder.sample(1250, true), true);
  assert.deepEqual(all().records, [
    { kind: "discontinuity", name: "sampling-gap", startMs: 500, durationMs: 0 },
  ]);
});

test("buffers and batches are bounded and explicitly count lost samples", () => {
  const { recorder, all } = fixture();
  for (let index = 0; index < 100; index++) recorder.mark("board.commit", { cards: index });
  const first = recorder.take();
  assert.equal(first.records.length, UI_BATCH_LIMIT);
  assert.equal(first.dropped, 100 - UI_QUEUE_LIMIT);
  const rest = all().records;
  assert.equal(rest.length, UI_QUEUE_LIMIT - UI_BATCH_LIMIT);
  assert.equal(rest.at(-1)?.values?.cards, 99);
});

test("fast work is aggregated, overlapping history bounded, and span ends idempotent", () => {
  const { recorder, set, all } = fixture();
  for (let index = 0; index < 100; index++) {
    set(index);
    const end = recorder.begin("board.storage-write");
    set(index + 1);
    end();
    end();
  }
  assert.equal(all().records.length, 0);
  assert.equal(recorder.overlapping(0, 1000).length, 6);
  recorder.summarize();
  const record = all().records[0];
  assert.equal(record.values?.events, 100);
  assert.equal(record.values?.maxSpanMs, 1);
  assert.equal(record.values?.slowSpans, 0);
  recorder.summarize();
  assert.equal(all().records[0].values?.events, 0);
});

test("native schema accepts only bounded numeric data and known metric names", () => {
  const entry = { kind: "span", name: "sse.parse", startMs: 1, durationMs: 100, values: { cards: 500 } };
  const batch = { type: "performance", documentId: "doc-one", timeOrigin: 1, records: [entry], dropped: 0 };
  assert.equal(isUiPerformanceBatch(batch), true);
  for (const value of [
    { ...batch, documentId: "/private/project" },
    { ...batch, secret: "private" },
    { ...batch, records: Array(9).fill(entry) },
    { ...batch, records: [{ ...entry, name: "private-card-title" }] },
    { ...batch, records: [{ ...entry, durationMs: Infinity }] },
    { ...batch, records: [{ ...entry, values: { url: "https://private" } }] },
    { ...batch, records: [{ ...entry, values: { cards: -1 } }] },
    { ...batch, records: [{ ...entry, spans: Array(7).fill({ name: "sse.parse", startMs: 0, durationMs: 10 }) }] },
  ]) assert.equal(isUiPerformanceBatch(value), false);
});
