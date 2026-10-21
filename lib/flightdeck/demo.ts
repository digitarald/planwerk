import { crewColorIndex, type Crew, type CrewMember } from "./crew.ts";

type Beat = Pick<CrewMember, "station" | "mode" | "task" | "detail" | "helpers">;

const SCRIPTS: Array<{ id: string; title: string; risk: CrewMember["risk"]; beats: Beat[] }> = [
  { id: "demo:offline", title: "Offline sync support", risk: "high", beats: [
    { station: "archive", mode: "working", task: "Reading", detail: "view src/sync/queue.ts", helpers: 0 },
    { station: "planning", mode: "working", task: "Briefing helpers", detail: "task", helpers: 2 },
    { station: "engineering", mode: "working", task: "Editing", detail: "apply_patch", helpers: 2 },
    { station: "bridge", mode: "reporting", task: "Needs your input", detail: "Keep both versions on conflict?", helpers: 1 },
  ] },
  { id: "demo:search", title: "Search results ranking", risk: "medium", beats: [
    { station: "scanner", mode: "working", task: "Searching", detail: "rg \"rankScore\"", helpers: 0 },
    { station: "engineering", mode: "working", task: "Editing", detail: "edit src/search/rank.ts", helpers: 0 },
    { station: "diagnostics", mode: "working", task: "Running tests", detail: "npm test -- rank", helpers: 0 },
    { station: "diagnostics", mode: "fault", task: "Hit a fault", detail: "Model request failed", helpers: 0 },
  ] },
  { id: "demo:release", title: "Release notes for v2.4", risk: "low", beats: [
    { station: "comms", mode: "working", task: "Calling out", detail: "web_fetch changelog", helpers: 0 },
    { station: "planning", mode: "working", task: "Planning", detail: "Outlining highlights", helpers: 0 },
    { station: "comms", mode: "working", task: "Shipping changes", detail: "git push origin release-notes", helpers: 0 },
  ] },
  { id: "demo:build", title: "Migrate to the new bundler", risk: "medium", beats: [
    { station: "fabricator", mode: "working", task: "Installing supplies", detail: "npm install", helpers: 3 },
    { station: "fabricator", mode: "working", task: "Building", detail: "npm run build", helpers: 3 },
    { station: "engineering", mode: "working", task: "Editing", detail: "edit build.config.ts", helpers: 1 },
  ] },
  { id: "demo:audit", title: "Accessibility audit", risk: "low", beats: [
    { station: "archive", mode: "working", task: "Researching", detail: "Reviewing focus order", helpers: 1 },
    { station: "bridge", mode: "reporting", task: "Needs approval", detail: "Run axe against staging?", helpers: 0 },
  ] },
  { id: "demo:idle-1", title: "Telemetry dashboard", risk: "low", beats: [{ station: "lounge", mode: "resting", task: "Off duty", helpers: 0 }] },
  { id: "demo:idle-2", title: "Onboarding copy pass", risk: "low", beats: [{ station: "lounge", mode: "resting", task: "Off duty", helpers: 0 }] },
  { id: "demo:idle-3", title: "Dependency bumps", risk: "low", beats: [{ station: "lounge", mode: "resting", task: "Off duty", helpers: 0 }] },
  { id: "demo:idle-4", title: "Flaky test triage", risk: "low", beats: [{ station: "lounge", mode: "resting", task: "Off duty", helpers: 0 }] },
  { id: "demo:idle-5", title: "Docs screenshots", risk: "low", beats: [{ station: "lounge", mode: "resting", task: "Off duty", helpers: 0 }] },
  { id: "demo:idle-6", title: "Settings cleanup", risk: "low", beats: [{ station: "lounge", mode: "resting", task: "Off duty", helpers: 0 }] },
  { id: "demo:idle-7", title: "Theme tokens", risk: "low", beats: [{ station: "lounge", mode: "resting", task: "Off duty", helpers: 0 }] },
];

/** A scripted shift for showing the flightdeck without live agents. */
export function demoCrew(tick: number): Crew {
  const members = SCRIPTS.map((script, index): CrewMember => {
    const beat = script.beats[Math.floor(tick / 2 + index * 0.5) % script.beats.length];
    return { id: script.id, title: script.title, colorIndex: crewColorIndex(script.id), risk: script.risk, ...beat };
  });
  return { members, offDuty: 0 };
}
