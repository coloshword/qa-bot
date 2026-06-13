#!/usr/bin/env node
// qa-bench — trigger ONE faithful QA run and time it, for the optimization loop.
// Same claude invocation + playbook + stack/lane machinery the bot uses; posts to a fresh
// Slack thread (real qa-post). Records duration/turns/cost to bench/results.jsonl and a
// per-tool timestamped trace to bench/events-<runid>.jsonl so we can see where time goes.
//
// Env required (source .env first): SLACK_BOT_TOKEN, CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY.
// Usage: node bin/qa-bench.mjs <PR_URL> <spec-file> [label]

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebClient } from '@slack/web-api';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = (n) => path.join(ROOT, 'bin', n);
const STACKS_DIR = process.env.QA_STACKS_DIR ?? path.join(ROOT, 'stacks');
const POOL_DIR = path.join(STACKS_DIR, '.pool');
const TOTAL_STACKS = Number(process.env.QA_TOTAL_STACKS ?? '3');
const BENCH_DIR = path.join(ROOT, 'bench');
const CHANNEL = process.env.QA_BENCH_CHANNEL ?? 'C0B9R0Z13HR';
const MODEL = process.env.QA_MODEL ?? 'claude-sonnet-4-6';
const MAX_TURNS = Number(process.env.CLAUDE_MAX_TURNS ?? '1500');

const [prUrl, specFile, label = 'bench'] = process.argv.slice(2);
if (!prUrl || !specFile) {
  console.error('usage: qa-bench.mjs <PR_URL> <spec-file> [label]');
  process.exit(1);
}

// --- pool (mirror src/stack-pool.ts) ---
function claimAny(owner) {
  fs.mkdirSync(POOL_DIR, { recursive: true });
  for (let id = 1; id <= TOTAL_STACKS; id++) {
    try {
      fs.mkdirSync(path.join(POOL_DIR, `claimed-${id}`));
    } catch {
      continue;
    }
    fs.writeFileSync(path.join(POOL_DIR, `claimed-${id}`, 'owner'), owner);
    return id;
  }
  return undefined;
}
function releaseOwner(owner) {
  if (!fs.existsSync(POOL_DIR)) return;
  for (const e of fs.readdirSync(POOL_DIR)) {
    if (!/^claimed-\d+$/.test(e)) continue;
    let o = '';
    try {
      o = fs.readFileSync(path.join(POOL_DIR, e, 'owner'), 'utf8').trim();
    } catch {}
    if (o === owner) fs.rmSync(path.join(POOL_DIR, e), { recursive: true, force: true });
  }
}

// --- prompt (mirror src/claude/prompt.ts renderPrompt) ---
function renderPrompt(spec, priorGotchas) {
  return [
    'You are an autonomous QA engineer for Book of the Month. Follow the "QA workflow" section of your playbook exactly and in order.',
    `Pull request to QA: ${prUrl}`,
    `\nCheck to perform:\nbuild your own test plan from the diff/PR/ticket; the full product spec for context is below.\n\n${spec}`,
    priorGotchas ? `\nKnown gotchas from past runs (use these, and append new ones to $QA_GOTCHAS_FILE):\n${priorGotchas}` : '',
    '',
    'Non-negotiables:',
    '- Read the ENTIRE diff + PR + ticket, then generate test cases scaled to the change (epic → 8–20).',
    '- >4 cases → orchestrate: delegate each case to a qa-case-executor subagent; never open the browser yourself.',
    '- Run the spec-conformance-reviewer; its findings become test cases proven behaviorally.',
    '- Exactly ONE voice posts per case (subagent if delegated, else you).',
    '- A FAIL citing code is invalid until you RUN the mechanism and capture the effect.',
    '- Finish with a summary verdict @-mentioning the requester.',
  ]
    .filter((l) => l !== '')
    .join('\n');
}

