# Solution — Anti-Suspension Architecture (Zero-UX-Penalty)

Date: 2026-09-18.  
Status: AUDITED & APPROVED (Final Polish).  
Goal: Eliminate upstream DeepSeek account mutes and suspensions during heavy agentic coding workloads without imposing developer-facing latency or sacrificing user experience.

---

## 1. Problem & Forensic Context

### 1.1 Forensic Findings vs Working Hypotheses
To ensure engineering effort targets verified mechanisms rather than speculation, the anti-suspension architecture strictly separates empirically measured phenomena from working threat hypotheses:

1. **Sub-second Machine Turnaround (Observed Fact)**:
   - In autonomous agentic loops (`read_file` -> `edit_file` -> `run_command`), local tool execution completes in 10–50ms.
   - Upstream DeepSeek receives consecutive multi-thousand token prompts separated by tens of milliseconds.
   - Real human users in web browsers require multiple seconds to read responses and type prompts. Sub-second turnarounds represent an unmistakable automated signature.
2. **Single-Account Monopolization (Observed Fact)**:
   - Session stickiness pins an entire agent conversation to one account to preserve server-side chat context (`session.id`).
   - A long coding task with 40 tool calls dumps 100% of its volume onto a single account within minutes, consuming its hourly quota and triggering velocity tripwires while peer accounts in the pool remain idle.
3. **Headless Route Divergence (Working Hypothesis)**:
   - A proxy issuing exclusively completion and chat-creation calls omits the baseline background telemetry and profile routes (`GET /api/v0/users/current`) that standard web sessions periodically trigger. While it is unproven whether DeepSeek's WAF actively computes route ratios, matching standard browser navigation paths reduces statistical divergence from typical web traffic.
4. **WAF Velocity Heuristics (Working Hypothesis)**:
   - Cloudflare WAF and backend risk engines may monitor burst velocity per IP and per authorization token over short windows (e.g. 1–5 minutes).
5. **Cross-Account Device Clustering (Working Hypothesis)**:
   - Reusing identical static identifiers (`device_id`) across multiple distinct user accounts poses a significant risk of account linkage on risk SDKs (e.g. Shumei). Providing authentic, browser-isolated UUIDs mitigates correlated fingerprint clustering.

### 1.2 The UX Integrity Invariant
A blunt, flat 2–5 second sleep on every turn is unacceptable:
- It degrades interactive human turns with artificial latency.
- It redundantly stalls turns where local execution was already slow (e.g. running builds or test suites taking 3–10s).
- It injects 30–50 seconds of dead idle time into every standard 10-turn coding task.
- Any delay mechanism must be **turn-aware** and **delta-based**: only agent-loop turns ever wait, human turns are always instant.

---

## 2. Hardened Architecture (5 Core Pillars)

```
                       [Incoming Request]
                               │
               ┌───────────────┴───────────────┐
               ▼                               ▼
       [Client Compaction]             [Normal Turn]
               │                               │
    [Compaction Rotation]                      │
    - Ready peer pool (least-used)             │
    - Fresh pin scoping (no lock)              │
    - Atomic reset & swap                      │
    - Repair budget cleared (fresh chat)       │
               │                               │
               └───────────────┬───────────────┘
                               │
                      [Account Selection]
                      - Fresh session: honor PREFERRED_ACCOUNT
                      - Live session: sticky to session.accountId
                               │
                [askDeepSeekStream Choke Point]
                               │
               ┌───────────────┴───────────────┐
               ▼                               ▼
     [Lazy Ambient Telemetry]          [Delta Pacer]
     - Permitted headers only          - Classifier: Human 0ms vs Agent loop
     - Non-blocking fire-and-forget    - delay = max(0, target - elapsed)
     - 15s AbortSignal timeout         - Jitter: uniform on [0, jitterMs]
     - Log-only 401 (no failure mark)  - Usable deadline gate
                                       - Callsite exemption (!e.isPacingReject)
                                       - Outer catch Retry-After preservation
                               │
                      [Upstream Send]
                               │
                  [Dispatch Timestamp Stamping]
                  - Stamp account.lastDispatchedAt at recordUpstreamTurn
```

