import { NextResponse } from "next/server";
import { z } from "zod";
import { validateLocalMutationRequest, validateLocalEventStreamRequest } from "@/lib/http/local-mutation";
import { listCoordinatorGoals, manageCoordinatorGoal } from "@/lib/orchestrator/coordinator-goal-service";
import { coordinatorGoalWaitReason } from "@/lib/orchestrator/coordinator-goal-reconciler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const scopeSchema = z.object({
  hostUrl: z.string().min(1).max(4_096),
  workspaceScope: z.array(z.string().max(4_096)).max(256),
});
const commandSchema = scopeSchema.extend({
  action: z.enum(["pause", "resume", "cancel"]),
  goalId: z.string().min(1).max(128), revision: z.number().int().positive(),
  commandId: z.string().uuid(),
});

export async function GET(request: Request) {
  const requestError = validateLocalEventStreamRequest(request);
  if (requestError) return NextResponse.json({ error: requestError }, { status: 403 });
  try {
    const params = new URL(request.url).searchParams;
    const scope = scopeSchema.parse({
      hostUrl: params.get("hostUrl"), workspaceScope: JSON.parse(params.get("workspaceScope") ?? "[]"),
    });
    const goals = listCoordinatorGoals(scope).map((goal) => ({
      ...goal, waitingReason: coordinatorGoalWaitReason(goal),
    }));
    return NextResponse.json({ goals });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}

export async function POST(request: Request) {
  const requestError = validateLocalMutationRequest(request);
  if (requestError) return NextResponse.json({ error: requestError }, { status: 403 });
  try {
    const body = commandSchema.parse(await request.json());
    const goal = manageCoordinatorGoal(body, {
      action: body.action, goalId: body.goalId, revision: body.revision,
    }, `goal-control:${body.commandId}`);
    return NextResponse.json({ goal });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 409 });
  }
}
