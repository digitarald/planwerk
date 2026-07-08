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
  assert.equal(parseVerdictToken("VERDICT: pass."), "pass"); // trailing period
  assert.equal(parseVerdictToken("- VERDICT: fail"), "fail"); // list marker
});

test("parseVerdictToken: takes the LAST standalone verdict line", () => {
  const text = "Initially I thought VERDICT: fail, but after review\nVERDICT: pass";
  assert.equal(parseVerdictToken(text), "pass");
});

test("parseVerdictToken: returns null when no token present", () => {
  assert.equal(parseVerdictToken("The plan looks reasonable to me."), null);
  assert.equal(parseVerdictToken(""), null);
});

test("parseVerdictToken: ignores inline mentions and quoted examples (no false positives)", () => {
  // Only a standalone verdict line counts — prose that quotes/discusses the
  // contract must not be parsed as the machine verdict.
  assert.equal(parseVerdictToken("Use VERDICT: pass, VERDICT: fail, or VERDICT: needs-human"), null);
  assert.equal(parseVerdictToken("It is not safe to say VERDICT: pass"), null);
  assert.equal(parseVerdictToken("No final token, just discussing VERDICT: pass tokens."), null);
});

test("parseVerdictToken: real reviewer output — findings then a concluding line", () => {
  const text = [
    "I reviewed the plan.",
    "- The angle input could exceed 359 degrees.",
    "The plan is otherwise solid.",
    "",
    "VERDICT: pass",
  ].join("\n");
  assert.equal(parseVerdictToken(text), "pass");
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
