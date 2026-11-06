import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { callFoundry, DecisionTransportError } from "./transport.ts";

const names = ["PLANWERK_DECISION_ENDPOINT", "PLANWERK_DECISION_DEPLOYMENT", "PLANWERK_DECISION_API_KEY"] as const;
const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
afterEach(() => {
  mock.restoreAll();
  for (const name of names) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});
function setup() {
  process.env.PLANWERK_DECISION_ENDPOINT = "https://synthetic.services.ai.azure.com";
  process.env.PLANWERK_DECISION_DEPLOYMENT = "synthetic-deployment";
  process.env.PLANWERK_DECISION_API_KEY = "test-only-not-a-credential";
}
const questions = { safe: { type: "noul" as const, instructions: "Is this synthetic evidence safe?" } };
const payload = { model: "underlying-model", answers: { safe: { type: "noul", noul: 0.99 } },
  usage: { input_tokens: 2, output_tokens: 1 } };

test("Foundry uses deployment names, no redirects, bounded cancellation, and preserves the returned model", async () => {
  setup();
  const fetch = mock.method(globalThis, "fetch", async (url: string | URL | Request, options?: RequestInit) => {
    assert.equal(url, "https://synthetic.services.ai.azure.com/providers/microsoft/v1/systemone");
    assert.equal(options?.redirect, "error");
    assert.equal(options?.cache, "no-store");
    assert.ok(options?.signal);
    assert.equal(JSON.parse(String(options?.body)).model, "synthetic-deployment");
    return Response.json(payload);
  });
  assert.equal((await callFoundry("Synthetic input", questions)).model, "underlying-model");
  assert.equal(fetch.mock.callCount(), 1);
});

test("invalid setup or request never reaches the network", async () => {
  setup();
  const fetch = mock.method(globalThis, "fetch", async () => { throw Error("Unexpected network"); });
  for (const endpoint of ["http://localhost", "https://example.com", "https://synthetic.services.ai.azure.com/redirect"]) {
    process.env.PLANWERK_DECISION_ENDPOINT = endpoint;
    await assert.rejects(callFoundry("Synthetic", questions), /Configure/);
  }
  setup();
  await assert.rejects(callFoundry({ count: NaN }, questions), /finite/);
  await assert.rejects(callFoundry("x".repeat(128 * 1024), questions), /128 KiB/);
  await assert.rejects(callFoundry("", questions), /nonempty/);
  assert.equal(fetch.mock.callCount(), 0);
});

test("rate limits expose bounded retry advice without making a second request", async () => {
  setup();
  const fetch = mock.method(globalThis, "fetch", async () => new Response(null, { status: 429, headers: { "Retry-After": "45" } }));
  await assert.rejects(callFoundry("Synthetic", questions),
    (error: unknown) => error instanceof DecisionTransportError && error.retryAfterMs === 45_000);
  assert.equal(fetch.mock.callCount(), 1);
});

test("auth failures, malformed responses, and oversized streams never produce a decision", async () => {
  setup();
  const fetch = mock.method(globalThis, "fetch", async () => new Response(null, { status: 401 }));
  await assert.rejects(callFoundry("Synthetic", questions),
    (error: unknown) => error instanceof DecisionTransportError && error.retryAfterMs === undefined);
  fetch.mock.mockImplementation(async () => new Response("not JSON"));
  await assert.rejects(callFoundry("Synthetic", questions), SyntaxError);
  fetch.mock.mockImplementation(async () => new Response("x".repeat(1024 * 1024 + 1)));
  await assert.rejects(callFoundry("Synthetic", questions), /1 MiB/);
});
