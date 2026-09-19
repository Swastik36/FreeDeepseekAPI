# Pacing Gate Fixes & Hardening Log

Documenting implementation and verification for each finding in `docs/verification-pacing-gate-2026-09-18.md`.
This document is updated incrementally as each finding is resolved and verified.

---

## 1. M-C — In-place Retry Quota/Burst Eligibility Scoping

### Problem & Root Cause
When `DEEPSEEK_RETRY_RATELIMIT=1` was enabled and an upstream turn failed with rate limit, the in-place retry gate (`server.js:4905`) verified pool-wide readiness via `anyReady: anyAccountReady(accounts)`. However, the in-place retry targets `session.accountId` specifically. While `inPlaceRateLimitRetry` temporarily lifts `account.cooldownUntil = 0`, it does not clear hourly quota (`withinQuota`) or 1-minute burst limit (`withinBurst`). If the retry account was cooling down *and* had exhausted quota or burst, the handler would sleep up to 10 seconds (`waitMs`), log an in-place retry attempt, and re-enter `askDeepSeekStream` where `selectAccountForSession` immediately re-threw a quota or burst 429 without reaching upstream.

### Resolution & Code Changes
1. **`shouldRetryInPlace` Eligibility Extension** ([`server.js:465-470`](file:///home/swastik/FreeDeepseekAPI/server.js#L465-L470)):
   - Added optional `accountReady` parameter: `if (o.accountReady !== undefined && !o.accountReady) return false;`.
   - Preserved `o.anyReady !== undefined && !o.anyReady` check for backwards compatibility with pool-wide all-cooling detection.
2. **Dedicated Helper `isRetryAccountEligible`** ([`server.js:495-500`](file:///home/swastik/FreeDeepseekAPI/server.js#L495-L500)):
   - Pure testable helper:
     ```javascript
     function isRetryAccountEligible(a, nowMs = Date.now()) {
         return !!(a && a.config && a.config.token && a.config.cookie && withinQuota(a, nowMs) && withinBurst(a, nowMs));
     }
     ```
   - Checks that the candidate account has credentials and is within hourly quota and burst limits. Deliberately does *not* check `cooldownUntil` because in-place retry's designated purpose is lifting cooldown once.
3. **Callsite Scoping** ([`server.js:4909-4923`](file:///home/swastik/FreeDeepseekAPI/server.js#L4909-L4923)):
   - Resolved `retryAccount` before evaluating `shouldRetryInPlace`.
   - Evaluated `retryEligible = isRetryAccountEligible(retryAccount)` and passed `accountReady: retryEligible` to `shouldRetryInPlace`.
   - Over-quota or over-burst retry accounts skip the wait and proceed immediately to rate limit migration.
4. **Test Exports**: Exported `isRetryAccountEligible` in `__test` object ([`server.js:5706`](file:///home/swastik/FreeDeepseekAPI/server.js#L5706)).

### Verification & Tests
- **Unit Test**: Added assertions in [`tests/unit.test.js:2974-2975`](file:///home/swastik/FreeDeepseekAPI/tests/unit.test.js#L2974-L2975) asserting `shouldRetryInPlace` returns `false` when `accountReady: false` and `true` when `accountReady: true`.
- **Anti-Suspension Test Suite**: Added test in [`tests/anti-suspension.test.js:530-573`](file:///home/swastik/FreeDeepseekAPI/tests/anti-suspension.test.js#L530-L573) (`M-C: isRetryAccountEligible scopes in-place retry to account quota and burst state`):
  - Proves `isRetryAccountEligible` accepts cooling account when quota/burst are intact.
  - Proves `isRetryAccountEligible` rejects missing credentials.
  - Proves burst-spent account fails `isRetryAccountEligible` and skips `shouldRetryInPlace`.
- **Suite Result**: 264/264 tests passing (245 core + 19 anti-suspension).

---

## 2. H-3 — Reservation Stamping at Gate-Pass for Concurrent Turn Serialization

### Problem & Root Cause
Previously, `account.lastDispatchedAt` was stamped only after the PoW challenge was obtained (`server.js:1924`), well after the pacing sleep and network round trips. If Turn A was sleeping or fetching, Turn B on the same account would observe the stale timestamp, calculate the same delay, and collapse the spacing to the spread between the two stamps (milliseconds instead of `AGENT_TURN_GAP_MS`).

### Resolution & Code Changes
1. **Admission Reservation Stamping** ([`server.js:1864-1867`](file:///home/swastik/FreeDeepseekAPI/server.js#L1864-L1867)):
   - Upon passing the gate check (when `pacing.action !== 'reject'`), immediately claim the dispatch slot:
     ```javascript
     const reservationStamp = now + (pacing.delayMs || 0);
     const prevDispatchedAt = account.lastDispatchedAt || 0;
     account.lastDispatchedAt = Math.max(prevDispatchedAt, reservationStamp);
     ```
   - If Turn B arrives while Turn A is waiting or fetching, Turn B observes `account.lastDispatchedAt` pointing to Turn A's future dispatch slot. Turn B calculates its delay relative to Turn A's slot, strictly maintaining `AGENT_TURN_GAP_MS` serialization.
2. **Immediate Pre-Sleep Client Disconnect Check** ([`server.js:1869-1874`](file:///home/swastik/FreeDeepseekAPI/server.js#L1869-L1874)):
   - Before entering `setTimeout(resolve, pacing.delayMs)`, if `isClientGone()` is already true, roll back the reservation and abort immediately without burning the sleep interval.
3. **Rollback on Aborted Wait** ([`server.js:1882-1887`](file:///home/swastik/FreeDeepseekAPI/server.js#L1882-L1887)):
   - Wrapped `setTimeout` and deadline checks in `try ... catch (waitErr)`. If client disconnects or request deadline expires during the wait, restores `account.lastDispatchedAt = prevDispatchedAt` (if no subsequent turn has stamped a newer reservation).
4. **Monotonic Dispatch Stamping** ([`server.js:1940`](file:///home/swastik/FreeDeepseekAPI/server.js#L1940)):
   - Updated dispatch stamping at `recordUpstreamTurn`:
     ```javascript
     recordUpstreamTurn(account);
     account.lastDispatchedAt = Math.max(account.lastDispatchedAt || 0, Date.now());
     ```
   - Guarantees `lastDispatchedAt` never rolls back a future reservation created by a concurrently queued turn.

### Verification & Tests
- **Anti-Suspension Test Suite**: Added test in [`tests/anti-suspension.test.js:574-650`](file:///home/swastik/FreeDeepseekAPI/tests/anti-suspension.test.js#L574-L650) (`H-3: pacing gate stamps reservation at admission and serializes concurrent turns`):
  - Spawns child process with `DEEPSEEK_AGENT_TURN_GAP_MS=6000`, `DEEPSEEK_TURN_JITTER_MS=0`.
  - Proves Call 1 writes a reservation stamp immediately at gate-pass before any network PoW fetch.
  - Proves Call 2 arriving with 2s deadline observes Call 1's reservation and throws typed 429 pacing reject (`isPacingReject: true`).
  - Proves reservation rolls back to `prevStamp` if client disconnects during wait.
- **Suite Result**: 265/265 tests passing (245 core + 20 anti-suspension).

---

## 3. M-D — Upper Clamps on Pacing Knobs & Startup Warning

### Problem & Root Cause
`numEnv(name, def, min, max)` warns and falls back to default when input values exceed `max` or are `< min`. Previously, `AGENT_TURN_GAP_MS`, `TURN_JITTER_MS`, and `MIN_USABLE_UPSTREAM_MS` had no upper `max` specified. An operator specifying `DEEPSEEK_AGENT_TURN_GAP_MS=300000` (e.g. fat-fingered extra zero) would silently lock up all agent loop turns or force immediate 429 rejects. Additionally, if `gap >= minUsable`, pacing sleep would almost never be permitted when remaining deadline is tight, leading to near-immediate rejects without warning.

### Resolution & Code Changes
1. **Knob Range Clamps** ([`server.js:1091-1093`](file:///home/swastik/FreeDeepseekAPI/server.js#L1091-L1093)):
   - `AGENT_TURN_GAP_MS = numEnv('DEEPSEEK_AGENT_TURN_GAP_MS', 6000, 0, 60000);` (clamped to 60s max).
   - `TURN_JITTER_MS = numEnv('DEEPSEEK_TURN_JITTER_MS', 2000, 0, 60000);` (clamped to 60s max).
   - `MIN_USABLE_UPSTREAM_MS = numEnv('DEEPSEEK_MIN_USABLE_UPSTREAM_MS', 10000, 1000, REQUEST_DEADLINE_MS);` (clamped to `REQUEST_DEADLINE_MS` = 120s max).
2. **Startup Warning on Pathological Configuration** ([`server.js:1094-1096`](file:///home/swastik/FreeDeepseekAPI/server.js#L1094-L1096)):
   ```javascript
   if (AGENT_TURN_GAP_MS > 0 && AGENT_TURN_GAP_MS >= MIN_USABLE_UPSTREAM_MS) {
       console.log(`[DS-API] Warning: DEEPSEEK_AGENT_TURN_GAP_MS (${AGENT_TURN_GAP_MS}ms) >= DEEPSEEK_MIN_USABLE_UPSTREAM_MS (${MIN_USABLE_UPSTREAM_MS}ms); turn pacing may reject turns when remaining deadline is tight.`);
   }
   ```

### Verification & Tests
- **Anti-Suspension Test Suite**: Added test in [`tests/anti-suspension.test.js:652-675`](file:///home/swastik/FreeDeepseekAPI/tests/anti-suspension.test.js#L652-L675) (`M-D: pacing knobs enforce upper clamps and warn when gap >= min-usable`):
  - Proves `DEEPSEEK_AGENT_TURN_GAP_MS=300000` triggers `[DS-API] Invalid DEEPSEEK_AGENT_TURN_GAP_MS="300000"; using default 6000` and clamps to 6000.
  - Proves `DEEPSEEK_MIN_USABLE_UPSTREAM_MS=200000` triggers `[DS-API] Invalid ... using default 10000` and clamps to 10000.
  - Proves `DEEPSEEK_AGENT_TURN_GAP_MS=15000` (which is $\ge 10000$) logs the startup warning.
- **Suite Result**: 266/266 tests passing (245 core + 21 anti-suspension).

---

## 4. M-A — Callsite Batch Metric Extraction & Behavioral Test Coverage

### Problem & Root Cause
Pillar 1's directive prompts models to batch multiple tool calls, and caller-side metrics (`account.multiToolBatchCount`, `account.batchSizeCounts`) record actual batch occurrences. Previously, existing tests only verified that `accountStatus` echoed pre-filled counters; no test actually drove multi-tool parsing output through the metric increment logic.

### Resolution & Code Changes
1. **Helper Extraction `recordBatchMetrics`** ([`server.js:2872-2878`](file:///home/swastik/FreeDeepseekAPI/server.js#L2872-L2878)):
   - Extracted the inline increment into a pure, testable helper:
     ```javascript
     function recordBatchMetrics(account, batchSize) {
         if (!account || !(batchSize > 1)) return;
         account.multiToolBatchCount = (account.multiToolBatchCount || 0) + 1;
         if (!account.batchSizeCounts) account.batchSizeCounts = {};
         const szKey = String(batchSize);
         account.batchSizeCounts[szKey] = (account.batchSizeCounts[szKey] || 0) + 1;
     }
     ```
2. **Callsite Wiring** ([`server.js:5302`](file:///home/swastik/FreeDeepseekAPI/server.js#L5302)):
   - Replaced verbose inline logic in HTTP response parsing with `recordBatchMetrics(initialCall?.account, multiCalls.length)`.
3. **Test Export**: Exported `recordBatchMetrics` in `__test` ([`server.js:5683`](file:///home/swastik/FreeDeepseekAPI/server.js#L5683)).

### Verification & Tests
- **Anti-Suspension Test Suite**: Added test in [`tests/anti-suspension.test.js:677-703`](file:///home/swastik/FreeDeepseekAPI/tests/anti-suspension.test.js#L677-L703) (`M-A: parseToolCalls batch output updates account multiToolBatchCount and batchSizeCounts`):
  - Drives a real 3-call string through `parseToolCalls` and feeds the result into `recordBatchMetrics`.
  - Asserts `multiToolBatchCount === 1` and `batchSizeCounts['3'] === 1`.
  - Asserts subsequent batches increment counts monotonically.
  - Asserts single-call turns (`batchSize === 1`) do not increment multi-tool counters.
- **Suite Result**: 267/267 tests passing.

---

## 5. M-B — Shipped Defaults Pinning & Human-Turn Bypass Verification

### Problem & Root Cause
Two critical invariants had no test pinning:
1. The shipped defaults (`6000ms` gap, `2000ms` jitter, `10000ms` min usable) were unpinned by tests, violating the project's own rule in `CONTRIBUTING.md`.
2. Human-turn bypass was tested only at the classifier level (`role === 'user'` $\rightarrow$ `false`), but never verified through `askDeepSeekStream` to guarantee that human turns incur zero sleep delay and zero reservation stamp (the founding zero-UX-penalty promise).

### Resolution & Code Changes
1. **Defaults Pinning**: Added assertions validating exported constants.
2. **Integration Bypass Verification**: Driven through `askDeepSeekStream` with `isAgentLoop: false` on an account with a recent dispatch timestamp that would otherwise require ~6s sleep.

### Verification & Tests
- **Anti-Suspension Test Suite**: Added test in [`tests/anti-suspension.test.js:705-755`](file:///home/swastik/FreeDeepseekAPI/tests/anti-suspension.test.js#L705-L755) (`M-B: shipped pacing defaults are pinned and human turns bypass pacing gate without delay`):
  - Asserts `AGENT_TURN_GAP_MS === 6000`, `TURN_JITTER_MS === 2000`, `MIN_USABLE_UPSTREAM_MS === 10000`.
  - Asserts `isAgentLoopTurn` returns `false` for genuine user prompts.
  - Intercepts `global.fetch` hermetically at `create_pow_challenge` so the test executes in ~1.5ms without hitting upstream network and aborts before dispatch timestamping.
  - Asserts `askDeepSeekStream` with `isAgentLoop: false` bypasses the pacing sleep entirely (< 500ms elapsed), proves the turn reached upstream PoW fetch directly, and asserts `account.lastDispatchedAt` was left untouched by the gate.
- **Suite Result**: 268/268 tests passing (245 core + 23 anti-suspension).

---

## 6. L-B, L-D, L-E — Lows & Cleanup

### Problem & Root Cause
1. **L-B**: `docs/solution-pacing-2026-09-17.md:34` documented non-existent variable `DEEPSEEK_MIN_TURN_GAP_MS` with stale `default 0`.
2. **L-D**: In `calculateRequiredDelay`, `Math.floor(rand() * (jitterMs + 1))` evaluated to `jitterMs + 1` when injected deterministic `rand` returned `1`.
3. **L-E**: In `selectAccountForSession`, `stickyOverBurst` was computed inline, and then `stickyBurstReject` recomputed `burstUsedThisMinute(sticky, nowMs) >= limit` redundantly.

### Resolution & Code Changes
1. **L-B Doc Correction** ([`docs/solution-pacing-2026-09-17.md:34`](file:///home/swastik/FreeDeepseekAPI/docs/solution-pacing-2026-09-17.md#L34)):
   - Updated knob name to `DEEPSEEK_AGENT_TURN_GAP_MS (default 6000)` and jitter to `default 2000`.
2. **L-D Jitter Upper Bound Clamp** ([`server.js:1115-1119`](file:///home/swastik/FreeDeepseekAPI/server.js#L1115-L1119)):
   - Applied `Math.min(jitterMs, ...)`:
     ```javascript
     const jitter = jitterMs > 0 ? Math.min(jitterMs, Math.floor(rand() * (jitterMs + 1))) : 0;
     ```
3. **L-E Unified Burst Gate Evaluation** ([`server.js:394-404, 809-810`](file:///home/swastik/FreeDeepseekAPI/server.js#L394-L404)):
   - Updated `stickyBurstReject(sticky, session, nowMs, limit, isOverBurst = null)` to accept precomputed `stickyOverBurst` boolean.
   - Reuses the existing calculation in `selectAccountForSession` without a second evaluation of `burstUsedThisMinute`.

### Verification & Tests
- **Anti-Suspension Test Suite**: Added tests in [`tests/anti-suspension.test.js:751-782`](file:///home/swastik/FreeDeepseekAPI/tests/anti-suspension.test.js#L751-L782):
  - `L-D: calculateRequiredDelay clamps jitter to jitterMs when rand returns 1` (asserts `rand = 1` yields exactly `targetGapMs + jitterMs`, never `+1`).
  - `L-E: stickyBurstReject accepts precomputed isOverBurst to avoid redundant evaluation` (proves precomputed `false` returns `null`, precomputed `true` returns typed 429).
- **Suite Result**: 270/270 tests passing (245 core + 25 anti-suspension).

---
