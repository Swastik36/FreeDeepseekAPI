# Verification & Audit Report: Per-Account Concurrency Ceiling for FreeDeepSeekAPI

**Date:** 2026-09-22  
**Auditor:** Principal Software Engineer & Concurrency Specialist  
**Target Codebase:** `/home/swastik/FreeDeepseekAPI` (`server.js`, `tests/unit.test.js`)  
**Active Branch:** `swastik-mods` (uncommitted working tree changes)  
**Test Suite Status:** 289 passing across all suites (`npm test`: 252 unit, 25 anti-suspension, 7 updater, 5 installer; 0 failed)

---

## Executive Summary

The pending concurrency ceiling implementation (`MAX_PER_ACCOUNT`, `hasCapacity`, `saturatedWaitSec`) establishes an essential protection mechanism against upstream DeepSeek account suspension. However, a deep architectural and concurrency audit reveals **critical concurrency vulnerabilities**:

1. **Premature Inflight Release During Streaming (Critical Architecture Flaw):** `account.inflight` is decremented in `askDeepSeekStream`'s `finally` block immediately upon receipt of upstream HTTP response headers, leaving `account.inflight === 0` throughout the entire 10–60+ second SSE token streaming phase. During streaming, `hasCapacity(account)` evaluates to `true`, completely dismantling the concurrency ceiling.
2. **TOCTOU Race Window (Critical):** `hasCapacity` is checked during account selection, followed by an asynchronous pacing gate (`await setTimeout(...)`) before `account.inflight` is incremented. Multiple concurrent requests slip past the gate and burst upstream simultaneously.
3. **Mid-Turn Streaming Migration Regression (High):** When an account rate-limits mid-stream and peer accounts are busy, the migration handler falls back to cooldown math (`earliestReleaseMs()`) and emits a 429 with up to a 10-minute backoff rather than a 503 Overloaded with turn-scale retry (2–10s).
4. **Defensive Programming Flaws (Medium/High):** Missing null guards at line 863 can trigger unhandled TypeErrors; `hasCapacity(null)` inappropriately fails open; `setMaxPerAccount` silently disables the ceiling on invalid inputs; and underflow detection in `inflight` decrement is masked by `(0 || 1) - 1`.

Below is the exhaustive item-by-item verification, deep-dive concurrency analysis, discovery of additional edge cases, and an engineering implementation roadmap.

---

## 1. Item-by-Item Verdict on the 10 Pending Findings

### Finding 1: TOCTOU Race Window Between `hasCapacity` Check, Pacing Gate `await`, and `inflight` Increment
- **Verdict:** **CONFIRMED**
- **Location:** `server.js:1887` (`selectAccountForSession`), `server.js:1916` (`await new Promise(...)`), `server.js:1942` (`account.inflight++`).
- **Analysis:**
  At line 1887, `selectAccountForSession(session, agentId)` selects an account by evaluating `hasCapacity(a)` (line 853 / 816), which verifies `account.inflight < MAX_PER_ACCOUNT`.
  Immediately after selection, lines 1896–1935 execute the turn-aware pacing gate for agent loops:
  ```javascript
  1908: if (pacing.action === 'wait' && pacing.delayMs > 0) {
  ...
  1916:     await new Promise(resolve => setTimeout(resolve, pacing.delayMs));
  ```
  At line 1916, execution yields back to the Node.js event loop for `delayMs` (typically 500ms to 2000ms+). During this wait, `account.inflight` has **not** yet been incremented (increment occurs at line 1942).
  Any concurrent request arriving during this delay executes `selectAccountForSession`, observes `account.inflight === 0`, and selects the identical account. When the pacing timer fires, all queued requests proceed to line 1942, incrementing `inflight` past `MAX_PER_ACCOUNT` and blasting concurrent requests upstream to DeepSeek Web API.

---

