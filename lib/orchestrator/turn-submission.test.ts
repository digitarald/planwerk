import assert from "node:assert/strict";
import { test } from "node:test";

import { TurnSubmission } from "./turn-submission.ts";

test("a cancelled turn cannot cross the submission boundary", () => {
  const turn = new TurnSubmission();
  turn.cancel();
  assert.equal(turn.tryStart(false), false);
  assert.equal(turn.cancelled, true);
});

test("an already-aborted request is rejected immediately before send", () => {
  const turn = new TurnSubmission();
  assert.equal(turn.tryStart(true), false);
  assert.equal(turn.cancelled, true);
});
