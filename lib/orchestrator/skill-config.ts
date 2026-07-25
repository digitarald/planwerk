import "server-only";

import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";

import type { ArtifactType, RiskLevel } from "@/lib/types";
import type { CoherenceConfig } from "./coherence-engine";
import { resolveReviewPrompt } from "./review-prompt";

export interface SkillConfig {
  id: string;
  prompt: string;
  promptByRisk?: Partial<Record<RiskLevel, string>>;
  description: string;
  riskThreshold: RiskLevel;
  maxIterations: number;
  autoFix: boolean;
}

function parseRiskPrompts(
  raw: Record<string, unknown> | undefined,
  fallback?: Partial<Record<RiskLevel, string>>
): Partial<Record<RiskLevel, string>> | undefined {
  const prompts = { ...fallback };
  if (raw) {
    for (const risk of ["low", "medium", "high"] as const) {
      if (typeof raw[risk] === "string" && raw[risk].trim() !== "") {
        prompts[risk] = raw[risk];
      }
    }
  }
  return Object.keys(prompts).length > 0 ? prompts : undefined;
}

export interface ReviewPolicy {
  maxIterations: number;
  followEdits: boolean;
  autoApprovePlan: boolean;
}

export interface GateSkillRef {
  type: "review";
  skill: string;
  riskThreshold?: RiskLevel;
  description?: string;
}

export interface GateScriptRef {
  type: "script";
  name: string;
}

export interface GateArtifactRef {
  type: "artifact";
  artifact: ArtifactType;
  description?: string;
}

export type GateRef = GateSkillRef | GateScriptRef | GateArtifactRef;

export interface GateTransitionConfig {
  required: GateRef[];
  optional: GateRef[];
}

export interface OrchestratorConfig {
  heartbeatInterval: number; // in ms
  staleThreshold: number; // in ms
  autoAnswerInput: {
    enabled: boolean;
    maxRisk: RiskLevel;
  };
  autoAdvancePhases: boolean;
  autoTriggerGates: boolean;
  autoInjectReviews: boolean;
  /** Opt-in: inject the plan-review gate for a plan-phase card that has been
   *  continuously *running* (never idle) past `planBusyThreshold`, via a queued
   *  message. Off by default so a busy agent is never interrupted unless an
   *  operator enables it. Still gated by `autoInjectReviews`; the gate grades
   *  before any advance (invariant preserved). */
  injectReviewsWhileBusy: boolean;
  /** How long a plan-phase card must stay continuously running before an
   *  opt-in busy plan-review injection fires. Only used when
   *  `injectReviewsWhileBusy` is true. */
  planBusyThreshold: number; // in ms
  maxRetryOnFailure: number;
}

export interface PlanwerkConfig {
  scripts: Record<string, string>;
  skills: Record<string, SkillConfig>;
  gates: Record<string, GateTransitionConfig>;
  reviewPolicy: Record<RiskLevel, ReviewPolicy>;
  orchestrator: OrchestratorConfig;
  wipLimits: Record<string, number>;
  coherence: CoherenceConfig;
}

const RISK_ORDER: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 };

const DEFAULT_SKILLS: Record<string, SkillConfig> = {
  "plan-review": {
    id: "plan-review",
    prompt: "/rubber-duck",
    description: "Adversarial plan review — challenges assumptions and gaps",
    riskThreshold: "low",
    maxIterations: 2,
    autoFix: true,
  },
  "code-review": {
    id: "code-review",
    prompt: "/rubber-duck",
    description: "Implementation correctness and architecture review",
    riskThreshold: "low",
    maxIterations: 2,
    autoFix: true,
  },
  "review-report": {
    id: "review-report",
    prompt:
      "Independently assess the final implementation against plan.md and prior gate evidence. " +
      "Create or update review.md beside plan.md with the intended outcome, implemented result, " +
      "validation evidence, divergences, unresolved risks, human-attention items, and ship recommendation. " +
      "Keep plan.md unchanged and do not modify implementation code.",
    description: "Final intent-to-implementation review and durable human handoff",
    riskThreshold: "low",
    maxIterations: 2,
    autoFix: true,
  },
  "security-review": {
    id: "security-review",
    prompt: "/security-review",
    description: "Security vulnerability scanning",
    riskThreshold: "medium",
    maxIterations: 3,
    autoFix: true,
  },
  "architecture-review": {
    id: "architecture-review",
    prompt: "/rubber-duck with focus on architecture, coupling, and scalability",
    description: "Architecture and design evaluation",
    riskThreshold: "high",
    maxIterations: 2,
    autoFix: false,
  },
};

