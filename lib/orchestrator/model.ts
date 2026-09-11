import type {
  CopilotClient,
  ModelInfo,
} from "@github/copilot-sdk";

export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";
export type OrchestratorModelRole =
  | "conversation"
  | "triage"
  | "review"
  | "approval";

export interface OrchestratorModelSelection {
  model: string;
  reasoningEffort?: ReasoningEffort;
  role: OrchestratorModelRole;
  highStakes: boolean;
  source: "override" | "policy";
}

const REASONING_ORDER: ReasoningEffort[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

function enabledModels(models: ModelInfo[]): ModelInfo[] {
  return models.filter((model) => model.policy?.state !== "disabled");
}

function selectReasoningEffort(model: ModelInfo): ReasoningEffort | undefined {
  if (!model.capabilities.supports.reasoningEffort) return undefined;
  const supported = model.supportedReasoningEfforts;
  if (!supported?.length) return undefined;
  return [...supported].sort(
    (left, right) =>
      REASONING_ORDER.indexOf(right) - REASONING_ORDER.indexOf(left)
  )[0];
}

function compareModels(left: ModelInfo, right: ModelInfo): number {
  const contextDifference =
    right.capabilities.limits.max_context_window_tokens -
    left.capabilities.limits.max_context_window_tokens;
  return contextDifference || left.id.localeCompare(right.id);
}

export async function selectOrchestratorModel(
  client: Pick<CopilotClient, "listModels">,
  options: {
    role: OrchestratorModelRole;
    risk?: "low" | "medium" | "high";
    override?: string;
  }
): Promise<OrchestratorModelSelection> {
  const models = enabledModels(await client.listModels());
  const override = options.override ?? process.env.ORCHESTRATOR_MODEL;
  const highStakes =
    options.risk === "high" ||
    options.role === "review" ||
    options.role === "approval";

  if (override) {
    const selected = models.find((model) => model.id === override);
    if (!selected) {
      throw new Error(
        `ORCHESTRATOR_MODEL "${override}" is unavailable or disabled`
      );
    }
    if (highStakes && !selected.capabilities.supports.reasoningEffort) {
      throw new Error(
        `ORCHESTRATOR_MODEL "${override}" lacks reasoning capability required for ${options.role}`
      );
    }
    return {
      model: selected.id,
      reasoningEffort: selectReasoningEffort(selected),
      role: options.role,
      highStakes,
      source: "override",
    };
  }

  const candidates = highStakes
    ? models.filter((model) => model.capabilities.supports.reasoningEffort)
    : models;
  if (candidates.length === 0) {
    throw new Error(
      highStakes
        ? `No enabled reasoning-capable model is available for high-stakes ${options.role}`
        : `No enabled model is available for ${options.role}`
    );
  }

  const selected = [...candidates].sort(compareModels)[0];
  return {
    model: selected.id,
    reasoningEffort: selectReasoningEffort(selected),
    role: options.role,
    highStakes,
    source: "policy",
  };
}
