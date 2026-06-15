# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Slack-triggered QA bot. Mention it in Slack with a GitHub PR (and/or Jira ticket); it brings up
the PR's branch as an **isolated local Xavier stack** on this machine, spawns a Claude Code agent
that drives the flow in a real browser (Playwright MCP), and posts step-by-step screenshots plus a
PASS/FAIL verdict back to the thread. Multiple tickets run in parallel, each pinned to its own stack
slot (own DB container, redis pair, service ports).

This is a *thin TypeScript host* that orchestrates a *Claude Code subprocess*. The interesting logic
lives in two places: the Node host (`src/`, `bin/`) and the **prompt/playbook/agent-definitions** that
steer the agent. Editing `QA_PLAYBOOK.md`, `src/claude/prompt.ts`, or `agents/*.md` changes bot
behavior as much as editing code does.

## Commands

```sh
make dev          # npm install + run the bot with tsx watch (host mode — the normal way to run)
npm run dev       # same, no install
npm start         # run once without watch
npm run typecheck # tsc --noEmit (the only "test" — there is no test suite)
```

There is **no build, lint, or test command** beyond `typecheck`. Run `npm run typecheck` after
changing anything in `src/` (`bin/*.mjs` is plain JS, not type-checked).

Docker (`make up` / `docker compose up`) still exists but only supports the legacy ephemeral flow;
local-stack QA requires host mode because `qa-stack` shells out to host npm/Docker.

## Architecture

### Request lifecycle (one QA run)

1. **`src/index.ts`** — Slack Bolt app in Socket Mode. On `app_mention`, parses the text for a PR
   URL, Jira ticket key, raw URL, or `ephemeral:` name. A mention in a thread with a known session
   and no new link is treated as a **follow-up** (resume or live interrupt).
2. **`src/queue/worker.ts`** — the core. `enqueue()` → `pump()` drains the queue, claiming a stack
   slot per job (`stack-pool`). `runJob`/`executeJob` set up the per-run directory, write the MCP
   config + hooks + agent definitions, build the env, and call the runner. One run per Slack thread
   at a time (`active` map, keyed by thread).
3. **`src/claude/runner.ts`** — spawns the `claude` CLI as a subprocess (`--print
   --output-format stream-json --dangerously-skip-permissions`), parses the streaming JSON for
   session id / text / tool-use / result, and exposes `{ promise, kill }`. Enforces a wall-clock
   timeout (`QA_RUN_TIMEOUT_MINS`, default 90).
4. **`src/claude/prompt.ts`** — renders the initial user prompt (non-negotiables, test-case scaling
   rules). The **system prompt is `QA_PLAYBOOK.md`**, passed via `--append-system-prompt` on fresh
   runs only.
5. The agent does the actual QA: brings up the stack via `qa-stack`, drives the browser, posts to
   Slack via `qa-post`, and ends with a `## QA RESULT` block.

### Stack pool & slots

`src/stack-pool.ts` and `bin/qa-stack.mjs` implement the **same** filesystem-based allocation
protocol (atomic `mkdir` of `stacks/.pool/claimed-<id>/`), so the Node host and the agent-invoked
CLI can claim/release the global stack budget (`QA_TOTAL_STACKS`, default 3, RAM-bound) without
racing. If you change the protocol in one, change it in the other.

- Each run claims one slot as its **primary**. Resumes re-claim their *specific* slot (the branch
  checkout + DB state live there); fresh jobs take any free slot.
- A big-epic orchestrator can claim extra slots as concurrent **lanes** (`qa-stack add-lane`),
  tagged with `$QA_RUN_ID` so `releaseOwner(runId)` frees primary + lanes together when the run ends.
- Slot N's ports: `base = 20000 + (N-1)*100` → db `+6`, redis-near/far `+79`/`+78`, core `+82`,
  snes `+30`, botm-admin `+50`, admin `+51`.

### `bin/qa-stack.mjs` — the agent's stack manager

Per-slot local Xavier stacks under `stacks/slot<N>/`. First `up` on a slot clones Xavier from a
local seed (`QA_XAVIER_SOURCE`, default `../Xavier`) and npm-installs all services (one-time
~10 min); later branch swaps are minutes. Reads its slot from `$QA_STACK_SLOT` (set per-run by the
worker) or `--slot`. Sources Xavier's `.env.local.xavier` then applies per-slot port overrides.
Key subcommands: `up <branch> [--whitelabel botm|allurial]`, `reset-db`, `sql "<SQL>"`,
`run-script <node|python3> <path-in-core>`, `start <admin|botm-admin>`, `logs`, `status`, `down`,
and pool ops `pool` / `add-lane` / `release`.

