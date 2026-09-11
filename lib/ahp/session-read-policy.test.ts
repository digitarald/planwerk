import assert from "node:assert/strict";
import test from "node:test";

import {
  shouldEnrichSessionOnStartup,
  shouldReadLiveSessionState,
} from "./session-read-policy.ts";
import { AHPStatus } from "./types.ts";

test("reads live state only for active sessions", () => {
  assert.equal(shouldReadLiveSessionState(AHPStatus.Idle), false);
  assert.equal(shouldReadLiveSessionState(AHPStatus.Error), false);
  assert.equal(shouldReadLiveSessionState(AHPStatus.InProgress), true);
  assert.equal(shouldReadLiveSessionState(AHPStatus.InputNeeded), true);
});

test("never restores archived sessions", () => {
  assert.equal(
    shouldReadLiveSessionState(AHPStatus.IsArchived | AHPStatus.Idle),
    false,
  );
  assert.equal(
    shouldReadLiveSessionState(AHPStatus.IsArchived | AHPStatus.InProgress),
    false,
  );
});

test("cold startup never reads session state, even without a cache", () => {
  assert.equal(
    shouldEnrichSessionOnStartup(AHPStatus.Idle, false, false),
    false,
  );
  assert.equal(
    shouldEnrichSessionOnStartup(
      AHPStatus.IsArchived | AHPStatus.Idle,
      false,
      false,
    ),
    false,
  );
});

test("active startup reads only missing or stale details", () => {
  assert.equal(
    shouldEnrichSessionOnStartup(AHPStatus.InProgress, false, false),
    true,
  );
  assert.equal(
    shouldEnrichSessionOnStartup(AHPStatus.InProgress, true, false),
    true,
  );
  assert.equal(
    shouldEnrichSessionOnStartup(AHPStatus.InProgress, true, true),
    false,
  );
});
