import { test } from "node:test";
import assert from "node:assert/strict";

import {
  detectPairs,
  moduleKeyOf,
  shouldEscalate,
  effectiveRisk,
  pairBlocks,
  computeSignature,
  signatureSourceRevisions,
  coherenceDeferralPolicy,
  type DetectCard,
} from "./coherence-detect.ts";

const WD = "/repo";

function card(id: string, files: [string, number, number][], risk: DetectCard["risk"] = "low"): DetectCard {
  return {
    id,
    workingDirectory: WD,
    risk,
    files: files.map(([path, added, removed]) => ({ path, added, removed })),
  };
}

test("effectiveRisk treats unknown risk as medium", () => {
  assert.equal(effectiveRisk(undefined), "medium");
  assert.equal(effectiveRisk(null), "medium");
  assert.equal(effectiveRisk("low"), "low");
});

test("host identity fences detection and signatures even with identical repo and source facts", () => {
  const a = { ...card("a", [["/repo/src/x/shared.ts", 1, 1]]), hostUrl: "ws://a" };
  const b = { ...card("b", [["/repo/src/x/shared.ts", 1, 1]]), hostUrl: "ws://b" };
  assert.deepEqual(detectPairs([a, b], { moduleDepth: 2 }), []);
  const sameHost = { ...b, hostUrl: a.hostUrl };
  const pair = detectPairs([a, sameHost], { moduleDepth: 2 })[0];
  assert.ok(pair);
  assert.notEqual(pair.signature, computeSignature("file", pair.overlapPaths,
    { ...a, hostUrl: "ws://replacement" }, { ...b, hostUrl: "ws://replacement" }, 2));
});

test("deferral policy has deterministic reason-aware wake conditions and bounded failure retries", () => {
  assert.deepEqual(coherenceDeferralPolicy("inactive-session", 100, 1),
    { wakeCondition: "activation-change", retryAt: null });
  assert.deepEqual(coherenceDeferralPolicy("evidence-limit", 1, 1),
    { wakeCondition: "signature-change", retryAt: null });
  assert.deepEqual(coherenceDeferralPolicy("infrastructure", 1, 100),
    { wakeCondition: "retry-time", retryAt: 60_100 });
  assert.deepEqual(coherenceDeferralPolicy("infrastructure", 3, 100),
    { wakeCondition: "retry-time", retryAt: 240_100 });
  assert.deepEqual(coherenceDeferralPolicy("infrastructure", 5, 100),
    { wakeCondition: "manual", retryAt: null });
  assert.deepEqual(coherenceDeferralPolicy("invalid-model-output", 2, 100),
    { wakeCondition: "manual", retryAt: null });
});

test("file-tier overlap is detected and always escalates", () => {
  const pairs = detectPairs(
    [card("a", [["/repo/src/x/foo.ts", 10, 2]]), card("b", [["/repo/src/x/foo.ts", 3, 1]])],
    { moduleDepth: 2 }
  );
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].tier, "file");
  assert.deepEqual(pairs[0].overlapPaths, ["/repo/src/x/foo.ts"]);
  assert.equal(pairs[0].escalate, true);
  // sorted pair identity
  assert.equal(pairs[0].cardA, "a");
  assert.equal(pairs[0].cardB, "b");
});

test("module-tier only escalates when a card is >= medium risk", () => {
  const lowLow = detectPairs(
    [card("a", [["/repo/src/x/foo.ts", 5, 0]], "low"), card("b", [["/repo/src/x/bar.ts", 5, 0]], "low")],
    { moduleDepth: 2 }
  );
  assert.equal(lowLow.length, 1);
  assert.equal(lowLow[0].tier, "module");
  assert.equal(lowLow[0].escalate, false);

  const withMedium = detectPairs(
    [card("a", [["/repo/src/x/foo.ts", 5, 0]], "medium"), card("b", [["/repo/src/x/bar.ts", 5, 0]], "low")],
    { moduleDepth: 2 }
  );
  assert.equal(withMedium[0].tier, "module");
  assert.equal(withMedium[0].escalate, true);
});

test("same-repo guard: different working directories never pair", () => {
  const a: DetectCard = { id: "a", workingDirectory: "/repo1", risk: "high", files: [{ path: "/repo1/src/x/foo.ts", added: 1, removed: 0 }] };
  const b: DetectCard = { id: "b", workingDirectory: "/repo2", risk: "high", files: [{ path: "/repo2/src/x/foo.ts", added: 1, removed: 0 }] };
  // note: exact paths differ anyway, but module keys would collide without the guard
  const pairs = detectPairs([a, b], { moduleDepth: 2 });
  assert.equal(pairs.length, 0);
});

