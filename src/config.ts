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
  runTimeoutMs: Number(process.env.QA_RUN_TIMEOUT_MINS ?? '90') * 60 * 1000,
  stackSlots: Number(process.env.QA_STACK_SLOTS ?? '2'),
};
