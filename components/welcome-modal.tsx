"use client";

import { useEffect } from "react";
import {
  ChevronRight,
  ArrowRight,
  ClipboardList,
  Hammer,
  Lightbulb,
  Radio,
  Rocket,
  Search,
  ShieldCheck,
  Sparkles,
  UserCheck,
} from "lucide-react";

import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { usePersistentState } from "@/lib/hooks/use-persistent-state";
import { useUIStore } from "@/lib/store/ui-store";

const WELCOME_SEEN_KEY = "planwerk:welcome-seen";

const PHASES = [
  { icon: Lightbulb, label: "Define", color: "var(--chart-1)" },
  { icon: ClipboardList, label: "Plan", color: "var(--chart-3)" },
  { icon: Hammer, label: "Build", color: "var(--chart-5)" },
  { icon: Search, label: "Review", color: "var(--chart-4)" },
  { icon: Rocket, label: "Ship", color: "var(--chart-2)" },
];

const PRINCIPLES = [
  { icon: ShieldCheck, label: "Gates enforced" },
  { icon: Radio, label: "Orchestrator on watch" },
  { icon: UserCheck, label: "You approve" },
];

export function WelcomeModal() {
  const open = useUIStore((s) => s.welcomeOpen);
  const setWelcomeOpen = useUIStore((s) => s.setWelcomeOpen);
  const [seen, setSeen] = usePersistentState(WELCOME_SEEN_KEY, "");

  // First run: auto-open once when the user hasn't seen the intro yet.
  useEffect(() => {
    if (seen !== "true") {
      setWelcomeOpen(true);
    }
  }, [seen, setWelcomeOpen]);

  const handleOpenChange = (next: boolean) => {
    setWelcomeOpen(next);
    if (!next && seen !== "true") {
      setSeen("true");
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg gap-0 overflow-hidden p-0">
        <DialogHeader className="items-center gap-1.5 px-6 pt-7 pb-1 text-center">
          <span className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.18em] text-primary">
            <Sparkles className="h-3.5 w-3.5" />
            Welcome to Planwerk
          </span>
          <DialogTitle className="text-xl leading-tight">
            A kanban board for your AI agents
          </DialogTitle>
        </DialogHeader>

        {/* The concept, shown not told: a card flows left to right through phases */}
        <div className="px-6 pt-5">
          <ol className="flex items-start justify-between">
            {PHASES.map(({ icon: Icon, label, color }, i) => (
              <li key={label} className="contents">
                <div className="flex flex-1 flex-col items-center gap-2">
                  <span
                    className="flex h-12 w-12 items-center justify-center rounded-2xl border"
                    style={{
                      color,
                      backgroundColor: `color-mix(in oklch, ${color} 12%, transparent)`,
                      borderColor: `color-mix(in oklch, ${color} 28%, transparent)`,
                    }}
                  >
                    <Icon className="h-5 w-5" />
                  </span>
                  <span className="text-xs font-medium">{label}</span>
                </div>
                {i < PHASES.length - 1 && (
                  <ChevronRight
                    aria-hidden
                    className="mt-3.5 h-4 w-4 shrink-0 text-muted-foreground/40"
                  />
                )}
              </li>
            ))}
          </ol>
          <p className="mt-4 text-center text-sm text-muted-foreground">
            Every agent session is a card that flows through these phases. Nothing
            advances until the work is verified.
          </p>
        </div>

        {/* Principles as compact chips, not paragraphs */}
        <div className="mt-5 flex flex-wrap justify-center gap-2 px-6">
          {PRINCIPLES.map(({ icon: Icon, label }) => (
            <span
              key={label}
              className="flex items-center gap-1.5 rounded-full border border-border/60 bg-muted/40 px-3 py-1 text-xs text-muted-foreground"
            >
              <Icon className="h-3.5 w-3.5 text-primary" />
              {label}
            </span>
          ))}
        </div>

        <div className="mt-6 px-6 pb-6">
          <DialogClose render={<Button size="lg" className="h-11 w-full text-sm" />}>
            Get started
            <ArrowRight className="h-4 w-4" />
          </DialogClose>
          <p className="mt-3 flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
            Reopen anytime from the command palette
            <kbd className="rounded border border-border bg-muted px-1 font-mono text-[10px]">
              ⌘K
            </kbd>
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
