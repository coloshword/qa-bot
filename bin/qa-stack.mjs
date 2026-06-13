#!/usr/bin/env node
// qa-stack — manage per-slot local Xavier stacks for QA runs.
//
// Each slot is a fully independent stack: its own Xavier clone, accountless DB
// container, redis pair, and service ports, so multiple QA runs execute in
// parallel without touching each other.
//
// Usage (slot comes from $QA_STACK_SLOT, set per-run by the bot; --slot overrides):
//   qa-stack up <branch> [--whitelabel botm|allurial] [--no-pull]
//   qa-stack reset-db            fresh DB + redis flush + branch migrations
//   qa-stack sql "<SQL>"         run SQL against the slot DB (table output)
//   qa-stack run-script <node|python3> <path-in-core> [args...]
//   qa-stack start <admin|botm-admin>
//   qa-stack logs <core|snes|admin|botm-admin> [lines]
//   qa-stack status
//   qa-stack down
//
// Ports for slot N: base = 20000 + (N-1)*100
//   db=base+6  redis-near=base+79  redis-far=base+78  core=base+82
//   snes=base+30  botm-admin=base+50  admin=base+51

import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const XAVIER_SOURCE = process.env.QA_XAVIER_SOURCE ?? path.resolve(ROOT, '..', 'Xavier');
const STACKS_DIR = process.env.QA_STACKS_DIR ?? path.join(ROOT, 'stacks');
const TOTAL_STACKS = Number(process.env.QA_TOTAL_STACKS ?? '3');
const POOL_DIR = path.join(STACKS_DIR, '.pool');

// Allocation pool, mirroring src/stack-pool.ts (atomic mkdir claims). Shared with the worker.
function poolTryClaim(id, owner) {
  fs.mkdirSync(POOL_DIR, { recursive: true });
  const marker = path.join(POOL_DIR, `claimed-${id}`);
  try {
    fs.mkdirSync(marker);
  } catch {
    return false;
  }
  fs.writeFileSync(path.join(marker, 'owner'), owner);
  return true;
}
function poolClaimAny(owner) {
  for (let id = 1; id <= TOTAL_STACKS; id++) if (poolTryClaim(id, owner)) return id;
  return undefined;
}
function poolReleaseOwner(owner) {
  fs.mkdirSync(POOL_DIR, { recursive: true });
  const released = [];
  for (const entry of fs.readdirSync(POOL_DIR)) {
    const m = entry.match(/^claimed-(\d+)$/);
    if (!m) continue;
    const dir = path.join(POOL_DIR, entry);
    let o = '';
    try {
      o = fs.readFileSync(path.join(dir, 'owner'), 'utf8').trim();
    } catch {}
    if (o === owner) {
      fs.rmSync(dir, { recursive: true, force: true });
      released.push(Number(m[1]));
    }
  }
  return released;
}
function poolStatus() {
  fs.mkdirSync(POOL_DIR, { recursive: true });
  const claimed = {};
  for (const entry of fs.readdirSync(POOL_DIR)) {
    const m = entry.match(/^claimed-(\d+)$/);
    if (!m) continue;
    let o = '?';
    try {
      o = fs.readFileSync(path.join(POOL_DIR, entry, 'owner'), 'utf8').trim();
    } catch {}
    claimed[Number(m[1])] = o;
  }
  return claimed;
}

const DB_IMAGES = {
  botm: 'ghcr.io/bookofthemonthclub/xavier/xavier-accountless-db:latest',
  allurial: 'ghcr.io/bookofthemonthclub/xavier/accountless-allurial-db:latest',
};
const REDIS_IMAGE = 'redis/redis-stack:latest';

// Services we manage. `install` dirs get npm install on lockfile changes.
const NPM_DIRS = ['core', 'snes', 'admin', 'botm_admin'];

// ---------------------------------------------------------------------------
// args / slot / paths
// ---------------------------------------------------------------------------

