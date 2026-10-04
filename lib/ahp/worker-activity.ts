import type { ChatSummary, SessionChatSummary } from "@microsoft/agent-host-protocol";

import type { RuntimeStatus, WorkerActivity } from "@/lib/types";

const AHP_STATUS = {
  Error: 2,
  InProgress: 8,
  InputNeeded: 24,
} as const;

export type WorkerChatSummary = SessionChatSummary & Pick<Partial<ChatSummary>, "activity">;

export function workerRuntime(status: number | undefined): RuntimeStatus | "unknown" {
  if (status === undefined) return "unknown";
  if ((status & 64) !== 0) return "idle";
  if ((status & AHP_STATUS.Error) !== 0) return "error";
  if ((status & AHP_STATUS.InputNeeded) === AHP_STATUS.InputNeeded) return "input-needed";
  if ((status & AHP_STATUS.InProgress) !== 0) return "running";
  return "idle";
}

/** AHP makes tool origin the canonical subagent relationship. */
export function isToolSpawnedWorker(chat: WorkerChatSummary): boolean {
  return chat.origin?.kind === "tool";
}

/** Input-needed includes the in-progress bit but is not currently executing. */
export function isWorkerActive(chat: WorkerChatSummary): boolean {
  return (
    isToolSpawnedWorker(chat)
    && chat.status !== undefined
    && (chat.status & 64) === 0
    && (chat.status & AHP_STATUS.InProgress) !== 0
    && (chat.status & AHP_STATUS.InputNeeded) !== AHP_STATUS.InputNeeded
  );
}

export function mapWorkerChat(chat: WorkerChatSummary, history: WorkerActivity["history"] = []): WorkerActivity | undefined {
  if (!isToolSpawnedWorker(chat) || chat.interactivity === "hidden") return undefined;
  return {
    id: chat.resource,
    title: chat.title,
    runtime: workerRuntime(chat.status),
    activity: chat.activity,
    isActive: isWorkerActive(chat),
    history,
  };
}

export function mapWorkerChats(chats: readonly WorkerChatSummary[]): WorkerActivity[] {
  return chats
    .map((chat) => mapWorkerChat(chat))
    .filter((worker): worker is WorkerActivity => worker !== undefined)
    .sort((a, b) => Number(b.isActive) - Number(a.isActive) || a.title.localeCompare(b.title));
}

/** Keep completed workers visible after hosts prune their chat catalog. */
export function retainInactiveWorkers(
  previous: readonly WorkerActivity[] | undefined,
  current: readonly WorkerActivity[],
): WorkerActivity[] {
  const currentIds = new Set(current.map((worker) => worker.id));
  const retained = (previous ?? [])
    .filter((worker) => !currentIds.has(worker.id))
    .map((worker) => ({ ...worker, runtime: "idle" as const, isActive: false }));
  return [...current, ...retained].sort(
    (a, b) => Number(b.isActive) - Number(a.isActive) || a.title.localeCompare(b.title),
  );
}
