import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isCardInAnyAutomationScope,
  isCardInAutomationScope,
  parseWorkspaceScope,
  UNASSIGNED_WORKSPACE,
} from "../automation-scope.ts";

const planwerk = { project: { path: "/repo/planwerk" } };
const other = { project: { path: "/repo/other" } };
const unassigned = {};

test("an unfiltered tab permits every workspace", () => {
  const scope = new Set<string>();
  assert.equal(isCardInAutomationScope(planwerk, scope), true);
  assert.equal(isCardInAutomationScope(other, scope), true);
  assert.equal(isCardInAutomationScope(unassigned, scope), true);
});

test("a filtered tab permits only its selected workspaces", () => {
  const scope = new Set(["/repo/planwerk"]);
  assert.equal(isCardInAutomationScope(planwerk, scope), true);
  assert.equal(isCardInAutomationScope(other, scope), false);
  assert.equal(isCardInAutomationScope(unassigned, scope), false);
});

test("the unassigned filter permits only unassigned cards", () => {
  const scope = new Set([UNASSIGNED_WORKSPACE]);
  assert.equal(isCardInAutomationScope(planwerk, scope), false);
  assert.equal(isCardInAutomationScope(unassigned, scope), true);
});

test("connected tab scopes are combined as a union", () => {
  const scopes = [new Set(["/repo/planwerk"]), new Set([UNASSIGNED_WORKSPACE])];
  assert.equal(isCardInAnyAutomationScope(planwerk, scopes), true);
  assert.equal(isCardInAnyAutomationScope(other, scopes), false);
  assert.equal(isCardInAnyAutomationScope(unassigned, scopes), true);
});

test("an unfiltered connected tab permits every card", () => {
  const scopes = [new Set(["/repo/planwerk"]), new Set<string>()];
  assert.equal(isCardInAnyAutomationScope(other, scopes), true);
});

test("an omitted scope preserves compatibility with unfiltered clients", () => {
  assert.deepEqual(parseWorkspaceScope('["/repo/planwerk", "__unassigned__"]'), new Set(["/repo/planwerk", UNASSIGNED_WORKSPACE]));
  assert.deepEqual(parseWorkspaceScope(null), new Set());
});

test("malformed scope query values fail closed", () => {
  assert.equal(parseWorkspaceScope('{"workspace":"/repo/planwerk"}'), null);
  assert.equal(parseWorkspaceScope("not-json"), null);
  assert.equal(parseWorkspaceScope(""), null);
  assert.equal(isCardInAnyAutomationScope(planwerk, [null]), false);
});
