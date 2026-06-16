import { NextResponse } from "next/server";

import { mockAHPSessions } from "@/lib/ahp/mock-sessions";

export async function GET() {
  return NextResponse.json({ sessions: mockAHPSessions });
}