// --- multi-lane mcp (mirror worker.writeMcpConfig) ---
function writeMcp(mcpPath, artifactsDir) {
  const servers = {};
  for (let id = 1; id <= TOTAL_STACKS; id++) {
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

async function main() {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) throw new Error('SLACK_BOT_TOKEN missing (source .env)');
  const slack = new WebClient(token);

  const gitSha = (await import('node:child_process')).execSync('git rev-parse --short HEAD', { cwd: ROOT }).toString().trim();
  const root = await slack.chat.postMessage({
    channel: CHANNEL,
    text: `:stopwatch: *benchmark run* — \`${label}\` @ ${gitSha} — ${prUrl}`,
  });
  const thread = root.ts;

  const runId = randomUUID();
  const runDir = path.join(ROOT, 'runs', runId);
  const artifactsDir = path.join(runDir, 'artifacts');
  const inboxDir = path.join(runDir, 'inbox');
  fs.mkdirSync(artifactsDir, { recursive: true });
  fs.mkdirSync(inboxDir, { recursive: true });
  fs.cpSync(path.join(ROOT, 'agents'), path.join(runDir, '.claude', 'agents'), { recursive: true });
  const mcpPath = path.join(runDir, 'mcp.json');
  writeMcp(mcpPath, artifactsDir);
  fs.writeFileSync(
    path.join(runDir, '.claude', 'settings.json'),
    JSON.stringify({ hooks: { PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: `node "${BIN('qa-inbox-hook.mjs')}"` }] }] } }, null, 2),
  );

  const slot = claimAny(runId);
  if (slot === undefined) throw new Error('pool full — another QA run is active; wait and retry');

  const spec = fs.readFileSync(specFile, 'utf8');
  const playbook = fs.readFileSync(path.join(ROOT, 'QA_PLAYBOOK.md'), 'utf8');
  // Frozen, spoiler-free gotchas: every benchmark run starts from the SAME fresh-QA knowledge
  // state and appends to a throwaway. Otherwise prior runs leak the bug ("already known from
  // run 4") and later runs skip re-proving it — wrecking both correctness signal and reproducibility.
  const frozen = path.join(BENCH_DIR, 'gotchas-frozen.md');
  const gotchasFile = path.join(runDir, 'gotchas.md');
  fs.copyFileSync(frozen, gotchasFile);
  const priorGotchas = fs.readFileSync(gotchasFile, 'utf8').slice(-6000);
  const prompt = renderPrompt(spec, priorGotchas);

  const env = {
    ...process.env,
    QA_MIGRATE_TOLERANT: '1', // mirror PR is old code vs newer snapshot — let lanes build anyway
    QA_POST_BIN: BIN('qa-post.mjs'),
    QA_DB_BIN: BIN('qa-db.mjs'),
    QA_STACK_BIN: BIN('qa-stack.mjs'),
    QA_STACK_SLOT: String(slot),
    QA_RUN_ID: runId,
    QA_XAVIER_CHECKOUT: path.join(STACKS_DIR, `slot${slot}`, 'Xavier'),
    QA_INBOX: inboxDir,
    QA_ARTIFACTS_DIR: artifactsDir,
    QA_GOTCHAS_FILE: gotchasFile,
    QA_SLACK_CHANNEL: CHANNEL,
    QA_SLACK_THREAD: thread,
    QA_SLACK_REQUESTER: '',
  };

  const args = [
    '--print', '--output-format', 'stream-json', '--verbose',
    '--mcp-config', mcpPath, '--strict-mcp-config', '--dangerously-skip-permissions',
    '--max-turns', String(MAX_TURNS), '--model', MODEL,
    '--session-id', runId, '--append-system-prompt', playbook, prompt,
  ];

  const eventsLog = path.join(BENCH_DIR, `events-${label}-${gitSha}-${runId.slice(0, 8)}.jsonl`);
  fs.mkdirSync(BENCH_DIR, { recursive: true });
  const t0 = Date.now();
  console.log(`[bench] ${label} @ ${gitSha} slot ${slot} — starting ${prUrl}`);

  const child = spawn('claude', args, { cwd: runDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const rl = readline.createInterface({ input: child.stdout });
  let turns, cost, isError, status;
  rl.on('line', (line) => {
    let ev;
    try { ev = JSON.parse(line); } catch { return; }
    const el = Math.round((Date.now() - t0) / 1000);
    if (ev.type === 'assistant') {
      for (const b of ev.message?.content ?? []) {
        if (b.type === 'tool_use') {
          const sum = b.name === 'Bash' ? (b.input?.command ?? '') : JSON.stringify(b.input ?? {});
          fs.appendFileSync(eventsLog, JSON.stringify({ t: el, tool: b.name, sum: String(sum).slice(0, 200) }) + '\n');
        }
      }
    } else if (ev.type === 'result') {
      turns = ev.num_turns; cost = ev.total_cost_usd; isError = ev.is_error; status = ev.subtype;
    }
  });
  child.stderr.on('data', (d) => process.stderr.write(d));

  const code = await new Promise((r) => child.on('close', r));
  const durationSec = Math.round((Date.now() - t0) / 1000);
  releaseOwner(runId);

  const rec = { ts: new Date(t0).toISOString(), label, gitSha, prUrl, durationSec, durationMin: +(durationSec / 60).toFixed(1), turns, costUsd: cost, status, isError: !!isError, exitCode: code, eventsLog: path.basename(eventsLog), runId };
  fs.appendFileSync(path.join(BENCH_DIR, 'results.jsonl'), JSON.stringify(rec) + '\n');
  await slack.chat.postMessage({ channel: CHANNEL, thread_ts: thread, text: `:checkered_flag: benchmark \`${label}\` done — *${rec.durationMin} min* (${turns ?? '?'} turns, $${cost?.toFixed?.(2) ?? '?'})` });
  console.log(`[bench] DONE ${label}: ${rec.durationMin} min, ${turns} turns, $${cost?.toFixed?.(2) ?? '?'}`);
  console.log(JSON.stringify(rec));
}

main().catch((e) => { console.error('[bench] failed:', e.message); process.exit(1); });
