import "server-only";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { CreationConfigError } from "./session-config";

const configuration = z.object({
  hostUrl: z.string().min(1).max(2048),
  provider: z.string().min(1).max(100).optional(),
  workingDirectory: z.string().min(1).max(8192),
  config: z.record(z.string(), z.unknown()).optional(),
  model: z.object({
    id: z.string().min(1).max(300),
    config: z.record(z.string(), z.union([z.string(), z.number().finite(), z.boolean(), z.null()])).optional(),
  }).strict().optional(),
  completion: z.object({ property: z.string().min(1).max(300), query: z.string().max(300) }).strict().optional(),
}).strict();

const creation = configuration.extend({
  completion: z.never().optional(),
  requestId: z.uuid(),
  revision: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  prompt: z.string().max(100_000).optional(),
  title: z.string().max(100_000).optional(),
});

export function parseCreationRequest(body: unknown, create: true): z.infer<typeof creation>;
export function parseCreationRequest(body: unknown, create?: false): z.infer<typeof configuration>;
export function parseCreationRequest(body: unknown, create = false) {
  const parsed = (create ? creation : configuration).safeParse(body);
  if (!parsed.success) throw new CreationConfigError("Invalid task options. Refresh options and check the workspace and task.");
  const input = parsed.data;
  if (isAbsolute(input.workingDirectory)) input.workingDirectory = pathToFileURL(input.workingDirectory).href;
  else {
    let url: URL;
    try { url = new URL(input.workingDirectory); } catch { throw new CreationConfigError("Workspace must be an absolute folder path."); }
    if (url.protocol !== "file:" || (url.hostname && url.hostname !== "localhost") || url.search || url.hash) {
      throw new CreationConfigError("Workspace must be a local folder.");
    }
    input.workingDirectory = url.href;
  }
  if (create && !("prompt" in input && typeof input.prompt === "string" && input.prompt.trim()) &&
    !("title" in input && typeof input.title === "string" && input.title.trim())) {
    throw new CreationConfigError("Task description required.");
  }
  return input;
}
