import assert from "node:assert/strict";
import test from "node:test";

import { judgeWithTransport } from "./verdict-judge-core.ts";

test("accepts typed verdicts and normalizes display text", async () => {
  assert.deepEqual(
    await judgeWithTransport("Review complete.", async () => ({
      status: "failed",
      summary: " One blocker remains. ",
      findings: [" Missing authorization check. "],
    })),
    {
      status: "failed",
      summary: "One blocker remains.",
      findings: ["Missing authorization check."],
    },
  );
  assert.equal(
    (await judgeWithTransport("Review complete.", async () => ({
      status: "passed", summary: "No blockers remain.", findings: [],
    }))).status,
    "passed",
  );
});

test("rejects text envelopes and internally inconsistent verdicts", async () => {
  for (const response of [
    "not json",
    '{"status":"passed","summary":"Looks good.","findings":[]}',
    { status: "passed", summary: "Looks good.", findings: ["A blocker."] },
    { status: "failed", summary: "Something is wrong.", findings: [] },
    { status: "passed", summary: " ", findings: [] },
    { status: "failed", summary: "A blocker.", findings: [42] },
  ]) {
    assert.equal(
      (await judgeWithTransport("Review complete.", async () => response)).status,
      "needs-human",
    );
  }
});

test("fails closed for missing, empty, invalid, and rejected judge responses", async () => {
  let calls = 0;
  const unusedTransport = async () => {
    calls++;
    return undefined;
  };
  assert.equal((await judgeWithTransport(undefined, unusedTransport)).status, "needs-human");
  assert.equal(calls, 0);
  assert.equal(
    (await judgeWithTransport("Review complete.", async () => undefined)).status,
    "needs-human",
  );
  assert.equal(
    (await judgeWithTransport("Review complete.", async () => {
      throw new Error("timeout");
    })).status,
    "needs-human",
  );
});

test("caps displayed findings without truncating before semantic validation", async () => {
  const findings = Array.from({ length: 12 }, (_, index) => `Blocker ${index}`);
  const result = await judgeWithTransport("Review.", async () => ({
    status: "failed", summary: "Blockers remain.", findings,
  }));
  assert.deepEqual(result.findings, findings.slice(0, 10));
});