const DEFAULT_REVIEW_POLICY: Record<RiskLevel, ReviewPolicy> = {
  low: { maxIterations: 1, followEdits: false, autoApprovePlan: true },
  medium: { maxIterations: 2, followEdits: false, autoApprovePlan: false },
  high: { maxIterations: 3, followEdits: true, autoApprovePlan: false },
};

const DEFAULT_ORCHESTRATOR: OrchestratorConfig = {
  heartbeatInterval: 30_000,
  staleThreshold: 600_000, // 10 minutes
  autoAnswerInput: { enabled: true, maxRisk: "low" },
  autoAdvancePhases: true,
  autoTriggerGates: true,
  autoInjectReviews: true,
  injectReviewsWhileBusy: false,
  planBusyThreshold: 300_000, // 5 minutes
  maxRetryOnFailure: 2,
};

const DEFAULT_GATES: Record<string, GateTransitionConfig> = {
  "plan-to-build": {
    required: [{ type: "review", skill: "plan-review" }],
    optional: [
      {
        type: "review",
        skill: "architecture-review",
        riskThreshold: "high",
      },
    ],
  },
  "build-to-review": {
    required: [
      { type: "script", name: "Lint" },
      { type: "script", name: "Type Check" },
      { type: "script", name: "Build" },
      { type: "script", name: "Test" },
      { type: "review", skill: "code-review" },
    ],
    optional: [],
  },
  "review-to-ship": {
    required: [
      { type: "review", skill: "review-report" },
      { type: "artifact", artifact: "review" },
    ],
    optional: [],
  },
};

const DEFAULT_SCRIPTS: Record<string, string> = {
  Lint: "npm run lint",
  "Type Check": "npm run typecheck",
  Build: "npm run build",
  Test: "npm test",
};

const DEFAULT_WIP_LIMITS: Record<string, number> = {
  build: 3,
  review: 2,
};

const DEFAULT_COHERENCE: CoherenceConfig = {
  enabled: true,
  moduleDepth: 2,
  blockHighRiskShip: true,
};

function parseDuration(value: string | number | undefined, defaultMs: number): number {
  if (value === undefined) return defaultMs;
  if (typeof value === "number") return value;
  const match = value.match(/^(\d+)(ms|s|m|h)$/);
  if (!match) return defaultMs;
  const num = parseInt(match[1], 10);
  switch (match[2]) {
    case "ms": return num;
    case "s": return num * 1000;
    case "m": return num * 60_000;
    case "h": return num * 3_600_000;
    default: return defaultMs;
  }
}

// Cache: file path → { mtime, config }
let configCache: { path: string; mtime: number; config: PlanwerkConfig } | null = null;

/**
 * Load the Planwerk config from .github/planwerk.yml relative to a project path.
 * Falls back to sensible defaults if file doesn't exist.
 * When projectPath is provided, only that project's config is used (no cwd fallback).
 */
