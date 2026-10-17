import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { RpcError, type AhpClient } from "@microsoft/agent-host-protocol/client";
import { EvidenceCaptureBudget, EvidenceCaptureLimitError } from "./evidence-budget.ts";

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
    if (specifier.startsWith(".") && !path.extname(specifier) && context.parentURL?.startsWith("file:")) {
      const candidate = fileURLToPath(new URL(`${specifier}.ts`, context.parentURL));
      if (existsSync(candidate)) return { shortCircuit: true, url: pathToFileURL(candidate).href };
    }
    return nextResolve(specifier, context);
  },
});
after(() => hooks.deregister());
const { fetchCopilotCliArtifacts } = await import("./plan-artifact.ts");

test("artifact misses are scoped to the observing connection and its revision", async () => {
  let missingReads = 0;
  const missing = { async request() { missingReads++; throw new RpcError(-32008, "Not found"); } } as unknown as AhpClient;
  let existingReads = 0;
  const existing = { async request() { existingReads++; return { encoding: "utf-8", data: "Current plan" }; } } as unknown as AhpClient;
  const session = "copilotcli:/12345678-1234-1234-1234-123456789abc";
  assert.deepEqual(await fetchCopilotCliArtifacts(missing, session, "rev-1"), []);
  assert.deepEqual(await fetchCopilotCliArtifacts(missing, session, "rev-1"), []);
  assert.equal(missingReads, 2);
  assert.equal((await fetchCopilotCliArtifacts(existing, session, "rev-1")).length, 2);
  assert.equal(existingReads, 2);
  await fetchCopilotCliArtifacts(missing, session, "rev-2");
  assert.equal(missingReads, 4);
});

test("a bridge shares misses across transient clients but not reconnects or other hosts", async () => {
  let reads = 0;
  const client = () => ({ async request() { reads++; throw new RpcError(-32008, "Not found"); } }) as unknown as AhpClient;
  const session = "copilotcli:/12345678-1234-1234-1234-123456789abc";
  const bridge = new AbortController();
  await fetchCopilotCliArtifacts(client(), session, "v1", bridge);
  await fetchCopilotCliArtifacts(client(), session, "v1", bridge);
  assert.equal(reads, 2);
  await fetchCopilotCliArtifacts(client(), session, "v1", new AbortController());
  assert.equal(reads, 4);
});

test("intentional captures propagate unreadable artifacts instead of certifying their absence", async () => {
  const client = { async request() { throw new Error("transport interrupted"); } } as unknown as AhpClient;
  const session = "copilotcli:/12345678-1234-1234-1234-123456789abc";
  assert.deepEqual(await fetchCopilotCliArtifacts(client, session, "v1"), []);
  await assert.rejects(fetchCopilotCliArtifacts(client, session, "v1", {}, true), /transport interrupted/);
  const missing = { async request() { throw new RpcError(-32008, "Not found"); } } as unknown as AhpClient;
  assert.deepEqual(await fetchCopilotCliArtifacts(missing, session, "v1", {}, true), []);
});

test("provider fallback artifacts share the cumulative decoded byte budget", async () => {
  const budget = new EvidenceCaptureBudget({ maxFiles: 2, maxDecodedBytes: 3, timeoutMs: 1_000 });
  const client = {
    async request() { return { encoding: "base64", data: Buffer.from([0x80, 0x81]).toString("base64") }; },
  } as unknown as AhpClient;
  try {
    await assert.rejects(fetchCopilotCliArtifacts(client,
      "copilotcli:/12345678-1234-1234-1234-123456789abc", "v1", {}, true, budget),
    (error) => error instanceof EvidenceCaptureLimitError && error.detail === "byte-limit");
  } finally {
    budget.dispose();
  }
});
