import "server-only";

import { CoordinatorModeStore } from "./coordinator-mode-store";
import { getDb } from "./schema";

export type {
  CoordinatorBoardMode,
  CoordinatorModeAudit,
  CoordinatorSessionMode,
  EffectiveCoordinatorMode,
} from "./coordinator-mode-store";

export function getCoordinatorModeStore(): CoordinatorModeStore {
  return new CoordinatorModeStore(getDb());
}
