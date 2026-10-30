import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { RendererHealth } from "./renderer-health.ts";

test("health probe requires a loaded document and its matching acknowledgement", async () => {
  const messages: unknown[] = [];
  let script = "";
  const health = new RendererHealth((value) => { script = value; });
  const result = health.check();
  assert.equal(health.check(), result);
  const context = {
    document: { readyState: "loading" },
    window: { __electrobunSendToHost: (value: unknown) => messages.push(value) },
  };
  runInNewContext(script, context);
  assert.equal(messages.length, 0);
  context.document.readyState = "complete";
  runInNewContext(script, context);
  assert.equal(messages.length, 1);
  health.receive(null);
  health.receive({ type: "renderer-health", id: "stale" });
  health.receive({ type: "diagnostic", id: Reflect.get(messages[0] as object, "id") });
  assert.equal(health.check(), result);
  health.receive(messages[0]);
  assert.equal(await result, true);
});

test("a missing acknowledgement times out and late messages cannot satisfy a new probe", async () => {
  const messages: unknown[] = [];
  const health = new RendererHealth((script) => runInNewContext(script, {
    document: { readyState: "interactive" },
    window: { __electrobunSendToHost: (value: unknown) => messages.push(value) },
  }), 20);
  assert.equal(await health.check(), false);
  const next = health.check();
  health.receive(messages[0]);
  assert.equal(health.check(), next);
  health.receive(messages[1]);
  assert.equal(await next, true);
});

test("cancelling during shutdown or navigation settles the pending probe", async () => {
  const health = new RendererHealth(() => {});
  const pending = health.check();
  health.cancel();
  assert.equal(await pending, null);
  health.cancel();
  const next = health.check();
  assert.notEqual(next, pending);
  health.cancel();
  assert.equal(await next, null);
});

test("native execution failures are surfaced and do not leave a pending check", async () => {
  const health = new RendererHealth(() => { throw new Error("Native bridge unavailable"); });
  await assert.rejects(health.check(), /Native bridge unavailable/);
  await assert.rejects(health.check(), /Native bridge unavailable/);
});
