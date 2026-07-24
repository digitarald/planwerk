import "server-only";

import { getDb } from "@/lib/db/schema";
import type {
  KanbanCard,
  RiskLevel,
  CoherenceStatus,
  CoherenceTier,
  CoherenceConflictPeer,
} from "@/lib/types";
import { getCardRisk } from "./risk-store";
import {
  detectPairs,
  pairBlocks,
  effectiveRisk,
  pairKey,
  type DetectCard,
  type DetectedPair,
} from "./coherence-detect";

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
  };
}

const OPEN_STATUSES = "('detected','reviewing','conflict','needs-human')";

/** Effective (conservative) risk for a card — unknown → medium. */
function riskOf(cardId: string): RiskLevel {
  return effectiveRisk(getCardRisk(cardId)?.level);
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
export function syncCoherence(cards: KanbanCard[], config: CoherenceConfig): CoherenceRow[] {
  if (!config.enabled) return [];
  const db = getDb();

  // In-flight cards with real code diffs.
  const inFlight = cards.filter(
    (c) => !c.isArchived && (c.phase === "build" || c.phase === "review") && c.fileChanges?.length
  );

  const detectCards: DetectCard[] = inFlight.map((c) => ({
    id: c.id,
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
             (card_a, card_b, tier, overlap_paths, signature, status, risk_snapshot)
           VALUES (?, ?, ?, ?, ?, 'detected', ?)`
        ).run(p.cardA, p.cardB, p.tier, JSON.stringify(p.overlapPaths), p.signature, risk);
        continue;
      }

      const row = mapRow(existing);

      // Signature unchanged → leave as-is (verdict/dismissal still valid).
      if (row.signature === p.signature) {
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
         WHERE id = ?`
      ).run(p.tier, JSON.stringify(p.overlapPaths), p.signature, risk, row.id);
    }

    // 2. Cleanup: close open rows whose pair no longer overlaps, or where either
    //    card is gone/shipped/archived.
    const liveById = new Map(cards.map((c) => [c.id, c]));
    const openRows = db
      .prepare(`SELECT * FROM coherence_conflicts WHERE status IN ${OPEN_STATUSES}`)
      .all() as CoherenceRowDb[];

    for (const dbRow of openRows) {
      const row = mapRow(dbRow);
      const key = `${row.cardA}\u0000${row.cardB}`;
      const stillDetected = detectedByKey.has(key);
      const a = liveById.get(row.cardA);
      const b = liveById.get(row.cardB);
      const cardGone =
        !a || !b || a.isArchived || b.isArchived || a.phase === "ship" || b.phase === "ship";

      if (!stillDetected || cardGone) {
        db.prepare(
          `UPDATE coherence_conflicts
             SET status = 'coherent', resolved_at = ${now}, resolved_by = 'auto',
                 updated_at = ${now}
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
        `SELECT * FROM coherence_conflicts WHERE card_a = ? AND card_b = ? AND status = 'detected'`
      )
      .get(p.cardA, p.cardB) as CoherenceRowDb | undefined;
    if (dbRow) escalatable.push(mapRow(dbRow));
  }

  return escalatable;
}

/** CAS-claim a detected row for review. Returns true only for the winner. */
export function claimForReview(rowId: number, signature: string): boolean {
  const db = getDb();
  const res = db
    .prepare(
      `UPDATE coherence_conflicts SET status = 'reviewing', updated_at = datetime('now')
       WHERE id = ? AND status = 'detected' AND signature = ?`
    )
    .run(rowId, signature);
  return res.changes > 0;
}

/** Race-safe verdict write: only applies if the row is still reviewing the same
 *  signature (a human dismiss or a fresh signature otherwise wins). */
export function completeReview(
  rowId: number,
  signature: string,
  verdict: { status: "conflict" | "coherent" | "needs-human"; summary: string; findings: string[] }
): boolean {
  const db = getDb();
  const resolved = verdict.status === "coherent";
  const res = db
    .prepare(
      `UPDATE coherence_conflicts
         SET status = ?, verdict_summary = ?, findings_json = ?,
             resolved_at = ${resolved ? "datetime('now')" : "NULL"},
             resolved_by = ${resolved ? "'reviewer'" : "NULL"},
             updated_at = datetime('now')
       WHERE id = ? AND status = 'reviewing' AND signature = ?`
    )
    .run(verdict.status, verdict.summary, JSON.stringify(verdict.findings), rowId, signature);
  return res.changes > 0;
}

/** Human "Accept divergence": dismiss the pair for its current signature. A later
 *  different signature reopens it. */
export function dismissConflict(cardA: string, cardB: string): CoherenceRow | null {
  const db = getDb();
  const [a, b] = pairKey(cardA, cardB);
  const existing = db
    .prepare("SELECT * FROM coherence_conflicts WHERE card_a = ? AND card_b = ?")
    .get(a, b) as CoherenceRowDb | undefined;
  if (!existing) return null;
  const row = mapRow(existing);
  db.prepare(
    `UPDATE coherence_conflicts
       SET status = 'dismissed', dismissed_signature = signature,
           resolved_at = datetime('now'), resolved_by = 'human', updated_at = datetime('now')
     WHERE id = ?`
  ).run(row.id);
  // Durable audit trail (mirrors gate-engine.logManualOverride).
  db.prepare(
    "INSERT INTO heartbeat_log (detection, card_id, action_taken, detail) VALUES (?, ?, ?, ?)"
  ).run("coherence-dismissed", cardA, "accept-divergence", `${a} <> ${b}`);
  return { ...row, status: "dismissed", dismissedSignature: row.signature };
}

/** Open (non-terminal) coherence rows involving a card. */
export function getOpenConflictsForCard(cardId: string): CoherenceRow[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM coherence_conflicts
         WHERE (card_a = ? OR card_b = ?) AND status IN ${OPEN_STATUSES}
         ORDER BY updated_at DESC`
    )
    .all(cardId, cardId) as CoherenceRowDb[];
  return rows.map(mapRow);
}

/**
 * Rows that block this card from shipping *right now* — computed live from current
 * risk + config, never a stored flag. Pair-level: any qualifying row blocks both
 * member cards.
 */
export function getShipBlockingConflicts(
  cardId: string,
  config: CoherenceConfig = DEFAULT_COHERENCE_CONFIG
): CoherenceRow[] {
  if (!config.enabled) return [];
  return getOpenConflictsForCard(cardId).filter((row) =>
    pairBlocks(row.status, riskOf(row.cardA), riskOf(row.cardB), {
      blockHighRiskShip: config.blockHighRiskShip,
    })
  );
}

/** Confirmed conflicts (status='conflict') involving a card, for attention/enrichment. */
export function getConfirmedConflictsForCard(cardId: string): CoherenceRow[] {
  const db = getDb();
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
  config: CoherenceConfig = DEFAULT_COHERENCE_CONFIG
): { peers: CoherenceConflictPeer[]; blocking: boolean } | null {
  const confirmed = getConfirmedConflictsForCard(cardId);
  const blocking = getShipBlockingConflicts(cardId, config).length > 0;
  if (confirmed.length === 0 && !blocking) return null;

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

  return { peers, blocking };
}