const rawArgs = process.argv.slice(2);
const flags = {};
const args = [];
for (let i = 0; i < rawArgs.length; i++) {
  const a = rawArgs[i];
  if (a === '--slot') flags.slot = Number(rawArgs[++i]);
  else if (a === '--whitelabel') flags.whitelabel = rawArgs[++i];
  else if (a === '--owner') flags.owner = rawArgs[++i];
  else if (a === '--no-pull') flags.noPull = true;
  else args.push(a);
}
const cmd = args.shift();

// Pool-level commands operate across stacks and don't need a preset slot.
const POOL_CMDS = new Set(['pool', 'add-lane', 'release']);
const slot = flags.slot ?? Number(process.env.QA_STACK_SLOT ?? NaN);
if (!POOL_CMDS.has(cmd) && (!Number.isInteger(slot) || slot < 1)) {
  die('no slot: set QA_STACK_SLOT or pass --slot <n> (1-based)');
}

const base = 20000 + (slot - 1) * 100;
const ports = {
  db: base + 6,
  redisNear: base + 79,
  redisFar: base + 78,
  core: base + 82,
  snes: base + 30,
  botmAdmin: base + 50,
  admin: base + 51,
};
const names = {
  db: `qa-db-slot${slot}`,
  redisNear: `qa-redis-near-slot${slot}`,
  redisFar: `qa-redis-far-slot${slot}`,
};
const slotDir = path.join(STACKS_DIR, `slot${slot}`);
const repoDir = path.join(slotDir, 'Xavier');
const logsDir = path.join(slotDir, 'logs');
const stateFile = path.join(slotDir, 'state.json');

function die(msg) {
  console.error(`qa-stack: ${msg}`);
  process.exit(1);
}

// Progress ping to the QA Slack thread (no-op when run outside a bot job).
function slackPing(text) {
  const bin = process.env.QA_POST_BIN;
  if (!bin || !process.env.QA_SLACK_CHANNEL || !process.env.QA_SLACK_THREAD) return;
  try {
    const child = spawn('node', [bin, 'msg', text], { stdio: 'ignore', detached: true });
    child.unref();
  } catch {
    /* progress pings must never break the stack */
  }
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch {
    return { slot, services: {}, installHead: {} };
  }
}
function writeState(s) {
  fs.mkdirSync(slotDir, { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify(s, null, 2));
}

function envFileFor(whitelabel) {
  const f = whitelabel === 'allurial' ? '.env.allurial-local.xavier' : '.env.local.xavier';
  const p = path.join(XAVIER_SOURCE, f);
  if (!fs.existsSync(p)) die(`env file missing: ${p} (run \`make copy-environment\` in Xavier)`);
  return p;
}

// Per-slot env overrides, applied AFTER sourcing the Xavier env file.
function slotEnv(whitelabel) {
  return {
    XAVIER_CONFIG: 'env',
    XAVIER_WHITELABEL_THEME: whitelabel,
    XAVIER_READER_HOST: '127.0.0.1',
    XAVIER_WRITER_HOST: '127.0.0.1',
    XAVIER_READER_PORT: String(ports.db),
    XAVIER_WRITER_PORT: String(ports.db),
    NEAR_REDIS_HOST: '127.0.0.1',
    NEAR_REDIS_PORT: String(ports.redisNear),
    FAR_REDIS_HOST: '127.0.0.1',
    FAR_REDIS_PORT: String(ports.redisFar),
    REDIS_HOST: '127.0.0.1',
    REDIS_PORT: String(ports.redisNear),
    CORE_PORT: String(ports.core),
    API_HOST: `http://localhost:${ports.core}`,
    NEXT_PUBLIC_API_HOST: `http://localhost:${ports.core}`,
    PORT: String(ports.snes),
    SNES_PORT: String(ports.snes),
    BOTM_ADMIN_SERVER_PORT: String(ports.botmAdmin),
    ADMIN_SERVER_PORT: String(ports.admin),
  };
}

// ---------------------------------------------------------------------------
// shell helpers
// ---------------------------------------------------------------------------

function sh(command, { cwd, timeoutMs = 300_000, quiet = false } = {}) {
  return new Promise((resolve, reject) => {
    execFile('bash', ['-c', command], { cwd, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        if (!quiet) console.error(stderr.toString().trim());
        reject(new Error(`command failed: ${command}\n${stderr.toString().slice(0, 2000)}`));
      } else resolve(stdout.toString());
    });
  });
}

