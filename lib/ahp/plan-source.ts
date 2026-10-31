import { createHash } from "node:crypto";

export interface PlanSource {
  sessionUri: string;
  uri: string;
  chatUri?: string;
  turnId?: string;
  requestId?: string;
}

export interface PlanEvidence {
  content: string;
  changesetRef: string;
  source: PlanSource;
}

export interface PlanReviewInput {
  questionId: string;
  actionIds: string[];
  planUri?: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

export function isPlanReviewRequest(request: unknown): boolean {
  const value = record(request);
  return Boolean(value && (Object.hasOwn(value, "planReview")
    || record(value._meta)?.purpose === "planReview"));
}

export function readPlanReviewInput(request: unknown): PlanReviewInput | null {
  const review = record(record(request)?.planReview);
  if (!review || typeof review.answerQuestionId !== "string"
    || !review.answerQuestionId.trim() || !Array.isArray(review.actions)
    || review.actions.length === 0
    || (review.planUri !== undefined && typeof review.planUri !== "string")) return null;
  const actionIds: string[] = [];
  for (const action of review.actions) {
    const id = record(action)?.id;
    if (typeof id !== "string" || !id.trim() || actionIds.includes(id)) return null;
    actionIds.push(id);
  }
  return {
    questionId: review.answerQuestionId,
    actionIds,
    planUri: typeof review.planUri === "string" ? review.planUri : undefined,
  };
}

export function isPlanSource(value: unknown, sessionUri: string): value is PlanSource {
  const source = record(value);
  if (!source || source.sessionUri !== sessionUri
    || typeof source.uri !== "string" || !source.uri.trim()) return false;
  for (const key of ["chatUri", "turnId", "requestId"]) {
    if (source[key] !== undefined && (typeof source[key] !== "string" || !source[key].trim())) return false;
  }
  return source.requestId === undefined || (source.chatUri !== undefined && source.turnId !== undefined);
}

export function hashPlanContent(content: string): string {
  return `plan:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}
