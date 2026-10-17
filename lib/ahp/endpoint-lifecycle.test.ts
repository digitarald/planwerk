import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { after, test } from "node:test";

const state: {
  candidates: string[];
  discoveries: number;
  sockets: Array<{ terminate(): void; terminated: boolean; close(): void }>;
  mode: "healthy" | "hung" | "catalog-hung" | "initialize-hung";
} = { candidates: [], discoveries: 0, sockets: [], mode: "healthy" };
const key = "__planwerkEndpointLifecycle";
const actualClientUrl = import.meta.resolve("@microsoft/agent-host-protocol/client");
Object.defineProperty(globalThis, key, { value: state, configurable: true });
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    let source: string | undefined;
    if (specifier === "ws") source = `
      import { EventEmitter } from "node:events";
      export default class FakeSocket extends EventEmitter {
        static OPEN=1; static CONNECTING=0; readyState=0; terminated=false;
        constructor(url) {
          super();
          const s=globalThis["${key}"];
          this.mode=s.mode;
          if(s.candidates.length > s.sockets.length) this.mode=s.candidates[s.sockets.length];
          s.sockets.push(this);
          if(this.mode !== "hung") queueMicrotask(()=>{this.readyState=1;this.emit("open");});
        }
        close(){this.readyState=3;this.emit("close",1000);}
        terminate(){this.terminated=true;this.close();}
        send(){}
      }`;
    if (specifier === "./local-endpoint-registry.ts") source = `
      export async function discoverLocalEditorEndpoints() {
        const s=globalThis["${key}"];s.discoveries++;
        return s.candidates.map((name,index)=>({socketPath:name,modifiedAt:index}));
      }`;
    if (specifier === "@microsoft/agent-host-protocol/client" && context.parentURL?.endsWith("/endpoint.ts")) source = `
      export {TransportError} from "${actualClientUrl}";
      export class AhpClient {
        constructor(transport){this.transport=transport;}
        connect(){}
        async initialize(){
          if(this.transport.socket.mode==="initialize-hung") return new Promise((resolve,reject)=>{this.reject=reject;});
          return {protocolVersion:"1.0.0"};
        }
        async request(){
          if(this.transport.socket.mode==="catalog-hung") return new Promise((resolve,reject)=>{this.reject=reject;});
          return {items:[{resource:"fake"}]};
        }
        async shutdown(){this.reject?.(new Error("closed"));this.transport.close();}
      }`;
    if (source) return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(source)}` };
    return nextResolve(specifier, context);
  },
});
after(() => { hooks.deregister(); Reflect.deleteProperty(globalThis, key); });
const { connectInitializedAhpClient, connectAhpTransport, clearDesktopEndpointCache } = await import("./endpoint.ts");
const tick = async () => {
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};
function reset() {
  clearDesktopEndpointCache();
  state.candidates = [];
  state.discoveries = 0;
  state.sockets.length = 0;
  state.mode = "healthy";
}

test("a hung candidate times out without hiding a healthy candidate; discovery is single-flight", async (t) => {
  reset();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  state.candidates = ["hung", "healthy"];
  const first = connectInitializedAhpClient("vscode-local://desktop");
  const second = connectInitializedAhpClient("vscode-local://desktop");
  await tick();
  assert.equal(state.discoveries, 1);
  t.mock.timers.tick(15_000);
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.diagnostics.compatibleCandidateCount, 1);
  assert.equal(b.diagnostics.resolvedTarget, "healthy");
  assert.equal(state.sockets[0].terminated, true);
  await a.client.shutdown();
  await b.client.shutdown();
});

test("the whole probe expires even if catalog requests never settle", async (t) => {
  reset();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  state.candidates = ["catalog-hung", "healthy"];
  const connecting = connectInitializedAhpClient("vscode-local://desktop");
  await tick();
  t.mock.timers.tick(15_000);
  const result = await connecting;
  assert.equal(result.diagnostics.resolvedTarget, "healthy");
  await result.client.shutdown();
});

test("remote handshakes have deadlines and abort terminates the owned socket", async (t) => {
  reset();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  state.mode = "hung";
  const connecting = connectAhpTransport("ws://fake");
  const failure = assert.rejects(connecting, /timed out/);
  t.mock.timers.tick(15_000);
  await failure;
  assert.equal(state.sockets[0].terminated, true);
  const controller = new AbortController();
  const aborted = connectAhpTransport("ws://fake", controller.signal);
  const rejection = assert.rejects(aborted, { name: "AbortError" });
  controller.abort();
  await rejection;
  assert.equal(state.sockets[1].terminated, true);
});

test("cancelling a shared discovery waiter does not cancel other callers", async (t) => {
  reset();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  state.candidates = ["hung", "healthy"];
  const controller = new AbortController();
  const first = connectInitializedAhpClient("vscode-local://desktop", { signal: controller.signal });
  const rejected = assert.rejects(first, { name: "AbortError" });
  const second = connectInitializedAhpClient("vscode-local://desktop");
  await tick();
  controller.abort();
  await rejected;
  t.mock.timers.tick(15_000);
  const result = await second;
  assert.equal(state.discoveries, 1);
  await result.client.shutdown();
});

test("abort during initialize closes the owned connection and rejects promptly", async () => {
  reset();
  state.mode = "initialize-hung";
  const controller = new AbortController();
  const connecting = connectInitializedAhpClient("ws://fake", { signal: controller.signal });
  const rejected = assert.rejects(connecting, { name: "AbortError" });
  await tick();
  controller.abort();
  await rejected;
});
