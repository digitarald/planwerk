import "server-only";

import { CopilotClient } from "@github/copilot-sdk";

import { RiskLevel } from "@/lib/types";

export interface RiskInput {
  title: string;
  activity?: string;
  filesChanged: number;
  additions: number;
  deletions: number;
  filePaths?: string[];
  lastAgentMessage?: string;
  planContent?: string;
}

interface RiskAssessment {
  level: RiskLevel;
  factors: string[];
}

// Module-level singleton — started lazily, reused across calls
let clientInstance: CopilotClient | null = null;
let clientStarting: Promise<CopilotClient> | null = null;

async function getClient(): Promise<CopilotClient> {
  if (clientInstance) return clientInstance;
  if (clientStarting) return clientStarting;

  clientStarting = (async () => {
    try {
      const client = new CopilotClient();
      await client.start();
      clientInstance = client;
      return client;
    } finally {
      clientStarting = null;
    }
  })();

  return clientStarting;
}

const SYSTEM_PROMPT = `You are a risk triage agent for a software development lifecycle system.

Given context about a task (title, activity, file metrics, plan content, and the agent's last response), assess the risk level as one of: "low", "medium", or "high".

Risk criteria:
- **Low**: Typo fixes, config changes, documentation, small isolated changes (<5 files, <50 lines)
- **Medium**: Feature work, refactors, dependency updates, moderate scope (5-10 files or 50-200 lines)
- **High**: Security-sensitive changes (auth, encryption, credentials), database migrations, core infrastructure, payment/billing logic, large blast radius (>10 files or >200 lines), breaking API changes

Pay special attention to:
- The plan content (if provided) — it describes the intended scope and approach
- The agent's last message — it summarizes the most recent work done
- File paths — security/auth/migration/payment paths indicate higher risk

Respond with ONLY a JSON object (no markdown fences, no extra text):
{"level": "low|medium|high", "factors": ["reason 1", "reason 2"]}

Each factor should be a concise explanation (under 15 words) of why this risk level was chosen.`;

function buildPrompt(input: RiskInput): string {
  const lines = [
    `Task: ${input.title}`,
    input.activity ? `Activity: ${input.activity}` : null,
    `Files changed: ${input.filesChanged}`,
    `Lines added: ${input.additions}, deleted: ${input.deletions}`,
    input.filePaths?.length
      ? `File paths:\n${input.filePaths.slice(0, 50).map((f) => `  - ${f}`).join("\n")}`
      : null,
    input.planContent
      ? `Plan:\n${input.planContent.slice(0, 3000)}`
      : null,
    input.lastAgentMessage
      ? `Agent's last response:\n${input.lastAgentMessage.slice(0, 2000)}`
      : null,
  ];
  return lines.filter(Boolean).join("\n\n");
}

function parseResponse(content: string): RiskAssessment | null {
  try {
    // Strip markdown fences if model wraps response
    const cleaned = content.replace(/```(?:json)?\s*/g, "").replace(/```\s*$/g, "").trim();
    const parsed = JSON.parse(cleaned);
    if (
      parsed &&
      typeof parsed.level === "string" &&
      ["low", "medium", "high"].includes(parsed.level) &&
      Array.isArray(parsed.factors)
    ) {
      return {
        level: parsed.level as RiskLevel,
        factors: parsed.factors.map(String),
      };
    }
  } catch {
    // Fall through to null
  }
  return null;
}

/**
 * Simple fallback when the Copilot SDK is unavailable.
 * Uses only file/line thresholds — no keyword scanning.
 */
function fallbackAssessRisk(input: RiskInput): RiskAssessment {
  const factors: string[] = [];
  let score = 0;

  if (input.filesChanged > 10) {
    score += 2;
    factors.push(`Large changeset (${input.filesChanged} files)`);
  } else if (input.filesChanged > 5) {
    score += 1;
    factors.push(`Moderate changeset (${input.filesChanged} files)`);
  }

  const totalChanges = input.additions + input.deletions;
  if (totalChanges > 200) {
    score += 2;
    factors.push(`${totalChanges} lines changed`);
  } else if (totalChanges > 50) {
    score += 1;
  }

  const level: RiskLevel = score >= 3 ? "high" : score >= 1 ? "medium" : "low";
  if (factors.length === 0) {
    factors.push("Small, isolated change");
  }
  return { level, factors };
}

export async function assessRisk(input: RiskInput): Promise<RiskAssessment> {
  try {
    const client = await getClient();
    const session = await client.createSession({
      model: "gpt-4.1",
      systemMessage: { content: SYSTEM_PROMPT },
    });

    try {
      const response = await session.sendAndWait(
        { prompt: buildPrompt(input) },
        30_000
      );

      const content = response?.data?.content;
      if (content) {
        const parsed = parseResponse(content);
        if (parsed) return parsed;
      }
    } finally {
      await session.disconnect().catch(() => {});
    }
  } catch (err) {
    // Reset client so the next call retries from scratch
    clientInstance = null;
    console.warn(
      "[risk-assessor] Copilot SDK call failed, using fallback:",
      err instanceof Error ? err.message : err
    );
  }

  return fallbackAssessRisk(input);
}
