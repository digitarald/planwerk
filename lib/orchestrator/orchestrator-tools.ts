import { defineTool } from "@github/copilot-sdk";
import type {
  Tool,
  ToolInvocation,
  ToolResultObject,
} from "@github/copilot-sdk";

export const ORCHESTRATOR_TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "create_session",
      description: "Create a new agent session for a task. Use when user wants to start new work.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", minLength: 1, description: "Task title" },
          prompt: { type: "string", minLength: 1, description: "Outcome, acceptance criteria and essential constraints; leave implementation to the worker" },
          workingDirectory: { type: "string", minLength: 1, description: "Absolute in-scope working directory" },
        },
        required: ["title", "prompt", "workingDirectory"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "list_sessions",
      description: "Search the connected host's scoped session catalogue, without waking sessions. Paginated, maximum 25 per page.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          offset: { type: "integer", minimum: 0 },
          limit: { type: "integer", minimum: 1, maximum: 25 },
        },
        required: [],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "read_session",
      description: "Inspect one scoped session's outcome, pending input, plan, gate/review evidence and provenance. Missing cold evidence requires explicit human refresh.",
      parameters: {
        type: "object",
        properties: { cardId: { type: "string", minLength: 1 } },
        required: ["cardId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "read_session_messages",
      description: "Read the latest cached agent outcome, with chat/turn identity and truncation when captured. Not a full transcript; never restores a cold session.",
      parameters: {
        type: "object",
        properties: {
          cardId: { type: "string", minLength: 1 },
          offset: { type: "integer", minimum: 0 },
          limit: { type: "integer", minimum: 1, maximum: 20 },
        },
        required: ["cardId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "list_goals",
      description: "List durable chief-of-staff goals in the current host and workspace scope.",
      parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "read_goal",
      description: "Read a goal's revision, work graph, delivery identities, blockers and result evidence before changing it.",
      parameters: {
        type: "object", properties: { goalId: { type: "string", minLength: 1 } },
        required: ["goalId"], additionalProperties: false,
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "manage_goal",
      description: "Create a draft goal, edit undispatched work/dependencies, activate, pause, resume or cancel future follow-ups. Criteria must reflect the human objective; ask when unclear. Lower modes allow drafting/activation but never launch workers. No action may declare work completed.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["create", "update", "add_work", "dependencies", "activate", "pause", "resume", "cancel"] },
          goalId: { type: "string", minLength: 1 },
          revision: { type: "integer", minimum: 1 },
          objective: { type: "string", minLength: 1 },
          acceptanceCriteria: { type: "string", minLength: 1 },
          itemId: { type: "string", minLength: 1 },
          instructions: { type: "string", minLength: 1, description: "Desired outcome and essential constraints, not implementation steps" },
          workingDirectory: { type: "string", minLength: 1 },
          cardId: { type: "string", minLength: 1 },
          dependencies: { type: "array", items: { type: "string" }, maxItems: 32 },
          dependencyKind: { type: "string", enum: ["result", "verified"] },
        },
        required: ["action"], additionalProperties: false,
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "send_message",
      description: "Send a text instruction to a running agent session. Use to steer, nudge, or give context to an agent.",
      parameters: {
        type: "object",
        properties: {
          cardId: { type: "string", minLength: 1, description: "Card ID to message" },
          message: { type: "string", minLength: 1, description: "Message to send to the agent" },
        },
        required: ["cardId", "message"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "answer_input",
      description: "Answer a pending input question for a session that's waiting for user input.",
      parameters: {
        type: "object",
        properties: {
          cardId: { type: "string", minLength: 1, description: "Card ID with pending input" },
          answer: { type: "string", minLength: 1, description: "The answer to provide" },
        },
        required: ["cardId", "answer"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "trigger_review",
      description: "Inject a review skill into a session. Use to start code review, plan review, or security review.",
      parameters: {
        type: "object",
        properties: {
          cardId: { type: "string", minLength: 1, description: "Card ID to review" },
          skillId: {
            type: "string",
            minLength: 1,
            description: "Configured review skill ID from read_session.availableReviewSkills",
          },
        },
        required: ["cardId", "skillId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "trigger_gate",
      description: "Run a deterministic gate check (lint, typecheck, or test) on a card.",
      parameters: {
        type: "object",
        properties: {
          cardId: { type: "string", minLength: 1, description: "Card ID to check" },
          gateType: {
            type: "string",
            enum: ["lint", "typecheck", "test"],
            description: "Gate type to run",
          },
          gateName: {
            type: "string",
            minLength: 1,
            description:
              "Optional configured gate name; when provided it must match the requested type",
          },
        },
        required: ["cardId", "gateType"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "override_phase",
      description: "Force-advance a card past its current gates. Use sparingly — creates audit trail. Refuse for high-risk cards without explicit human confirmation.",
      parameters: {
        type: "object",
        properties: {
          cardId: { type: "string", minLength: 1, description: "Card ID to advance" },
          targetPhase: {
            type: "string",
            enum: ["plan", "build", "review", "ship"],
            description: "Phase to move the card to",
          },
          reason: { type: "string", minLength: 1, description: "Why this override is justified" },
        },
        required: ["cardId", "targetPhase", "reason"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "assess_risk",
      description: "Re-run risk assessment on a card. Use when the card's scope has changed significantly.",
      parameters: {
        type: "object",
        properties: {
          cardId: { type: "string", minLength: 1, description: "Card ID to assess" },
        },
        required: ["cardId"],
        additionalProperties: false,
      },
    },
  },
] as const;

export type OrchestratorToolName =
  (typeof ORCHESTRATOR_TOOLS)[number]["function"]["name"];

export interface ToolCallResult {
  success: boolean;
  message: string;
  auditKey?: string;
  data?: unknown;
}

export interface OrchestratorToolDispatch {
  (
    toolName: OrchestratorToolName,
    args: Record<string, unknown>,
    auditKey: string,
    invocation: ToolInvocation,
  ): Promise<ToolCallResult>;
}

export interface OrchestratorToolResultEvent {
  toolCallId: string;
  toolName: OrchestratorToolName;
  auditKey: string;
  result: ToolCallResult;
}

type JsonProperty = {
  type: "string" | "integer" | "array";
  minLength?: number;
  enum?: readonly string[];
  minimum?: number;
  maximum?: number;
  items?: { type: "string" };
  maxItems?: number;
};

type ActionSchema = {
  properties: Record<string, JsonProperty>;
  required: readonly string[];
};

export function createToolAuditKey(
  invocation: Pick<ToolInvocation, "sessionId" | "toolCallId">,
): string {
  // This versioned key is suitable for a future durable UNIQUE constraint.
  // The SDK preserves toolCallId when re-delivering the same invocation.
  return `cto-tool:v1:${invocation.sessionId}:${invocation.toolCallId}`;
}

export function validateToolArguments(
  toolName: OrchestratorToolName,
  value: unknown,
): Record<string, unknown> {
  const definition = ORCHESTRATOR_TOOLS.find(
    (tool) => tool.function.name === toolName,
  );
  if (!definition) {
    throw new Error(`Unknown tool: ${toolName}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("arguments must be an object");
  }

  const args = value as Record<string, unknown>;
  const schema = definition.function.parameters as ActionSchema;
  for (const key of Object.keys(args)) {
    if (!(key in schema.properties)) {
      throw new Error(`unexpected argument: ${key}`);
    }
  }
  for (const key of schema.required) {
    if (!(key in args)) {
      throw new Error(`missing required argument: ${key}`);
    }
  }
  for (const [key, raw] of Object.entries(args)) {
    const property = schema.properties[key];
    if (property.type === "integer" ? !Number.isSafeInteger(raw)
      : property.type === "array" ? !Array.isArray(raw)
      : typeof raw !== property.type) {
      throw new Error(`${key} must be a ${property.type}`);
    }
    if (Array.isArray(raw) &&
        (raw.length > (property.maxItems ?? 32) || !raw.every((entry) => typeof entry === "string" && entry.length <= 256))) {
      throw new Error(`${key} must be a bounded array of strings`);
    }
    if (typeof raw === "number" &&
        ((property.minimum !== undefined && raw < property.minimum) ||
         (property.maximum !== undefined && raw > property.maximum))) {
      throw new Error(`${key} is outside the permitted range`);
    }
    if (
      typeof raw === "string" &&
      property.minLength !== undefined &&
      raw.length < property.minLength
    ) {
      throw new Error(`${key} must not be empty`);
    }
    if (
      typeof raw === "string" &&
      property.enum &&
      !property.enum.includes(raw)
    ) {
      throw new Error(`${key} must be one of: ${property.enum.join(", ")}`);
    }
  }
  return args;
}

export function createOrchestratorSdkTools(options: {
  dispatch: OrchestratorToolDispatch;
  onResult?: (event: OrchestratorToolResultEvent) => void;
}): Tool[] {
  return ORCHESTRATOR_TOOLS.map((definition) => {
    const toolName = definition.function.name;
    return defineTool(toolName, {
      description: definition.function.description,
      parameters: definition.function.parameters,
      defer: "never",
      skipPermission: toolName !== "override_phase",
      handler: async (rawArgs, invocation) => {
        const auditKey = createToolAuditKey(invocation);
        let result: ToolCallResult;
        try {
          const args = validateToolArguments(toolName, rawArgs);
          result = await options.dispatch(
            toolName,
            args,
            auditKey,
            invocation
          );
        } catch (error) {
          result = {
            success: false,
            message: error instanceof Error ? error.message : String(error),
            auditKey,
          };
        }

        result = { ...result, auditKey };
        options.onResult?.({
          toolCallId: invocation.toolCallId,
          toolName,
          auditKey,
          result,
        });

        return {
          textResultForLlm: JSON.stringify(result),
          resultType: result.success ? "success" : "failure",
          ...(result.success ? {} : { error: result.message }),
        } satisfies ToolResultObject;
      },
    });
  });
}