// Build a bash script that sources the Xavier env file, applies slot overrides,
// then runs `command` — same quoting semantics as the Xavier Makefile.
function envScript(command, whitelabel, extraEnv = {}) {
  const overrides = { ...slotEnv(whitelabel), ...extraEnv };
  const exports = Object.entries(overrides)
    .map(([k, v]) => `export ${k}=${JSON.stringify(v)}`)
    .join('\n');
  return `set -e\nset -a\nsource ${JSON.stringify(envFileFor(whitelabel))}\nset +a\n${exports}\n${command}`;
}

function shEnv(command, whitelabel, opts = {}) {
  return sh(envScript(command, whitelabel, opts.extraEnv), opts);
}

// Start a long-running service detached, stdout+stderr to a log file.
function startDetached(name, command, whitelabel, cwd) {
  fs.mkdirSync(logsDir, { recursive: true });
  const logFile = path.join(logsDir, `${name}.log`);
  const fd = fs.openSync(logFile, 'a');
  fs.writeSync(fd, `\n===== qa-stack start ${name} ${new Date().toISOString()} =====\n`);
  const child = spawn('bash', ['-c', envScript(command, whitelabel)], {
    cwd,
    detached: true,
    stdio: ['ignore', fd, fd],
  });
  child.unref();
  fs.closeSync(fd);
  return { pid: child.pid, logFile };
}

function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function killService(state, name) {
  const svc = state.services?.[name];
  if (!svc?.pid) return;
  // Detached spawn made the child a process-group leader: kill the whole group.
  for (const sig of ['SIGTERM', 'SIGKILL']) {
    try {
      process.kill(-svc.pid, sig);
    } catch {
      break; // group already gone
    }
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && alive(svc.pid)) await sleep(200);
    if (!alive(svc.pid)) break;
  }
  delete state.services[name];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitHttp(url, { timeoutMs, label, okStatuses = [200] }) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
      if (okStatuses.includes(res.status) || (res.status >= 200 && res.status < 400)) return;
      lastErr = `HTTP ${res.status}`;
    } catch (e) {
      lastErr = e.message;
    }
    await sleep(2000);
  }
  throw new Error(`${label} not ready after ${timeoutMs / 1000}s (${lastErr}) — check \`qa-stack logs\``);
}

// ---------------------------------------------------------------------------
// git / npm
// ---------------------------------------------------------------------------

async function ensureClone() {
  if (fs.existsSync(path.join(repoDir, '.git'))) return false;
  console.log(`[slot${slot}] first-time setup: cloning Xavier (local objects, fast)...`);
  fs.mkdirSync(slotDir, { recursive: true });
  await sh(`git clone ${JSON.stringify(XAVIER_SOURCE)} ${JSON.stringify(repoDir)}`, { timeoutMs: 600_000 });
  const origin = (await sh('git remote get-url origin', { cwd: XAVIER_SOURCE })).trim();
  await sh(`git remote set-url origin ${JSON.stringify(origin)}`, { cwd: repoDir });
  return true;
}

