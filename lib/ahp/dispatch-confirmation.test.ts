import assert from "node:assert/strict";
import { test } from "node:test";

import type { AhpClient } from "@microsoft/agent-host-protocol/client";

import {
  dispatchAndConfirm,
  MessageDispatchAmbiguousError,
} from "./dispatch-confirmation.ts";

test("a ping failure after dispatch is reported as ambiguous", async () => {
  let dispatches = 0;
  const client = {
    dispatch() {
      dispatches++;
    },
    async ping() {
      throw new Error("transport closed");
    },
  } as unknown as Pick<AhpClient, "dispatch" | "ping">;

  await assert.rejects(
    dispatchAndConfirm(
      client,
      "chat:1",
      { type: "test" } as never,
      "message may have been dispatched"
    ),
    MessageDispatchAmbiguousError
  );
  assert.equal(dispatches, 1);
});

test("a synchronous dispatch failure remains a proven pre-dispatch failure", async () => {
  const dispatchError = new Error("socket is not open");
  let pings = 0;
  const client = {
    dispatch() {
      throw dispatchError;
    },
    async ping() {
      pings++;
    },
  } as unknown as Pick<AhpClient, "dispatch" | "ping">;

  await assert.rejects(
    dispatchAndConfirm(
      client,
      "chat:1",
      { type: "test" } as never,
      "message may have been dispatched",
    ),
    (error: unknown) => error === dispatchError,
  );
  assert.equal(pings, 0);
});