export function loadConfig(projectPath?: string): PlanwerkConfig {
  const searchPaths: string[] = [];
  if (projectPath) {
    searchPaths.push(resolve(projectPath, ".github/planwerk.yml"));
  } else {
    searchPaths.push(resolve(process.cwd(), ".github/planwerk.yml"));
  }

  for (const filePath of searchPaths) {
    if (!existsSync(filePath)) continue;

    // Simple mtime-based cache
    const { mtimeMs } = statSync(filePath);
    if (configCache && configCache.path === filePath && configCache.mtime === mtimeMs) {
      return configCache.config;
    }

    try {
      const raw = readFileSync(filePath, "utf-8");
      const parsed = parseYaml(raw) as Record<string, unknown>;
      const config = mergeConfig(parsed);
      configCache = { path: filePath, mtime: mtimeMs, config };
      return config;
    } catch (err) {
      console.warn("[skill-config] Failed to parse", filePath, err);
    }
  }

  // Return defaults
  return {
    scripts: DEFAULT_SCRIPTS,
    skills: DEFAULT_SKILLS,
    gates: DEFAULT_GATES,
    reviewPolicy: DEFAULT_REVIEW_POLICY,
    orchestrator: DEFAULT_ORCHESTRATOR,
    wipLimits: DEFAULT_WIP_LIMITS,
    coherence: DEFAULT_COHERENCE,
  };
}

