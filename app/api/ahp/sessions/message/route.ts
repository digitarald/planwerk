import { NextRequest, NextResponse } from "next/server";

import { z } from "zod";
import { changeConversation } from "@/lib/ahp/conversation";
import { ConversationConflictError } from "@/lib/ahp/conversation-core";
import { ahpErrorResponse } from "@/lib/ahp/api-error";
import { validateLocalMutationRequest } from "@/lib/http/local-mutation";

const identity = { hostUrl: z.string().min(1), sessionUri: z.string().min(1), chatUri: z.string().min(1).optional() };
const text = z.string().trim().min(1).max(32_000);
const schema = z.discriminatedUnion("operation", [
  z.object({ ...identity, operation: z.literal("send"), message: text }).strict(),
  z.object({ ...identity, operation: z.literal("steer"), message: text }).strict(),
  z.object({ ...identity, chatUri: z.string().min(1), operation: z.literal("edit"), kind: z.enum(["queued", "steering"]), id: z.string().min(1), expectedText: z.string(), message: text }).strict(),
  z.object({ ...identity, chatUri: z.string().min(1), operation: z.literal("cancel"), kind: z.enum(["queued", "steering"]), id: z.string().min(1), expectedText: z.string() }).strict(),
  z.object({ ...identity, chatUri: z.string().min(1), operation: z.literal("reorder"), order: z.array(z.string().min(1)).max(1_000).refine((order) => new Set(order).size === order.length) }).strict(),
]);

export async function POST(request: NextRequest) {
  const requestError = validateLocalMutationRequest(request);
  if (requestError) {
    return NextResponse.json({ error: requestError }, { status: 403 });
  }

  const raw = await request.json().catch(() => null);
  const parsed = schema.safeParse(raw && typeof raw === "object" ? { ...raw, operation: raw.operation ?? "send" } : raw);
  if (!parsed.success) return NextResponse.json({ error: "Invalid message request." }, { status: 400 });
  const { hostUrl, sessionUri, chatUri, ...mutation } = parsed.data;

  try {
    const result = await changeConversation(hostUrl, sessionUri, chatUri, mutation, request.signal);

    return NextResponse.json({
      ok: true,
      ...result,
      turnId: result.id,
      queued: result.outcome === "queued",
    });
  } catch (err) {
    if (err instanceof ConversationConflictError) return NextResponse.json({ error: err.message }, { status: 409 });
    console.error("[ahp:message] error:", err instanceof Error ? err.message : err);
    return ahpErrorResponse(err, "Failed to send message");
  }
}
