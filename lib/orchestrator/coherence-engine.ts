import "server-only";

import { getDb } from "@/lib/db/schema";
import { ensureCoherenceSafetySchema } from "@/lib/db/coherence-safety-schema";
import { isSessionOwnedByHost } from "@/lib/db/session-ownership";
import type {
  KanbanCard,
  RiskLevel,
  CoherenceStatus,
  CoherenceTier,
  CoherenceConflictPeer,
} from "@/lib/types";
import { getRiskForAutomation } from "./risk-store";
import {
  detectPairs,
  pairBlocks,
  pairKey,
  signatureSourceRevisions,
  coherenceDeferralPolicy,
  type CoherenceDeferralReason,
  type CoherenceWakeCondition,
  type DetectCard,
  type DetectedPair,
} from "./coherence-detect";
import { WORK_LEASE_MS } from "@/lib/db/work-lease-schema";
import { resolveAuthoritativeGateRevision } from "./gate-revision";
import { coherenceWait } from "../ahp/automation-wait";
import type { AutomationWait } from "../types";

export const COHERENCE_RETRY_MS = 60_000;

export interface CoherenceConfig {
  enabled: boolean;
  moduleDepth: number;
  blockHighRiskShip: boolean;
}

export const DEFAULT_COHERENCE_CONFIG: CoherenceConfig = {
  enabled: true,
  moduleDepth: 2,
  blockHighRiskShip: true,
};

export interface CoherenceRow {
  id: number;
  cardA: string;
  cardB: string;
  tier: CoherenceTier;
  overlapPaths: string[];
  signature: string;
  status: CoherenceStatus;
  riskSnapshot?: RiskLevel;
  verdictSummary?: string;
  findings?: string[];
  dismissedSignature?: string;
  updatedAt: string;
  hostUrl?: string;
  deferralReason?: CoherenceDeferralReason;
  wakeCondition?: CoherenceWakeCondition;
  retryAt?: number;
  failureAttempts?: number;
}

interface CoherenceRowDb {
  id: number;
  card_a: string;
  card_b: string;
  tier: string;
  overlap_paths: string;
  signature: string;
  status: string;
  risk_snapshot: string | null;
  verdict_summary: string | null;
  findings_json: string | null;
  dismissed_signature: string | null;
  updated_at: string;
  host_url: string | null;
  deferral_reason: CoherenceDeferralReason | null;
  wake_condition: CoherenceWakeCondition | null;
  retry_at_ms: number | null;
  failure_attempts: number;
  activation_key: string | null;
}

function coherenceDb() {
  const db = getDb();
  ensureCoherenceSafetySchema(db);
  return db;
}

function parseJsonArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

function mapRow(row: CoherenceRowDb): CoherenceRow {
  return {
    id: row.id,
    cardA: row.card_a,
    cardB: row.card_b,
    tier: row.tier as CoherenceTier,
    overlapPaths: parseJsonArray(row.overlap_paths),
    signature: row.signature,
    status: row.status as CoherenceStatus,
    riskSnapshot: (row.risk_snapshot as RiskLevel) || undefined,
    verdictSummary: row.verdict_summary || undefined,
    findings: row.findings_json ? parseJsonArray(row.findings_json) : undefined,
    dismissedSignature: row.dismissed_signature || undefined,
    updatedAt: row.updated_at,
    hostUrl: row.host_url ?? undefined,
    deferralReason: row.deferral_reason ?? undefined,
    wakeCondition: row.wake_condition ?? undefined,
    retryAt: row.retry_at_ms ?? undefined,
    failureAttempts: row.failure_attempts ?? 0,
  };
}

const OPEN_STATUSES = "('detected','reviewing','conflict','needs-human')";

/** Effective (conservative) risk for a card — stale/missing → high. */
function riskOf(cardId: string): RiskLevel {
  return getRiskForAutomation(cardId) ?? "high";
}

function maxRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  const order: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 };
  return order[a] >= order[b] ? a : b;
}

/**
 * Reconcile detected overlaps with persisted rows, and close rows that no longer
 * apply. Returns the rows that are `detected` + escalatable, for the async
 * executor to review (never reviewed inline).
 */
