import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { ToolInvocation, ToolResultObject } from "@github/copilot-sdk";

import type { KanbanCard, Phase } from "../types.ts";
import { createOrchestratorSdkTools } from "./orchestrator-tools.ts";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const originalCwd = process.cwd();
const scratchRoot = path.join(
  repositoryRoot,
  ".test-runs",
  `native-tool-routing-${process.pid}`,
);

mkdirSync(scratchRoot, { recursive: true });
process.chdir(scratchRoot);

registerHooks({
  resolve(specifier, context, nextResolve) {
    const virtualModules: Record<string, string> = {
      "@/lib/ahp/session-messenger":
        "export async function injectMessage(){return {success:false}};" +
        "export async function answerInput(){return {success:false}}",
      "./review-executor":
        "export async function startReview(){throw new Error('startReview service required')}",
      "./risk-assessor":
        "export async function assessRisk(){return {level:'high',factors:[]}}",
      "./risk-store":
        "export function getRiskForAutomation(){return 'high'};" +
        "export function getAuthoritativeRiskSnapshot(){return null};" +
        "export function persistAuthoritativeRisk(){return true}",
      "./risk-reassessment":
        "export async function reassessAndPersistRisk(){throw new Error('not implemented in routing test')}",
      "./cto-override-authorization":
        "export function authorizeAndRunOverride(){return {authorized:false,reason:'not implemented'}};" +
        "export function getAuthoritativeApprovalBinding(){return null}",
      "../inbox/service": "export function projectCoordinatorGoalToInbox(){}",
      "../ahp/create-session": "export async function createAndStartSession(){throw new Error('test has no live host')}",
      "./auto-answerer": "export async function submitAuthorizedAnswer(){return {answered:false,reason:'Human input required'}}",
    };
    if (virtualModules[specifier]) {
      return {
        shortCircuit: true,
        url: `data:text/javascript,${encodeURIComponent(virtualModules[specifier])}`,
      };
    }
    if (specifier === "server-only") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export%20{}",
      };
    }
    if (specifier.startsWith("@/")) {
      const unresolved = path.join(repositoryRoot, specifier.slice(2));
      const candidates = [
        unresolved,
        `${unresolved}.ts`,
        `${unresolved}.tsx`,
        path.join(unresolved, "index.ts"),
      ];
      const resolved = candidates.find((candidate) => existsSync(candidate));
      if (!resolved) {
        throw new Error(`Cannot resolve test alias ${specifier}`);
      }
      return {
        shortCircuit: true,
        url: pathToFileURL(resolved).href,
      };
    }
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (
        !specifier.startsWith(".")
        || !context.parentURL?.startsWith("file:")
        || path.extname(specifier)
      ) {
        throw error;
      }
      const unresolved = path.resolve(
        path.dirname(fileURLToPath(context.parentURL)),
        specifier,
      );
      const resolved = [
        `${unresolved}.ts`,
        `${unresolved}.tsx`,
        path.join(unresolved, "index.ts"),
      ].find((candidate) => existsSync(candidate));
      if (!resolved) throw error;
      return {
        shortCircuit: true,
        url: pathToFileURL(resolved).href,
      };
    }
  },
});

const [
  { executeToolCall },
  {
    canAdvancePhase,
    completeGateRun,
    getGatesForTransition,
    startGateRun,
  },
  { getDb },
] = await Promise.all([
  import("./tool-executor.ts"),
  import("./gate-engine.ts"),
  import("../db/schema.ts"),
]);

const db = getDb();
const hostUrl = "vscode-local://desktop";
const { registerCoordinatorHostReader } = await import("./coordinator-hosts.ts");
const { setCoordinatorDefaultMode, setCoordinatorSessionOverride } = await import("./coordinator-mode-store.ts");
setCoordinatorDefaultMode("coordinate");

