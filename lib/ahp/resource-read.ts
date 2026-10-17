import "server-only";

import type { AhpClient } from "@microsoft/agent-host-protocol/client";
import type { ContentEncoding } from "@microsoft/agent-host-protocol";

/**
 * Read a text resource (plan.md, changeset file content, etc.) via `resourceRead`,
 * always returning a clean utf-8 string.
 *
 * `resourceRead`'s `encoding` param is server-chosen by default, and the spec
 * requires the server to fall back to either `base64` or `utf-8` if it can't
 * honor a requested encoding — so a caller that ignores `result.encoding` and
 * assumes the string is always plain text risks silently corrupting content
 * (every artifact/changeset-file read in Planwerk is rendered or injected as
 * markdown text, never treated as binary). This helper requests `utf-8`
 * explicitly and decodes base64 on the rare path where the server still
 * returns it.
 *
 * `ContentEncoding` is an ambient `const enum`, which can't be referenced as
 * a value under `isolatedModules` — the wire string literals are cast to the
 * type instead, matching the pattern in `actions.ts`.
 */
export async function readTextResource(
  client: AhpClient,
  uri: string,
  onDecodedBytes?: (count: number) => void,
): Promise<string> {
  const result = await client.request("resourceRead", {
    channel: "ahp-root://" as const,
    uri,
    encoding: "utf-8" as ContentEncoding,
  });

  if ((result.encoding as string) === "base64") {
    const bytes = Buffer.from(result.data, "base64");
    onDecodedBytes?.(bytes.length);
    return bytes.toString("utf-8");
  }
  onDecodedBytes?.(Buffer.byteLength(result.data, "utf-8"));
  return result.data;
}
