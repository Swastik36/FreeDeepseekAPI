# Pacing-Gate Findings Report — `~/FreeDeepseekAPI`

Date: 2026-09-18. Tree: `swastik-mods` @ `287799b` (scope note: the originating review
labeled its scope `3751aef`, but all evidence was read from HEAD; nothing below depends
on the label). Pacing defaults at review time: gap 6000ms, jitter 2000ms, deadline
120000ms, min-usable 10000ms. Retracted review items (L-C stale-count, L-F commit-message)
are excluded — L-C's cited sentence is factually correct (core suite is still exactly 245),
and `git show` proves every commit message matched its payload.

---

## H-3 — Pacer measures gaps, does not serialize concurrent turns (Medium)

### What is wrong

The pacing gate is an **open-loop delay**, not a mutual-exclusion slot. It reads a shared
timestamp, sleeps, and only stamps the shared timestamp much later — after two network
round trips. Any second turn that passes the gate inside that window observes the same
stale timestamp, computes the same delay, and the enforced gap collapses to the spread
between the two stamps, which can be milliseconds against a 6000ms target.

### Mechanism, step by step

1. Turn A (agent-loop, account X) enters the gate (`server.js:1848-1871`). It reads
   `account.lastDispatchedAt` — call it T0 (`:1851`) — and computes
   `delay = 6000 + jitter − (now − T0)` via `resolvePacingAction` (`:1853`).
2. Turn A sleeps (`:1857-1858`), then runs the PoW-challenge fetch (`:1891`), the
   chat-create fetch (`:1940`), and the completion fetch (`:1964`).
3. Only after the challenge is issued does Turn A stamp
   `account.lastDispatchedAt = Date.now()` (`:1917`). The load counter
   (`account.inflight++`, `:1878`) is likewise bumped only after the gate.
4. Turn B (a *different* session that the scorer also placed on account X) enters the
   gate while Turn A is still sleeping or fetching. It reads the same T0, computes the
   same delay, sleeps the same sleep. Both turns then stamp after their own PoW fetches.
5. Enforced gap = `stampB − stampA`, driven by PoW-fetch durations, not by the pacer.
   The 6000ms target is silently void for exactly the burst shapes pacing exists to stop.

### Why two turns can share one account

Stickiness binds *sessions* to accounts, never accounts to sessions. A fresh session
takes the score-minimum over the ready set, and nothing excludes an account that
already hosts an in-flight turn. The scorer's `10 × inflight` term (`scoreBase`)
steers the second turn elsewhere *when an idle peer exists* — so collision needs
all-peers-busy, a single live account, or a scorer tie. The project's own roadmap
(`04_next_moves.md`) contemplates concurrency 2–4, which is precisely the regime
where this fires. Same-session turns cannot overlap (they are await-chained), so this
is strictly a cross-session effect.

### Impact

Not a crash, not a leak: the failure mode is the pacer quietly not pacing. Under the
doubled 6s default the collapse window is wider than before, but the consequence is
unchanged — reduced spacing, never corruption. Severity Medium because the mechanism is
certain and the precondition is plausible, not because breakage was demonstrated live.

### Fix direction

Claim the slot at gate-pass instead of stamping at dispatch: write a reservation stamp
before sleeping (rolled back on reject/client-gone), or move `inflight++` ahead of the
sleep and gate partially on it (which also improves scorer steering during the wait).
Cover with a test that evaluates the gate twice against one account with the second
call interleaved before the first stamp — it must observe the reservation. That test
fails today.

---

## M-C — In-place retry burns its bounded wait on a quota/burst-blocked sticky (Medium-low)

### What is wrong

The in-place rate-limit retry checks whether *any* account is ready, then spends its
sleep and its one cooldown-lift on *one specific* account — which may be blocked for
reasons the lift does not clear. The wait is consumed, a log line claims a retry, and
the re-entered call fails immediately on a limiter nobody lifted.

### Mechanism, step by step

1. A turn fails with a rate-limit error. The retry gate (`server.js:4902-4906`) tests
   `anyReady: anyAccountReady(accounts)` — pool-wide readiness, not sticky readiness.
2. Once the gate passes, the bounded wait is unconditional (`:4910`,
   `await setTimeout(waitMs)`, up to `RATELIMIT_RETRY_MAX_MS` = 10s).