async function checkout(branch) {
  const ref = branch.replace(/^origin\//, '');
  console.log(`[slot${slot}] fetching + checking out ${ref}...`);
  await sh(`git fetch origin ${JSON.stringify(ref)}`, { cwd: repoDir, timeoutMs: 300_000 });
  await sh(`git checkout -f -B qa-current ${JSON.stringify(`origin/${ref}`)}`, { cwd: repoDir });
  return (await sh('git rev-parse HEAD', { cwd: repoDir })).trim();
}

// webpack-cli is only an optional peer dep of webpack; without it the admin builds
// stall on an interactive "install webpack-cli?" prompt. --no-save keeps the clone clean.
async function ensureWebpackCli(dir) {
  const abs = path.join(repoDir, dir);
  if (fs.existsSync(path.join(abs, 'node_modules', 'webpack-cli'))) return;
  console.log(`[slot${slot}] installing webpack-cli into ${dir} (needed for headless builds)`);
  await sh('npm install --no-save --no-audit --no-fund webpack-cli@5', { cwd: abs, timeoutMs: 300_000 });
}

async function npmInstallIfNeeded(state, headSha) {
  const jobs = [];
  for (const dir of NPM_DIRS) {
    const abs = path.join(repoDir, dir);
    if (!fs.existsSync(path.join(abs, 'package.json'))) continue;
    const last = state.installHead?.[dir];
    let needed = !fs.existsSync(path.join(abs, 'node_modules'));
    if (!needed && last && last !== headSha) {
      const diff = await sh(
        `git diff --name-only ${last} ${headSha} -- ${dir}/package.json ${dir}/package-lock.json`,
        { cwd: repoDir, quiet: true },
      ).catch(() => 'unknown'); // e.g. old sha gc'd — install to be safe
      needed = diff.trim().length > 0;
    } else if (!needed && !last) {
      needed = true;
    }
    if (needed) {
      console.log(`[slot${slot}] npm install: ${dir} (deps changed or first run)`);
      jobs.push(
        sh('npm install --no-audit --no-fund', { cwd: abs, timeoutMs: 900_000 }).then(() => {
          state.installHead[dir] = headSha;
        }),
      );
    } else {
      state.installHead[dir] = headSha;
    }
  }
  if (jobs.length) slackPing(`:package: dependencies changed on this branch — npm install first (adds a few min)`);
  await Promise.all(jobs);
  for (const dir of ['admin', 'botm_admin']) {
    if (fs.existsSync(path.join(repoDir, dir, 'package.json'))) await ensureWebpackCli(dir);
  }
}

// ---------------------------------------------------------------------------
// docker: db + redis
// ---------------------------------------------------------------------------

async function dbReset(whitelabel, pull) {
  const image = DB_IMAGES[whitelabel];
  console.log(`[slot${slot}] resetting DB container ${names.db} (${whitelabel}, port ${ports.db})...`);
  await sh(`docker rm -f ${names.db} 2>/dev/null || true`);
  if (pull) await sh(`docker pull --platform linux/amd64 ${image}`, { timeoutMs: 600_000 });
  await sh(`docker run -d --name ${names.db} -p ${ports.db}:3306 ${image}`);
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    const logs = await sh(`docker logs ${names.db} 2>&1 || true`, { quiet: true });
    if (/ready for connections.*Bind-address/s.test(logs)) {
      console.log(`[slot${slot}] DB ready`);
      return;
    }
    await sleep(2000);
  }
  throw new Error('DB container did not become ready in 240s');
}

async function redisEnsureAndFlush() {
  for (const [name, port] of [
    [names.redisNear, ports.redisNear],
    [names.redisFar, ports.redisFar],
  ]) {
    const running = (await sh(`docker ps -q -f name=^${name}$`, { quiet: true })).trim();
    if (!running) {
      await sh(`docker rm -f ${name} 2>/dev/null || true`);
      await sh(`docker run --rm -d --name ${name} -p ${port}:6379 ${REDIS_IMAGE}`);
    }
    const deadline = Date.now() + 60_000;
    while (true) {
      const pong = await sh(`docker exec ${name} redis-cli PING`, { quiet: true }).catch(() => '');
      if (pong.trim() === 'PONG') break;
      if (Date.now() > deadline) throw new Error(`${name} not accepting connections after 60s`);
      await sleep(1000);
    }
    await sh(`docker exec ${name} redis-cli FLUSHALL`);
  }
  console.log(`[slot${slot}] redis pair up + flushed (${ports.redisNear}/${ports.redisFar})`);
}

// ---------------------------------------------------------------------------
// service lifecycle
// ---------------------------------------------------------------------------

async function buildCore() {
  console.log(`[slot${slot}] building core (clean tsc)...`);
  await sh('rm -rf build && npx tsc', { cwd: path.join(repoDir, 'core'), timeoutMs: 600_000 });
  console.log(`[slot${slot}] core built`);
}

