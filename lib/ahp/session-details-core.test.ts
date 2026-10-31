import assert from "node:assert/strict";
import test from "node:test";

import {
  matchesResumableTurn,
  projectSessionDetails,
} from "./session-details-core.ts";

test("hidden default chats cannot disclose transcript or error content", () => {
  assert.deepEqual(projectSessionDetails({ defaultChat: "hidden" }, {
    resource: "hidden", interactivity: "hidden",
    turns: [{ id: "turn", state: "complete", responseParts: [{ kind: "markdown", content: "Private" }] }],
  }), {});
  assert.deepEqual(projectSessionDetails({ defaultChat: "hidden", chats: [{ resource: "hidden", interactivity: "hidden" }] }, {
    resource: "hidden", turns: [{ id: "turn", state: "complete", responseParts: [{ kind: "markdown", content: "Private" }] }],
  }), {});
});

test("projects final agent markdown for zero-file completion sessions", () => {
  const details = projectSessionDetails(
    { defaultChat: "ahp-chat://default/session" },
    {
      resource: "ahp-chat://default/session",
      turns: [{
        id: "turn-1",
        state: "complete",
        responseParts: [{ kind: "markdown", content: "Research complete." }],
      }],
    },
  );

  assert.equal(details.lastAgentMessage, "Research complete.");
  assert.equal(details.runtimeError, undefined);
  assert.deepEqual(details.outcomeEvidence, {
    chatUri: "ahp-chat://default/session", turnId: "turn-1", state: "complete",
    text: "Research complete.", truncated: false,
  });
});

test("a previous response cannot masquerade as the latest delegated turn; long outcomes disclose truncation", () => {
  const previous = { id: "previous", state: "complete", responseParts: [{ kind: "markdown", content: "Old result" }] };
  const latest = { id: "latest", state: "complete", responseParts: [] };
  const details = projectSessionDetails({ defaultChat: "chat" }, { turns: [previous, latest] });
  assert.equal(details.lastAgentMessage, "Old result");
  assert.equal(details.outcomeEvidence, undefined);
  const long = projectSessionDetails({ defaultChat: "chat" }, {
    turns: [{ ...latest, responseParts: [{ kind: "markdown", content: "x".repeat(9000) }] }],
  });
  assert.equal(long.outcomeEvidence?.text.length, 8000);
  assert.equal(long.outcomeEvidence?.truncated, true);
});

test("projects the latest errored turn and its resume identity", () => {
  const details = projectSessionDetails(
    { defaultChat: "ahp-chat://default/session" },
    {
      resource: "ahp-chat://default/session",
      turns: [{
        id: "turn-2",
        startedAt: "2026-09-23T20:00:00.000Z",
        state: "error",
        responseParts: [{
          kind: "error",
          error: {
            errorType: "invalid-input-item",
            message: "Input item does not belong to this connection",
            stack: "stack",
          },
          resumable: true,
        }],
      }],
    },
  );

  assert.deepEqual(details.runtimeError, {
    source: "turn",
    errorType: "invalid-input-item",
    message: "Input item does not belong to this connection",
    stack: "stack",
    chatUri: "ahp-chat://default/session",
    turnId: "turn-2",
    startedAt: "2026-09-23T20:00:00.000Z",
    resumable: true,
  });
  assert.equal(
    matchesResumableTurn(
      details,
      "ahp-chat://default/session",
      "turn-2",
    ),
    true,
  );
  assert.equal(
    matchesResumableTurn(
      details,
      "ahp-chat://default/session",
      "stale-turn",
    ),
    false,
  );
});

test("falls back to creation errors without inventing resumability", () => {
  const details = projectSessionDetails({
    creationError: {
      errorType: "provider-start",
      message: "Provider failed to start",
    },
  });

  assert.deepEqual(details.runtimeError, {
    source: "creation",
    errorType: "provider-start",
    message: "Provider failed to start",
    stack: undefined,
    resumable: false,
  });
});

test("ignores malformed and non-final turn error parts", () => {
  const details = projectSessionDetails(
    {},
    {
      turns: [{
        id: "turn-3",
        state: "error",
        responseParts: [
          {
            kind: "error",
            error: { errorType: "old", message: "Superseded error" },
            resumable: true,
          },
          { kind: "markdown", content: "Recovered response" },
        ],
      }],
    },
  );

  assert.equal(details.runtimeError, undefined);
  assert.equal(details.lastAgentMessage, "Recovered response");
});