### Finding 2: Lack of Genuine Concurrent-Request Unit Tests Testing `MAX_PER_ACCOUNT=1`
- **Verdict:** **CONFIRMED**
- **Location:** `tests/unit.test.js:3356–3528`, `4350–4384`.
- **Analysis:**
  All existing capacity tests in `tests/unit.test.js` evaluate static mock states (e.g. manually mutating `{ inflight: 1 }` on objects before calling a synchronous function) or issue a single isolated HTTP request via `withServer`.
  Not a single test launches two concurrent overlapping asynchronous operations (e.g., `Promise.all([post(...), post(...)])` or concurrent `askDeepSeekStream` calls) against an account with `MAX_PER_ACCOUNT=1`.
  **Feasibility:** Genuine concurrent tests can readily be written in `unit.test.js` using `withServer` and `Promise.all([post(port, ...), post(port, ...)])` with an ephemeral mock fetch or delayed stream response.

---

### Finding 3: Null-Guard Mismatch (`server.js:855` vs `server.js:863`)
- **Verdict:** **CONFIRMED**
- **Location:** `server.js:855` vs `server.js:863`, `869`, `873`.
- **Analysis:**
  At line 855:
  ```javascript
  855: const usable = accounts.filter(a => a && a.config && a.config.token && a.config.cookie);
  ```
  The author defensively checked `a && a.config`. However, eight lines down:
  ```javascript
  863: const waiting = accounts.filter(a => a.config.token && a.config.cookie).sort((a, b) => a.cooldownUntil - b.cooldownUntil)[0];
  869: const capped = accounts.filter(a => a.config.token && a.config.cookie && !withinQuota(a, now)).map(a => a.id);
  873: const capped = accounts.filter(a => a.config.token && a.config.cookie && !withinBurst(a, now)).map(a => a.id);
  ```
  If `accounts` contains a `null` element or an account object without `config` (e.g., during config reload, corrupted auth, or test fixtures), line 853 (`isAccountReady`) safely ignores it, line 855 filters it out, but line 863 immediately throws:
  `TypeError: Cannot read properties of undefined (reading 'token')` (or `properties of null (reading 'config')`).
  This unhandled exception bubbles up to the HTTP server handler and turns a proper 429/503 into an unhandled HTTP 500 error. Reusing `usable` for `waiting` and lines 869/873 completely resolves this.

---

### Finding 4: Undocumented `MAX_PER_ACCOUNT` Knob in `.env.example` / `README.md`
- **Verdict:** **CONFIRMED**
- **Location:** `.env.example`, `README.md`.
- **Analysis:**
  `DEEPSEEK_MAX_PER_ACCOUNT` is parsed at `server.js:589`:
  ```javascript
  let MAX_PER_ACCOUNT = numEnv('DEEPSEEK_MAX_PER_ACCOUNT', 1, 0, 10);
  ```
  It defaults to `1`. Grepping `.env.example` and `README.md` yields zero occurrences. Operators running multi-user proxies or multi-agent clients have no visibility that this ceiling exists, that it defaults to 1 concurrency per account, or that setting it to `0` disables the ceiling.

---

### Finding 5: `saturatedWaitSec` EWMA Latency Heuristic, `lastDispatchedAt` Clamp, Comment vs Behavior
- **Verdict:** **REFINED**
- **Location:** `server.js:601–608`.
- **Analysis:**
  The function:
  ```javascript
  function saturatedWaitSec(account, nowMs = Date.now()) {
      const elapsed = Math.max(0, nowMs - (account?.lastDispatchedAt || nowMs));
      const ewma = Number(account?.ewmaLatencyMs) || 5000;
      const estMs = Math.max(2000, ewma - elapsed);
      const deadlineCapSec = Math.max(1, Math.ceil(REQUEST_DEADLINE_MS / 1000));
      return Math.min(deadlineCapSec, Math.min(10, Math.max(2, Math.ceil(estMs / 1000))));
  }
  ```
  1. **Future Stamp Clamping During Pacing:** When pacing is active, line 1906 stamps `account.lastDispatchedAt = now + pacing.delayMs` (in the future). `nowMs - lastDispatchedAt` is negative, so `Math.max(0, ...)` sets `elapsed = 0`. The function returns `ewma` (e.g. 5s), ignoring the fact that the running request has not even started its upstream round trip and will take `remainingPacing + ewma`.
  2. **Multi-Concurrency Head-of-Line Inaccuracy:** If `MAX_PER_ACCOUNT > 1`, `lastDispatchedAt` records the dispatch time of the *most recently* admitted request, not the earliest admitted request. Therefore `elapsed` reflects the newest turn rather than estimating when the earliest turn will vacate.
  3. **Comment vs Deadline Cap:** The comment specifies "bounded between 2s and 10s (and capped by REQUEST_DEADLINE_MS)". In extreme configurations where `REQUEST_DEADLINE_MS <= 1000`, `deadlineCapSec` is 1, and `Math.min(1, Math.max(2, ...))` returns 1s, violating the literal 2s floor. Under standard operations (deadline >= 2000ms), bounding is preserved.
  *Conclusion:* Functionally safe for HTTP `Retry-After`, but semantically coarse.