export function syncCoherence(
  cards: KanbanCard[],
  config: CoherenceConfig,
  hostUrl: string,
  options: { authoritativeSessionUris?: ReadonlySet<string> } = {},
): CoherenceRow[] {
  if (!config.enabled || !hostUrl?.trim()) return [];
  const db = coherenceDb();
  const hostCards = cards.filter((card) => isSessionOwnedByHost(db, card.id, hostUrl));

  // In-flight cards with real code diffs.
  const inFlight = hostCards.filter(
    (c) => !c.isArchived && (c.phase === "build" || c.phase === "review") && c.fileChanges?.length
  );

  const detectCards: DetectCard[] = inFlight.map((c) => ({
    id: c.id,
    hostUrl,
    sourceRevision: c.changesetVerified === true ? c.sourceRevision : undefined,
    workingDirectory: c.workingDirectory,
    workingDirectories: c.workingDirectories,
    risk: riskOf(c.id),
    files: (c.fileChanges ?? []).map((f) => ({ path: f.path, added: f.added, removed: f.removed })),
  }));

  const detected = detectPairs(detectCards, { moduleDepth: config.moduleDepth });
  const detectedByKey = new Map<string, DetectedPair>();
  for (const p of detected) detectedByKey.set(`${p.cardA}\u0000${p.cardB}`, p);

  const now = "datetime('now')";
  const escalatable: CoherenceRow[] = [];
  const activationKey = (a: string, b: string) => JSON.stringify(
    [a, b].map((id) => [id, hostCards.find((card) => card.id === id)?.runtime ?? "unknown"]),
  );

  const upsert = db.transaction(() => {
    // 1. Upsert detected pairs.
    for (const p of detected) {
      const risk = maxRisk(riskOf(p.cardA), riskOf(p.cardB));
      const existing = db
        .prepare("SELECT * FROM coherence_conflicts WHERE card_a = ? AND card_b = ?")
        .get(p.cardA, p.cardB) as CoherenceRowDb | undefined;

      if (!existing) {
        db.prepare(
          `INSERT INTO coherence_conflicts
             (card_a, card_b, tier, overlap_paths, signature, status, risk_snapshot, host_url, activation_key)
           VALUES (?, ?, ?, ?, ?, 'detected', ?, ?, ?)`
        ).run(p.cardA, p.cardB, p.tier, JSON.stringify(p.overlapPaths), p.signature, risk,
          hostUrl, activationKey(p.cardA, p.cardB));
        continue;
      }

      const row = mapRow(existing);
      if (existing.host_url !== hostUrl) continue;

      // Signature unchanged → leave as-is (verdict/dismissal still valid).
      if (row.signature === p.signature) {
        if (existing.wake_condition === "activation-change" &&
            existing.activation_key !== activationKey(p.cardA, p.cardB)) {
          db.prepare(`
            UPDATE coherence_conflicts SET deferral_reason = NULL, wake_condition = NULL,
              retry_at_ms = NULL, failure_attempts = 0, review_lease_expires_at_ms = NULL,
              activation_key = ? WHERE id = ?
          `).run(activationKey(p.cardA, p.cardB), row.id);
        }
        // A dismissal only holds for its own signature (already equal here).
        continue;
      }

      // Signature changed. If the human dismissed *this new* signature, keep dismissed.
      if (row.dismissedSignature && row.dismissedSignature === p.signature) {
        db.prepare(
          `UPDATE coherence_conflicts
             SET tier = ?, overlap_paths = ?, signature = ?, status = 'dismissed',
                 risk_snapshot = ?, updated_at = ${now}
           WHERE id = ?`
        ).run(p.tier, JSON.stringify(p.overlapPaths), p.signature, risk, row.id);
        continue;
      }

      // Otherwise the overlap materially changed → reopen for a fresh verdict.
      db.prepare(
        `UPDATE coherence_conflicts
           SET tier = ?, overlap_paths = ?, signature = ?, status = 'detected',
               verdict_summary = NULL, findings_json = NULL, risk_snapshot = ?,
               resolved_at = NULL, resolved_by = NULL, updated_at = ${now}
               , review_owner_id = NULL, review_lease_expires_at_ms = NULL
               , deferral_reason = NULL, wake_condition = NULL, retry_at_ms = NULL,
                 failure_attempts = 0, activation_key = ?
         WHERE id = ?`
      ).run(p.tier, JSON.stringify(p.overlapPaths), p.signature, risk,
        activationKey(p.cardA, p.cardB), row.id);
    }

    // 2. Cleanup: close open rows whose pair no longer overlaps, or where either
    //    card is gone/shipped/archived.
    const liveById = new Map(hostCards.map((c) => [c.id, c]));
    const openRows = db
      .prepare(`SELECT * FROM coherence_conflicts WHERE host_url = ? AND status IN ${OPEN_STATUSES}`)
      .all(hostUrl) as CoherenceRowDb[];

    for (const dbRow of openRows) {
      const row = mapRow(dbRow);
      const key = `${row.cardA}\u0000${row.cardB}`;
      const stillDetected = detectedByKey.has(key);
      const a = liveById.get(row.cardA);
      const b = liveById.get(row.cardB);
      if (![row.cardA, row.cardB].every((id) => isSessionOwnedByHost(db, id, hostUrl))) continue;
      const authoritativelyRemoved = options.authoritativeSessionUris !== undefined &&
        (!options.authoritativeSessionUris.has(row.cardA) || !options.authoritativeSessionUris.has(row.cardB));
      const cardGone = authoritativelyRemoved ||
        a?.isArchived || b?.isArchived || a?.phase === "ship" || b?.phase === "ship";
      if (!cardGone && (!a || !b)) continue;

      // Losing live enrichment is not proof that the overlap disappeared.
      if (!stillDetected && !cardGone &&
          ![a!, b!].every((card) => {
            if (card.changesetVerified !== true) return false;
            const source = resolveAuthoritativeGateRevision(db, card.id, "build", hostUrl);
            return source.ok && source.sourceRevision === card.sourceRevision;
          })) {
        continue;
      }

      if (!stillDetected || cardGone) {
        db.prepare(
          `UPDATE coherence_conflicts
             SET status = 'coherent', resolved_at = ${now}, resolved_by = 'auto',
                 updated_at = ${now}, review_owner_id = NULL,
                 review_lease_expires_at_ms = NULL
                 , deferral_reason = NULL, wake_condition = NULL, retry_at_ms = NULL
           WHERE id = ?`
        ).run(row.id);
      }
    }
  });

  upsert();

  // Collect escalatable detected rows for the executor (after the transaction).
  for (const p of detected) {
    if (!p.escalate) continue;
    const dbRow = db
      .prepare(
        `SELECT * FROM coherence_conflicts WHERE card_a = ? AND card_b = ? AND status = 'detected'
           AND host_url = ?
           AND (wake_condition IS NULL OR (wake_condition = 'retry-time' AND retry_at_ms <= ?))
           AND COALESCE(review_lease_expires_at_ms, 0) <= ?`
      )
      .get(p.cardA, p.cardB, hostUrl, Date.now(), Date.now()) as CoherenceRowDb | undefined;
    if (dbRow) escalatable.push(mapRow(dbRow));
  }

  return escalatable;
}