test("non-code files are excluded from overlap", () => {
  const pairs = detectPairs(
    [card("a", [["/repo/.copilot/session-state/plan.md", 9, 9]]), card("b", [["/repo/.copilot/session-state/plan.md", 9, 9]])],
    { moduleDepth: 2 }
  );
  assert.equal(pairs.length, 0);
});

test("signature changes when a shared file's edit size changes", () => {
  const a1 = card("a", [["/repo/src/x/foo.ts", 10, 2]]);
  const b1 = card("b", [["/repo/src/x/foo.ts", 3, 1]]);
  const sig1 = detectPairs([a1, b1], { moduleDepth: 2 })[0].signature;

  const a2 = card("a", [["/repo/src/x/foo.ts", 20, 2]]); // more additions
  const sig2 = detectPairs([a2, b1], { moduleDepth: 2 })[0].signature;
  assert.notEqual(sig1, sig2);

  // identical inputs → identical signature (stable)
  const sig1again = detectPairs([a1, b1], { moduleDepth: 2 })[0].signature;
  assert.equal(sig1, sig1again);
});

test("signature is order-independent for the pair", () => {
  const a = card("a", [["/repo/src/x/foo.ts", 10, 2]]);
  const b = card("b", [["/repo/src/x/foo.ts", 3, 1]]);
  const sigAB = computeSignature("file", ["/repo/src/x/foo.ts"], a, b, 2);
  const sigBA = computeSignature("file", ["/repo/src/x/foo.ts"], b, a, 2);
  assert.equal(sigAB, sigBA);
});

test("equal paths and line counts cannot reuse verdicts across source revisions", () => {
  const a = { ...card("a", [["/repo/src/x/foo.ts", 10, 2]]), sourceRevision: "source-a" };
  const b = { ...card("b", [["/repo/src/x/foo.ts", 3, 1]]), sourceRevision: "source-b" };
  const signature = computeSignature("file", ["/repo/src/x/foo.ts"], a, b, 2);
  assert.notEqual(signature,
    computeSignature("file", ["/repo/src/x/foo.ts"], { ...a, sourceRevision: "source-a2" }, b, 2));
  assert.deepEqual([...signatureSourceRevisions(signature)], [["a", "source-a"], ["b", "source-b"]]);
  assert.equal(signatureSourceRevisions("file|old-count-only-signature").size, 0);
  assert.equal(signatureSourceRevisions(computeSignature(
    "file", ["/repo/src/x/foo.ts"], { ...a, sourceRevision: undefined }, b, 2,
  )).size, 0);
});

test("moduleKeyOf ignores bare common roots but keeps deeper modules", () => {
  assert.equal(moduleKeyOf("/repo/src/foo.ts", WD, 1), null); // bare 'src'
  assert.equal(moduleKeyOf("/repo/src/orchestrator/foo.ts", WD, 2), "src/orchestrator");
  assert.equal(moduleKeyOf("/repo/foo.ts", WD, 2), null); // too shallow
});

test("shouldEscalate: file always, module by risk", () => {
  assert.equal(shouldEscalate("file", "low", "low"), true);
  assert.equal(shouldEscalate("module", "low", "low"), false);
  assert.equal(shouldEscalate("module", "low", "medium"), true);
  assert.equal(shouldEscalate("module", "high", "low"), true);
});

const BLOCK = { blockHighRiskShip: true };

test("pairBlocks: high-risk conflict blocks, low/medium is advisory", () => {
  assert.equal(pairBlocks("conflict", "high", "low", BLOCK), true); // pair-level: either high blocks both
  assert.equal(pairBlocks("conflict", "medium", "low", BLOCK), false);
  assert.equal(pairBlocks("conflict", "low", "low", BLOCK), false);
});

test("pairBlocks: high-risk provisional (detected/reviewing) blocks before verdict", () => {
  assert.equal(pairBlocks("detected", "high", "low", BLOCK), true);
  assert.equal(pairBlocks("reviewing", "high", "medium", BLOCK), true);
  assert.equal(pairBlocks("needs-human", "high", "low", BLOCK), true);
});

test("pairBlocks: resolved/dismissed never block", () => {
  assert.equal(pairBlocks("coherent", "high", "high", BLOCK), false);
  assert.equal(pairBlocks("dismissed", "high", "high", BLOCK), false);
});

test("pairBlocks: config toggle disables blocking entirely", () => {
  assert.equal(pairBlocks("conflict", "high", "high", { blockHighRiskShip: false }), false);
});
