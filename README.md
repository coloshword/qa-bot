# QA Bot

Slack-triggered QA agent. Mention it with a GitHub PR (and/or Jira ticket); it brings up the
PR's branch as a **local Xavier stack** on this machine, drives the flow in a real browser via
Claude Code + Playwright MCP, and posts step-by-step screenshots plus a PASS/FAIL verdict back
to the thread. Multiple tickets QA in parallel — each run gets its own isolated stack slot
(own DB container, redis pair, service ports).

## Quick start (host mode — required for local stacks)

The bot now runs **on the host**, not in Docker: it manages git checkouts, npm builds, and
sibling Docker containers (DB/redis) per slot.

Prereqs on this machine:
- Docker running, `gh` authenticated, Node 20+
- A Xavier clone at `../Xavier` with `.env.local.xavier` (and `.env.allurial-local.xavier`)
  populated via `make copy-environment` (Teller)

```sh
cp .env.example .env   # fill in the values (see below)
make dev               # npm install + run the bot
```

## Local stacks (qa-stack)

`bin/qa-stack.mjs` manages per-slot stacks under `stacks/slot<N>/`. Slot N's ports:
base `20000 + (N-1)*100` → snes `+30`, core `+82`, db `+6`, botm-admin `+50`, admin `+51`,
redis near/far `+79`/`+78`. The agent gets `QA_STACK_SLOT` per run and calls:

```
qa-stack up <branch> [--whitelabel botm|allurial]   # checkout, clean build, fresh DB, migrations, core+snes  (~2–4 min warm)
qa-stack reset-db                                   # pristine accountless DB + redis flush + migrations
qa-stack sql "<SQL>"                                # query the slot DB
qa-stack run-script node build/scripts/<x>.js       # run crons/scripts against the slot (seconds, vs ~10 min on an ephemeral)
qa-stack start botm-admin | logs core | status | down
```

First `up` on a slot clones Xavier (from the local `../Xavier`, so it's fast) and npm-installs
all services — one-time ~10 min. After that, branch swaps are minutes. Ephemerals remain the
documented fallback for what local can't do (cerebro search, queueworld/newworld, shareable URLs).

The agent also gets `QA_XAVIER_CHECKOUT` pointing at its slot's source tree (the exact branch
under test), so it can grep real code — selectors, cron entrypoints, whitelabel gating — instead
of working from the PR diff alone. `qa-stack up` posts progress pings (checkout → building →
READY) to the QA thread itself.

## Configuration (`.env`)

| Var | Required | Notes |
|-----|----------|-------|
| `SLACK_BOT_TOKEN` | yes | `xoxb-…`, posts + uploads |
| `SLACK_APP_TOKEN` | yes | `xapp-…`, opens the Socket Mode websocket |
| `CLAUDE_CODE_OAUTH_TOKEN` | one of these | subscription auth, from `claude setup-token` |
| `ANTHROPIC_API_KEY` | one of these | per-token billing alternative |
| `QA_MODEL` | no | default `claude-sonnet-4-6` |
| `CLAUDE_MAX_TURNS` | no | default `1500` |
| `GH_TOKEN` | no | passed to `gh` |
| `QA_TOTAL_STACKS` | no | global budget of isolated stacks shared across all runs, default `3` (RAM-bound, ~3 on 24GB). A run takes 1; a big-epic orchestrator claims more as concurrent lanes. |
| `QA_XAVIER_SOURCE` | no | path to the seed Xavier clone, default `../Xavier` |
| `QA_STACKS_DIR` | no | where slot clones live, default `./stacks` |
| `JIRA_BASE_URL` / `JIRA_EMAIL` / `JIRA_API_TOKEN` | no | Jira ticket context |
| `DEFAULT_EPHEMERAL_URL` | no | fallback when a mention omits a URL |

## Claude auth: use a subscription

Subscriptions don't have API keys — they auth via OAuth. Generate a long-lived token once on any
machine with a browser:

```sh
claude setup-token
```

Paste the result into `.env` as `CLAUDE_CODE_OAUTH_TOKEN`. The token is account-bound, not
machine-bound, so it works wherever you drop it (mini, container, CI). Usage counts against your
personal subscription rate limits.

## Usage

In a channel the bot is in:

```
@qa-bot QA https://github.com/bookofthemonthclub/Xavier/pull/12345 — walk the skip flow on the series box
```

Reply in the same thread to continue — follow-ups resume the same run (and same stack slot),
even interrupting a run in progress.

## Notes

- Concurrency = `QA_STACK_SLOTS` (default 2). Each run is pinned to a slot; resumes return to
  their slot since the branch checkout + DB state live there.
- Each run is isolated under `runs/<job-id>/` with its own MCP config + screenshot output dir.
- Docker mode (`docker compose up`) still exists but only supports the ephemeral flow —
  `qa-stack` needs host npm/Docker, so local-stack QA requires host mode.
