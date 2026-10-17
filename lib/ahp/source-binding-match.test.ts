import assert from "node:assert/strict";
import { test } from "node:test";
import { sourceBindingsMatch, sourceEvidenceRevision } from "./source-binding-match.ts";

const legacy = { sourceRevision: "catalog-fence", planVersion: "plan-time", contentRevision: "manifest" };
const captured = { ...legacy, manifestRevision: "manifest", evidenceDigest: "captured-digest" };

test("pure binding comparison preserves aliases without conflating digest with observation", () => {
  assert.equal(sourceBindingsMatch(legacy, { ...legacy, manifestRevision: "manifest" }), true);
  assert.equal(sourceBindingsMatch(legacy, {
    sourceRevision: legacy.sourceRevision, planVersion: legacy.planVersion, manifestRevision: "manifest",
  }), true);
  assert.equal(sourceBindingsMatch(captured, { ...captured }), true);
  assert.equal(sourceEvidenceRevision(legacy), "catalog-fence");
  assert.equal(sourceEvidenceRevision(captured), "captured-digest");
  assert.equal(sourceBindingsMatch(captured, { ...captured, planVersion: "new-time" }), false);
  assert.equal(sourceBindingsMatch(captured, { ...captured, sourceRevision: "new-fence" }), false);
});

test("missing, invalid and mismatched source binding fields fail closed", () => {
  for (const candidate of [
    undefined, {}, { ...captured, evidenceDigest: "" }, { ...captured, evidenceDigest: "different" },
    { ...captured, evidenceDigest: undefined }, { ...captured, manifestRevision: 7 },
    { ...captured, contentRevision: "different" },
  ]) assert.equal(sourceBindingsMatch(captured, candidate), false);
});