---

### Pillar 1: Batching Directive Diff & Caller-Side Metrics

#### Objective
Encourage DeepSeek to emit multiple independent tool calls in a single turn (up to 8 calls), directly reducing the number of round-trips and turnaround intervals without modifying client code or model weights.

#### Prompt Diff & Contradiction Review (`server.js:2008` in `formatToolDefinitions`)
Line 2008 currently instructs the model on batch discipline. We update it to provide an explicit directive to parallelize independent read operations while preserving the 6-batch limit:

```diff
- text += 'BATCH DISCIPLINE: at most 6 tool batches per task; 1 batch = one turn with max 8 tool calls. Plan multi-step work to fit: batch independent calls together, then answer from results. Do not re-batch the same calls and do not split one batch across turns.\n';
+ text += 'BATCH DISCIPLINE: at most 6 tool batches per task; 1 batch = one turn with max 8 tool calls. When inspecting code (read/grep/find), emit all independent calls in the SAME turn (up to 8 calls); single-call turns are reserved for when a subsequent argument strictly depends on prior tool output. Do not batch mutations on the same target. Plan multi-step work to fit: batch independent calls together, then answer from results.\n';
```

**Coexistence Review**:
- **Cap Clarity**: "6 tool batches per task" (task budget) and "1 batch = one turn with max 8 tool calls" (per-turn ceiling) are explicitly defined. The second sentence reinforces the 8-call per turn limit ("up to 8 calls") without altering the 6-batch task ceiling.
- **Safety**: "Do not batch mutations on the same target" prevents race conditions or overlapping edits.

#### Metrics Placement & House-Pattern Scope (`server.js:~5058`)
- **Purity Guard**: `parseToolCalls` remains completely pure and account-agnostic. It does not access `account` or global state.
- **Caller-Side Tracking**: Metrics are recorded at the callsite in `server.js` (~line 5058) where both parsed `multiCalls` and `account` are available:
  ```javascript
  const multiCalls = parseToolCalls(fullContent, { allowedToolNames });
  if (multiCalls && multiCalls.length > 0 && multiCalls.every(tc => allowedToolNames.has(tc.name))) {
      console.log(`${agentTag} Model emitted ${multiCalls.length} valid tool call(s) in turn: ${multiCalls.map(tc => tc.name).join(', ')}`);
      toolCall = multiCalls.length === 1 ? multiCalls[0] : multiCalls;
      if (multiCalls.length > 1 && initialCall?.account) {
          initialCall.account.multiToolBatchCount = (initialCall.account.multiToolBatchCount || 0) + 1;
          if (!initialCall.account.batchSizeCounts) initialCall.account.batchSizeCounts = {};
          const szKey = String(multiCalls.length);
          initialCall.account.batchSizeCounts[szKey] = (initialCall.account.batchSizeCounts[szKey] || 0) + 1;
      }
  }
  ```
- **Surfacing in `/health`**: Follows the house pattern in `accountStatus(account)`:
  ```json
  "accounts": [
    {
      "id": "account_1",
      "multi_tool_batches": 14,
      "batch_size_distribution": { "2": 8, "3": 4, "4": 2 }
    }
  ]
  ```

---

### Pillar 2: Account Device ID Capture & Staging (Option C)

#### Objective
Capture authentic application-level UUIDs (`deepseek-device-id:chat`) per account without causing browser lock collisions, and stage them safely through the verification pipeline using `device_id` snake_case throughout.

