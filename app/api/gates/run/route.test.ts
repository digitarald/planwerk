import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import {
  after,
  before,
  test,
} from "node:test";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import path from "node:path";

import Database from "better-sqlite3";

import { getRiskFactsSnapshot } from "../../../../lib/orchestrator/risk-facts.ts";

const repositoryRoot = path.resolve(import.meta.dirname, "../../../..");
const testScratchRoot = path.join(repositoryRoot, ".test-runs");
const projectPath = "/gate-route-risk-test";
let appRoot = "";
let baseUrl = "";
let server: ChildProcess;
let database: Database.Database;
let serverOutput = "";
let scriptGateProjectPath = "";

function getAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const address = listener.address();
      assert.ok(address && typeof address !== "string");
      listener.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

async function waitForServer(): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`Next dev exited before becoming ready:\n${serverOutput}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/gates/run?cardId=probe`);
      if (response.status < 500) return;
    } catch {
      // The socket is not ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for Next dev:\n${serverOutput}`);
}

function copyProjectEntry(name: string): void {
  cpSync(path.join(repositoryRoot, name), path.join(appRoot, name), {
    recursive: true,
  });
}

function seedGateRun(
  cardId: string,
  changesetRef = "source:source-v1",
): void {
  database.prepare(`
    INSERT INTO card_phases (card_id, phase) VALUES (?, 'define')
  `).run(cardId);
  database.prepare(`
    INSERT INTO gate_runs (
      card_id, from_phase, to_phase, gate_type, status, changeset_ref,
      completed_at
    ) VALUES (
      ?, 'define', 'plan', 'human-approval', 'passed', ?, datetime('now')
    )
  `).run(cardId, changesetRef);
}

function seedFacts(
  cardId: string,
  title = "Small documentation fix",
  sourceRevision = "source-v1",
  files = 1,
): string {
  const planVersion = `plan-${sourceRevision}`;
  const contentRevision = `content-${sourceRevision}`;
  database.prepare(`
    INSERT OR REPLACE INTO session_cache (
      session_uri, host_url, summary_json, enrichment_json
    ) VALUES (?, 'vscode-local://desktop', ?, ?)
  `).run(
    cardId,
    JSON.stringify({
      resource: cardId,
      title,
      modifiedAt: planVersion,
      changes: { files, additions: 2, deletions: 1 },
      _planwerkRiskFacts: {
        sourceRevision,
        planVersion,
        contentRevision,
        pendingInput: null,
      },
    }),
    JSON.stringify({
      changesetVerified: true,
      totalFileCount: files,
      additions: 2,
      deletions: 1,
      fileChanges: Array.from(
        { length: files },
        (_, index) => ({ path: index === 0 ? "README.md" : `docs/${index}.md` }),
      ),
      _planwerkSource: {
        sourceRevision,
        planVersion,
        contentRevision,
      },
    }),
  );
  const snapshot = getRiskFactsSnapshot(
    database,
    "vscode-local://desktop",
    cardId,
  );
  assert.ok(snapshot);
  return snapshot.digest;
}

function seedRisk(cardId: string, riskDigest: string | null): void {
  database.prepare(`
    INSERT OR REPLACE INTO card_risk (
      card_id, risk_level, risk_factors, assessed_by, risk_digest
    ) VALUES (?, 'low', '["Small documentation change"]', 'copilot', ?)
  `).run(cardId, riskDigest);
}

function localMutationHeaders(
  overrides: Record<string, string> = {},
): Record<string, string> {
  return {
    "content-type": "application/json",
    host: new URL(baseUrl).host,
    origin: baseUrl,
    "sec-fetch-site": "same-origin",
    ...overrides,
  };
}

async function advance(
  cardId: string,
  changesetRef?: string,
): Promise<{
  response: Response;
  payload: Record<string, unknown>;
}> {
  const response = await fetch(`${baseUrl}/api/gates/run`, {
    method: "POST",
    headers: localMutationHeaders(),
    body: JSON.stringify({
      cardId,
      action: "advance",
      projectPath,
      ...(changesetRef === undefined ? {} : { changesetRef }),
    }),
  });
  return {
    response,
    payload: await response.json() as Record<string, unknown>,
  };
}

function phaseFor(cardId: string): string {
  const row = database.prepare(`
    SELECT phase FROM card_phases WHERE card_id = ?
  `).get(cardId) as { phase: string };
  return row.phase;
}

