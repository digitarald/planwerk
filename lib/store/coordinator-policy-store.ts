import { create } from "zustand";

import {
  DEFAULT_COORDINATOR_MODE,
  COORDINATOR_MODE_META,
  isCoordinatorMode,
  type CoordinatorMode,
} from "@/lib/orchestrator/coordinator-mode";
import { useOrchestratorStore } from "@/lib/store/orchestrator-store";

const BOARD_TARGET = "board";

interface CoordinatorModePayload {
  defaultMode: CoordinatorMode;
  overrides: Record<string, CoordinatorMode>;
  effectiveModes: Record<string, CoordinatorMode>;
}

interface CoordinatorPolicyState extends CoordinatorModePayload {
  hostUrl: string | null;
  cardIds: string[];
  hydrated: boolean;
  hydrationError: string | null;
  pending: Record<string, boolean>;
  errors: Record<string, string | null>;
  hydrate: (hostUrl: string | null, cardIds: string[]) => Promise<void>;
  reset: () => void;
  setBoardMode: (mode: CoordinatorMode) => Promise<boolean>;
  setSessionMode: (
    hostUrl: string,
    cardId: string,
    mode: CoordinatorMode | null,
  ) => Promise<boolean>;
}

let hydrationGeneration = 0;
const targetGenerations = new Map<string, number>();

function beginTargetRequest(target: string): number {
  const generation = (targetGenerations.get(target) ?? 0) + 1;
  targetGenerations.set(target, generation);
  return generation;
}

function isCurrentTargetRequest(target: string, generation: number): boolean {
  return targetGenerations.get(target) === generation;
}