export function claimForReviewOwner(
  rowId: number,
  signature: string,
  ownerId: string,
  hostUrl: string,
  leaseMs = WORK_LEASE_MS,
  now = Date.now(),
): boolean {
  const db = coherenceDb();
  if (!hostUrl?.trim()) return false;
  const row = db.prepare("SELECT * FROM coherence_conflicts WHERE id = ?")
    .get(rowId) as CoherenceRowDb | undefined;
  if (!row || row.host_url !== hostUrl ||
      ![row.card_a, row.card_b].every((id) => isSessionOwnedByHost(db, id, hostUrl))) return false;
  const res = db
    .prepare(
      `UPDATE coherence_conflicts
       SET status = 'reviewing', review_owner_id = ?,
           review_lease_expires_at_ms = ?, updated_at = datetime('now')
       WHERE id = ? AND status = 'detected' AND signature = ?
         AND (wake_condition IS NULL OR (wake_condition = 'retry-time' AND retry_at_ms <= ?))
         AND COALESCE(review_lease_expires_at_ms, 0) <= ?`
    )
    .run(ownerId, now + leaseMs, rowId, signature, now, now);
  return res.changes > 0;
}

export function renewCoherenceReviewLease(
  rowId: number,
  signature: string,
  ownerId: string,
  leaseMs = WORK_LEASE_MS,
  now = Date.now(),
): boolean {
  return coherenceDb().prepare(`
    UPDATE coherence_conflicts
    SET review_lease_expires_at_ms = ?
    WHERE id = ? AND status = 'reviewing' AND signature = ?
      AND review_owner_id = ? AND review_lease_expires_at_ms > ?
  `).run(
    now + leaseMs,
    rowId,
    signature,
    ownerId,
    now,
  ).changes === 1;
}

