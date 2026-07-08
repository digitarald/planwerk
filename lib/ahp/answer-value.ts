/**
 * Pure, dependency-free builders that shape a free-form string into the typed
 * AHP answer value a chat input question expects.
 *
 * Kept free of the `@/` alias and `server-only` so it can be exercised directly
 * by the `node --test` harness (mirrors the `verdict-parse.ts` / `coherence-detect.ts`
 * precedent). Two consumers:
 *  - `buildAnswer` — option-aware mapping for auto-answer / the `answer_input`
 *    orchestrator tool (matches a select option, or coerces boolean/number/text).
 *  - `buildFreeformAnswer` — delivers arbitrary prose (e.g. a rubber-duck critique)
 *    to whatever follow-up the agent surfaces, including a `single-select` that
 *    allows free text (the shape Copilot CLI's `ask_user` tool now produces).
 *
 * Both operate on a structural {@link AnswerQuestion}, so callers can pass either
 * the mapped `PendingInputQuestion` (`allowFreeform`) or a normalized view of a
 * raw SDK `ChatInputQuestion` (`allowFreeformInput`).
 */

/** A typed AHP answer value (mirrors `ChatInputAnswerValue` from the protocol). */
export type AnswerValue =
  | { kind: "text"; value: string }
  | { kind: "number"; value: number }
  | { kind: "boolean"; value: boolean }
  | { kind: "selected"; value: string; freeformValues?: string[] }
  | { kind: "selected-many"; value: string[]; freeformValues?: string[] };

export interface AnswerOption {
  id: string;
  label: string;
  recommended?: boolean;
}

/** The minimal shape the builders need from a question. */
export interface AnswerQuestion {
  kind: string;
  options?: AnswerOption[];
  allowFreeform?: boolean;
}

export function parseBoolean(s: string): boolean | null {
  const v = s.trim().toLowerCase();
  if (/^(yes|y|true|enabled?|on|ok|sure|affirmative|approve)\b/.test(v)) return true;
  if (/^(no|n|false|disabled?|off|never|decline|reject)\b/.test(v)) return false;
  return null;
}

/**
 * Map a free-form answer onto the typed, question-specific answer value the AHP
 * host expects. Returns the value plus a human-readable label for the feed, or
 * `null` when the answer can't be confidently mapped (so the caller escalates
 * instead of submitting a malformed answer).
 */
export function buildAnswer(
  question: AnswerQuestion,
  answer: string,
): { value: AnswerValue; display: string } | null {
  switch (question.kind) {
    case "single-select": {
      const options = question.options ?? [];
      const lower = answer.toLowerCase();
      const matched =
        options.find((o) => o.label.toLowerCase() === lower || o.id.toLowerCase() === lower) ??
        options.find(
          (o) =>
            o.label.toLowerCase().includes(lower) || lower.includes(o.label.toLowerCase()),
        ) ??
        options.find((o) => o.recommended);
      // No confident option match → escalate (return null) rather than guess.
      // Delivering arbitrary prose into a select is `buildFreeformAnswer`'s job,
      // used only where free text is explicitly intended (the plan-decline path).
      if (!matched) return null;
      return { value: { kind: "selected", value: matched.id }, display: matched.label };
    }
    case "boolean": {
      const b = parseBoolean(answer);
      if (b === null) return null;
      return { value: { kind: "boolean", value: b }, display: b ? "Yes" : "No" };
    }
    case "number":
    case "integer": {
      const n = Number(answer.replace(/[^0-9.+-]/g, ""));
      if (!Number.isFinite(n)) return null;
      return { value: { kind: "number", value: n }, display: String(n) };
    }
    case "text": {
      return { value: { kind: "text", value: answer }, display: answer };
    }
    default:
      // multi-select (or unknown) — let a human handle it.
      return null;
  }
}

/**
 * Shape arbitrary prose into an answer value the given question can carry.
 *
 * Used to deliver a critique to whatever follow-up the agent surfaces after a
 * plan decline — a plain text input, or a select that permits free text
 * (`allowFreeform`). Returns `null` when the question cannot carry free text
 * (e.g. a select without freeform), so the caller keeps polling / escalates.
 */
export function buildFreeformAnswer(
  question: AnswerQuestion,
  feedback: string,
): AnswerValue | null {
  switch (question.kind) {
    case "text":
      return { kind: "text", value: feedback };
    case "single-select":
      return question.allowFreeform
        ? { kind: "selected", value: "", freeformValues: [feedback] }
        : null;
    case "multi-select":
      return question.allowFreeform
        ? { kind: "selected-many", value: [], freeformValues: [feedback] }
        : null;
    default:
      return null;
  }
}

/** True when a question can carry arbitrary free text as its answer. */
export function canCarryFreeform(question: AnswerQuestion): boolean {
  return buildFreeformAnswer(question, "probe") !== null;
}
