"use client";

import { useState } from "react";
import { Check, Loader2, X, Sparkles, Play, Eye, HelpCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useConnectionStore } from "@/lib/store/connection-store";
import type { PendingInput, PendingInputQuestion } from "@/lib/types";
import { cn } from "@/lib/utils";

interface PendingInputCardProps {
  cardId: string;
  input: PendingInput;
}

type SubmitState = "idle" | "submitting" | "done" | "stale" | "error";

async function submitInputResponse(
  hostUrl: string,
  sessionUri: string,
  requestId: string,
  response: "accept" | "decline" | "cancel",
  answers?: Record<string, unknown>
): Promise<{ inputRemoved: boolean; activeClient: boolean }> {
  const res = await fetch("/api/ahp/sessions/input", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hostUrl, sessionUri, requestId, response, answers }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "Failed to submit");
  }
  return res.json();
}

/** Map common option labels to icons for the plan approval picker */
function getOptionIcon(label: string): typeof Play | null {
  const lower = label.toLowerCase();
  if (lower.includes("autopilot")) return Sparkles;
  if (lower.includes("implement")) return Play;
  if (lower.includes("approve") || lower.includes("review")) return Eye;
  return null;
}

function SingleSelectQuestion({
  question,
  onSelect,
  disabled,
}: {
  question: PendingInputQuestion;
  onSelect: (optionId: string) => void;
  disabled: boolean;
}) {
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [showHints, setShowHints] = useState(false);
  const options = question.options ?? [];

  // Check if any options have hints to show the help toggle
  const hasHints = options.some(opt => {
    if (opt.description) return true;
    const match = opt.label.match(/\(([^)]+)\)/);
    return match && !opt.recommended;
  });

  return (
    <div className="space-y-2">
      <div className="flex items-start gap-1">
        <p className="flex-1 text-[11px] font-medium text-foreground/90 leading-snug">
          {question.message}
        </p>
        {hasHints && (
          <button
            type="button"
            className={cn(
              "shrink-0 rounded-full p-0.5 transition-colors",
              showHints
                ? "text-primary bg-primary/10"
                : "text-muted-foreground/50 hover:text-muted-foreground hover:bg-muted"
            )}
            onClick={(e) => {
              e.stopPropagation();
              setShowHints(!showHints);
            }}
            title={showHints ? "Hide details" : "Show details"}
          >
            <HelpCircle className="h-3 w-3" />
          </button>
        )}
      </div>
      <div className="flex flex-col gap-1">
        {options.map((opt) => {
          const Icon = getOptionIcon(opt.label);
          // Clean up label: strip "(Recommended" suffix since we show it visually
          const cleanLabel = opt.recommended
            ? opt.label.replace(/\s*\(Recommended[^)]*\)/i, "").trim()
            : opt.label;
          // Extract parenthetical as description hint
          const parenMatch = cleanLabel.match(/\(([^)]+)\)/);
          const hint = opt.description || (parenMatch ? parenMatch[1] : null);
          const displayLabel = cleanLabel.replace(/\s*\([^)]*\)/, "").trim() || cleanLabel;

          return (
            <button
              key={opt.id}
              disabled={disabled}
              className={cn(
                "group relative inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[11px] font-medium transition-all duration-150 text-left",
                "border",
                "disabled:opacity-50 disabled:cursor-not-allowed",
                opt.recommended
                  ? "border-primary/50 bg-primary text-primary-foreground shadow-sm shadow-primary/20 hover:bg-primary/90 hover:shadow-md hover:shadow-primary/25"
                  : "border-border bg-background text-foreground hover:border-primary/30 hover:bg-primary/5 hover:shadow-sm"
              )}
              onMouseEnter={() => setHoveredId(opt.id)}
              onMouseLeave={() => setHoveredId(null)}
              onClick={(e) => {
                e.stopPropagation();
                onSelect(opt.id);
              }}
            >
              {Icon && <Icon className={cn(
                "h-3 w-3 shrink-0 transition-transform duration-150",
                hoveredId === opt.id && "scale-110"
              )} />}
              <span className="flex-1 min-w-0">
                {displayLabel}
                {showHints && hint && (
                  <span className={cn(
                    "ml-1 text-[10px] font-normal animate-in fade-in duration-150",
                    opt.recommended ? "text-primary-foreground/70" : "text-muted-foreground"
                  )}>
                    — {hint}
                  </span>
                )}
              </span>
              {opt.recommended && (
                <span className="ml-auto shrink-0 rounded bg-primary-foreground/20 px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-primary-foreground/90">
                  ★
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function TextQuestion({
  question,
  onSubmit,
  disabled,
}: {
  question: PendingInputQuestion;
  onSubmit: (value: string) => void;
  disabled: boolean;
}) {
  const [value, setValue] = useState(
    (question.defaultValue as string) ?? ""
  );

  return (
    <div className="space-y-1.5">
      <p className="text-[11px] font-medium text-foreground/90 leading-snug">
        {question.message}
      </p>
      <div className="flex gap-1">
        <Input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          disabled={disabled}
          className="h-6 text-[11px] flex-1 rounded-md"
          placeholder="Type your answer…"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter" && value.trim()) {
              onSubmit(value.trim());
            }
          }}
        />
        <Button
          size="sm"
          variant="default"
          disabled={disabled || !value.trim()}
          className="h-6 w-6 p-0 rounded-md"
          onClick={(e) => {
            e.stopPropagation();
            if (value.trim()) onSubmit(value.trim());
          }}
        >
          <Check className="h-3 w-3" />
        </Button>
      </div>
    </div>
  );
}

function BooleanQuestion({
  question,
  onSelect,
  disabled,
}: {
  question: PendingInputQuestion;
  onSelect: (value: boolean) => void;
  disabled: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <p className="text-[11px] font-medium text-foreground/90 leading-snug">
        {question.message}
      </p>
      <div className="flex gap-1.5">
        <button
          disabled={disabled}
          className="inline-flex items-center gap-1 rounded-md border border-primary/40 bg-primary px-2.5 py-1 text-[10px] font-medium text-primary-foreground shadow-sm transition-all hover:bg-primary/90 hover:shadow-md disabled:opacity-50"
          onClick={(e) => {
            e.stopPropagation();
            onSelect(true);
          }}
        >
          <Check className="h-3 w-3" />
          Yes
        </button>
        <button
          disabled={disabled}
          className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2.5 py-1 text-[10px] font-medium text-foreground shadow-sm transition-all hover:border-primary/30 hover:bg-primary/5 hover:shadow-md disabled:opacity-50"
          onClick={(e) => {
            e.stopPropagation();
            onSelect(false);
          }}
        >
          <X className="h-3 w-3" />
          No
        </button>
      </div>
    </div>
  );
}

export function PendingInputCard({ cardId, input }: PendingInputCardProps) {
  const [submitState, setSubmitState] = useState<SubmitState>("idle");
  const hostUrl = useConnectionStore((s) => s.hostUrl);
  const question = input.questions[0];

  // Determine if we can handle this input inline
  const supportedKinds = ["single-select", "text", "boolean"];
  const isActionable =
    input.questions.length <= 1 &&
    (!question || supportedKinds.includes(question.kind));

  const handleSubmit = async (
    response: "accept" | "decline" | "cancel",
    answers?: Record<string, unknown>
  ) => {
    if (!hostUrl) return;
    setSubmitState("submitting");
    try {
      const result = await submitInputResponse(hostUrl, cardId, input.requestId, response, answers);
      if (result.inputRemoved) {
        setSubmitState("done");
      } else {
        // Input dispatched but host didn't apply it (session may be stale)
        setSubmitState("stale");
      }
    } catch {
      setSubmitState("error");
      setTimeout(() => setSubmitState("idle"), 3000);
    }
  };

  const handleSelectOption = (questionId: string, optionId: string) => {
    handleSubmit("accept", {
      [questionId]: {
        state: "submitted",
        value: { kind: "selected", value: optionId },
      },
    });
  };

  const handleTextAnswer = (questionId: string, text: string) => {
    handleSubmit("accept", {
      [questionId]: {
        state: "submitted",
        value: { kind: "text", value: text },
      },
    });
  };

  const handleBooleanAnswer = (questionId: string, value: boolean) => {
    handleSubmit("accept", {
      [questionId]: {
        state: "submitted",
        value: { kind: "boolean", value },
      },
    });
  };

  if (submitState === "submitting") {
    return (
      <div className="mt-1.5 flex items-center gap-2 rounded-lg border border-primary/20 bg-primary/5 px-2.5 py-2 dark:bg-primary/10">
        <Loader2 className="h-3 w-3 animate-spin text-primary" />
        <p className="text-[11px] font-medium text-primary">
          Sending response…
        </p>
      </div>
    );
  }

  if (submitState === "done") {
    return (
      <div className="mt-1.5 flex items-center gap-2 rounded-lg border border-green-200/80 bg-green-50/50 px-2.5 py-2 dark:border-green-800/30 dark:bg-green-950/20">
        <Check className="h-3 w-3 text-green-600 dark:text-green-400" />
        <p className="text-[11px] font-medium text-green-700 dark:text-green-300">
          Response sent
        </p>
      </div>
    );
  }

  if (submitState === "stale") {
    return (
      <div className="mt-1.5 flex items-center gap-2 rounded-lg border border-amber-200/80 bg-amber-50/50 px-2.5 py-2 dark:border-amber-800/30 dark:bg-amber-950/20">
        <HelpCircle className="h-3 w-3 text-amber-600 dark:text-amber-400" />
        <p className="text-[11px] font-medium text-amber-700 dark:text-amber-300">
          Session needs attention in VS Code
        </p>
      </div>
    );
  }

  if (submitState === "error") {
    return (
      <div className="mt-1.5 flex items-center gap-2 rounded-lg border border-destructive/20 bg-destructive/5 px-2.5 py-2">
        <X className="h-3 w-3 text-destructive" />
        <p className="text-[11px] font-medium text-destructive">
          Failed — try again
        </p>
      </div>
    );
  }

  // No questions — show message only with accept/decline
  if (!question) {
    return (
      <div className="mt-1.5 space-y-2 rounded-lg border border-amber-200/80 bg-gradient-to-b from-amber-50/80 to-amber-50/40 px-2.5 py-2 dark:border-amber-800/30 dark:from-amber-950/20 dark:to-amber-950/10">
        {input.message && (
          <p className="text-[11px] font-medium text-amber-900 dark:text-amber-200 leading-snug">
            {input.message}
          </p>
        )}
        <div className="flex gap-1.5">
          <button
            className="inline-flex items-center gap-1 rounded-md border border-primary/40 bg-primary px-2.5 py-1 text-[10px] font-medium text-primary-foreground shadow-sm transition-all hover:bg-primary/90 hover:shadow-md"
            onClick={(e) => {
              e.stopPropagation();
              handleSubmit("accept");
            }}
          >
            <Check className="h-3 w-3" />
            Accept
          </button>
          <button
            className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2.5 py-1 text-[10px] font-medium text-foreground shadow-sm transition-all hover:border-primary/30 hover:bg-primary/5 hover:shadow-md"
            onClick={(e) => {
              e.stopPropagation();
              handleSubmit("decline");
            }}
          >
            Decline
          </button>
        </div>
      </div>
    );
  }

  // Non-actionable: multi-question or unsupported kind — show message only
  if (!isActionable) {
    return (
      <div className="mt-1.5 space-y-1 rounded-lg border border-amber-200/80 bg-gradient-to-b from-amber-50/80 to-amber-50/40 px-2.5 py-2 dark:border-amber-800/30 dark:from-amber-950/20 dark:to-amber-950/10">
        <p className="text-[11px] font-medium text-amber-900 dark:text-amber-200 leading-snug">
          {input.message || question.message}
        </p>
        <p className="text-[10px] text-muted-foreground">
          Open in editor to respond
        </p>
      </div>
    );
  }

  return (
    <div
      className="mt-1.5 space-y-1.5 rounded-lg border border-amber-200/80 bg-gradient-to-b from-amber-50/80 to-amber-50/40 px-2.5 py-2 dark:border-amber-800/30 dark:from-amber-950/20 dark:to-amber-950/10"
    >
      {/* Show top-level message if different from question message */}
      {input.message && input.message !== question.message && (
        <p className="text-[10px] text-muted-foreground leading-snug">
          {input.message}
        </p>
      )}

      {question.kind === "single-select" && (
        <SingleSelectQuestion
          question={question}
          onSelect={(optionId) => handleSelectOption(question.id, optionId)}
          disabled={false}
        />
      )}

      {question.kind === "text" && (
        <TextQuestion
          question={question}
          onSubmit={(text) => handleTextAnswer(question.id, text)}
          disabled={false}
        />
      )}

      {question.kind === "boolean" && (
        <BooleanQuestion
          question={question}
          onSelect={(value) => handleBooleanAnswer(question.id, value)}
          disabled={false}
        />
      )}
    </div>
  );
}
