"use client";

import { useState } from "react";
import { Loader2, Send } from "lucide-react";
import { Input } from "@/components/ui/input";
import { useOrchestratorStore } from "@/lib/store/orchestrator-store";

export function ChatInput() {
  const [value, setValue] = useState("");
  const sendMessage = useOrchestratorStore((s) => s.sendMessage);
  const isProcessing = useOrchestratorStore((s) => s.isProcessing);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!value.trim() || isProcessing) return;
    void sendMessage(value.trim());
    setValue("");
  };

  return (
    <form onSubmit={handleSubmit} className="p-2">
      <div className="relative">
        <Input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Ask or instruct..."
          className="pr-8 text-xs h-8 bg-background"
          disabled={isProcessing}
        />
        <button
          type="submit"
          disabled={!value.trim() || isProcessing}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground disabled:opacity-30"
        >
          {isProcessing ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Send className="h-3.5 w-3.5" />
          )}
        </button>
      </div>
    </form>
  );
}
