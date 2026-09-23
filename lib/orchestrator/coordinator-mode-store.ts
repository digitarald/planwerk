import { getCoordinatorModeStore } from "../db/coordinator-mode";
import type {
  CoordinatorBoardMode,
  CoordinatorSessionMode,
} from "../db/coordinator-mode-store";
import type { CoordinatorMode } from "./coordinator-mode";

export type CoordinatorDefaultModeRecord = CoordinatorBoardMode;
export type CoordinatorSessionOverrideRecord = CoordinatorSessionMode;

export function getCoordinatorDefaultMode(): CoordinatorMode {
  return getCoordinatorModeStore().getBoardDefault().mode;
}

export function getCoordinatorSessionOverride(
  hostUrl: string,
  cardId: string,
): CoordinatorMode | null {
  return getCoordinatorModeStore().getSessionOverride(hostUrl, cardId)?.mode ??
    null;
}

export function getEffectiveCoordinatorMode(
  hostUrl: string,
  cardId: string,
): CoordinatorMode {
  return getCoordinatorModeStore().getEffectiveMode(hostUrl, cardId).mode;
}

export function setCoordinatorDefaultMode(
  mode: CoordinatorMode,
): CoordinatorDefaultModeRecord {
  return getCoordinatorModeStore().setBoardDefault(mode);
}

export function setCoordinatorSessionOverride(
  hostUrl: string,
  cardId: string,
  mode: CoordinatorMode | null,
): CoordinatorSessionOverrideRecord | null {
  return getCoordinatorModeStore().setSessionOverride(hostUrl, cardId, mode);
}
