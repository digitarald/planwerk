import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { monitorServerPerformance } from "./server-performance.ts";

test("server runtime metrics expose event-loop latency, utilization and memory with removable monitoring", async (t) => {
  const records: Array<Record<string, unknown>> = [];
  t.mock.method(console, "info", (_label: string, json: string) => records.push(JSON.parse(json)));
  const stop = monitorServerPerformance(30);
  t.after(stop);
  await delay(120);
  stop();
  assert.ok(records.length > 0);
  const record = records[0];
  assert.equal(record.metric, "server.runtime");
  for (const key of ["eventLoopMaxMs", "eventLoopP99Ms", "eventLoopUtilization", "rssBytes", "heapUsedBytes", "uptimeSeconds"]) {
    assert.equal(typeof record[key], "number", key);
    assert.ok(Number.isFinite(record[key]) && Number(record[key]) >= 0, key);
  }
  assert.ok(Number(record.eventLoopUtilization) <= 1);
  const count = records.length;
  await delay(60);
  assert.equal(records.length, count);
});
