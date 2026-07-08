import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseBoolean,
  buildAnswer,
  buildFreeformAnswer,
  canCarryFreeform,
  type AnswerQuestion,
} from "./answer-value.ts";

const single = (
  options: { id: string; label: string; recommended?: boolean }[],
  allowFreeform = false,
): AnswerQuestion => ({ kind: "single-select", options, allowFreeform });

// ── parseBoolean ────────────────────────────────────────────────────────────

test("parseBoolean: recognizes affirmatives and negatives", () => {
  assert.equal(parseBoolean("yes"), true);
  assert.equal(parseBoolean("Approve it"), true);
  assert.equal(parseBoolean("no"), false);
  assert.equal(parseBoolean("Decline"), false);
  assert.equal(parseBoolean("maybe later"), null);
});

// ── buildAnswer (option-aware) ──────────────────────────────────────────────

test("buildAnswer: matches a single-select option by exact label or id", () => {
  const q = single([
    { id: "a", label: "Widen review" },
    { id: "b", label: "Apply fix now" },
  ]);
  assert.deepEqual(buildAnswer(q, "Apply fix now"), {
    value: { kind: "selected", value: "b" },
    display: "Apply fix now",
  });
  assert.deepEqual(buildAnswer(q, "a"), {
    value: { kind: "selected", value: "a" },
    display: "Widen review",
  });
});

test("buildAnswer: falls back to the recommended option when nothing matches", () => {
  const q = single([
    { id: "a", label: "Widen review" },
    { id: "b", label: "Apply fix now", recommended: true },
  ]);
  assert.deepEqual(buildAnswer(q, "something totally unrelated"), {
    value: { kind: "selected", value: "b" },
    display: "Apply fix now",
  });
});

test("buildAnswer: single-select with no match escalates (null) even when freeform is allowed", () => {
  // buildAnswer is strict option-matching; free-text delivery is buildFreeformAnswer's job.
  const q = single([{ id: "a", label: "Widen review" }], true);
  assert.equal(buildAnswer(q, "let me explain differently"), null);
});

test("buildAnswer: single-select with no match, no recommendation, no freeform → null", () => {
  const q = single([{ id: "a", label: "Widen review" }], false);
  assert.equal(buildAnswer(q, "zzz nonmatching"), null);
});

test("buildAnswer: boolean/number/text", () => {
  assert.deepEqual(buildAnswer({ kind: "boolean" }, "yes"), {
    value: { kind: "boolean", value: true },
    display: "Yes",
  });
  assert.deepEqual(buildAnswer({ kind: "number" }, "about 42 items"), {
    value: { kind: "number", value: 42 },
    display: "42",
  });
  assert.deepEqual(buildAnswer({ kind: "text" }, "hello"), {
    value: { kind: "text", value: "hello" },
    display: "hello",
  });
});

test("buildAnswer: multi-select is not auto-answered", () => {
  assert.equal(buildAnswer({ kind: "multi-select", options: [] }, "anything"), null);
});

// ── buildFreeformAnswer (prose delivery) ────────────────────────────────────

test("buildFreeformAnswer: text question carries prose as text", () => {
  assert.deepEqual(buildFreeformAnswer({ kind: "text" }, "critique"), {
    kind: "text",
    value: "critique",
  });
});

test("buildFreeformAnswer: single-select with freeform → selected + freeformValues", () => {
  assert.deepEqual(buildFreeformAnswer(single([{ id: "a", label: "A" }], true), "critique"), {
    kind: "selected",
    value: "",
    freeformValues: ["critique"],
  });
});

test("buildFreeformAnswer: single-select WITHOUT freeform cannot carry prose → null", () => {
  assert.equal(buildFreeformAnswer(single([{ id: "a", label: "A" }], false), "critique"), null);
});

test("buildFreeformAnswer: multi-select with freeform → selected-many + freeformValues", () => {
  assert.deepEqual(
    buildFreeformAnswer({ kind: "multi-select", options: [], allowFreeform: true }, "critique"),
    { kind: "selected-many", value: [], freeformValues: ["critique"] },
  );
});

test("buildFreeformAnswer: boolean/number cannot carry prose → null", () => {
  assert.equal(buildFreeformAnswer({ kind: "boolean" }, "critique"), null);
  assert.equal(buildFreeformAnswer({ kind: "number" }, "critique"), null);
});

test("canCarryFreeform mirrors buildFreeformAnswer", () => {
  assert.equal(canCarryFreeform({ kind: "text" }), true);
  assert.equal(canCarryFreeform(single([{ id: "a", label: "A" }], true)), true);
  assert.equal(canCarryFreeform(single([{ id: "a", label: "A" }], false)), false);
  assert.equal(canCarryFreeform({ kind: "boolean" }), false);
});
