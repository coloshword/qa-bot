import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

// Filesystem-based allocation pool for the global stack budget. Claims are atomic
// (mkdir throws on existing), so the worker (this module) and the qa-stack CLI
// (bin/qa-stack.mjs, which mirrors this protocol) can claim/release safely in parallel.
//
// Marker: <stacksDir>/.pool/claimed-<id>/  (dir) containing an `owner` file.

const POOL_DIR = path.join(config.stacksDir, '.pool');

function ensure(): void {
  fs.mkdirSync(POOL_DIR, { recursive: true });
}

function tryClaim(id: number, owner: string): boolean {
  const marker = path.join(POOL_DIR, `claimed-${id}`);
  try {
    fs.mkdirSync(marker); // atomic — fails if another process holds it
  } catch {
    return false;
  }
  fs.writeFileSync(path.join(marker, 'owner'), owner);
  return true;
}

/** Claim any free stack id (1..totalStacks). Returns the id, or undefined if the pool is full. */
export function claimAny(owner: string): number | undefined {
  ensure();
  for (let id = 1; id <= config.totalStacks; id++) {
    if (tryClaim(id, owner)) return id;
  }
  return undefined;
}

/** Claim a specific stack id (for resumes that must return to their built stack). */
export function claimSpecific(id: number, owner: string): boolean {
  ensure();
  return tryClaim(id, owner);
}

/** Release every stack held by an owner. Returns the released ids. */
export function releaseOwner(owner: string): number[] {
  ensure();
  const released: number[] = [];
  for (const entry of fs.readdirSync(POOL_DIR)) {
    const m = entry.match(/^claimed-(\d+)$/);
    if (!m) continue;
    const dir = path.join(POOL_DIR, entry);
    let o = '';
    try {
      o = fs.readFileSync(path.join(dir, 'owner'), 'utf8').trim();
    } catch {
      /* partial claim — clean it up below */
    }
    if (o === owner) {
      fs.rmSync(dir, { recursive: true, force: true });
      released.push(Number(m[1]));
    }
  }
  return released;
}

export function freeCount(): number {
  ensure();
  let used = 0;
  for (const e of fs.readdirSync(POOL_DIR)) if (/^claimed-\d+$/.test(e)) used++;
  return Math.max(0, config.totalStacks - used);
}
