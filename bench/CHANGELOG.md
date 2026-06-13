iter-1 @ baseline: serial 11-case run = 52 min, $13, 125 turns (bug caught case 9). Optimization: tolerant migrations so lanes build on the mirror PR → parallel cases.
iter-1 @ e810bca: 31 min (was 52), 104 turns, $7.60 — lanes engaged (2 add-lane, lane2 used), bug caught case 8/9 FAIL+mechanism. Trace: ~144s lane build + ~60-90s clean tsc per stack, both redundant on same-SHA reruns.
iter-2 @ next: skip core clean rebuild when slot build already at target SHA (recurring win on primary up + every lane).
