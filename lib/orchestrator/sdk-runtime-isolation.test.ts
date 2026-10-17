import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { CopilotClientOptions } from "@github/copilot-sdk";

const calls: string[] = [];
const configurations: CopilotClientOptions[] = [];
const key = "__planwerkSdkIsolationTest";
Object.defineProperty(globalThis, key, {
  value: { calls, configurations },
  configurable: true,
});
const previousDataDir = process.env.PLANWERK_DATA_DIR;
const previousCopilotHome = process.env.COPILOT_HOME;
process.env.PLANWERK_DATA_DIR = "/tmp/planwerk-sdk-isolation-test";
process.env.COPILOT_HOME = "/tmp/foreign-copilot-home";

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    let source: string | undefined;
    if (specifier === "server-only") source = "export {}";
    if (specifier === "@github/copilot-sdk") source = `
      const state = globalThis["${key}"];
      export class CopilotClient {
        constructor(options) { state.configurations.push(options); }
        async start() { state.calls.push("start"); }
        async stop() { state.calls.push("stop"); return []; }
        async ping() { state.calls.push("ping"); return {}; }
        async getStatus() { state.calls.push("status"); return {}; }
        async listSessions() { throw new Error("Health must not scan sessions"); }
        async resumeSession() { throw new Error("Health must not resume sessions"); }
      }`;
    if (source) return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(source)}` };
    if (specifier.startsWith(".") && !path.extname(specifier) && context.parentURL?.startsWith("file:")) {
      const candidate = fileURLToPath(new URL(`${specifier}.ts`, context.parentURL));
      if (existsSync(candidate)) return { shortCircuit: true, url: pathToFileURL(candidate).href };
    }
    return nextResolve(specifier, context);
  },
});
after(() => {
  hooks.deregister();
  Reflect.deleteProperty(globalThis, key);
  if (previousDataDir === undefined) delete process.env.PLANWERK_DATA_DIR;
  else process.env.PLANWERK_DATA_DIR = previousDataDir;
  if (previousCopilotHome === undefined) delete process.env.COPILOT_HOME;
  else process.env.COPILOT_HOME = previousCopilotHome;
});

const runtime = await import("./sdk-runtime.ts");

test("runtime is lazy, uses private empty-mode storage, and health never lists or resumes", async () => {
  assert.deepEqual(calls, []);
  assert.equal(configurations.length, 0);
  await runtime.checkCopilotRuntimeHealth();
  assert.deepEqual(calls, []);
  const lease = await runtime.acquireCopilotRuntimeClient();
  assert.equal(configurations.length, 1);
  assert.equal(configurations[0].mode, "empty");
  assert.equal(configurations[0].baseDirectory, "/tmp/planwerk-sdk-isolation-test/copilot-sdk");
  assert.equal(configurations[0].workingDirectory, "/tmp/planwerk-sdk-isolation-test");
  assert.equal(configurations[0].connection, undefined, "must spawn its own runtime, not attach to VS Code");
  assert.equal(configurations[0].clientInfo?.applicationName, "planwerk");
  await runtime.checkCopilotRuntimeHealth();
  await lease.release();
  await runtime.shutdownCopilotRuntime();
  assert.deepEqual(calls, ["start", "status", "ping", "stop"]);
});
