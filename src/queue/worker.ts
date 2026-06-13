import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { WebClient } from '@slack/web-api';
import { config } from '../config.js';
import { runClaude } from '../claude/runner.js';
import { renderPrompt } from '../claude/prompt.js';
import { post } from '../slack/post.js';
import { syncGotchas } from '../gotchas-sync.js';
import * as pool from '../stack-pool.js';
import * as sessionStore from '../session-store.js';

const QA_POST_BIN = fileURLToPath(new URL('../../bin/qa-post.mjs', import.meta.url));
const QA_INBOX_HOOK = fileURLToPath(new URL('../../bin/qa-inbox-hook.mjs', import.meta.url));
const QA_DB_BIN = fileURLToPath(new URL('../../bin/qa-db.mjs', import.meta.url));
const QA_STACK_BIN = fileURLToPath(new URL('../../bin/qa-stack.mjs', import.meta.url));
const STACKS_DIR = process.env.QA_STACKS_DIR ?? fileURLToPath(new URL('../../stacks', import.meta.url));
const AGENTS_SRC = fileURLToPath(new URL('../../agents', import.meta.url));

export interface Job {
  prUrl?: string;
  ticket?: string;
  url?: string;
  instructions: string;
  channel: string;
  thread: string;
  requester?: string;
  client: WebClient;
  isResume?: boolean;
  resumeSessionId?: string;
  /** Resumes must run on the slot that holds their stack (branch checkout + DB state). */
  requiredSlot?: number;
}

interface ActiveRun {
  thread: string;
  primarySlot: number;
  runId: string;
  kill: () => void;
}

const queue: Job[] = [];
const active = new Map<string, ActiveRun>(); // thread -> running job (holds its primary + any lanes)

export function enqueue(job: Job): void {
  queue.push(job);
  pump();
}

export function interrupt(thread: string, message: string, client: WebClient, channel: string, requester?: string): boolean {
  const session = sessionStore.get(thread);
  if (!session) return false;
  const run = active.get(thread);
  if (!run) return false;
  const slot = run.primarySlot;

  // Explicit stop words are the only thing that kills a run (and its subagents).
  if (/^\s*(stop|abort|cancel|kill)\b/i.test(message)) {
    console.log('[worker] STOP requested on thread', thread, 'slot', slot);
    run.kill();
    enqueue({
      instructions: `The user stopped the run with: "${message}". Acknowledge via qa-post, summarize where you left off (cases done/remaining), and await further instructions.`,
      channel,
      thread,
      requester,
      client,
      isResume: true,
      resumeSessionId: session.sessionId,
      requiredSlot: session.slot,
    });
    return true;
  }

  // Everything else is non-destructive: drop it in the run's inbox. The orchestrator
  // reads the inbox at every test-case boundary — in-flight work (and subagents) survive.
  const inboxDir = path.join(session.runDir, 'inbox');
  fs.mkdirSync(inboxDir, { recursive: true });
  fs.writeFileSync(path.join(inboxDir, `${Date.now()}.md`), message.trim() + '\n');
  console.log('[worker] inbox message for thread', thread, 'slot', slot);
  void post(
    client,
    channel,
    thread,
    ':envelope_with_arrow: noted — delivering to the agent now (reply `stop` to abort the run).',
  );
  return true;
}

function pump(): void {
  for (let i = 0; i < queue.length; ) {
    const job = queue[i];
    if (active.has(job.thread)) {
      i++; // a run is already live on this thread; don't double-start
      continue;
    }
    const runId = randomUUID();
    // Resumes try to return to their built stack; fresh jobs take any free stack.
    let slot: number | undefined;
    if (job.requiredSlot && pool.claimSpecific(job.requiredSlot, runId)) {
      slot = job.requiredSlot;
    } else {
      slot = pool.claimAny(runId);
    }
    if (slot === undefined) {
      i++; // pool full — leave queued; a finishing run will pump() again
      continue;
    }
    queue.splice(i, 1);
    active.set(job.thread, { thread: job.thread, primarySlot: slot, runId, kill: () => {} });
    void runJob(job, slot, runId).finally(() => {
      const released = pool.releaseOwner(runId); // primary + any lanes the run claimed
      console.log(`[worker] released stacks [${released.join(',')}] for run ${runId.slice(0, 8)}`);
      active.delete(job.thread);
      pump();
    });
  }
}

