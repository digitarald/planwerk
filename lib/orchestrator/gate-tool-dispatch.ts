import { MessageDispatchAmbiguousError } from "../ahp/dispatch-confirmation.ts";
import { isOperationAborted } from "../abort.ts";
import type { ToolHandlerOutcome } from "./tool-execution-disposition.ts";

interface GateDispatchResult {
  success: boolean;
}

interface DispatchGateInstructionOptions {
  cardTitle: string;
  gateType: string;
  gateRunId: number;
  command: string;
  inject: () => Promise<GateDispatchResult>;
  failGate: (output: string) => void;
}

export async function dispatchGateInstruction({
  cardTitle,
  gateType,
  gateRunId,
  command,
  inject,
  failGate,
}: DispatchGateInstructionOptions): Promise<ToolHandlerOutcome> {
  try {
    const dispatch = await inject();
    if (!dispatch.success) {
      failGate("Gate instruction was not dispatched; retry this gate.");
      return {
        result: {
          success: false,
          message: `Failed to trigger ${gateType} gate for ${cardTitle}; retry the action.`,
        },
        disposition: "retryable",
      };
    }
  } catch (error) {
    if (isOperationAborted(error)) throw error;
    if (error instanceof MessageDispatchAmbiguousError) {
      failGate(
        "Gate instruction dispatch is ambiguous; human review is required before retrying.",
      );
      return {
        result: {
          success: false,
          message:
            `Gate dispatch for ${cardTitle} is ambiguous; ` +
            "human review is required before retrying.",
        },
        disposition: "needs-human",
      };
    }
    const detail = error instanceof Error ? error.message : String(error);
    failGate(`Gate instruction was not dispatched: ${detail}`);
    return {
      result: {
        success: false,
        message:
          `Failed to trigger ${gateType} gate for ${cardTitle}: ${detail}. ` +
          "Retry the action.",
      },
      disposition: "retryable",
    };
  }

  return {
    result: {
      success: true,
      message:
        `Triggered ${gateType} gate for ${cardTitle} (run #${gateRunId}). ` +
        `Agent instructed to run ${command}.`,
    },
    disposition: "terminal",
  };
}
