# PR1–PR3 subagent/task implementation dump

Date: 2026-03-07

This file records the work completed for the requested PR1–PR3 scope:

- PR1 — extract task domain modules + fix resume validation + propagate parent session permissions
- PR2 — add durable task/branch runtime records + heartbeat + interrupted recovery
- PR3 — add task/branch APIs + regenerate SDK + migrate TUI/web reads to backend objects

No git commits were made.

---

## PR4 follow-up update

After the initial PR1–PR3 pass, the next implementation chunk was partially completed in the same working tree.

Implemented after this note was first written:

- transactional branch apply with durable rollback journal
- stale apply recovery on startup/runtime heartbeat expiry
- direct backend branch cancel/apply controls wired into web and TUI control towers
- branch cancel/result race fix so late child results do not overwrite cancelled branch rows
- inline TUI task-branch renderer polish for cancelled/interrupted/apply states
- clearer task/branch terminal status formatting in tool output

This means the following item from the original “still not implemented” list is no longer open:

- transactional rollback for branch apply

Still open after the PR4 follow-up work:

- dedicated append-only event-backed `task_watch` / `task_branch_status` replacing message-history reconstruction
- upgraded branch judging model/rubric
- retention/GC/repair command
- prompt/orchestration tuning pass

Files added after the original note:

- `packages/selene/src/task/apply.ts`

Additional files updated after the original note:

- `packages/selene/src/task/recovery.ts`
- `packages/selene/src/tool/task.ts`
- `packages/selene/test/tool/task.test.ts`
- `packages/app/src/pages/control-tower.tsx`
- `packages/selene/src/cli/cmd/tui/routes/control-tower.tsx`
- `packages/selene/src/cli/cmd/tui/routes/session/index.tsx`

Additional validation run after the original note:

- `cd packages/selene && bun run typecheck`
- `cd packages/selene && bun test --timeout 30000 test/tool/task.test.ts`
- `cd packages/app && bun run typecheck`

---

## High-level outcome

The subagent/task system now has a first-class backend task domain instead of relying only on inferred session/tool-part state.

Implemented:

- durable task run records
- durable branch/tournament run records
- persisted task/branch lifecycle events
- runtime heartbeat ownership
- stale-run interruption recovery
- stricter `task_id` resume validation
- parent permission inheritance for child task sessions
- backend task + task-branch APIs
- regenerated JS SDK for new APIs
- migrated the main web and TUI task/tournament surfaces to use the backend task domain

Still not implemented in this pass:

- dedicated append-only event-backed `task_watch` / `task_branch_status` replacing message-history reconstruction
- upgraded branch judging model/rubric
- retention/GC/repair command
- prompt/orchestration tuning pass

---

## New backend modules

### `packages/selene/src/task/event.ts`
Added a shared task-event model:

- `TaskEvent.Type`
- `TaskEvent.Info`
- `TaskEvent.push(...)`

This provides persisted lifecycle events for both task runs and branch runs.

### `packages/selene/src/task/run.ts`
Added durable single-task run storage and runtime state.

Key additions:

- `TaskRun.Status`
  - `running`
  - `completed`
  - `error`
  - `cancelled`
  - `interrupted`
- `TaskRun.Runtime`
  - owner
  - pid
  - started
  - heartbeat
- `TaskRun.Info`
- `TaskRun.get(...)`
- `TaskRun.ensure(...)`
- `TaskRun.fromSession(...)`
  - synthesizes a compatible fallback record for older task sessions with no stored task-run record yet
- `TaskRun.list(...)`
- `TaskRun.upsert(...)`
- `TaskRun.beat(...)`
- `TaskRun.finish(...)`
- `TaskRun.cancel(...)`
- `TaskRun.interrupt(...)`
- `TaskRun.watch(...)`
- bus events:
  - `task.updated`
  - `task.event`

### `packages/selene/src/task/branch.ts`
Added durable branch/tournament run storage and runtime state.

Key additions:

- `TaskBranch.Eval`
- `TaskBranch.RowStatus`
- `TaskBranch.Row`
- `TaskBranch.Winner`
- `TaskBranch.Apply`
- `TaskBranch.Status`
  - `running`
  - `completed`
  - `error`
  - `cancelled`
  - `interrupted`
- `TaskBranch.Info`
- `TaskBranch.get(...)`
- `TaskBranch.list(...)`
- `TaskBranch.create(...)`
- `TaskBranch.update(...)`
- `TaskBranch.beat(...)`
- `TaskBranch.finish(...)`
- `TaskBranch.cancel(...)`
- `TaskBranch.interrupt(...)`
- `TaskBranch.markWinner(...)`
- `TaskBranch.setApply(...)`
- `TaskBranch.watch(...)`
- bus events:
  - `task.branch.updated`
  - `task.branch.event`

Compatibility behavior added:

- branch state loader normalizes older persisted `task_branch` JSON shape into the new richer `TaskBranch.Info` shape
- older records that do not yet have `projectID`, `directory`, `rootSessionId`, `events`, `runtime`, or `applied.status` are normalized on read

### `packages/selene/src/task/lineage.ts`
Added lineage + permission utilities.

Implemented:

- `TaskLineage.validate(...)`
  - verifies current project
  - verifies target session is a subagent
  - rejects archived sessions
  - enforces same root tree
  - verifies resumed task belongs to the same subagent agent
- `TaskLineage.permission(...)`
  - merges parent session permissions with child-task restrictions
  - preserves parent denies/restrictions instead of replacing them
  - still applies task-specific subagent restrictions
  - still denies todo tools for subagents

### `packages/selene/src/task/recovery.ts`
Added stale-run recovery.

Implemented:

- `TaskRecovery.init()`
- `TaskRecovery.recover()`

Behavior:

- scans running task runs and running branch runs
- if heartbeat is stale, marks them `interrupted`
- keeps them resumable rather than silently losing them

---

## Runtime/bootstrap integration

### `packages/selene/src/project/bootstrap.ts`
Added:

- `TaskRecovery.init()` during instance bootstrap

Effect:

- task/branch stale-runtime recovery is now part of normal instance startup behavior

---

## Permission + prompt changes

### `packages/selene/src/session/prompt.ts`
Extended prompt input and permission handling.

Implemented:

- added `permission` to `SessionPrompt.PromptInput`
- merged explicit `permission` with legacy `tools` booleans when prompting
- when a permission ruleset is passed in, prompt-time tool availability is now reflected into `tools` by computing disabled tool ids from the permission rules
- persisted the resolved permission onto the session via `Session.setPermission(...)`

Effect:

- child task sessions now store the real effective permission state
- prompt-driven execution respects inherited session restrictions more truthfully
- UI/debugging/status now reflect actual child-session policy more closely

---

## Task tool changes

### `packages/selene/src/tool/task.ts`
This file was the main integration point.

#### Single-task flow changes

Implemented:

- imported and used `TaskRun`, `TaskBranch`, and `TaskLineage`
- on task launch:
  - compute inherited child permission from parent session
  - create or validate resumed child session using lineage rules
  - persist/update a durable `TaskRun`
- on resume via `task_id`:
  - enforce project/root/subagent/agent checks via `TaskLineage.validate(...)`
  - update resumed session permission to the new inherited effective permission
- wrap task execution in `TaskRun.watch(...)` to maintain heartbeat
- on completion:
  - persist `TaskRun.finish(..., { status: "completed" })`
- on failure:
  - persist `TaskRun.finish(..., { status: "error" })`
- on abort/cancel:
  - persist `TaskRun.cancel(...)`

#### Branch/tournament flow changes

Implemented:

- child branch sessions now also inherit parent session restrictions
- branch child task runs persist their own `TaskRun` records
- branch run itself persists a durable `TaskBranch` record
- branch execution is wrapped in `TaskBranch.watch(...)` to maintain heartbeat
- branch completion writes durable final state via `TaskBranch.finish(...)`
- branch cancel now marks both child tasks and parent branch state cancelled
- apply state is now persisted via `TaskBranch.setApply(...)`