test("a failed goal notification reports that the command was saved and retry reuses its receipt", async () => {
  const { manageCoordinatorGoal, listCoordinatorGoals } = await import("./coordinator-goal-service.ts");
  const { coordinatorGoalEvents } = await import("./coordinator-goal-events.ts");
  registerCoordinatorHostReader(() => ({ generation: 1, cards: [card("goal-notification", "build")], scopes: [new Set<string>()] }));
  const scope = { hostUrl, workspaceScope: [] };
  const args = { action: "create", objective: "Verify integration", acceptanceCriteria: "Tests pass" };
  const unsubscribe = coordinatorGoalEvents.subscribe(() => { throw new Error("Subscriber failed"); });
  try {
    assert.throws(() => manageCoordinatorGoal(scope, args, "notification-command"), /Goal saved.*Reload goals/);
  } finally { unsubscribe(); }
  const saved = listCoordinatorGoals(scope);
  assert.equal(saved.length, 1);
  const retried = manageCoordinatorGoal(scope, args, "notification-command");
  assert.equal(retried.id, saved[0].id);
  assert.equal(retried.revision, saved[0].revision);
  assert.equal(listCoordinatorGoals(scope).length, 1);
  for (const authority of [{ signal: AbortSignal.abort() }, { isCurrent: () => false }]) {
    const stopped = await executeToolCall("manage_goal", args, {
      ...scope, cards: [], idempotencyKey: "cancelled-goal", sdkSessionId: "test", toolCallId: "cancelled-goal",
      ...authority,
    });
    assert.equal(stopped.success, false);
    assert.equal(listCoordinatorGoals(scope).length, 1);
  }
});

test("nested folders pick up custom YAML gates, scripts, and review policy", async () => {
  const project = path.join(scratchRoot, "custom-project");
  const nested = path.join(project, "packages", "app");
  mkdirSync(path.join(project, ".github"), { recursive: true });
  mkdirSync(nested, { recursive: true });
  writeFileSync(path.join(project, ".github", "planwerk.yaml"), `
scripts:
  - name: Local check
    command: npm run check:local
gates:
  build-to-review:
    required:
      - type: script
        name: Local check
review_policy:
  medium:
    auto_approve_plan: true
risk_assessment:
  guidance: Consider recovery cost in this local-only tool.
`);
  const gates = getGatesForTransition("build", "review", nested, "medium");
  assert.equal(gates.length, 1);
  assert.equal(gates[0].gateName, "Local check");
  assert.equal(gates[0].command, "npm run check:local");
  const { loadConfig } = await import("./skill-config.ts");
  const config = loadConfig(nested);
  assert.equal(config.reviewPolicy.medium.autoApprovePlan, true);
  assert.equal(config.riskAssessment.guidance, "Consider recovery cost in this local-only tool.");
});

after(() => {
  process.chdir(originalCwd);
  rmSync(scratchRoot, { recursive: true, force: true });
});

function invocation(toolName: string, toolCallId: string): ToolInvocation {
  return {
    sessionId: "native-routing-session",
    toolCallId,
    toolName,
    arguments: {},
  };
}

function card(id: string, phase: Phase): KanbanCard {
  return {
    id,
    title: `Card ${id}`,
    phase,
    runtime: "idle",
    gateStatus: "pending",
    attention: "none",
    risk: "low",
    activity: "Ready",
    additions: 2,
    deletions: 1,
    filesChanged: 1,
    changesetVerified: true,
    sourceRevision: `${id}-source`,
    planContentHash: `plan:${id}-plan`,
    planSteps: { total: 1, done: 0 },
    modifiedAt: Date.now(),
    workingDirectory: repositoryRoot,
    project: { path: repositoryRoot, name: "test" },
  };
}

function seedAuthoritativeRevision(value: KanbanCard): string {
  const sourceRevision = value.sourceRevision!;
  const planVersion = `${value.id}-version`;
  const contentRevision = `${value.id}-content`;
  db.prepare(`
    INSERT OR REPLACE INTO card_phases (card_id, phase) VALUES (?, ?)
  `).run(value.id, value.phase);
  db.prepare(`
    INSERT OR REPLACE INTO session_cache (
      session_uri, host_url, summary_json, enrichment_json
    ) VALUES (?, ?, ?, ?)
  `).run(
    value.id,
    hostUrl,
    JSON.stringify({
      resource: value.id,
      _planwerkRiskFacts: {
        sourceRevision,
        planVersion,
        contentRevision,
      },
    }),
    JSON.stringify({
      changesetVerified: true,
      totalFileCount: value.filesChanged,
      additions: value.additions,
      deletions: value.deletions,
      planContentHash: value.planContentHash,
      _planwerkSource: {
        sourceRevision,
        planVersion,
        contentRevision,
      },
    }),
  );
  return value.phase === "plan"
    ? value.planContentHash!
    : `source:${encodeURIComponent(sourceRevision)}`;
}

