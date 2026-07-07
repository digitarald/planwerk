import "server-only";

import type { AhpClient } from "@microsoft/agent-host-protocol/client";
import type { SessionState } from "@microsoft/agent-host-protocol";

import { readSessionState } from "./snapshot";

/**
 * As of AHP 0.5 the selected model is no longer a first-class `SessionSummary`
 * field — it is provider-defined configuration carried in
 * `SessionState.config.values` (keyed by the provider's config schema). The
 * protocol does not standardize a key name, so this is a documented, best-effort
 * lookup across the keys providers commonly use, with graceful `undefined`
 * fallback when the provider models selection differently.
 */
const MODEL_CONFIG_KEYS = ["model", "modelId", "model_id", "selectedModel"] as const;

/** Best-effort extraction of the selected model id from session config values. */
export function extractModelFromConfig(config: SessionState["config"]): string | undefined {
  const values = config?.values;
  if (!values) return undefined;

  for (const key of MODEL_CONFIG_KEYS) {
    const value = values[key];
    if (typeof value === "string" && value.trim()) return value;
    // Some providers nest the selection as `{ id }` or `{ model }`.
    if (value && typeof value === "object") {
      const nested =
        (value as Record<string, unknown>).id ?? (value as Record<string, unknown>).model;
      if (typeof nested === "string" && nested.trim()) return nested;
    }
  }
  return undefined;
}

/**
 * Read a session's full state and derive the selected model from its config.
 * Returns `undefined` when the session exposes no recognizable model selection.
 */
export async function fetchSessionModel(
  client: AhpClient,
  sessionUri: string,
): Promise<string | undefined> {
  const state = await readSessionState(client, sessionUri);
  return extractModelFromConfig(state?.config);
}