#### New exported helpers

Added reusable helpers used by routes and tools:

- `taskCancel(id)`
- `branchCancel(id)`
- `branchApply(input)`

#### Status/watch changes

Updated:

- `task_status` now uses durable `TaskRun.ensure(...)`
- `task_watch` now uses durable task run state for terminal status
- `task_cancel` now returns `status: cancelled`

#### Compatibility decisions preserved

- `task_id` remains the session ID for the child subagent session
- older sessions without persisted task-run state are still readable via `TaskRun.fromSession(...)`

---

## New task routes

### `packages/selene/src/server/routes/task.ts`
Added a new route file exposing first-class task APIs.

Implemented APIs:

#### task branch endpoints
- `taskBranch.list`
- `taskBranch.get`
- `taskBranch.events`
- `taskBranch.cancel`
- `taskBranch.apply`

#### task endpoints
- `task.list`
- `task.get`
- `task.events`
- `task.cancel`
- `task.resume`

Notable behavior:

- `task.resume` validates lineage before reuse
- `task.resume` can run foreground or background
- `task.resume` uses `TaskRun.upsert(...)` and `SessionPrompt.prompt(...)`
- `taskBranch.apply` directly applies the selected winner through the backend API
- `taskBranch.cancel` directly cancels the tournament and child task runs

### `packages/selene/src/server/server.ts`
Integrated the new route group:

- mounted `TaskRoutes()` at `/task`

---

## SDK regeneration

Regenerated:

- `packages/sdk/js/src/v2/gen/sdk.gen.ts`
- `packages/sdk/js/src/v2/gen/types.gen.ts`

New generated client groups now available:

- `sdk.task`
- `sdk.taskBranch`

New generated types include:

- `TaskRun`
- `TaskRunStatus`
- `TaskRuntime`
- `TaskBranchRun`
- related response/operation types for the new routes

Build command used:

- `./packages/sdk/js/script/build.ts`

---

## Web UI migration

### `packages/app/src/pages/control-tower.tsx`
Migrated the task/tournament pane toward backend truth.

Implemented:

- imported `TaskBranchRun`
- added backend task-branch state store: `data.run`
- on tower load, fetches both:
  - session list
  - task-branch list
- replaced tournament discovery from root-session tool-part archaeology with backend `taskBranch.list(...)`
- `Run` type updated to reflect backend status and apply state
- apply state now comes from durable branch-run `applied.status`, not root-tool scan heuristics
- `Apply winner` now calls direct backend API:
  - `sdk.taskBranch.apply(...)`
- removed model requirement for winner apply in the web tower

Still true in this file:

- family/session evidence is still stitched from session/message/todo/diff APIs
- compare/open/select controls remain UI-driven on top of the richer backend task data

### `packages/app/src/pages/control-tower-state.ts`
Simplified helper state.

Changed:

- removed tool-scan-based `applyState(...)`
- `runNote(...)` now depends only on:
  - winner existence
  - apply status
- model requirement note for apply was removed because direct branch apply no longer requires prompting a model

### `packages/app/src/pages/control-tower-state.test.ts`
Updated tests to match the simpler helper contract.

---

## TUI migration

### `packages/selene/src/cli/cmd/tui/routes/control-tower.tsx`
Migrated task pane to backend task-branch data.

Implemented:

- imported `TaskBranchRun`
- added local `job.list` store for branch runs
- added `loadRun()` polling using `sdk.client.taskBranch.list(...)`
- replaced task-branch tournament discovery from root session messages/tool metadata with backend task-branch records
- task row state now reflects backend branch status directly
- apply status is preserved on the run type for future UI use

### `packages/selene/src/cli/cmd/tui/routes/session/index.tsx`
Migrated inline task/task-branch tool renderers toward backend task objects.

Implemented:

