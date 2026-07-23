import assert from "node:assert/strict";
import test from "node:test";

import {
  judgeWithTransport,
  parseJudgeResponse,
} from "./verdict-judge-core.ts";

test("parses consistent structured verdicts", () => {
  assert.deepEqual(
    parseJudgeResponse(
      '{"status":"failed","summary":"One blocker remains.","findings":["Missing authorization check."]}'
    ),
    {
      status: "failed",
      summary: "One blocker remains.",
      findings: ["Missing authorization check."],
    }
  );
  assert.deepEqual(
    parseJudgeResponse(
      '```json\n{"status":"passed","summary":"No blockers remain.","findings":[]}\n```'
    ),
    {
      status: "passed",
      summary: "No blockers remain.",
      findings: [],
    }
  );
});

test("rejects malformed or internally inconsistent verdicts", () => {
  assert.equal(parseJudgeResponse("not json"), null);
  assert.equal(
    parseJudgeResponse(
      '{"status":"passed","summary":"Looks good.","findings":["A blocker."]}'
    ),
    null
  );
  assert.equal(
    parseJudgeResponse(
      '{"status":"failed","summary":"Something is wrong.","findings":[]}'
    ),
    null
  );
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
    "needs-human"
  );
  assert.equal(
    (await judgeWithTransport("Review complete.", async () => "invalid")).status,
    "needs-human"
  );
  assert.equal(
    (
      await judgeWithTransport("Review complete.", async () => {
        throw new Error("timeout");
      })
    ).status,
    "needs-human"
  );
});
