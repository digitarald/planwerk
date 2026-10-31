import "server-only";

import type { AhpClient } from "@microsoft/agent-host-protocol/client";
import type { ChatState, SessionState } from "@microsoft/agent-host-protocol";
import type { Artifact } from "@/lib/types";
import { awaitAbortable } from "../abort";
import { readTextResource } from "./resource-read";
import { EvidenceCaptureBudget } from "./evidence-budget";
import { hashPlanContent, isPlanReviewRequest, readPlanReviewInput, type PlanEvidence } from "./plan-source";
import { readChatState } from "./snapshot";

function requestTurn(chat: ChatState | undefined, requestId: string): string {
  const turns = [...(chat?.turns ?? []), ...(chat?.activeTurn ? [chat.activeTurn] : [])];
  const matches = turns.filter((turn) => turn.responseParts.some(
    (part) => part.kind === "inputRequest" && part.request.id === requestId && part.response === undefined,
  ));
  if (matches.length !== 1) throw new Error("The original plan request turn is unavailable or ambiguous.");
  return matches[0].id;
}

export async function fetchSessionPlan(
  client: AhpClient,
  sessionUri: string,
  state: SessionState,
  providedBudget?: EvidenceCaptureBudget,
  providedChat?: ChatState,
): Promise<{ artifact: Artifact; source: PlanEvidence["source"] } | null> {
  if (!sessionUri.startsWith("ahp-session:/")) return null;
  const requests = (state.inputNeeded ?? []).filter(
    (entry) => entry.kind === "chatInput" && isPlanReviewRequest(entry.request),
  );
  if (requests.length === 0) return null;
  if (requests.length !== 1) throw new Error("More than one parent plan request is pending.");
  const entry = requests[0];
  if (entry.kind !== "chatInput") return null;
  const review = readPlanReviewInput(entry.request);
  if (!review?.planUri) throw new Error("The host has not published a complete plan resource.");
  const budget = providedBudget ?? new EvidenceCaptureBudget();
  try {
    const chat = providedChat?.resource === entry.chat
      ? providedChat : await awaitAbortable(() => readChatState(client, entry.chat), budget.signal);
    const source = {
      sessionUri, uri: review.planUri, chatUri: entry.chat,
      turnId: requestTurn(chat, entry.request.id), requestId: entry.request.id,
    };
    const content = await awaitAbortable(() => readTextResource(client, source.uri,
      (count) => budget.consumeDecodedBytes(count)), budget.signal);
    budget.assertCurrent();
    if (!content.trim()) throw new Error("The published plan resource is empty.");
    return {
      source,
      artifact: {
        id: source.uri, type: "plan", title: "Plan", contentRef: content,
        createdAt: Date.now(), createdBy: "agent", status: "draft",
      },
    };
  } catch (error) {
    budget.assertCurrent();
    throw error;
  } finally {
    if (!providedBudget) budget.dispose();
  }
}

export async function verifyPlanEvidence(
  client: AhpClient,
  state: SessionState,
  evidence: PlanEvidence,
  budget: EvidenceCaptureBudget,
): Promise<void> {
  const { source } = evidence;
  if (source.requestId) {
    const entry = state.inputNeeded?.find(
      (input) => input.kind === "chatInput" && input.request.id === source.requestId,
    );
    if (!entry || entry.kind !== "chatInput" || entry.chat !== source.chatUri
      || readPlanReviewInput(entry.request)?.planUri !== source.uri) {
      throw new Error("The original plan request or resource changed.");
    }
    const chat = await awaitAbortable(() => readChatState(client, entry.chat), budget.signal);
    if (requestTurn(chat, source.requestId) !== source.turnId) {
      throw new Error("The original plan request turn changed.");
    }
  }
  const content = await awaitAbortable(() => readTextResource(client, source.uri,
    (count) => budget.consumeDecodedBytes(count)), budget.signal);
  budget.assertCurrent();
  if (!content.trim() || content !== evidence.content
    || hashPlanContent(content) !== evidence.changesetRef) {
    throw new Error("The parent plan changed after its evidence was captured.");
  }
}