- `Task(...)` inline renderer now fetches `sdk.client.task.get(...)`
- `TaskBranch(...)` inline renderer now fetches `sdk.client.taskBranch.get(...)`
- both renderers still use existing session/message data for richer visible progress detail when available
- background completion toasts now use durable backend status
  - completed
  - cancelled
  - interrupted
  - error
- branch tool renderer now uses durable backend branch winner/status where available

This keeps the current good inline UX while reducing dependence on tool-part metadata as the source of truth.

---

## Tests added/updated

### `packages/selene/test/tool/task.test.ts`
Added tests for the new structural guarantees.

Added coverage for:

- resume across different project is rejected
- resume of an interactive session is rejected
- resume under the wrong agent is rejected
- child permissions inherit parent restrictions
- stale task and branch runs are marked `interrupted` by recovery

Adjusted existing expectations:

- task status title now reports durable state (`Task running`)
- task cancel now returns durable state (`status: cancelled`)

### `packages/app/src/pages/control-tower-state.test.ts`
Updated for the new helper contract after removing tool-scan-based apply inference.

---

## Validation run

Executed and passed:

### selene
- `cd packages/selene && bun run typecheck`
- `cd packages/selene && bun test --timeout 30000 test/tool/task.test.ts`

### app
- `cd packages/app && bun run typecheck`
- `cd packages/app && bun test src/pages/control-tower-state.test.ts`

### sdk generation
- `./packages/sdk/js/script/build.ts`

---

## Files created in this pass

- `packages/selene/src/task/event.ts`
- `packages/selene/src/task/run.ts`
- `packages/selene/src/task/branch.ts`
- `packages/selene/src/task/lineage.ts`
- `packages/selene/src/task/recovery.ts`
- `packages/selene/src/server/routes/task.ts`

---

## Files modified in this pass

- `packages/selene/src/project/bootstrap.ts`
- `packages/selene/src/session/prompt.ts`
- `packages/selene/src/tool/task.ts`
- `packages/selene/src/server/server.ts`
- `packages/selene/test/tool/task.test.ts`
- `packages/sdk/js/src/v2/gen/sdk.gen.ts`
- `packages/sdk/js/src/v2/gen/types.gen.ts`
- `packages/app/src/pages/control-tower.tsx`
- `packages/app/src/pages/control-tower-state.ts`
- `packages/app/src/pages/control-tower-state.test.ts`
- `packages/selene/src/cli/cmd/tui/routes/control-tower.tsx`
- `packages/selene/src/cli/cmd/tui/routes/session/index.tsx`

---

## Behavioral changes worth knowing

### New durable states
Tasks and branch runs can now explicitly land in:

- `running`
- `completed`
- `error`
- `cancelled`
- `interrupted`

### Resume safety improvements
A `task_id` resume can no longer silently cross:

- projects
- root trees
- session kind boundaries
- subagent type boundaries

### Permission inheritance improvements
Child subagents now inherit parent session restrictions instead of getting a fresh replacement ruleset.

### UI/API shift
The system is now meaningfully closer to:

- backend truth first
- UI second
- message/tool-part metadata as compatibility/supporting detail, not primary truth

---

## Important remaining gaps after this pass

These are still open and were intentionally left for later PRs:

1. `task_watch` / `task_branch_status` still reconstruct fine-grained output from session history rather than reading a fully authoritative append-only event stream
2. branch judging is still heuristic-based
3. there is no retention/GC/repair CLI yet
4. prompt/orchestration tuning for broader/faster analysis prompts is still pending

---

## Practical next step

The next logical implementation chunk after the PR4 follow-up work is PR5:

- event-backed watch/status
- richer task/branch progress payloads
- consumer migration away from message-history reconstruction

---

## Remaining PR specs

The sections below are specifications for the remaining planned PRs. These sections describe intended scope and acceptance criteria; they are not a claim that PR5–PR8 are already implemented.

### PR5 — append-only task events + event-backed watch/status/UI

