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
  /** Owning chat channel, supplied by the session aggregate. */
  chat?: string;
}

/** Whether the host has supplied an aggregate snapshot, even when it is empty. */
export function hasObservedInputNeeded<T>(
  inputNeeded: readonly T[] | undefined | null,
): inputNeeded is readonly T[] {
  return Array.isArray(inputNeeded);
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
 * True only when an *observed* aggregate contains no matching entry. An
 * unavailable aggregate is unknown, not evidence that an input was removed.
 */
export function isInputObservedRemoved(
  inputNeeded: readonly InputNeededEntryLike[] | undefined | null,
  requestId: string,
): boolean {
  return hasObservedInputNeeded(inputNeeded)
    && !findChatInputEntry(inputNeeded, requestId)
    && !findEntryById(inputNeeded, requestId);
}

/**
 * Return a single chat-input request that appeared after a known snapshot on
 * the specified chat. More than one new request is ambiguous, so callers must
 * wait rather than answer an unrelated concurrent input.
 */
export function findUniqueNewChatInputEntry<T extends InputNeededEntryLike>(
  inputNeeded: readonly T[] | undefined | null,
  chatUri: string,
  knownRequestIds: ReadonlySet<string>,
): T | undefined {
  if (!hasObservedInputNeeded(inputNeeded)) return undefined;

  const candidates = inputNeeded.filter(
    (entry) =>
      entry.kind === "chatInput"
      && entry.chat === chatUri
      && typeof entry.request?.id === "string"
      && !knownRequestIds.has(entry.request.id),
  );
  return candidates.length === 1 ? candidates[0] : undefined;
}
