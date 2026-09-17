# Solution — per-account pacing + burst cap (4a implemented, 4b deferred)

Status: burst cap (4a) IMPLEMENTED 2026-09-17; min-gap pacer (4b) DEFERRED for
measurement with all knobs default 0. (`server.js`: `DEEPSEEK_BURST_PER_MINUTE`
default 0, `recordUpstreamTurn` unconditional writer + `usedSince` readers,
`withinBurst`/`stickyBurstReject` (pure, tested), readiness filters +
sticky-429 + `burst_used_1m` status; tests 241 green; live-fired with limit 3
(post early-return fix): fresh picks exclude spent accounts, sticky live chat
fails fast 429, all-cooling falls back to the enriched generic 429.)

## 1. Problem (measured against us)

Hourly quota (60/hr) allows sixty turns in six minutes — the exact burst shape
that drew the Sep-17 suspension. Upstream reacts to velocity (rapid, regular,
think-time-free turns), not just volume. Agentic clients don't self-pace, and
invisible turns (titles, compaction summaries, repair retries) join the burst.

## 2. Design

### 2a. Burst cap — BUILD FIRST (4a)
- Knob: `DEEPSEEK_BURST_PER_MINUTE` (default **0 = off** until measured;
  candidate 10). Sliding 60s window over the request ring.
- Semantics mirror quota exactly: fresh picks / migration / `/readyz` exclude
  burst-spent accounts; sticky live chat fails fast 429 (chat preserved) with
  `Retry-After` = oldest-in-minute + 60s − now.
- **No-mark rule (structural, not aspirational):** burst rejection throws inside
  `selectAccountForSession`, i.e. BEFORE `askDeepSeekStream` — and the handler
  catch never calls `markAccountFailure` on select-path errors (verified
  2026-09-17: marks happen only post-selection inside `askDeepSeekStream`).
  Pin with a test: failures/counters byte-identical across a burst reject.
  If a future edit adds marking to that catch, this test must be updated first.

### 2b. Min-gap pacer — DEFERRED (4b)
- Knobs: `DEEPSEEK_MIN_TURN_GAP_MS`, `DEEPSEEK_TURN_JITTER_MS` (both default 0).
  When enabled: gap = min + rand*jitter; candidate default 2000+3000 **only
  after** Sep-19 measurement. Numbers in v1 of this doc were placeholders —
  stated plainly so nobody treats them as derived.
- Placement (verified slot): in `askDeepSeekStream` AFTER account selection
  (`server.js:~1520`) and BEFORE `inflight++` (`:~1528`). Sleeping while holding
  the inflight slot would inflate `10*inflight` for concurrent turns and
  blackhole the pacing account in the scorer — the review caught this, the slot
  above avoids it.
- Deadline rule (corrected twice): pace ONLY if usable upstream time remains
  after the wait, i.e. `remainingMs - gap >= MIN_USABLE_UPSTREAM_MS`
  (candidate 10000, tunable). Otherwise skip the sleep AND fail fast with a
  pacing-aware 429 (`retryAfter = ceil(gap/1000)`, chat preserved) — never
  silently downgrade to no-wait (that reintroduces the burst) and never
  `min(gap, remaining)`-then-attempt-anyway (that burns the budget in sleep
  and attempts a turn born timed-out). Single `setTimeout`, then recheck
  `clientGone`/`deadlineHit()` (house pattern, not sliced sleeps).
- Failed turns DO advance `lastUpstreamAt` (camouflage continuity — a failed
  turn still occupied the wire visibly upstream).
- Jitter is load-bearing (fixed gaps fingerprint); `rand` injectable, default
  `Math.random`. Unit tests pin bounds, not distribution (stated limitation).

### 2c. One clock, two readers (decided)
Quota stamp and pacer stamp are the SAME event (upstream-turn start): a single
unconditional `recordUpstreamTurn(account, nowMs)` pushes the ring and sets
`lastUpstreamAt`. Quota reads it via `usedSince(...,3600000)`, burst via
`usedSince(...,60000)`. This kills the two-clocks divergence by construction.
Requires decoupling the writer from the quota flag (today
`recordAccountRequest` early-returns when quota is off — burst needs the ring
regardless): split into unconditional writer + windowed readers, keep
`usedThisHour`/`withinQuota` as thin wrappers so existing tests stand.

## 3. Server changes (for the implementer)

1. `recordUpstreamTurn` (unconditional push + prune + fixed 1024 cap +
   `lastUpstreamAt` set) replaces `recordAccountRequest` at the PoW-success
   stamp site; `usedSince(account, windowMs, nowMs)` generalizes both readers.
2. `burstUsedThisMinute`/`withinBurst` thin wrappers; ready/migration/readyz
   filters; sticky-429 branch (quota-branch shape); `accountStatus +=
   burst_used_1m`.
3. (4b only) `pacingDelayMs` pure + sleep in the verified 1520→1528 slot +
   `logDebug` pacing line.
4. Exports for all pure helpers; no-mark pinning test; bounds tests.

## 4. Composition

| Layer | Trigger | Action | Default |
|---|---|---|---|
| Pacer (4b) | gap < min+jitter | delay (sleep) | OFF |
| Burst (4a) | >N turns/60s | fail-fast 429, no mark | OFF |
| Quota | >60 turns/1h | sit out, 429 + release time | ON (60) |
| Scorer/cooldown | failures/timeouts | unchanged | n/a |

Pacer delays, burst rejects fast, quota sits out long. Shape-vs-shed are
different functions (burst binds first on sustained load by design — that is
the point, not redundancy).

## 5. Tests & verification
- Unit (deterministic): gap math incl. the usable-time gate
  (`remaining - gap >= MIN_USABLE` attempts; else pacing-429 — both branches);
  bounds over 500 trials; burst count/prune/60s-boundary incl. out-of-order
  stamps; sticky-429 preserves chat; chat-less rotates; all-spent 429 +
  `Retry-After`; failures byte-identical across burst reject; `usedSince`
  window generality.
- Writer-split test updates (required by the `recordUpstreamTurn` refactor):
  the existing "capped at 2× quota (≤120)" test becomes "capped at fixed 1024";
  add out-of-order release test (`oldestInWindow` ≠ position [0]); keep the
  `usedThisHour`/`withinQuota` suites untouched (thin wrappers, behavior
  preserved).
- Live (post-Sep-19, preconditions FIRST): enable DEBUG, confirm
  `burst_used_1m`/`lastUpstreamAt` visible in `/health`, THEN run the burst
  drill on scratch (turns spaced per journal `pacing ... sleeping` lines;
  rejects carry `Retry-After`; no cooling/failures from rejects). Do not drill
  on muted accounts.
- Rollback: knobs `0` + restart (asserted by construction).

## 6. Open questions (not blockers)
- Cost-correlated gaps (titles vs full turns): v1 paces uniformly as an admitted
  simplification; correlate later only with measured data.
- Exact burst default (candidate 10) and gap defaults: set from Sep-19 traffic,
  not from this doc.