#### Architecture Decision: Dedicated Auth Profile Capture (Option C)
Pointing `deepseek_chrome_auth.js` at the running MCP browser profile (`~/.config/playwright-profile`) is architecturally invalid: Chromium places an exclusive `SingletonLock` on its user data directory, and running two instances causes lock contention and profile corruption.
Instead, we adopt **Option (c)**:
1. **Interactive Extraction via CDP**: During interactive login, `deepseek_chrome_auth.js` opens its dedicated Chrome instance on port 9334. DeepSeek Web initializes its application state, writing `deepseek-device-id:chat` into `localStorage`.
2. **CDP Extraction**: `readPageAuth(cdp)` extracts `pageState.localStorage['deepseek-device-id:chat']` over the active CDP connection.
3. **Strict RFC 4122 Hex Validation**:
   ```javascript
   const rawDeviceId = pageState.localStorage ? pageState.localStorage['deepseek-device-id:chat'] : null;
   const device_id = (typeof rawDeviceId === 'string' && /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(rawDeviceId))
       ? rawDeviceId
       : null;
   ```
4. **Direct snake_case Persistence**: `readPageAuth` returns `device_id` (snake_case). It is written directly as `"device_id"` in `persistAuthResult`, perfectly matching `server.js:617` (`config.device_id`).
5. **Lifecycle & Churn Caveat**: The captured UUID remains stable for the lifetime of that account file (e.g. `accounts/bharat.json`), persisting across all server restarts and serving thousands of requests. It changes only when an operator re-authenticates the account via `npm run auth`, accurately mirroring a user clearing browser cache or logging in from a new machine.

#### Credential Staging & Promotion Pipeline
1. `scripts/auth-cli.sh` writes credentials and `device_id` into a temporary staging file (`$TMP_PREFIX.stage`, mode `0600`, non-json extension to prevent premature discovery).
2. Staging file is probed via `node "$REPO_ROOT/scripts/probe-account.js" "$TMP_PREFIX.stage"`.
3. Only upon `ALIVE` response:
   - Create timestamped backup: `cp "$target" "$target.bak.$(date +%s)"`.
   - Atomic replacement: `mv "$TMP_PREFIX.stage" "$target"` (e.g. into `accounts/bharat.json`).
4. The root `deepseek-auth.json` is never directly clobbered during account management.

---

### Pillar 3: Compaction-Triggered Rotation

#### Objective
Re-balance hourly quota consumption across ready accounts during long-running tasks without violating session stickiness during active multi-turn interactions.

#### Scope & Operating Invariants
- Compaction occurs naturally when client context approaches limits (~1–2 times per 40-turn task).
- Compaction is a **quota-load-balancing** tool across hours, **not** an anti-burst velocity defense.
- **Scoping of Preferred Account**: `DEEPSEEK_PREFERRED_ACCOUNT` sets the operator's preference for **fresh session chats**. During compaction rotation, rotation is explicitly permitted across all ready accounts to prevent one account from absorbing 100% of a multi-hour session's workload.

#### Atomic Sequence & Call Site (`server.js:4616`)
At line 4616, incoming messages already contain the compaction summary. `now` is explicitly initialized locally (`const compactionNow = Date.now();`), eliminating ReferenceError risks:

```javascript
let compactionReset = null;
if (deltaMode && detectClientCompaction(messages, session)) {
    const compactionNow = Date.now();
    const targetAccountId = selectCompactionTargetAccount(session, compactionNow);
    compactionReset = performCompactionRotation(session, targetAccountId);
    const targetAccount = accounts.find(a => a && a.id === targetAccountId);
    const targetUsed = targetAccount ? usedSince(targetAccount, QUOTA_WINDOW_MS, compactionNow) : 0;
    const quotaDisplay = HOURLY_QUOTA > 0 ? `target used: ${targetUsed}/${HOURLY_QUOTA}/h` : `target used: ${targetUsed}/h (unmetered)`;
    console.log(`${agentTag} Client compaction detected (old chat ${compactionReset.failedSessionId} had ${compactionReset.failedMessageCount} msgs); rotated account ${compactionReset.oldAccountId} -> ${compactionReset.newAccountId} (${quotaDisplay}); seeding fresh chat.`);
}
```

