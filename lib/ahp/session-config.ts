import "server-only";

import type { AhpClient } from "@microsoft/agent-host-protocol/client";
import type { SessionState } from "@microsoft/agent-host-protocol";

import { readRootState, readSessionState } from "./snapshot";
import { createHash } from "node:crypto";
import type { JsonPrimitive, ModelSelection } from "@microsoft/agent-host-protocol";
import { configProblems, configValueError, creationModelSchema, isConfigRecord, type CreationConfiguration } from "./creation-config";

export class CreationConfigError extends Error {}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (isConfigRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

export function creationRevision(value: unknown): string {
  return createHash("sha256").update(stable(value)).digest("hex");
}

export async function resolveCreationConfiguration(client: AhpClient, input: {
  provider?: string;
  workingDirectory: string;
  config?: Record<string, unknown>;
  model?: ModelSelection;
  completion?: { property: string; query: string };
  strict?: boolean;
}): Promise<CreationConfiguration> {
  const root = await readRootState(client);
  const providers = (root?.agents ?? []).map(({ provider, displayName, models }) => ({
    provider, displayName,
    models: models.map((model) => ({ ...model, configSchema: creationModelSchema(provider, model.configSchema) })),
  }));
  const provider = input.provider ?? providers.find((p) => p.provider === "copilotcli")?.provider ?? providers[0]?.provider;
  const agent = providers.find((p) => p.provider === provider);
  if (!agent) throw new CreationConfigError("The selected provider is no longer advertised. Refresh task options.");
  const context = { channel: "ahp-root://" as const, provider, workingDirectory: input.workingDirectory };
  let result = await client.request("resolveSessionConfig", { ...context, config: input.config });
  const defaults: Record<string, unknown> = {};
  if (provider === "copilotcli") {
    for (const [key, value] of Object.entries({ mode: "plan", autoApprove: "autoApprove" })) {
      const property = result.schema.properties[key];
      if (input.config?.[key] === undefined && property && !property.readOnly && property.enum?.includes(value)) defaults[key] = value;
    }
  }
  if (Object.keys(defaults).length) result = await client.request("resolveSessionConfig", { ...context, config: { ...result.values, ...defaults } });
  if (input.completion && !result.schema.properties[input.completion.property]?.enumDynamic) {
    throw new CreationConfigError("This task option does not support dynamic choices.");
  }

  const values = { ...result.values };
  const problems: string[] = [];
  for (const [key, value] of Object.entries(input.config ?? {})) {
    const property = result.schema.properties[key];
    if (input.strict && (!property || stable(value) !== stable(values[key]))) {
      problems.push(`${property?.title ?? key} changed or is not supported. Refresh task options.`);
    }
  }
  for (const [key, value] of Object.entries(values)) {
    const property = result.schema.properties[key];
    if (!property || configValueError(property.enumDynamic ? { ...property, enum: undefined } : property, value)) {
      if (input.strict) problems.push(`${key} is no longer valid`);
      delete values[key];
    }
  }
  for (const [key, property] of Object.entries(result.schema.properties)) {
    if (values[key] === undefined && property.default !== undefined && !configValueError(property, property.default)) values[key] = property.default;
  }
  const completions: CreationConfiguration["completions"] = {};
  for (const [key, property] of Object.entries(result.schema.properties)) {
    if (!property.enumDynamic) continue;
    const { items } = await client.request("sessionConfigCompletions", {
      ...context, config: values, property: key,
      query: input.strict && typeof values[key] === "string" ? values[key] as string : input.completion?.property === key ? input.completion.query : "",
    });
    completions[key] = items;
    if (values[key] !== undefined && !items.some((item) => item.value === values[key])) {
      // A default/recent completion list need not contain a selected branch.
      const selected = await client.request("sessionConfigCompletions", { ...context, config: values, property: key, query: String(values[key]) });
      completions[key] = [...items, ...selected.items.filter((item) => !items.some((other) => other.value === item.value))];
      if (!selected.items.some((item) => item.value === values[key])) {
        if (input.strict) problems.push(`${property.title} is no longer available`);
        delete values[key];
      }
    }
  }
  let model: ModelSelection | undefined;
  if (input.model) {
    const advertised = agent.models.find((m) => m.id === input.model!.id && m.policyState !== "disabled");
    if (!advertised) throw new CreationConfigError("The selected model is unavailable or disabled. Choose another model.");
    const modelValues = { ...input.model.config };
    for (const [key, property] of Object.entries(advertised.configSchema?.properties ?? {})) {
      if (modelValues[key] === undefined && property.default !== undefined) modelValues[key] = property.default as JsonPrimitive;
      if (property.readOnly && stable(modelValues[key]) !== stable(property.default)) problems.push(`${property.title} is read-only`);
    }
    problems.push(...configProblems(advertised.configSchema ?? { type: "object", properties: {} }, modelValues));
    model = { id: advertised.id, ...(Object.keys(modelValues).length ? { config: modelValues } : {}) };
  }
  problems.push(...configProblems(result.schema, values));
  if (input.strict && problems.length) throw new CreationConfigError(problems.join("; "));
  const revision = creationRevision({ provider, workingDirectory: input.workingDirectory, schema: result.schema, values, model, providers });
  return { providers, provider: agent.provider, schema: result.schema, values, model, completions, revision, problems };
}

/**
 * The selected model is provider-defined configuration carried in
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
