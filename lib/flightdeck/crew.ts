import type { KanbanCard, RiskLevel, SessionCurrentTool } from "../types.ts";

/** Work stations aboard the flightdeck. The bridge and lounge are not work. */
export type StationId =
  | "archive"
  | "scanner"
  | "planning"
  | "engineering"
  | "fabricator"
  | "diagnostics"
  | "comms"
  | "bridge"
  | "lounge";

export type CrewMode = "working" | "reporting" | "resting" | "fault";

export interface CrewMember {
  id: string;
  title: string;
  colorIndex: number;
  station: StationId;
  mode: CrewMode;
  /** Short verb phrase for what the agent is doing, e.g. "Running tests". */
  task: string;
  /** Raw source of the task (command, tool or activity text), shown on hover. */
  detail?: string;
  risk: RiskLevel;
  /** Active subagents, rendered as helper robots. */
  helpers: number;
  project?: string;
}

export interface Crew {
  members: CrewMember[];
  /** Idle sessions beyond the lounge capacity. */
  offDuty: number;
}

export const STATION_NAMES: Record<StationId, string> = {
  archive: "Archive",
  scanner: "Sensor array",
  planning: "Strategy table",
  engineering: "Engineering bench",
  fabricator: "Fabricator",
  diagnostics: "Diagnostics bay",
  comms: "Comms deck",
  bridge: "Mission control",
  lounge: "Crew lounge",
};

/** The VS Code chat pet's color presets (Stable, Insiders, Exploration, …) plus a few more. */
export const CREW_COLORS = [
  "#23a8f2", "#24bfa5", "#ff8c00", "#e6536f", "#e6c94d", "#55b85a", "#a277e6", "#ed83b5",
  "#f1f5f9", "#4dd0e1", "#9ccc65", "#ffb74d", "#7986cb", "#f06292", "#ff7a59", "#5c9dff",
] as const;

/** Ping-pong (2), arcade (2), chess (2) and couch (3). */
export const LOUNGE_CAPACITY = 9;

type WorkStation = Exclude<StationId, "bridge" | "lounge">;
interface Classification { station: WorkStation; task: string }

const SHELL_RULES: Array<[RegExp, Classification]> = [
  // The leading program decides first, so `rg "test"` is a search, not a test run.
  [/^\s*(rg|grep|find|fd|ag)\b/, { station: "scanner", task: "Searching" }],
  [/^\s*(cat|head|tail|less|ls|tree|wc)\b|^\s*git (diff|log|status|show|blame)\b/, { station: "archive", task: "Reading" }],
  [/\b(test|tests|jest|vitest|pytest|mocha|playwright|cypress|node --test|go test|cargo test|dotnet test)\b/, { station: "diagnostics", task: "Running tests" }],
  [/\b(lint|eslint|prettier|ruff|typecheck|clippy|format)\b|tsc --noemit/, { station: "diagnostics", task: "Running checks" }],
  [/\bgit (commit|push|tag|merge|rebase)\b|\bgh (pr|release)\b/, { station: "comms", task: "Shipping changes" }],
  [/\b(npm|pnpm|yarn|bun|pip|cargo|go|dotnet|brew) (i|install|add|ci|restore|get|mod)\b/, { station: "fabricator", task: "Installing supplies" }],
  [/\b(build|compile|tsc|make|webpack)\b/, { station: "fabricator", task: "Building" }],
  [/\b(curl|wget)\b|\bgh api\b/, { station: "comms", task: "Calling out" }],
];

const TOOL_RULES: Array<[RegExp, Classification]> = [
  [/^(view|read|read_file|show_file|cat|lsp|fetch_copilot_cli_documentation|list_dir|listdir)$/, { station: "archive", task: "Reading" }],
  [/^(grep|rg|glob|search|file_search|semantic_search|search_code\w*|tool_search\w*|codebase_search)$/, { station: "scanner", task: "Searching" }],
  [/^(edit|create|apply_patch|str_replace\w*|insert|write|write_file|replace_string_in_file|multi_replace\w*|notebook_edit)$/, { station: "engineering", task: "Editing" }],
  [/^(web_fetch|web_search|fetch|create_pull_request|github\S*|gh\S*)$/, { station: "comms", task: "Calling out" }],
  [/^(task|write_agent|read_agent|list_agents|runsubagent|delegate\w*)$/, { station: "planning", task: "Briefing helpers" }],
  [/^(think|sql|update_todo|manage_todo_list|report_intent|skill|store_memory|exit_plan_mode|propose_work)$/, { station: "planning", task: "Planning" }],
  [/^(code_review|codeql_checker|parallel_validation|run_tests?|get_errors)$/, { station: "diagnostics", task: "Checking work" }],
  [/^(read_bash|write_bash|stop_bash|list_bash|read_powershell|write_powershell|stop_powershell)$/, { station: "fabricator", task: "Tending a machine" }],
];