#### Selection Algorithm & Fresh Budget Reset
`selectCompactionTargetAccount` selects the candidate account among all ready peers with the lowest utilization in the past hour via `usedSince(a, QUOTA_WINDOW_MS, now)`, tie-breaking on the oldest `lastUsedAt`. Healthy peers (`consecutiveFailures === 0`) are preferred when available to avoid rotating to a stricken peer.

When rotating to a new account, the new chat is a fresh conversation context and must receive a **fresh repair budget** (clearing `repairCount` and `repairHash`) so it is not prematurely capped due to prior failures on the old account:

```javascript
// Top-level, following selectFreshAccount (lines 1009-1044)
function selectCompactionTargetAccount(session, now = Date.now()) {
    let candidates = accounts.filter(a => a && a.id !== session.accountId && isAccountReady(a, now));
    if (candidates.length === 0) return session.accountId;

    // Prefer healthy peers (consecutiveFailures === 0) if available to avoid rotating to a stricken peer
    const healthy = candidates.filter(a => (a.consecutiveFailures || 0) === 0);
    if (healthy.length > 0) candidates = healthy;

    // Least-used in the past hour wins; tie-break on oldest lastUsedAt
    candidates.sort((a, b) => {
        const usedA = usedSince(a, QUOTA_WINDOW_MS, now);
        const usedB = usedSince(b, QUOTA_WINDOW_MS, now);
        if (usedA !== usedB) return usedA - usedB;
        return (a.lastUsedAt || 0) - (b.lastUsedAt || 0);
    });
    return candidates[0].id;
}

function performCompactionRotation(session, targetAccountId) {
    const oldAccountId = session.accountId;
    const failure = resetRemoteSession(session, false); // Clears session.id, parentMessageId, delta continuity (defer persist to end)
    delete failure.accountId;
    session.accountId = targetAccountId;
    // Fresh chat on fresh account gets a clean repair budget
    session.repairHash = null;
    session.repairAt = 0;
    session.repairCount = 0;
    persistSessions();
    return {
        ...failure,
        oldAccountId,
        newAccountId: targetAccountId,
    };
}
```

---

### Pillar 4: Lazy Piggybacked Ambient Telemetry

#### Objective
Ensure accounts exhibit regular browser route presence in DeepSeek internal logs via periodic reads of `/api/v0/users/current`, without adding request latency.

#### Choke Point Placement & Execution Ordering (`server.js:1846`)
Hooked at the single `askDeepSeekStream` choke point immediately after `selectAccountForSession(session, agentId)`. This covers 100% of upstream calls (fresh picks, sticky turns, and compaction rotations alike).

**Execution Order at Choke Point**:
1. `maybeTriggerAmbientTelemetry(account, askTurnStartedAt);` (fire-and-forget, non-blocking promise).
2. Delta pacing delay calculation and sleep gate (evaluated before incrementing `account.inflight`).

#### Permitted Headers & Literal Fallback
- All `Sec-Fetch-*` headers are omitted to prevent undici `TypeError`.
- Literal fallback for User-Agent prevents crashes on test or hand-built objects:
  ```javascript
  const DEFAULT_BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

  function buildTelemetryHeaders(account) {
      const headers = {
          'Authorization': `Bearer ${account.config.token}`,
          'Cookie': account.config.cookie,
          'User-Agent': account.headers?.['User-Agent'] || DEFAULT_BROWSER_UA,
          'Accept': 'application/json, text/plain, */*',
          'Referer': 'https://chat.deepseek.com/',
      };
      if (account.config.device_id) {
          headers['x-device-id'] = account.config.device_id;
      }
      return headers;
  }
  ```

