import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { WebClient } from '@slack/web-api';
import { config } from '../config.js';
import { runClaude } from '../claude/runner.js';
import { renderPrompt } from '../claude/prompt.js';
import { post } from '../slack/post.js';

const QA_POST_BIN = fileURLToPath(new URL('../../bin/qa-post.mjs', import.meta.url));

export interface Job {
  prUrl?: string;
  ticket?: string;
  url?: string;
  instructions: string;
  channel: string;
  thread: string;
  requester?: string;
  client: WebClient;
}

const queue: Job[] = [];
let running = false;

export function enqueue(job: Job): void {
  queue.push(job);
  void pump();
}

async function pump(): Promise<void> {
  if (running) return;
  const job = queue.shift();
  if (!job) return;
  running = true;
  try {
    await processJob(job);
  } catch (e) {
    console.error('[worker] job failed', e);
    await post(job.client, job.channel, job.thread, `:x: QA run crashed: ${(e as Error).message}`);
  } finally {
    running = false;
    if (queue.length) void pump();
  }
}

function writeMcpConfig(mcpPath: string, artifactsDir: string): void {
  fs.writeFileSync(
    mcpPath,
    JSON.stringify(
      {
        mcpServers: {
          playwright: {
            command: 'npx',
            args: ['@playwright/mcp@latest', '--headless', '--isolated', '--no-sandbox', '--output-dir', artifactsDir],
          },
        },
      },
      null,
      2,
    ),
  );
}

async function processJob(job: Job): Promise<void> {
  const jobId = randomUUID();
  const runDir = path.join(config.runsDir, jobId);
  const artifactsDir = path.join(runDir, 'artifacts');
  fs.mkdirSync(artifactsDir, { recursive: true });

  const mcpConfigPath = path.join(runDir, 'mcp.json');
  writeMcpConfig(mcpConfigPath, artifactsDir);

  const playbook = fs.existsSync(config.playbookPath) ? fs.readFileSync(config.playbookPath, 'utf8') : '';
  const priorGotchas = fs.existsSync(config.gotchasPath)
    ? fs.readFileSync(config.gotchasPath, 'utf8').slice(-6000)
    : '';
  const prompt = renderPrompt({
    prUrl: job.prUrl,
    ticket: job.ticket,
    url: job.url,
    instructions: job.instructions,
    priorGotchas,
  });

  await runClaude(
    {
      prompt,
      cwd: runDir,
      mcpConfigPath,
      playbook,
      model: config.model,
      maxTurns: config.maxTurns,
      sessionId: jobId,
      env: {
        ...process.env,
        QA_POST_BIN,
        QA_ARTIFACTS_DIR: artifactsDir,
        QA_GOTCHAS_FILE: config.gotchasPath,
        QA_SLACK_CHANNEL: job.channel,
        QA_SLACK_THREAD: job.thread,
        QA_SLACK_REQUESTER: job.requester ?? '',
      },
    },
    {
      onText: (t) => console.log('[agent]', t.slice(0, 200)),
      onToolUse: (name) => console.log('[tool]', name),
      onResult: (r) => {
        console.log('[result]', r.isError ? 'ERROR' : 'ok', r.costUsd ?? '');
        if (r.isError) {
          void post(
            job.client,
            job.channel,
            job.thread,
            `:warning: QA run ended with an error.\n${(r.text ?? '').slice(0, 600)}`,
          );
        }
      },
    },
  );
}