#### Goal
Stop rebuilding task progress from message history on every watch/status request. Replace that with authoritative append-only task and branch event streams backed by persisted storage and exposed through the API.

#### Problem this PR solves
Current behavior still depends on scanning message/part history to answer:

- `task_watch`
- `task_branch_status`
- inline progress UI in session views
- control tower progress summaries

That works, but it is expensive, indirect, and not ideal for long-lived or highly parallel runs.

#### Scope
Keep the existing persisted lifecycle-event foundation, but expand it into a richer append-only progress stream for both:

- task runs
- branch runs

Promote those events into the primary source of truth for progress, with session/message history remaining supporting detail rather than the status engine.

Important design constraint:

- do not overload the current shared `TaskEvent.Type` enum with every low-level progress shape
- add either:
  - separate task/branch progress event unions
  - or a discriminated event payload model with domain-specific schemas

Without that, PR5 will collapse into untyped `data` blobs and fragile consumer logic.

#### Files expected to change
Core backend:

- `packages/selene/src/task/event.ts`
- `packages/selene/src/task/run.ts`
- `packages/selene/src/task/branch.ts`
- `packages/selene/src/tool/task.ts`
- `packages/selene/src/session/processor.ts`
- `packages/selene/src/session/prompt.ts`
- `packages/selene/src/server/routes/task.ts`

Possibly add:

- `packages/selene/src/task/watch.ts`
- `packages/selene/src/task/stream.ts`

UI/API consumers:

- `packages/selene/src/cli/cmd/tui/routes/session/index.tsx`
- `packages/selene/src/cli/cmd/tui/routes/control-tower.tsx`
- `packages/app/src/pages/control-tower.tsx`
- `packages/app/src/context/global-sync/*`
- `packages/app/src/context/sync.tsx`

SDK:

- `packages/sdk/js/src/v2/gen/sdk.gen.ts`
- `packages/sdk/js/src/v2/gen/types.gen.ts`

#### Event model
Add persisted progress event kinds along these lines.

Do not treat this list as a required flat enum on the existing shared lifecycle event type. These should be modeled as richer progress events, not jammed into the current coarse lifecycle-only enum.

For tasks:

- `created`
- `running`
- `resumed`
- `blocked`
- `tool_started`
- `tool_completed`
- `tool_error`
- `reasoning`
- `summary`
- `context_published`
- `completed`
- `error`
- `cancelled`
- `interrupted`

For branches:

- `created`
- `running`
- `branch_started`
- `branch_completed`
- `branch_error`
- `branch_cancelled`
- `winner`
- `apply_started`
- `applied`
- `apply_error`
- `completed`
- `error`
- `cancelled`
- `interrupted`

#### API additions/changes
Refine existing APIs first:

- `task.events` already exists and should gain richer progress coverage plus `wait_ms`
- `taskBranch.events` already exists and should gain richer progress coverage plus `wait_ms`
- optional SSE endpoints can come after long-poll migration is working

Likely route shape:

- `GET /task/:taskID/events?cursor=&limit=&wait_ms=`
- `GET /task/branch/:branchID/events?cursor=&limit=&wait_ms=`

Migration order:

1. extend existing cursor endpoints and event payloads
2. switch `task_watch` / `task_branch_status` to event-first reads
3. migrate UI consumers to cursor polling
4. add SSE only if cursor polling is still insufficient

#### Tool changes
Refactor:

- `task_watch` should read task events first, not rescan all session history
- `task_branch_status` should read branch events first, not merge child histories on demand

Message-history fallback may remain temporarily for older runs without full event coverage.

#### UI changes
TUI and web should:

- consume task/branch event streams incrementally
- update progress incrementally using cursors
- reduce or remove expensive periodic status reconstruction
- keep snapshot fetches only for initial hydration and reconnect recovery

The first UI migration does not need SSE. Cursor-based polling on the existing endpoints is enough to prove the model.

#### Tests required
Add tests for:

