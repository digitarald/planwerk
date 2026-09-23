import type { InboxProjectionOperation } from "./types.ts";

export function scopedInboxSourceKey(
  hostUrl: string,
  sourceKey: string,
): string {
  return `host:${encodeURIComponent(hostUrl)}:${sourceKey}`;
}

export function scopeInboxProjection(
  hostUrl: string,
  operation: InboxProjectionOperation,
): InboxProjectionOperation {
  if (operation.type === "resolve-source") {
    return {
      ...operation,
      sourceKey: scopedInboxSourceKey(hostUrl, operation.sourceKey),
    };
  }
  if (operation.type === "resolve-kind") {
    return {
      ...operation,
      exceptSourceKey: operation.exceptSourceKey
        ? scopedInboxSourceKey(hostUrl, operation.exceptSourceKey)
        : undefined,
    };
  }

  const sourceKey = scopedInboxSourceKey(
    hostUrl,
    operation.item.sourceKey,
  );
  return {
    ...operation,
    item: {
      ...operation.item,
      sourceKey,
      briefing: {
        ...operation.item.briefing,
        provenance: {
          ...operation.item.briefing.provenance,
          sourceKey,
          hostUrl,
        },
      },
    },
  };
}
