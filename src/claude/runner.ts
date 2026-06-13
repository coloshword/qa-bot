import { spawn } from 'node:child_process';
import readline from 'node:readline';

export interface RunCallbacks {
  onSession?(id: string): void;
  onText?(text: string): void;
  onToolUse?(name: string, input: unknown): void;
  onResult?(r: { text: string; isError: boolean; costUsd?: number; stopReason?: string; numTurns?: number }): void;
}

export interface RunOptions {
  prompt: string;
  cwd: string;
  mcpConfigPath: string;
  playbook: string;
  model: string;
  maxTurns: number;
  sessionId: string;
  resuming?: boolean;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export interface RunHandle {
  promise: Promise<{ code: number; timedOut: boolean }>;
  kill: () => void;
}

export function runClaude(opts: RunOptions, cb: RunCallbacks): RunHandle {
  const args = [
    '--print',
    '--output-format', 'stream-json',
    '--verbose',
    '--mcp-config', opts.mcpConfigPath,
    '--strict-mcp-config',
    '--dangerously-skip-permissions',
    '--max-turns', String(opts.maxTurns),
    '--model', opts.model,
  ];
  if (opts.resuming) {
    args.push('--resume', opts.sessionId);
  } else {
    args.push('--session-id', opts.sessionId);
    if (opts.playbook) args.push('--append-system-prompt', opts.playbook);
  }
  args.push(opts.prompt);

  const child = spawn('claude', args, { cwd: opts.cwd, env: opts.env, stdio: ['ignore', 'pipe', 'pipe'] });
  const rl = readline.createInterface({ input: child.stdout });

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(trimmed);
    } catch {
      return;
    }
    handleEvent(ev, cb);
  });

  child.stderr.on('data', (d) => console.error('[claude stderr]', d.toString().trim()));

  let timedOut = false;
  const timer = opts.timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        console.error(`[claude] wallclock timeout (${opts.timeoutMs}ms) — killing process`);
        child.kill('SIGTERM');
      }, opts.timeoutMs)
    : null;

  const promise = new Promise<{ code: number; timedOut: boolean }>((resolve) => {
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? 0, timedOut });
    });
  });

  return { promise, kill: () => child.kill('SIGTERM') };
}

function handleEvent(ev: any, cb: RunCallbacks): void {
  switch (ev?.type) {
    case 'system':
      if (ev.subtype === 'init' && ev.session_id) cb.onSession?.(ev.session_id);
      break;
    case 'assistant':
      for (const block of ev.message?.content ?? []) {
        if (block.type === 'text' && block.text) cb.onText?.(block.text);
        else if (block.type === 'tool_use') cb.onToolUse?.(block.name, block.input);
      }
      break;
    case 'result':
      cb.onResult?.({
        text: ev.result ?? '',
        isError: !!ev.is_error,
        costUsd: typeof ev.total_cost_usd === 'number' ? ev.total_cost_usd : undefined,
        stopReason: typeof ev.subtype === 'string' ? ev.subtype : undefined,
        numTurns: typeof ev.num_turns === 'number' ? ev.num_turns : undefined,
      });
      break;
  }
}
