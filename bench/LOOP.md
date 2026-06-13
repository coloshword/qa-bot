# QA-bot speed optimization loop

**Goal: drive a full QA run of PR #18835 from ~45 min to under 20 min**, without losing
correctness (it must still catch the Friend/BFF lifetime-scope bug as a behavioral FAIL).

Each loop iteration, do exactly this:

## 1. Guard against contention
- If a QA run is active — `pgrep -f 'claude --print'` returns anything, OR
  `node bin/qa-stack.mjs pool` shows <3 free — the machine is busy (a benchmark or the live
  bot is running). Do NOT start a benchmark. Reschedule the wakeup ~10 min out and stop.

## 2. Analyze the most recent completed benchmark (if not yet optimized)
- Read the last line of `bench/results.jsonl` (duration, turns, cost) and its `events-*.jsonl`
  trace (per-tool elapsed-seconds timestamps).
- Find the biggest time sink. Likely candidates, in rough priority:
  1. **Serial case execution** — cases run one at a time. Lanes (`add-lane`) give ~3× but the
     #18835 mirror's old migrations fail the lane build. Fixing lane builds for the benchmark
     (tolerant migrations / matching snapshot) is probably the single biggest win.
  2. **Per-case churn** — repeated SQL, screenshot path fumbling, `ToolSearch` reloading
     playwright schemas, login-per-case. A `qa-login` session-mint tool cuts per-case time.
  3. **Wasted turns** — anything repeated identically across the trace.
- Make **ONE** targeted change (playbook / agents / qa-stack / worker). Keep correctness:
  the run must still produce the case-9 Friend/BFF FAIL-with-mechanism.
- `npm run typecheck`. Commit + push with the timing delta in the message
  (e.g. `bench: parallelize cases across lanes — 44→NN min`).

## 3. Launch the next benchmark (background)
```
set -a && source .env && set +a
export PATH="$HOME/.nvm/versions/node/v20.20.0/bin:$PATH"
node bin/qa-bench.mjs https://github.com/bookofthemonthclub/Xavier/pull/18835 bench/spec-18835.md iter-<N>
```
Run it in the background. Reschedule the wakeup ~25 min out to collect the result and iterate.

## 4. Log
Append a one-line note to `bench/CHANGELOG.md`: `iter-<N> @ <sha>: <change> → <duration> min`.

Stop the loop only if 3 consecutive iterations produce no improvement, or the goal (<20 min) is hit.
