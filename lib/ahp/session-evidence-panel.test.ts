import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { after, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import type { KanbanCard } from "../types.ts";

const reactUrl = import.meta.resolve("react");
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@/components/ui/button") return {
      shortCircuit: true,
      url: `data:text/javascript,${encodeURIComponent(`import {createElement} from "${reactUrl}";export function Button({variant,size,...props}){return createElement("button",props);}`)}`,
    };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith("/session-evidence-panel.tsx")) return {
      shortCircuit: true, format: "module",
      source: ts.transpileModule(readFileSync(new URL(url), "utf8"), {
        compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ESNext },
      }).outputText,
    };
    return nextLoad(url, context);
  },
});
after(() => hooks.deregister());
const { SessionEvidencePanel } = await import("../../components/board/session-evidence-panel.tsx");
const card: KanbanCard = {
  id: "a", title: "A", phase: "build", runtime: "idle", gateStatus: "pending", risk: "high",
  attention: "stale", activity: "", additions: 0, deletions: 0, filesChanged: 0,
  modifiedAt: 0, planSteps: { total: 0, done: 0 },
};
test("lean disclosure exposes capture time, scope, warning and limits without claiming gate approval", () => {
  const html = renderToStaticMarkup(createElement(SessionEvidencePanel, {
    card: { ...card, evidence: {
      state: "stale", capture: { capturedAt: "2026-10-16T00:00:00Z", source: "explicit", coverage: "bytes" },
    } },
    connected: true, refreshState: "idle", onRefresh() {},
  }));
  assert.match(html, /<details/);
  assert.match(html, /Evidence out of date/);
  assert.match(html, /dateTime="2026-10-16T00:00:00.000Z"/i);
  assert.match(html, /explicit refresh/);
  assert.match(html, /not an approved gate/);
  assert.match(html, /May restore the session and change its activity time/);
  assert.match(html, /256 files, 32 MiB, 30 seconds/);
  assert.equal((html.match(/<button/g) ?? []).length, 1);
});
test("conflicts reveal recovery in place, hide refresh and never pose a system wait as approval", () => {
  const html = renderToStaticMarkup(createElement(SessionEvidencePanel, {
    card: { ...card, ownershipConflict: true, automationWait: {
      reason: "ownership", summary: "Two hosts claim this session.", nextStep: "Choose the host that owns this work.",
    } },
    connected: true, refreshState: "idle", onRefresh() {},
    ownershipRecovery: createElement("button", {}, "Resolve ownership"),
  }));
  assert.match(html, /<details[^>]* open=""/);
  assert.match(html, /Two hosts claim/);
  assert.match(html, /Resolve ownership/);
  assert.doesNotMatch(html, /Refresh evidence/);
  assert.equal((html.match(/<button/g) ?? []).length, 1);
});

test("refresh busy and failed states are explicit and unavailable evidence never claims freshness", () => {
  const busy = renderToStaticMarkup(createElement(SessionEvidencePanel, {
    card, connected: true, refreshState: "refreshing", onRefresh() {},
  }));
  assert.match(busy, /disabled=""/);
  assert.match(busy, /aria-busy="true"/);
  assert.match(busy, /Evidence unavailable/);
  const failed = renderToStaticMarkup(createElement(SessionEvidencePanel, {
    card, connected: true, refreshState: "error", refreshError: "Session changed during capture.", onRefresh() {},
  }));
  assert.match(failed, /role="alert"/);
  assert.match(failed, /Session changed during capture/);
  assert.doesNotMatch(failed, /Collection finished/);
});

test("overlap waits retain a separate gate explanation, while other-host views omit irrelevant refresh controls", () => {
  const overlap = renderToStaticMarkup(createElement(SessionEvidencePanel, {
    card: { ...card, gateBlocker: "Code review pending", automationWait: {
      reason: "service", summary: "Overlap reviewer unavailable.", nextStep: "Retry is automatic.",
    } },
    connected: true, refreshState: "idle", onRefresh() {},
  }));
  assert.match(overlap, /Required gate: Code review pending/);
  const otherHost = renderToStaticMarkup(createElement(SessionEvidencePanel, {
    card: { ...card, automationWait: {
      reason: "ownership", summary: "Managed by another host.", nextStep: "Connect to the selected host.",
    } },
    connected: true, refreshState: "idle", onRefresh() {},
  }));
  assert.doesNotMatch(otherHost, /<button/);
  assert.doesNotMatch(otherHost, /Full refresh limit/);
});
