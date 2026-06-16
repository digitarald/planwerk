import { NextRequest, NextResponse } from "next/server";

function generateResponse(
  message: string,
): { response: string; action?: string } {
  const lower = message.toLowerCase();

  if (
    lower.includes("create") ||
    lower.includes("new task") ||
    lower.includes("start")
  ) {
    return {
      response:
        "I'll create a new task. What should it be called? Or paste a GitHub issue URL and I'll extract the details.",
      action: "prompt_create",
    };
  }

  if (lower.includes("why") && lower.includes("stuck")) {
    return {
      response:
        '"Search indexing service" has been idle for 8 minutes. The agent appears to be waiting for a decision on the Elasticsearch vs Meilisearch approach. I can nudge it to pick Elasticsearch (the safer choice) or you can inject a message with your preference.',
      action: "diagnose",
    };
  }

  if (lower.includes("next") || lower.includes("what should")) {
    return {
      response:
        `Based on priority and dependencies, I'd suggest moving "Add rate limiting" from DEFINE to PLAN next. It's been waiting the longest and has no blockers. Want me to start planning it?`,
      action: "suggest",
    };
  }

  if (lower.includes("override") || lower.includes("skip")) {
    return {
      response:
        "Got it. I'll mark the review gate as manually approved. Note: this bypasses the adversarial review — the card will move to the next phase without AI validation.",
      action: "override",
    };
  }

  if (lower.includes("pause") || lower.includes("stop")) {
    return {
      response:
        "Pausing all active sessions. 3 sessions in BUILD and 1 in REVIEW will be suspended. They'll resume where they left off when you're ready.",
      action: "pause",
    };
  }

  if (
    lower.includes("status") ||
    lower.includes("how") ||
    lower.includes("board")
  ) {
    return {
      response:
        'Board health: 4 active, 2 idle, 0 errors, 1 needs input. "Database migration v3" is in REVIEW with code review running. "Update API docs" needs your input on which endpoints to prioritize.',
      action: "status",
    };
  }

  return {
    response:
      "I understand. Let me look into that. For now, the board is stable — 4 sessions active, no critical issues. Is there something specific you'd like me to focus on?",
  };
}

export async function POST(request: NextRequest) {
  const { message } = await request.json();

  if (!message) {
    return NextResponse.json({ error: "message required" }, { status: 400 });
  }

  await new Promise((resolve) =>
    setTimeout(resolve, 500 + Math.random() * 1000),
  );

  const { response, action } = generateResponse(message);

  return NextResponse.json({ response, action });
}
