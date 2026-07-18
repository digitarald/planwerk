import { test } from "node:test";
import assert from "node:assert/strict";

import {
  findChatInputEntry,
  findEntryById,
  findUniqueNewChatInputEntry,
  hasObservedInputNeeded,
  isInputObservedRemoved,
  type InputNeededEntryLike,
} from "./input-presence.ts";

// A realistic plan-approval `inputNeeded` entry: kind "chatInput", composite
// opaque `id`, and a `request` keyed by the question GUID.
const GUID = "254d19fd-0000-0000-0000-000000000000";
const planApproval: InputNeededEntryLike = {
  id: `chatInput:ahp-chat://session/1:${GUID}`,
  kind: "chatInput",
  request: { id: GUID },
};

test("findChatInputEntry: matches by request.id (the question GUID)", () => {
  assert.equal(findChatInputEntry([planApproval], GUID), planApproval);
});

test("findChatInputEntry: does not match the opaque composite id", () => {
  assert.equal(findChatInputEntry([planApproval], planApproval.id as string), undefined);
});

test("findChatInputEntry: ignores non-chatInput kinds", () => {
  const toolConfirm: InputNeededEntryLike = { id: "t1", kind: "toolConfirmation", request: { id: GUID } };
  assert.equal(findChatInputEntry([toolConfirm], GUID), undefined);
});

test("findEntryById: matches by the opaque composite id", () => {
  assert.equal(findEntryById([planApproval], planApproval.id as string), planApproval);
  assert.equal(findEntryById([planApproval], GUID), undefined);
});

test("isInputObservedRemoved: false while the plan-approval is still pending", () => {
  // Matched by request.id → still present → not resolved.
  assert.equal(isInputObservedRemoved([planApproval], GUID), false);
});

test("isInputObservedRemoved: true once the host consumes the request (applied)", () => {
  // This is the core regression: after a real accept, the entry leaves
  // `inputNeeded`, so success must be reported only here — not after a bare
  // dispatch+ping while the entry is still present.
  assert.equal(isInputObservedRemoved([], GUID), true);
  assert.equal(isInputObservedRemoved([{ id: "other", kind: "chatInput", request: { id: "different" } }], GUID), true);
});

test("isInputObservedRemoved: matches by opaque id too (never falsely 'applied')", () => {
  // An entry present only under its composite id must count as unresolved so a
  // real pending request isn't mistaken for an applied answer.
  const idOnly: InputNeededEntryLike = { id: GUID, kind: "chatInput" };
  assert.equal(isInputObservedRemoved([idOnly], GUID), false);
});

test("observed-removal predicates distinguish an unknown aggregate", () => {
  assert.equal(hasObservedInputNeeded([]), true);
  assert.equal(hasObservedInputNeeded(undefined), false);
  assert.equal(hasObservedInputNeeded(null), false);
  assert.equal(isInputObservedRemoved(undefined, GUID), false);
  assert.equal(isInputObservedRemoved(null, GUID), false);
  assert.equal(findChatInputEntry(undefined, GUID), undefined);
  assert.equal(findEntryById(null, GUID), undefined);
});

test("findUniqueNewChatInputEntry rejects concurrent candidates", () => {
  const known = new Set([GUID]);
  const followUp = {
    id: "chatInput:follow-up",
    kind: "chatInput",
    chat: "ahp-chat://plan",
    request: { id: "follow-up" },
  };
  assert.equal(
    findUniqueNewChatInputEntry([planApproval, followUp], "ahp-chat://plan", known),
    followUp,
  );
  assert.equal(
    findUniqueNewChatInputEntry(
      [planApproval, followUp, { ...followUp, id: "chatInput:concurrent", request: { id: "concurrent" } }],
      "ahp-chat://plan",
      known,
    ),
    undefined,
  );
});
