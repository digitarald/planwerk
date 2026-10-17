import { createHash } from "node:crypto";

import type Database from "better-sqlite3";

import type {
  PendingInput,
  PendingInputOption,
  PendingInputQuestion,
} from "../types.ts";
import { stableJson } from "../db/cto-continuity-store.ts";
import { isSessionOwnedByHost } from "../db/session-ownership.ts";
import { sourceBindingsMatch, sourceEvidenceRevision } from "../ahp/source-binding-match.ts";
import type { RiskInput } from "./risk-assessor.ts";

export interface NormalizedPendingInput {
  requestId: string;
  kind: NonNullable<PendingInput["kind"]>;
  message: string;
  questions: Array<{
    id: string;
    kind: PendingInputQuestion["kind"];
    title: string;
    message: string;
    required: boolean;
    allowFreeform: boolean;
    defaultValue: string | number | boolean | null;
    options: Array<{
      id: string;
      label: string;
      description: string;
      recommended: boolean;
    }>;
  }>;
}

export type SensitiveElicitationCategory =
  | "permissions"
  | "credentials"
  | "deployment"
  | "destructive-operation"
  | "tool-authorization"
  | "command-execution"
  | "filesystem-mutation"
  | "process-control"
  | "network-publication";

export interface ElicitationAuthorization {
  allowed: boolean;
  digest: string | null;
  facts: NormalizedPendingInput | null;
  reason?: string;
  sensitiveCategory?: SensitiveElicitationCategory;
}

export interface RiskFactsSnapshot {
  cardId: string;
  hostUrl: string;
  input: RiskInput;
  digest: string;
  elicitationDigest?: string | null;
}

type RiskFactsRow = {
  card_id: string;
  host_url: string;
  summary_json: string;
  enrichment_json: string | null;
  phase: string;
};

interface PersistedRiskFacts {
  sourceRevision?: string;
  planVersion?: string;
  contentRevision?: string;
  manifestRevision?: string;
  evidenceDigest?: string;
  pendingInput?: unknown;
}

interface PersistedSummary {
  title?: string;
  activity?: string;
  changes?: { files?: number; additions?: number; deletions?: number };
  _planwerkRiskFacts?: PersistedRiskFacts;
}

interface PersistedEnrichment {
  changesetVerified?: boolean;
  totalFileCount?: number;
  additions?: number;
  deletions?: number;
  fileChanges?: Array<{ path?: string }>;
  lastAgentMessage?: string;
  planContent?: string;
  planContentHash?: string;
  _planwerkSource?: {
    sourceRevision?: string;
    planVersion?: string;
    contentRevision?: string;
    manifestRevision?: string;
    evidenceDigest?: string;
  };
}

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function normalizeOption(option: PendingInputOption): NormalizedPendingInput["questions"][number]["options"][number] {
  return {
    id: normalizeText(option.id),
    label: normalizeText(option.label),
    description: normalizeText(option.description),
    recommended: option.recommended === true,
  };
}

function normalizeQuestion(question: PendingInputQuestion): NormalizedPendingInput["questions"][number] {
  const defaultValue =
    typeof question.defaultValue === "string"
      ? normalizeText(question.defaultValue)
      : typeof question.defaultValue === "number" || typeof question.defaultValue === "boolean"
        ? question.defaultValue
        : null;
  return {
    id: normalizeText(question.id),
    kind: question.kind,
    title: normalizeText(question.title),
    message: normalizeText(question.message),
    required: question.required === true,
    allowFreeform: question.allowFreeform === true,
    defaultValue,
    options: (question.options ?? []).map(normalizeOption),
  };
}

export function normalizePendingInput(
  input: PendingInput | null | undefined,
): NormalizedPendingInput | null {
  if (!input || typeof input.requestId !== "string" || !Array.isArray(input.questions)) {
    return null;
  }
  return {
    requestId: normalizeText(input.requestId),
    kind: input.kind ?? "elicitation",
    message: normalizeText(input.message),
    questions: input.questions.map(normalizeQuestion),
  };
}

