"use client";

import { useState } from "react";
import { Check, Loader2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useConnectionStore } from "@/lib/store/connection-store";
import type { PendingInput, PendingInputQuestion } from "@/lib/types";

interface PendingInputCardProps {
  cardId: string;
  input: PendingInput;
}

type SubmitState = "idle" | "submitting" | "error";

async function submitInputResponse(
  hostUrl: string,
  sessionUri: string,
  requestId: string,
  response: "accept" | "decline" | "cancel",
  answers?: Record<string, unknown>
) {
  const res = await fetch("/api/ahp/sessions/input", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hostUrl, sessionUri, requestId, response, answers }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "Failed to submit");
  }
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
  const options = question.options ?? [];
  return (
    <div className="space-y-1">
      <p className="line-clamp-3 text-[11px] text-foreground/90">
        {question.message}
      </p>
      <div className="flex flex-wrap gap-1">
        {options.map((opt) => (
          <Button
            key={opt.id}
            size="sm"
            variant={opt.recommended ? "default" : "outline"}
            disabled={disabled}
            className="h-5 px-2 text-[10px]"
            onClick={(e) => {
              e.stopPropagation();
              onSelect(opt.id);
            }}
          >
            {opt.label}
          </Button>
        ))}
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
    <div className="space-y-1">
      <p className="line-clamp-3 text-[11px] text-foreground/90">
        {question.message}
      </p>
      <div className="flex gap-1">
        <Input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          disabled={disabled}
          className="h-5 text-[10px] flex-1"
          placeholder="Type your answer..."
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
          className="h-5 w-5 p-0"
          onClick={(e) => {
            e.stopPropagation();
            if (value.trim()) onSubmit(value.trim());
          }}
        >
          <Check className="h-2.5 w-2.5" />
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
    <div className="space-y-1">
      <p className="line-clamp-3 text-[11px] text-foreground/90">
        {question.message}
      </p>
      <div className="flex gap-1">
        <Button
          size="sm"
          variant="default"
          disabled={disabled}
          className="h-5 px-2 text-[10px]"
          onClick={(e) => {
            e.stopPropagation();
            onSelect(true);
          }}
        >
          Yes
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={disabled}
          className="h-5 px-2 text-[10px]"
          onClick={(e) => {
            e.stopPropagation();
            onSelect(false);
          }}
        >
          No
        </Button>
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
      await submitInputResponse(hostUrl, cardId, input.requestId, response, answers);
      // Don't reset — the subscription will clear the input
    } catch {
      setSubmitState("error");
      setTimeout(() => setSubmitState("idle"), 2000);
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
      <div className="mt-1 flex items-center gap-1.5 rounded border border-amber-200 bg-amber-50 px-1.5 py-1 dark:border-amber-800/40 dark:bg-amber-950/20">
        <Loader2 className="h-2.5 w-2.5 animate-spin text-amber-600 dark:text-amber-400" />
        <p className="text-[10px] text-amber-700 dark:text-amber-400">
          Submitting…
        </p>
      </div>
    );
  }

  if (submitState === "error") {
    return (
      <div className="mt-1 flex items-center gap-1.5 rounded border border-red-200 bg-red-50 px-1.5 py-1 dark:border-red-800/40 dark:bg-red-950/20">
        <X className="h-2.5 w-2.5 text-red-600 dark:text-red-400" />
        <p className="text-[10px] text-red-700 dark:text-red-400">
          Failed — try again
        </p>
      </div>
    );
  }

  // No questions — show message only with accept/decline
  if (!question) {
    return (
      <div className="mt-1 space-y-1 rounded border border-amber-200 bg-amber-50 px-1.5 py-1 dark:border-amber-800/40 dark:bg-amber-950/20">
        {input.message && (
          <p className="line-clamp-3 text-[11px] font-medium text-amber-800 dark:text-amber-300">
            {input.message}
          </p>
        )}
        <div className="flex gap-1">
          <Button
            size="sm"
            variant="default"
            className="h-5 px-2 text-[10px]"
            onClick={(e) => {
              e.stopPropagation();
              handleSubmit("accept");
            }}
          >
            Accept
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-5 px-2 text-[10px]"
            onClick={(e) => {
              e.stopPropagation();
              handleSubmit("decline");
            }}
          >
            Decline
          </Button>
        </div>
      </div>
    );
  }

  // Non-actionable: multi-question or unsupported kind — show message only
  if (!isActionable) {
    return (
      <div className="mt-1 space-y-0.5 rounded border border-amber-200 bg-amber-50 px-1.5 py-1 dark:border-amber-800/40 dark:bg-amber-950/20">
        <p className="line-clamp-3 text-[11px] font-medium text-amber-800 dark:text-amber-300">
          {input.message || question.message}
        </p>
        <p className="text-[10px] text-amber-700/60 dark:text-amber-400/50">
          Open in editor to respond
        </p>
      </div>
    );
  }

  return (
    <div
      className="mt-1 space-y-1 rounded border border-amber-200 bg-amber-50 px-1.5 py-1 dark:border-amber-800/40 dark:bg-amber-950/20"
      onClick={(e) => e.stopPropagation()}
    >
      {/* Show top-level message if different from question message */}
      {input.message && input.message !== question.message && (
        <p className="line-clamp-2 text-[10px] text-amber-700/70 dark:text-amber-400/60">
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
