# Kanban-Style SDLC Work Management System on Agent Host Protocol

## Executive Summary

This report investigates building an **AI-first SDLC kanban board** on top of Microsoft's [Agent Host Protocol (AHP)](https://github.com/microsoft/agent-host-protocol) — a synchronized, multi-client state protocol for AI agent sessions. The system would organize agent sessions as kanban cards, extract structured metadata via the [GitHub Copilot SDK](https://github.com/github/copilot-sdk), and run an autonomous orchestrator ("CTO agent") that monitors progress, intervenes on failures, and reduces developer micromanagement.

---

## 1. Agent Host Protocol (AHP) — Foundation Layer

### 1.1 What AHP Provides

AHP is a **transport-agnostic, JSON-RPC 2.0-based, stateful protocol** for managing synchronized AI agent sessions across multiple clients. Key properties:

- **Immutable state trees** mutated by ordered actions through pure reducers (Redux-like)
- **Channel-based architecture** — every resource is a URI-identified subscribable channel
- **Multi-client synchronization** — write-ahead with reconciliation
- **Real-time notifications** — `root/sessionAdded`, `root/sessionRemoved`, `root/sessionSummaryChanged`
- **Lazy loading** — subscribe on demand, large content by reference

> Source: [AHP README](https://github.com/microsoft/agent-host-protocol/blob/main/README.md), [What is AHP](https://github.com/microsoft/agent-host-protocol/blob/main/docs/guide/what-is-ahp.md)

### 1.2 Channel Architecture

| Channel | URI Pattern | Purpose |
|---------|-------------|---------|
| Root | `ahp-root://` | Global state: agents, terminals, active session count |
| Session | `ahp-session:/<uuid>` | Per-session lifecycle, chats, model/agent, customizations, changesets |
| Chat | `ahp-chat:/<cid>` | Per-conversation turns, streaming, tool calls, input requests |
| Terminal | `ahp-terminal:/<id>` | Terminal I/O state |
| Changeset | `ahp-changeset:/<id>` | File diff views (uncommitted, session-wide, per-turn) |

> Source: [`docs/specification/session-channel.md`](https://github.com/microsoft/agent-host-protocol/blob/main/docs/specification/session-channel.md)

### 1.3 Session State — The Basis for Card Metadata

The `SessionSummary` interface (from [`types/channels-session/state.ts`](https://github.com/microsoft/agent-host-protocol/blob/main/types/channels-session/state.ts)) provides the canonical source for card data:

```typescript
interface SessionSummary {
  resource: URI;              // Session URI (unique ID)
  provider: string;           // Agent provider (e.g. "copilot")
  title: string;              // Human-readable title → Card title
  status: SessionStatus;      // Bitset: Idle, InProgress, InputNeeded, Error, IsRead, IsArchived
  activity?: string;          // Current activity description → Card subtitle
  createdAt: number;          // → Card creation time
  modifiedAt: number;         // → Last activity timestamp
  project?: ProjectInfo;      // Server-owned project metadata
  model?: ModelSelection;     // Currently selected model
  agent?: AgentSelection;     // Custom agent selection
  workingDirectory?: URI;     // Working directory → Repo/path context
  changes?: ChangesSummary;   // { additions, deletions, files } → Progress indicator
  annotations?: AnnotationsSummary; // Lint/annotation counts
}
```

**Session status as kanban column driver:**
```typescript
enum SessionStatus {
  Idle = 1,                    // → "Done" or "Ready" column
  Error = 1 << 1,             // → "Blocked" column
  InProgress = 1 << 3,        // → "In Progress" column
  InputNeeded = (1<<3)|(1<<4), // → "Needs Input" column
  IsRead = 1 << 5,            // → Read/unread badge
  IsArchived = 1 << 6,        // → Archive/hidden
}
```

### 1.4 Real-Time Session List Maintenance

The root channel exposes commands and notifications for maintaining the session catalog:

| Method | Direction | Purpose |
|--------|-----------|---------|
| `listSessions` | Request | Fetch full session catalog |
| `root/sessionAdded` | Server → Client | New card appears |
| `root/sessionRemoved` | Server → Client | Card disposed |
| `root/sessionSummaryChanged` | Server → Client | Card metadata updated (title, status, activity, etc.) |

> Source: [`types/channels-root/notifications.ts`](https://github.com/microsoft/agent-host-protocol/blob/main/types/channels-root/notifications.ts), [`docs/specification/root-channel.md`](https://github.com/microsoft/agent-host-protocol/blob/main/docs/specification/root-channel.md)

### 1.5 Available Client SDKs

| Language | Package | Notes |
|----------|---------|-------|
| TypeScript | `@microsoft/agent-host-protocol` | Wire types, reducers, `AhpClient`, `WebSocketTransport` |
| Rust | `ahp`, `ahp-types`, `ahp-ws` | crates.io |
| Swift | `AgentHostProtocol`, `AgentHostProtocolClient` | SPM |
| Kotlin | `com.microsoft.agenthostprotocol:agent-host-protocol` | Maven Central |
| Go | `github.com/microsoft/agent-host-protocol/clients/go` | `ahptypes`, `ahp`, `ahpws` |

CLI tool: **[AHPX](https://github.com/TylerLeonhardt/ahpx)** — A command-line and Node.js client for AHP servers.

### 1.6 Reference Server

The reference AHP server lives in **VS Code**: [`src/vs/platform/agentHost/node/`](https://github.com/microsoft/vscode/tree/main/src/vs/platform/agentHost/node).

---

## 2. Copilot SDK — Extraction & Orchestration Engine

### 2.1 Overview

The [`@github/copilot-sdk`](https://www.npmjs.com/package/@github/copilot-sdk) is the official TypeScript SDK for embedding GitHub Copilot's agentic workflows. It provides:

- **Full agent runtime** — planning, tool invocation, file edits, multi-turn conversation
- **Session lifecycle management** — create, send, stream, destroy
- **Hook system** — intercept and modify agent behavior at every lifecycle stage
- **Event streams** — observe session activity in real-time

> Sources: [npm: @github/copilot-sdk](https://www.npmjs.com/package/@github/copilot-sdk), [GitHub Blog announcement](https://github.blog/news-insights/company-news/build-an-agent-into-any-app-with-the-github-copilot-sdk/), [Copilot SDK GA changelog](https://github.blog/changelog/2026-06-02-copilot-sdk-is-now-generally-available/)

### 2.2 Key APIs for This System

```typescript
import { CopilotClient } from "@github/copilot-sdk";

const client = new CopilotClient();
await client.start();

// Create extraction session
const session = await client.createSession({
  model: "gpt-5",
  streaming: true,
  hooks: {
    onSessionStart: async (input, invocation) => { /* inject board context */ },
    onPostToolUse: async (input, invocation) => { /* capture tool results */ },
    onErrorOccurred: async (input, invocation) => { /* alert orchestrator */ },
  }
});

// Extract card metadata from session content
session.on("assistant.message", (event) => { /* parse structured output */ });
session.on("session.idle", () => { /* mark extraction complete */ });
```

### 2.3 Session Hooks (Orchestrator Integration Points)

| Hook | Use Case in Board System |
|------|--------------------------|
| `onSessionStart` | Inject SDLC phase context, board state |
| `onUserPromptSubmitted` | Validate/rewrite prompts per card's phase |
| `onPreToolUse` | Gate destructive tools based on card status |
| `onPostToolUse` | Capture tool results as card artifacts |
| `onSessionEnd` | Transition card column, archive |
| `onErrorOccurred` | Trigger orchestrator intervention |

### 2.4 Event Streams for Monitoring

| Event | Board Use |
|-------|-----------|
| `assistant.message_delta` | Live progress streaming in card |
| `tool.execution.start` / `complete` | Activity timeline in card detail |
| `session.idle` | Mark card as waiting/done |
| `session.error` | Move card to "Blocked" column |

---

## 3. System Architecture

### 3.1 High-Level Design

```
┌─────────────────────────────────────────────────────────────┐
│                     KANBAN BOARD UI                          │
│  ┌──────┐  ┌──────────┐  ┌───────────┐  ┌──────┐  ┌────┐  │
│  │Backlog│  │In Progress│  │Needs Input│  │Review│  │Done│  │
│  └───┬───┘  └─────┬─────┘  └─────┬─────┘  └──┬───┘  └──┬─┘  │
└──────┼───────────┼──────────────┼───────────┼────────┼──┘
       │           │              │           │        │
┌──────┴───────────┴──────────────┴───────────┴────────┴──┐
│                  BOARD STATE ENGINE                       │
│  • Maps SessionSummary → Card                            │
│  • Applies column rules from status bitset               │
│  • Manages card metadata + artifacts                     │
└─────────────────────┬───────────────────────────────────┘
                      │
         ┌────────────┴────────────┐
         │                         │
┌────────▼─────────┐    ┌─────────▼──────────┐
│   AHP CLIENT     │    │  COPILOT SDK        │
│                  │    │  (Orchestrator)      │
│ • listSessions   │    │                      │
│ • subscribe      │    │ • Extract metadata   │
│ • notifications  │    │ • Run interventions  │
│ • createSession  │    │ • Monitor sessions   │
│ • disposeSession │    │ • Summarize progress │
└────────┬─────────┘    └─────────┬──────────┘
         │                         │
         └────────────┬────────────┘
                      │
              ┌───────▼────────┐
              │   AHP SERVER    │
              │  (VS Code Host) │
              │                 │
              │ Agent Sessions  │
              └─────────────────┘
```

### 3.2 Data Flow

1. **Session Discovery**: AHP client calls `listSessions` on `ahp-root://`, subscribes for real-time updates
2. **Card Hydration**: For each session, subscribe to `ahp-session:/<uuid>` to get `SessionState`
3. **Metadata Extraction**: Copilot SDK session analyzes conversation history → produces structured card data
4. **Column Assignment**: `SessionStatus` bitset maps to kanban columns
5. **Live Updates**: `root/sessionSummaryChanged` notifications drive card position changes
6. **Orchestrator Loop**: Periodic heartbeat or event-driven checks for stuck/failed sessions

---

## 4. Kanban Column Mapping

### 4.1 Recommended SDLC Columns

| Column | Trigger / Rule | Visual |
|--------|---------------|--------|
| **Backlog** | Manually created cards not yet started (custom metadata) | 📋 |
| **Planning** | Session active, no code changes yet (`changes.files === 0`) | 🗺️ |
| **In Progress** | `status & InProgress` AND `changes.files > 0` | 🔨 |
| **Needs Input** | `status & InputNeeded` | ⚠️ |
| **In Review** | Session has PR created (custom metadata or changeset operation) | 👀 |
| **Blocked/Error** | `status & Error` | 🚫 |
| **Done** | `status === Idle` AND all acceptance criteria met | ✅ |
| **Archived** | `status & IsArchived` | 📦 |

### 4.2 Card Metadata Schema (Extended)

```typescript
interface KanbanCard {
  // === From AHP SessionSummary ===
  sessionUri: string;           // ahp-session:/<uuid>
  title: string;                // Session title
  status: SessionStatus;        // Raw status bitset
  activity: string;             // Current activity string
  createdAt: number;
  modifiedAt: number;
  model: string;                // Model in use
  changes: ChangesSummary;      // { additions, deletions, files }
  workingDirectory: string;     // Repo path

  // === Extracted by Copilot SDK ===
  sdlcPhase: 'backlog' | 'planning' | 'development' | 'review' | 'testing' | 'done';
  summary: string;              // AI-generated summary of current state
  todos: TodoItem[];            // Extracted TODO list with progress
  plan: string;                 // Session plan (from plan.md or similar)
  blockers: string[];           // Known blockers
  artifacts: Artifact[];        // Research docs, plans, designs
  estimatedCompletion: number;  // AI-estimated % complete
  lastHumanInput: number;       // Timestamp of last human interaction
  needsAttention: boolean;      // Orchestrator flag
  attentionReason?: string;     // Why attention is needed

  // === Board-level metadata ===
  column: string;               // Current kanban column
  priority: number;             // 1-5 priority
  labels: string[];             // Tags/labels
  assignee?: string;            // Human assignee
  linkedPR?: string;            // GitHub PR URL
  linkedIssue?: string;         // GitHub issue URL
}
```

---

## 5. The Orchestrator ("CTO Agent")

### 5.1 Role

The orchestrator is an always-running Copilot SDK session that monitors the board and acts as an autonomous "CTO":

- **Monitors** all sessions for stuck, errored, or idle states
- **Intervenes** when sessions fail (retry, escalate, suggest fixes)
- **Informs** the user of issues requiring human decision
- **Optimizes** WIP limits and task ordering
- **Summarizes** progress across the board

### 5.2 Trigger Mechanisms

| Trigger | When | Action |
|---------|------|--------|
| `root/sessionSummaryChanged` | Any session state change | Evaluate if intervention needed |
| Heartbeat (30s–60s) | Periodic | Check for stale sessions, aggregate progress |
| `session.error` event | Session fails | Analyze error, attempt recovery or escalate |
| `InputNeeded` status | Session blocked on input | Notify user, suggest response |
| Manual trigger | User requests board review | Full board analysis and recommendations |
| Changeset update | Code changes land | Trigger review phase, update estimates |

### 5.3 Orchestrator Implementation

```typescript
import { CopilotClient } from "@github/copilot-sdk";
import { AhpClient, WebSocketTransport } from "@microsoft/agent-host-protocol";

class BoardOrchestrator {
  private ahp: AhpClient;
  private copilot: CopilotClient;
  private orchestratorSession: CopilotSession;

  async start() {
    // Connect to AHP host
    this.ahp = new AhpClient(new WebSocketTransport(AHP_SERVER_URL));
    await this.ahp.initialize();
    await this.ahp.subscribe("ahp-root://");

    // Start Copilot SDK
    this.copilot = new CopilotClient();
    await this.copilot.start();

    // Create persistent orchestrator session
    this.orchestratorSession = await this.copilot.createSession({
      model: "gpt-5",
      hooks: {
        onErrorOccurred: async (input) => {
          await this.handleOrchestratorError(input);
        }
      }
    });

    // Listen for board changes
    this.ahp.on("root/sessionSummaryChanged", (params) => {
      this.evaluateSession(params.session, params.changes);
    });

    // Heartbeat
    setInterval(() => this.heartbeat(), 30_000);
  }

  async evaluateSession(sessionUri: string, changes: Partial<SessionSummary>) {
    if (changes.status !== undefined) {
      const status = changes.status;
      if (status & SessionStatus.Error) {
        await this.handleError(sessionUri);
      } else if (status & SessionStatus.InputNeeded) {
        await this.notifyInputNeeded(sessionUri);
      }
    }
  }

  async heartbeat() {
    const sessions = await this.ahp.listSessions();
    for (const session of sessions) {
      const staleness = Date.now() - session.modifiedAt;
      if (staleness > STALE_THRESHOLD && session.status & SessionStatus.InProgress) {
        await this.investigateStaleSession(session);
      }
    }
  }

  async handleError(sessionUri: string) {
    // Use Copilot SDK to analyze the error and suggest recovery
    const response = await this.orchestratorSession.sendAndWait({
      prompt: `Session ${sessionUri} entered error state. Analyze the context and suggest recovery steps.`
    });
    // Notify user with analysis
    await this.notify(sessionUri, "error", response.data.content);
  }
}
```

### 5.4 Orchestrator Intervention Strategies

| Scenario | Detection | Intervention |
|----------|-----------|--------------|
| Session stuck (no progress 5min) | Heartbeat staleness check | Ping session, suggest next step |
| Repeated tool failures | `onErrorOccurred` hook count | Switch strategy, notify human |
| WIP limit exceeded | Card count per column | Block new work, suggest prioritization |
| Session drift (off-topic) | Copilot SDK analysis of recent turns | Redirect to original goal |
| Dependency conflict | Cross-session file overlap detection | Alert, suggest ordering |
| All sessions idle | Heartbeat finds no active work | Suggest next backlog item |

---

## 6. Quality Gates, Feedback Loops & Skill-Based Reviews

### 6.1 Core Principle: No Implicit Transitions

State transitions between kanban columns are **never automatic**. Every transition requires passing a **quality gate** — a combination of deterministic checks and indeterministic (AI-driven) reviews. The board engine enforces this; neither the session agent nor the user can bypass gates without explicit override.

```
┌─────────┐    Gate: Plan Review    ┌────────────┐    Gate: QA Pass    ┌──────┐
│ Planning │──────────────────────►│ Development │───────────────────►│ Done │
└─────────┘   ◄── feedback loop    └────────────┘  ◄── feedback loop  └──────┘
                  (revise plan)                        (fix failures)
```

### 6.2 Risk-Based Gate Intensity

The CTO orchestrator (or human) assigns a **risk level** to each card. Risk determines how rigorous the gates are:

| Risk Level | Plan Gate | Implementation Gate | Review Gate |
|-----------|-----------|-------------------|-------------|
| **Low** (typo fix, config) | Self-review sufficient | Lint + type check + implementation review | Concise `review.md`; auto-merge may be allowed |
| **Medium** (feature, refactor) | 1 adversarial review | Lint + types + tests + independent correctness/architecture review | Evidence synthesis in `review.md` + human review |
| **High** (security, core infra) | 2 adversarial reviews + human approval | Full test suite + coverage threshold + multiple implementation reviewers | Detailed `review.md` + human sign-off |

Risk can be:
- **Assumed** from heuristics (files touched, blast radius, keywords like "auth", "payment", "migration")
- **Extracted** by the CTO agent analyzing the plan/scope
- **Overridden** by the human at any time

```typescript
interface QualityGateConfig {
  phase: 'plan' | 'implementation' | 'review' | 'done';
  riskLevel: 'low' | 'medium' | 'high';
  deterministic: DeterministicCheck[];    // Must all pass
  indeterministic: IndeterministicCheck[]; // AI reviews
  requiredHumanApproval: boolean;
}

interface DeterministicCheck {
  id: string;
  name: string;           // e.g. "lint", "typecheck", "test"
  command?: string;       // e.g. "npm run lint"
  extractFromProject: boolean; // Auto-discover from package.json, Makefile, etc.
  status: 'pending' | 'running' | 'passed' | 'failed';
  output?: string;
}

interface IndeterministicCheck {
  id: string;
  name: string;           // e.g. "adversarial-plan-review", "code-review"
  skillName: string;      // Skill to invoke as sub-agent
  status: 'pending' | 'running' | 'passed' | 'needs-revision' | 'failed';
  feedback?: string;      // Review output fed back into session
  requiredBeforeTransition: boolean;
}
```

### 6.3 Adversarial Plan Review

Before transitioning from **Planning → Implementation**, the plan must survive adversarial review:

**What the adversarial reviewer challenges:**
- Ambiguous requirements or acceptance criteria
- Unstated assumptions about environment, dependencies, or APIs
- Missing error handling or edge case consideration
- Scope creep indicators
- Feasibility concerns given the codebase
- Security/performance blind spots

**Implementation as a skill:**
```typescript
// The adversarial review skill is injected into the session's available skills
const adversarialReviewSkill = {
  name: "adversarial-plan-review",
  description: "Critically review the session plan, challenge assumptions, and identify gaps",
  // Invoked as a sub-agent with access to the plan artifact
};
```

The review produces structured feedback:
```typescript
interface PlanReviewResult {
  verdict: 'approved' | 'needs-revision';
  challenges: Array<{
    category: 'assumption' | 'ambiguity' | 'missing-edge-case' | 'scope' | 'feasibility' | 'security';
    description: string;
    suggestion: string;
    severity: 'blocking' | 'important' | 'minor';
  }>;
  overallAssessment: string;
}
```

If `needs-revision`, the feedback is **injected back into the session conversation** and the card stays in Planning. The agent revises the plan and the gate re-triggers.

### 6.4 Implementation Quality Gates (Deterministic)

Before a session can transition from **Implementation → Review/Done**, deterministic checks must pass:

```typescript
interface ProjectQualityConfig {
  // Auto-extracted from project configuration
  lint?: { command: string; extractedFrom: string };     // e.g. from package.json "scripts.lint"
  typecheck?: { command: string; extractedFrom: string }; // e.g. "tsc --noEmit"
  test?: { command: string; extractedFrom: string };      // e.g. "npm test"
  build?: { command: string; extractedFrom: string };     // e.g. "npm run build"
  custom?: Array<{ name: string; command: string }>;     // Project-specific gates
}
```

**Per-project extraction**: The system inspects the project to discover what validation is available:
- `package.json` → npm scripts (lint, test, typecheck, build)
- `Makefile` / `Justfile` → make targets
- `.github/workflows/` → CI checks to mirror locally
- `pyproject.toml` / `Cargo.toml` / `go.mod` → language-specific tooling
- Custom config file (e.g., `.kanban-gates.yaml`)

**Feedback loop on failure:**
```
Session completes work → Gate runner executes lint/test/typecheck
  ├─ All pass → Transition to Review/Done ✓
  └─ Any fail → Failure output injected into session conversation
                 → Card stays in "Implementation"
                 → Agent sees errors and fixes them
                 → Loop repeats until pass
```

### 6.5 Hybrid Deterministic + Indeterministic Gate Engine

The key insight: **some gates are deterministic** (did linting pass? yes/no) and **some are indeterministic** (does this plan make sense? is the code quality good?). The board engine treats them differently:

| Property | Deterministic | Indeterministic |
|----------|--------------|-----------------|
| Execution | Run command, check exit code | Invoke sub-agent skill |
| Result | Binary pass/fail | Verdict + structured feedback |
| Retry cost | Cheap (just re-run) | Expensive (tokens) |
| When to trigger | Always on transition attempt | Based on risk + whether already ran |
| Feedback format | Raw CLI output (errors, warnings) | Natural language review |

### 6.6 Skills as Review Injection Mechanism

Reviews are implemented as **skills** (sub-agents) that can be:
1. **Invoked by the session agent itself** during its work (agent-initiated)
2. **Enforced by the gate engine** when the session signals completion (system-initiated)

This dual-invocation model solves token efficiency:

```
Session agent does work...
  │
  ├─ Agent invokes review skill during work (self-directed)
  │   → Skill runs, feedback integrated
  │   → Gate engine sees skill was used ✓
  │   → No forced re-run needed
  │
  └─ Agent signals "done" WITHOUT invoking review skill
      → Gate engine detects missing review
      → Automatically triggers review skill externally
      → Feedback injected into session
      → Session continues (stays in current column)
```

**Detection mechanism:**
```typescript
interface GateEnforcement {
  // When session transitions to Idle (signals "done")
  onSessionIdle(session: SessionState): void {
    const requiredSkills = this.getRequiredSkills(session, session.currentPhase);

    for (const skill of requiredSkills) {
      const wasInvoked = this.checkSkillInvocationInSession(session, skill.name);

      if (wasInvoked) {
        // Skill already ran within the session — check its result
        const result = this.getSkillResult(session, skill.name);
        if (result.verdict === 'approved') {
          continue; // Gate passes
        } else {
          // Already ran but didn't pass — feedback already in conversation
          // Keep in current column, agent should already be addressing it
        }
      } else {
        // Skill was NOT invoked — enforce it now
        await this.triggerSkillExternally(session, skill);
        // This injects the review into the session, keeping it in current column
      }
    }
  }

  checkSkillInvocationInSession(session: SessionState, skillName: string): boolean {
    // Inspect session's tool call history for the skill invocation
    // AHP exposes tool calls in the chat channel state
    // Look for toolCallComplete actions where tool.name matches skillName
    return session.chats
      .flatMap(chat => chat.turns)
      .some(turn => turn.toolCalls?.some(tc => tc.name === skillName && tc.status === 'complete'));
  }
}
```

### 6.7 Skill Definitions for Reviews

```typescript
// These skills are registered as AHP customizations (MCP servers or built-in tools)
const reviewSkills: SkillDefinition[] = [
  {
    name: "adversarial-plan-review",
    phases: ['planning'],
    description: "Challenge plan assumptions, identify gaps, and rate confidence",
    agentPrompt: `You are an adversarial reviewer. Your job is to find weaknesses in plans.
      Challenge every assumption. Ask what happens when things go wrong.
      Rate your confidence that this plan will succeed without revision.`,
    outputSchema: { verdict: 'approved' | 'needs-revision', challenges: Challenge[] }
  },
  {
    name: "code-review",
    phases: ['implementation'],
    description: "Review code changes for correctness, security, and maintainability",
    agentPrompt: `Review the code changes. Focus on bugs, security issues, and logic errors.
      Do not comment on style. Only flag issues that genuinely matter.`,
    outputSchema: { verdict: 'approved' | 'needs-revision', issues: Issue[] }
  },
  {
    name: "test-coverage-review",
    phases: ['implementation'],
    description: "Assess whether test coverage is adequate for the changes made",
    agentPrompt: `Analyze the code changes and existing tests. Are critical paths covered?
      Are edge cases tested? Suggest specific tests that are missing.`,
    outputSchema: { verdict: 'approved' | 'needs-revision', missingTests: TestSuggestion[] }
  },
  {
    name: "security-review",
    phases: ['implementation'],
    riskThreshold: 'high', // Only required for high-risk cards
    description: "Security-focused review of changes",
    agentPrompt: `Analyze for security vulnerabilities: injection, auth bypass, data exposure,
      crypto misuse. Only flag issues with >80% confidence of exploitability.`,
    outputSchema: { verdict: 'approved' | 'needs-revision', vulnerabilities: Vulnerability[] }
  }
];
```

### 6.8 The Feedback Loop State Machine

Each phase has an internal loop that prevents premature transition:

```
┌──────────────────────────────────────────────────┐
│              PHASE: Implementation                │
│                                                  │
│  ┌─────┐    ┌──────────┐    ┌──────────────┐   │
│  │Work │───►│Gate Check │───►│All Gates Pass│───┼──► Next Phase
│  └──┬──┘    └─────┬─────┘    └──────────────┘   │
│     ▲             │                              │
│     │        ┌────▼─────┐                        │
│     │        │Gate Fails │                        │
│     │        └────┬──────┘                        │
│     │             │                              │
│     │        ┌────▼──────────────┐               │
│     └────────┤Feedback Injected  │               │
│              │into Session       │               │
│              └───────────────────┘               │
└──────────────────────────────────────────────────┘
```

**Loop counter / circuit breaker:**
```typescript
interface FeedbackLoop {
  maxIterations: number;        // Default: 3 for reviews, 5 for lint fixes
  currentIteration: number;
  history: LoopIteration[];
  
  // After max iterations, escalate to human
  onMaxIterationsReached(): void {
    this.card.needsAttention = true;
    this.card.attentionReason = `Failed to pass ${this.gateName} after ${this.maxIterations} attempts`;
    this.moveToColumn('blocked');
  }
}
```

### 6.9 Token Efficiency Strategy

The dual-invocation model (agent-initiated vs system-enforced) optimizes token usage:

| Scenario | Token Cost | Mechanism |
|----------|-----------|-----------|
| Agent self-reviews during work | Included in session cost | Agent invokes skill naturally |
| Agent skips review, system enforces | Additional skill invocation cost | Gate engine triggers externally |
| Agent reviews but doesn't pass | Re-work + re-review cost | Feedback loop continues |
| Deterministic gate fails | Zero AI cost | CLI command re-run |

**Key optimization**: By checking `checkSkillInvocationInSession()` before forcing a review, we avoid double-reviewing work the agent already validated. The gate engine only pays for enforcement when the agent didn't self-regulate.

**Additional token-saving measures:**
- Cache review results — if code hasn't changed since last review, don't re-review
- Incremental reviews — only review the delta since last review pass
- Tiered models — use cheaper models for initial lint-level reviews, expensive models for security/architecture

### 6.10 Integration with AHP Lifecycle

AHP doesn't have native quality gates, but the system leverages existing primitives:

| AHP Primitive | Gate System Usage |
|---------------|-------------------|
| `SessionStatus.Idle` | Trigger: session signaled completion → run gate checks |
| `SessionStatus.InputNeeded` | Gate feedback injected → session awaits agent processing |
| `session/toolCallComplete` actions | Detection: check if review skill was invoked |
| `root/sessionSummaryChanged` | Monitor: track when sessions signal state changes |
| `resourceRead` / `resourceWrite` | Execute: read plan artifacts, write gate results |
| Changeset subscription | Context: know what files changed for scoped reviews |
| `dispatchAction` with custom `_meta` | Annotation: tag sessions with gate status |
| Session `customizations` (skills) | Injection: register review skills as available tools |

The board engine sits **between** AHP events and column transitions, intercepting would-be transitions and gating them:

```typescript
// Pseudocode for the gate interceptor
ahpClient.on("root/sessionSummaryChanged", async (params) => {
  const { session, changes } = params;
  const card = board.getCard(session);

  // Session went idle — agent thinks it's done
  if (changes.status === SessionStatus.Idle && card.column === 'implementation') {
    // Don't transition yet — run gates
    const gateResult = await gateEngine.evaluate(card, 'implementation→review');

    if (gateResult.allPassed) {
      card.column = 'review'; // Transition allowed
    } else {
      // Inject feedback, session will resume
      await injectFeedback(session, gateResult.failures);
      // Card stays in 'implementation' — loop continues
    }
  }
});
```

---

## 7. Artifacts & Research Documents

### 6.1 Frontloading Research in Cards

Each card should carry pre-loaded artifacts that give context before starting work:

```typescript
interface Artifact {
  id: string;
  type: 'plan' | 'research' | 'design' | 'spec' | 'test-plan' | 'decision';
  title: string;
  content: string;           // Markdown content
  contentRef?: URI;          // AHP resource URI for lazy loading
  createdAt: number;
  createdBy: 'human' | 'agent';
  status: 'draft' | 'approved' | 'superseded';
}
```

### 6.2 Artifact Sources

| Source | Mechanism |
|--------|-----------|
| Session plan.md | Extract from session filesystem via AHP `resourceRead` |
| Conversation summaries | Copilot SDK extraction from chat turns |
| Changeset analysis | Subscribe to session changesets for file diffs |
| External links | User-attached GitHub issues, PRs, docs |
| Research documents | Agent-generated research stored in session artifacts dir |

### 6.3 Integration with AHP Resources

AHP provides filesystem commands on the root channel:
- `resourceRead` — Read file content from session working directory
- `resourceList` — List files in a directory
- `resourceWrite` — Write artifacts back to session

This enables reading `plan.md`, `todos`, and other session-state artifacts directly.

---

## 7. User Experience Design

### 7.1 Card Detail View

```
┌────────────────────────────────────────────────┐
│ 🔨 Refactor auth middleware          [gpt-5]   │
│ ────────────────────────────────────────────── │
│ Status: In Progress • 73% complete             │
│ Activity: "Implementing JWT refresh logic"     │
│ Changes: +127 -34 across 5 files               │
│                                                │
│ ▸ Plan (3 of 7 steps complete)                 │
│   ✅ Research existing auth patterns           │
│   ✅ Design new token flow                     │
│   ✅ Implement token generation                │
│   🔨 Implement refresh endpoint                │
│   ⬜ Add rate limiting                         │
│   ⬜ Write integration tests                   │
│   ⬜ Update API documentation                  │
│                                                │
│ ▸ Artifacts                                    │
│   📄 Auth Pattern Research (approved)          │
│   📄 Token Flow Design (approved)              │
│   📄 API Spec Draft (draft)                    │
│                                                │
│ ▸ Recent Activity                              │
│   12:34 - Tool: editFile src/auth/refresh.ts   │
│   12:33 - Agent: "Adding refresh endpoint..."  │
│   12:30 - Tool: readFile src/auth/tokens.ts    │
│                                                │
│ [Open Session] [Pause] [Ask Question] [Archive]│
└────────────────────────────────────────────────┘
```

### 7.2 Board-Level Dashboard

- **WIP limits** per column (configurable)
- **Health indicators** — stuck sessions, error rates, throughput
- **Context switching** — click card to open session in IDE/CLI
- **Filters** — by repo, by model, by assignee, by priority
- **Timeline view** — alternative to columns showing temporal progress

### 7.3 Notifications & Attention System

| Priority | Channel | Example |
|----------|---------|---------|
| Critical | Push notification | Session errored, needs immediate input |
| High | Badge on board | Session stuck > 5 min, WIP exceeded |
| Medium | Card highlight | Session completed, ready for review |
| Low | Activity feed | Progress update, artifact created |

---

## 8. Technical Implementation Strategy

### 8.1 Recommended Tech Stack

| Layer | Technology | Rationale |
|-------|-----------|-----------|
| AHP Client | `@microsoft/agent-host-protocol` (TypeScript) | Official, typed, includes reducers |
| Orchestrator | `@github/copilot-sdk` | Official agent runtime with hooks |
| Board State | SQLite + Redux-like store | Persistent local state with real-time sync |
| UI | React + Tailwind (or Tauri/Electron for desktop) | Rich kanban UIs exist (react-beautiful-dnd, @hello-pangea/dnd) |
| Transport | WebSocket to AHP server | Real-time bidirectional |
| CLI alternative | AHPX + custom commands | For terminal-first workflows |

### 8.2 Multi-Host Support

AHP SDKs (Rust, Swift, Go) ship `MultiHostClient` for connecting to multiple agent hosts simultaneously. This enables:
- Monitoring sessions across multiple machines/environments
- Aggregating work from different teams
- Supporting distributed development setups

> Source: [AHP README — Multi-host section](https://github.com/microsoft/agent-host-protocol/blob/main/README.md)

### 8.3 Implementation Phases

| Phase | Scope | Effort |
|-------|-------|--------|
| **1. Read-only board** | Connect to AHP, list sessions, map to columns, basic UI | 1-2 weeks |
| **2. Card enrichment** | Copilot SDK metadata extraction, artifacts display | 2-3 weeks |
| **3. Quality gate engine** | Deterministic checks (lint/test/build), per-project extraction, feedback injection | 2-3 weeks |
| **4. Skill-based reviews** | Adversarial plan review, code review as sub-agent skills, dual-invocation detection | 3-4 weeks |
| **5. Orchestrator MVP** | Error detection, stale session alerts, risk assessment, gate enforcement | 2-3 weeks |
| **6. Full orchestrator** | Proactive optimization, WIP management, cross-session coordination | 3-4 weeks |
| **7. UX polish** | Drag-and-drop, context switching, notification system, gate status visualization | 2-3 weeks |

---

## 9. Additional Ideas & Considerations

### 9.1 Additional Features Worth Exploring

1. **Dependency graph visualization** — Show which cards depend on others (e.g., shared files, API contracts)
2. **Cost tracking** — Token usage per session, model cost breakdown
3. **Template cards** — Pre-configured card templates for common SDLC patterns (bug fix, feature, refactor)
4. **Retrospectives** — Auto-generated summaries of completed work with metrics
5. **Branching strategies** — Board awareness of git branches, PRs, merge conflicts
6. **Team mode** — Multiple humans sharing a board, each with their own agent sessions
7. **SLA tracking** — Time-in-column metrics, burndown charts
8. **Voice/natural language board control** — "Move the auth task to review" via Copilot
9. **Integration with GitHub Projects** — Sync cards ↔ GitHub Issues/PRs bidirectionally
10. **Playbook system** — Codified SDLC patterns the orchestrator follows (e.g., "always run tests before moving to review")

### 9.2 Challenges & Risks

| Challenge | Mitigation |
|-----------|-----------|
| AHP is under active development (breaking changes expected) | Pin to specific protocol version, use reducers for compatibility |
| Session metadata may not be rich enough for SDLC tracking | Extend via `_meta` fields and external state store |
| Orchestrator runaway (infinite loops, cost) | Budget limits, human-in-the-loop gates, rate limiting |
| Multi-model/multi-agent complexity | Normalize card metadata regardless of backend |
| Latency in Copilot SDK extraction | Cache aggressively, extract incrementally on state changes |
| Privacy/security of session content | Orchestrator runs locally, no external data exfil |

### 9.3 Open Questions

- **Session persistence**: How long do AHP sessions survive? Need external persistence for long-lived SDLC cards?
- **Custom metadata storage**: Where to persist board-level metadata (priority, labels, phase) that doesn't exist in AHP?
- **Multi-user coordination**: How do multiple developers share a board view of the same AHP host?
- **Offline mode**: What happens when AHP server is unreachable? Local state divergence?

---

## 10. Related Work & Prior Art

| Project | Relevance |
|---------|-----------|
| [Linear](https://linear.app) | Modern issue tracker with AI features; inspiration for UX |
| [CrewAI](https://github.com/crewaiinc/crewai) | Multi-agent orchestration framework |
| [MetaGPT](https://github.com/geekan/MetaGPT) | Software company simulation with agent roles |
| [Microsoft AutoGen](https://github.com/microsoft/autogen) | Multi-agent conversation framework |
| [OpenDevin](https://github.com/OpenDevin/OpenDevin) | Autonomous AI software engineer |
| [GitHub Projects](https://github.com/features/issues) | Kanban + issues + automation |
| [Copilot Workspace](https://githubnext.com/projects/copilot-workspace) | AI-assisted SDLC in GitHub |

---

## 11. Conclusion

Building a kanban-style SDLC system on AHP is **highly viable** because:

1. **AHP provides exactly the right primitives** — session state, real-time notifications, multi-client sync, and resource access cover all data needs
2. **The Copilot SDK fills the intelligence gap** — extraction, summarization, and orchestration are first-class capabilities
3. **The notification system enables reactive UX** — `root/sessionSummaryChanged` is purpose-built for maintaining live session lists
4. **Changesets provide code awareness** — File-level diff tracking maps naturally to progress indicators
5. **The protocol is agent-agnostic** — Works regardless of which AI backend powers the sessions

The main innovation is in the **mapping layer** (session state → SDLC card) and the **orchestrator** (autonomous CTO monitoring the board). Both are well-supported by the existing protocol primitives and SDK capabilities.

---

## References

1. [Microsoft Agent Host Protocol — GitHub Repository](https://github.com/microsoft/agent-host-protocol)
2. [AHP Documentation Site](https://microsoft.github.io/agent-host-protocol/)
3. [AHP Session Channel Specification](https://github.com/microsoft/agent-host-protocol/blob/main/docs/specification/session-channel.md)
4. [AHP Root Channel Specification](https://github.com/microsoft/agent-host-protocol/blob/main/docs/specification/root-channel.md)
5. [AHP State Model Guide](https://github.com/microsoft/agent-host-protocol/blob/main/docs/guide/state-model.md)
6. [AHP Changesets Guide](https://github.com/microsoft/agent-host-protocol/blob/main/docs/guide/changesets.md)
7. [AHP TypeScript Types — Session State](https://github.com/microsoft/agent-host-protocol/blob/main/types/channels-session/state.ts)
8. [AHP TypeScript Types — Root State](https://github.com/microsoft/agent-host-protocol/blob/main/types/channels-root/state.ts)
9. [AHPX CLI Tool](https://github.com/TylerLeonhardt/ahpx)
10. [GitHub Copilot SDK — npm](https://www.npmjs.com/package/@github/copilot-sdk)
11. [GitHub Copilot SDK — Repository](https://github.com/github/copilot-sdk)
12. [Copilot SDK GA Announcement](https://github.blog/changelog/2026-06-02-copilot-sdk-is-now-generally-available/)
13. [Copilot SDK Hooks Documentation](https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/hooks)
14. [Model Context Protocol Specification](https://modelcontextprotocol.io/specification/2025-06-18/architecture)
15. [VS Code Agent Host Implementation](https://github.com/microsoft/vscode/tree/main/src/vs/platform/agentHost/node)
