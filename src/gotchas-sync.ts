import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from './config.js';

const exec = promisify(execFile);

// Serialize syncs: two parallel sessions ending together must not race on the git index.
let chain: Promise<void> = Promise.resolve();

/** Commit + push the gotchas file (and only it) so every session's learnings reach the
 *  remote and future deployments start with them. All failures are non-fatal. */
export function syncGotchas(label: string): Promise<void> {
  chain = chain.then(() => doSync(label));
  return chain;
}

async function doSync(label: string): Promise<void> {
  const file = config.gotchasPath;
  if (!fs.existsSync(file)) return;
  const cwd = path.dirname(file);
  const git = async (...args: string[]) => (await exec('git', args, { cwd })).stdout.trim();

  try {
    await git('add', '--', file);
    const staged = await git('diff', '--cached', '--name-only', '--', file);
    if (!staged) return; // nothing new learned this session

    // Pathspec commit: only the gotchas file, regardless of what else is dirty/staged.
    await git('commit', '-m', `qa-gotchas: ${label}`, '--', file);

    const branch = await git('rev-parse', '--abbrev-ref', 'HEAD');
    if (branch === 'HEAD') {
      console.error('[gotchas] detached HEAD — committed locally, skipping push');
      return;
    }
    try {
      await git('push', 'origin', `HEAD:${branch}`);
    } catch {
      // remote moved: integrate (autostash protects any dirty working tree) and retry once
      await git('pull', '--rebase', '--autostash', 'origin', branch);
      await git('push', 'origin', `HEAD:${branch}`);
    }
    console.log('[gotchas] pushed session learnings:', label);
  } catch (e) {
    console.error('[gotchas] sync failed (non-fatal):', (e as Error).message);
  }
}
