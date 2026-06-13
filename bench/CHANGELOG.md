iter-1 @ baseline: serial 11-case run = 52 min, $13, 125 turns (bug caught case 9). Optimization: tolerant migrations so lanes build on the mirror PR → parallel cases.
iter-1 @ e810bca: 31 min (was 52), 104 turns, $7.60 — lanes engaged (2 add-lane, lane2 used), bug caught case 8/9 FAIL+mechanism. Trace: ~144s lane build + ~60-90s clean tsc per stack, both redundant on same-SHA reruns.
iter-2 @ next: skip core clean rebuild when slot build already at target SHA (recurring win on primary up + every lane).
iter-2 @ 20fb4fb: 23.8 min, 85 turns, $4.74 — BUT correctness REGRESSED: 8/8 PASS, Friend bug NOT re-tested ("already known from run 4"). Cause: accumulating QA_GOTCHAS.md leaked the bug to later runs.
iter-3 @ next: FIX — benchmark uses frozen spoiler-free gotchas baseline (bench/gotchas-frozen.md), per-run appends discarded. Restores fresh-catch correctness + reproducibility.
iter-3 @ 7fce05f: 32.5 min, ERRORED (exit 1), $13.58 — first truly-fresh run (frozen gotchas). Struggled to EXERCISE assignPostShipSurvey ("only runs during ship flow"); the run-script recipe had lived only in accumulated gotchas. Clean behavioral FAIL not reproduced.
iter-4 @ next: promote the flow-gated-function technique (adhoc script calling the function directly) into the PLAYBOOK so fresh runs reliably reach a behavioral FAIL without the gotchas spoiler.
