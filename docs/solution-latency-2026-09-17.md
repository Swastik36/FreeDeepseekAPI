# Solution — per-account latency tracking (IMPLEMENTED 2026-09-17)

Status: implemented — EWMA step helper, success-path update, status field.
Display-only (no scoring reader); tests 245 green.

## 1. What it is

Exponential moving average of successful upstream turn durations, per account,
exposed in `/health`, never used in scoring (yet). Purpose: prerequisite data
for any future routing smarts (a degrading account shows rising latency before
it starts failing), plus a human-readable health signal next to
`used_this_hour`/`burst_used_1m`. Deliberately display-only in v1 — no scorer
weight until measured against real traffic.

## 2. Our-side design

- Sample point: `askDeepSeekStream` entry → successful `resp` return (covers
  PoW + completion; excludes client-side streaming fan-out). Timer adjacent to
  `account.lastUsedAt` at entry (`server.js:~1694`), EWMA write in the success
  block (`:~1826`) — re-derive with grep, anchors drift.
- Update (success path only): `account.ewmaLatencyMs = prev > 0
  ? 0.7 * prev + 0.3 * sample : sample` (alpha 0.3: reacts within ~3 turns,
  stable enough to read). Failures never update it (a timeout's duration is
  not service speed). Init `0` = unknown in `accounts.push`.
- Exposure: `accountStatus += ewma_latency_ms: Math.round(...)` (additive,
  safe). DEFERRED, do not cite as behavior: optional `logDebug` line when EWMA
  crosses 30s (early-degradation tripwire).
- No env knobs in v1 (alpha fixed; document why: one fewer dimension while
  gathering baseline data).

## 3. Tests & verification
- Unit: first sample sets value; EWMA math on known sequence
  (e.g. samples 1000,2000 → 1000 then 1300); failures leave it untouched
  (single write site in the success path — construction-guaranteed, plus a
  status test asserting a fresh account reads `ewma_latency_ms: 0`); init 0
  reads as unknown.
- Timer placement: entry stamp post-`select` (`server.js:~1694`), write on
  success (`:~1826`) — select latency excluded, per-call spans, PoW included
  by definition. (Tilde refs: re-derive with grep, they drift.)
- Live: run turns, confirm `/health` shows plausible, account-specific,
  converging values; confirm scorer ignores it (routing decisions unchanged
  with/without the field — assert by construction: no reader in scoring paths).
- Rollback: delete the field (display-only; nothing reads it).
- DEFERRED (not in tree): the 30s-degradation `logDebug` tripwire from the
  draft — wanted, unbuilt. Do not cite it as behavior.

## 4. Explicit non-goals
Scoring on latency; percentiles/histograms (EWMA suffices for trend);
client-visible headers. Note for any future scorer use (M-2): the sample is
turn-cost, PoW-dominated (solve difficulty variance dwarfs completion variance)
— separate PoW time from completion time before weighting, or the scorer will
optimize for easy puzzles.
