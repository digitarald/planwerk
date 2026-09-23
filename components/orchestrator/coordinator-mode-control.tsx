"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  Bot,
  Eye,
  Loader2,
  RadioTower,
  ShieldCheck,
} from "lucide-react";

import {
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  COORDINATOR_MODES,
  COORDINATOR_MODE_META,
  type CoordinatorMode,
} from "@/lib/orchestrator/coordinator-mode";
import {
  useBoardCoordinatorPolicy,
  useCoordinatorPolicy,
  useCoordinatorPolicyStore,
} from "@/lib/store/coordinator-policy-store";
import { useConnectionStore } from "@/lib/store/connection-store";
import { cn } from "@/lib/utils";

const modeIcons = {
  observe: Eye,
  verify: ShieldCheck,
  coordinate: RadioTower,
} satisfies Record<CoordinatorMode, typeof Eye>;

interface ConfirmationProps {
  open: boolean;
  scope: "board" | "session";
  cardTitle?: string;
  pending: boolean;
  error: string | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}

export function CoordinatorModeConfirmationDialog({
  open,
  scope,
  cardTitle,
  pending,
  error,
  onOpenChange,
  onConfirm,
}: ConfirmationProps) {
  const cancelButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open || pending) return;
    const timeout = window.setTimeout(() => cancelButtonRef.current?.focus(), 0);
    return () => window.clearTimeout(timeout);
  }, [open, pending]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        initialFocus={() => cancelButtonRef.current}
        showCloseButton={!pending}
      >
        <DialogHeader>
          <DialogTitle>
            {scope === "board"
              ? "Allow board-wide coordination?"
              : `Allow coordination for “${cardTitle ?? "this session"}”?`}
          </DialogTitle>
          <DialogDescription className="space-y-2 leading-5">
            <span className="block">
              {scope === "board"
                ? "This lets the coordinator message sessions, respond to low-risk inputs, and advance cards after every required gate passes. Sessions with an override keep their own mode."
                : "This lets the coordinator message this session, respond to low-risk inputs, and advance its card after every required gate passes."}
            </span>
            <span className="block font-medium text-foreground/80">
              Required gates still apply. You can change this mode at any time.
            </span>
          </DialogDescription>
        </DialogHeader>
        {error && (
          <p
            role="alert"
            className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive"
          >
            {error}
          </p>
        )}
        <DialogFooter>
          <DialogClose
            disabled={pending}
            render={
              <Button ref={cancelButtonRef} variant="outline" autoFocus />
            }
          >
            Cancel
          </DialogClose>
          <Button disabled={pending} onClick={onConfirm}>
            {pending ? (
              <Loader2 className="animate-spin" aria-hidden="true" />
            ) : (
              <RadioTower aria-hidden="true" />
            )}
            {pending ? "Applying…" : "Enable Coordinate"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function BoardCoordinatorModeControl() {
  const { defaultMode: confirmedMode, hydrated, pending, error, setMode } =
    useBoardCoordinatorPolicy();
  const retryHydration = useCoordinatorPolicyStore((state) => state.hydrate);
  const policyHostUrl = useCoordinatorPolicyStore((state) => state.hostUrl);
  const policyCardIds = useCoordinatorPolicyStore((state) => state.cardIds);
  const [proposedMode, setProposedMode] = useState<CoordinatorMode | null>(
    null,
  );

  const requestMode = (mode: CoordinatorMode) => {
    if (mode === confirmedMode || pending) return;
    if (mode === "coordinate" && confirmedMode !== "coordinate") {
      setProposedMode(mode);
      return;
    }
    void setMode(mode);
  };

  const handleConfirmationOpenChange = (open: boolean) => {
    if (!open && !pending) setProposedMode(null);
  };

  const confirmCoordinate = async () => {
    if (proposedMode !== "coordinate") return;
    const saved = await setMode(proposedMode);
    if (saved) setProposedMode(null);
  };

  const handleModeKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    mode: CoordinatorMode,
  ) => {
    if (!hydrated || pending) {
      event.preventDefault();
      return;
    }

    const currentIndex = COORDINATOR_MODES.indexOf(mode);
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      nextIndex = (currentIndex + 1) % COORDINATOR_MODES.length;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      nextIndex =
        (currentIndex - 1 + COORDINATOR_MODES.length) %
        COORDINATOR_MODES.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = COORDINATOR_MODES.length - 1;
    }
    if (nextIndex === null) return;

    event.preventDefault();
    const nextMode = COORDINATOR_MODES[nextIndex];
    requestMode(nextMode);
    if (nextMode !== "coordinate" || confirmedMode === "coordinate") {
      document.getElementById(`board-coordinator-mode-${nextMode}`)?.focus();
    }
  };

  return (
    <>
      <section aria-labelledby="coordinator-mode-label" className="pt-1">
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <span
            id="coordinator-mode-label"
            className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground"
          >
            <Bot className="h-3.5 w-3.5" aria-hidden="true" />
            Coordinator mode
          </span>
          {!hydrated && !error && (
            <span className="text-[9px] text-muted-foreground">
              Loading…
            </span>
          )}
        </div>
        <div
          role="radiogroup"
          aria-labelledby="coordinator-mode-label"
          aria-describedby="coordinator-mode-description"
          aria-busy={pending}
          className="grid grid-cols-3 rounded-md border border-border/80 bg-background p-0.5"
        >
          {COORDINATOR_MODES.map((mode) => {
            const Icon = modeIcons[mode];
            const selected = hydrated && mode === confirmedMode;
            return (
              <button
                key={mode}
                id={`board-coordinator-mode-${mode}`}
                type="button"
                role="radio"
                aria-checked={selected}
                aria-disabled={!hydrated || pending}
                disabled={!hydrated}
                tabIndex={selected ? 0 : -1}
                onClick={() => requestMode(mode)}
                onKeyDown={(event) => handleModeKeyDown(event, mode)}
                title={COORDINATOR_MODE_META[mode].description}
                className={cn(
                  "flex h-7 items-center justify-center gap-1 rounded px-1 text-[11px] font-medium transition-colors duration-150 aria-disabled:cursor-wait aria-disabled:opacity-60",
                  selected
                    ? "bg-primary/12 text-primary shadow-xs"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                {pending && selected ? (
                  <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                ) : (
                  <Icon className="h-3 w-3" aria-hidden="true" />
                )}
                {COORDINATOR_MODE_META[mode].label}
              </button>
            );
          })}
        </div>
        <p
          id="coordinator-mode-description"
          aria-live="polite"
          className="mt-1.5 text-[11px] leading-4 text-muted-foreground"
        >
          {hydrated
            ? COORDINATOR_MODE_META[confirmedMode].shortDescription
            : error
              ? "Coordinator mode unavailable. The existing server setting remains in effect."
              : "Loading coordinator authority…"}
        </p>
        {error && (
          <div className="mt-1 flex items-start justify-between gap-2">
            <p role="alert" className="text-[10px] leading-4 text-destructive">
              {error}
            </p>
            {!hydrated && (
              <button
                type="button"
                disabled={pending}
                onClick={() =>
                  void retryHydration(policyHostUrl, policyCardIds)
                }
                className="shrink-0 text-[10px] font-medium text-primary hover:underline disabled:opacity-50"
              >
                Retry
              </button>
            )}
          </div>
        )}
      </section>
      <CoordinatorModeConfirmationDialog
        open={proposedMode === "coordinate"}
        scope="board"
        pending={pending}
        error={error}
        onOpenChange={handleConfirmationOpenChange}
        onConfirm={() => void confirmCoordinate()}
      />
    </>
  );
}

interface SessionCoordinatorProps {
  cardId: string;
  cardTitle: string;
}

export function SessionCoordinatorModeControl({
  cardId,
  cardTitle,
}: SessionCoordinatorProps) {
  const hostUrl = useConnectionStore((state) => state.hostUrl);
  const {
    defaultMode: confirmedDefaultMode,
    effectiveMode: confirmedEffectiveMode,
    override: confirmedOverride,
    hydrated,
    pending,
    error,
    setMode,
  } = useCoordinatorPolicy(cardId);
  const [proposal, setProposal] = useState<{
    mode: CoordinatorMode | null;
  } | null>(
    null,
  );

  const applyMode = async (mode: CoordinatorMode | null) => {
    if (!hostUrl) return false;
    return setMode(hostUrl, cardId, mode);
  };

  const requestMode = (mode: CoordinatorMode | null) => {
    if (pending || mode === confirmedOverride) return;
    const nextEffective = mode ?? confirmedDefaultMode;
    if (
      nextEffective === "coordinate" &&
      confirmedEffectiveMode !== "coordinate"
    ) {
      setProposal({ mode });
      return;
    }
    void applyMode(mode);
  };

  const handleConfirmationOpenChange = (open: boolean) => {
    if (!open && !pending) setProposal(null);
  };

  const confirmCoordinate = async () => {
    if (!proposal) return;
    const saved = await applyMode(proposal.mode);
    if (saved) setProposal(null);
  };

  return (
    <>
      <div className="flex flex-wrap items-center gap-1.5">
        <label
          htmlFor={`coordinator-mode-${cardId}`}
          className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground"
        >
          <Bot className="h-3 w-3" aria-hidden="true" />
          Coordinator
        </label>
        <select
          id={`coordinator-mode-${cardId}`}
          value={confirmedOverride ?? "inherit"}
          disabled={!hostUrl || !hydrated || pending}
          onChange={(event) =>
            requestMode(
              event.target.value === "inherit"
                ? null
                : (event.target.value as CoordinatorMode),
            )
          }
          className="h-6 rounded-md border border-border bg-background px-1.5 text-[11px] font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary/50 disabled:opacity-50"
          aria-describedby={`coordinator-mode-source-${cardId}`}
        >
          <option value="inherit">
            {`Inherit board default (${COORDINATOR_MODE_META[confirmedDefaultMode].label})`}
          </option>
          {COORDINATOR_MODES.map((mode) => (
            <option key={mode} value={mode}>
              {COORDINATOR_MODE_META[mode].label}
            </option>
          ))}
        </select>
        {pending && (
          <Loader2
            className="h-3 w-3 animate-spin text-muted-foreground"
            aria-label="Saving coordinator mode"
          />
        )}
        <span
          id={`coordinator-mode-source-${cardId}`}
          className="text-[10px] text-muted-foreground"
        >
          {confirmedOverride
            ? `Session override · effective ${COORDINATOR_MODE_META[confirmedEffectiveMode].label}`
            : "Board default"}
        </span>
      </div>
      {error && (
        <p role="alert" className="mt-1 text-[10px] text-destructive">
          {error}
        </p>
      )}
      <CoordinatorModeConfirmationDialog
        open={proposal !== null}
        scope="session"
        cardTitle={cardTitle}
        pending={pending}
        error={error}
        onOpenChange={handleConfirmationOpenChange}
        onConfirm={() => void confirmCoordinate()}
      />
    </>
  );
}

export function CoordinatorModeContextMenu({
  cardId,
  cardTitle,
}: SessionCoordinatorProps) {
  const hostUrl = useConnectionStore((state) => state.hostUrl);
  const {
    defaultMode: confirmedDefaultMode,
    effectiveMode: confirmedEffectiveMode,
    override: confirmedOverride,
    hydrated,
    pending,
    error,
    setMode,
  } =
    useCoordinatorPolicy(cardId);
  const [proposal, setProposal] = useState<{
    mode: CoordinatorMode | null;
  } | null>(
    null,
  );

  const applyMode = async (mode: CoordinatorMode | null) => {
    if (!hostUrl) return false;
    return setMode(hostUrl, cardId, mode);
  };

  const requestMode = (value: string) => {
    const mode = value === "inherit" ? null : (value as CoordinatorMode);
    if (mode === confirmedOverride || pending) return;
    const nextEffective = mode ?? confirmedDefaultMode;
    if (
      nextEffective === "coordinate" &&
      confirmedEffectiveMode !== "coordinate"
    ) {
      setProposal({ mode });
      return;
    }
    void applyMode(mode);
  };

  const handleConfirmationOpenChange = (open: boolean) => {
    if (!open && !pending) setProposal(null);
  };

  const confirmCoordinate = async () => {
    if (!proposal) return;
    const saved = await applyMode(proposal.mode);
    if (saved) setProposal(null);
  };

  return (
    <>
      <ContextMenuSub>
        <ContextMenuSubTrigger disabled={!hostUrl || !hydrated || pending}>
          {pending ? (
            <Loader2 className="animate-spin" aria-hidden="true" />
          ) : (
            <Bot aria-hidden="true" />
          )}
          Coordinator mode
        </ContextMenuSubTrigger>
        <ContextMenuSubContent>
          <ContextMenuRadioGroup
            value={confirmedOverride ?? "inherit"}
            onValueChange={requestMode}
          >
            <ContextMenuRadioItem value="inherit" closeOnClick>
              {`Inherit board default (${COORDINATOR_MODE_META[confirmedDefaultMode].label})`}
            </ContextMenuRadioItem>
            {COORDINATOR_MODES.map((mode) => (
              <ContextMenuRadioItem key={mode} value={mode} closeOnClick>
                {COORDINATOR_MODE_META[mode].label}
              </ContextMenuRadioItem>
            ))}
          </ContextMenuRadioGroup>
        </ContextMenuSubContent>
      </ContextMenuSub>
      <CoordinatorModeConfirmationDialog
        open={proposal !== null}
        scope="session"
        cardTitle={cardTitle}
        pending={pending}
        error={error}
        onOpenChange={handleConfirmationOpenChange}
        onConfirm={() => void confirmCoordinate()}
      />
    </>
  );
}

export function CoordinatorOverrideMarker({ cardId }: { cardId: string }) {
  const { override, mutationError } = useCoordinatorPolicy(cardId);
  if (!override && !mutationError) return null;

  if (mutationError) {
    return (
      <>
        <span aria-hidden="true" className="text-muted-foreground/45"> · </span>
        <span role="alert" className="text-[9px] font-medium text-destructive">
          Mode not saved
        </span>
      </>
    );
  }
  if (!override) return null;
  const Icon = modeIcons[override];

  return (
    <>
      <span aria-hidden="true" className="text-muted-foreground/45"> · </span>
      <span
        className="inline-flex shrink-0 items-center gap-0.5 text-[9px] font-medium text-muted-foreground/70"
        title={`Coordinator override: ${COORDINATOR_MODE_META[override].label}`}
      >
        <Icon className="h-2.5 w-2.5" aria-hidden="true" />
        {COORDINATOR_MODE_META[override].label}
      </span>
    </>
  );
}
