import 'dotenv/config';
import path from 'node:path';

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function reqClaudeAuth(): void {
  if (!process.env.CLAUDE_CODE_OAUTH_TOKEN && !process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      'Missing Claude auth: set CLAUDE_CODE_OAUTH_TOKEN (subscription, from `claude setup-token`) or ANTHROPIC_API_KEY (per-token billing)',
    );
  }
}

reqClaudeAuth();

const runsDir = process.env.RUNS_DIR ?? path.resolve('runs');

export const config = {
  slackBotToken: req('SLACK_BOT_TOKEN'),
  slackAppToken: req('SLACK_APP_TOKEN'),
  model: process.env.QA_MODEL ?? 'claude-sonnet-4-6',
  maxTurns: Number(process.env.CLAUDE_MAX_TURNS ?? '1500'),
  defaultEphemeralUrl: process.env.DEFAULT_EPHEMERAL_URL ?? '',
  jiraBaseUrl: (process.env.JIRA_BASE_URL ?? '').replace(/\/$/, ''),
  jiraEmail: process.env.JIRA_EMAIL ?? '',
  jiraApiToken: process.env.JIRA_API_TOKEN ?? '',
  runsDir,
  playbookPath: process.env.PLAYBOOK_PATH ?? path.resolve('QA_PLAYBOOK.md'),
  gotchasPath: process.env.QA_GOTCHAS_FILE ?? path.resolve('QA_GOTCHAS.md'),
  // When false, runs still READ prior gotchas (injected into the prompt) but the agent's
  // writes go to a per-run throwaway AND the post-run commit+push is skipped — keeps the
  // gotchas file frozen for reproducible benchmarks.
  gotchasUpdate: (process.env.QA_GOTCHAS_UPDATE ?? 'true').toLowerCase() !== 'false',
  // When true (default), the worker pre-warms a fresh PR job's primary slot the instant it's
  // claimed (`qa-stack prepare <branch>`: checkout + npm install + core tsc, all whitelabel-
  // agnostic) so that heavy work overlaps agent boot + planning. The agent's own `qa-stack up`
  // reuses it under a per-slot build lock. Set QA_PREWARM=false to disable.
  prewarm: (process.env.QA_PREWARM ?? 'true').toLowerCase() !== 'false',
  runTimeoutMs: Number(process.env.QA_RUN_TIMEOUT_MINS ?? '90') * 60 * 1000,
  stacksDir: process.env.QA_STACKS_DIR ?? path.resolve('stacks'),
  // Global budget of isolated stacks shared across all runs (RAM-bound, ~3 on a 24GB box).
  // A run takes 1 as primary; a big-epic orchestrator claims more as concurrent lanes.
  totalStacks: Number(process.env.QA_TOTAL_STACKS ?? '3'),
};