### Agent-facing CLIs in `bin/` (invoked by the agent, not the host)

The worker passes their absolute paths to the agent as env vars (`$QA_POST_BIN`, `$QA_STACK_BIN`,
`$QA_DB_BIN`). The agent calls them via `node "$QA_..._BIN" ...`:

- **`qa-post.mjs`** (`$QA_POST_BIN`) — the ONLY channel for user-facing output. `msg|img|file`,
  `--mention` to ping the requester. Reads `QA_SLACK_*` env. The reviewer never sees the agent's
  raw stdout, only what goes through here.
- **`qa-stack.mjs`** (`$QA_STACK_BIN`) — described above.
- **`qa-db.mjs`** (`$QA_DB_BIN`) — queries an *ephemeral's* CloudBeaver GraphQL API (legacy
  ephemeral flow; local stacks use `qa-stack sql` instead).
- **`qa-inbox-hook.mjs`** — a Claude Code `PostToolUse` hook, not called directly. Delivers mid-run
  user messages from the run's `inbox/` into the live agent context (see below).

### Mid-run messaging (interrupt vs inbox)

While a run is live, a follow-up in its thread is handled by `interrupt()` in the worker:
- A message starting with `stop|abort|cancel|kill` **kills** the subprocess and enqueues a resume to
  acknowledge and summarize.
- Anything else is written to `runs/<id>/inbox/<ts>.md`. The `qa-inbox-hook` (wired via the run's
  generated `.claude/settings.json`) fires on every tool call and injects pending inbox messages
  into the agent — orchestrator *or* subagent — without interrupting in-flight work. Delivered files
  move to `inbox/delivered/` for at-most-once delivery.

### Subagents (the `Task` tool)

For plans with **>4 cases** the agent becomes an orchestrator and must delegate each case to a
subagent rather than driving the browser itself (to preserve its context over a long epic). Two
agent types in `agents/` are copied into each run's `.claude/agents/`:
- **`qa-case-executor`** — runs exactly ONE test case in one lane and returns a structured verdict.
- **`spec-conformance-reviewer`** — pure clause-by-clause read of the diff vs the ticket/epic; its
  findings are *hypotheses* the orchestrator must verify behaviorally, never bugs on their own.

### Per-run directory & sessions

Each run lives under `runs/<job-id>/`: `mcp.json` (one Playwright MCP server per possible lane —
`playwright`, `lane2`, `lane3`, …), `.claude/settings.json` (the inbox hook), `.claude/agents/`,
`inbox/`, and `artifacts/` (screenshots/logs, one subdir per lane). `src/session-store.ts` is an
in-memory `Map<threadTs, {sessionId, channel, runDir, slot}>` — **session continuity is not
persisted across host restarts**.

### Gotchas memory loop

`QA_GOTCHAS.md` is durable cross-run memory. Its tail is injected into the fresh-run prompt; the
agent appends new learnings to `$QA_GOTCHAS_FILE` during a run. After each run,
`src/gotchas-sync.ts` commits **only that file** (pathspec commit) and pushes it, so learnings reach
the remote and future deployments. Syncs are chained to avoid git-index races between parallel runs.

## Conventions

- ESM throughout (`"type": "module"`). TS source imports use `.js` extensions (NodeNext). Run via
  `tsx`, no compile step. `bin/*.mjs` are standalone Node scripts (no deps beyond `@slack/web-api`).
- `src/config.ts` centralizes env reading and validates required vars at startup (`req()` throws;
  Claude auth needs `CLAUDE_CODE_OAUTH_TOKEN` *or* `ANTHROPIC_API_KEY`). Add new config there.
- Side channels (Slack posting, gotchas push, progress pings) are best-effort: failures are logged,
  never thrown, so they can't break a run.

## Important constraints (behavioral, enforced via prompt)

These are baked into `prompt.ts` / `QA_PLAYBOOK.md` / `agents/*.md`. Preserve them when editing:
- **A code-cited FAIL is invalid until the real mechanism is run** and the misbehavior captured as
  an effect. Code-reading or querying pre-existing state = BLOCKED, never FAIL.
- **Arrange freely, never fake the Act**: preconditions can be set via SQL, but the behavior under
  test must be produced by the real mechanism (UI/API/script), never by writing the rows the
  mechanism is supposed to write.
- User-visible behavior requires a browser screenshot of the actual element; API/SQL only
  corroborates (unless the deliverable *is* the API/data).
- ~10-min cap per case, one changed-variable retry — never grind on a failing case.
