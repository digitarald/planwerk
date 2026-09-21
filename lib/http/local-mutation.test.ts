import assert from "node:assert/strict";
import { test } from "node:test";

import {
  validateLocalEventStreamRequest,
  validateLocalMutationRequest,
} from "./local-mutation.ts";

function mutationRequest(
  url: string,
  headers: Record<string, string>,
  method = "POST",
): Request {
  return new Request(url, { method, headers });
}

const validOrigins = [
  "http://127.0.0.1:3000",
  "http://localhost:3000",
  "http://[::1]:3000",
];

test("local mutation guard accepts supported loopback same-origin JSON requests", () => {
  for (const origin of validOrigins) {
    const host = new URL(origin).host;
    const request = mutationRequest(
      `${origin}/api/ahp/sessions`,
      {
        host,
        origin,
        "sec-fetch-site": "same-origin",
        "content-type": "application/json; charset=utf-8",
      },
    );
    assert.equal(validateLocalMutationRequest(request), null, origin);
  }

  const deleteRequest = mutationRequest(
    "http://127.0.0.1:3000/api/orchestrator/chat",
    {
      host: "127.0.0.1:3000",
      origin: "http://127.0.0.1:3000",
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
    },
    "DELETE",
  );
  assert.equal(validateLocalMutationRequest(deleteRequest, "DELETE"), null);
});

test("local mutation guard rejects non-local, cross-origin, and non-JSON requests", () => {
  const baseHeaders = {
    host: "127.0.0.1:3000",
    origin: "http://127.0.0.1:3000",
    "sec-fetch-site": "same-origin",
    "content-type": "application/json",
  };
  const cases: Array<{
    name: string;
    url?: string;
    method?: string;
    headers?: Record<string, string>;
  }> = [
    {
      name: "cross-origin Origin",
      headers: { origin: "http://attacker.example" },
    },
    {
      name: "cross-site Fetch Metadata",
      headers: { "sec-fetch-site": "cross-site" },
    },
    {
      name: "browser-simple text/plain",
      headers: { "content-type": "text/plain" },
    },
    {
      name: "unsupported JSON-derived media type",
      headers: { "content-type": "application/problem+json" },
    },
    {
      name: "non-loopback Host",
      url: "http://planwerk.example/api/ahp/sessions",
      headers: {
        host: "planwerk.example",
        origin: "http://planwerk.example",
      },
    },
    {
      name: "missing Origin",
      headers: { origin: "" },
    },
    {
      name: "unsupported method",
      method: "PUT",
    },
  ];

  for (const entry of cases) {
    const request = mutationRequest(
      entry.url ?? "http://127.0.0.1:3000/api/ahp/sessions",
      { ...baseHeaders, ...entry.headers },
      entry.method,
    );
    assert.notEqual(validateLocalMutationRequest(request), null, entry.name);
  }
});

test("local event stream guard accepts loopback same-origin GET without Content-Type", () => {
  for (const origin of validOrigins) {
    const request = new Request(`${origin}/api/ahp/events`, {
      headers: {
        host: new URL(origin).host,
        origin,
        "sec-fetch-site": "same-origin",
      },
    });
    assert.equal(validateLocalEventStreamRequest(request), null, origin);

    const eventSourceRequest = new Request(`${origin}/api/ahp/events`, {
      headers: {
        host: new URL(origin).host,
        "sec-fetch-site": "same-origin",
      },
    });
    assert.equal(
      validateLocalEventStreamRequest(eventSourceRequest),
      null,
      `${origin} without Origin`,
    );
  }
});

test("local event stream guard rejects non-local and cross-origin requests", () => {
  const baseHeaders = {
    host: "127.0.0.1:3000",
    origin: "http://127.0.0.1:3000",
    "sec-fetch-site": "same-origin",
  };
  const cases: Array<{
    name: string;
    url?: string;
    method?: string;
    headers?: Record<string, string>;
  }> = [
    {
      name: "cross-origin Origin with omitted workspace scope",
      headers: { origin: "http://attacker.example" },
    },
    {
      name: "cross-site Fetch Metadata",
      headers: { "sec-fetch-site": "cross-site" },
    },
    {
      name: "non-loopback Host",
      url: "http://planwerk.example/api/ahp/events",
      headers: {
        host: "planwerk.example",
        origin: "http://planwerk.example",
      },
    },
    {
      name: "missing Origin and Fetch Metadata",
      headers: { origin: "", "sec-fetch-site": "" },
    },
    {
      name: "unsupported method",
      method: "POST",
    },
  ];

  for (const entry of cases) {
    const request = new Request(
      entry.url ?? "http://127.0.0.1:3000/api/ahp/events",
      {
        method: entry.method,
        headers: { ...baseHeaders, ...entry.headers },
      },
    );
    assert.notEqual(validateLocalEventStreamRequest(request), null, entry.name);
  }
});
