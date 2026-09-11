import { NextRequest, NextResponse } from "next/server";

import { setSessionArchived } from "@/lib/ahp/session-messenger";
import { ahpErrorResponse } from "@/lib/ahp/api-error";
import { validateLocalMutationRequest } from "@/lib/http/local-mutation";

const debug = (...args: unknown[]) => {
  if (process.env.AHP_DEBUG) console.info("[ahp:archive]", ...args);
};

export async function POST(request: NextRequest) {
  const requestError = validateLocalMutationRequest(request);
  if (requestError) {
    return NextResponse.json({ error: requestError }, { status: 403 });
  }

  const body = (await request.json()) as {
    hostUrl?: string;
    sessionUri?: string;
    isArchived?: boolean;
  };

  const { hostUrl, sessionUri } = body;
  const isArchived = body.isArchived ?? true;

  if (!hostUrl || !sessionUri) {
    return NextResponse.json(
      { error: "hostUrl and sessionUri are required" },
      { status: 400 }
    );
  }

  debug("POST:", sessionUri, "isArchived:", isArchived);

  try {
    const result = await setSessionArchived(hostUrl, sessionUri, isArchived);

    if (!result.success) {
      return NextResponse.json(
        { error: "Failed to apply archive state to session", status: result.status },
        { status: 502 }
      );
    }

    return NextResponse.json({ ok: true, status: result.status });
  } catch (err) {
    console.error("[ahp:archive] error:", err instanceof Error ? err.message : err);
    return ahpErrorResponse(err, "Failed to archive session");
  }
}