---

### Finding 6: Migration Mid-Turn 503 Behavior Change During `askDeepSeekStream` Re-entry
- **Verdict:** **CONFIRMED & REFINED**
- **Location:** `server.js:5015–5030`, `5146–5187`.
- **Analysis:**
  There are two critical migration paths when rate limits strike:
  1. **Mid-turn SSE Migration (`server.js:5146–5172`):** When upstream returns an SSE rate limit mid-stream, `resolveRateLimitMigration` attempts to find a peer account. If all peer accounts are saturated (`hasCapacity(a)` is false), `decision.migrateTo` is `undefined`. Line 5150 executes:
     ```javascript
     if (rateLimitMigrated || !decision.migrateTo) {
         const rel = earliestReleaseMs();
         const waitSec = Number.isFinite(rel) ? Math.max(1, Math.ceil((rel - Date.now()) / 1000)) : 2;
         ...
         sendStreamError(res, apiMode, { message: rateLimitExhaustedMessage(waitSec), type: 'rate_limit_error' });
     ```
     This emits a **429 rate limit error** with a cooldown computed from `earliestReleaseMs()` (which can be 5–10 minutes for cooling accounts!), advising the user that the pool is exhausted and suggesting context compaction. This directly contradicts the design principle tested at `unit.test.js:3477`: ready-but-saturated peers should yield a short 503 Overloaded (2–10s retry), not a 5-minute 429 exhaustion error.
  2. **Initial-Turn Migration Catch (`server.js:5014–5016`):** If initial dispatch 429s and peer accounts are saturated, `!decision.migrateTo` causes `throw e`, rethrowing the original 429 cooldown instead of signalling temporary concurrency saturation.
  3. **Unprotected Migration Re-entry:** When migration proceeds (line 5174: `performRateLimitMigration`), the remote chat session is reset (`session.id = null`). If the subsequent call to `askDeepSeekStream` at line 5182 fails with 503 Overloaded (due to race or peer becoming busy), the chat session was already destroyed mid-turn without recovery.

---

### Finding 7: `stickyBurstReject` Ordering vs Chat-less Stickies Rotation
- **Verdict:** **REFINED (INVALID as a defect)**
- **Location:** `server.js:814–852`.
- **Analysis:**
  The reviewer suspected that `stickyBurstReject` (line 832) might interfere with chat-less session rotation or capacity rejection.
  Detailed examination proves the logic is sound:
  - `stickyBurstReject` contains an internal guard: `if (!session || !session.id) return null;` (line 399).
  - For chat-less sessions (`session.id == null`), `stickyBurstReject` returns `null` and `stickySaturated && session.id` is `false`. Both conditions cleanly fall through to lines 850–851 (`session.accountId = null`), unsticking the session and rotating freely to `ready` accounts at line 853.
  - For live chat sessions (`session.id != null`), placing quota and burst rejection before saturation 503 rejection is **correct**: quota and burst cooldowns are long-term constraints (minutes to an hour). If a live chat's account is both burst-exhausted and saturated, returning 503 (retry in 2s) would immediately fail with 429 on retry. The long-term constraint must take precedence.
  *Conclusion:* Not a functional bug; merely a stylistic difference (helper function vs inline `if`).

---

