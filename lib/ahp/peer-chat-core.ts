import type { ChatSource, ChatState, CreateChatParams } from "@microsoft/agent-host-protocol";

export interface PeerChatAgent {
  provider: string;
  capabilities?: {
    multipleChats?: {
      fork?: boolean;
      sideChat?: boolean;
    };
  };
}

export interface PeerChatRootState {
  agents: PeerChatAgent[];
}

export type CreatePeerChatParams = CreateChatParams;

export function contextualChatCapabilities(root: unknown, provider: string) {
  const agents = (root as Partial<PeerChatRootState> | undefined)?.agents;
  const flags = Array.isArray(agents) ? agents.find((agent) => agent.provider === provider)?.capabilities?.multipleChats : undefined;
  return { fork: flags?.fork === true, sideChat: flags?.sideChat === true, ordinary: supportsPeerChats(root, provider) };
}

export function validateChatSource(
  root: unknown, provider: string, chat: Pick<ChatState, "resource" | "turns" | "activeTurn">,
  source: ChatSource,
): void {
  const capabilities = contextualChatCapabilities(root, provider);
  if (source.chat !== chat.resource) throw new Error("The source chat changed.");
  if (source.kind !== "fork" && source.kind !== "sideChat") throw new Error("Unsupported chat source.");
  if (!capabilities[source.kind]) throw new Error("The provider does not advertise this conversation capability.");
  const completed = chat.turns.find((turn) => turn.id === source.turnId);
  const active = chat.activeTurn?.id === source.turnId;
  if (!completed && !active) throw new Error("The source turn is no longer available. Reload conversation evidence.");
  if (source.kind === "fork" && (!completed || completed.state !== "complete" || active)) throw new Error("Only a completed turn can be forked.");
  if (source.kind === "sideChat" && source.selection && !source.selection.text.trim()) {
    throw new Error("The selected-text snapshot must not be empty.");
  }
}

export function supportsPeerChats(
  rootState: unknown,
  provider: string,
): boolean {
  if (!rootState || typeof rootState !== "object") return false;
  const agents = (rootState as Partial<PeerChatRootState>).agents;
  if (!Array.isArray(agents)) return false;
  const agent = agents.find((candidate) => candidate.provider === provider);
  return Boolean(
    agent?.capabilities &&
    agent.capabilities.multipleChats && typeof agent.capabilities.multipleChats === "object",
  );
}

export function buildCreatePeerChatParams(
  sessionUri: string,
  chatId: string,
): CreatePeerChatParams {
  const encodedSession = Buffer.from(sessionUri, "utf8").toString("base64url");
  return {
    channel: sessionUri,
    chat: `ahp-chat://${chatId}/${encodedSession}`,
  };
}