- monotonic cursor behavior
- no duplicate event replay after reconnect
- long-poll returning immediately when new events exist
- task watch correctness without full-history rescans
- branch status correctness without merged message-history rebuilds
- UI updates from event streams for both web and TUI

#### Acceptance criteria
- `task_watch` no longer depends primarily on `Session.messages(...)` rescans
- `task_branch_status` no longer depends primarily on merged child-history rescans
- progress updates are cursor/event based
- UI progress remains correct across reconnects
- old runs remain readable through compatibility fallback

---

### PR6 — richer branch judging and explainable winner selection

#### Goal
Replace the current heuristic-only winner selection with a layered evaluation system that is deterministic first, optionally model-assisted second, and always explainable.

#### Problem this PR solves
Current branch winner logic is useful but shallow. It mostly scores:

- diff size
- edit count
- test command heuristics
- obvious failure markers

That is not strong enough for trustworthy multi-branch decision-making.

#### Scope
Split branch evaluation into three stages:

1. deterministic evidence extraction
2. optional model-based judge pass
3. final winner synthesis

#### Files expected to change
- `packages/selene/src/tool/task.ts`
- `packages/selene/src/task/branch.ts`
- `packages/selene/src/config/config.ts`
- `packages/selene/src/server/routes/task.ts`
- `packages/app/src/pages/control-tower.tsx`
- `packages/selene/src/cli/cmd/tui/routes/control-tower.tsx`

Likely new modules:

- `packages/selene/src/task/judge.ts`
- `packages/selene/src/task/evidence.ts`
- `packages/selene/src/task/rubric.ts`

#### Deterministic evidence extraction
Capture structured evidence for each branch:

- file diff summary
- files edited
- tests run
- test pass/fail outcomes
- tool errors
- explicit blocked/incomplete language
- whether branch produced useful output at all
- apply safety/conflict status
- whether branch was cancelled/interrupted

#### Optional judge model
Add configurable judge support in config, for example:

- judge provider/model selection
- rubric weights
- enable/disable model judge per project or global config

Judge output should be structured, not just prose:

- rubric scores by category
- confidence
- key evidence citations
- winner recommendation
- runner-up explanation

#### Persisted winner metadata
Persist richer winner information on `TaskBranch.Info`, such as:

- score breakdown
- confidence basis
- evidence refs
- why winner won
- why runner-up lost
- whether result came from heuristic-only or model-assisted judging

Compatibility requirement:

- older persisted branch records with the current minimal `winner` shape must remain readable
- richer judge metadata should be added in a backward-compatible way
- read normalization must tolerate:
  - no judge metadata
  - heuristic-only records
  - partially populated judge output

#### Decision policy
Define the precedence rule explicitly instead of leaving it implicit in tests:

1. cancelled / interrupted / errored branches are never eligible winners unless every branch is terminal-failed
2. deterministic hard evidence gates come first
   - test failures
   - explicit blocked state
   - missing useful output
   - apply-unsafety when relevant
3. model judging may rank eligible branches, but should not override hard deterministic disqualifiers
4. the persisted winner record must say whether the final decision was:
   - heuristic-only
   - model-assisted
   - forced fallback because no eligible completed branch existed

#### UI changes
Control towers should show:

- winner confidence
- score breakdown
- top evidence snippets
- runner-up comparison hints

#### Tests required
Add stable fixtures for branch outcomes so winner selection does not drift unexpectedly.

Test categories:

- deterministic evidence extraction
- heuristic-only winner selection
- model-judge fallback behavior when no judge configured
- precedence rules when heuristic and judge disagree
- persistence of explanation metadata

#### Acceptance criteria
- winner selection is explainable, not opaque
- deterministic evidence exists even when no judge model is configured
- model judging is optional and configurable
- UIs can display why a winner was selected

---

### PR7 — retention, repair, and cleanup tooling

#### Goal
Clean up durable task artifacts over time so the task system remains maintainable and observable in real use.

#### Problem this solves
Now that task and branch runs are durable, they will accumulate indefinitely unless actively pruned or repaired.

