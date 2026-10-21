import assert from "node:assert/strict";
import test from "node:test";

import type { KanbanCard } from "../types.ts";
import { buildCrew, classifyWork, crewMemberFromCard, LOUNGE_CAPACITY } from "./crew.ts";

function card(overrides: Partial<KanbanCard> = {}): KanbanCard {
  return {
    id: "copilotcli:/one", title: "Offline support", phase: "build", runtime: "running",
    gateStatus: "pending", attention: "none", risk: "low", activity: "", additions: 0,
    deletions: 0, filesChanged: 0, planSteps: { total: 0, done: 0 }, modifiedAt: 1,
    ...overrides,
  } as KanbanCard;
}

test("the current tool decides what the agent is doing", () => {
  assert.deepEqual(classifyWork({ id: "1", name: "view" }, "Implementing sync"), { station: "archive", task: "Reading", detail: "view" });
  assert.equal(classifyWork({ id: "1", name: "rg" }, "").station, "scanner");
  assert.equal(classifyWork({ id: "1", name: "apply_patch" }, "").station, "engineering");
  assert.equal(classifyWork({ id: "1", name: "task" }, "").task, "Briefing helpers");
});

test("shell commands are classified by what they run", () => {
  const shell = (command: string) => classifyWork({ id: "1", name: "bash", command }, "");
  assert.equal(shell("npm test").task, "Running tests");
  assert.equal(shell("npm run build && npm test").station, "diagnostics");
  assert.equal(shell("npm run lint").task, "Running checks");
  assert.equal(shell("git commit -m x && git push").station, "comms");
  assert.equal(shell("npm install three").task, "Installing supplies");
  assert.equal(shell("git status").station, "archive");
  assert.deepEqual(shell("./scripts/do-thing.sh"), { station: "fabricator", task: "Running a command", detail: "./scripts/do-thing.sh" });
  assert.equal(shell("rg \"test\" lib").station, "scanner");
  assert.equal(shell("cat build.log").station, "archive");
  assert.equal(shell("git diff && npm test").station, "diagnostics");
  assert.equal(shell("cd lib && rg build").station, "scanner");
});

test("reported intent is the fallback when no tool is running", () => {
  assert.equal(classifyWork(undefined, "Exploring codebase").station, "archive");
  assert.equal(classifyWork(undefined, "Running tests").station, "diagnostics");
  assert.equal(classifyWork(undefined, "Implementing fix").station, "engineering");
  assert.deepEqual(classifyWork(undefined, "Thinking"), { station: "planning", task: "Thinking", detail: "Thinking" });
});

test("runtime status chooses the mode, never the phase", () => {
  assert.equal(crewMemberFromCard(card({ runtime: "input-needed" })).station, "bridge");
  assert.equal(crewMemberFromCard(card({ runtime: "input-needed", pendingInput: { requestId: "r", questions: [], kind: "toolConfirmation" } })).task, "Needs approval");
  assert.equal(crewMemberFromCard(card({ runtime: "error", activity: "Running tests" })).mode, "fault");
  assert.equal(crewMemberFromCard(card({ runtime: "idle", phase: "review" })).station, "lounge");
});

test("active subagents become helpers; finished ones do not", () => {
  const member = crewMemberFromCard(card({ workers: [
    { id: "a", title: "A", runtime: "running", isActive: true, history: [] },
    { id: "b", title: "B", runtime: "idle", isActive: false, history: [] },
  ] }));
  assert.equal(member.helpers, 1);
});

test("archived cards never board and the lounge has limited seats", () => {
  const cards = [
    card({ id: "archived", isArchived: true }),
    ...Array.from({ length: LOUNGE_CAPACITY + 2 }, (_, index) => card({ id: `idle-${index}`, runtime: "idle", modifiedAt: index })),
  ];
  const crew = buildCrew(cards);
  assert.equal(crew.members.length, LOUNGE_CAPACITY);
  assert.equal(crew.offDuty, 2);
  assert.equal(crew.members[0].id, `idle-${LOUNGE_CAPACITY + 1}`);
});
