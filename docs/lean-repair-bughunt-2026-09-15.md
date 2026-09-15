# Lean-first repair: 5-round bug hunt (2026-09-15)

Scope: uncommitted `server.js` strict-retry rewire (lean attempt 1 → full attempt 2,
same chat) + `tests/unit.test.js` additions. Method: 5 rounds × ~3 candidates;
each candidate got a genuine disproof attempt (code read, live-log evidence, or
`node` probe against `server.js.__test`). Disproved candidates were dropped, not
filed. No fixes applied — collection only.

Tally: **14 candidates → 4 confirmed bugs + 3 observations, 7 dropped.**

## Confirmed bugs

### B1 (minor): capped fail-fast path still pays 1s sleep + full prompt build
`server.js:2650-2676`. Order is sleep → `appendPromptInstruction` over the ~80k
prompt → lean build → sha256 → classify → capped check. A capped turn therefore
burns ~1s plus two large string builds before "failing fast without another
upstream call". Fix sketch: build `strictPrompt`, hash, classify *before* the
sleep; sleep only when an upstream call will actually happen.

### B2 (minor, observability): success log doesn't attribute the attempt
`server.js:2710` logs `Retry with strict prompt succeeded` identically for lean
attempt 1 and full attempt 2. This blinds the lean-vs-full tuning decision
(watch-item: flip the order back if attempt-2 successes dominate). Fix sketch:
include the attempt (`lean`/`full`) in the log line.

### B3 (minor, pre-existing): repair guard is wiped by restart
Proven by `tests/unit.test.js:1080-1103` (persist omits guard fields, restore
nulls them). If a restart lands inside the 10-min guard window between a 502
and the client's verbatim retry, the retry is treated as fresh → full 80k
repair + a new-chat cycle the guard was built to prevent. Narrow window
(restarts are manual, retries immediate) and self-converging next turn.

### B4 (minor, pre-existing): session-scoped guard under same-agent concurrency
No per-agent serialization exists (only the global `inFlight` cap,
`server.js:219-2201`). Two interleaved same-agent turns share
`repairHash`/`repairCount`, and any success's `clearRepairGuard` clears all
in-flight turns' guards. Rare (needs concurrent same-agent malformed turns)
and self-healing.

## Observations (no bug, needed later)

### O1: production lean is ~47KB, not ~1.5KB
Measured `47,798 chars` in live logs — the client's tool catalog dominates the
lean prompt. Real saving is ~40% vs the 80k full resend, not ~98%. All future
cost math and the `compactSchemas`/per-tool caps should assume tools ≈ 40-50k.

### O2: retry-block attempt order has zero direct tests
All 59 tests are function-level; lean→full ordering is verified only via live
logs. To lock it: extract attempt selection (which prompt shape for
fresh/repeat/capped, attempt-2 predicate) into a pure function and unit-test
the matrix.

### O3: attempt-2 extends worst-case turn latency by one fetch-timeout window
`DS_FETCH_TIMEOUT_MS` (60s) per upstream call; nothing preempts an in-flight
repair, and `clientGone` is only rechecked at attempt-2 entry. If upstream ever
wedges, the client may be gone before `res.end`. New chain length attributable
to this change; fine today, revisit if upstream latency degrades.

## Dropped (disproved)

- R1: throw-before-attempt consumes guard budget (pre-existing, self-corrects
  next turn); repair success never adopts repair messageId (side effect in
  `readDeepSeekResponse:2469` does; logs show `parent: 2 → 4`).
- R2: malformed turns poison local history (502 returns before `storeHistory`);
  repair turns inflate depth rollover (counter tracks real remote messages,
  negligible at depth 100); 502 `history_length` stale post-reset (reset never
  clears history).
- R3: idle sweep destroys guard (4h vs 10min windows can't overlap); repeat
  hash fragile to nondeterminism (no timestamps/random reach prompt text;
  production repeat-detection fired, proving byte-stability).
- R4: middle-truncation eats tool defs (adapter lives at system tail, which is
  preserved; live full-resend tool calls succeeded); giant catalog breaks lean
  bounding (floors gracefully by design); 120-char tool truncation causes wrong
  args (attempt-2 exists for exactly this).
- R5: attempt-2 blows the 120s deadline (seconds-scale headroom, disproved).
