import assert from "node:assert/strict";
import test from "node:test";
import { AssessmentLane } from "./assessment-lane.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
test("shares identical facts, bounds concurrency, and supersedes queued obsolete work", async () => {
  const lane = new AssessmentLane<number>(1, 2);
  let finish!: (value: number) => void;
  let calls = 0;
  const first = lane.run("a", "v1", async () => { calls++; return new Promise<number>((resolve) => { finish = resolve; }); });
  const duplicate = lane.run("a", "v1", async () => { throw new Error("duplicate"); });
  const superseded = lane.run("b", "v1", async () => { throw new Error("obsolete"); });
  const rejected = assert.rejects(superseded, /superseded/);
  const latest = lane.run("b", "v2", async () => { calls++; return 2; });
  await tick();
  assert.equal(calls, 1);
  finish(1);
  assert.deepEqual(await Promise.all([first, duplicate, latest]), [1, 1, 2]);
  await rejected;
  assert.equal(calls, 2);
});

test("queue overflow is explicit and failures do not stall following work", async () => {
  const lane = new AssessmentLane<number>(1, 1);
  let finish!: () => void;
  const first = lane.run("a", "1", async () => new Promise<number>((_resolve, reject) => { finish = () => reject(new Error("model unavailable")); }));
  const failed = assert.rejects(first, /model unavailable/);
  const queued = lane.run("b", "1", async () => 2);
  await assert.rejects(lane.run("c", "1", async () => 3), /queue is full/);
  await tick();
  finish();
  await failed;
  assert.equal(await queued, 2);
});

test("different revisions of one card are serialized without blocking an independent card", async () => {
  const lane = new AssessmentLane<number>(2);
  let finish!: (value: number) => void;
  const calls: string[] = [];
  const first = lane.run("a", "1", async () => {
    calls.push("a1");
    return new Promise<number>((resolve) => { finish = resolve; });
  });
  const next = lane.run("a", "2", async () => { calls.push("a2"); return 2; });
  const independent = lane.run("b", "1", async () => { calls.push("b1"); return 3; });
  await tick();
  assert.deepEqual(calls, ["a1", "b1"]);
  finish(1);
  assert.deepEqual(await Promise.all([first, next, independent]), [1, 2, 3]);
});
