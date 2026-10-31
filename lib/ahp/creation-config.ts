import type {
  AgentInfo, ConfigPropertySchema, ConfigSchema, ModelSelection,
  SessionConfigPropertySchema, SessionConfigSchema, SessionConfigValueItem,
} from "@microsoft/agent-host-protocol";

export interface CreationConfiguration {
  providers: Pick<AgentInfo, "provider" | "displayName" | "models">[];
  provider: string;
  schema: SessionConfigSchema;
  values: Record<string, unknown>;
  model?: ModelSelection;
  completions: Record<string, SessionConfigValueItem[]>;
  revision: string;
  problems: string[];
}

export function isConfigRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function configValueError(property: ConfigPropertySchema, value: unknown): string | undefined {
  if (property.enum && !property.enum.some((item) => Object.is(item, value))) return "Choose an allowed value";
  if (property.type === "array") {
    if (!Array.isArray(value)) return "Expected a list";
    if (property.minItems !== undefined && value.length < property.minItems) return "Too few items";
    if (property.maxItems !== undefined && value.length > property.maxItems) return "Too many items";
    return property.items ? value.map((item) => configValueError(property.items!, item)).find(Boolean) : undefined;
  }
  if (property.type === "object") {
    if (!isConfigRecord(value)) return "Expected an object";
    return configProblems({ type: "object", properties: property.properties ?? {}, required: property.required }, value, property.additionalProperties)[0];
  }
  if (typeof value !== property.type || (typeof value === "number" && !Number.isFinite(value))) return `Expected ${property.type}`;
}

export function configProblems(
  schema: ConfigSchema,
  values: Record<string, unknown>,
  additional?: ConfigPropertySchema,
): string[] {
  const problems: string[] = [];
  for (const key of schema.required ?? []) {
    if (values[key] === undefined || values[key] === "") problems.push(`${schema.properties[key]?.title ?? key} is required`);
  }
  for (const [key, value] of Object.entries(values)) {
    const property = schema.properties[key] ?? additional;
    if (!property || ["__proto__", "constructor", "prototype"].includes(key)) {
      problems.push(`${key} is not supported`);
      continue;
    }
    // Dynamic enums contain only seeds; their complete membership is checked by the server.
    const error = configValueError((property as SessionConfigPropertySchema).enumDynamic ? { ...property, enum: undefined } : property, value);
    if (error) problems.push(`${property.title}: ${error}`);
  }
  return problems;
}

/** The form intentionally supports compact scalar pickers, not arbitrary JSON editing. */
export function isCreationControl(property: ConfigPropertySchema): boolean {
  return property.type === "boolean" || property.type === "string" || property.type === "number";
}

export function creationModelSchema(provider: string, schema?: ConfigSchema): ConfigSchema | undefined {
  if (!schema) return schema;
  const properties = { ...schema.properties };
  const primary = properties.thinkingLevel;
  const alias = properties.reasoningEffort;
  // Copilot's legacy thinkingLevel takes precedence over its reasoningEffort alias.
  const consolidate = provider === "copilotcli" && primary?.type === "string" && alias?.type === "string"
    && !!primary.enum && !!alias.enum
    && primary.enum.length === alias.enum.length && primary.enum.every((value) => alias.enum!.includes(value))
    && !!primary.readOnly === !!alias.readOnly
    && (alias.default === undefined || alias.default === primary.default);
  if (consolidate) delete properties.reasoningEffort;
  const controls = Object.entries(properties).filter(([, property]) => isCreationControl(property));
  for (const [key, property] of controls) {
    if (!controls.some(([otherKey, other]) => otherKey !== key && other.title === property.title)) continue;
    properties[key] = {
      ...property,
      title: `${property.title} (${key})`,
      description: `${property.description ?? ""} Model configuration: ${key}.${provider === "copilotcli" && primary && alias && !consolidate && ["thinkingLevel", "reasoningEffort"].includes(key) ? " thinkingLevel takes precedence when both effort settings are set." : ""}`.trim(),
    };
  }
  return {
    ...schema, properties,
    ...(schema.required ? { required: [...new Set(schema.required.map((key) => consolidate && key === "reasoningEffort" ? "thinkingLevel" : key))] } : {}),
  };
}

export function creationSummary(config: CreationConfiguration): string {
  const parts = [config.model
    ? config.providers.find((p) => p.provider === config.provider)?.models.find((m) => m.id === config.model?.id)?.name ?? config.model.id
    : "Host default model"];
  for (const [key, property] of Object.entries(config.schema.properties)) {
    if (!/mode|approve|permission|isolation|target/i.test(key) || !isCreationControl(property)) continue;
    const value = config.values[key];
    if (value === undefined) continue;
    if (config.provider === "copilotcli" && key === "mode" && value === "plan") parts.push("Plan mode");
    else if (config.provider === "copilotcli" && key === "autoApprove" && value === "autoApprove") parts.push("approvals bypassed");
    else {
      const index = property.enum?.findIndex((entry) => entry === value) ?? -1;
      parts.push(`${property.title}: ${property.enumLabels?.[index] ?? String(value)}`);
    }
  }
  return parts.join(" · ");
}