function hasCurrentSources(row: CoherenceRowDb, hostUrl?: string): boolean {
  if (!hostUrl || row.host_url !== hostUrl) return false;
  const sources = signatureSourceRevisions(row.signature);
  return [row.card_a, row.card_b].every((cardId) => {
    if (!isSessionOwnedByHost(coherenceDb(), cardId, hostUrl)) return false;
    const current = resolveAuthoritativeGateRevision(coherenceDb(), cardId, "build", hostUrl);
    return current.ok && sources.get(cardId) === current.sourceRevision;
  });
}

/** Recheck ownership and source facts after each asynchronous boundary. */
export function isCoherenceReviewCurrent(
  rowId: number,
  signature: string,
  ownerId: string,
  hostUrl: string,
  now = Date.now(),
): boolean {
  const row = coherenceDb().prepare(`
    SELECT * FROM coherence_conflicts
    WHERE id = ? AND status = 'reviewing' AND signature = ?
      AND review_owner_id = ? AND review_lease_expires_at_ms > ?
  `).get(rowId, signature, ownerId, now) as CoherenceRowDb | undefined;
  return Boolean(row && hasCurrentSources(row, hostUrl));
}

/** Retryable infrastructure/evidence failures are not human review verdicts. */
export function deferCoherenceReview(
  rowId: number,
  signature: string,
  ownerId: string,
  reason: CoherenceDeferralReason,
  now = Date.now(),
): boolean {
  const db = coherenceDb();
  return db.transaction(() => {
    const row = db.prepare(`
      SELECT failure_attempts FROM coherence_conflicts
      WHERE id = ? AND status = 'reviewing' AND signature = ?
        AND review_owner_id = ? AND review_lease_expires_at_ms > ?
    `).get(rowId, signature, ownerId, now) as { failure_attempts: number } | undefined;
    if (!row) return false;
    const attempts = (row.failure_attempts ?? 0) + 1;
    const policy = coherenceDeferralPolicy(reason, attempts, now);
    const summary = reason === "evidence-limit"
      ? "Unsupported coherence review: evidence exceeds the complete-review limit; chunked review is not supported."
      : reason === "inactive-session"
        ? "Coherence review deferred: inactive-session. Explicit refresh captures digests, not reviewable code; cold-session review is unsupported. Activate both sessions or explicitly accept divergence for the current revision."
        : `Coherence review deferred: ${reason}; wake: ${policy.wakeCondition}.`;
    return db.prepare(`
      UPDATE coherence_conflicts
      SET status = 'detected', verdict_summary = ?, findings_json = NULL,
          resolved_at = NULL, resolved_by = NULL, review_owner_id = NULL,
          review_lease_expires_at_ms = ?, deferral_reason = ?, wake_condition = ?,
          retry_at_ms = ?, failure_attempts = ?, updated_at = datetime('now')
      WHERE id = ? AND status = 'reviewing' AND signature = ?
        AND review_owner_id = ? AND review_lease_expires_at_ms > ?
    `).run(summary, policy.retryAt, reason, policy.wakeCondition, policy.retryAt,
      attempts, rowId, signature, ownerId, now).changes === 1;
  }).immediate();
}

/** Race-safe verdict write: only applies if the row is still reviewing the same
 *  signature (a human dismiss or a fresh signature otherwise wins). */