#### Log-Only 401 Semantics & Account Initialization
- Upstream 401 on `/users/current` **never** calls `markAccountFailure`, **never** increments failure counters, and **never** triggers cooldown.
- Initialized in `loadDeepSeekConfig`:
  `lastTelemetryAt: 0`, `lastTelemetryStatus: null`.
- Surfaced safely in `accountStatus(account)` for `/health`:
  `last_telemetry_at: account.lastTelemetryAt || null`,
  `last_telemetry_status: account.lastTelemetryStatus || null`.

---

### Pillar 5: Turn-Aware Delta Pacing

#### Objective
Enforce human-like turnaround intervals between consecutive turns on an account without slowing down human developers or operations that already took significant execution time.

#### Signature-Driven Wiring & Input Threading
To resolve missing-variable reference issues, `askDeepSeekStream` accepts an explicit options parameter:

```javascript
async function askDeepSeekStream(
    prompt,
    agentId,
    model = 'deepseek-default',
    freshSessionPrompt = prompt,
    { isClientGone = () => false, requestStartedAt = Date.now(), isAgentLoop = false } = {}
)
```

At the HTTP handler call sites:
- **Turn 1 Initial Call (`server.js:4888`)**:
  `const isAgent = isAgentLoopTurn({ messages, agentId, compactionReset });`
  Passes `{ isClientGone: () => clientGone, requestStartedAt, isAgentLoop: isAgent }`.
- **Retries, Migrations & Continuations (`server.js:4910, 4933, 5097, 5144, 5218, 5303, 5325`)**:
  Passes `{ isClientGone: () => clientGone, requestStartedAt, isAgentLoop: true }`.

#### Hardened Turn Classifier & Decision Engine
```javascript
// Top-level, following telemetry helpers (lines 1083-1134)
function isAgentLoopTurn({ messages, agentId, compactionReset = null }) {
    // 1. Explicit title generation requests via shared title bucket helper
    if (isSharedTitleBucket(agentId) || isTitleGenerationRequest(messages)) {
        return true;
    }
    // 2. Compaction summary turns
    if (compactionReset !== null) {
        return true;
    }
    // 3. Tool result responses
    if (!Array.isArray(messages) || messages.length === 0) return true; // Fail closed to paced
    const lastMsg = messages[messages.length - 1];
    if (!lastMsg) return true;
    if (lastMsg.role === 'tool') return true;
    if (typeof lastMsg.content === 'string' && lastMsg.content.includes('[Tool Result]')) return true;

    // 4. User turn: only when role is 'user' and none of the above hold
    if (lastMsg.role === 'user') return false;

    // Fail closed for any unexpected role/format
    return true;
}
```

#### Delay Calculation, Jitter Math & Decision Resolution
- **Distribution**: Discrete uniform integer on $[0, \text{jitterMs}]$ inclusive: $\lfloor \text{rand}() \times (\text{jitterMs} + 1) \rfloor$.
- **Random Source**: Defaults to `Math.random`, injectable `rand` parameter for deterministic testing.
```javascript
function calculateRequiredDelay(elapsedMs, targetGapMs, jitterMs, rand = Math.random) {
    if (targetGapMs <= 0) return 0;
    const jitter = jitterMs > 0 ? Math.floor(rand() * (jitterMs + 1)) : 0;
    const target = targetGapMs + jitter;
    return Math.max(0, target - elapsedMs);
}

function resolvePacingAction({
    elapsedMs,
    targetGapMs = AGENT_TURN_GAP_MS,
    jitterMs = TURN_JITTER_MS,
    remainingMs,
    minUsableMs = MIN_USABLE_UPSTREAM_MS,
    rand = Math.random,
}) {
    if (targetGapMs <= 0) return { action: 'proceed', delayMs: 0 };
    const delayMs = calculateRequiredDelay(elapsedMs, targetGapMs, jitterMs, rand);
    if (delayMs <= 0) return { action: 'proceed', delayMs: 0 };

    if (remainingMs - delayMs < minUsableMs) {
        const waitSec = Math.max(1, Math.ceil(delayMs / 1000));
        const err = new Error(`Turn turnaround pacing delay (${delayMs}ms) exceeds usable upstream deadline (~${Math.floor(remainingMs)}ms remaining, ${minUsableMs}ms needed). Retry in ~${waitSec}s; chat preserved.`);
        err.status = 429;
        err.retryAfter = waitSec;
        err.type = 'rate_limit';
        err.isPacingReject = true;
        return { action: 'reject', delayMs, waitSec, error: err };
    }

    return { action: 'wait', delayMs };
}
```