3. `inPlaceRateLimitRetry` lifts exactly one thing: `account.cooldownUntil = 0`
   (`:517`; the snapshot/restore around it is otherwise correct).
4. The retry re-enters `askDeepSeekStream` → `selectAccountForSession` (`:767`). For a
   session pinned to a live chat, the sticky branch can still throw the hourly-quota
   429 (`:794-800`) or the burst 429 (`:801-803`) — neither is keyed on `cooldownUntil`,
   so neither was cleared by the lift.
5. Net effect: up to 10 seconds of dead client time, a `recovered: false` that
   understates why, and a log line announcing an in-place retry that never reached
   upstream.

### Preconditions (all four must hold)

1. `DEEPSEEK_RETRY_RATELIMIT=1` — **the whole path is default-off**, so this bites
   only operators who opted into in-place retries.
2. The failing turn owns a live remote chat (chat-less stickies rotate freely instead
   of throwing).
3. The sticky account is simultaneously cooling *and* over quota or burst cap.
4. At least one *other* account is ready (otherwise the gate correctly skips).

Four-way conjunction plus an opt-in flag: real, but narrow. That is why this is
Medium-low urgency despite High mechanism confidence.

### Fix direction

Scope eligibility to the account that will actually be retried: test
`isAccountReady(retryAccount)` — or explicitly
`withinQuota(retryAccount) && withinBurst(retryAccount)` — instead of (or in addition
to) the pool-wide `anyAccountReady(accounts)`. One predicate, no structural change.

---

## M-D — Pacing knobs have no upper clamp (Medium)

### What is wrong

All three pacing knobs accept any finite value ≥ their minimum with no maximum, so a
fat-fingered environment value is accepted silently and converts the proxy into a
sleep-or-429 machine. The codebase already knows how to do this correctly — the
hourly quota next door is clamped to `[0, 100000]` (`server.js:313`) — the pacing
knobs just never got the same treatment.

### Mechanism

`numEnv(name, def, min, max)` (`server.js:26-35`) warns and falls back only for
non-finite or out-of-range input. The pacing knobs pass `0` (gap, jitter) or `1000`
(min-usable) as the minimum and nothing as the maximum (`:1084-1086`). Hence
`DEEPSEEK_AGENT_TURN_GAP_MS=300000` is finite and ≥ 0: accepted with no warning.
Every subsequent agent-loop turn then sleeps ~5 minutes (deadline permitting) or is
rejected outright by `resolvePacingAction` — and the guard designed to catch bad
configuration never fires, because the value is technically valid. The same hole
admits `MIN_USABLE_UPSTREAM_MS` larger than `REQUEST_DEADLINE_MS`, a combination
under which *waiting is never permitted* and every paced turn is a reject.

### Impact

Default users are untouched (shipped 6000/2000/10000 are sane). The victim is a future
operator editing the service environment: one extra zero, no warning, all agent loops
stall or 429, and nothing in the logs points at the knob. Configuration faults should
be loud; this one is silent.

### Fix direction

Give all three knobs a real max (e.g. 60000 for gap/jitter; a ceiling at or below
`REQUEST_DEADLINE_MS` for min-usable), and emit a startup warning when
gap ≥ min-usable — that combination guarantees reject-or-near-useless behavior and
deserves a log line at boot, not a mystery at runtime.

---

## M-A — Callsite batch metric is untested (Medium)

### What is wrong

Pillar 1 has two halves: a prompt directive that *asks* the model to batch, and a
caller-side counter that *measures* whether batching actually happens. The measurement
half has zero coverage — a refactor could delete the increment and the suite would
stay green while the project flies blind on its own primary objective.

### Evidence

- The acceptance criterion is explicit (`docs/solution-anti-suspension-2026-09-18.md:425`):
  simulating a 3-call emission must increment `account.multiToolBatchCount` and update
  `account.batchSizeCounts["3"]`.
- The increment lives at `server.js:5258-5263`, inside the multi-call parse branch.
- The only test touching these fields (`tests/anti-suspension.test.js:27-39`) constructs
  a mock account with the counters pre-filled and asserts `accountStatus` echoes them.
  It never drives a parse result through the increment site. Echo ≠ coverage.

### Impact

