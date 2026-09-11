import type { CtoContinuityStore } from "../db/cto-continuity-store.ts";
import { validateLocalMutationRequest } from "../http/local-mutation.ts";
import { decideCtoApproval } from "./cto-approval.ts";

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export function listApprovalDisplayMetadata(
  store: CtoContinuityStore,
): Response {
  const approvals = store.listApprovals("pending").map((approval) => ({
    toolName: approval.toolName,
    cardId: approval.cardId,
    riskLevel: approval.riskLevel,
    facts: approval.facts,
    status: approval.status,
    expiresAtMs: approval.expiresAtMs,
    createdAtMs: approval.createdAtMs,
  }));
  return json({ approvals });
}

export async function handleApprovalDecision(
  request: Request,
  store: CtoContinuityStore,
): Promise<Response> {
  const requestError = validateLocalMutationRequest(request);
  if (requestError) return json({ error: requestError }, 403);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return json({ error: "invalid decision body" }, 400);
  }

  const values = body as Record<string, unknown>;
  const keys = Object.keys(values);
  if (keys.some((key) => key !== "decisionCapability" && key !== "decision")) {
    return json({ error: "unsupported decision field" }, 400);
  }
  if (
    typeof values.decisionCapability !== "string" ||
    (values.decision !== "approve" && values.decision !== "reject")
  ) {
    return json(
      { error: "decisionCapability and approve/reject decision are required" },
      400,
    );
  }

  const approval = decideCtoApproval(
    store,
    values.decisionCapability,
    values.decision === "approve" ? "approved" : "rejected",
  );
  if (!approval) {
    return json(
      { error: "decision capability is invalid, expired, or already used" },
      409,
    );
  }
  return json({ ok: true, status: approval.status });
}