function nativeTools(
  cards: KanbanCard[],
  services: NonNullable<Parameters<typeof executeToolCall>[2]["services"]>,
) {
  registerCoordinatorHostReader((host) => host === hostUrl ? ({ generation: 1, cards, scopes: [new Set<string>()] }) : undefined);
  const executeGateCommand: NonNullable<Parameters<typeof executeToolCall>[2]["services"]>["executeGateCommand"] =
    (runId, _command, _directory, onComplete) => {
      completeGateRun(runId, "passed", "configured check passed");
      onComplete?.("passed");
    };
  return createOrchestratorSdkTools({
    dispatch: (toolName, args, auditKey, toolInvocation) =>
      executeToolCall(toolName, args, {
        hostUrl,
        workspaceScope: [],
        cards,
        idempotencyKey: auditKey,
        sdkSessionId: toolInvocation.sessionId,
        toolCallId: toolInvocation.toolCallId,
        services: { executeGateCommand, ...services },
      }),
  });
}

test("native trigger_gate stores the configured name and authoritative revision, then satisfies that gate", async () => {
  const value = card("gate-card", "build");
  const expectedRevision = seedAuthoritativeRevision(value);
  let injections = 0;
  const tool = nativeTools([value], {
    injectMessage: async () => {
      injections++;
      return { success: true, queued: false, turnId: "gate-turn" };
    },
  }).find((candidate) => candidate.name === "trigger_gate")!;
  const toolInvocation = invocation("trigger_gate", "gate-call");

  const first = await tool.handler!(
    { cardId: value.id, gateType: "lint" },
    toolInvocation,
  ) as ToolResultObject;
  const second = await tool.handler!(
    { cardId: value.id, gateType: "lint" },
    toolInvocation,
  ) as ToolResultObject;

  assert.equal(first.resultType, "success");
  assert.deepEqual(
    JSON.parse(second.textResultForLlm),
    JSON.parse(first.textResultForLlm),
  );
  assert.equal(injections, 0);
  const rows = db.prepare(`
    SELECT id, from_phase, to_phase, gate_type, gate_name, changeset_ref
    FROM gate_runs WHERE card_id = ?
  `).all(value.id) as Array<Record<string, string | number | null>>;
  assert.equal(rows.length, 1);
  const runId = rows[0].id as number;
  assert.deepEqual(rows, [{
    id: runId,
    from_phase: "build",
    to_phase: "review",
    gate_type: "lint",
    gate_name: "Lint",
    changeset_ref: expectedRevision,
  }]);
  assert.equal(completeGateRun(runId, "passed", "lint passed"), false);

  const { pendingGates } = canAdvancePhase(
    value.id,
    "build",
    "review",
    repositoryRoot,
    "high",
    expectedRevision,
  );
  assert.equal(
    pendingGates.some((gate) => gate.gateName === "Lint"),
    false,
  );
});

for (const scenario of [
  { gateType: "typecheck", gateName: "Type Check" },
  { gateType: "test", gateName: "Test" },
] as const) {
  test(`native trigger_gate resolves and satisfies the named ${scenario.gateName} gate`, async () => {
    const value = card(`gate-${scenario.gateType}`, "build");
    const expectedRevision = seedAuthoritativeRevision(value);
    const tool = nativeTools([value], {
      injectMessage: async () => ({
        success: true,
        queued: false,
        turnId: `${scenario.gateType}-turn`,
      }),
    }).find((candidate) => candidate.name === "trigger_gate")!;

    const result = await tool.handler!(
      { cardId: value.id, gateType: scenario.gateType },
      invocation("trigger_gate", `${scenario.gateType}-call`),
    ) as ToolResultObject;
    assert.equal(result.resultType, "success");

    const row = db.prepare(`
      SELECT id, gate_name, changeset_ref
      FROM gate_runs WHERE card_id = ?
    `).get(value.id) as {
      id: number;
      gate_name: string | null;
      changeset_ref: string | null;
    };
    assert.equal(row.gate_name, scenario.gateName);
    assert.equal(row.changeset_ref, expectedRevision);
    assert.equal(completeGateRun(row.id, "passed", "gate passed"), false);

    const { pendingGates } = canAdvancePhase(
      value.id,
      "build",
      "review",
      repositoryRoot,
      "high",
      expectedRevision,
    );
    assert.equal(
      pendingGates.some((gate) => gate.gateName === scenario.gateName),
      false,
    );
  });
}

