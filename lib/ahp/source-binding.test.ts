import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { Changeset, ChangesetFile, ChangesetState } from "@microsoft/agent-host-protocol";
import type { AhpClient } from "@microsoft/agent-host-protocol/client";
import type { AHPSessionSummary } from "./types.ts";

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
const {
  attachAHPSourceRevision, beginEvidenceRead, bindEnrichment, enrichmentEvidenceDigest,
  enrichmentManifestRevision, enrichmentMatchesSummary, isEvidenceReadCurrent, summarySourceRevision,
  invalidateEvidenceReads, observeEvidenceRefresh, releaseEvidenceRead,
  cacheableSummary,
} = await import("./source-binding.ts");
const { enrichChangesetState } = await import("./changeset-enricher.ts");
const summary: AHPSessionSummary = {
  resource: "copilotcli:/test", provider: "copilotcli", title: "Test", status: 1,
  createdAt: "2026-10-17T00:00:00Z", modifiedAt: "2026-10-17T01:00:00Z",
  changes: { files: 1, additions: 1, deletions: 1 },
};
const catalog = { changeKind: "session", label: "Session", uriTemplate: "ahp-changeset:/test" } as Changeset;
const file: ChangesetFile = {
  id: "code",
  edit: {
    before: { uri: "file:///old.ts", content: { uri: "ahp-content:/before" } },
    after: { uri: "file:///new.ts", content: { uri: "ahp-content:/after" } },
    diff: { added: 1, removed: 1 },
  },
};
async function enrichment(bytes: string, changedFile = file) {
  const client = {
    async request(_method: string, params: { uri: string }) {
      return { data: Buffer.from(params.uri.endsWith("before") ? "old" : bytes).toString("base64"), encoding: "base64" };
    },
  } as unknown as AhpClient;
  return enrichChangesetState(client, catalog, { status: "ready", files: [changedFile] } as ChangesetState, true);
}

test("catalog timestamp/count revisions are invalidation fences, not captured digests", async () => {
  const a = await enrichment("aaa");
  const b = await enrichment("bbb");
  assert.equal(enrichmentManifestRevision(a), enrichmentManifestRevision(b));
  assert.notEqual(a.capturedFilesDigest, b.capturedFilesDigest);
  assert.notEqual(enrichmentEvidenceDigest(a), enrichmentEvidenceDigest(b));
  assert.equal(summarySourceRevision(summary), summarySourceRevision({ ...summary }));
  assert.notEqual(summarySourceRevision(summary), summarySourceRevision({ ...summary, modifiedAt: "new" }));
});

test("capture includes before/after identities, rename and deletion semantics", async () => {
  const renamed = await enrichment("new");
  const moved = await enrichment("new", { ...file, edit: { ...file.edit, before: { ...file.edit.before!, uri: "file:///other.ts" } } });
  const deleted = await enrichment("new", { ...file, edit: { before: file.edit.before, diff: file.edit.diff } });
  assert.notEqual(renamed.capturedFilesDigest, moved.capturedFilesDigest);
  assert.notEqual(renamed.capturedFilesDigest, deleted.capturedFilesDigest);
});

test("binary resource digests preserve bytes that would collapse under UTF-8 decoding", async () => {
  const capture = (byte: number) => enrichChangesetState({
    async request(_method: string, params: { encoding: string }) {
      assert.equal(params.encoding, "base64");
      return { data: Buffer.from([byte]).toString("base64"), encoding: "base64" };
    },
  } as unknown as AhpClient, catalog, { status: "ready", files: [file] } as ChangesetState, true);
  assert.notEqual((await capture(0x80)).capturedFilesDigest, (await capture(0x81)).capturedFilesDigest);
});

test("raw plan bytes participate even when the legacy normalized plan ref is unchanged", async () => {
  const captured = await enrichment("new");
  const first = { ...captured, planContent: "one two", planContentHash: "plan:equal" };
  const second = { ...captured, planContent: "one  two", planContentHash: "plan:equal" };
  assert.equal(enrichmentManifestRevision(first), enrichmentManifestRevision(second));
  assert.notEqual(enrichmentEvidenceDigest(first), enrichmentEvidenceDigest(second));
  const bound = bindEnrichment(summary, first);
  assert.equal(enrichmentMatchesSummary(summary, bound), true);
  assert.equal(enrichmentMatchesSummary(summary, { ...bound, planContent: second.planContent }), false);
});

test("legacy manifest-only bindings remain compatible, without inventing captured proof", async () => {
  const captured = await enrichment("new");
  delete captured.capturedFilesDigest;
  const bound = bindEnrichment(summary, captured);
  delete bound._planwerkSource.manifestRevision;
  assert.equal(bound._planwerkSource.evidenceDigest, undefined);
  assert.equal(enrichmentMatchesSummary(summary, bound), true);
  const explicit = { ...summary };
  attachAHPSourceRevision(explicit, { _meta: { revision: "host-v1" } });
  assert.equal(summarySourceRevision(explicit), "ahp:host-v1");
  attachAHPSourceRevision(explicit, { _meta: {} });
  assert.equal(summarySourceRevision(explicit), summarySourceRevision(summary));
});

test("capture time records a real collection and survives invalidation as metadata only", async () => {
  const session = { ...summary, modifiedAt: "2020-01-01T00:00:00Z" };
  const result = bindEnrichment(session, await enrichment("new"), "explicit");
  assert.equal(result.evidenceCapture?.source, "explicit");
  assert.equal(result.evidenceCapture?.coverage, "bytes");
  assert.notEqual(result.evidenceCapture?.capturedAt, session.modifiedAt);
  const invalidated = cacheableSummary(session, undefined, null);
  assert.deepEqual(invalidated.lastEvidenceCapture, result.evidenceCapture);
  assert.equal(invalidated._planwerkRiskFacts.evidenceDigest, undefined);
  assert.equal(invalidated._planwerkRiskFacts.contentRevision, undefined);
});

test("new generations supersede old reads only within the same host/session", () => {
  const first = beginEvidenceRead("host-a", summary.resource);
  const otherHost = beginEvidenceRead("host-b", summary.resource);
  assert.equal(isEvidenceReadCurrent("host-a", summary.resource, first), true);
  const newer = beginEvidenceRead("host-a", summary.resource);
  assert.equal(isEvidenceReadCurrent("host-a", summary.resource, first), false);
  releaseEvidenceRead("host-a", summary.resource, newer);
  assert.equal(isEvidenceReadCurrent("host-a", summary.resource, first), false, "finishing newer work cannot revive older work");
  releaseEvidenceRead("host-a", summary.resource, first);
  releaseEvidenceRead("host-b", summary.resource, otherHost);
});

test("removed/disposed coordination retains only active owners and releases host listeners", () => {
  const coordination = (globalThis as typeof globalThis & {
    __planwerkEvidenceCoordination: {
      reads: Map<string, symbol>;
      listeners: Map<string, Set<unknown>>;
    };
  }).__planwerkEvidenceCoordination;
  const baseline = { reads: coordination.reads.size, listeners: coordination.listeners.size };
  for (let i = 0; i < 100; i++) invalidateEvidenceReads("retired-host", `retired-${i}`);
  const token = beginEvidenceRead("retired-host", summary.resource);
  const stop = observeEvidenceRefresh("retired-host", () => {});
  invalidateEvidenceReads("retired-host", summary.resource);
  stop();
  assert.equal(coordination.reads.size, baseline.reads);
  releaseEvidenceRead("retired-host", summary.resource, token);
  assert.equal(coordination.reads.size, baseline.reads);
  assert.equal(coordination.listeners.size, baseline.listeners);
});