export function completeReview(
  rowId: number,
  signature: string,
  verdict: { status: "conflict" | "coherent" | "needs-human"; summary: string; findings: string[] },
  ownerId: string,
  now = Date.now(),
  hostUrl?: string,
): boolean {
  const db = coherenceDb();
  const resolved = verdict.status === "coherent";
  return db.transaction(() => {
    const row = db.prepare(`
      SELECT * FROM coherence_conflicts WHERE id = ? AND signature = ?
    `).get(rowId, signature) as CoherenceRowDb | undefined;
    if (!row || !hasCurrentSources(row, hostUrl)) return false;
    const res = db
      .prepare(
        `UPDATE coherence_conflicts
         SET status = ?, verdict_summary = ?, findings_json = ?,
             resolved_at = ${resolved ? "datetime('now')" : "NULL"},
             resolved_by = ${resolved ? "'reviewer'" : "NULL"},
             updated_at = datetime('now'),
             review_lease_expires_at_ms = NULL, review_owner_id = NULL
             , deferral_reason = NULL, wake_condition = NULL, retry_at_ms = NULL,
               failure_attempts = 0
       WHERE id = ? AND status = 'reviewing' AND signature = ?
         AND review_owner_id = ? AND review_lease_expires_at_ms > ?`
      )
      .run(
        verdict.status,
        verdict.summary,
        JSON.stringify(verdict.findings),
        rowId,
        signature,
        ownerId,
        now,
      );
    return res.changes > 0;
  }).immediate();
}

/** Human "Accept divergence": dismiss the pair for its current signature. A later
 *  different signature reopens it. */
export function dismissConflict(cardA: string, cardB: string, hostUrl: string): CoherenceRow | null {
  const db = coherenceDb();
  return db.transaction(() => {
    const [a, b] = pairKey(cardA, cardB);
    const existing = db
      .prepare("SELECT * FROM coherence_conflicts WHERE card_a = ? AND card_b = ?")
      .get(a, b) as CoherenceRowDb | undefined;
    if (!existing || !hasCurrentSources(existing, hostUrl)) return null;
    const row = mapRow(existing);
    const result = db.prepare(
      `UPDATE coherence_conflicts
         SET status = 'dismissed', dismissed_signature = signature,
             resolved_at = datetime('now'), resolved_by = 'human',
             review_owner_id = NULL, review_lease_expires_at_ms = NULL,
             updated_at = datetime('now')
       WHERE id = ? AND host_url = ? AND signature = ?`
    ).run(row.id, hostUrl, row.signature);
    if (result.changes !== 1) return null;
    // Durable audit trail (mirrors gate-engine.logManualOverride).
    db.prepare(
      "INSERT INTO heartbeat_log (detection, card_id, action_taken, detail) VALUES (?, ?, ?, ?)"
    ).run("coherence-dismissed", cardA, "accept-divergence", `${a} <> ${b}`);
    return { ...row, status: "dismissed" as const, dismissedSignature: row.signature };
  }).immediate();
}

/** Open (non-terminal) coherence rows involving a card. */
export function getOpenConflictsForCard(cardId: string): CoherenceRow[] {
  const db = coherenceDb();
  const rows = db
    .prepare(
      `SELECT * FROM coherence_conflicts
         WHERE (card_a = ? OR card_b = ?) AND status IN ${OPEN_STATUSES}
         ORDER BY updated_at DESC`
    )
    .all(cardId, cardId) as CoherenceRowDb[];
  return rows.map(mapRow);
}

function resolveOwnedCoherenceHost(cardId: string, hostUrl?: string): string | undefined {
  const db = coherenceDb();
  const host = hostUrl ?? (db.prepare("SELECT host_url FROM session_cache WHERE session_uri = ?")
    .get(cardId) as { host_url: string } | undefined)?.host_url;
  return host?.trim() && isSessionOwnedByHost(db, cardId, host) ? host : undefined;
}

/**
 * Rows that block this card from shipping *right now* — computed live from current
 * risk + config, never a stored flag. Pair-level: any qualifying row blocks both
 * member cards.
 */