test("native trigger_gate rejects a configured name that does not match its type", async () => {
  const value = card("gate-name-mismatch", "build");
  seedAuthoritativeRevision(value);
  let injections = 0;
  const tool = nativeTools([value], {
    injectMessage: async () => {
      injections++;
      return { success: true, queued: false };
    },
  }).find((candidate) => candidate.name === "trigger_gate")!;

  const result = await tool.handler!(
    { cardId: value.id, gateType: "lint", gateName: "Test" },
    invocation("trigger_gate", "gate-name-mismatch-call"),
  ) as ToolResultObject;

  assert.equal(result.resultType, "failure");
  assert.match(result.error ?? "", /No configured gate matches type "lint" name "Test"/);
  assert.equal(injections, 0);
  assert.equal(
    (db.prepare(`
      SELECT COUNT(*) AS count FROM gate_runs WHERE card_id = ?
    `).get(value.id) as { count: number }).count,
    0,
  );
});

for (const scenario of [
  { phase: "plan", next: "build", skillId: "plan-review" },
  { phase: "build", next: "review", skillId: "code-review" },
  { phase: "review", next: "ship", skillId: "review-report" },
] as const) {
  test(`native trigger_review stores ${scenario.phase}->${scenario.next} and satisfies its configured review gate`, async () => {
    const value = card(`review-${scenario.phase}`, scenario.phase);
    const expectedRevision = seedAuthoritativeRevision(value);
    let starts = 0;
    const tool = nativeTools([value], {
      startReview: async (
        _hostUrl,
        _sessionUri,
        cardId,
        skill,
        transition,
        _riskLevel,
        changesetRef,
      ) => {
        starts++;
        const [fromPhase, toPhase] = transition.split("->") as [Phase, Phase];
        const gateRunId = startGateRun({
          cardId,
          fromPhase,
          toPhase,
          gateType: "review",
          gateName: skill.id,
          changesetRef,
        });
        completeGateRun(gateRunId, "passed", "review passed");
        const result = db.prepare(`
          INSERT INTO review_runs (
            card_id, skill_id, phase_transition, status, changeset_ref,
            gate_run_id
          ) VALUES (?, ?, ?, 'passed', ?, ?)
        `).run(cardId, skill.id, transition, changesetRef, gateRunId);
        return {
          success: true,
          reviewRunId: Number(result.lastInsertRowid),
          disposition: "terminal" as const,
        };
      },
    }).find((candidate) => candidate.name === "trigger_review")!;
    const toolInvocation = invocation(
      "trigger_review",
      `review-${scenario.phase}-call`,
    );

    const first = await tool.handler!(
      { cardId: value.id, skillId: scenario.skillId },
      toolInvocation,
    ) as ToolResultObject;
    const second = await tool.handler!(
      { cardId: value.id, skillId: scenario.skillId },
      toolInvocation,
    ) as ToolResultObject;

    assert.equal(first.resultType, "success");
    assert.deepEqual(
      JSON.parse(second.textResultForLlm),
      JSON.parse(first.textResultForLlm),
    );
    assert.equal(starts, 1);
    assert.deepEqual(
      db.prepare(`
        SELECT skill_id, phase_transition, changeset_ref
        FROM review_runs WHERE card_id = ?
      `).get(value.id),
      {
        skill_id: scenario.skillId,
        phase_transition: `${scenario.phase}->${scenario.next}`,
        changeset_ref: expectedRevision,
      },
    );

    const configuredReview = getGatesForTransition(
      scenario.phase,
      scenario.next,
      repositoryRoot,
      "high",
    ).find(
      (gate) =>
        gate.gateType === "review" && gate.gateName === scenario.skillId,
    );
    assert.ok(configuredReview);
    const { pendingGates } = canAdvancePhase(
      value.id,
      scenario.phase,
      scenario.next,
      repositoryRoot,
      "high",
      expectedRevision,
    );
    assert.equal(
      pendingGates.some(
        (gate) =>
          gate.gateType === "review" && gate.gateName === scenario.skillId,
      ),
      false,
    );
  });
}

