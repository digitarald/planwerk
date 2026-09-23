"use client";

import { useEffect } from "react";
import {
  ArrowRight,
  Columns3,
  Inbox,
  Radio,
  ShieldCheck,
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

const PHASES = ["Define", "Plan", "Build", "Review", "Ship"];

const PRINCIPLES = [
  { icon: ShieldCheck, label: "Gates verify" },
  { icon: Radio, label: "Coordinator observes" },
  { icon: UserCheck, label: "You decide" },
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
      <DialogContent className="max-h-[calc(100dvh-1rem)] gap-0 overflow-y-auto overscroll-contain p-0 sm:max-w-lg">
        <DialogHeader className="items-start gap-2 px-6 pb-1 pt-7 text-left">
          <span className="flex items-center gap-1.5 text-xs font-medium text-primary">
            <Inbox className="h-3.5 w-3.5" />
            Welcome to Planwerk
          </span>
          <DialogTitle className="max-w-sm text-pretty text-xl leading-tight">
            See what needs you.
          </DialogTitle>
          <p className="max-w-[54ch] text-sm leading-5 text-muted-foreground">
            Planwerk puts decisions, reviews, and finished work in one queue.
            The board tracks everything else.
          </p>
        </DialogHeader>

        <div className="mt-5 border-y border-border/70 px-6">
          <section className="flex gap-3 py-4">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Inbox className="h-4 w-4" />
            </span>
            <div>
              <h3 className="text-sm font-semibold">Work the queue</h3>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                Open the next item, act, and move on. Plans and review notes
                stay one click away.
              </p>
            </div>
          </section>

          <section className="flex gap-3 border-t border-border/70 py-4">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              <Columns3 className="h-4 w-4" />
            </span>
            <div className="min-w-0 flex-1">
              <h3 className="text-sm font-semibold">Track progress</h3>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                The board shows where work is. Gates, not runtime status, move
                cards forward.
              </p>
              <ol className="mt-3 flex min-w-0 gap-1" aria-label="Delivery phases">
                {PHASES.map((phase) => (
                  <li
                    key={phase}
                    className="min-w-0 flex-1 rounded border border-border/70 bg-muted/45 px-1 py-1 text-center text-[10px] font-medium text-muted-foreground"
                  >
                    <span className="block truncate">{phase}</span>
                  </li>
                ))}
              </ol>
            </div>
          </section>
        </div>

        <div className="mt-5 flex flex-wrap gap-2 px-6">
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