const ACTIVITY_RULES: Array<[RegExp, Classification]> = [
  [/\b(test|verif|validat|check|lint|typecheck|diagnos|debug|reproduc|qa)\w*/, { station: "diagnostics", task: "Testing" }],
  [/\b(build|compil|bundl|install|depend|packag|setup|set up|configur)\w*/, { station: "fabricator", task: "Building" }],
  [/\b(commit|push|pull request|publish|deploy|releas|ship|merg|sync)\w*|\bpr\b/, { station: "comms", task: "Shipping" }],
  [/\b(search|find|grep|locat|hunt|scan)\w*|\blook(ing)? for\b/, { station: "scanner", task: "Searching" }],
  [/\b(read|explor|investigat|inspect|review|research|understand|analy|learn|fetch|docs|documentation|context|gather)\w*/, { station: "archive", task: "Researching" }],
  [/\b(plan|design|think|outlin|brainstorm|draft|decid|architect|consider|reason|propos|delegat|coordinat)\w*/, { station: "planning", task: "Planning" }],
  [/\b(implement|edit|writ|fix|updat|add|refactor|creat|chang|modif|apply|patch|wir|clean|remov|renam|migrat|polish|improv|code|port)\w*/, { station: "engineering", task: "Building it" }],
];

const SHELL_TOOL = /^(bash|powershell|shell|run_in_terminal|terminal)$/i;

function firstMatch(rules: Array<[RegExp, Classification]>, text: string): Classification | undefined {
  return rules.find(([pattern]) => pattern.test(text))?.[1];
}

/** Each `&&`/`;` segment is classified on its own; the furthest-along step wins. */
function classifyShell(command: string): Classification | undefined {
  const READ_RULES = 2; // the first two rules only look around; any action in the chain outranks them
  let best: { rank: number; match: Classification } | undefined;
  for (const segment of command.split(/&&|\|\||;/)) {
    const rule = SHELL_RULES.findIndex(([pattern]) => pattern.test(segment));
    if (rule < 0) continue;
    const rank = rule < READ_RULES ? rule + SHELL_RULES.length : rule;
    if (!best || rank < best.rank) best = { rank, match: SHELL_RULES[rule][1] };
  }
  return best?.match;
}

/** Tool first (what the hands are doing), then reported intent, then a calm default. */
export function classifyWork(tool: SessionCurrentTool | undefined, activity: string): Classification & { detail?: string } {
  if (tool) {
    if (SHELL_TOOL.test(tool.name)) {
      const command = tool.command?.toLowerCase() ?? "";
      const match = command ? classifyShell(command) : undefined;
      return { ...(match ?? { station: "fabricator", task: "Running a command" }), detail: tool.command ?? tool.displayName };
    }
    const match = firstMatch(TOOL_RULES, tool.name.toLowerCase());
    if (match) return { ...match, detail: tool.displayName ?? tool.name };
  }
  const text = activity.trim().toLowerCase();
  const match = text && text !== "thinking" ? firstMatch(ACTIVITY_RULES, text) : undefined;
  if (match) return { ...match, detail: activity };
  if (tool) return { station: "comms", task: "Using a tool", detail: tool.displayName ?? tool.name };
  return { station: "planning", task: "Thinking", detail: activity || undefined };
}

export function crewColorIndex(id: string): number {
  let hash = 2166136261;
  for (let index = 0; index < id.length; index++) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % CREW_COLORS.length;
}

function activeHelpers(card: KanbanCard): number {
  return card.workers?.filter((worker) => worker.isActive).length ?? 0;
}

export function crewMemberFromCard(card: KanbanCard): CrewMember {
  const base = {
    id: card.id,
    title: card.title || "Untitled session",
    colorIndex: crewColorIndex(card.id),
    risk: card.risk,
    helpers: activeHelpers(card),
    project: card.project?.name,
  };
  if (card.runtime === "input-needed") {
    const task = card.pendingInput?.kind === "toolConfirmation" ? "Needs approval" : "Needs your input";
    return { ...base, station: "bridge", mode: "reporting", task, detail: card.pendingInput?.message ?? (card.activity || undefined) };
  }
  if (card.runtime === "error") {
    const work = classifyWork(undefined, card.activity);
    return { ...base, station: work.station, mode: "fault", task: "Hit a fault", detail: card.runtimeError?.message ?? (card.activity || undefined) };
  }
  if (card.runtime === "idle") {
    return { ...base, helpers: 0, station: "lounge", mode: "resting", task: "Off duty" };
  }
  const work = classifyWork(card.currentTool, card.activity);
  return { ...base, station: work.station, mode: "working", task: work.task, detail: work.detail };
}

/** Archived cards never board. Idle crew beyond lounge capacity stay off-screen. */
export function buildCrew(cards: readonly KanbanCard[]): Crew {
  const members: CrewMember[] = [];
  const resting: Array<{ member: CrewMember; modifiedAt: number }> = [];
  for (const card of cards) {
    if (card.isArchived) continue;
    const member = crewMemberFromCard(card);
    if (member.mode === "resting") resting.push({ member, modifiedAt: card.modifiedAt });
    else members.push(member);
  }
  resting.sort((a, b) => b.modifiedAt - a.modifiedAt);
  members.push(...resting.slice(0, LOUNGE_CAPACITY).map((entry) => entry.member));
  return { members, offDuty: Math.max(0, resting.length - LOUNGE_CAPACITY) };
}