### Finding 8: `hasCapacity(null)` Returning `true` (Failing Open)
- **Verdict:** **CONFIRMED**
- **Location:** `server.js:596–598`, `tests/unit.test.js:3363`.
- **Analysis:**
  Line 596 defines:
  ```javascript
  function hasCapacity(a) {
      return !(MAX_PER_ACCOUNT > 0) || (Number(a && a.inflight) || 0) < MAX_PER_ACCOUNT;
  }
  ```
  When `a` is `null` or `undefined`, `a && a.inflight` is `null`. In JavaScript, `Number(null)` evaluates to `0`. Consequently, `0 < MAX_PER_ACCOUNT` evaluates to `true`.
  The unit test at `unit.test.js:3363` explicitly enshrines this:
  `assert.equal(serverInternals.hasCapacity(null), true, 'null fails open');`
  Failing open on `null` contradicts all other account validation predicates in the codebase (`isAccountReady`, `isRetryAccountEligible`), which strictly require `Boolean(a && a.config)` and fail closed. If `hasCapacity` is ever used as a standalone check, passing `null` will falsely indicate capacity and crash with null dereferences downstream.

---

### Finding 9: `setMaxPerAccount` Silently Disabling on Invalid Input
- **Verdict:** **CONFIRMED**
- **Location:** `server.js:591`.
- **Analysis:**
  `server.js:591`:
  ```javascript
  function setMaxPerAccount(n) { MAX_PER_ACCOUNT = Math.max(0, Math.min(10, Math.floor(Number(n) || 0))); }
  ```
  If `n` is `NaN`, `undefined`, `"invalid"`, or negative, `Number(n) || 0` coerces to `0`.
  Because `MAX_PER_ACCOUNT <= 0` signifies that the ceiling is disabled (`!(MAX_PER_ACCOUNT > 0)`), any invalid argument silently disables concurrency limiting completely without warning or error.
  By contrast, startup helper `numEnv` (line 30) warns and retains defaults. `setMaxPerAccount` should validate `Number.isFinite(n) && n >= 0`, rejecting or warning on invalid inputs.

---

### Finding 10: Git Status and Uncommitted State
- **Verdict:** **CONFIRMED**
- **Location:** Working tree on branch `swastik-mods`.
- **Analysis:**
  `git status` confirms:
  - Changes not staged for commit: `modified: server.js`, `modified: tests/unit.test.js`.
  - Untracked files: `accounts/` (local testing/auth directory).
  The implementation is entirely uncommitted.

---

## 2. Test Suite Execution & Output Verification

Running `cd /home/swastik/FreeDeepseekAPI && npm test` executes four test files under `node --test` alongside syntax checks:
- `tests/unit.test.js`: **252 passed**, 0 failed, duration: ~2.4s.
- `tests/anti-suspension.test.js`: **25 passed**, 0 failed, duration: ~648ms.
- `tests/update.test.js`: **7 passed**, 0 failed, duration: ~933ms.
- `tests/install.test.js`: **5 passed**, 0 failed, duration: ~208ms.
- **Grand Total:** **289 tests passed, 0 failed** (exit code 0).

---

## 3. Deep-Dive Concurrency Analysis: The TOCTOU Race & Architectural Root Cause

### Root Cause Analysis
In Node.js, asynchronous operations between a capacity check and a state mutation yield control back to the event loop. The execution timeline in `server.js` currently is:

```
Request 1: selectAccountForSession() -> checks hasCapacity() -> returns account (inflight: 0)
Request 1: pacing gate -> resolvePacingAction() -> action === 'wait'
Request 1: await new Promise(resolve => setTimeout(resolve, delayMs)) [YIELDS EVENT LOOP]
   │
   ├── Request 2 arrives: selectAccountForSession() -> checks hasCapacity() -> sees inflight: 0!
   ├── Request 2: pacing gate -> await setTimeout(...) [YIELDS EVENT LOOP]
   │
Request 1 timer fires: account.inflight++ (inflight: 1) -> dispatches upstream
Request 2 timer fires: account.inflight++ (inflight: 2) -> dispatches upstream simultaneously!
```

### Recommended Reservation/Release Pattern
To guarantee an unbreakable concurrency ceiling, admission and capacity reservation must be atomic:
1. **Synchronous Reservation:** `account.inflight` must be incremented synchronously at selection time (within `selectAccountForSession` or immediately upon return), **before** entering the pacing gate `await`.
2. **Guaranteed Pacing Cleanup:** If the client aborts or the request deadline expires during the pacing interval, a `try/finally` or catch block must immediately decrement `account.inflight`.

