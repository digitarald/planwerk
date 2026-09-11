import { NextRequest, NextResponse } from "next/server";

import { getCtoContinuityStore } from "@/lib/db/cto-continuity";
import { validateLocalMutationRequest } from "@/lib/http/local-mutation";
import {
  handleApprovalDecision,
  listApprovalDisplayMetadata,
} from "@/lib/orchestrator/approval-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return listApprovalDisplayMetadata(getCtoContinuityStore());
}

export async function POST(request: NextRequest) {
  const requestError = validateLocalMutationRequest(request);
  if (requestError) {
    return NextResponse.json({ error: requestError }, { status: 403 });
  }

  return handleApprovalDecision(request, getCtoContinuityStore());
}
