import { KanbanCard } from "@/lib/types";

export const mockCards: KanbanCard[] = [
  {
    id: "1",
    title: "Refactor auth middleware",
    phase: "build",
    runtime: "running",
    gateStatus: "pending",
    attention: "none",
    risk: "medium",
    activity: "Implementing JWT refresh token rotation...",
    additions: 34,
    deletions: 12,
    filesChanged: 3,
    planSteps: { total: 7, done: 4 },
    modifiedAt: Date.now() - 120000,
    model: "gpt-5",
    branch: "main",
    workingDirectory: "src/auth/",
    artifacts: [
      {
        id: "a1",
        type: "plan",
        title: "Auth Refactor Plan",
        contentRef: `# Auth Refactor Plan

## Goal
Replace the legacy session-based auth with stateless JWT tokens supporting refresh rotation.

## Steps
1. ~~Audit existing middleware~~ ✓
2. ~~Design token schema (access + refresh)~~ ✓
3. ~~Implement token generation & validation~~ ✓
4. **Implement refresh token rotation** ← current
5. Migrate existing sessions to JWT
6. Update integration tests
7. Deploy with feature flag

## Token Schema
| Field | Type | Notes |
|-------|------|-------|
| sub | string | User ID |
| exp | number | 15min for access, 7d for refresh |
| jti | string | Unique token ID for revocation |
| scope | string[] | Permission scopes |

## Risks
- Refresh token theft window during rotation
- Clock skew between services (mitigated with 30s grace)
`,
        createdAt: Date.now() - 3600000,
        createdBy: "agent",
        status: "approved",
      },
      {
        id: "a2",
        type: "research",
        title: "JWT Best Practices Analysis",
        contentRef: `# JWT Best Practices Analysis

## Summary
Surveyed OWASP, Auth0, and RFC 7519 recommendations for secure JWT usage in production.

## Key Findings

### Token Lifetime
- Access tokens: **15 minutes max** (OWASP recommendation)
- Refresh tokens: **7 days** with rotation on every use
- Sliding window preferred over fixed expiry

### Storage
- Access token: in-memory only (never localStorage)
- Refresh token: httpOnly secure cookie with SameSite=Strict

### Rotation Strategy
- Issue new refresh token on every refresh request
- Invalidate old token immediately
- Detect reuse → revoke entire family (theft indicator)

## References
- [OWASP JWT Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/JSON_Web_Token_for_Java_Cheat_Sheet.html)
- [RFC 7519](https://datatracker.ietf.org/doc/html/rfc7519)
- Auth0 blog: "Refresh Token Rotation"
`,
        createdAt: Date.now() - 3200000,
        createdBy: "agent",
        status: "approved",
      },
      {
        id: "a3",
        type: "design",
        title: "Token Flow Diagram",
        createdAt: Date.now() - 2800000,
        createdBy: "agent",
        status: "draft",
      },
    ],
    recentActivity: [
      { timestamp: Date.now() - 120000, type: "tool", message: "editFile src/auth/refresh.ts" },
      { timestamp: Date.now() - 180000, type: "agent", message: "Adding refresh endpoint with sliding window expiry" },
      { timestamp: Date.now() - 240000, type: "tool", message: "readFile src/auth/tokens.ts" },
    ],
  },
  {
    id: "2",
    title: "Fix login redirect bug",
    phase: "ship",
    runtime: "idle",
    gateStatus: "passed",
    attention: "none",
    risk: "low",
    activity: "All gates passed. Ready for merge.",
    additions: 8,
    deletions: 3,
    filesChanged: 1,
    planSteps: { total: 3, done: 3 },
    modifiedAt: Date.now() - 300000,
    model: "claude-sonnet",
    branch: "fix/login-redirect",
    artifacts: [
      {
        id: "a4",
        type: "spec",
        title: "Redirect Bug Repro Steps",
        createdAt: Date.now() - 600000,
        createdBy: "human",
        status: "approved",
      },
    ],
    recentActivity: [
      { timestamp: Date.now() - 300000, type: "gate", message: "All gates passed — ready to ship" },
      { timestamp: Date.now() - 360000, type: "gate", message: "Code review: approved" },
    ],
  },
  {
    id: "3",
    title: "Add rate limiting to API",
    phase: "define",
    runtime: "idle",
    gateStatus: "pending",
    attention: "none",
    risk: "medium",
    activity: "Awaiting scope definition",
    additions: 0,
    deletions: 0,
    filesChanged: 0,
    planSteps: { total: 0, done: 0 },
    modifiedAt: Date.now() - 3600000,
  },
  {
    id: "4",
    title: "Search indexing service with Elasticsearch integration",
    phase: "build",
    runtime: "idle",
    gateStatus: "pending",
    attention: "stale",
    risk: "high",
    activity: "Building Elasticsearch adapter...",
    additions: 156,
    deletions: 23,
    filesChanged: 8,
    planSteps: { total: 12, done: 6 },
    modifiedAt: Date.now() - 480000,
    model: "gpt-5",
    branch: "feat/search",
    workingDirectory: "src/search/",
    artifacts: [
      {
        id: "a5",
        type: "research",
        title: "Elasticsearch vs Meilisearch Comparison",
        contentRef: `# Elasticsearch vs Meilisearch

## Evaluation Criteria
Compared on: full-text quality, vector search, scalability, operational cost.

| Criteria | Elasticsearch | Meilisearch |
|----------|--------------|-------------|
| Full-text search | ★★★★★ | ★★★★☆ |
| Vector/hybrid search | ★★★★☆ (8.x kNN) | ★★☆☆☆ |
| Scalability | ★★★★★ | ★★★☆☆ |
| Ops complexity | ★★☆☆☆ | ★★★★★ |
| Latency (p99) | ~50ms | ~12ms |

## Recommendation
**Elasticsearch** — vector search is a hard requirement for semantic matching. Accept the operational overhead with managed service (Elastic Cloud).

## Trade-offs
- Higher ops cost (~$400/mo vs ~$50/mo for Meili Cloud)
- Requires JVM tuning and index lifecycle management
- But: single system for full-text + vector eliminates glue code
`,
        createdAt: Date.now() - 7200000,
        createdBy: "agent",
        status: "approved",
      },
      {
        id: "a6",
        type: "plan",
        title: "Indexing Service Architecture",
        contentRef: `# Indexing Service Architecture

## Overview
Event-driven indexing pipeline that reacts to data changes and maintains ES indices.

## Components
1. **Change Listener** — subscribes to DB change stream
2. **Transform Worker** — enriches documents, generates embeddings
3. **Bulk Writer** — batches and flushes to Elasticsearch
4. **Health Monitor** — tracks lag, errors, index freshness

## Data Flow
\`\`\`
DB Change Stream → Listener → Queue → Transform → Bulk Writer → ES
                                         ↓
                                    Embedding API
\`\`\`

## Index Schema
- \`documents_v1\` — full-text + metadata
- \`documents_vectors_v1\` — dense vector (768d) for kNN

## Deployment
- Workers run as separate processes (scalable independently)
- Queue: Redis Streams for at-least-once delivery
- Retry with exponential backoff (max 5 attempts)
`,
        createdAt: Date.now() - 6000000,
        createdBy: "agent",
        status: "approved",
      },
      {
        id: "a7",
        type: "decision",
        title: "Chose Elasticsearch for full-text + vector",
        createdAt: Date.now() - 5800000,
        createdBy: "agent",
        status: "approved",
      },
      {
        id: "a8",
        type: "test-plan",
        title: "Integration Test Plan",
        createdAt: Date.now() - 4000000,
        createdBy: "agent",
        status: "draft",
      },
    ],
    recentActivity: [
      { timestamp: Date.now() - 480000, type: "tool", message: "editFile src/search/adapter.ts" },
      { timestamp: Date.now() - 500000, type: "agent", message: "Implementing bulk indexing with batched writes" },
      { timestamp: Date.now() - 600000, type: "tool", message: "createFile src/search/types.ts" },
    ],
  },
  {
    id: "5",
    title: "Database migration v3",
    phase: "review",
    runtime: "running",
    gateStatus: "evaluating",
    attention: "none",
    risk: "high",
    activity: "Code review in progress...",
    additions: 89,
    deletions: 45,
    filesChanged: 6,
    planSteps: { total: 5, done: 5 },
    modifiedAt: Date.now() - 60000,
    model: "claude-sonnet",
    branch: "feat/migration-v3",
    artifacts: [
      {
        id: "a9",
        type: "plan",
        title: "Migration Sequence Plan",
        createdAt: Date.now() - 1800000,
        createdBy: "agent",
        status: "approved",
      },
      {
        id: "a10",
        type: "spec",
        title: "Schema v3 Specification",
        createdAt: Date.now() - 1600000,
        createdBy: "human",
        status: "approved",
      },
    ],
    recentActivity: [
      { timestamp: Date.now() - 60000, type: "gate", message: "Code review started by review-agent" },
      { timestamp: Date.now() - 90000, type: "gate", message: "Lint + typecheck + tests: passed" },
      { timestamp: Date.now() - 120000, type: "agent", message: "All migrations applied, submitted for review" },
    ],
  },
  {
    id: "6",
    title: "Onboarding flow redesign",
    phase: "plan",
    runtime: "running",
    gateStatus: "pending",
    attention: "none",
    risk: "medium",
    activity: "Drafting step-by-step plan...",
    additions: 0,
    deletions: 0,
    filesChanged: 0,
    planSteps: { total: 8, done: 2 },
    modifiedAt: Date.now() - 200000,
    model: "gpt-5",
    artifacts: [
      {
        id: "a11",
        type: "research",
        title: "Competitor Onboarding Flows",
        createdAt: Date.now() - 400000,
        createdBy: "agent",
        status: "approved",
      },
      {
        id: "a12",
        type: "design",
        title: "Onboarding Wireframes (draft)",
        createdAt: Date.now() - 250000,
        createdBy: "agent",
        status: "draft",
      },
    ],
    recentActivity: [
      { timestamp: Date.now() - 200000, type: "agent", message: "Outlining progressive disclosure steps" },
      { timestamp: Date.now() - 300000, type: "tool", message: "webSearch 'onboarding best practices 2026'" },
    ],
  },
  {
    id: "7",
    title: "Fix payment webhook retry logic",
    phase: "review",
    runtime: "idle",
    gateStatus: "evaluating",
    attention: "none",
    risk: "high",
    activity: "Code review in progress...",
    additions: 42,
    deletions: 18,
    filesChanged: 4,
    planSteps: { total: 4, done: 4 },
    modifiedAt: Date.now() - 180000,
    model: "claude-sonnet",
    branch: "fix/payment-webhook",
    artifacts: [
      {
        id: "a13",
        type: "spec",
        title: "Webhook Retry Requirements",
        createdAt: Date.now() - 900000,
        createdBy: "human",
        status: "approved",
      },
      {
        id: "a14",
        type: "plan",
        title: "Exponential Backoff Implementation",
        createdAt: Date.now() - 800000,
        createdBy: "agent",
        status: "approved",
      },
    ],
    recentActivity: [
      { timestamp: Date.now() - 180000, type: "gate", message: "Code review started by review-agent" },
      { timestamp: Date.now() - 200000, type: "gate", message: "Lint + typecheck: passed" },
      { timestamp: Date.now() - 220000, type: "agent", message: "Implementation complete, submitting for review" },
    ],
  },
  {
    id: "8",
    title: "Update API docs for v2 endpoints",
    phase: "build",
    runtime: "input-needed",
    gateStatus: "pending",
    attention: "needs-human",
    risk: "low",
    activity: "Which endpoints should I document first?",
    additions: 22,
    deletions: 0,
    filesChanged: 2,
    planSteps: { total: 6, done: 2 },
    modifiedAt: Date.now() - 90000,
    model: "gpt-5",
    branch: "docs/api-update",
    artifacts: [
      {
        id: "a15",
        type: "plan",
        title: "API Documentation Plan",
        createdAt: Date.now() - 500000,
        createdBy: "agent",
        status: "draft",
      },
    ],
    recentActivity: [
      { timestamp: Date.now() - 90000, type: "agent", message: "Waiting for input: which endpoints to prioritize?" },
      { timestamp: Date.now() - 150000, type: "tool", message: "readFile docs/api/README.md" },
    ],
  },
  {
    id: "9",
    title: "Implement RBAC permissions model",
    phase: "build",
    runtime: "error",
    gateStatus: "failed",
    attention: "error",
    risk: "high",
    activity: "TypeError: Cannot read property 'roles' of undefined",
    additions: 67,
    deletions: 5,
    filesChanged: 4,
    planSteps: { total: 9, done: 5 },
    modifiedAt: Date.now() - 45000,
    model: "gpt-5",
    branch: "feat/rbac",
    artifacts: [
      {
        id: "a16",
        type: "research",
        title: "RBAC vs ABAC Analysis",
        createdAt: Date.now() - 2000000,
        createdBy: "agent",
        status: "approved",
      },
      {
        id: "a17",
        type: "spec",
        title: "Permissions Matrix",
        createdAt: Date.now() - 1800000,
        createdBy: "human",
        status: "approved",
      },
      {
        id: "a18",
        type: "plan",
        title: "RBAC Implementation Plan",
        createdAt: Date.now() - 1600000,
        createdBy: "agent",
        status: "superseded",
      },
    ],
    recentActivity: [
      { timestamp: Date.now() - 45000, type: "agent", message: "Error: Cannot read property 'roles' of undefined" },
      { timestamp: Date.now() - 50000, type: "tool", message: "runCommand npm run typecheck (failed)" },
      { timestamp: Date.now() - 70000, type: "tool", message: "editFile src/permissions/engine.ts" },
    ],
  },
];
