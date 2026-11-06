import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { decisionPolicyKey, foundryConfiguration } from "./config.ts";

const names = [
  "XDG_CONFIG_HOME", "PLANWERK_DECISION_CONFIG_SOURCE", "PLANWERK_DECISION_ENDPOINT",
  "PLANWERK_DECISION_DEPLOYMENT", "PLANWERK_DECISION_API_KEY", "PLANWERK_DECISION_TOKEN",
  "PLANWERK_DECISION_POLICIES", "DECIDE_ENDPOINT", "DECIDE_DEPLOYMENT",
  "DECIDE_API_KEY", "AZURE_API_KEY", "DECIDE_TOKEN", "AZURE_ENTRA_TOKEN",
] as const;
const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
let directory: string;
function settings(value: unknown = { endpoint: "https://synthetic.services.ai.azure.com", deployment: "saved-deployment" }) {
  writeFileSync(join(directory, "decide", "config.json"), JSON.stringify(value));
}
beforeEach(() => {
  for (const name of names) delete process.env[name];
  directory = mkdtempSync(join(tmpdir(), "planwerk-decide-"));
  mkdirSync(join(directory, "decide"));
  process.env.XDG_CONFIG_HOME = directory;
  settings();
});
afterEach(() => {
  for (const name of names) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  rmSync(directory, { recursive: true, force: true });
});

test("saved skill credentials are never accessed without the explicit local opt-in", async () => {
  let reads = 0;
  await assert.rejects(foundryConfiguration(async () => { reads++; return "synthetic-only"; }), /Configure/);
  assert.equal(reads, 0);
});

test("opt-in reuses saved target and an endpoint-bound Keychain credential without exporting it", async () => {
  process.env.PLANWERK_DECISION_CONFIG_SOURCE = "decide";
  const config = await foundryConfiguration(async (endpoint) => {
    assert.equal(endpoint, "https://synthetic.services.ai.azure.com");
    return "synthetic-only";
  });
  assert.equal(config.deployment, "saved-deployment");
  assert.deepEqual(config.headers, { "api-key": "synthetic-only" });
  assert.equal(process.env.PLANWERK_DECISION_API_KEY, undefined);
  assert.equal(process.env.PLANWERK_DECISION_ENDPOINT, undefined);
});

test("explicit Planwerk target and credentials override skill settings without reading an unused file", async () => {
  process.env.PLANWERK_DECISION_CONFIG_SOURCE = "decide";
  process.env.PLANWERK_DECISION_ENDPOINT = "https://explicit.services.ai.azure.com";
  process.env.PLANWERK_DECISION_DEPLOYMENT = "explicit-deployment";
  process.env.PLANWERK_DECISION_TOKEN = "explicit-token";
  process.env.DECIDE_API_KEY = "shared-key";
  settings({ malformed: true });
  const config = await foundryConfiguration(async () => { throw Error("Unexpected Keychain read"); });
  assert.equal(config.endpoint, "https://explicit.services.ai.azure.com");
  assert.equal(config.deployment, "explicit-deployment");
  assert.deepEqual(config.headers, { Authorization: "Bearer explicit-token" });
});

test("shared environment credentials follow the skill's key-before-token precedence", async () => {
  process.env.PLANWERK_DECISION_CONFIG_SOURCE = "decide";
  process.env.DECIDE_API_KEY = "decide-key";
  process.env.AZURE_API_KEY = "azure-key";
  process.env.DECIDE_TOKEN = "decide-token";
  const read = async () => { throw Error("Unexpected Keychain read"); };
  assert.deepEqual((await foundryConfiguration(read)).headers, { "api-key": "decide-key" });
  delete process.env.DECIDE_API_KEY;
  assert.deepEqual((await foundryConfiguration(read)).headers, { "api-key": "azure-key" });
  delete process.env.AZURE_API_KEY;
  assert.deepEqual((await foundryConfiguration(read)).headers, { Authorization: "Bearer decide-token" });
});

test("empty credentials, invalid settings and denied Keychain access remain explicit failures", async () => {
  process.env.PLANWERK_DECISION_CONFIG_SOURCE = "decide";
  process.env.DECIDE_API_KEY = "";
  await assert.rejects(foundryConfiguration(async () => { throw Error("Unexpected Keychain read"); }), /valid server-side/);
  delete process.env.DECIDE_API_KEY;
  await assert.rejects(foundryConfiguration(async () => { throw Error("Keychain access denied"); }), /Keychain access denied/);
  settings({ endpoint: "https://example.com", deployment: "not-foundry" });
  await assert.rejects(foundryConfiguration(async () => { throw Error("Unexpected Keychain read"); }), /Configure/);
  settings({ malformed: true });
  await assert.rejects(foundryConfiguration(), /Saved decide configuration is invalid/);
});

test("saved deployment changes invalidate decision authority without reading a credential", () => {
  process.env.PLANWERK_DECISION_CONFIG_SOURCE = "decide";
  const first = decisionPolicyKey("risk", "synthetic-v1");
  settings({ endpoint: "https://synthetic.services.ai.azure.com", deployment: "replacement" });
  assert.notEqual(decisionPolicyKey("risk", "synthetic-v1"), first);
});
