import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import type { AHPSessionSummary } from "./types.ts";
import type { ChangesetEnrichment } from "./changeset-enricher.ts";

const root = path.resolve(import.meta.dirname, "../..");
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) {
      return { shortCircuit: true, url: pathToFileURL(path.join(root, `${specifier.slice(2)}.ts`)).href };
    }
    if (specifier.startsWith(".") && !path.extname(specifier) && context.parentURL?.startsWith("file:")) {
      const candidate = fileURLToPath(new URL(`${specifier}.ts`, context.parentURL));
      if (existsSync(candidate)) return { shortCircuit: true, url: pathToFileURL(candidate).href };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith("/lib/ahp/map-session.ts")) return {
      shortCircuit: true, format: "module",
      source: ts.transpileModule(readFileSync(new URL(url), "utf8"), {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ESNext },
      }).outputText,
    };
    return nextLoad(url, context);
  },
});
after(() => hooks.deregister());
const { mapSessionToCard } = await import("./map-session.ts");
const binding = {
  sourceRevision: "catalog-fence", planVersion: "2026-10-17T00:00:00Z",
  contentRevision: "manifest", manifestRevision: "manifest", evidenceDigest: "captured-a",
};
function fixtures() {
  const summary: AHPSessionSummary & { _planwerkRiskFacts?: typeof binding } = {
    resource: "card", provider: "copilotcli", title: "Card", status: 1,
    createdAt: binding.planVersion, modifiedAt: binding.planVersion,
    changes: { files: 9, additions: 90, deletions: 9 },
    _planwerkRiskFacts: { ...binding },
  };
  const enrichment: ChangesetEnrichment & { _planwerkSource: typeof binding } = {
    codeFileCount: 1, totalFileCount: 1, additions: 2, deletions: 1, changesetVerified: true,
    fileChanges: [{ path: "/repo/a.ts", added: 2, removed: 1 }],
    planContentHash: "plan:actual-plan",
    artifacts: [{ id: "plan", type: "plan", title: "Plan", contentRef: "Plan", createdAt: 1, createdBy: "agent", status: "draft" }],
    _planwerkSource: { ...binding },
  };
  return { summary, enrichment };
}

test("cards and gates share the captured evidence identity, not the observation fence", () => {
  const { summary, enrichment } = fixtures();
  const card = mapSessionToCard(summary, "build", enrichment);
  assert.equal(card.sourceRevision, "captured-a");
  assert.equal(card.changesetVerified, true);
  assert.equal(card.filesChanged, 1);
  assert.equal(card.planContentHash, "plan:actual-plan");
});

test("mismatched digest or manifest bindings cannot project authoritative file/plan evidence", () => {
  for (const field of ["evidenceDigest", "manifestRevision", "planVersion"] as const) {
    const { summary, enrichment } = fixtures();
    enrichment._planwerkSource[field] = "different";
    const card = mapSessionToCard(summary, "build", enrichment);
    assert.equal(card.sourceRevision, undefined);
    assert.equal(card.changesetVerified, false);
    assert.equal(card.filesChanged, 9);
    assert.equal(card.fileChanges, undefined);
    assert.equal(card.planContentHash, undefined);
    assert.equal(card.artifacts?.some((artifact) => artifact.contentRef === "Plan") ?? false, false);
  }
});

test("live summaries still fence captured evidence on timestamp-only invalidation", () => {
  const { summary, enrichment } = fixtures();
  delete summary._planwerkRiskFacts;
  assert.equal(mapSessionToCard(summary, "build", enrichment).sourceRevision, "captured-a");
  summary.modifiedAt = "2026-10-17T00:00:01Z";
  const card = mapSessionToCard(summary, "build", enrichment);
  assert.equal(card.sourceRevision, undefined);
  assert.equal(card.changesetVerified, false);
  assert.equal(card.planContentHash, undefined);
});

test("last capture provenance remains visible as stale, never relabelled with catalog activity time", () => {
  const { summary, enrichment } = fixtures();
  const capture = { capturedAt: "2026-10-16T01:00:00Z", source: "explicit" as const, coverage: "bytes" as const };
  enrichment.evidenceCapture = capture;
  summary.lastEvidenceCapture = capture;
  assert.deepEqual(mapSessionToCard(summary, "build", enrichment).evidence, { state: "current", capture });
  summary.modifiedAt = "2026-10-17T20:00:00Z";
  const stale = mapSessionToCard(summary, "build", enrichment);
  assert.equal(stale.evidence?.state, "stale");
  assert.equal(stale.evidence?.capture?.capturedAt, capture.capturedAt);
  assert.equal(stale.changesetVerified, false);
});

test("legacy manifest-only evidence remains compatible without claiming captured bytes", () => {
  const { summary, enrichment } = fixtures();
  Reflect.deleteProperty(summary._planwerkRiskFacts!, "evidenceDigest");
  Reflect.deleteProperty(enrichment._planwerkSource, "evidenceDigest");
  Reflect.deleteProperty(summary._planwerkRiskFacts!, "manifestRevision");
  Reflect.deleteProperty(enrichment._planwerkSource, "manifestRevision");
  assert.equal(mapSessionToCard(summary, "build", enrichment).sourceRevision, "catalog-fence");
});
