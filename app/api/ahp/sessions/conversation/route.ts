import { NextRequest, NextResponse } from "next/server";
import type { ChatSource } from "@microsoft/agent-host-protocol";
import { z } from "zod";
import { ahpErrorResponse } from "@/lib/ahp/api-error";
import { ConversationConflictError } from "@/lib/ahp/conversation-core";
import { createContextualConversation, readConversation } from "@/lib/ahp/conversation";
import { validateLocalMutationRequest } from "@/lib/http/local-mutation";

const identity = { hostUrl: z.string().min(1), sessionUri: z.string().min(1), chatUri: z.string().min(1).optional() };
const source = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("fork"), chat: z.string().min(1), turnId: z.string().min(1) }).strict(),
  z.object({
    kind: z.literal("sideChat"), chat: z.string().min(1), turnId: z.string().min(1),
    selection: z.object({ text: z.string().min(1).max(8_000), responsePartId: z.string().min(1).optional() }).strict().optional(),
  }).strict(),
]);
const schema = z.discriminatedUnion("operation", [
  z.object({ ...identity, operation: z.literal("read") }).strict(),
  z.object({ ...identity, chatUri: z.string().min(1), operation: z.literal("history"), cursor: z.string().min(1) }).strict(),
  z.object({ ...identity, chatUri: z.string().min(1), operation: z.literal("create"), source: source.optional() }).strict(),
]);

export async function POST(request: NextRequest) {
  const requestError = validateLocalMutationRequest(request);
  if (requestError) return NextResponse.json({ error: requestError }, { status: 403 });
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid conversation request." }, { status: 400 });
  const body = parsed.data;
  try {
    if (body.operation === "create") return NextResponse.json(await createContextualConversation(
      body.hostUrl, body.sessionUri, body.chatUri, body.source as ChatSource | undefined, request.signal,
    ));
    return NextResponse.json({ conversation: await readConversation(
      body.hostUrl, body.sessionUri, body.chatUri, body.operation === "history" ? body.cursor : undefined, request.signal,
    ) });
  } catch (error) {
    if (error instanceof ConversationConflictError) return NextResponse.json({ error: error.message }, { status: 409 });
    return ahpErrorResponse(error, "Conversation could not be loaded. No automatic retry was made.");
  }
}
