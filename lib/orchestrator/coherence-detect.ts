/**
 * Pure, side-effect-free coherence detection logic.
 *
 * Deliberately free of `server-only`, better-sqlite3, and AHP imports so it can be
 * unit-tested in isolation with `node:test`. The server-side engine
 * (`coherence-engine.ts`) wraps these functions with persistence and I/O.
 */

import type { CoherenceTier, CoherenceStatus, RiskLevel } from "@/lib/types";

/** Patterns that indicate non-code files (session artifacts, temp, etc.).
 *  Kept in sync conceptually with changeset-enricher's NON_CODE_PATTERNS, but
 *  duplicated here to keep this module dependency-free and testable. */
const NON_CODE_PATTERNS: RegExp[] = [
  /^\.copilot\//,
  /\/\.copilot\//,
  /\/session-state\//,
  /\/plan\.md$/,
  /\/research\.md$/,
  /\/spec\.md$/,
  /\/specification\.md$/,
  /\/design\.md$/,
  /\/decision\.md$/,
  /\/test-plan\.md$/,
  /\.tmp$/,
  /^\/tmp\//,
];

/** Top-level directory names too shallow to be a meaningful "module" anchor. */
const COMMON_ROOTS = new Set([
  "src",
  "app",
  "lib",
  "components",
  "pages",
  "public",
  "test",
  "tests",
  "packages",
]);

const RISK_ORDER: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 };

/** A single changed file for detection purposes. */
export interface DetectFile {
  path: string;
  added: number;
  removed: number;
}

/** Minimal per-card input for detection. `risk` must already be the effective
 *  (conservative) risk — use {@link effectiveRisk} before passing it in. */
export interface DetectCard {
  id: string;
  sourceRevision?: string;
  workingDirectory?: string;
  workingDirectories?: string[];
  risk: RiskLevel;
  files: DetectFile[];
}

export interface DetectOptions {
  /** Directory segments (relative to workingDirectory) compared for module tier. */
  moduleDepth: number;
}

export interface DetectedPair {
  /** Sorted so the unordered pair has a stable identity. */
  cardA: string;
  cardB: string;
  tier: CoherenceTier;
  /** Shared exact files (file tier) or shared module dirs (module tier). */
  overlapPaths: string[];
  signature: string;
  /** Whether this pair warrants an LLM review (file tier always; module tier
   *  only when either card is medium/high risk). */
  escalate: boolean;
}

/** Missing/unknown risk is treated as medium for coherence — never suppress
 *  escalation just because async risk assessment hasn't landed yet. */
export function effectiveRisk(level?: RiskLevel | null): RiskLevel {
  return level ?? "medium";
}

export function isCodePath(path: string): boolean {
  return !NON_CODE_PATTERNS.some((p) => p.test(path));
}

/** Stable sorted key for an unordered card pair. */
export function pairKey(a: string, b: string): [string, string] {
  return a <= b ? [a, b] : [b, a];
}

/** Strip the workingDirectory prefix so module keys are repo-relative. */
function toRelative(path: string, workingDirectory?: string): string {
  if (!workingDirectory) return path.replace(/^\/+/, "");
  let wd = workingDirectory;
  if (!wd.endsWith("/")) wd += "/";
  if (path.startsWith(wd)) return path.slice(wd.length);
  return path.replace(/^\/+/, "");
}

/**
 * Repo-relative module key for a path, or null when the path is too shallow or
 * anchored only on a common root (e.g. bare `src/`) to be a useful module signal.
 */
export function moduleKeyOf(
  path: string,
  workingDirectory: string | undefined,
  depth: number
): string | null {
  const rel = toRelative(path, workingDirectory);
  const segments = rel.split("/").filter(Boolean);
  // Need at least `depth` dir segments plus a filename to form a real module.
  if (segments.length <= depth) return null;
  const key = segments.slice(0, depth).join("/");
  // A single common-root segment (e.g. "src") is not a meaningful module.
  if (depth === 1 && COMMON_ROOTS.has(key)) return null;
  return key;
}

/** File tier always escalates; module tier only if either card is >= medium. */
export function shouldEscalate(tier: CoherenceTier, riskA: RiskLevel, riskB: RiskLevel): boolean {
  if (tier === "file") return true;
  return Math.max(RISK_ORDER[riskA], RISK_ORDER[riskB]) >= RISK_ORDER.medium;
}

/**
 * Deterministic signature for a pair — the staleness key. Changes whenever the
 * shared surface or either card's edits to it change, so a changed signature
 * forces a fresh verdict. The host source revision is a conservative fence:
 * equal paths/counts alone never prove equal code.
 */
export function computeSignature(
  tier: CoherenceTier,
  overlapPaths: string[],
  cardA: DetectCard,
  cardB: DetectCard,
  moduleDepth: number
): string {
  const part = (card: DetectCard) => {
    const relevant = card.files
      .filter((f) => {
        if (tier === "file") return overlapPaths.includes(f.path);
        // module tier: this card's files under any shared module dir
        const key = moduleKeyOf(f.path, card.workingDirectory, moduleDepth);
        return key !== null && overlapPaths.includes(key);
      })
      .map((f) => [toRelative(f.path, card.workingDirectory), f.added, f.removed] as const)
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    return [card.id, card.sourceRevision?.trim() ? card.sourceRevision : null, relevant];
  };
  const [a, b] = cardA.id <= cardB.id ? [cardA, cardB] : [cardB, cardA];
  return JSON.stringify(["coherence-v2", tier, [...overlapPaths].sort(), part(a), part(b)]);
}

