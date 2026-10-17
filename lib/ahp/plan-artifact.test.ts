import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { RpcError, type AhpClient } from "@microsoft/agent-host-protocol/client";

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