#### Scope
Add lifecycle management for:

- completed task runs
- completed branch runs
- task/branch events
- apply journals/backups
- stale interrupted runs
- orphaned worktrees/sandboxes
- optionally stale shared-context artifacts published by task/branch runs, if retention policy covers them

#### Files expected to change
- `packages/selene/src/task/recovery.ts`
- `packages/selene/src/task/run.ts`
- `packages/selene/src/task/branch.ts`
- `packages/selene/src/task/apply.ts`
- `packages/selene/src/project/bootstrap.ts`
- `packages/selene/src/scheduler/index.ts`

Likely new modules:

- `packages/selene/src/task/gc.ts`
- `packages/selene/src/task/repair.ts`
- optionally a debug/CLI entrypoint such as `packages/selene/src/cli/cmd/debug/task.ts`

#### Features
Implement:

- retention windows for durable task artifacts
- cleanup scheduler
- orphan detection for worktrees and broken branch records
- repair/report utility for corrupted or partial task state
- metrics/logging around cleanup and repair actions
- explicit dry-run mode for repair/cleanup actions where practical

#### Tests required
- GC removes old durable artifacts but preserves recent ones
- repair detects missing child session references
- repair detects stale running jobs with dead heartbeats
- orphaned worktrees are reported and optionally cleaned

#### Acceptance criteria
- durable task storage does not grow forever without control
- repair tooling can inspect and clean broken task state
- cleanup actions are observable in logs

---

### PR8 — prompt + orchestration tuning for broad analysis

#### Goal
Improve broad-analysis subagent behavior so the system fans out faster and returns denser operator-grade results.

#### Problem this solves
Even with better task infrastructure, broad prompts like “analyze this codebase” can still feel bursty or under-parallelized because prompt policy and orchestration style are not optimized enough.

#### Scope
Tune subagent instructions and orchestration guidance for faster, denser, more parallel broad-analysis behavior.

#### Files expected to change
- `packages/selene/src/agent/prompt/explore.txt`
- `packages/selene/src/tool/task.txt`
- `packages/selene/src/session/prompt/codex_header.txt`
- optionally `packages/selene/src/agent/agent.ts`

#### Behavioral targets
Subagents should:

- start with a batched repo map for broad analysis tasks
- batch independent reads/searches early
- distinguish research-only vs research-and-edit work
- return concise operator summaries with:
  - findings
  - evidence
  - confidence
  - next steps
- avoid low-value chatter and repeated self-narration

#### Optional extension
If `general` and `explore` remain overloaded, add a dedicated `analysis` subagent with stricter broad-scan behavior.

#### Tests/validation required
- prompt snapshots or structured tests where feasible
- real regression prompts such as:
  - `analyze this codebase`
  - `review this subsystem`
  - `find likely race conditions`
- observation that the first tool fan-out is broader and denser than before

#### Acceptance criteria
- broad analysis prompts fan out faster
- subagent outputs are denser and more operator-useful
- prompt behavior is measurably improved without regressing editing flows

---

## Remaining PR sequence summary

- PR5 — append-only task events + event-backed watch/status/UI
- PR6 — richer branch judging and explainable winner selection
- PR7 — retention, repair, and cleanup tooling
- PR8 — prompt/orchestration tuning for broad analysis

## Final acceptance bar for the full roadmap

The overall subagent/task roadmap is complete when all of the following are true:

- resumed `task_id` cannot cross project/root/agent boundaries incorrectly
- child subagents inherit parent session restrictions exactly
- restart does not silently lose running background tasks
- web/TUI/control tower read core task/branch state from backend task objects rather than tool-part archaeology
- branch apply is conflict-safe and rollback-capable
- branch tournaments can be cancelled cleanly
- watch/status paths are event/cursor based rather than full-history rescans
- branch winner selection is explainable and testable
- durable task artifacts are retained and cleaned intentionally
- broad analysis prompts fan out quickly and return dense, operator-grade summaries
