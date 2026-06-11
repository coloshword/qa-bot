# QA Bot

Slack-triggered QA agent. Mention it with a Jira ticket and/or an ephemeral URL; it drives the
flow in a real browser via Claude Code + Playwright MCP and posts step-by-step screenshots plus
a PASS/FAIL verdict back to the thread.

## Quick start

```sh
cp .env.example .env   # fill in the values (see below)
docker compose up --build
```

That single command builds the image (Claude Code, Playwright + chromium, gh, acli) and starts
the bot connected to Slack over Socket Mode.

## Configuration (`.env`)

| Var | Required | Notes |
|-----|----------|-------|
| `SLACK_BOT_TOKEN` | yes | `xoxb-…`, posts + uploads |
| `SLACK_APP_TOKEN` | yes | `xapp-…`, opens the Socket Mode websocket |
| `CLAUDE_CODE_OAUTH_TOKEN` | one of these | subscription auth, from `claude setup-token` |
| `ANTHROPIC_API_KEY` | one of these | per-token billing alternative |
| `QA_MODEL` | no | default `claude-sonnet-4-6` |
| `CLAUDE_MAX_TURNS` | no | default `60` |
| `GH_TOKEN` | no | passed to `gh` |
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
@qa-bot QA EN-15242 — walk the skip flow on the series box   https://<ephemeral>/...
```

Reply in the same thread to continue (follow-up steers the same run context — planned).

## Notes

- Single-worker queue: one QA run at a time (avoids contention with other browser automation).
- Each run is isolated under `runs/<job-id>/` with its own MCP config + screenshot output dir.
- Network: the container must be able to reach the target URL. On macOS + a split-tunnel VPN,
  verify a container can reach VPN-only hosts before relying on it.
