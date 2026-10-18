import assert from "node:assert/strict";
import test from "node:test";
import { installUiPerformance, uiAfterPaint, uiMark, uiMeasure } from "./ui-performance-client.ts";
import type { UiPerformanceBatch } from "./ui-performance.ts";
import { observeBoardStorage } from "./ui-storage.ts";

test("browser lifecycle detects injected spans and observers, pauses hidden work, and cleans up", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 10_000 });
  let mono = 0;
  t.mock.method(performance, "now", () => mono);
  const packets: UiPerformanceBatch[] = [];
  const win = Object.assign(new EventTarget(), {
    __PLANWERK_DESKTOP__: true,
    __PLANWERK_PERFORMANCE_DISABLED__: false,
    __electrobunSendToHost: (packet: UiPerformanceBatch) => packets.push(packet),
  });
  const doc = Object.assign(new EventTarget(), { visibilityState: "visible" });
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  const descriptors = ["window", "document", "requestAnimationFrame", "cancelAnimationFrame", "PerformanceObserver"]
    .map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  const observers: FakeObserver[] = [];
  class FakeObserver {
    static supportedEntryTypes = ["longtask", "paint", "navigation"];
    readonly callback: (list: { getEntries: () => PerformanceEntry[] }) => void;
    type = "";
    disconnected = false;
    constructor(callback: FakeObserver["callback"]) { this.callback = callback; observers.push(this); }
    observe(options: PerformanceObserverInit) { this.type = options.type ?? ""; }
    disconnect() { this.disconnected = true; }
  }
  for (const [name, value] of Object.entries({
    window: win, document: doc, PerformanceObserver: FakeObserver,
    requestAnimationFrame: (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame; },
    cancelAnimationFrame: (id: number) => { frames.delete(id); },
  })) Object.defineProperty(globalThis, name, { value, configurable: true });
  t.after(() => {
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  });
  const stop = installUiPerformance();
  t.after(stop);
  const tick = (milliseconds: number) => { mono += milliseconds; t.mock.timers.tick(milliseconds); };
  uiMark("shell.commit");
  uiMeasure("sse.parse", () => { mono += 180; });
  tick(250);
  uiAfterPaint("board.paint-opportunity");
  for (let count = 0; count < 2; count++) {
    const pending = [...frames.values()];
    frames.clear();
    mono += 16;
    for (const callback of pending) callback(mono);
  }
  const observed = { name: "untrusted script URL", entryType: "longtask", startTime: 1, duration: 180, toJSON() {} };
  observers.find((observer) => observer.type === "longtask")!.callback({ getEntries: () => [observed] });
  tick(3000);
  const entries = packets.flatMap((packet) => packet.records);
  assert.ok(entries.some((entry) => entry.kind === "stall" && entry.spans?.some((span) => span.name === "sse.parse")));
  assert.ok(entries.some((entry) => entry.name === "longtask"));
  assert.ok(entries.some((entry) => entry.name === "board.paint-opportunity"));
  const capabilities = entries.find((entry) => entry.name === "capabilities")!;
  assert.equal(capabilities.values?.longtask, 1);
  assert.equal(capabilities.values?.eventTiming, 0);
  assert.doesNotMatch(JSON.stringify(packets), /untrusted script/);

  doc.visibilityState = "hidden";
  doc.dispatchEvent(new Event("visibilitychange"));
  tick(2000);
  doc.visibilityState = "visible";
  doc.dispatchEvent(new Event("visibilitychange"));
  tick(250);
  tick(3000);
  stop();
  assert.ok(observers.every((observer) => observer.disconnected));
  assert.equal(frames.size, 0);
  let before = packets.length;
  tick(30_000);
  assert.equal(packets.length, before);
  Object.defineProperty(globalThis, "PerformanceObserver", { value: undefined, configurable: true });
  const stopFallback = installUiPerformance();
  tick(3000);
  stopFallback();
  const fallback = packets.slice(before).flatMap((packet) => packet.records)
    .find((entry) => entry.kind === "capabilities")!;
  assert.equal(fallback.values?.timerLag, 1);
  assert.equal(fallback.values?.longtask, 0);
  assert.equal(fallback.values?.longAnimationFrame, 0);
  before = packets.length;
  win.__PLANWERK_PERFORMANCE_DISABLED__ = true;
  installUiPerformance();
  uiMeasure("sse.parse", () => { mono += 200; });
  tick(3000);
  assert.equal(packets.length, before);
});

test("storage timing preserves JSON persistence semantics and surfaces exceptions", () => {
  const values = new Map<string, { state: { hideDone: boolean } }>();
  const storage = observeBoardStorage({
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: { state: { hideDone: boolean } }) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  })!;
  storage.setItem("board", { state: { hideDone: true } });
  assert.deepEqual(storage.getItem("board"), { state: { hideDone: true } });
  storage.removeItem("board");
  assert.equal(storage.getItem("board"), null);
  assert.equal(observeBoardStorage(undefined), undefined);
  const broken = observeBoardStorage({ ...storage, getItem: () => { throw new Error("storage denied"); } })!;
  assert.throws(() => broken.getItem("board"), /storage denied/);
});