test("native trigger_review rejects final and invalid card phases before dispatch", async () => {
  const finalCard = card("review-final", "ship");
  const invalidCard = {
    ...card("review-invalid", "build"),
    phase: "unknown",
  } as unknown as KanbanCard;
  let starts = 0;
  const tool = nativeTools([finalCard, invalidCard], {
    startReview: async () => {
      starts++;
      return {
        success: true,
        reviewRunId: 1,
        disposition: "terminal",
      };
    },
  }).find((candidate) => candidate.name === "trigger_review")!;

  const finalResult = await tool.handler!(
    { cardId: finalCard.id, skillId: "review-report" },
    invocation("trigger_review", "review-final-call"),
  ) as ToolResultObject;
  const invalidResult = await tool.handler!(
    { cardId: invalidCard.id, skillId: "code-review" },
    invocation("trigger_review", "review-invalid-call"),
  ) as ToolResultObject;

  assert.equal(finalResult.resultType, "failure");
  assert.match(finalResult.error ?? "", /final SDLC phase ship/);
  assert.equal(invalidResult.resultType, "failure");
  assert.match(invalidResult.error ?? "", /invalid SDLC phase "unknown"/);
  assert.equal(starts, 0);
});

test("Observe ignores forged client cards, supports bounded desktop queries and rejects worker effects", async () => {
  const cards = Array.from({ length: 30 }, (_, index) => card(`session-${String(index).padStart(2, "0")}`, "build"));
  registerCoordinatorHostReader((host) => host === hostUrl ? { generation: 1, cards, scopes: [new Set<string>()] } : undefined);
  setCoordinatorDefaultMode("observe");
  const context = { hostUrl, workspaceScope: [], cards: [card("forged", "build")], idempotencyKey: "observe", sdkSessionId: "test", toolCallId: "test" };
  try {
    const listed = await executeToolCall("list_sessions", { limit: 25 }, context);
    const data = listed.data as { sessions: { id: string }[]; nextOffset: number };
    assert.equal(data.sessions.length, 25);
    assert.equal(data.nextOffset, 25);
    assert.equal(data.sessions.some((item) => item.id === "forged"), false);
    await assert.rejects(() => executeToolCall("send_message", { cardId: cards[0].id, message: "do it" }, context), /does not permit/);
    await assert.rejects(() => executeToolCall("create_session", { title: "Work", prompt: "Do work", workingDirectory: repositoryRoot }, context), /does not permit/);
    await assert.rejects(() => executeToolCall("send_message", { cardId: "forged", message: "do it" }, context), /outside/);
    await assert.rejects(() => executeToolCall("list_sessions", {}, { ...context, hostUrl: "ws://other" }), /Connect/);
    assert.equal((await executeToolCall("list_sessions", {}, { ...context, workspaceScope: ["/outside"] })).message.startsWith("0 scoped"), true);
  } finally { setCoordinatorDefaultMode("coordinate"); }
});

test("per-session mode and mid-operation downgrade fence the next effect", async () => {
  const value = card("mode-fence", "build");
  registerCoordinatorHostReader(() => ({ generation: 1, cards: [value], scopes: [new Set<string>()] }));
  const { withCoordinatorAuthority } = await import("./coordinator-authority.ts");
  const { runOperationEffect } = await import("./operation-context.ts");
  let effects = 0;
  setCoordinatorSessionOverride(hostUrl, value.id, "observe");
  await assert.rejects(() => withCoordinatorAuthority({ hostUrl, workspaceScope: [] }, { cardId: value.id }, "interact", undefined, async () => { effects++; }), /does not permit/);
  setCoordinatorSessionOverride(hostUrl, value.id, null);
  await assert.rejects(() => withCoordinatorAuthority({ hostUrl, workspaceScope: [] }, { cardId: value.id }, "interact", undefined, async () => {
    setCoordinatorDefaultMode("observe");
    await runOperationEffect("interact", async () => { effects++; });
  }), /current|authority|changed|permit|cancelled/i);
  setCoordinatorDefaultMode("coordinate");
  assert.equal(effects, 0);
});

test("Verify invokes independent report-only reviews without primary instructions", async () => {
  const value = card("verify-review", "build");
  seedAuthoritativeRevision(value);
  setCoordinatorDefaultMode("verify");
  let observed = false;
  try {
    const tool = nativeTools([value], {
      startReview: async (_host, _uri, _id, skill, _transition, _risk, _revision, options) => {
        assert.equal(skill.autoFix, false);
        assert.equal(options?.independent, true);
        observed = true;
        return { success: true, reviewRunId: 99, disposition: "terminal" };
      },
    }).find((tool) => tool.name === "trigger_review")!;
    const result = await tool.handler!({ cardId: value.id, skillId: "code-review" }, invocation("trigger_review", "verify-review")) as ToolResultObject;
    assert.equal(result.resultType, "success");
    assert.equal(observed, true);
  } finally { setCoordinatorDefaultMode("coordinate"); }
});