/** Legacy/count-only signatures cannot authorize a source-bound verdict. */
export function signatureSourceRevisions(signature: string): Map<string, string> {
  try {
    const value: unknown = JSON.parse(signature);
    if (!Array.isArray(value) || value[0] !== "coherence-v2") return new Map();
    const sources = new Map<string, string>();
    for (const part of [value[3], value[4]]) {
      if (!Array.isArray(part) || typeof part[0] !== "string" ||
          typeof part[1] !== "string" || !part[1].trim()) return new Map();
      sources.set(part[0], part[1]);
    }
    return sources;
  } catch {
    return new Map();
  }
}

/**
 * Detect overlapping pairs among in-flight cards using inverted indexes
 * (path → cards, moduleKey → cards) so we only consider genuinely shared
 * buckets rather than a blind O(n²) scan.
 */
export function detectPairs(cards: DetectCard[], opts: DetectOptions): DetectedPair[] {
  const byId = new Map(cards.map((c) => [c.id, c]));

  // Code-only file paths per card.
  const codePaths = new Map<string, string[]>();
  for (const card of cards) {
    codePaths.set(
      card.id,
      card.files.map((f) => f.path).filter(isCodePath)
    );
  }

  const pathIndex = new Map<string, Set<string>>();
  const moduleIndex = new Map<string, Set<string>>();

  for (const card of cards) {
    for (const path of codePaths.get(card.id) ?? []) {
      (pathIndex.get(path) ?? pathIndex.set(path, new Set()).get(path)!).add(card.id);
      const key = moduleKeyOf(path, card.workingDirectory, opts.moduleDepth);
      if (key) {
        (moduleIndex.get(key) ?? moduleIndex.set(key, new Set()).get(key)!).add(card.id);
      }
    }
  }

  // Candidate pairs from shared buckets → accumulate shared files / module dirs.
  const sharedFiles = new Map<string, Set<string>>(); // pairKey → shared exact paths
  const sharedModules = new Map<string, Set<string>>(); // pairKey → shared module dirs

  const addPairs = (
    members: Set<string>,
    value: string,
    into: Map<string, Set<string>>
  ) => {
    const ids = [...members];
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = byId.get(ids[i])!;
        const b = byId.get(ids[j])!;
        // Same-repo guard: only pair cards in the same working directory.
        const aDirectories = a.workingDirectories ?? (a.workingDirectory ? [a.workingDirectory] : []);
        const bDirectories = b.workingDirectories ?? (b.workingDirectory ? [b.workingDirectory] : []);
        if (!aDirectories.some((directory) => bDirectories.includes(directory))) continue;
        const [ka, kb] = pairKey(ids[i], ids[j]);
        const k = `${ka}\u0000${kb}`;
        (into.get(k) ?? into.set(k, new Set()).get(k)!).add(value);
      }
    }
  };

  for (const [path, members] of pathIndex) {
    if (members.size >= 2) addPairs(members, path, sharedFiles);
  }
  for (const [key, members] of moduleIndex) {
    if (members.size >= 2) addPairs(members, key, sharedModules);
  }

  const pairs: DetectedPair[] = [];
  const seen = new Set<string>();
  const allKeys = new Set([...sharedFiles.keys(), ...sharedModules.keys()]);

  for (const k of allKeys) {
    if (seen.has(k)) continue;
    seen.add(k);
    const [cardA, cardB] = k.split("\u0000");
    const a = byId.get(cardA)!;
    const b = byId.get(cardB)!;

    const files = sharedFiles.get(k);
    const modules = sharedModules.get(k);

    const tier: CoherenceTier = files && files.size > 0 ? "file" : "module";
    const overlapPaths = [...(tier === "file" ? files! : modules!)].sort();

    const signature = computeSignature(tier, overlapPaths, a, b, opts.moduleDepth);
    const escalate = shouldEscalate(tier, a.risk, b.risk);

    pairs.push({ cardA, cardB, tier, overlapPaths, signature, escalate });
  }

  return pairs;
}

/**
 * Whether a persisted pair blocks `review → ship` right now (computed live, never
 * read from a stored flag). A pair blocks when it is a confirmed `conflict`, OR a
 * provisional `detected`/`reviewing` pair, AND either card is high-risk under the
 * current config. Pair-level: if it blocks, both member cards are blocked.
 */
export function pairBlocks(
  status: CoherenceStatus,
  riskA: RiskLevel,
  riskB: RiskLevel,
  opts: { blockHighRiskShip: boolean }
): boolean {
  if (!opts.blockHighRiskShip) return false;
  const provisional = status === "detected" || status === "reviewing" || status === "needs-human";
  const blockingStatus = status === "conflict" || provisional;
  if (!blockingStatus) return false;
  const highRiskInvolved =
    RISK_ORDER[riskA] >= RISK_ORDER.high || RISK_ORDER[riskB] >= RISK_ORDER.high;
  return highRiskInvolved;
}