export function getShipBlockingConflicts(
  cardId: string,
  config: CoherenceConfig = DEFAULT_COHERENCE_CONFIG,
  hostUrl?: string,
): CoherenceRow[] {
  if (!config.enabled) return [];
  const db = coherenceDb();
  const host = resolveOwnedCoherenceHost(cardId, hostUrl);
  if (!host) return [];
  db.transaction(() => {
    const settled = db.prepare(`
      SELECT * FROM coherence_conflicts
      WHERE (card_a = ? OR card_b = ?)
        AND (status = 'dismissed' OR (status = 'coherent' AND resolved_by = 'reviewer'))
    `).all(cardId, cardId) as CoherenceRowDb[];
    for (const row of settled) {
      if (row.host_url !== null && row.host_url !== host) continue;
      if (hasCurrentSources(row, host)) continue;
      db.prepare(`
        UPDATE coherence_conflicts
        SET status = 'detected', verdict_summary = NULL, findings_json = NULL,
            resolved_at = NULL, resolved_by = NULL, review_owner_id = NULL,
            review_lease_expires_at_ms = NULL, updated_at = datetime('now'),
            deferral_reason = NULL, wake_condition = NULL, retry_at_ms = NULL
        WHERE id = ?
      `).run(row.id);
    }
  }).immediate();
  return getOpenConflictsForCard(cardId).filter((row) => (row.hostUrl === host || row.hostUrl === undefined) &&
    pairBlocks(row.status, riskOf(row.cardA), riskOf(row.cardB), {
      blockHighRiskShip: config.blockHighRiskShip,
    })
  );
}

/** Confirmed conflicts (status='conflict') involving a card, for attention/enrichment. */
export function getConfirmedConflictsForCard(cardId: string): CoherenceRow[] {
  const db = coherenceDb();
  const rows = db
    .prepare(
      `SELECT * FROM coherence_conflicts
         WHERE (card_a = ? OR card_b = ?) AND status = 'conflict'
         ORDER BY updated_at DESC`
    )
    .all(cardId, cardId) as CoherenceRowDb[];
  return rows.map(mapRow);
}

/** Resolve a card's display title from the session cache (best-effort). */
function resolveCardTitle(cardId: string): string | undefined {
  const db = getDb();
  const row = db
    .prepare("SELECT summary_json FROM session_cache WHERE session_uri = ?")
    .get(cardId) as { summary_json: string } | undefined;
  if (!row) return undefined;
  try {
    return (JSON.parse(row.summary_json) as { title?: string }).title;
  } catch {
    return undefined;
  }
}

/** Build the card-attached coherence summary for enrichment. */
export function buildCoherenceSummary(
  cardId: string,
  cardTitleById: (id: string) => string | undefined = resolveCardTitle,
  config: CoherenceConfig = DEFAULT_COHERENCE_CONFIG,
  hostUrl?: string,
): { peers: CoherenceConflictPeer[]; blocking: boolean; wait?: AutomationWait } | null {
  const host = resolveOwnedCoherenceHost(cardId, hostUrl);
  if (!host) return null;
  const confirmed = getConfirmedConflictsForCard(cardId)
    .filter((row) => row.hostUrl === host || row.hostUrl === undefined);
  const blocking = getShipBlockingConflicts(cardId, config, host).length > 0;
  const pending = getOpenConflictsForCard(cardId)
    .filter((row) => row.hostUrl === host && (row.status === "detected" || row.status === "reviewing"))
    .sort((a, b) => Number(Boolean(b.deferralReason)) - Number(Boolean(a.deferralReason)))[0];
  if (confirmed.length === 0 && !blocking && !pending) return null;

  const peers: CoherenceConflictPeer[] = confirmed.map((row) => {
    const peerId = row.cardA === cardId ? row.cardB : row.cardA;
    return {
      cardId: peerId,
      cardTitle: cardTitleById(peerId) ?? peerId,
      tier: row.tier,
      status: row.status,
      summary: row.verdictSummary,
      findings: row.findings,
      overlapPaths: row.overlapPaths,
    };
  });

  return {
    peers, blocking,
    wait: pending ? coherenceWait(pending.deferralReason, pending.wakeCondition, pending.retryAt) : undefined,
  };
}
