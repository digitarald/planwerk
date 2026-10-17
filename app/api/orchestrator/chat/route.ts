import type { SessionConfig } from "@github/copilot-sdk";
import { NextRequest, NextResponse } from "next/server";

import { getCtoContinuityStore } from "@/lib/db/cto-continuity";
import { getDb } from "@/lib/db/schema";
import { createSdkObservabilityIngestor } from "@/lib/db/sdk-observability";
import { validateLocalMutationRequest } from "@/lib/http/local-mutation";
import {
  createCtoPermissionPolicy,
  getCtoTurnTimeoutMs,
  type CtoPendingApprovalDecision,
} from "@/lib/orchestrator/cto-approval";
import {
  CtoSessionLeaseBusyError,
  CtoSessionManager,
  type CtoSessionHandle,
} from "@/lib/orchestrator/cto-session-manager";
import {
  invalidateRuntimeForCleanupFailure,
  releaseRuntimeLease,
} from "@/lib/orchestrator/copilot-session";
import {
  buildBoardContext,
  buildCardDetail,
  getGateSummary,
} from "@/lib/orchestrator/board-context";
import { buildCtoChatTurn } from "@/lib/orchestrator/cto-chat-context";
import {
  createOrchestratorSdkTools,
  ORCHESTRATOR_TOOLS,
} from "@/lib/orchestrator/orchestrator-tools";
import type { OrchestratorToolResultEvent } from "@/lib/orchestrator/orchestrator-tools";
import {
  createSdkEventMapper,
  mapSdkFailure,
} from "@/lib/orchestrator/orchestrator-stream";
import { selectOrchestratorModel } from "@/lib/orchestrator/model";
import {
  acquireCopilotRuntimeClient,
  classifyCopilotFailure,
  isCopilotRuntimeInvalidatingFailure,
} from "@/lib/orchestrator/sdk-runtime";
import type { CopilotRuntimeLease } from "@/lib/orchestrator/sdk-runtime-manager";
import {
  executeToolCall,
  getAuthoritativeApprovalBinding,
} from "@/lib/orchestrator/tool-executor";
import { TurnSubmission } from "@/lib/orchestrator/turn-submission";
import type { KanbanCard } from "@/lib/types";
import type { CopilotClient } from "@github/copilot-sdk";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TOOL_NAMES = ORCHESTRATOR_TOOLS.map((tool) => tool.function.name);
const SESSION_TIMEOUT_MS = getCtoTurnTimeoutMs();

function isLocalHost(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "::1" ||
      host === "[::1]"
    );
  } catch {
    return false;
  }
}

type CardPhaseRow = {
  card_id: string;
  phase: string;
  updated_at: string;
};

function getCardsFromDb(): KanbanCard[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT card_id, phase, updated_at FROM card_phases")
    .all() as CardPhaseRow[];

  return rows.map((row) => ({
    id: row.card_id,
    title: row.card_id,
    phase: row.phase as KanbanCard["phase"],
    runtime: "idle" as const,
    gateStatus: "pending" as const,
    attention: "none" as const,
    risk: "low" as const,
    activity: "",
    additions: 0,
    deletions: 0,
    filesChanged: 0,
    planSteps: { total: 0, done: 0 },
    modifiedAt: new Date(row.updated_at).getTime(),
  }));
}

function generateReadOnlyFallback(
  message: string,
  cards: KanbanCard[],
  selectedCard?: KanbanCard,
): string {
  const lower = message.toLowerCase();
  const phases = { define: 0, plan: 0, build: 0, review: 0, ship: 0 };
  for (const card of cards) {
    if (card.phase in phases) {
      phases[card.phase as keyof typeof phases]++;
    }
  }

  const summary = `Board: ${phases.define} defining, ${phases.plan} planning, ${phases.build} building, ${phases.review} in review, ${phases.ship} shipped.`;
  const degraded = "Degraded read-only mode — CTO actions are disabled. ";

  if (lower.includes("status") || lower.includes("board") || lower.includes("how")) {
    return degraded + summary +
      (selectedCard
        ? ` Selected: ${selectedCard.title} in ${selectedCard.phase}.`
        : "");
  }
  if (lower.includes("stuck") || lower.includes("why")) {
    return degraded + (selectedCard
      ? `${selectedCard.title} is in ${selectedCard.phase} (${selectedCard.runtime}). Check if it needs input or has a gate failure.`
      : `${summary} Select a card for details.`);
  }
  if (lower.includes("next") || lower.includes("what should")) {
    const attentionCards = cards.filter(
      (card) =>
        card.attention !== "none" || card.runtime === "input-needed",
    );
    return degraded + (attentionCards.length > 0
      ? `Priority: ${attentionCards[0].title} needs attention (${attentionCards[0].attention || attentionCards[0].runtime}).`
      : `${summary} No cards need immediate attention.`);
  }
  return degraded + summary;
}

