import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import Database from "better-sqlite3";

const db = new Database(":memory:");
db.exec(`
  CREATE TABLE card_phases (card_id TEXT PRIMARY KEY, phase TEXT, updated_at TEXT);
  CREATE TABLE gate_runs (
    id INTEGER PRIMARY KEY, card_id TEXT, from_phase TEXT, to_phase TEXT,
    gate_type TEXT, gate_name TEXT, changeset_ref TEXT, owner_id TEXT,
    lease_expires_at_ms INTEGER, status TEXT DEFAULT 'running', output TEXT,
    completed_at TEXT
  );
`);
const pending: {
  options: { signal?: AbortSignal };
  callback: (error: Error | null, stdout: string, stderr: string) => void;
}[] = [];
const globalKey = "__planwerkGateCancellationTest";
Object.defineProperty(globalThis, globalKey, { value: { db, pending }, configurable: true });
const root = path.resolve(import.meta.dirname, "../..");
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    const mocks: Record<string, string> = {
      "server-only": "export {}",
      "@/lib/db/schema": `export function getDb(){return globalThis["${globalKey}"].db}`,
      "./skill-config": "export function loadConfig(){return {}}",
      "node:child_process": `export function exec(command,options,callback){
        globalThis["${globalKey}"].pending.push({options,callback});return {};
      }`,
    };
    if (mocks[specifier]) {
      return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(mocks[specifier])}` };
    }
    if (specifier.startsWith("@/")) {
      return { shortCircuit: true, url: pathToFileURL(path.join(root, `${specifier.slice(2)}.ts`)).href };
    }
    if (specifier.startsWith(".") && !path.extname(specifier) && context.parentURL?.startsWith("file:")) {
      const candidate = fileURLToPath(new URL(`${specifier}.ts`, context.parentURL));
      if (existsSync(candidate)) return { shortCircuit: true, url: pathToFileURL(candidate).href };
    }
    return nextResolve(specifier, context);
  },
});
const { executeGateCommand, startGateRun } = await import("./gate-engine.ts");

after(() => {
  db.close();
  hooks.deregister();
  Reflect.deleteProperty(globalThis, globalKey);
});

function start() {
  return startGateRun({
    cardId: "card", fromPhase: "build", toPhase: "review", gateType: "test",
  });
}

function outcome(id: number) {
  return db.prepare("SELECT status, output FROM gate_runs WHERE id = ?").get(id) as {
    status: string; output: string;
  };
}

test("a pre-cancelled gate does not start a command", () => {
  const controller = new AbortController();
  controller.abort();
  const id = start();
  const before = pending.length;
  executeGateCommand(id, "fake-test", process.cwd(), undefined, { signal: controller.signal });
  assert.equal(pending.length, before);
  assert.equal(outcome(id).status, "failed");
});

test("cancelled command results cannot become passing gates and receive the owned abort signal", () => {
  const controller = new AbortController();
  const id = start();
  executeGateCommand(id, "fake-test", process.cwd(), undefined, { signal: controller.signal });
  const command = pending.pop()!;
  assert.equal(command.options.signal, controller.signal);
  controller.abort();
  command.callback(null, "Checks passed remotely", "");
  assert.equal(outcome(id).status, "failed");
  assert.match(outcome(id).output, /authority\/source changed/);
});

test("a source or mode change fences a late successful check result", () => {
  let current = true;
  const id = start();
  executeGateCommand(id, "fake-test", process.cwd(), undefined, { isCurrent: () => current });
  current = false;
  pending.pop()!.callback(null, "All checks passed", "");
  assert.equal(outcome(id).status, "failed");
});

test("current manually requested checks retain their existing passing behavior", () => {
  const id = start();
  executeGateCommand(id, "fake-test", process.cwd());
  pending.pop()!.callback(null, "All checks passed", "");
  assert.deepEqual(outcome(id), { status: "passed", output: "All checks passed" });
});
