import "server-only";

import path from "node:path";
import { dataDirectory } from "../data-directory";

import { CopilotClient } from "@github/copilot-sdk";

import {
  CopilotRuntimeManager,
  classifyCopilotFailure,
  isCopilotRuntimeInvalidatingFailure,
  type CopilotRuntimeHealth,
  type CopilotRuntimeLease,
} from "./sdk-runtime-manager";

const PLANWERK_COPILOT_BASE_DIRECTORY = path.join(
  dataDirectory(),
  "copilot-sdk"
);

const manager = new CopilotRuntimeManager({
  createClient: () =>
    new CopilotClient({
      mode: "empty",
      workingDirectory: process.env.PLANWERK_DATA_DIR || process.cwd(),
      baseDirectory: PLANWERK_COPILOT_BASE_DIRECTORY,
      clientInfo: {
        applicationName: "planwerk",
        applicationVersion: "0.1.0",
        integrationName: "orchestrator",
        integrationVersion: "1.0.0",
      },
    }),
});

export function getCopilotRuntimeClient(): Promise<CopilotClient> {
  return manager.getClient();
}

export function acquireCopilotRuntimeClient(): Promise<
  CopilotRuntimeLease<CopilotClient>
> {
  return manager.acquireClient();
}

export function resetCopilotRuntime(
  failedClient: CopilotClient | undefined,
  reason: unknown
): Promise<boolean> {
  if (!isCopilotRuntimeInvalidatingFailure(reason)) {
    return Promise.resolve(false);
  }
  return manager.reset(failedClient, reason);
}

export {
  classifyCopilotFailure,
  isCopilotRuntimeInvalidatingFailure,
};

export function getCopilotRuntimeHealth(): CopilotRuntimeHealth {
  return manager.getHealth();
}

export function checkCopilotRuntimeHealth(): Promise<CopilotRuntimeHealth> {
  return manager.checkHealth();
}

export function shutdownCopilotRuntime(): Promise<void> {
  return manager.shutdown();
}