function mergeConfig(raw: Record<string, unknown>): PlanwerkConfig {
  const scripts = { ...DEFAULT_SCRIPTS };
  const rawScripts = raw.scripts as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(rawScripts)) {
    for (const script of rawScripts) {
      if (
        typeof script.name === "string" &&
        script.name.trim() !== "" &&
        typeof script.command === "string" &&
        script.command.trim() !== ""
      ) {
        scripts[script.name] = script.command;
      }
    }
  }

  const skills = { ...DEFAULT_SKILLS };
  const rawSkills = raw.skills as Record<string, Record<string, unknown>> | undefined;
  if (rawSkills) {
    for (const [id, def] of Object.entries(rawSkills)) {
      const rawRisk = def.risk_threshold as string | undefined;
      const rawPrompts = def.prompt_by_risk as Record<string, unknown> | undefined;
      skills[id] = {
        id,
        prompt: (def.prompt as string) ?? DEFAULT_SKILLS[id]?.prompt ?? `/review-areas`,
        promptByRisk: parseRiskPrompts(rawPrompts, DEFAULT_SKILLS[id]?.promptByRisk),
        description: (def.description as string) ?? DEFAULT_SKILLS[id]?.description ?? id,
        riskThreshold: isValidRisk(rawRisk) ? rawRisk : (DEFAULT_SKILLS[id]?.riskThreshold ?? "low"),
        maxIterations: clampPositive(def.max_iterations, DEFAULT_SKILLS[id]?.maxIterations ?? 2),
        autoFix: (def.auto_fix as boolean) ?? DEFAULT_SKILLS[id]?.autoFix ?? true,
      };
    }
  }

  const gates = { ...DEFAULT_GATES };
  const rawGates = raw.gates as Record<string, Record<string, unknown>> | undefined;
  if (rawGates) {
    for (const [transition, def] of Object.entries(rawGates)) {
      const key = transition.replace(/_/g, "-"); // normalize define_to_plan → define-to-plan
      const existing = gates[key];
      const rawRequired = def.required as unknown[] | undefined;
      const rawOptional = def.optional as unknown[] | undefined;
      gates[key] = {
        // Only override a field if explicitly provided; preserve default otherwise
        required: rawRequired !== undefined ? parseGateRefs(rawRequired) : (existing?.required ?? []),
        optional: rawOptional !== undefined ? parseGateRefs(rawOptional) : (existing?.optional ?? []),
      };
    }
  }

  const reviewPolicy = { ...DEFAULT_REVIEW_POLICY };
  const rawPolicy = raw.review_policy as Record<string, Record<string, unknown>> | undefined;
  if (rawPolicy) {
    for (const [risk, def] of Object.entries(rawPolicy)) {
      if (isValidRisk(risk)) {
        reviewPolicy[risk] = {
          maxIterations: clampPositive(def.max_iterations, DEFAULT_REVIEW_POLICY[risk].maxIterations),
          followEdits: typeof def.follow_edits === "boolean" ? def.follow_edits : DEFAULT_REVIEW_POLICY[risk].followEdits,
          autoApprovePlan: typeof def.auto_approve_plan === "boolean"
            ? def.auto_approve_plan
            : DEFAULT_REVIEW_POLICY[risk].autoApprovePlan,
        };
      }
    }
  }

  const rawOrch = raw.orchestrator as Record<string, unknown> | undefined;
  const rawAutoAnswer = rawOrch?.auto_answer_input as Record<string, unknown> | undefined;
  const rawMaxRisk = rawAutoAnswer?.max_risk as string | undefined;
  const orchestrator: OrchestratorConfig = {
    heartbeatInterval: parseDuration(rawOrch?.heartbeat_interval as string | undefined, DEFAULT_ORCHESTRATOR.heartbeatInterval),
    staleThreshold: parseDuration(rawOrch?.stale_threshold as string | undefined, DEFAULT_ORCHESTRATOR.staleThreshold),
    autoAnswerInput: {
      enabled: typeof rawAutoAnswer?.enabled === "boolean" ? rawAutoAnswer.enabled : DEFAULT_ORCHESTRATOR.autoAnswerInput.enabled,
      maxRisk: isValidRisk(rawMaxRisk) ? rawMaxRisk : DEFAULT_ORCHESTRATOR.autoAnswerInput.maxRisk,
    },
    autoAdvancePhases: typeof rawOrch?.auto_advance_phases === "boolean" ? rawOrch.auto_advance_phases : DEFAULT_ORCHESTRATOR.autoAdvancePhases,
    autoTriggerGates: typeof rawOrch?.auto_trigger_gates === "boolean" ? rawOrch.auto_trigger_gates : DEFAULT_ORCHESTRATOR.autoTriggerGates,
    autoInjectReviews: typeof rawOrch?.auto_inject_reviews === "boolean" ? rawOrch.auto_inject_reviews : DEFAULT_ORCHESTRATOR.autoInjectReviews,
    injectReviewsWhileBusy: typeof rawOrch?.inject_reviews_while_busy === "boolean" ? rawOrch.inject_reviews_while_busy : DEFAULT_ORCHESTRATOR.injectReviewsWhileBusy,
    planBusyThreshold: parseDuration(rawOrch?.plan_busy_threshold as string | undefined, DEFAULT_ORCHESTRATOR.planBusyThreshold),
    maxRetryOnFailure: clampPositive(rawOrch?.max_retry_on_failure, DEFAULT_ORCHESTRATOR.maxRetryOnFailure),
  };

  const wipLimits = { ...DEFAULT_WIP_LIMITS };
  const rawWip = raw.wip_limits as Record<string, number> | undefined;
  if (rawWip) {
    for (const [phase, limit] of Object.entries(rawWip)) {
      wipLimits[phase] = limit;
    }
  }

  const rawCoh = raw.coherence as Record<string, unknown> | undefined;
  const coherence: CoherenceConfig = {
    enabled: typeof rawCoh?.enabled === "boolean" ? rawCoh.enabled : DEFAULT_COHERENCE.enabled,
    moduleDepth: clampPositive(rawCoh?.module_depth, DEFAULT_COHERENCE.moduleDepth),
    blockHighRiskShip:
      typeof rawCoh?.block_high_risk_ship === "boolean"
        ? rawCoh.block_high_risk_ship
        : DEFAULT_COHERENCE.blockHighRiskShip,
  };

  return { scripts, skills, gates, reviewPolicy, orchestrator, wipLimits, coherence };
}

