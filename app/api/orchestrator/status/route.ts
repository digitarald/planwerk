import { NextResponse } from "next/server";

import { getCoordinatorModeStore } from "@/lib/db/coordinator-mode";
import { getDb } from "@/lib/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const db = getDb();
  const boardDefault = getCoordinatorModeStore().getBoardDefault();
  const sessionCount = db.prepare("SELECT COUNT(*) as count FROM card_phases").get() as {
    count: number;
  };
  const activeGates = db
    .prepare("SELECT COUNT(*) as count FROM gate_runs WHERE status = 'running'")
    .get() as { count: number };

  return NextResponse.json({
    status: boardDefault.mode,
    defaultMode: boardDefault.mode,
    modeUpdatedAt: boardDefault.updatedAt,
    sessionsMonitored: sessionCount.count,
    activeInterventions: activeGates.count,
    lastHeartbeat: new Date().toISOString(),
    nextCheck: new Date(Date.now() + 30000).toISOString(),
  });
}
