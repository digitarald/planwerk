import assert from "node:assert/strict";
import { test } from "node:test";

import {
  closeCtoApprovals,
  type FeedItem,
} from "./orchestrator-store.ts";

test("stream termination expires only approval items owned by that stream", () => {
  const items: FeedItem[] = [
    {
      id: "approval-1",
      type: "approval-required",
      message: "Approve",
      timestamp: 1,
      approval: {
        decisionCapability: "cap-1",
        toolName: "override_phase",
        riskLevel: "high",
        action: {},
        facts: {},
        expiresAtMs: 60_000,
      },
    },
    {
      id: "approval-2",
      type: "approval-required",
      message: "Other stream",
      timestamp: 2,
      approval: {
        decisionCapability: "cap-2",
        toolName: "override_phase",
        riskLevel: "high",
        action: {},
        facts: {},
        expiresAtMs: 120_000,
      },
    },
  ];

  const closed = closeCtoApprovals(items, new Set(["cap-1"]));
  assert.equal(closed[0].type, "alert");
  assert.equal(closed[0].approval, undefined);
  assert.equal(closed[1].approval?.decisionCapability, "cap-2");
});