#### Dispatch Stamping Semantics (`account.lastDispatchedAt`)
- **Stamping Site**: Scoped strictly to the `recordUpstreamTurn(account)` callsite at [`server.js:1917`](file:///home/swastik/FreeDeepseekAPI/server.js#L1916-L1918):
  ```javascript
  recordUpstreamTurn(account);
  account.lastDispatchedAt = Date.now();
  ```
  Pre-upstream failures (such as local PoW challenge network drops) do not stamp `lastDispatchedAt` because no completion was dispatched.
- **Elapsed Measurement**: `elapsed = account.lastDispatchedAt ? (now - account.lastDispatchedAt) : Infinity`.
- **Rotated / Idle Accounts**: If `account.lastDispatchedAt === 0`, `elapsed = Infinity` $\rightarrow$ `requiredDelay = 0ms`. Freshly rotated accounts incur 0ms delay.

#### Migration-Site Exemption (Zero Predicate Surgery)
The shared security predicate `isRateLimitError` remains completely untouched. The exemption is scoped exclusively to the call sites:

1. **In-place Retry Gate (`server.js:4905`)**:
   ```javascript
   shouldRetryInPlace({
       flagOn: RETRY_RATELIMIT,
       rateLimit: isRateLimitError(e) && !e?.isPacingReject,
       // ...
   })
   ```
2. **Rate Limit Migration Gate (`server.js:4932`)**:
   ```javascript
   if (!isRateLimitError(e) || e?.isPacingReject || rateLimitMigrated || clientGone || deadlineHit()) throw e;
   ```

#### Outer Catch Message & Retry-After Consistency (`server.js:5504`)
When pacing delay exceeds the usable deadline or expires during the pacing interval, it throws:
```javascript
const waitSec = Math.max(1, Math.ceil(delayMs / 1000));
const err = new Error(`Turn turnaround pacing delay (${delayMs}ms) exceeds usable upstream deadline (~${Math.floor(remainingMs)}ms remaining, ${MIN_USABLE_UPSTREAM_MS}ms needed). Retry in ~${waitSec}s; chat preserved.`);
err.status = 429;
err.retryAfter = waitSec;
err.type = 'rate_limit';
err.isPacingReject = true;
throw err;
```
In the outer HTTP error handler (`server.js:5504`):
1. **Header**: `status === 429 && e.retryAfter` parses `waitSec` via `parseRetryAfterMs(e.retryAfter)` $\rightarrow$ sets `headers['Retry-After'] = String(waitSec)`.
2. **Message**: `server.js:5504` is updated to exempt pacing rejects from `rateLimitExhaustedMessage`:
   ```javascript
   if (status !== 429 || e?.isPacingReject) return toClientErrorMessage(e.message);
   ```
This guarantees that both the JSON error message and the HTTP `Retry-After` header state the exact same `waitSec`, and the client is never falsely told that "all accounts reached rate limits".

---

## 3. Configuration Knobs & Defaults

All new knobs default to safe values (pacing on: 3s gap + 1s jitter on agent-loop turns only; telemetry off):

| Knob | Default | Validation / Clamp | Description |
|---|---|---|---|
| `DEEPSEEK_AGENT_TURN_GAP_MS` | `3000` (3s) | integer $\ge 0$ | Target minimum gap between consecutive agent loop turns on an account (`0` disables) |
| `DEEPSEEK_TURN_JITTER_MS` | `1000` (1s) | integer $\ge 0$ | Maximum uniform random jitter added to agent gap (uniform on $[0, \text{jitterMs}]$) |
| `DEEPSEEK_MIN_USABLE_UPSTREAM_MS` | `10000` (10s) | integer $\ge 1000$ | Minimum required time remaining before request deadline to permit pacing sleep |
| `DEEPSEEK_AMBIENT_TELEMETRY` | `0` (Off) | `0` or `1` | Enables background `/api/v0/users/current` telemetry pings |
| `DEEPSEEK_TELEMETRY_INTERVAL_MS` | `900000` (15m) | integer $\ge 60000$ | Minimum interval between ambient telemetry pings per account |

---

## 4. Test & Verification Plan

All tests are placed in [`tests/anti-suspension.test.js`](file:///home/swastik/FreeDeepseekAPI/tests/anti-suspension.test.js) and wired directly into `package.json` under `npm test`:

1. **Batching Directive & Metrics**:
   - Verify `formatToolDefinitions` string includes both batching and turn cap sentences without contradiction.
   - Assert `parseToolCalls` remains pure.
   - Test callsite metric tracking: simulating a 3-call emission increments `account.multiToolBatchCount` and updates `account.batchSizeCounts["3"]`.
2. **Device ID Staging & Validation**:
   - Verify regex rejects non-UUID strings (`"null"`, `"undefined"`, `"------------------------------------"`).
   - Verify regex accepts valid standard 8-4-4-4-12 UUIDs.
   - Verify snake_case persistence into account file.
3. **Compaction Rotation & Fresh Repair Budget**:
   - Explicit test: `compaction rotation gives fresh chat a clean repair budget without cross-account contamination`.
   - Unit test `performCompactionRotation`: verify `session.id` cleared, `session.accountId` updated, `session.repairCount = 0`, `session.repairHash = null`.
   - Unit test `selectCompactionTargetAccount`: verify least-used account is selected without crashing on `now`.
4. **Lazy Ambient Telemetry**:
   - Verify emitted headers contain NO forbidden `Sec-Fetch-*` keys.
   - Verify literal User-Agent fallback when account headers are absent.
   - Assert upstream `401 Unauthorized` updates `lastTelemetryStatus = 401` without incrementing `failures` or entering cooldown.
5. **Turn-Aware Delta Pacing & Migration Exemption**:
   - Classifier test: pure user message -> `false`; tool result, title request via `isSharedTitleBucket`, compaction turn -> `true`.
   - Delay calculation test: assert discrete uniform jitter on $[0, \text{jitterMs}]$ with injected `rand`.
   - Migration callsite exemption test: error with `isPacingReject === true` throws directly at line 4753 without invoking `performRateLimitMigration`.
   - Outer catch test: pacing 429 preserves `e.message` and emits matching `Retry-After` header.

---

## 5. Build & Implementation Order

1. **Pillar 2 path fix**: Snake_case `device_id` in `scripts/deepseek_chrome_auth.js` + strict RFC 4122 hex regex + Pillar 1 prompt diff with contradiction check + callsite metric.
2. **Pillar 3**: Compaction rotation with clean repair budget reset (`session.repairCount = 0`), least-used selection, and `compactionNow` fix.
3. **Pillar 4**: Lazy ambient telemetry at `askDeepSeekStream` choke point, permitted headers, literal UA fallback, 15s timeout, log-only 401.
4. **Pillar 5**: Turn-aware delta pacing with options-signature wiring, request-dispatch stamping (`lastDispatchedAt` at `recordUpstreamTurn`), callsite migration exemption, and outer catch message preservation.
5. **Test Suite Wiring**: Add `tests/anti-suspension.test.js` to `package.json`'s `npm test` script.
