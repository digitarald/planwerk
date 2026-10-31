import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import type { CoordinatorGoal, GoalState, GoalWorkItem } from "../orchestrator/coordinator-goal-types.ts";

export function ensureCoordinatorGoalsSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS coordinator_goals (
      id TEXT PRIMARY KEY, host_url TEXT NOT NULL, workspace_scope_json TEXT NOT NULL,
      objective TEXT NOT NULL, acceptance_criteria TEXT NOT NULL, state TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1, summary TEXT, evidence_digest TEXT,
      owner_id TEXT, lease_expires_at_ms INTEGER,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS coordinator_goals_host ON coordinator_goals(host_url, state);
    CREATE TABLE IF NOT EXISTS coordinator_work_items (
      id TEXT PRIMARY KEY, goal_id TEXT NOT NULL REFERENCES coordinator_goals(id),
      state TEXT NOT NULL, data_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS coordinator_work_goal ON coordinator_work_items(goal_id);
    CREATE TABLE IF NOT EXISTS coordinator_dependencies (
      item_id TEXT NOT NULL REFERENCES coordinator_work_items(id),
      prerequisite_id TEXT NOT NULL REFERENCES coordinator_work_items(id),
      kind TEXT NOT NULL CHECK(kind IN ('result','verified')),
      PRIMARY KEY(item_id, prerequisite_id), CHECK(item_id <> prerequisite_id)
    );
    CREATE TABLE IF NOT EXISTS coordinator_goal_commands (
      audit_key TEXT PRIMARY KEY, arguments_json TEXT NOT NULL, result_json TEXT NOT NULL
    );
  `);
}

interface GoalRow {
  id: string; host_url: string; workspace_scope_json: string;
  objective: string; acceptance_criteria: string; state: GoalState;
  revision: number; summary: string | null; evidence_digest: string | null;
}

export function coordinatorId(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 32);
}

export class CoordinatorGoalStore {
  private readonly db: Database.Database;
  constructor(db: Database.Database) { this.db = db; }

  command(key: string, args: Record<string, unknown>, mutate: () => CoordinatorGoal): CoordinatorGoal {
    return this.db.transaction(() => {
      const argumentsJson = JSON.stringify(args);
      const prior = this.db.prepare("SELECT arguments_json,result_json FROM coordinator_goal_commands WHERE audit_key=?")
        .get(key) as { arguments_json: string; result_json: string } | undefined;
      if (prior) {
        if (prior.arguments_json !== argumentsJson) throw new Error("Goal command identity was reused with different arguments.");
        return JSON.parse(prior.result_json) as CoordinatorGoal;
      }
      const goal = mutate();
      this.db.prepare("INSERT INTO coordinator_goal_commands VALUES (?,?,?)").run(key, argumentsJson, JSON.stringify(goal));
      return goal;
    })();
  }

  get(id: string): CoordinatorGoal | undefined {
    const row = this.db.prepare("SELECT * FROM coordinator_goals WHERE id = ?").get(id) as GoalRow | undefined;
    if (!row) return undefined;
    const items = (this.db.prepare("SELECT data_json FROM coordinator_work_items WHERE goal_id = ? ORDER BY id").all(id) as { data_json: string }[])
      .map(({ data_json }) => JSON.parse(data_json) as GoalWorkItem);
    for (const item of items) {
      item.dependencies = (this.db.prepare("SELECT prerequisite_id, kind FROM coordinator_dependencies WHERE item_id = ? ORDER BY prerequisite_id").all(item.id) as { prerequisite_id: string; kind: "result" | "verified" }[])
        .map((edge) => ({ itemId: edge.prerequisite_id, kind: edge.kind }));
    }
    return {
      id: row.id, hostUrl: row.host_url, workspaceScope: JSON.parse(row.workspace_scope_json),
      objective: row.objective, acceptanceCriteria: row.acceptance_criteria, state: row.state,
      revision: row.revision, summary: row.summary ?? undefined,
      evidenceDigest: row.evidence_digest ?? undefined, items,
    };
  }

  list(hostUrl: string, limit = 50, workspaceScope: readonly string[] = []): CoordinatorGoal[] {
    const scope = JSON.stringify(workspaceScope);
    return (this.db.prepare(`SELECT id FROM coordinator_goals WHERE host_url = ?
      AND (? = '[]' OR NOT EXISTS (
        SELECT 1 FROM json_each(workspace_scope_json) saved
        WHERE saved.value NOT IN (SELECT value FROM json_each(?))
      ))
      ORDER BY CASE state WHEN 'needs-human' THEN 0 WHEN 'active' THEN 1
        WHEN 'paused' THEN 2 WHEN 'draft' THEN 3 ELSE 4 END, updated_at DESC, id LIMIT ?`)
      .all(hostUrl, scope, scope, Math.min(100, Math.max(1, limit))) as { id: string }[])
      .map(({ id }) => this.get(id)!);
  }

  *active(hostUrl: string): IterableIterator<CoordinatorGoal> {
    const rows = this.db.prepare("SELECT id FROM coordinator_goals WHERE host_url=? AND state='active' ORDER BY updated_at,id")
      .all(hostUrl) as { id: string }[];
    for (const row of rows) yield this.get(row.id)!;
  }

  create(input: Pick<CoordinatorGoal, "id" | "hostUrl" | "workspaceScope" | "objective" | "acceptanceCriteria">): CoordinatorGoal {
    if (!input.objective.trim() || !input.acceptanceCriteria.trim() ||
        !input.workspaceScope.length || input.workspaceScope.length > 256) {
      throw new Error("An objective, acceptance criteria and explicit saved workspaces are required.");
    }
    this.db.prepare(`INSERT INTO coordinator_goals (
      id,host_url,workspace_scope_json,objective,acceptance_criteria,state
    ) VALUES (?,?,?,?,?,'draft') ON CONFLICT(id) DO NOTHING`).run(
      input.id, input.hostUrl, JSON.stringify(input.workspaceScope), input.objective, input.acceptanceCriteria,
    );
    return this.get(input.id)!;
  }

  update(id: string, revision: number, patch: {
    state?: GoalState; summary?: string; objective?: string; acceptanceCriteria?: string; evidenceDigest?: string;
  }, ownerId?: string): CoordinatorGoal {
    const goal = this.get(id);
    if (!goal || goal.revision !== revision) throw new Error("Goal changed; reload before applying this decision.");
    if (goal.state === "cancelled" || goal.state === "completed") throw new Error("This goal is terminal; create a new goal for further work.");
    if ((patch.objective !== undefined || patch.acceptanceCriteria !== undefined) && goal.items.some((item) => item.state !== "ready" && item.state !== "blocked")) {
      throw new Error("Acceptance criteria cannot be rewritten after work is dispatched.");
    }
    const updated = { ...goal, ...patch };
    if (!updated.objective.trim() || !updated.acceptanceCriteria.trim()) throw new Error("Objective and acceptance criteria cannot be empty.");
    const result = this.db.prepare(`UPDATE coordinator_goals SET
      objective=?,acceptance_criteria=?,state=?,summary=?,evidence_digest=?,revision=revision+1,updated_at=datetime('now')
      WHERE id=? AND revision=? AND (? IS NULL OR (owner_id=? AND lease_expires_at_ms>?))`).run(
      updated.objective, updated.acceptanceCriteria, updated.state, updated.summary ?? null,
      updated.evidenceDigest ?? null, id, revision, ownerId ?? null, ownerId ?? null, Date.now(),
    );
    if (result.changes !== 1) throw new Error("Goal lease or revision changed.");
    return this.get(id)!;
  }

  addItem(goalId: string, revision: number, input: Pick<GoalWorkItem, "id" | "instructions" | "acceptanceCriteria" | "workingDirectory" | "cardId" | "dependencies">): CoordinatorGoal {
    return this.db.transaction(() => {
      const goal = this.get(goalId);
      if (!goal || goal.revision !== revision) throw new Error("Goal changed; reload first.");
      if (goal.state !== "draft" && goal.state !== "paused") throw new Error("Pause the goal before changing its work graph.");
      if (goal.items.length >= 32) throw new Error("A goal supports at most 32 work items.");
      if (!input.instructions.trim() || !input.acceptanceCriteria.trim()) throw new Error("Instructions and acceptance criteria are required.");
      if (goal.items.some((item) => item.id === input.id)) return goal;
      const item: GoalWorkItem = {
        ...input, goalId, state: input.dependencies.length ? "blocked" : "ready",
        actionKey: `goal-work:v1:${goalId}:${input.id}`,
      };
      this.db.prepare("INSERT INTO coordinator_work_items(id,goal_id,state,data_json) VALUES (?,?,?,?)")
        .run(item.id, goalId, item.state, JSON.stringify(item));
      for (const dependency of input.dependencies) {
        if (!goal.items.some((other) => other.id === dependency.itemId)) throw new Error("Dependencies must belong to this goal.");
        this.db.prepare("INSERT INTO coordinator_dependencies(item_id,prerequisite_id,kind) VALUES (?,?,?)")
          .run(item.id, dependency.itemId, dependency.kind);
      }
      this.assertAcyclic(goalId);
      return this.update(goalId, revision, {});
    })();
  }

  setDependencies(goalId: string, revision: number, itemId: string, edges: GoalWorkItem["dependencies"]): CoordinatorGoal {
    return this.db.transaction(() => {
      const goal = this.get(goalId);
      const item = goal?.items.find((entry) => entry.id === itemId);
      if (!goal || !item || goal.revision !== revision || !["draft", "paused"].includes(goal.state) ||
          !["ready", "blocked"].includes(item.state)) throw new Error("Only undispatched work in a draft or paused goal may be edited.");
      this.db.prepare("DELETE FROM coordinator_dependencies WHERE item_id=?").run(itemId);
      for (const edge of edges) {
        if (!goal.items.some((entry) => entry.id === edge.itemId)) throw new Error("Dependencies must belong to this goal.");
        this.db.prepare("INSERT INTO coordinator_dependencies VALUES (?,?,?)").run(itemId, edge.itemId, edge.kind);
      }
      this.assertAcyclic(goalId);
      return this.update(goalId, revision, {});
    })();
  }

  private assertAcyclic(goalId: string): void {
    const goal = this.get(goalId)!;
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (id: string) => {
      if (visiting.has(id)) throw new Error("Work dependencies must not contain a cycle.");
      if (visited.has(id)) return;
      visiting.add(id);
      for (const edge of goal.items.find((item) => item.id === id)?.dependencies ?? []) visit(edge.itemId);
      visiting.delete(id);
      visited.add(id);
    };
    for (const item of goal.items) visit(item.id);
  }

  claim(id: string, revision: number, ownerId: string, now = Date.now(), leaseMs = 120_000): boolean {
    return this.db.prepare(`UPDATE coordinator_goals SET owner_id=?,lease_expires_at_ms=?
      WHERE id=? AND revision=? AND state='active' AND (owner_id IS NULL OR lease_expires_at_ms<=?)`)
      .run(ownerId, now + leaseMs, id, revision, now).changes === 1;
  }

  release(id: string, ownerId: string): void {
    this.db.prepare("UPDATE coordinator_goals SET owner_id=NULL,lease_expires_at_ms=NULL WHERE id=? AND owner_id=?").run(id, ownerId);
  }

  owns(id: string, revision: number, ownerId: string, now = Date.now()): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM coordinator_goals WHERE id=? AND revision=? AND owner_id=? AND lease_expires_at_ms>? AND state='active'")
      .get(id, revision, ownerId, now));
  }

  saveItem(goalId: string, revision: number, item: GoalWorkItem, ownerId: string): CoordinatorGoal {
    return this.db.transaction(() => {
      const goal = this.update(goalId, revision, {}, ownerId);
      const result = this.db.prepare("UPDATE coordinator_work_items SET state=?,data_json=? WHERE id=? AND goal_id=?")
        .run(item.state, JSON.stringify(item), item.id, goalId);
      if (result.changes !== 1) throw new Error("Work item does not belong to this goal.");
      return this.get(goal.id)!;
    })();
  }
}
