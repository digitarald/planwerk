import { NextRequest, NextResponse } from "next/server";
import { withAHPClient } from "@/lib/ahp/client-operation";
import { resolveCreationConfiguration, CreationConfigError } from "@/lib/ahp/session-config";
import { parseCreationRequest } from "@/lib/ahp/creation-request";
import { validateLocalMutationRequest } from "@/lib/http/local-mutation";
import { ahpErrorResponse } from "@/lib/ahp/api-error";

export async function POST(request: NextRequest) {
  const error = validateLocalMutationRequest(request);
  if (error) return NextResponse.json({ error }, { status: 403 });
  try {
    const input = parseCreationRequest(await request.json());
    const result = await withAHPClient(input.hostUrl, (client) => resolveCreationConfiguration(client, input), request.signal);
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    if (err instanceof CreationConfigError || err instanceof SyntaxError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return ahpErrorResponse(err, "Failed to resolve task options");
  }
}