Medium rather than Low because of *what* is unmeasured: without the counter, nobody can
tell whether the batching directive changed model behavior or is expensive prompt
decoration. The metric is the feedback loop for the whole pillar.

### Fix direction

Feed a 3-call `parseToolCalls` result through the branch in a test (or extract the
six-line increment into a pure helper and test that directly — cheaper and stable
against handler refactors). Assert `multiToolBatchCount === 1` and
`batchSizeCounts["3"] === 1` afterward.

---

## M-B — Shipped default and human-turn bypass are untested (Medium)

### What is wrong

Two properties the project now leans on have no test pinning them:

1. **The shipped default.** The only gate-level test injects an override
   (`tests/anti-suspension.test.js:499`, `DEEPSEEK_AGENT_TURN_GAP_MS: '5000'`). No
   test reads the exported `AGENT_TURN_GAP_MS` to assert the shipped 6000. A future
   edit can silently re-tune the most behavior-changing knob in the file and nothing
   fails — this already happened once in miniature when the default moved 0 → 3000 →
   6000 across commits with only commit messages as witnesses.
2. **The human-turn bypass.** Human behavior is covered at the classifier
   (`:405`, `role === 'user'` → `false`), but never at the gate: no test drives a
   human-shaped request through the wiring and asserts zero sleep is scheduled. The
   zero-UX-penalty mandate — the pillar's founding promise — rests on an untested
   integration point.

### Why this one stings

The project's own contribution guide, added in this same stack
(`CONTRIBUTING.md:58,63`), now *requires* new knobs to "assert both the default and
the boundary" and to "add a test that pins the default." The pacing knobs violate the
house rule written beside them.

### Fix direction

Two small tests: one asserting the exported default constants, one driving the gate
(or `resolvePacingAction` plus the `isAgentLoop` threading) with `isAgentLoop: false`
and asserting no `setTimeout` was scheduled. Three tests total together with M-A.

---

## L-B — Wrong knob name in `solution-pacing` (Low)

`docs/solution-pacing-2026-09-17.md:34` documents `DEEPSEEK_MIN_TURN_GAP_MS`. That
name occurs zero times in code (checked across `server.js`, `scripts/*.js`,
`lib/*.js`); the shipped variable is `DEEPSEEK_AGENT_TURN_GAP_MS` (`server.js:1084`).
An operator following that doc sets a variable the server never reads and concludes
pacing is broken. Same line's "(both default 0)" is stale as well. One-line doc fix.

---

## L-D — Jitter formula exceeds its documented bound on injected `rand() === 1` (Low)

`calculateRequiredDelay` (`server.js:1104-1109`) computes
`Math.floor(rand() * (jitterMs + 1))`, documented as uniform on `[0, jitterMs]`
(`docs/solution-anti-suspension-2026-09-18.md:411`). For production `Math.random()`,
which never returns exactly 1, the output is exactly `0..jitterMs` — correct. But
`rand` is injectable for determinism, and `() => 1` yields `jitterMs + 1`, one past
the contract. Either clamp (`Math.min(jitterMs, …)`) or document that `rand` must
return `< 1`. Edge-only; production-safe today.

---

## L-E — Burst readiness computed in two places (Low)

`selectAccountForSession` computes `stickyOverBurst` inline (`server.js:786`) and then
calls `stickyBurstReject` (`:802`), which recomputes the same predicate internally
(`:394-404`). Harmless today — both sites receive the identical `now`, so they cannot
disagree — but two sources of truth for one gate is the exact pattern that previously
produced the release-math drift this codebase already had to reunify. Next touch of
either site should collapse them to one call. Opportunistic.

---

## Suggested implementation order

1. **M-C** — one predicate (`isAccountReady(retryAccount)` scoping); smallest diff, clearest win.
2. **H-3** — reservation stamp before the sleep plus the interleaved-calls test (fails today, passes after).
3. **M-D** — real maxima on the three knobs plus the gap-≥-min-usable boot warning.
4. **M-A / M-B** — three tests (callsite increment, default pin, human bypass); the last two satisfy the project's own `CONTRIBUTING.md` rule.
5. **L-B / L-D / L-E** — doc one-liner, `Math.min` clamp, collapse on next touch.

No item needs a restart to investigate further, and none is a security hole.
