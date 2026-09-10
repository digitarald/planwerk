import assert from "node:assert/strict";
import test from "node:test";

import {
  canApproveToolConfirmation,
  normalizeToolRiskAssessment,
  resolveToolConfirmationDecision,
  toolAuthenticationHandoff,
  toolConfirmationIntent,
} from "./tool-safety.ts";

test("tool authentication handoff redacts OAuth challenge data", () => {
  const handoff = toolAuthenticationHandoff({
    displayName: "GitHub MCP",
    toolName: "github.search",
    auth: {
      resource: "https://api.example.test/data?tenant=private",
      oauthClient: { clientId: "client-id", clientSecret: "super-secret" },
      requiredScopes: ["repo:read"],
    },
  });

  assert.deepEqual(handoff, {
    message: "Authentication required for GitHub MCP. Complete it in VS Code.",
    toolName: "GitHub MCP",
  });
  assert.doesNotMatch(JSON.stringify(handoff), /super-secret|client-id|tenant=private|repo:read/);
});

test("tool confirmation options reject unknown IDs and intents", () => {
  const toolCall = {
    options: [
      { id: "approve-once", kind: "approve" },
      { id: "deny", kind: "deny" },
      { id: "future", kind: "defer" },
    ],
  };

  assert.equal(toolConfirmationIntent("defer"), "unknown");
  assert.deepEqual(resolveToolConfirmationDecision(toolCall, true, "approve-once"), {
    ok: true,
    approved: true,
    selectedOptionId: "approve-once",
  });
  assert.deepEqual(resolveToolConfirmationDecision(toolCall, false, "approve-once"), {
    ok: false,
    error: "approved does not match the selected option intent",
  });
  assert.deepEqual(resolveToolConfirmationDecision(toolCall, true, "missing"), {
    ok: false,
    error: "optionId is not offered by this tool confirmation",
  });
  assert.deepEqual(resolveToolConfirmationDecision(toolCall, true, "future"), {
    ok: false,
    error: "optionId has an unsupported confirmation intent",
  });
});

test("result confirmations and loading tool safety remain fail-safe", () => {
  assert.deepEqual(
    resolveToolConfirmationDecision({ status: "pending-result-confirmation" }, false, undefined),
    { ok: true, approved: false },
  );
  assert.deepEqual(
    resolveToolConfirmationDecision({ status: "pending-result-confirmation" }, true, "approve"),
    { ok: false, error: "Result confirmations do not accept an optionId" },
  );

  const loading = normalizeToolRiskAssessment({ status: "loading", kind: "judge" } as never);
  assert.deepEqual(loading, { status: "loading" });
  assert.equal(canApproveToolConfirmation(loading), false);
  assert.deepEqual(
    resolveToolConfirmationDecision(
      { riskAssessment: { status: "loading" } },
      true,
      undefined,
    ),
    { ok: false, error: "Tool safety assessment is still loading; approval is unavailable" },
  );
  assert.deepEqual(
    resolveToolConfirmationDecision(
      { riskAssessment: { status: "loading" } },
      false,
      undefined,
    ),
    { ok: true, approved: false },
  );
  assert.equal(canApproveToolConfirmation(normalizeToolRiskAssessment({
    status: "complete",
    kind: "judge",
    reason: { markdown: "Safe after review" },
    safety: 1.2,
  } as never)), true);
});
