#!/usr/bin/env node
// PostToolUse hook: delivers mid-run user messages from $QA_INBOX into the live
// agent context (orchestrator OR subagent — whoever makes the next tool call).
// At-most-once: messages are moved to inbox/delivered/ before injection.
// Must NEVER break the run: any failure exits 0 silently.

import fs from 'node:fs';
import path from 'node:path';

try {
  // stdin carries hook JSON (cwd = runDir); env is the claude process env.
  let inbox = process.env.QA_INBOX;
  if (!inbox) {
    const stdin = fs.readFileSync(0, 'utf8');
    const cwd = JSON.parse(stdin || '{}').cwd;
    if (cwd) inbox = path.join(cwd, 'inbox');
  }
  if (!inbox || !fs.existsSync(inbox)) process.exit(0);

  const files = fs
    .readdirSync(inbox)
    .filter((f) => f.endsWith('.md'))
    .sort();
  if (!files.length) process.exit(0);

  const deliveredDir = path.join(inbox, 'delivered');
  fs.mkdirSync(deliveredDir, { recursive: true });
  const messages = [];
  for (const f of files) {
    const p = path.join(inbox, f);
    messages.push(fs.readFileSync(p, 'utf8').trim());
    fs.renameSync(p, path.join(deliveredDir, f));
  }

  const context = [
    '📨 MID-RUN MESSAGE FROM THE USER (delivered live — the run was NOT interrupted):',
    ...messages.map((m) => `> ${m.replace(/\n/g, '\n> ')}`),
    '',
    'Handle it now: acknowledge in one line via `node "$QA_POST_BIN" msg ...` and adapt.',
    'If you are a subagent: adjust your current case if relevant, and ALWAYS include this',
    'message verbatim in your final report so the orchestrator sees it too.',
  ].join('\n');

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: context },
    }),
  );
  process.exit(0);
} catch {
  process.exit(0);
}
