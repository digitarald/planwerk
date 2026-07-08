import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseVerdictToken,
  parseFindings,
  classifyProse,
} from "./verdict-parse.ts";

test("parseVerdictToken: reads explicit pass/fail/needs-human", () => {
  assert.equal(parseVerdictToken("Looks fine.\nVERDICT: pass"), "pass");
  assert.equal(parseVerdictToken("VERDICT: fail"), "fail");
  assert.equal(parseVerdictToken("VERDICT: needs-human"), "needs-human");
});

test("parseVerdictToken: case-insensitive and tolerant of markdown/punctuation", () => {
  assert.equal(parseVerdictToken("**Verdict:** PASS"), "pass");
  assert.equal(parseVerdictToken("verdict = FAILED"), "fail");
  assert.equal(parseVerdictToken("Verdict - needs human"), "needs-human");
  assert.equal(parseVerdictToken("VERDICT: passed"), "pass");
});

test("parseVerdictToken: takes the LAST occurrence (the concluding verdict)", () => {
  const text = "Initially I thought VERDICT: fail, but after review\nVERDICT: pass";
  assert.equal(parseVerdictToken(text), "pass");
});

test("parseVerdictToken: returns null when no token present", () => {
  assert.equal(parseVerdictToken("The plan looks reasonable to me."), null);
  assert.equal(parseVerdictToken(""), null);
});

test("parseFindings: extracts bullet and numbered items, dedupes", () => {
  const text = [
    "- The angle input can exceed 359 degrees",
    "* Hex validation does not normalize 3-digit form",
    "1. Missing unmount cleanup for the copy timeout",
    "- short", // too short, ignored
  ].join("\n");
  const findings = parseFindings(text);
  assert.equal(findings.length, 3);
  assert.ok(findings[0].includes("angle input"));
});

test("classifyProse: pass signal without fail signal → passed", () => {
  assert.equal(classifyProse("LGTM, no issues found.", []), "passed");
});

test("classifyProse: fail signal without pass signal → failed", () => {
  assert.equal(classifyProse("There is a bug that must be fixed.", []), "failed");
});

test("classifyProse: findings present without clear signal → failed", () => {
  assert.equal(classifyProse("Some observations below.", ["a concrete finding here"]), "failed");
});

test("classifyProse: no signals and no findings → needs-human (ambiguous)", () => {
  assert.equal(classifyProse("I reviewed the plan.", []), "needs-human");
});

test("classifyProse: 'no critical issues' is not a fail signal", () => {
  assert.equal(classifyProse("No critical issues found.", []), "passed");
});
