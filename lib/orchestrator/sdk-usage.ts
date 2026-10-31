import type { SessionEvent } from "@github/copilot-sdk";

export interface SdkUsageSummary {
  scope: "session-checkpoint" | "observed-stream";
  models: Array<{ provider: string; model: string; inputTokens?: number; outputTokens?: number; partial?: boolean }>;
  totalNanoAiu?: number;
  updatedAt: string;
}

export function createSdkUsageTracker() {
  let scope: SdkUsageSummary["scope"] = "observed-stream";
  let totalNanoAiu: number | undefined;
  const models = new Map<string, SdkUsageSummary["models"][number]>();
  const watermarks = new Map<string, number>();
  const receipts = new Set<string>();
  const checkpoints = new Set<string>();
  let checkpointAt: string | undefined;
  return (event: SessionEvent): SdkUsageSummary | null => {
    if (event.type === "session.usage_checkpoint" && !event.agentId) {
      if (checkpoints.has(event.id) || (checkpointAt && event.timestamp < checkpointAt)) return null;
      checkpoints.add(event.id);
      checkpointAt = event.timestamp;
      scope = "session-checkpoint";
      models.clear();
      watermarks.clear();
      for (const entry of event.data.providerModelMetrics ?? []) {
        const provider = entry.provider?.label ?? "Unknown provider";
        const model = entry.modelDisplayName ?? entry.modelId ?? "Unknown model";
        models.set(JSON.stringify([entry.provider?.id ?? null, entry.modelId]), {
          provider, model,
          inputTokens: entry.metrics?.usage.inputTokens,
          outputTokens: entry.metrics?.usage.outputTokens,
        });
      }
      totalNanoAiu = event.data.totalNanoAiu;
      for (const [source, sequence] of Object.entries(event.data.usageAccountingWatermarks ?? {})) {
        if (sequence !== undefined) watermarks.set(source, sequence);
      }
    } else if (event.type === "assistant.usage") {
      const data = event.data;
      const accounting = data.accounting;
      const id = accounting
        ? JSON.stringify([accounting.sourceSessionId, accounting.usageId])
        : data.apiCallId ?? event.id;
      if (receipts.has(id)) return null;
      receipts.add(id);
      if (accounting && accounting.sequence <= (watermarks.get(accounting.sourceSessionId) ?? -1)) return null;
      // A checkpoint cannot be combined safely with legacy, unsequenced receipts.
      if (scope === "session-checkpoint" && (!accounting || !watermarks.has(accounting.sourceSessionId))) return null;
      const key = JSON.stringify([data.provider?.id ?? data.modelProvider ?? null, data.model]);
      const previous = models.get(key);
      models.set(key, {
        provider: data.provider?.label ?? data.modelProvider ?? "Unknown provider",
        model: data.modelDisplayName ?? data.model,
        inputTokens: data.inputTokens === undefined ? previous?.inputTokens : (previous?.inputTokens ?? 0) + data.inputTokens,
        outputTokens: data.outputTokens === undefined ? previous?.outputTokens : (previous?.outputTokens ?? 0) + data.outputTokens,
        ...(previous?.partial || data.inputTokens === undefined || data.outputTokens === undefined ? { partial: true } : {}),
      });
      // Checkpoint nano-AI units remain checkpoint-only; no multiplier-to-dollar conversion.
    } else return null;
    return { scope, models: [...models.values()], totalNanoAiu, updatedAt: event.timestamp };
  };
}
