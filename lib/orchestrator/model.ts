import "server-only";

/**
 * The model used for all orchestrator LLM calls (risk triage, coherence review,
 * auto-answer, orchestrator chat). Centralized so a model rename is a one-line
 * change instead of a hunt across subsystems. Override with `ORCHESTRATOR_MODEL`.
 */
export const ORCHESTRATOR_MODEL = process.env.ORCHESTRATOR_MODEL ?? "gpt-5.4-mini";