async function assertReassessmentRequired(
  cardId: string,
  expectedStatus: string,
): Promise<void> {
  const { response, payload } = await advance(cardId);
  assert.equal(response.status, 409);
  assert.equal(payload.error, "Risk reassessment required before advancing");
  assert.match(String(payload.detail), /Reassess risk.*then retry advancement/i);
  assert.equal(payload.riskStatus, expectedStatus);
  assert.equal(payload.retryable, true);
  assert.equal(phaseFor(cardId), "define");
}

before(async () => {
  mkdirSync(testScratchRoot, { recursive: true });
  appRoot = mkdtempSync(path.join(testScratchRoot, "gate-route-"));
  for (const name of [
    "app",
    "lib",
    "next.config.ts",
    "package.json",
    "tsconfig.json",
  ]) {
    copyProjectEntry(name);
  }
  scriptGateProjectPath = path.join(appRoot, "script-gate-project");
  mkdirSync(path.join(scriptGateProjectPath, ".github"), { recursive: true });
  writeFileSync(
    path.join(scriptGateProjectPath, ".github/planwerk.yml"),
    [
      "scripts:",
      "  - name: Test",
      "    command: node --version",
      "gates:",
      "  build-to-review:",
      "    required:",
      "      - type: script",
      "        name: Test",
      "    optional: []",
      "",
    ].join("\n"),
  );
  symlinkSync(
    path.join(repositoryRoot, "node_modules"),
    path.join(appRoot, "node_modules"),
  );

  const port = await getAvailablePort();
  baseUrl = `http://127.0.0.1:${port}`;
  server = spawn(
    path.join(repositoryRoot, "node_modules/.bin/next"),
    ["dev", "--webpack", "--hostname", "127.0.0.1", "--port", String(port)],
    {
      cwd: appRoot,
      env: {
        ...process.env,
        NEXT_TELEMETRY_DISABLED: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  server.stdout?.on("data", (chunk) => {
    serverOutput += chunk.toString();
  });
  server.stderr?.on("data", (chunk) => {
    serverOutput += chunk.toString();
  });

  await waitForServer();
  database = new Database(path.join(appRoot, ".planwerk/planwerk.db"));
  database.pragma("foreign_keys = ON");
  database.prepare(`
    INSERT INTO gate_configs (
      project_path, phase_transition, gate_type, command, required
    ) VALUES (?, 'define->plan', 'human-approval', NULL, 1)
  `).run(projectPath);
});

after(async () => {
  database?.close();
  if (server && server.exitCode === null) {
    server.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      server.once("exit", () => resolve());
      setTimeout(() => {
        if (server.exitCode === null) server.kill("SIGKILL");
      }, 5_000).unref();
    });
  }
  if (appRoot) rmSync(appRoot, { recursive: true, force: true });
  try {
    rmdirSync(testScratchRoot);
  } catch {
    // Another local test may still be using the shared repository scratch root.
  }
});

test("advance rejects missing risk even when gates passed", async () => {
  const cardId = "gate-risk-missing";
  seedGateRun(cardId);
  seedFacts(cardId);

  await assertReassessmentRequired(cardId, "missing");
});

test("advance rejects legacy null-digest risk even when gates passed", async () => {
  const cardId = "gate-risk-unbound";
  seedGateRun(cardId);
  seedFacts(cardId);
  seedRisk(cardId, null);

  await assertReassessmentRequired(cardId, "unbound");
});

test("advance rejects stale risk even when gates passed", async () => {
  const cardId = "gate-risk-stale";
  seedGateRun(cardId);
  seedRisk(cardId, seedFacts(cardId));
  database.prepare(`
    UPDATE session_cache
    SET summary_json = ?, enrichment_json = ?
    WHERE session_uri = ?
  `).run(
    JSON.stringify({
      resource: cardId,
      title: "Authentication migration",
      modifiedAt: "plan-source-v2",
      changes: { files: 12, additions: 400, deletions: 80 },
      _planwerkRiskFacts: {
        sourceRevision: "source-v2",
        planVersion: "plan-source-v2",
        contentRevision: "content-source-v2",
        pendingInput: null,
      },
    }),
    JSON.stringify({
      changesetVerified: true,
      totalFileCount: 1,
      additions: 2,
      deletions: 1,
      fileChanges: [{ path: "README.md" }],
      _planwerkSource: {
        sourceRevision: "source-v2",
        planVersion: "plan-source-v2",
        contentRevision: "content-source-v2",
      },
    }),
    cardId,
  );

  await assertReassessmentRequired(cardId, "stale");
});

test("advance rejects risk when authoritative facts are unavailable", async () => {
  const cardId = "gate-risk-facts-unavailable";
  seedGateRun(cardId);
  seedRisk(cardId, "facts-no-longer-available");

  const { response, payload } = await advance(cardId);
  assert.equal(response.status, 409);
  assert.equal(payload.error, "Authoritative revision unavailable");
  assert.equal(payload.retryable, true);
  assert.equal(phaseFor(cardId), "define");
});

test("advance permits current digest-bound risk after gates pass", async () => {
  const cardId = "gate-risk-current";
  seedGateRun(cardId);
  seedRisk(cardId, seedFacts(cardId));

  const { response, payload } = await advance(cardId);
  assert.equal(response.status, 200, JSON.stringify(payload));
  assert.equal(payload.previousPhase, "define");
  assert.equal(payload.newPhase, "plan");
  assert.equal(phaseFor(cardId), "plan");
});

test("run-gate passes a named configured gate with authoritative identity and revision", async () => {
  const cardId = "named-script-gate";
  database.prepare(`
    INSERT INTO card_phases (card_id, phase) VALUES (?, 'build')
  `).run(cardId);
  seedFacts(cardId);

  const runResponse = await fetch(`${baseUrl}/api/gates/run`, {
    method: "POST",
    headers: localMutationHeaders(),
    body: JSON.stringify({
      cardId,
      action: "run-gate",
      gateType: "test",
      projectPath: scriptGateProjectPath,
      workingDirectory: appRoot,
    }),
  });
  const runPayload = await runResponse.json() as { runId?: number; error?: string };
  assert.equal(runResponse.status, 200, JSON.stringify(runPayload));
  assert.equal(typeof runPayload.runId, "number");

  const deadline = Date.now() + 10_000;
  let run: {
    status: string;
    gate_name: string | null;
    changeset_ref: string | null;
  } | undefined;
  while (Date.now() < deadline) {
    run = database.prepare(`
      SELECT status, gate_name, changeset_ref
      FROM gate_runs WHERE id = ?
    `).get(runPayload.runId) as typeof run;
    if (run?.status !== "running") break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.deepEqual(run, {
    status: "passed",
    gate_name: "Test",
    changeset_ref: "source:source-v1",
  });

  const checkResponse = await fetch(`${baseUrl}/api/gates/run`, {
    method: "POST",
    headers: localMutationHeaders(),
    body: JSON.stringify({
      cardId,
      action: "check",
      projectPath: scriptGateProjectPath,
    }),
  });
  const checkPayload = await checkResponse.json() as {
    allowed?: boolean;
    pendingGates?: unknown[];
  };
  assert.equal(checkResponse.status, 200, JSON.stringify(checkPayload));
  assert.equal(checkPayload.allowed, true);
  assert.deepEqual(checkPayload.pendingGates, []);
});

test("run-gate rejects mismatched and unconfigured names before creating a run", async () => {
  const cardId = "invalid-script-gate";
  database.prepare(`
    INSERT INTO card_phases (card_id, phase) VALUES (?, 'build')
  `).run(cardId);
  seedFacts(cardId);

  for (const request of [
    { gateType: "test", gateName: "Lint" },
    { gateType: "lint" },
  ]) {
    const response = await fetch(`${baseUrl}/api/gates/run`, {
      method: "POST",
      headers: localMutationHeaders(),
      body: JSON.stringify({
        cardId,
        action: "run-gate",
        projectPath: scriptGateProjectPath,
        workingDirectory: appRoot,
        ...request,
      }),
    });
    const payload = await response.json() as { error?: string };
    assert.equal(response.status, 400, JSON.stringify(payload));
    assert.match(payload.error ?? "", /No configured gate matches/);
  }

  assert.equal(
    (database.prepare(`
      SELECT COUNT(*) AS count FROM gate_runs WHERE card_id = ?
    `).get(cardId) as { count: number }).count,
    0,
  );
});

test("approve preserves a legitimately unnamed configured gate", async () => {
  const cardId = "unnamed-human-gate";
  database.prepare(`
    INSERT INTO card_phases (card_id, phase) VALUES (?, 'define')
  `).run(cardId);
  seedFacts(cardId);

  const response = await fetch(`${baseUrl}/api/gates/run`, {
    method: "POST",
    headers: localMutationHeaders(),
    body: JSON.stringify({
      cardId,
      action: "approve",
      gateType: "human-approval",
      projectPath,
    }),
  });
  const payload = await response.json() as { runId?: number; error?: string };
  assert.equal(response.status, 200, JSON.stringify(payload));
  assert.equal(typeof payload.runId, "number");
  assert.deepEqual(
    database.prepare(`
      SELECT status, gate_type, gate_name, changeset_ref
      FROM gate_runs WHERE id = ?
    `).get(payload.runId),
    {
      status: "passed",
      gate_type: "human-approval",
      gate_name: null,
      changeset_ref: "source:source-v1",
    },
  );
});

test("every local mutation route rejects cross-origin and text/plain before its side-effect seam", async () => {
  const cardId = "gate-mutation-security";
  database.prepare(`
    INSERT INTO card_phases (card_id, phase) VALUES (?, 'define')
  `).run(cardId);

  const routes: Array<{
    name: string;
    path: string;
    method?: "POST" | "DELETE";
    body?: Record<string, unknown>;
  }> = [
    {
      name: "AHP session creation",
      path: "/api/ahp/sessions",
      body: {
        hostUrl: "http://127.0.0.1:9",
        prompt: "Start a guarded session",
      },
    },
    {
      name: "AHP input",
      path: "/api/ahp/sessions/input",
      body: {
        hostUrl: "http://127.0.0.1:9",
        sessionUri: "copilotcli:/guard-test",
        requestId: "request-1",
        response: "accept",
      },
    },
    {
      name: "AHP messaging",
      path: "/api/ahp/sessions/message",
      body: {
        hostUrl: "http://127.0.0.1:9",
        sessionUri: "copilotcli:/guard-test",
        message: "Guarded message",
      },
    },
    {
      name: "AHP file review",
      path: "/api/ahp/sessions/review",
      body: {
        hostUrl: "http://127.0.0.1:9",
        sessionUri: "copilotcli:/guard-test",
        files: ["file-1"],
        reviewed: true,
      },
    },
    {
      name: "AHP archive",
      path: "/api/ahp/sessions/archive",
      body: {
        hostUrl: "http://127.0.0.1:9",
        sessionUri: "copilotcli:/guard-test",
        isArchived: true,
      },
    },
    {
      name: "orchestrator review",
      path: "/api/orchestrator/review",
      body: {
        cardId: "guard-review",
        skillId: "code-review",
        hostUrl: "http://127.0.0.1:9",
        sessionUri: "copilotcli:/guard-test",
      },
    },
    {
      name: "orchestrator chat",
      path: "/api/orchestrator/chat",
      body: { message: "Mutate the board" },
    },
    {
      name: "orchestrator chat cleanup",
      path: "/api/orchestrator/chat",
      method: "DELETE",
    },
    {
      name: "orchestrator approval",
      path: "/api/orchestrator/approvals",
      body: {
        decisionCapability: "not-a-real-capability",
        decision: "approve",
      },
    },
    {
      name: "gate transition",
      path: "/api/gates/run",
      body: { cardId, action: "transition", toPhase: "ship" },
    },
    {
      name: "gate execution",
      path: "/api/gates/run",
      body: {
        cardId,
        action: "run-gate",
        gateType: "human-approval",
      },
    },
    {
      name: "coherence dismissal",
      path: "/api/coherence/dismiss",
      body: { cardId: "guard-card-a", otherCardId: "guard-card-b" },
    },
  ];

  const beforeSdkSessions = database.prepare(
    "SELECT COUNT(*) AS count FROM cto_sdk_sessions",
  ).get() as { count: number };
  const beforeReviewRuns = database.prepare(
    "SELECT COUNT(*) AS count FROM review_runs",
  ).get() as { count: number };

  for (const route of routes) {
    for (const requestKind of ["cross-origin", "text/plain"] as const) {
      const headers = requestKind === "cross-origin"
        ? localMutationHeaders({
            origin: "http://attacker.example",
            "sec-fetch-site": "cross-site",
          })
        : localMutationHeaders({ "content-type": "text/plain" });
      const response = await fetch(`${baseUrl}${route.path}`, {
        method: route.method ?? "POST",
        headers,
        body: route.body === undefined ? undefined : JSON.stringify(route.body),
      });
      assert.equal(
        response.status,
        403,
        `${route.name} accepted ${requestKind}`,
      );
    }
  }

  assert.equal(phaseFor(cardId), "define");
  const afterSdkSessions = database.prepare(
    "SELECT COUNT(*) AS count FROM cto_sdk_sessions",
  ).get() as { count: number };
  const afterReviewRuns = database.prepare(
    "SELECT COUNT(*) AS count FROM review_runs",
  ).get() as { count: number };
  assert.equal(afterSdkSessions.count, beforeSdkSessions.count);
  assert.equal(afterReviewRuns.count, beforeReviewRuns.count);
});

test("AHP event stream rejects cross-origin setup before connecting and permits same-origin EventSource GET", async () => {
  let connectionCount = 0;
  const listener = net.createServer((socket) => {
    connectionCount += 1;
    socket.destroy();
  });
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });

  try {
    const address = listener.address();
    assert.ok(address && typeof address !== "string");
    const hostUrl = `ws://127.0.0.1:${address.port}`;
    const streamUrl = `${baseUrl}/api/ahp/events?host=${encodeURIComponent(hostUrl)}`;

    const blocked = await fetch(streamUrl, {
      headers: {
        host: new URL(baseUrl).host,
        origin: "http://attacker.example",
        "sec-fetch-site": "cross-site",
      },
    });
    assert.equal(blocked.status, 403);
    assert.deepEqual(await blocked.json(), {
      error: "cross-origin request is not allowed",
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(connectionCount, 0);

    const controller = new AbortController();
    const allowed = await fetch(
      `${streamUrl}&workspaceScope=${encodeURIComponent("[]")}`,
      {
        headers: {
          host: new URL(baseUrl).host,
          origin: baseUrl,
          "sec-fetch-site": "same-origin",
        },
        signal: controller.signal,
      },
    );
    assert.equal(allowed.status, 200);
    assert.match(
      allowed.headers.get("content-type") ?? "",
      /^text\/event-stream/,
    );
    const reader = allowed.body?.getReader();
    assert.ok(reader);
    const firstEvent = await reader.read();
    assert.equal(firstEvent.done, false);
    const firstFrame = new TextDecoder().decode(firstEvent.value).split("\n\n", 1)[0].trim();
    assert.ok(firstFrame.startsWith("data: "));
    const snapshot = JSON.parse(firstFrame.slice("data: ".length));
    assert.equal(snapshot.type, "init");
    assert.deepEqual(snapshot.cards, []);
    controller.abort();
    await reader.cancel().catch(() => undefined);
  } finally {
    await new Promise<void>((resolve, reject) => {
      listener.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
});

test("advance rejects stale caller revisions and omitted-revision replay", async () => {
  const cardId = "gate-revision-replay";
  seedGateRun(cardId, "source:source-v1");
  seedFacts(cardId, "Initial facts", "source-v1", 1);

  const currentDigest = seedFacts(cardId, "Updated facts", "source-v2", 2);
  seedRisk(cardId, currentDigest);

  const staleCaller = await advance(cardId, "source:source-v1");
  assert.equal(staleCaller.response.status, 409);
  assert.equal(
    staleCaller.payload.error,
    "Changeset revision does not match current AHP facts",
  );
  assert.equal(staleCaller.payload.stale, true);
  assert.equal(phaseFor(cardId), "define");

  const omitted = await advance(cardId);
  assert.equal(omitted.response.status, 403);
  assert.equal(omitted.payload.error, "Gates not passed");
  assert.equal(phaseFor(cardId), "define");
});

test("passed revision A cannot advance when the current source is unknown", async () => {
  const cardId = "gate-revision-unknown";
  seedGateRun(cardId, "source:source-v1");
  const digest = seedFacts(cardId, "Initial facts", "source-v1", 1);
  seedRisk(cardId, digest);
  database.prepare(`
    UPDATE session_cache
    SET enrichment_json = NULL
    WHERE session_uri = ?
  `).run(cardId);

  const { response, payload } = await advance(cardId);
  assert.equal(response.status, 409);
  assert.equal(payload.error, "Authoritative revision unavailable");
  assert.equal(payload.retryable, true);
  assert.equal(phaseFor(cardId), "define");
});
