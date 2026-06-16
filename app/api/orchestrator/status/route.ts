import { NextResponse } from "next/server";

import { getDb } from "@/lib/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const db = getDb();
  const sessionCount = db.prepare("SELECT COUNT(*) as count FROM card_phases").get() as {
    count: number;
  };
  const activeGates = db
    .prepare("SELECT COUNT(*) as count FROM gate_runs WHERE status = 'running'")
    .get() as { count: number };

  return NextResponse.json({
    status: "active",
    sessionsMonitored: sessionCount.count,
    activeInterventions: activeGates.count,
    lastHeartbeat: new Date().toISOString(),
    nextCheck: new Date(Date.now() + 30000).toISOString(),
  });
}