function sseResponse(events: Record<string, unknown>[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const event of events) {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
          );
        }
        controller.close();
      },
    }),
    {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "X-Content-Type-Options": "nosniff",
        Connection: "keep-alive",
      },
    },
  );
}

function degradedResponse(
  error: unknown,
  message: string,
  cards: KanbanCard[],
  selectedCard?: KanbanCard,
): Response {
  return sseResponse([
    mapSdkFailure(error, "degraded"),
    {
      type: "text",
      content: generateReadOnlyFallback(message, cards, selectedCard),
    },
    {
      type: "done",
      status: "degraded",
      actionsDisabled: true,
    },
  ]);
}

/**
 * Chat endpoint — streams native Copilot SDK deltas and tool lifecycle events
 * over SSE. Prose in the assistant response never authorizes an action.
 */
export async function POST(request: NextRequest) {
  const requestError = validateLocalMutationRequest(request);
  if (requestError) {
    return NextResponse.json({ error: requestError }, { status: 403 });
  }

  if (request.signal.aborted) {
    return NextResponse.json(
      { error: "request was cancelled before submission", retryable: true },
      { status: 499 }
    );
  }
  let body: {
    message?: string;
    selectedCardId?: string;
    cards?: KanbanCard[];
    hostUrl?: string;
  };
  try {
    body = await request.json();
  } catch {
    if (request.signal.aborted) {
      return NextResponse.json(
        { error: "request was cancelled before submission", retryable: true },
        { status: 499 }
      );
    }
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (request.signal.aborted) {
    return NextResponse.json(
      { error: "request was cancelled before submission", retryable: true },
      { status: 499 }
    );
  }

  const { message, selectedCardId, cards: clientCards, hostUrl } = body;
  if (!message) {
    return NextResponse.json({ error: "message required" }, { status: 400 });
  }
  if (hostUrl && !isLocalHost(hostUrl)) {
    return NextResponse.json(
      { error: "hostUrl must be localhost" },
      { status: 400 },
    );
  }

  const cards = clientCards ?? getCardsFromDb();
  const selectedCard = selectedCardId
    ? cards.find((card) => card.id === selectedCardId)
    : undefined;
  const actionsEnabled = Boolean(hostUrl);
  const chatTurn = buildCtoChatTurn({
    message,
    boardContext: buildBoardContext(cards),
    gateSummary: getGateSummary(),
    selectedCardContext: selectedCard ? buildCardDetail(selectedCard) : undefined,
    actionsEnabled,
  });

  let runtimeLease: CopilotRuntimeLease<CopilotClient>;
  try {
    runtimeLease = await acquireCopilotRuntimeClient();
  } catch (error) {
    console.warn(
      "[orchestrator-chat] Failed to start Copilot SDK:",
      error instanceof Error ? error.message : error,
    );
    return degradedResponse(error, message, cards, selectedCard);
  }

  const toolResults = new Map<string, OrchestratorToolResultEvent>();
  const continuityStore = getCtoContinuityStore();
  const sessionManager = new CtoSessionManager(continuityStore);
  const lifecycleAbort = new AbortController();
  const queuedApprovals: CtoPendingApprovalDecision[] = [];
  let deliverApproval:
    | ((approval: CtoPendingApprovalDecision) => void)
    | undefined;
  const permissionPolicy = createCtoPermissionPolicy({
    store: continuityStore,
    resolveBinding: getAuthoritativeApprovalBinding,
    signal: lifecycleAbort.signal,
    onApprovalRequired: (approval) => {
      if (deliverApproval) deliverApproval(approval);
      else queuedApprovals.push(approval);
    },
  });
  let sessionHandle: CtoSessionHandle;
  try {
    const client = runtimeLease.client;
    const selectedModel = await selectOrchestratorModel(client, {
      role: "conversation",
    });
    const tools = actionsEnabled
      ? createOrchestratorSdkTools({
          dispatch: (toolName, args, auditKey, invocation) =>
            executeToolCall(toolName, args, {
              hostUrl: hostUrl!,
              cards,
              idempotencyKey: auditKey,
              sdkSessionId: invocation.sessionId,
              toolCallId: invocation.toolCallId,
              signal: lifecycleAbort.signal,
            }),
          onResult: (event) => toolResults.set(event.toolCallId, event),
        })
      : [];
    const sessionConfig = {
      model: selectedModel.model,
      reasoningEffort: selectedModel.reasoningEffort,
      streaming: true,
      tools,
      availableTools: actionsEnabled ? TOOL_NAMES : [],
      infiniteSessions: {
        enabled: true,
        backgroundCompactionThreshold: 0.75,
        bufferExhaustionThreshold: 0.9,
      },
      enableSessionStore: false,
      skipCustomInstructions: true,
      onPermissionRequest: permissionPolicy.onPermissionRequest,
      hooks: permissionPolicy.hooks,
      systemMessage: chatTurn.systemMessage,
    } satisfies SessionConfig;
    sessionHandle = await sessionManager.open(
      client,
      selectedModel.model,
      sessionConfig,
      { invalidateRuntime: (reason) => runtimeLease.invalidate(reason) },
    );
  } catch (error) {
    permissionPolicy.cancelPending();
    if (error instanceof CtoSessionLeaseBusyError) {
      await releaseRuntimeLease(runtimeLease, "[orchestrator-chat]");
      return NextResponse.json(
        { error: error.message, retryable: true },
        { status: 409 }
      );
    }
    console.warn(
      "[orchestrator-chat] Failed to open Copilot SDK session:",
      error instanceof Error ? error.message : error,
    );
    if (isCopilotRuntimeInvalidatingFailure(error)) {
      await runtimeLease.invalidate(error).catch(() => {});
    }
    await releaseRuntimeLease(runtimeLease, "[orchestrator-chat]");
    return degradedResponse(error, message, cards, selectedCard);
  }
  const session = sessionHandle.session;

  if (request.signal.aborted) {
    lifecycleAbort.abort();
    permissionPolicy.cancelPending();
    const cleanup = await sessionHandle.release({ abort: true });
    await invalidateRuntimeForCleanupFailure(
      runtimeLease,
      cleanup,
      "[orchestrator-chat]",
    );
    await releaseRuntimeLease(runtimeLease, "[orchestrator-chat]");
    return NextResponse.json(
      { error: "request was cancelled before submission", retryable: true },
      { status: 499 }
    );
  }

  const encoder = new TextEncoder();
  const submission = new TurnSubmission();
  let controllerClosed = false;
  let cleanupPromise: Promise<void> | null = null;

  const cleanup = (abort: boolean, transportError?: unknown) => {
    lifecycleAbort.abort();
    permissionPolicy.cancelPending();
    cleanupPromise ??= (async () => {
      let cleanupInvalidationReason = transportError;
      const cleanup = await sessionHandle.release({ abort });
      const cleanupFailure = cleanup.failures.find(
        ({ error }) => isCopilotRuntimeInvalidatingFailure(error),
      );
      cleanupInvalidationReason ??= cleanupFailure?.error;
      if (cleanupInvalidationReason !== undefined) {
        await runtimeLease.invalidate(cleanupInvalidationReason).catch((error) => {
          console.warn(
            "[orchestrator-chat] Failed to invalidate Copilot SDK runtime:",
            error instanceof Error ? error.message : error
          );
        });
      }
      await releaseRuntimeLease(runtimeLease, "[orchestrator-chat]");
    })();
    return cleanupPromise;
  };

  const abortTurn = () => {
    submission.cancel();
    void cleanup(true);
  };
  request.signal.addEventListener("abort", abortTurn, { once: true });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const mapper = createSdkEventMapper(toolResults);
      const ingest = createSdkObservabilityIngestor({
        sdkSessionId: session.sessionId,
        boardId: "primary",
        workspaceId: process.cwd(),
        cardId: selectedCardId,
      });
      const send = (data: Record<string, unknown>) => {
        if (submission.cancelled || controllerClosed) return;
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(data)}\n\n`),
        );
      };
      deliverApproval = (approval) => {
        send({
          type: "approval-required",
          decisionCapability: approval.decisionCapability,
          toolName: approval.toolName,
          cardId: approval.cardId,
          riskLevel: approval.riskLevel,
          action: approval.action,
          facts: approval.facts,
          expiresAtMs: approval.expiresAtMs,
        });
      };
      for (const approval of queuedApprovals.splice(0)) {
        deliverApproval(approval);
      }
      const unsubscribe = session.on((event) => {
        if (event.type === "session.shutdown" || event.type === "session.error") {
          lifecycleAbort.abort();
          permissionPolicy.cancelPending();
        }
        try {
          ingest(event);
        } catch (error) {
          console.warn(
            "[orchestrator-chat] Failed to persist SDK event:",
            error instanceof Error ? error.message : error
          );
        }
        const mapped = mapper.map(event);
        if (!mapped) return;
        send(mapped);
        if (mapped.type === "error") {
          send({
            type: "text",
            content:
              `${mapper.content}${mapper.content ? "\n\n" : ""}` +
              `CTO error — actions disabled: ${mapped.message}`,
          });
        }
      });

      let abortOnCleanup = false;
      let transportError: unknown;
      try {
        if (!submission.tryStart(request.signal.aborted)) {
          abortOnCleanup = true;
          return;
        }
        await session.sendAndWait(chatTurn.message, SESSION_TIMEOUT_MS);
        submission.finish();
        if (submission.cancelled) {
          abortOnCleanup = true;
          return;
        }
        if (mapper.error) {
          abortOnCleanup = true;
          const mappedError = mapper.error;
          if (mappedError.type !== "error") {
            throw new Error("Invalid SDK error event");
          }
          const sessionError = Object.assign(
            new Error(mappedError.message),
            { name: mappedError.errorType ?? "SessionError" }
          );
          if (classifyCopilotFailure(sessionError) === "transport") {
            transportError = sessionError;
          }
          send({
            type: "done",
            status: "error",
            actionsDisabled: true,
          });
        } else if (!mapper.content) {
          abortOnCleanup = true;
          const mapped = mapSdkFailure(
            new Error("Copilot SDK returned no assistant message"),
          );
          send(mapped);
          send({
            type: "text",
            content: `CTO error — actions disabled: ${mapped.message}`,
          });
          send({
            type: "done",
            status: "error",
            actionsDisabled: true,
          });
        } else {
          send({ type: "done", status: "success" });
        }
      } catch (error) {
        abortOnCleanup = true;
        if (classifyCopilotFailure(error) === "transport") {
          transportError = error;
        }
        if (!submission.cancelled) {
          console.warn(
            "[orchestrator-chat] Copilot SDK turn failed:",
            error instanceof Error ? error.message : error,
          );
          const mapped = mapSdkFailure(error);
          send(mapped);
          send({
            type: "text",
            content:
              `${mapper.content}${mapper.content ? "\n\n" : ""}` +
              `CTO error — actions disabled: ${mapped.message}`,
          });
          send({
            type: "done",
            status: "error",
            actionsDisabled: true,
          });
        }

      } finally {
        deliverApproval = undefined;
        queuedApprovals.length = 0;
        unsubscribe();
        request.signal.removeEventListener("abort", abortTurn);
        await cleanup(
          abortOnCleanup || submission.cancelled,
          transportError
        );
        if (!submission.cancelled && !controllerClosed) {
          controllerClosed = true;
          controller.close();
        }
      }
    },
    async cancel() {
      submission.cancel();
      request.signal.removeEventListener("abort", abortTurn);
      await cleanup(true);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Content-Type-Options": "nosniff",
      Connection: "keep-alive",
    },
  });
}

export async function DELETE(request: NextRequest) {
  const requestError = validateLocalMutationRequest(request, "DELETE");
  if (requestError) {
    return NextResponse.json({ error: requestError }, { status: 403 });
  }

  let runtimeLease: CopilotRuntimeLease<CopilotClient> | undefined;
  try {
    runtimeLease = await acquireCopilotRuntimeClient();
    const cleared = await new CtoSessionManager(
      getCtoContinuityStore()
    ).clear(runtimeLease.client, {
      invalidateRuntime: (reason) => runtimeLease!.invalidate(reason),
    });
    return NextResponse.json({ cleared });
  } catch (error) {
    if (error instanceof CtoSessionLeaseBusyError) {
      return NextResponse.json(
        { error: error.message, retryable: true },
        { status: 409 }
      );
    }
    if (runtimeLease && isCopilotRuntimeInvalidatingFailure(error)) {
      await runtimeLease.invalidate(error).catch((resetError) => {
        console.warn(
          "[orchestrator-chat] Failed to invalidate Copilot SDK runtime after clear failure:",
          resetError instanceof Error ? resetError.message : resetError,
        );
      });
    }
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to clear CTO session",
      },
      { status: 500 }
    );
  } finally {
    await releaseRuntimeLease(runtimeLease, "[orchestrator-chat]");
  }
}