function digestPendingInput(facts: NormalizedPendingInput | null): string | null {
  if (!facts) return null;
  return createHash("sha256").update(stableJson(facts)).digest("hex");
}

function sensitiveContent(facts: NormalizedPendingInput): string {
  return [
    facts.message,
    ...facts.questions.flatMap((question) => [
      question.title,
      question.message,
      typeof question.defaultValue === "string" ? question.defaultValue : "",
      ...question.options.flatMap((option) => [
        option.label,
        option.description,
      ]),
    ]),
  ].join("\n");
}

const SENSITIVE_PATTERNS: ReadonlyArray<{
  category: SensitiveElicitationCategory;
  pattern: RegExp;
}> = [
  {
    category: "command-execution",
    pattern: /(?:^|[\s"'`])(?:rm(?:\s|$)|git\s+\S+|curl(?:\s|$)|wget(?:\s|$)|bash(?:\s|$)|zsh(?:\s|$)|powershell(?:\s|$)|cmd(?:\.exe)?(?:\s|$)|sudo\s+\S+|npm\s+\S+|pnpm\s+\S+|yarn\s+\S+|node\s+--\S+|python\d*\s+\S+|ls\s+-\S+|(?:cp|mv|touch|mkdir|rmdir)\s+\S+)|(?:\|\s*(?:sh|bash|zsh)\b)|(?:&&|;|`|\$\()/i,
  },
  {
    category: "filesystem-mutation",
    pattern: /\b(?:create|write|modify|copy|delete|remove|erase|destroy|wipe|purge|truncate|overwrite|unlink|rmdir|chmod|chown|move|rename)\b.{0,30}\b(?:file|folder|directory|filesystem|path|workspace|repository|repo)\b|\b(?:file|folder|directory|filesystem|path|workspace|repository|repo)\b.{0,30}\b(?:create|write|modify|copy|delete|remove|erase|destroy|wipe|purge|truncate|overwrite|unlink|move|rename)\b/i,
  },
  {
    category: "process-control",
    pattern: /\b(?:kill|terminate|restart|stop|shutdown|signal)\b.{0,30}\b(?:process|service|server|daemon|job|worker|pid)\b|\bkill(?:all)?\b/i,
  },
  {
    category: "network-publication",
    pattern: /\b(?:upload|publish|expose|send|post)\b.{0,30}\b(?:internet|network|remote|public|endpoint|url|registry)\b|\bhttps?:\/\/|\b(?:curl|wget)\b/i,
  },
  {
    category: "permissions",
    pattern: /\b(?:permission|privilege|sudo|administrator|admin access|grant access|access rights?)\b/i,
  },
  {
    category: "credentials",
    pattern: /\b(?:credential|password|passphrase|secret|api[- ]?key|token|ssh key|oauth|sign[ -]?in|login)\b/i,
  },
  {
    category: "deployment",
    pattern: /\b(?:deploy(?:ment|ing|ed)?|production|prod|release|publish(?:ing|ed)?)\b/i,
  },
  {
    category: "destructive-operation",
    pattern: /\b(?:delete|destroy|drop|truncate|overwrite|wipe|purge|revert|rollback|reset\s+--hard|force[ -]?push|remove all)\b/i,
  },
  {
    category: "tool-authorization",
    pattern: /\b(?:(?:run|execute|authorize|approve|confirm|allow)\b.{0,40}\b(?:command|tool|terminal|shell|script)|(?:command|tool|terminal|shell|script)\b.{0,40}\b(?:run|execute|authorize|approve|confirm|allow))\b/i,
  },
];

const BENIGN_TOPIC_PATTERNS = [
  /\b(?:format(?:ting)?|code style|quote style|indentation|spacing|semicolon|line ending|prettier)\b/i,
  /\b(?:name|naming|identifier|terminology|label|case style|camelcase|snake_case|kebab-case)\b/i,
  /\b(?:test runner|test framework|test suite|test selection|test scope|unit test|integration test|vitest|jest|node test runner)\b/i,
];

export function authorizePendingElicitation(
  input: PendingInput | null | undefined,
): ElicitationAuthorization {
  const facts = normalizePendingInput(input);
  const digest = digestPendingInput(facts);
  if (!facts) {
    return {
      allowed: false,
      digest,
      facts,
      reason: "No server-observed pending input",
    };
  }
  if (facts.kind !== "elicitation") {
    return {
      allowed: false,
      digest,
      facts,
      reason: "Pending input is not an automatable elicitation",
    };
  }
  if (!facts.requestId || facts.questions.length !== 1 || !facts.questions[0]?.id) {
    return {
      allowed: false,
      digest,
      facts,
      reason: "Auto-answer requires exactly one identified question",
    };
  }

  const content = sensitiveContent(facts);
  const sensitive = SENSITIVE_PATTERNS.find(({ pattern }) => pattern.test(content));
  if (sensitive) {
    return {
      allowed: false,
      digest,
      facts,
      reason: `Sensitive ${sensitive.category} elicitation requires human input`,
      sensitiveCategory: sensitive.category,
    };
  }

  const question = facts.questions[0];
  if (question.allowFreeform || !["single-select", "boolean"].includes(question.kind)) {
    return {
      allowed: false,
      digest,
      facts,
      reason: "Auto-answer only permits closed benign selections",
    };
  }
  if (
    question.kind === "single-select"
    && (
      question.options.length < 2
      || question.options.length > 10
      || question.options.some((option) => !option.id || !option.label)
    )
  ) {
    return {
      allowed: false,
      digest,
      facts,
      reason: "Auto-answer requires a bounded set of identified choices",
    };
  }
  const topic = [facts.message, question.title, question.message].join("\n");
  if (!BENIGN_TOPIC_PATTERNS.some((pattern) => pattern.test(topic))) {
    return {
      allowed: false,
      digest,
      facts,
      reason: "Elicitation is outside the benign auto-answer allowlist",
    };
  }

  return { allowed: true, digest, facts };
}

function parseRowFacts(row: RiskFactsRow): {
  input: RiskInput;
  changesetVerified: boolean;
  planContentHash: string | null;
  pendingInput: NormalizedPendingInput | null;
  sourceRevision: string | null;
  planVersion: string | null;
  contentRevision: string | null;
  manifestRevision: string | null;
  evidenceDigest: string | null;
} {
  const summary = JSON.parse(row.summary_json) as PersistedSummary;
  const parsedEnrichment = row.enrichment_json
    ? JSON.parse(row.enrichment_json) as PersistedEnrichment
    : null;
  const source = summary._planwerkRiskFacts;
  const sourceRevision =
    typeof source?.sourceRevision === "string" && source.sourceRevision.trim()
      ? source.sourceRevision
      : null;
  const enrichment = parsedEnrichment
    && source
    && sourceRevision
    && sourceBindingsMatch(source, parsedEnrichment._planwerkSource)
      ? parsedEnrichment
      : null;
  const verified = enrichment?.changesetVerified === true;
  const filePaths = enrichment?.fileChanges
    ?.map(({ path }) => path)
    .filter((path): path is string => typeof path === "string" && path.trim().length > 0)
    .sort();
  const totalFileCount = enrichment?.totalFileCount;
  const factsComplete = verified
    && Number.isSafeInteger(totalFileCount)
    && (totalFileCount as number) >= 0
    && Array.isArray(enrichment?.fileChanges)
    && filePaths?.length === totalFileCount;
  const pendingInput = normalizePendingInput(
    source?.pendingInput as PendingInput | null | undefined,
  );

  return {
    input: {
      title: summary.title ?? row.card_id,
      activity: summary.activity,
      filesChanged: verified
        ? enrichment.totalFileCount ?? 0
        : summary.changes?.files ?? 0,
      additions: verified
        ? enrichment.additions ?? 0
        : summary.changes?.additions ?? 0,
      deletions: verified
        ? enrichment.deletions ?? 0
        : summary.changes?.deletions ?? 0,
      filePaths,
      lastAgentMessage: enrichment?.lastAgentMessage,
      planContent: enrichment?.planContent,
      sourceRevision: sourceEvidenceRevision(enrichment?._planwerkSource) ?? sourceRevision ?? undefined,
      pendingElicitation: pendingInput ?? undefined,
      factsComplete,
    },
    changesetVerified: verified,
    planContentHash: enrichment?.planContentHash ?? null,
    pendingInput,
    sourceRevision,
    planVersion: source?.planVersion ?? null,
    contentRevision: source?.contentRevision ?? null,
    manifestRevision: source?.manifestRevision ?? null,
    evidenceDigest: source?.evidenceDigest ?? null,
  };
}

export function parseAuthoritativeRiskInput(
  cardId: string,
  summaryJson: string,
  enrichmentJson: string | null,
): RiskInput {
  return parseRowFacts({
    card_id: cardId,
    host_url: "",
    summary_json: summaryJson,
    enrichment_json: enrichmentJson,
    phase: "",
  }).input;
}

function digestRow(row: RiskFactsRow): string | null {
  const facts = parseRowFacts(row);
  if (!facts.sourceRevision) return null;
  return createHash("sha256")
    .update(stableJson({
      hostUrl: row.host_url,
      input: facts.input,
      phase: row.phase,
      changesetVerified: facts.changesetVerified,
      planContentHash: facts.planContentHash,
      sourceRevision: facts.sourceRevision,
      planVersion: facts.planVersion,
      contentRevision: facts.manifestRevision ?? facts.contentRevision,
      ...(facts.evidenceDigest ? { evidenceDigest: facts.evidenceDigest } : {}),
      pendingInput: facts.pendingInput,
    }))
    .digest("hex");
}

function readRiskFactsRow(
  db: Database.Database,
  hostUrl: string,
  cardId: string,
): RiskFactsRow | undefined {
  if (!isSessionOwnedByHost(db, cardId, hostUrl)) return undefined;
  return db.prepare(`
    SELECT c.session_uri AS card_id, c.host_url, c.summary_json,
      c.enrichment_json, p.phase
    FROM session_cache c
    JOIN card_phases p ON p.card_id = c.session_uri
    WHERE c.host_url = ? AND c.session_uri = ?
  `).get(hostUrl, cardId) as RiskFactsRow | undefined;
}

export function getRiskFactsSnapshot(
  db: Database.Database,
  hostUrl: string,
  cardId: string,
): RiskFactsSnapshot | null {
  const row = readRiskFactsRow(db, hostUrl, cardId);
  if (!row) return null;
  const facts = parseRowFacts(row);
  const digest = digestRow(row);
  if (!digest) return null;
  return {
    cardId,
    hostUrl,
    input: facts.input,
    digest,
    elicitationDigest: digestPendingInput(facts.pendingInput),
  };
}

export function riskFactsStillMatch(
  db: Database.Database,
  snapshot: RiskFactsSnapshot,
): boolean {
  const row = readRiskFactsRow(db, snapshot.hostUrl, snapshot.cardId);
  return Boolean(row && digestRow(row) === snapshot.digest);
}

export function currentRiskFactsDigest(
  db: Database.Database,
  cardId: string,
): string | null {
  return currentRiskFactsSnapshot(db, cardId)?.digest ?? null;
}

export function currentRiskFactsSnapshot(
  db: Database.Database,
  cardId: string,
): RiskFactsSnapshot | null {
  const rows = db.prepare(`
    SELECT c.session_uri AS card_id, c.host_url, c.summary_json,
      c.enrichment_json, p.phase
    FROM session_cache c
    JOIN card_phases p ON p.card_id = c.session_uri
    WHERE c.session_uri = ?
    ORDER BY c.updated_at DESC
  `).all(cardId) as RiskFactsRow[];
  if (rows.length !== 1) return null;
  const row = rows[0];
  if (!isSessionOwnedByHost(db, cardId, row.host_url)) return null;
  const digest = digestRow(row);
  if (!digest) return null;
  const facts = parseRowFacts(row);
  return {
    cardId,
    hostUrl: row.host_url,
    input: facts.input,
    digest,
    elicitationDigest: digestPendingInput(facts.pendingInput),
  };
}