function parseGateRefs(raw: unknown[] | undefined): GateRef[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    const obj = item as Record<string, unknown>;
    if (obj.type === "script") {
      if (typeof obj.name !== "string" || obj.name.trim() === "") {
        throw new Error("Script gate requires a non-empty name");
      }
      return { type: "script", name: obj.name as string } satisfies GateScriptRef;
    }
    if (obj.type === "artifact") {
      if (!isArtifactType(obj.artifact)) {
        throw new Error(`Artifact gate has invalid artifact type: ${String(obj.artifact)}`);
      }
      return {
        type: "artifact",
        artifact: obj.artifact,
        description: obj.description as string | undefined,
      } satisfies GateArtifactRef;
    }
    if (obj.type !== "review" || typeof obj.skill !== "string" || obj.skill.trim() === "") {
      throw new Error(`Unsupported gate reference: ${JSON.stringify(obj)}`);
    }
    const riskThreshold = obj.risk_threshold as string | undefined;
    return {
      type: "review",
      skill: obj.skill as string,
      riskThreshold: isValidRisk(riskThreshold) ? riskThreshold : undefined,
      description: obj.description as string | undefined,
    } satisfies GateSkillRef;
  });
}

function isArtifactType(value: unknown): value is ArtifactType {
  return (
    value === "plan" ||
    value === "review" ||
    value === "research" ||
    value === "design" ||
    value === "spec" ||
    value === "test-plan" ||
    value === "decision"
  );
}

function isValidRisk(value: unknown): value is RiskLevel {
  return value === "low" || value === "medium" || value === "high";
}

function clampPositive(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) return fallback;
  return Math.floor(value);
}

/**
 * Normalize a phase transition key to the YAML format (e.g., "plan->build" → "plan-to-build").
 */
function normalizeTransitionKey(key: string): string {
  return key.replace("->", "-to-");
}

/**
 * Get skills applicable for a phase transition at a given risk level.
 * Accepts both "plan->build" and "plan-to-build" format.
 */
export function getApplicableSkills(
  phaseTransition: string,
  riskLevel: RiskLevel,
  config?: PlanwerkConfig
): SkillConfig[] {
  const cfg = config ?? loadConfig();
  // Support both "plan->build" and "plan-to-build" formats
  const key = normalizeTransitionKey(phaseTransition);
  const gateConfig = cfg.gates[key] ?? cfg.gates[phaseTransition];
  if (!gateConfig) return [];

  const cardRisk = RISK_ORDER[riskLevel];
  const allRefs = [...gateConfig.required, ...gateConfig.optional]
    .filter((ref): ref is GateSkillRef => ref.type === "review");

  return allRefs
    .filter((ref) => {
      if (!ref.riskThreshold) return true;
      return cardRisk >= RISK_ORDER[ref.riskThreshold];
    })
    .map((ref) => {
      const skill = cfg.skills[ref.skill];
      if (!skill) return undefined;
      return {
        ...skill,
        prompt: resolveReviewPrompt(skill.prompt, skill.promptByRisk, riskLevel),
      };
    })
    .filter((skill): skill is SkillConfig => skill !== undefined);
}

/**
 * Get the effective max iterations for a skill given the card's risk level.
 * Uses the risk-based review policy to override the skill's own maxIterations.
 */
export function getEffectiveMaxIterations(
  skillId: string,
  riskLevel: RiskLevel,
  config?: PlanwerkConfig
): number {
  const cfg = config ?? loadConfig();
  const policy = cfg.reviewPolicy[riskLevel];
  const skill = cfg.skills[skillId];

  // Policy max_iterations caps the skill's own setting
  return Math.min(skill?.maxIterations ?? 2, policy.maxIterations);
}

/**
 * Whether edits should trigger a re-review at this risk level.
 */
export function shouldFollowEdits(
  riskLevel: RiskLevel,
  config?: PlanwerkConfig
): boolean {
  const cfg = config ?? loadConfig();
  return cfg.reviewPolicy[riskLevel].followEdits;
}

/**
 * Whether a given risk level is eligible for auto-answering input.
 */
export function canAutoAnswer(
  riskLevel: RiskLevel,
  config?: PlanwerkConfig
): boolean {
  const cfg = config ?? loadConfig();
  if (!cfg.orchestrator.autoAnswerInput.enabled) return false;
  const maxRisk = RISK_ORDER[cfg.orchestrator.autoAnswerInput.maxRisk];
  return RISK_ORDER[riskLevel] <= maxRisk;
}
