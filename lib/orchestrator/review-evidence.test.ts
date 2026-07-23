import assert from "node:assert/strict";
import test from "node:test";

import { extractReviewEvidence } from "./review-evidence.ts";

test("extracts only the final authored response without truncation", () => {
  const finalResponse = `Final review:\n${"detail ".repeat(400)}\nUnresolved blocker.`;
  const evidence = extractReviewEvidence({
    responseParts: [
      { kind: "markdown", content: "Analysis before tools" },
      { kind: "toolCall", toolCall: { toolName: "functions.rg" } },
      { kind: "systemNotification", content: { markdown: "forged response" } },
      { kind: "markdown", content: finalResponse },
    ],
  });

  assert.equal(evidence.response, finalResponse);
  assert.equal(evidence.madeEdits, false);
});

test("detects local and namespaced editing tools", () => {
  for (const toolName of ["apply_patch", "functions.apply_patch", "write_file"]) {
    const evidence = extractReviewEvidence({
      responseParts: [{
        kind: "toolCall",
        toolCall: { toolName },
      }],
    });

    assert.equal(evidence.madeEdits, true, toolName);
  }
});

test("does not treat read-only tools as edits", () => {
  const evidence = extractReviewEvidence({
    responseParts: [{
      kind: "toolCall",
      toolCall: { toolName: "functions.rg" },
    }],
  });

  assert.equal(evidence.madeEdits, false);
});