function targetForCard(cardId: string): string {
  return `session:${cardId}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : "Coordinator mode could not be saved.";
}

async function responseError(response: Response): Promise<Error> {
  try {
    const payload = (await response.json()) as { error?: unknown };
    if (typeof payload.error === "string" && payload.error.trim()) {
      return new Error(payload.error);
    }
  } catch {
    // Fall through to a stable message when the route did not return JSON.
  }
  return new Error(`Coordinator mode request failed (${response.status}).`);
}

function modeRecord(value: unknown): Record<string, CoordinatorMode> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result: Record<string, CoordinatorMode> = {};
  for (const [key, mode] of Object.entries(value)) {
    if (!isCoordinatorMode(mode)) return null;
    result[key] = mode;
  }
  return result;
}

/**
 * The local route returns persisted rows. The legacy map branch remains for
 * compatibility, but malformed or partial responses never become UI state.
 */
function normalizePayload(
  value: unknown,
  hostUrl: string | null,
): CoordinatorModePayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const payload = value as Record<string, unknown>;

  const boardDefault = payload.boardDefault;
  const defaultMode =
    boardDefault &&
    typeof boardDefault === "object" &&
    !Array.isArray(boardDefault) &&
    isCoordinatorMode((boardDefault as Record<string, unknown>).mode)
      ? (boardDefault as { mode: CoordinatorMode }).mode
      : null;
  if (
    defaultMode &&
    Array.isArray(payload.overrides) &&
    Array.isArray(payload.effectiveModes)
  ) {
    const overrides: Record<string, CoordinatorMode> = {};
    for (const row of payload.overrides) {
      if (!(
        row &&
        typeof row === "object" &&
        !Array.isArray(row) &&
        typeof (row as { hostUrl?: unknown }).hostUrl === "string" &&
        typeof (row as { cardId?: unknown }).cardId === "string" &&
        isCoordinatorMode((row as { mode?: unknown }).mode)
      )) {
        return null;
      }
      if (
        hostUrl !== null &&
        (row as { hostUrl: string }).hostUrl === hostUrl
      ) {
        overrides[(row as { cardId: string }).cardId] = (
          row as { mode: CoordinatorMode }
        ).mode;
      }
    }

    const effectiveModes: Record<string, CoordinatorMode> = {};
    for (const row of payload.effectiveModes) {
      if (!(
        row &&
        typeof row === "object" &&
        !Array.isArray(row) &&
        typeof (row as { hostUrl?: unknown }).hostUrl === "string" &&
        typeof (row as { cardId?: unknown }).cardId === "string" &&
        isCoordinatorMode((row as { mode?: unknown }).mode)
      )) {
        return null;
      }
      if (
        hostUrl !== null &&
        (row as { hostUrl: string }).hostUrl === hostUrl
      ) {
        effectiveModes[(row as { cardId: string }).cardId] = (
          row as { mode: CoordinatorMode }
        ).mode;
      }
    }
    return { defaultMode, overrides, effectiveModes };
  }

  if (isCoordinatorMode(payload.defaultMode)) {
    const overrides = modeRecord(payload.overrides);
    const effectiveModes = modeRecord(payload.effectiveModes);
    if (!overrides || !effectiveModes) return null;
    return { defaultMode: payload.defaultMode, overrides, effectiveModes };
  }

  return null;
}

function effectiveModesFor(
  cardIds: readonly string[],
  defaultMode: CoordinatorMode,
  overrides: Record<string, CoordinatorMode>,
  confirmed: Record<string, CoordinatorMode>,
): Record<string, CoordinatorMode> {
  return Object.fromEntries(
    cardIds.map((cardId) => [
      cardId,
      overrides[cardId] ?? confirmed[cardId] ?? defaultMode,
    ]),
  );
}

function pendingTargets(
  pending: Record<string, boolean>,
  targets: readonly string[],
  value: boolean,
): Record<string, boolean> {
  const next = { ...pending };
  for (const target of targets) {
    if (value) next[target] = true;
    else delete next[target];
  }
  return next;
}

export const useCoordinatorPolicyStore = create<CoordinatorPolicyState>()(
  (set, get) => ({
    defaultMode: DEFAULT_COORDINATOR_MODE,
    overrides: {},
    effectiveModes: {},
    hostUrl: null,
    cardIds: [],
    hydrated: false,
    hydrationError: null,
    pending: {},
    errors: {},

    reset: () => {
      hydrationGeneration++;
      targetGenerations.clear();
      set({
        defaultMode: DEFAULT_COORDINATOR_MODE,
        overrides: {},
        effectiveModes: {},
        hostUrl: null,
        cardIds: [],
        hydrated: false,
        hydrationError: null,
        pending: {},
        errors: {},
      });
    },

    hydrate: async (hostUrl, rawCardIds) => {
      const cardIds = [...new Set(rawCardIds)].sort();
      const generation = ++hydrationGeneration;
      set(() => ({
        defaultMode: DEFAULT_COORDINATOR_MODE,
        overrides: {},
        effectiveModes: Object.fromEntries(
          cardIds.map((cardId) => [cardId, DEFAULT_COORDINATOR_MODE]),
        ),
        hostUrl,
        cardIds,
        hydrated: false,
        hydrationError: null,
        errors: {},
      }));

      try {
        const search = new URLSearchParams();
        if (hostUrl) search.set("hostUrl", hostUrl);
        const response = await fetch(`/api/orchestrator/mode?${search}`);
        if (!response.ok) throw await responseError(response);
        const payload = normalizePayload(await response.json(), hostUrl);
        if (!payload) throw new Error("Coordinator mode response was invalid.");
        if (generation !== hydrationGeneration) return;

        const overrides = Object.fromEntries(
          cardIds.flatMap((cardId) =>
            payload.overrides[cardId]
              ? [[cardId, payload.overrides[cardId]]]
              : [],
          ),
        );
        set({
          defaultMode: payload.defaultMode,
          overrides,
          effectiveModes: effectiveModesFor(
            cardIds,
            payload.defaultMode,
            overrides,
            payload.effectiveModes,
          ),
          hydrated: true,
          hydrationError: null,
        });
      } catch (error) {
        if (generation !== hydrationGeneration) return;
        const message =
          error instanceof Error && error.message
            ? error.message
            : "Coordinator mode could not be loaded.";
        set(() => ({
          defaultMode: DEFAULT_COORDINATOR_MODE,
          overrides: {},
          effectiveModes: Object.fromEntries(
            cardIds.map((cardId) => [cardId, DEFAULT_COORDINATOR_MODE]),
          ),
          hydrated: false,
          hydrationError: message,
        }));
      }
    },

    setBoardMode: async (mode) => {
      const generation = beginTargetRequest(BOARD_TARGET);
      set((state) => ({
        pending: { ...state.pending, [BOARD_TARGET]: true },
        errors: { ...state.errors, [BOARD_TARGET]: null },
      }));
      try {
        const response = await fetch("/api/orchestrator/mode", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scope: "board", mode }),
        });
        if (!response.ok) throw await responseError(response);
        const state = get();
        const payload = normalizePayload(
          await response.json(),
          state.hostUrl,
        );
        if (!payload) throw new Error("Coordinator mode response was invalid.");
        if (!isCurrentTargetRequest(BOARD_TARGET, generation)) return false;
        hydrationGeneration++;

        const effectiveModes = effectiveModesFor(
          state.cardIds,
          payload.defaultMode,
          state.overrides,
          payload.effectiveModes,
        );
        set((current) => ({
          defaultMode: payload.defaultMode,
          effectiveModes,
          hydrated: true,
          hydrationError: null,
          pending: pendingTargets(current.pending, [BOARD_TARGET], false),
        }));
        useOrchestratorStore.getState().addFeedItem({
          type: "setting",
          message: `Board default changed to ${COORDINATOR_MODE_META[payload.defaultMode].label}.`,
        });
        return true;
      } catch (error) {
        if (!isCurrentTargetRequest(BOARD_TARGET, generation)) return false;
        set((state) => ({
          pending: pendingTargets(state.pending, [BOARD_TARGET], false),
          errors: { ...state.errors, [BOARD_TARGET]: errorMessage(error) },
        }));
        return false;
      }
    },

    setSessionMode: async (hostUrl, cardId, mode) => {
      const target = targetForCard(cardId);
      const generation = beginTargetRequest(target);
      set((state) => ({
        pending: { ...state.pending, [target]: true },
        errors: { ...state.errors, [target]: null },
      }));
      try {
        const response = await fetch("/api/orchestrator/mode", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scope: "session", hostUrl, cardId, mode }),
        });
        if (!response.ok) throw await responseError(response);
        const payload = normalizePayload(await response.json(), hostUrl);
        if (!payload) throw new Error("Coordinator mode response was invalid.");
        if (!isCurrentTargetRequest(target, generation)) return false;
        hydrationGeneration++;

        const confirmedOverride = payload.overrides[cardId];
        const state = get();
        const overrides = { ...state.overrides };
        if (confirmedOverride) overrides[cardId] = confirmedOverride;
        else delete overrides[cardId];
        const effectiveMode =
          payload.effectiveModes[cardId] ??
          confirmedOverride ??
          payload.defaultMode;

        set((current) => ({
          defaultMode: payload.defaultMode,
          overrides,
          effectiveModes: {
            ...current.effectiveModes,
            [cardId]: effectiveMode,
          },
          hydrated: true,
          hydrationError: null,
          pending: pendingTargets(current.pending, [target], false),
        }));
        useOrchestratorStore.getState().addFeedItem({
          type: "setting",
          message: confirmedOverride
            ? `Session override changed to ${COORDINATOR_MODE_META[confirmedOverride].label}.`
            : `Session now inherits the board default (${COORDINATOR_MODE_META[effectiveMode].label}).`,
          cardId,
        });
        return true;
      } catch (error) {
        if (!isCurrentTargetRequest(target, generation)) return false;
        set((state) => ({
          pending: pendingTargets(state.pending, [target], false),
          errors: { ...state.errors, [target]: errorMessage(error) },
        }));
        return false;
      }
    },
  }),
);

export function useBoardCoordinatorPolicy() {
  const hydrated = useCoordinatorPolicyStore((state) => state.hydrated);
  const hydrationError = useCoordinatorPolicyStore(
    (state) => state.hydrationError,
  );
  const defaultMode = useCoordinatorPolicyStore((state) =>
    state.hydrated ? state.defaultMode : DEFAULT_COORDINATOR_MODE,
  );
  const pending = useCoordinatorPolicyStore(
    (state) => state.pending[BOARD_TARGET] === true,
  );
  const error = useCoordinatorPolicyStore(
    (state) => state.errors[BOARD_TARGET] ?? state.hydrationError,
  );
  const setMode = useCoordinatorPolicyStore((state) => state.setBoardMode);
  return {
    defaultMode,
    hydrated,
    hydrationError,
    pending,
    error,
    setMode,
  };
}

export function useCoordinatorPolicy(cardId: string) {
  const hydrated = useCoordinatorPolicyStore((state) => state.hydrated);
  const hydrationError = useCoordinatorPolicyStore(
    (state) => state.hydrationError,
  );
  const defaultMode = useCoordinatorPolicyStore((state) =>
    state.hydrated ? state.defaultMode : DEFAULT_COORDINATOR_MODE,
  );
  const effectiveMode = useCoordinatorPolicyStore(
    (state) =>
      state.hydrated
        ? state.effectiveModes[cardId] ?? state.defaultMode
        : DEFAULT_COORDINATOR_MODE,
  );
  const override = useCoordinatorPolicyStore(
    (state) => (state.hydrated ? state.overrides[cardId] ?? null : null),
  );
  const pending = useCoordinatorPolicyStore(
    (state) => state.pending[targetForCard(cardId)] === true,
  );
  const mutationError = useCoordinatorPolicyStore(
    (state) => state.errors[targetForCard(cardId)] ?? null,
  );
  const error = mutationError ?? hydrationError;
  const setMode = useCoordinatorPolicyStore((state) => state.setSessionMode);
  return {
    defaultMode,
    effectiveMode,
    override,
    hydrated,
    hydrationError,
    pending,
    error,
    mutationError,
    setMode,
  };
}
