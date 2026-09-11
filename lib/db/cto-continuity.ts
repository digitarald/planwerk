import "server-only";

import { randomUUID } from "node:crypto";

import { CtoContinuityStore } from "./cto-continuity-store";
import { getDb } from "./schema";

export type {
  ApprovalStatus,
  CtoApproval,
  CtoApprovalRequest,
  CtoApprovalBinding,
  CtoSessionRecord,
  ToolExecutionClaim,
} from "./cto-continuity-store";
export {
  hashCtoAction,
  stableJson,
} from "./cto-continuity-store";

const processOwnerId = randomUUID();

export function getCtoContinuityStore(): CtoContinuityStore {
  return new CtoContinuityStore(getDb(), Date.now, {
    ownerId: processOwnerId,
  });
}