async function runJob(job: Job, slot: number, runId: string): Promise<void> {
  try {
    if (job.isResume && job.resumeSessionId) {
      await executeJob(job, slot, runId, { resumeSessionId: job.resumeSessionId });
    } else {
      await executeJob(job, slot, runId, {});
    }
  } catch (e) {
    console.error(`[worker] job failed (slot ${slot})`, e);
    await post(job.client, job.channel, job.thread, `:x: QA run crashed: ${(e as Error).message}`);
  }
}

// One-line summary of a tool call's INPUT, so the log shows what the agent did,
// not just which tool it used — makes delegation/skip compliance visible.
function summarizeTool(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const clip = (s: unknown, n = 160) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
  switch (name) {
    case 'Bash':
      return clip(i.command, 200);
    case 'Task':
      return `subagent=${i.subagent_type ?? '?'} :: ${clip(i.description, 120)}`;
    case 'Read':
    case 'Edit':
    case 'Write':
      return clip(i.file_path);
    case 'Grep':
      return `${clip(i.pattern, 80)}${i.path ? ' in ' + clip(i.path, 80) : ''}`;
    default:
      if (name.startsWith('mcp__playwright__')) {
        return clip(i.url ?? i.element ?? i.text ?? i.selector ?? JSON.stringify(i), 120);
      }
      return clip(JSON.stringify(i), 160);
  }
}

// One browser per possible lane so concurrent subagents don't serialize on a shared browser.
// First server is `playwright` (the primary lane — keeps single-lane runs unchanged); extras
// are `lane2`, `lane3`, … The orchestrator assigns an added lane the next free browser server.
// Servers start lazily-ish (a node process each; the Chromium only launches on first browser call).
function writeMcpConfig(mcpPath: string, artifactsDir: string): void {
  const servers: Record<string, unknown> = {};
  for (let id = 1; id <= config.totalStacks; id++) {
    const name = id === 1 ? 'playwright' : `lane${id}`;
    const out = path.join(artifactsDir, name);
    fs.mkdirSync(out, { recursive: true });
    servers[name] = {
      command: 'npx',
      args: ['@playwright/mcp@latest', '--headless', '--isolated', '--no-sandbox', '--output-dir', out],
    };
  }
  fs.writeFileSync(mcpPath, JSON.stringify({ mcpServers: servers }, null, 2));
}

