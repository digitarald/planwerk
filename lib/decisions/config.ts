import { createHash } from "node:crypto";
import { z } from "zod";
import { acceptanceSchema, decisionFamilies, type DecisionFamily } from "./core.ts";
import {
  usesDecideConfiguration,
  savedDecideConfiguration,
  readDecideKeychainCredential,
} from "./decide-configuration.ts";

const profileSchema = z.strictObject({
  mode: z.enum(["legacy", "shadow", "active"]),
  acceptance: acceptanceSchema.optional(),
});
export type DecisionProfile = z.infer<typeof profileSchema>;

export function decisionProfile(family: DecisionFamily): DecisionProfile {
  const raw = process.env.PLANWERK_DECISION_POLICIES;
  if (!raw) return { mode: "legacy" };
  const profiles = z.partialRecord(z.enum(decisionFamilies), profileSchema).parse(JSON.parse(raw));
  return profiles[family] ?? { mode: "legacy" };
}

export function decisionPolicyKey(family: DecisionFamily, version: string): string {
  const target = decisionTarget();
  return createHash("sha256").update(JSON.stringify([
    family, version, decisionProfile(family),
    target.endpoint, target.deployment, target.source,
    process.env.PLANWERK_DECISION_CONFIGURATION_REVISION,
    Boolean(process.env.PLANWERK_DECISION_API_KEY || process.env.PLANWERK_DECISION_TOKEN ||
      (target.source === "decide" && (process.env.DECIDE_API_KEY || process.env.AZURE_API_KEY ||
        process.env.DECIDE_TOKEN || process.env.AZURE_ENTRA_TOKEN))),
  ])).digest("hex");
}

export function decisionStillCurrent(family: DecisionFamily, version: string, outcome: { policyKey: string }): boolean {
  return decisionProfile(family).mode === "active" && outcome.policyKey === decisionPolicyKey(family, version);
}

function decisionTarget() {
  const shared = usesDecideConfiguration();
  const explicitEndpoint = process.env.PLANWERK_DECISION_ENDPOINT ?? (shared ? process.env.DECIDE_ENDPOINT : undefined);
  const explicitDeployment = process.env.PLANWERK_DECISION_DEPLOYMENT ?? (shared ? process.env.DECIDE_DEPLOYMENT : undefined);
  const saved = shared && (explicitEndpoint === undefined || explicitDeployment === undefined)
    ? savedDecideConfiguration() : {};
  return {
    source: shared ? "decide" : "environment",
    endpoint: explicitEndpoint ?? saved.endpoint ?? "",
    deployment: explicitDeployment ?? saved.deployment ?? (shared ? "Decision-1" : undefined),
  };
}

export async function foundryConfiguration(
  readKeychain: (endpoint: string) => Promise<string> = readDecideKeychainCredential,
) {
  const target = decisionTarget();
  const endpoint = target.endpoint.trim().toLowerCase();
  if (!/^https:\/\/[a-z0-9][a-z0-9-]*\.services\.ai\.azure\.com\/?$/.test(endpoint)) {
    throw new Error("Configure PLANWERK_DECISION_ENDPOINT with a Foundry HTTPS resource URL.");
  }
  const deployment = target.deployment?.trim();
  if (!deployment) throw new Error("Decision-model setup requires a deployment.");
  let key = process.env.PLANWERK_DECISION_API_KEY;
  let token = process.env.PLANWERK_DECISION_TOKEN;
  if (key === undefined && token === undefined && target.source === "decide") {
    key = process.env.DECIDE_API_KEY ?? process.env.AZURE_API_KEY;
    if (key === undefined) token = process.env.DECIDE_TOKEN ?? process.env.AZURE_ENTRA_TOKEN;
    if (key === undefined && token === undefined) key = await readKeychain(endpoint);
  }
  const credential = (key ?? token)?.trim();
  if (!credential || !/^[!-~]+$/.test(credential)) {
    throw new Error("Decision-model setup requires a valid server-side API key or Entra token.");
  }
  const headers: Record<string, string> = key !== undefined
    ? { "api-key": credential } : { Authorization: `Bearer ${credential}` };
  return {
    endpoint: endpoint.replace(/\/$/, ""), deployment,
    headers,
  };
}
