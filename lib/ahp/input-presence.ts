/**
 * Pure predicates for locating a pending elicitation inside a session's
 * `inputNeeded` aggregate — and, by extension, for deciding whether an answer
 * we dispatched was actually *applied* (the request left `inputNeeded`).
 *
 * This is the crux of the plan-approval fix: `client.ping()` only flushes the
 * transport, so the orchestrator can only trust that a plan approval was
 * confirmed by re-reading state and checking the request is gone. Keeping the
 * matching logic here — free of `server-only` and the `@/` alias — makes it
 * unit-testable (`node --test`) and shared with `session-messenger.ts` and the
 * API route.
 */

/** Minimal structural shape of an `inputNeeded` entry we need to match on. */
export interface InputNeededEntryLike {
  /** Opaque host key (composite entry id). */
  id?: string;
  /** Entry kind — only `"chatInput"` entries carry an answerable `request`. */
  kind?: string;
  /** The chat-input request, present on `chatInput` entries. */
  request?: { id?: string };
}

/**
 * Find a mirrored chat elicitation by its `request.id` (the question/GUID the
 * orchestrator keys answers on).
 */
export function findChatInputEntry<T extends InputNeededEntryLike>(
  inputNeeded: readonly T[] | undefined | null,
  requestId: string,
): T | undefined {
  return inputNeeded?.find((e) => e.kind === "chatInput" && e.request?.id === requestId);
}

/** Find an entry by its opaque host key (composite entry id). */
export function findEntryById<T extends InputNeededEntryLike>(
  inputNeeded: readonly T[] | undefined | null,
  requestId: string,
): T | undefined {
  return inputNeeded?.find((e) => e.id === requestId);
}

/**
 * True when `requestId` matches no entry in the aggregate — matched neither by
 * `request.id` nor by opaque entry id. Used both to detect a stale request
 * (gone before we dispatched) and an *applied* answer (gone after we
 * dispatched).
 */
export function isInputResolved(
  inputNeeded: readonly InputNeededEntryLike[] | undefined | null,
  requestId: string,
): boolean {
  return !findChatInputEntry(inputNeeded, requestId) && !findEntryById(inputNeeded, requestId);
}
