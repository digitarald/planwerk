export interface PeerChatAgent {
  provider: string;
  capabilities?: {
    multipleChats?: {
      fork?: boolean;
    };
  };
}

export interface PeerChatRootState {
  agents: PeerChatAgent[];
}

export interface CreatePeerChatParams {
  channel: string;
  chat: string;
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
    Object.prototype.hasOwnProperty.call(agent.capabilities, "multipleChats"),
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