async function migrate(whitelabel) {
  console.log(`[slot${slot}] running DB migrations (${whitelabel})...`);
  try {
    await shEnv(`node build/api/DbMigration.js ${whitelabel}`, whitelabel, {
      cwd: path.join(repoDir, 'core'),
      timeoutMs: 600_000,
    });
    console.log(`[slot${slot}] migrations done`);
  } catch (e) {
    // Testing an OLD branch against today's (newer) accountless snapshot makes its
    // migrations fail (schema already ahead). With QA_MIGRATE_TOLERANT=1 we warn and
    // proceed — the snapshot is a superset, so the app runs. Lets lanes build on
    // time-traveled mirror PRs. Real current-PR runs leave this unset (strict).
    if (process.env.QA_MIGRATE_TOLERANT === '1') {
      console.error(`[slot${slot}] migrations failed but QA_MIGRATE_TOLERANT=1 — continuing: ${e.message.slice(0, 200)}`);
    } else {
      throw e;
    }
  }
}

const SERVICE_DEFS = {
  core: {
    cwd: 'core',
    command: 'node --enable-source-maps build/api/server.js',
    url: () => `http://127.0.0.1:${ports.core}/loaded`,
    publicUrl: () => `http://localhost:${ports.core}`,
    readyMs: 120_000,
  },
  snes: {
    cwd: 'snes',
    command: 'rm -rf .next && npm run dev',
    url: () => `http://127.0.0.1:${ports.snes}/`,
    publicUrl: () => `http://localhost:${ports.snes}`,
    readyMs: 180_000,
  },
  'botm-admin': {
    cwd: 'botm_admin',
    command: 'npm run start',
    url: () => `http://127.0.0.1:${ports.botmAdmin}/`,
    publicUrl: () => `http://localhost:${ports.botmAdmin}`,
    readyMs: 240_000,
  },
  admin: {
    cwd: 'admin',
    command: 'npm run start',
    url: () => `http://127.0.0.1:${ports.admin}/`,
    publicUrl: () => `http://localhost:${ports.admin}`,
    readyMs: 240_000,
  },
};

async function startService(state, name) {
  const def = SERVICE_DEFS[name];
  if (!def) die(`unknown service: ${name}`);
  await killService(state, name);
  if (def.cwd === 'admin' || def.cwd === 'botm_admin') await ensureWebpackCli(def.cwd);
  const { pid, logFile } = startDetached(name, def.command, state.whitelabel, path.join(repoDir, def.cwd));
  state.services[name] = { pid, port: Number(new URL(def.publicUrl()).port), logFile };
  writeState(state);
  console.log(`[slot${slot}] ${name} starting (pid ${pid}) — waiting for ${def.url()}`);
  await waitHttp(def.url(), { timeoutMs: def.readyMs, label: name });
  console.log(`[slot${slot}] ${name} ready at ${def.publicUrl()}`);
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

async function cmdUp() {
  const branch = args[0];
  if (!branch) die('usage: qa-stack up <branch> [--whitelabel botm|allurial] [--no-pull]');
  const whitelabel = flags.whitelabel ?? 'botm';
  if (!DB_IMAGES[whitelabel]) die(`whitelabel must be botm or allurial, got: ${whitelabel}`);
  const t0 = Date.now();

  const state = readState();
  state.whitelabel = whitelabel;

  // stop anything from a previous run on this slot
  for (const name of Object.keys(state.services ?? {})) await killService(state, name);

  await ensureClone();
  const headSha = await checkout(branch);
  state.branch = branch.replace(/^origin\//, '');
  state.headSha = headSha;
  writeState(state);
  slackPing(
    `:gear: starting QA env — checked out \`${state.branch}\` (${headSha.slice(0, 8)}), building core + snes with a fresh DB (~2–4 min)`,
  );
  console.log(`SOURCE READY: ${repoDir} is now on ${state.branch} — full codebase readable while the build continues`);

  await npmInstallIfNeeded(state, headSha);
  writeState(state);

  // slow parts in parallel: db reset + redis | core clean build
  await Promise.all([
    dbReset(whitelabel, !flags.noPull).then(() => redisEnsureAndFlush()),
    buildCore(),
  ]);

  await migrate(whitelabel);
  await startService(state, 'core');
  await startService(state, 'snes');

  const mins = ((Date.now() - t0) / 60000).toFixed(1);
  slackPing(`:white_check_mark: stack is up on \`${state.branch}\` (${whitelabel}, ${mins} min) — starting tests`);
  console.log(`\nREADY (slot ${slot}, branch ${state.branch}, ${whitelabel}, ${mins} min)`);
  printUrls(state);
}

async function cmdResetDb() {
  const state = readState();
  if (!state.branch) die('no stack on this slot yet — run `qa-stack up <branch>` first');
  await dbReset(state.whitelabel, false);
  await redisEnsureAndFlush();
  await migrate(state.whitelabel);
  console.log(`[slot${slot}] DB reset complete — clean accountless state, branch migrations applied`);
}

async function cmdSql() {
  const sql = args[0];
  if (!sql) die('usage: qa-stack sql "<SQL>"');
  const state = readState();
  // creds come from the sourced env file; run mysql inside the db container
  const script = envScript(
    `docker exec -i ${names.db} mysql -u"$XAVIER_WRITER_USER" -p"$XAVIER_WRITER_PASSWORD" -t "$XAVIER_WRITER_DATABASE" 2>/dev/null`,
    state.whitelabel ?? 'botm',
  );
  await new Promise((resolve, reject) => {
    const child = spawn('bash', ['-c', script], { stdio: ['pipe', 'inherit', 'inherit'] });
    child.stdin.end(sql + '\n');
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`mysql exited ${code}`))));
  });
}

