"use client";

import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { OrchestratorFeed } from "@/components/orchestrator/feed";
import { useUIStore } from "@/lib/store/ui-store";
import { CoordinatorGoals } from "./coordinator-goals";

export function CoordinatorDrawer() {
  const open = useUIStore((state) => state.coordinatorOpen);
  const setOpen = useUIStore((state) => state.setCoordinatorOpen);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        className="!top-10 !right-0 !bottom-0 !left-auto !h-auto !w-[min(420px,calc(100%-1rem))] !max-w-none !translate-x-0 !translate-y-0 !gap-0 !rounded-none !rounded-tl-xl border-l border-t p-0 shadow-elevation-lg"
      >
        <DialogTitle className="sr-only">Coordinator</DialogTitle>
        <div className="min-h-0 flex h-full flex-col pt-10">
          <CoordinatorGoals />
          <div className="min-h-0 flex-1"><OrchestratorFeed /></div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
