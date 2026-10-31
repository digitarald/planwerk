import type { CopilotSession, MessageOptions, SessionEvent } from "@github/copilot-sdk";

export type SdkTurnOutcome =
  | { status: "completed"; messageId: string }
  | { status: "blocked"; messageId: string; message: string };

/** Subscribe before admission: a policy block can arrive before send returns. */
export async function sendSdkTurn(
  session: Pick<CopilotSession, "send" | "on">,
  message: MessageOptions,
  timeoutMs: number,
  signal: AbortSignal,
  onAdmissionStateChange?: (pending: boolean) => void,
): Promise<SdkTurnOutcome> {
  signal.throwIfAborted();
  let messageId: string | undefined;
  let started = false;
  let active = true;
  const buffered: SessionEvent[] = [];
  const { promise, resolve, reject } = Promise.withResolvers<SdkTurnOutcome>();
  const observe = (event: SessionEvent) => {
    if (!active || event.agentId) return;
    if (event.type === "session.shutdown") {
      reject(new Error("The SDK session ended before the requested run completed."));
      return;
    }
    if (event.type === "session.error" && !event.data.originatingMessageId) {
      reject(new Error(event.data.message));
      return;
    }
    if (event.type !== "session.warning" && event.type !== "user.message" &&
        event.type !== "assistant.message" && event.type !== "session.idle" &&
        event.type !== "session.error" && event.type !== "session.autopilot_stopped") return;
    if (!messageId) { buffered.push(event); return; }
    if (event.type === "session.warning" && event.data.warningType === "policy_blocked"
        && event.data.originatingMessageId === messageId) {
      resolve({ status: "blocked", messageId, message: event.data.message });
    } else if (event.type === "user.message" && event.data.messageId === messageId) {
      started = true;
    } else if (event.type === "assistant.message" && event.data.originatingMessageId === messageId) {
      started = true;
    } else if (event.type === "session.idle" && started && event.data.mode !== "autopilot") {
      if (event.data.aborted) reject(new Error("The requested run was aborted before completion."));
      else resolve({ status: "completed", messageId });
    } else if (event.type === "session.error" && event.data.originatingMessageId === messageId) {
      reject(new Error(event.data.message));
    } else if (event.type === "session.autopilot_stopped" && event.data.requestId === messageId) {
      if (["error", "aborted"].includes(event.data.reason)) reject(new Error(`Autopilot ${event.data.reason}`));
      else resolve({ status: "completed", messageId });
    }
  };
  const unsubscribe = session.on(observe);
  const cancel = () => reject(signal.reason ?? new Error("Submission cancelled"));
  signal.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => reject(new Error(`Timeout after ${timeoutMs}ms waiting for response completion`)), timeoutMs);
  try {
    // Admission is also covered by timeout/cancellation; late responses are not retried.
    if (signal.aborted) cancel();
    else {
      onAdmissionStateChange?.(true);
      void session.send(message).then((id) => {
        onAdmissionStateChange?.(false);
        if (!active) return;
        messageId = id;
        for (const event of buffered) observe(event);
        buffered.length = 0;
      }, (error) => { onAdmissionStateChange?.(false); reject(error); });
    }
    return await promise;
  } finally {
    active = false;
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
    unsubscribe();
  }
}