async function cmdRunScript() {
  const [runner, scriptPath, ...rest] = args;
  if (!runner || !scriptPath) die('usage: qa-stack run-script <node|python3> <path-in-core> [args...]');
  const state = readState();
  if (!state.branch) die('no stack on this slot — run `qa-stack up <branch>` first');
  console.log(`[slot${slot}] running ${runner} ${scriptPath} ${rest.join(' ')} (branch ${state.branch})`);
  const script = envScript(
    [runner, scriptPath, ...rest].map((s) => JSON.stringify(s)).join(' '),
    state.whitelabel,
  );
  await new Promise((resolve, reject) => {
    const child = spawn('bash', ['-c', script], { cwd: path.join(repoDir, 'core'), stdio: 'inherit' });
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`script exited ${code}`))));
  });
}

async function cmdStart() {
  const name = args[0];
  if (!name) die('usage: qa-stack start <admin|botm-admin>');
  const state = readState();
  if (!state.branch) die('no stack on this slot — run `qa-stack up <branch>` first');
  await startService(state, name);
}

async function cmdLogs() {
  const name = args[0] ?? 'core';
  const lines = Number(args[1] ?? 100);
  const logFile = path.join(logsDir, `${name}.log`);
  if (!fs.existsSync(logFile)) die(`no log file for ${name} on slot ${slot}`);
  await new Promise((resolve) => {
    const child = spawn('tail', ['-n', String(lines), logFile], { stdio: 'inherit' });
    child.on('close', resolve);
  });
}

async function cmdStatus() {
  const state = readState();
  console.log(`slot ${slot}: branch=${state.branch ?? '(none)'} whitelabel=${state.whitelabel ?? '-'} sha=${(state.headSha ?? '').slice(0, 8)}`);
  for (const [name, svc] of Object.entries(state.services ?? {})) {
    console.log(`  ${name.padEnd(11)} ${alive(svc.pid) ? 'UP  ' : 'DEAD'} pid=${svc.pid} ${SERVICE_DEFS[name]?.publicUrl() ?? ''}`);
  }
  const dbUp = (await sh(`docker ps -q -f name=^${names.db}$`, { quiet: true })).trim();
  console.log(`  ${'db'.padEnd(11)} ${dbUp ? 'UP  ' : 'DOWN'} 127.0.0.1:${ports.db} (container ${names.db})`);
  printUrls(state);
}

function printUrls(state) {
  console.log('URLs:');
  console.log(`  storefront (snes): http://localhost:${ports.snes}`);
  console.log(`  core API:          http://localhost:${ports.core}`);
  console.log(`  botm-admin:        http://localhost:${ports.botmAdmin}  (start with: qa-stack start botm-admin)`);
  console.log(`  admin:             http://localhost:${ports.admin}  (start with: qa-stack start admin)`);
  console.log(`  DB:                127.0.0.1:${ports.db} (qa-stack sql "<SQL>")`);
}