async function executeJob(job: Job, slot: number, runId: string, opts: { resumeSessionId?: string }): Promise<void> {
  const resuming = !!opts.resumeSessionId;
  const session = resuming ? sessionStore.get(job.thread) : undefined;
  const jobId = randomUUID();
  const runDir = resuming && session?.runDir ? session.runDir : path.join(config.runsDir, jobId);
  const artifactsDir = path.join(runDir, 'artifacts');
  fs.mkdirSync(artifactsDir, { recursive: true });

  const mcpConfigPath = path.join(runDir, 'mcp.json');
  writeMcpConfig(mcpConfigPath, artifactsDir);

  // Subagent definitions (Task tool) are discovered from cwd/.claude/agents.
  fs.cpSync(AGENTS_SRC, path.join(runDir, '.claude', 'agents'), { recursive: true });
  const inboxDir = path.join(runDir, 'inbox');
  fs.mkdirSync(inboxDir, { recursive: true });

  // PostToolUse hook: delivers inbox messages into the live agent context within
  // seconds (fires on every tool call, in the orchestrator and inside subagents).
  fs.writeFileSync(
    path.join(runDir, '.claude', 'settings.json'),
    JSON.stringify(
      {
        hooks: {
          PostToolUse: [
            { matcher: '*', hooks: [{ type: 'command', command: `node "${QA_INBOX_HOOK}"` }] },
          ],
        },
      },
      null,
      2,
    ),
  );

  let prompt: string;
  let playbook = '';
  if (resuming) {
    prompt = job.instructions.trim() || 'Continue with the QA plan as previously discussed.';
  } else {
    playbook = fs.existsSync(config.playbookPath) ? fs.readFileSync(config.playbookPath, 'utf8') : '';
    const priorGotchas = fs.existsSync(config.gotchasPath)
      ? fs.readFileSync(config.gotchasPath, 'utf8').slice(-6000)
      : '';
    prompt = renderPrompt({
      prUrl: job.prUrl,
      ticket: job.ticket,
      url: job.url,
      instructions: job.instructions,
      priorGotchas,
    });
  }

  const jobEnv = {
    ...process.env,
    QA_POST_BIN,
    QA_DB_BIN,
    QA_STACK_BIN,
    QA_STACK_SLOT: String(slot),
    QA_RUN_ID: runId, // pool-ownership tag: `qa-stack add-lane --owner $QA_RUN_ID` claims under this
    QA_XAVIER_CHECKOUT: path.join(STACKS_DIR, `slot${slot}`, 'Xavier'),
    QA_INBOX: inboxDir,
    QA_ARTIFACTS_DIR: artifactsDir,
    QA_GOTCHAS_FILE: config.gotchasPath,
    QA_SLACK_CHANNEL: job.channel,
    QA_SLACK_THREAD: job.thread,
    QA_SLACK_REQUESTER: job.requester ?? '',
  };

  const tag = resuming ? 'resume' : 'run';
  let capturedSessionId: string | undefined;
  const handle = runClaude(
    {
      prompt,
      cwd: runDir,
      mcpConfigPath,
      playbook,
      model: config.model,
      maxTurns: config.maxTurns,
      sessionId: opts.resumeSessionId ?? jobId,
      resuming,
      timeoutMs: config.runTimeoutMs,
      env: jobEnv,
    },
    {
      onSession: (id) => {
        capturedSessionId = id;
        sessionStore.set(job.thread, id, job.channel, runDir, slot);
        console.log(`[worker] session stored (slot ${slot})`, job.thread, '->', id);
      },
      onText: (t) => console.log(`[agent/${tag}:${slot}]`, t.slice(0, 200)),
      onToolUse: (name, input) => console.log(`[tool/${tag}:${slot}]`, name, '·', summarizeTool(name, input)),
      onResult: (r) => {
        console.log(`[result/${tag}:${slot}]`, r.isError ? 'ERROR' : 'ok', `turns=${r.numTurns ?? '?'}`, `stop=${r.stopReason ?? '?'}`, r.costUsd ?? '');
        if (r.isError) {
          void post(
            job.client,
            job.channel,
            job.thread,
            `:warning: QA run ended with an error.\n${(r.text ?? '').slice(0, 600)}`,
          );
        } else {
          void post(
            job.client,
            job.channel,
            job.thread,
            `:white_check_mark: run complete — see ya! (${r.numTurns ?? '?'} turns, $${r.costUsd?.toFixed(2) ?? '?'})`,
          );
        }
      },
    },
  );
  const run = active.get(job.thread);
  if (run) run.kill = handle.kill;
  const { timedOut } = await handle.promise;

  if (timedOut) {
    console.error(`[worker/${tag}:${slot}] run timed out — killed after`, config.runTimeoutMs / 60000, 'min');
    await post(
      job.client,
      job.channel,
      job.thread,
      `:alarm_clock: QA run timed out after ${config.runTimeoutMs / 60000} min. Session \`${capturedSessionId ?? opts.resumeSessionId ?? jobId}\` is preserved — reply to resume.`,
    );
  }

  // Share what this session learned: commit + push the gotchas file so the next
  // session (and any freshly cloned deployment) starts smarter.
  await syncGotchas(job.ticket ?? job.prUrl ?? `session ${job.thread}`);
}
