import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({
    status: "active",
    sessionsMonitored: 8,
    activeInterventions: 0,
    lastHeartbeat: new Date().toISOString(),
    nextCheck: new Date(Date.now() + 30000).toISOString(),
  });
}