async function cmdDown() {
  const state = readState();
  for (const name of Object.keys(state.services ?? {})) await killService(state, name);
  await sh(`docker rm -f ${names.db} ${names.redisNear} ${names.redisFar} 2>/dev/null || true`);
  writeState(state);
  console.log(`[slot${slot}] stack down`);
}

// --- pool / lanes -----------------------------------------------------------

function cmdPool() {
  const claimed = poolStatus();
  const used = Object.keys(claimed).length;
  console.log(`pool: ${used}/${TOTAL_STACKS} stacks claimed, ${TOTAL_STACKS - used} free`);
  for (let id = 1; id <= TOTAL_STACKS; id++) {
    console.log(`  stack ${id}: ${claimed[id] ? `claimed by ${claimed[id].slice(0, 8)}` : 'free'}`);
  }
}

function cmdRelease() {
  const owner = flags.owner ?? process.env.QA_RUN_ID;
  if (!owner) die('usage: qa-stack release --owner <run-id>');
  const released = poolReleaseOwner(owner);
  console.log(`released stacks [${released.join(',')}] for owner ${owner.slice(0, 8)}`);
}

// Claim a free stack and bring the SAME branch up on it — an extra concurrent lane.
// Prints `LANE <id>` + its browser server name + URLs for the orchestrator to brief a subagent.
async function cmdAddLane() {
  const branch = args[0];
  if (!branch) die('usage: qa-stack add-lane <branch> --owner <run-id> [--whitelabel ...]');
  const owner = flags.owner ?? process.env.QA_RUN_ID;
  if (!owner) die('add-lane needs --owner <run-id> (or $QA_RUN_ID)');
  const whitelabel = flags.whitelabel ?? 'botm';

  const id = poolClaimAny(owner);
  if (id === undefined) {
    console.log('POOL_FULL — no free stack; run cases on the lanes you have');
    return;
  }
  console.log(`[lane] claimed stack ${id}; building ${branch} (${whitelabel}) on it...`);
  const self = fileURLToPath(import.meta.url);
  const upArgs = [self, 'up', branch, '--slot', String(id), '--whitelabel', whitelabel, '--no-pull'];
  const code = await new Promise((resolve) => {
    const child = spawn('node', upArgs, { stdio: 'inherit', env: process.env });
    child.on('close', resolve);
  });
  if (code !== 0) {
    // release only this stack's claim (leave the run's other lanes intact)
    fs.rmSync(path.join(POOL_DIR, `claimed-${id}`), { recursive: true, force: true });
    die(`add-lane: build failed on stack ${id}`);
  }
  const lbase = 20000 + (id - 1) * 100;
  const server = id === 1 ? 'playwright' : `lane${id}`;
  console.log(`LANE ${id}`);
  console.log(`  browser server: ${server}  (use mcp__${server}__* tools for this lane)`);
  console.log(`  storefront: http://localhost:${lbase + 30}`);
  console.log(`  core API:   http://localhost:${lbase + 82}`);
  console.log(`  DB:         127.0.0.1:${lbase + 6}  (qa-stack sql ... --slot ${id})`);
  console.log(`  slot flag:  --slot ${id}  (pass to sql/run-script/logs/reset-db for this lane)`);
}

// ---------------------------------------------------------------------------

const handlers = {
  up: cmdUp,
  'reset-db': cmdResetDb,
  sql: cmdSql,
  'run-script': cmdRunScript,
  start: cmdStart,
  logs: cmdLogs,
  status: cmdStatus,
  down: cmdDown,
  pool: cmdPool,
  release: cmdRelease,
  'add-lane': cmdAddLane,
};

const handler = handlers[cmd];
if (!handler) die(`unknown command: ${cmd ?? '(none)'} — one of: ${Object.keys(handlers).join(', ')}`);
try {
  await handler();
} catch (e) {
  console.error(`qa-stack ${cmd} failed: ${e.message}`);
  process.exit(1);
}