---

## 4. Discovery of Additional Critical Concurrency Bugs & Edge Cases

Our audit discovered **five additional bugs and edge cases** not captured in the preliminary 10-item review:

### Bug A (CRITICAL): Premature Inflight Decrement During Response Streaming
- **Location:** `server.js:2071`, `2085–2089` vs `server.js:5133`.
- **Mechanism:**
  In `server.js`:
  ```javascript
  2071: return { resp, agentId, account, promptUsed: effectivePrompt, freshSessionReset: recoveredFreshSession };
  2085: } finally {
  2086:     const remaining = (Number(account.inflight) || 1) - 1;
  ...
  2088:     account.inflight = Math.max(0, remaining);
  2089: }
  ```
  `askDeepSeekStream` returns `resp` (the raw HTTP `Response` object with unconsumed `resp.body` stream).
  Because `return` in a try block triggers the `finally` block before the promise resolves to the caller, **`account.inflight` is decremented back to 0 as soon as the HTTP headers arrive from DeepSeek (~300ms)!**
  The actual SSE streaming body consumption occurs **outside** `askDeepSeekStream` in the caller:
  ```javascript
  5133: let { content: fullContent, reasoningContent, ... } = await readDeepSeekResponse(dsResp.body);
  ```
  This streaming read can take 30 to 60+ seconds. Throughout this entire window, **`account.inflight` is 0**.
  Any subsequent request arriving during this time checks `hasCapacity(account)`, sees `inflight === 0 < MAX_PER_ACCOUNT`, and dispatches to the exact same DeepSeek account concurrently. DeepSeek Web API immediately detects multiple simultaneous streams on the same user session, triggering suspensions.
  **Remedy:** The account lease must span the entire turn, including `readDeepSeekResponse`, and only be released when the stream completes or errors.

### Bug B (HIGH): Client Disconnect During Streaming Leaves No Account Cleanup
- **Location:** `server.js:4667`, `5595–5600`.
- **Mechanism:**
  At line 4667: `res.on('close', () => { clientGone = true; clearKeepAlive(res); });`.
  At line 5595: The outer HTTP handler `finally` block decrements global `inFlight--`:
  ```javascript
  5595: } finally {
  5599:     if (inFlightCounted) inFlight--;
  5600: }
  ```
  Notice that `account.inflight` is completely absent from the outer `finally` block. Because `account.inflight` currently drops to 0 early (Bug A), it doesn't leak on disconnect. But once Bug A is corrected to hold `inflight` during streaming, any client disconnect (`res.on('close')`) or stream abort will permanently leak `account.inflight` unless the outer request handler releases the active account lease in `finally`.

### Bug C (HIGH): Masked Underflow in `inflight` Decrement
- **Location:** `server.js:2086`.
- **Mechanism:**
  ```javascript
  2086: const remaining = (Number(account.inflight) || 1) - 1;
  2087: if (remaining < 0) console.warn(`[account:${account.id}] inflight clamp engaged (counter would go negative); floored at 0 — investigate for a leak.`);
  ```
  If `account.inflight` is `0`, JavaScript evaluates `Number(0) || 1`, which evaluates to `1`.
  Then `1 - 1 = 0`. Thus `remaining` is `0`!
  `remaining < 0` is false!
  If an extra decrement occurs when `inflight` is 0, the underflow warning is **silently masked** and never logged. The check is dead code for zero-counter decrements. It must be written as:
  ```javascript
  const current = Number(account.inflight) || 0;
  const remaining = current - 1;
  if (remaining < 0) console.warn(...);
  ```

### Bug D (MEDIUM): Code Window Between Inflight Increment and Try Block
- **Location:** `server.js:1942–1954`.
- **Mechanism:**
  Line 1942 increments `account.inflight = (Number(account.inflight) || 0) + 1`.
  Lines 1943–1953 perform string interpolation, prompt selection, and console logging before line 1954 enters `try {`.
  If any synchronous exception occurs in this block (e.g. logging hook exception or variable access), the `finally` block is never entered, permanently blackholing the account under scoring.
  The increment must occur immediately inside or directly preceding the `try` block.

