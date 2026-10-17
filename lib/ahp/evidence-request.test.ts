import assert from "node:assert/strict";
import test from "node:test";
import { requestEvidenceRefresh } from "./evidence-request.ts";

test("explicit refresh sends intent and accepts only matching successful acknowledgements", async () => {
  const signal = new AbortController().signal;
  const fetcher: typeof fetch = async (_url, options) => {
    assert.equal(options?.signal, signal);
    assert.equal(options?.method, "POST");
    assert.deepEqual(JSON.parse(options?.body as string), { hostUrl: "ws://fake", sessionUri: "session-1" });
    return Response.json({ success: true, session: { resource: "session-1" } });
  };
  await requestEvidenceRefresh("ws://fake", "session-1", signal, fetcher);
  await assert.rejects(requestEvidenceRefresh("ws://fake", "session-1", signal, async () =>
    Response.json({ success: true, session: { resource: "other" } })), /failed/);
  await assert.rejects(requestEvidenceRefresh("ws://fake", "session-1", signal, async () =>
    Response.json(null)), /invalid response/);
});

test("failed refreshes preserve source-change explanations instead of success-shaped UI", async () => {
  await assert.rejects(requestEvidenceRefresh("ws://fake", "session-1", new AbortController().signal, async () =>
    Response.json({ success: false, reason: "changed" }, { status: 409 })), /changed during collection/);
  await assert.rejects(requestEvidenceRefresh("ws://fake", "session-1", new AbortController().signal, async () =>
    Response.json({ success: false, reason: "unavailable" }, { status: 409 })), /No current evidence/);
});
