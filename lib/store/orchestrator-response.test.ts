import assert from "node:assert/strict";
import { test } from "node:test";

import { orchestratorHttpErrorMessage } from "./orchestrator-response.ts";

test("non-2xx chat errors preserve server detail and retry guidance", () => {
  assert.equal(
    orchestratorHttpErrorMessage(409, {
      error: "The CTO session is already active",
      retryable: true,
    }),
    "The CTO session is already active. Please retry shortly."
  );
  assert.equal(
    orchestratorHttpErrorMessage(500, {}),
    "CTO request failed with HTTP 500. Please try again."
  );
});