### Bug E (HIGH): Intra-Turn Retries/Continuations Suffer 503 Mid-Stream Abort
- **Location:** `server.js:5229` (empty retry), `5298` (continuation), `5388` (tool repair).
- **Mechanism:**
  A single client request can execute multiple upstream calls (e.g. response continuation when token limit is reached, or strict tool formatting retry).
  Because the account was released after the first call (Bug A), a concurrent request from another client can grab the account. When the continuation turn calls `askDeepSeekStream`, `selectAccountForSession` finds its sticky account saturated and throws 503 Overloaded.
  This causes the user's connection to abort halfway through a streaming response with an SSE error, ruining the user experience.

---

## 5. Concrete Recommended Implementation Roadmap

### Phase 1: Account Lease & Turn Lifecycle (Fixes Finding 1, Bug A, Bug B, Bug D, Bug E)
1. **Implement `acquireAccountLease(account)` and `releaseAccountLease(account)`:**
   - Define formal lease helpers that manage `account.inflight` safely with correct underflow warnings.
2. **Move Reservation to Admission:**
   - In `selectAccountForSession` (or immediately upon selection in `askDeepSeekStream` / migration), acquire the lease synchronously before any `await` or pacing delay.
   - Wrap the pacing gate in a `try/catch` that releases the lease if pacing aborts or client disconnects.
3. **Extend Lease Across Streaming:**
   - Ensure the lease remains held during `readDeepSeekResponse`.
   - Pass an active lease handle or track `activeAccountLease` on the request context, releasing it in the outer `finally` block of `server.js:5595` (`if (activeAccountLease) releaseAccountLease(activeAccountLease)`).
   - In intra-turn continuations/retries, preserve the existing lease rather than re-competing for capacity.

### Phase 2: Migration & Saturation Consistency (Fixes Finding 6)
1. In `resolveRateLimitMigration`, distinguish between "all peers cooling/dead" and "peers ready but saturated".
2. When all peers are saturated:
   - Mid-turn streaming (line 5150) must emit a 503 Overloaded with `Retry-After: saturatedWaitSec(...)` instead of computing `earliestReleaseMs()` and sending a 429 with 5-minute backoff.
   - Initial catch (line 5015) must similarly surface 503 Overloaded with turn-scale retry.

### Phase 3: Defensive Guards & Hardening (Fixes Finding 3, Finding 8, Finding 9, Bug C)
1. **Finding 3:** At line 863, 869, 873, replace `accounts.filter(...)` with filters over `usable` to eliminate null/undefined dereference risks.
2. **Finding 8:** Update `hasCapacity(a)`:
   ```javascript
   function hasCapacity(a) {
       if (!a || !a.config) return false;
       return !(MAX_PER_ACCOUNT > 0) || (Number(a.inflight) || 0) < MAX_PER_ACCOUNT;
   }
   ```
   Update the unit test at `unit.test.js:3363` to assert that null fails closed (`hasCapacity(null) === false`).
3. **Finding 9:** Harden `setMaxPerAccount(n)` to validate `Number.isFinite(n) && n >= 0`, ignoring or warning on invalid arguments rather than disabling the ceiling.
4. **Bug C:** Fix `(Number(account.inflight) || 1) - 1` to `(Number(account.inflight) || 0) - 1`.

### Phase 4: True Concurrency Unit Tests (Fixes Finding 2)
1. Add concurrent tests in `tests/unit.test.js`:
   - Fire `Promise.all([post(port, ...), post(port, ...)])` against an ephemeral server with `MAX_PER_ACCOUNT=1`.
   - Verify that one request succeeds while the other receives 503 Overloaded with valid `Retry-After` headers and `overloaded` error type.
   - Verify that concurrent agent loop turns serialize properly through the pacing gate without violating `MAX_PER_ACCOUNT`.

### Phase 5: Documentation & Configuration (Fixes Finding 4)
1. Add `DEEPSEEK_MAX_PER_ACCOUNT` to `.env.example` under an explicit `## Concurrency ceiling` section. Document default (`1`), allowable range (`0` to `10`), and note that `0` disables per-account limiting.
2. Update `README.md` with operational guidance for multi-client setups.
