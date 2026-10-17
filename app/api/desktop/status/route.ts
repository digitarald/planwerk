import { NextRequest, NextResponse } from "next/server";
import { desktopHosts } from "@/lib/desktop/status";
import { getInboxCounts } from "@/lib/db/inbox-store";
import { getDb } from "@/lib/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: NextRequest) {
  const token = process.env.PLANWERK_DESKTOP_TOKEN;
  if (!token || request.headers.get("authorization") !== `Bearer ${token}`) {
    return NextResponse.json({ error: "Desktop authentication required" }, { status: 403 });
  }
  const hosts = desktopHosts();
  const connected = hosts.length > 0 && hosts.every((host) => host.connected);
  const running = hosts.reduce((total, host) => total + (host.connected ? host.running : 0), 0);
  const counts = hosts.reduce((total, host) => {
    const counts = getInboxCounts(getDb(), host.hostUrl);
    return { unread: total.unread + counts.unread, open: total.open + counts.open };
  }, { unread: 0, open: 0 });
  return NextResponse.json(
    { ...counts, connected, running },
    { headers: { "Cache-Control": "no-store" } },
  );
}
