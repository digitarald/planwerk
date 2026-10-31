"use client";

import { Loader2, Send } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useOrchestratorStore } from "@/lib/store/orchestrator-store";
import { useConnectionStore } from "@/lib/store/connection-store";
import { useBoardStore } from "@/lib/store/board-store";

export function ChatInput() {
  const value = useOrchestratorStore((state) => state.draft);
  const setValue = useOrchestratorStore((state) => state.setDraft);
  const sendMessage = useOrchestratorStore((s) => s.sendMessage);
  const isProcessing = useOrchestratorStore((s) => s.isProcessing);
  const hostUrl = useConnectionStore((s) => s.hostUrl);
  const workspaceFilters = useBoardStore((s) => s.workspaceFilters);
  const selectedCardId = useBoardStore((s) => s.detailCardId);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!value.trim() || isProcessing) return;
    void sendMessage(value.trim(), hostUrl ?? undefined, [...workspaceFilters], selectedCardId);
    setValue("");
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="p-2">
      <div className="relative">
        <Textarea
          id="coordinator-message"
          aria-label="Message the coordinator"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask or instruct..."
          className="min-h-[3.5rem] resize-none pr-8 text-xs bg-background"
          rows={2}
          disabled={isProcessing}
        />
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="submit"
                size="sm"
                variant="ghost"
                disabled={!value.trim() || isProcessing}
                className="absolute bottom-1.5 right-1.5 h-6 w-6 p-0 text-muted-foreground hover:text-foreground disabled:opacity-30"
                aria-label={isProcessing ? "Sending message" : "Send message"}
              />
            }
          >
            {isProcessing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Send className="h-3.5 w-3.5" />
            )}
          </TooltipTrigger>
          <TooltipContent>{isProcessing ? "Sending message" : "Send message"}</TooltipContent>
        </Tooltip>
      </div>
    </form>
  );
}
