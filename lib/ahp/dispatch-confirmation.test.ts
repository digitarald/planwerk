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

test("cancellation during confirmation is ambiguous even if ping never settles", async () => {
  const controller = new AbortController();
  let dispatches = 0;
  const operation = dispatchAndConfirm({
    dispatch() { dispatches++; },
    ping() { return new Promise<void>(() => {}); },
  } as unknown as Pick<AhpClient, "dispatch" | "ping">, "chat:1",
  { type: "test" } as never, "delivery is ambiguous", controller.signal);
  controller.abort();
  await assert.rejects(operation, MessageDispatchAmbiguousError);
  assert.equal(dispatches, 1);
});

test("cancellation after ping confirmation does not turn a confirmed write into an abort", async () => {
  const controller = new AbortController();
  let confirm!: () => void;
  const ping = new Promise<void>((resolve) => { confirm = resolve; });
  const operation = dispatchAndConfirm({
    dispatch() {},
    ping: () => ping,
  } as unknown as Pick<AhpClient, "dispatch" | "ping">, "chat:1",
  { type: "test" } as never, "delivery is ambiguous", controller.signal);
  confirm();
  controller.abort();
  await operation;
});

test("cancellation before dispatch is a proven pre-dispatch abort", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(dispatchAndConfirm({
    dispatch() { assert.fail("must not dispatch"); },
    async ping() { assert.fail("must not ping"); },
  } as unknown as Pick<AhpClient, "dispatch" | "ping">, "chat:1",
  { type: "test" } as never, "delivery is ambiguous", controller.signal), { name: "AbortError" });
});
