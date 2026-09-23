import type { NextRequest } from "next/server";

import { getCoordinatorModeStore } from "@/lib/db/coordinator-mode";
import {
  handleCoordinatorModeGet,
  handleCoordinatorModePost,
} from "@/lib/orchestrator/coordinator-mode-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: NextRequest) {
  return handleCoordinatorModeGet(request, getCoordinatorModeStore());
}

export function POST(request: NextRequest) {
  return handleCoordinatorModePost(request, getCoordinatorModeStore());
}
