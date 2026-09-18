# Implementation Specification — Anti-Suspension Architecture

Date: 2026-09-18.  
Status: READY FOR BUILD.  
Target Files:
- [`server.js`](file:///home/swastik/FreeDeepseekAPI/server.js)
- [`scripts/deepseek_chrome_auth.js`](file:///home/swastik/FreeDeepseekAPI/scripts/deepseek_chrome_auth.js)
- [`package.json`](file:///home/swastik/FreeDeepseekAPI/package.json)
- [`tests/anti-suspension.test.js`](file:///home/swastik/FreeDeepseekAPI/tests/anti-suspension.test.js) (New test suite in `tests/`)

---

## 1. Build Order & Phase Summary

| Step | Phase | Files | Verification |
|---|---|---|---|
| **1** | **Pillar 2 (Device ID) + Pillar 1 (Batching)** | `scripts/deepseek_chrome_auth.js`<br>`server.js:2132, 5231, 654, 693` | UUID regex tests, prompt contradiction check, metric distribution test |
| **2** | **Pillar 3 (Compaction Rotation)** | `server.js:1009-1044, 4725-4731` | Repair-guard cleared-count unit test, least-used selection test |
| **3** | **Pillar 4 (Lazy Ambient Telemetry)** | `server.js:1045-1082, 1846` | Undici header compliance test, literal UA fallback, 401 log-only test |
| **4** | **Pillar 5 (Turn-Aware Delta Pacing)** | `server.js:1083-1134, 1830-1878, 1916-1918, 4888, 4905, 4932, 5504` | Signature wiring, classifier test, delay test, callsite migration exemption, outer catch message test |
| **5** | **Test Suite Wiring** | `package.json:19`<br>`tests/anti-suspension.test.js` | Run full `npm test` verifying 245 existing tests + all new anti-suspension tests pass cleanly |

---

## 2. Pillar 1: Batching Directive Diff & Caller-Side Metrics

### 2.1 Prompt Diff in `formatToolDefinitions`
**File**: [`server.js`](file:///home/swastik/FreeDeepseekAPI/server.js)  
**Line**: `2008`

```diff
<<<<
    text += 'BATCH DISCIPLINE: at most 6 tool batches per task; 1 batch = one turn with max 8 tool calls. Plan multi-step work to fit: batch independent calls together, then answer from results. Do not re-batch the same calls and do not split one batch across turns.\n';
====
    text += 'BATCH DISCIPLINE: at most 6 tool batches per task; 1 batch = one turn with max 8 tool calls. When inspecting code (read/grep/find), emit all independent calls in the SAME turn (up to 8 calls); single-call turns are reserved for when a subsequent argument strictly depends on prior tool output. Do not batch mutations on the same target. Plan multi-step work to fit: batch independent calls together, then answer from results.\n';
>>>>
```

### 2.2 Account Object Initialization in `loadDeepSeekConfig`
**File**: [`server.js`](file:///home/swastik/FreeDeepseekAPI/server.js)  
**Line**: `654`

```diff
<<<<
            accounts.push({ id, file, config, headers: buildBaseHeaders(config), cooldownUntil: 0, failures: 0, consecutiveTimeouts: 0, consecutiveFailures: 0, lastFailureAt: 0, lastSuccessAt: 0, lastUsedAt: 0, inflight: 0, requestTimes: [], lastUpstreamAt: 0, ewmaLatencyMs: 0 });
====
            accounts.push({ id, file, config, headers: buildBaseHeaders(config), cooldownUntil: 0, failures: 0, consecutiveTimeouts: 0, consecutiveFailures: 0, lastFailureAt: 0, lastSuccessAt: 0, lastUsedAt: 0, inflight: 0, requestTimes: [], lastUpstreamAt: 0, ewmaLatencyMs: 0, lastTelemetryAt: 0, lastTelemetryStatus: null, lastDispatchedAt: 0, multiToolBatchCount: 0, batchSizeCounts: {} });
>>>>
```

### 2.3 Status Surfacing in `accountStatus`
**File**: [`server.js`](file:///home/swastik/FreeDeepseekAPI/server.js)  
**Lines**: `675-692`

```javascript
function accountStatus(account) {
    return {
        id: account.id,
        ready: !!(account.config.token && account.config.cookie),
        cooldown: account.cooldownUntil > Date.now(),
        cooldown_remaining_sec: Math.max(0, Math.ceil((account.cooldownUntil - Date.now()) / 1000)),
        failures: account.failures,
        consecutive_timeouts: account.consecutiveTimeouts || 0,
        consecutive_failures: account.consecutiveFailures || 0,
        used_this_hour: usedThisHour(account),
        quota_exhausted: HOURLY_QUOTA > 0 && !withinQuota(account),
        burst_used_1m: burstUsedThisMinute(account),
        has_device_id: Boolean(account.config.device_id),
        ewma_latency_ms: Math.round(Number(account.ewmaLatencyMs) || 0),
        inflight: Number(account.inflight) || 0,
        last_used_at: account.lastUsedAt || null,
        last_telemetry_at: account.lastTelemetryAt || null,
        last_telemetry_status: account.lastTelemetryStatus || null,
        last_dispatched_at: account.lastDispatchedAt || null,
        multi_tool_batches: account.multiToolBatchCount || 0,
        batch_size_distribution: account.batchSizeCounts || {},
    };
}
```

### 2.4 Callsite Metric Recording
**File**: [`server.js`](file:///home/swastik/FreeDeepseekAPI/server.js)  
**Lines**: `5058-5063`

```diff
<<<<
                const multiCalls = parseToolCalls(fullContent, { allowedToolNames });
                if (multiCalls && multiCalls.length > 0 && multiCalls.every(tc => allowedToolNames.has(tc.name))) {
                    console.log(`${agentTag} Model emitted ${multiCalls.length} valid tool call(s) in turn: ${multiCalls.map(tc => tc.name).join(', ')}`);
                    toolCall = multiCalls.length === 1 ? multiCalls[0] : multiCalls;
                } else {
====
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
                } else {
>>>>
```

---

## 3. Pillar 2: Account Device ID Capture & Staging (Option C)

### 3.1 CDP Extraction & RFC 4122 Validation in `readPageAuth`
**File**: [`scripts/deepseek_chrome_auth.js`](file:///home/swastik/FreeDeepseekAPI/scripts/deepseek_chrome_auth.js)  
**Lines**: `380-395`

```diff
<<<<
    const wasmUrl =
        (pageState.resources || []).find((u) => /sha3.*\.wasm/.test(u)) ||
        'https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm';
    return {
        token,
        cookie,
        hif_dliq,
        hif_leim,
        wasmUrl,
        baseUrl: 'https://chat.deepseek.com',
        href: pageState.href,
        cookiesCount: cookies.length,
    };
====
    const rawDeviceId = pageState.localStorage ? pageState.localStorage['deepseek-device-id:chat'] : null;
    const device_id = validateDeviceId(rawDeviceId);

    const wasmUrl =
        (pageState.resources || []).find((u) => /sha3.*\.wasm/.test(u)) ||
        'https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm';
    return {
        token,
        cookie,
        ...(device_id ? { device_id } : {}),
        hif_dliq,
        hif_leim,
        wasmUrl,
        baseUrl: 'https://chat.deepseek.com',
        href: pageState.href,
        cookiesCount: cookies.length,
    };
>>>>
```

*(Note: `persistAuthResult` at line 534 receives `auth` directly as `const { href, cookiesCount, ...persisted } = auth;`, so `device_id` in snake_case writes directly to disk without any intermediate renaming).*

---

## 4. Pillar 3: Compaction-Triggered Rotation

### 4.1 Rotation Helpers Implementation
**File**: [`server.js`](file:///home/swastik/FreeDeepseekAPI/server.js)  
**Placement**: Top-level, immediately following `selectFreshAccount` (line 1005)

```javascript
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

### 4.2 Compaction Call Site Update
**File**: [`server.js`](file:///home/swastik/FreeDeepseekAPI/server.js)  
**Lines**: `4616-4621`

```diff
<<<<
            let compactionReset = null;
            if (deltaMode && detectClientCompaction(messages, session)) {
                compactionReset = resetRemoteSession(session);
                console.log(`${agentTag} Client compaction detected (old chat ${compactionReset.failedSessionId} had ${compactionReset.failedMessageCount} msgs); starting fresh chat with tools + summary.`);
            }
====
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
>>>>
```

---

## 5. Pillar 4: Lazy Piggybacked Ambient Telemetry

### 5.1 Telemetry Logic & Permitted Headers
**File**: [`server.js`](file:///home/swastik/FreeDeepseekAPI/server.js)  
**Placement**: Top-level, immediately following `selectFreshAccount` (line 1005)

```javascript
const TELEMETRY_INTERVAL_MS = numEnv('DEEPSEEK_TELEMETRY_INTERVAL_MS', 900000, 60000); // 15m default, 1m min
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

function maybeTriggerAmbientTelemetry(account, now = Date.now(), fetchImpl = fetch) {
    if (!account?.config?.token) return;
    const isTelemetryOn = String(process.env.DEEPSEEK_AMBIENT_TELEMETRY || '0').trim() === '1';
    if (!isTelemetryOn && fetchImpl === fetch) return;
    if ((now - (account.lastTelemetryAt || 0)) < TELEMETRY_INTERVAL_MS) return;

    account.lastTelemetryAt = now;
    fetchImpl('https://chat.deepseek.com/api/v0/users/current', {
        method: 'GET',
        headers: buildTelemetryHeaders(account),
        signal: AbortSignal.timeout(15000),
    }).then(res => {
        account.lastTelemetryStatus = res.status;
        if (res.status === 401) {
            logDebug(`[telemetry:${account.id}] upstream returned 401 on /users/current`);
        }
    }).catch(err => {
        logDebug(`[telemetry:${account.id}] ping failed: ${err.message}`);
    });
}
```

---

## 6. Pillar 5: Turn-Aware Delta Pacing

### 6.1 Classifier & Calculation Helpers
**File**: [`server.js`](file:///home/swastik/FreeDeepseekAPI/server.js)  
**Placement**: Top-level, following telemetry helpers (lines 1083-1134)

```javascript
const AGENT_TURN_GAP_MS = numEnv('DEEPSEEK_AGENT_TURN_GAP_MS', 0, 0);
const TURN_JITTER_MS = numEnv('DEEPSEEK_TURN_JITTER_MS', 0, 0);
const MIN_USABLE_UPSTREAM_MS = numEnv('DEEPSEEK_MIN_USABLE_UPSTREAM_MS', 10000, 1000);

function isAgentLoopTurn({ messages, agentId, compactionReset = null }) {
    if (isSharedTitleBucket(agentId) || isTitleGenerationRequest(messages)) {
        return true;
    }
    if (compactionReset !== null) return true;

    if (!Array.isArray(messages) || messages.length === 0) return true; // Fail closed
    const lastMsg = messages[messages.length - 1];
    if (!lastMsg) return true;
    if (lastMsg.role === 'tool') return true;
    if (typeof lastMsg.content === 'string' && lastMsg.content.includes('[Tool Result]')) return true;

    if (lastMsg.role === 'user') return false; // Genuine human turn
    return true; // Fail closed for unknown shapes
}

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

### 6.2 Signature-Driven Wiring in `askDeepSeekStream`
**File**: [`server.js`](file:///home/swastik/FreeDeepseekAPI/server.js)  
**Lines**: `1830-1878`

```diff
<<<<
async function askDeepSeekStream(prompt, agentId, model = 'deepseek-default', freshSessionPrompt = prompt) {
    const modelCfg = resolveModelConfig(model);
    const session = getOrCreateAgentSession(agentId);
    const hadRemoteSession = Boolean(session.id);
    const account = selectAccountForSession(session, agentId);
    const dsHeaders = account.headers;
    account.lastUsedAt = Date.now();
    const askTurnStartedAt = Date.now();
    // Per-account load signal (brief §2): incremented when an upstream call
    // starts for this account, decremented in `finally` when it settles.
    // A leaked counter permanently blackholes the account under scoring, so
    // the finally below is load-bearing: it covers returns, throws, and the
    // catch-and-rethrow path alike.
    account.inflight = (Number(account.inflight) || 0) + 1;
====
async function askDeepSeekStream(
    prompt,
    agentId,
    model = 'deepseek-default',
    freshSessionPrompt = prompt,
    { isClientGone = () => false, requestStartedAt = Date.now(), isAgentLoop = false } = {}
) {
    const modelCfg = resolveModelConfig(model);
    const session = getOrCreateAgentSession(agentId);
    const hadRemoteSession = Boolean(session.id);
    const account = selectAccountForSession(session, agentId);
    const dsHeaders = account.headers;
    account.lastUsedAt = Date.now();
    const askTurnStartedAt = Date.now();

    // Ambient telemetry check (fire-and-forget, non-blocking)
    maybeTriggerAmbientTelemetry(account, askTurnStartedAt);

    // Turn-aware delta pacing gate (Pillar 5)
    if (AGENT_TURN_GAP_MS > 0 && isAgentLoop) {
        const now = Date.now();
        const elapsedMs = account.lastDispatchedAt ? (now - account.lastDispatchedAt) : Infinity;
        const remainingMs = REQUEST_DEADLINE_MS - (now - requestStartedAt);
        const pacing = resolvePacingAction({ elapsedMs, remainingMs });
        if (pacing.action === 'reject') {
            throw pacing.error;
        }
        if (pacing.action === 'wait' && pacing.delayMs > 0) {
            await new Promise(resolve => setTimeout(resolve, pacing.delayMs));
            if (isClientGone()) {
                throw new Error('Client disconnected during pacing interval');
            }
            if ((Date.now() - requestStartedAt) > REQUEST_DEADLINE_MS) {
                const err = new Error('Request deadline expired during pacing interval. Retry in ~1s; chat preserved.');
                err.status = 429;
                err.retryAfter = 1;
                err.type = 'rate_limit';
                err.isPacingReject = true;
                throw err;
            }
        }
    }

    // Per-account load signal (brief §2): incremented when an upstream call
    // starts for this account, decremented in `finally` when it settles.
    account.inflight = (Number(account.inflight) || 0) + 1;
>>>>
```

### 6.3 Request Dispatch Stamping at `recordUpstreamTurn`
**File**: [`server.js`](file:///home/swastik/FreeDeepseekAPI/server.js)  
**Lines**: `1916-1918`

```diff
<<<<
    recordUpstreamTurn(account);
====
    recordUpstreamTurn(account);
    account.lastDispatchedAt = Date.now();
>>>>
```

### 6.4 HTTP Handler Call Sites Input Threading
**File**: [`server.js`](file:///home/swastik/FreeDeepseekAPI/server.js)

1. **Initial turn (`server.js:4888`)**:
```javascript
const isAgent = isAgentLoopTurn({ messages, agentId, compactionReset });
initialCall = await askDeepSeekStream(fullPrompt, agentId, requestedModel, freshPromptBuild.prompt, {
    isClientGone: () => clientGone,
    requestStartedAt,
    isAgentLoop: isAgent,
});
```

2. **In-place rate limit retry (`server.js:4910`)**:
```javascript
askDeepSeekStream(fullPrompt, agentId, requestedModel, freshPromptBuild.prompt, {
    isClientGone: () => clientGone,
    requestStartedAt,
    isAgentLoop: true,
})
```

3. **Rate limit migration (`server.js:4933`)**:
```javascript
initialCall = await askDeepSeekStream(migrationBuild.prompt, agentId, requestedModel, migrationBuild.prompt, {
    isClientGone: () => clientGone,
    requestStartedAt,
    isAgentLoop: true,
});
```

4. **SSE throttling migration (`server.js:5097`)**:
```javascript
initialCall = await askDeepSeekStream(migrationBuild.prompt, agentId, requestedModel, migrationBuild.prompt, {
    isClientGone: () => clientGone,
    requestStartedAt,
    isAgentLoop: true,
});
```

5. **Empty-retry call (`server.js:5144`)**:
```javascript
const { resp: retryResp } = await askDeepSeekStream(retryPrompt, agentId, requestedModel, retryPrompt, {
    isClientGone: () => clientGone,
    requestStartedAt,
    isAgentLoop: true,
});
```

6. **Continuation round (`server.js:5218`)**:
```javascript
const continuationCall = await askDeepSeekStream(
    'continue',
    agentId,
    requestedModel,
    continuationRecoveryPrompt,
    {
        isClientGone: () => clientGone,
        requestStartedAt,
        isAgentLoop: true,
    }
);
```

7. **Repeat repair retries (`server.js:5303` & `5325`)**:
```javascript
// Attempt 1:
const { resp: retryResp2 } = await askDeepSeekStream(strictPrompt, agentId, requestedModel, strictPrompt, {
    isClientGone: () => clientGone,
    requestStartedAt,
    isAgentLoop: true,
});

// Attempt 2:
const { resp: retryResp3 } = await askDeepSeekStream(strictPrompt, agentId, requestedModel, strictPrompt, {
    isClientGone: () => clientGone,
    requestStartedAt,
    isAgentLoop: true,
});
```

### 6.5 In-Place Retry Gate Exemption
**File**: [`server.js`](file:///home/swastik/FreeDeepseekAPI/server.js)  
**Line**: `4905`

```diff
<<<<
                if (shouldRetryInPlace({ flagOn: RETRY_RATELIMIT, rateLimit: isRateLimitError(e), migrated: rateLimitMigrated, gone: clientGone, deadline: deadlineHit(), retryAfterSec: e.retryAfter, anyReady: anyReadyNow })
====
                if (shouldRetryInPlace({ flagOn: RETRY_RATELIMIT, rateLimit: isRateLimitError(e) && !e?.isPacingReject, migrated: rateLimitMigrated, gone: clientGone, deadline: deadlineHit(), retryAfterSec: e.retryAfter, anyReady: anyReadyNow })
>>>>
```

### 6.6 Rate Limit Migration Gate Exemption
**File**: [`server.js`](file:///home/swastik/FreeDeepseekAPI/server.js)  
**Line**: `4932`

```diff
<<<<
                    if (!isRateLimitError(e) || rateLimitMigrated || clientGone || deadlineHit()) throw e;
====
                    if (!isRateLimitError(e) || e?.isPacingReject || rateLimitMigrated || clientGone || deadlineHit()) throw e;
>>>>
```

### 6.7 Outer Catch Message & Retry-After Consistency
**File**: [`server.js`](file:///home/swastik/FreeDeepseekAPI/server.js)  
**Line**: `5504`

```diff
<<<<
                    if (status !== 429) return toClientErrorMessage(e.message);
                    const ms = parseRetryAfterMs(e.retryAfter);
                    if (ms == null) return toClientErrorMessage(e.message);
                    return rateLimitExhaustedMessage(Math.max(1, Math.ceil(ms / 1000)));
====
                    if (status !== 429 || e?.isPacingReject) return toClientErrorMessage(e.message);
                    const ms = parseRetryAfterMs(e.retryAfter);
                    if (ms == null) return toClientErrorMessage(e.message);
                    return rateLimitExhaustedMessage(Math.max(1, Math.ceil(ms / 1000)));
>>>>
```

---

## 7. Package.json Script & Test Suite Wiring

### 7.1 Script Wiring in `package.json`
**File**: [`package.json`](file:///home/swastik/FreeDeepseekAPI/package.json)  
**Line**: `19`

```diff
<<<<
    "test": "node --check server.js && node --check lib/pow.js && node --check scripts/auth.js && node --check scripts/auth_import.js && node --check scripts/doctor.js && node --check scripts/deepseek_chrome_auth.js && node --check scripts/probe-account.js && node --check scripts/probe_deepseek_models.js && node --check client.js && node --check scripts/live_agentic_smoke_tests.mjs && node --test tests/unit.test.js",
====
    "test": "node --check server.js && node --check lib/pow.js && node --check scripts/auth.js && node --check scripts/auth_import.js && node --check scripts/doctor.js && node --check scripts/deepseek_chrome_auth.js && node --check scripts/probe-account.js && node --check scripts/probe_deepseek_models.js && node --check client.js && node --check scripts/live_agentic_smoke_tests.mjs && node --test tests/unit.test.js && node --test tests/anti-suspension.test.js",
>>>>
```

### 7.2 Verbatim Test File
**File**: [`tests/anti-suspension.test.js`](file:///home/swastik/FreeDeepseekAPI/tests/anti-suspension.test.js)

```javascript
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const serverInternals = require('../server.js').__test;
const { validateDeviceId, persistAuthResult, readPageAuth } = require('../scripts/deepseek_chrome_auth.js');

test('Batch 1 (Pillar 1): formatToolDefinitions contains batch discipline and per-turn cap without contradiction', () => {
    const tools = [{ type: 'function', function: { name: 'read_file', description: 'read' } }];
    const formatted = serverInternals.formatToolDefinitions(tools);
    assert.match(formatted, /BATCH DISCIPLINE: at most 6 tool batches per task; 1 batch = one turn with max 8 tool calls/);
    assert.match(formatted, /When inspecting code \(read\/grep\/find\), emit all independent calls in the SAME turn \(up to 8 calls\)/);
    assert.match(formatted, /Do not batch mutations on the same target/);
});

test('Batch 1 (Pillar 1): parseToolCalls remains pure and account-agnostic', () => {
    const rawContent = '{"tool_call":{"name":"read_file","arguments":{"path":"a.txt"}}}\n{"tool_call":{"name":"read_file","arguments":{"path":"b.txt"}}}';
    const calls = serverInternals.parseToolCalls(rawContent, { allowedToolNames: new Set(['read_file']) });
    assert.equal(Array.isArray(calls), true);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].name, 'read_file');
    assert.equal(calls[1].name, 'read_file');
});

test('Batch 1 (Pillar 1): accountStatus exposes multi_tool_batches and batch_size_distribution', () => {
    const mockAccount = {
        id: 'account_batch_test',
        config: { token: 't', cookie: 'c' },
        cooldownUntil: 0,
        failures: 0,
        multiToolBatchCount: 3,
        batchSizeCounts: { '2': 2, '4': 1 },
    };
    const status = serverInternals.accountStatus(mockAccount);
    assert.equal(status.multi_tool_batches, 3);
    assert.deepEqual(status.batch_size_distribution, { '2': 2, '4': 1 });
});

test('Batch 1 (Pillar 2): validateDeviceId strictly validates RFC 4122 hex structure', () => {
    assert.equal(validateDeviceId('b5557788-29ca-4766-bd95-b9f1d07c088e'), 'b5557788-29ca-4766-bd95-b9f1d07c088e');
    assert.equal(validateDeviceId('B5557788-29CA-4766-BD95-B9F1D07C088E'), 'B5557788-29CA-4766-BD95-B9F1D07C088E');
    assert.equal(validateDeviceId('------------------------------------'), null);
    assert.equal(validateDeviceId('null'), null);
    assert.equal(validateDeviceId(null), null);
    assert.equal(validateDeviceId(undefined), null);
    assert.equal(validateDeviceId('b5557788-29ca-4766-bd95-b9f1d07c088'), null); // 35 chars
    assert.equal(validateDeviceId('b5557788-29ca-4766-bd95-b9f1d07c088ez'), null); // 37 chars
});

test('Batch 1 (Pillar 2 follow-up): readPageAuth omits device_id when missing/invalid and includes when valid', async () => {
    function mockCdp(rawDeviceId) {
        return {
            events: [
                {
                    params: {
                        request: {
                            url: 'https://chat.deepseek.com/api/v0/chat/completion',
                            headers: {
                                authorization: 'Bearer header_bearer_token',
                                'x-hif-dliq': 'dliq_val',
                                'x-hif-leim': 'leim_val',
                            },
                        },
                    },
                },
            ],
            send: async (method) => {
                if (method === 'Runtime.evaluate') {
                    return {
                        result: {
                            value: {
                                localStorage: {
                                    userToken: 'store_token',
                                    ...(rawDeviceId !== undefined ? { 'deepseek-device-id:chat': rawDeviceId } : {}),
                                },
                                sessionStorage: {},
                                resources: ['https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm'],
                                href: 'https://chat.deepseek.com',
                            },
                        },
                    };
                }
                if (method === 'Network.getAllCookies') {
                    return {
                        cookies: [
                            { name: 'ds_session', value: 'cookie_val', domain: '.deepseek.com' },
                        ],
                    };
                }
                return {};
            },
        };
    }

    // 1. Missing in localStorage -> omitted, token/cookie extracted
    const authMissing = await readPageAuth(mockCdp(undefined));
    assert.equal('device_id' in authMissing, false);
    assert.equal(authMissing.token, 'header_bearer_token');
    assert.equal(authMissing.cookie, 'ds_session=cookie_val');
    assert.equal(authMissing.hif_dliq, 'dliq_val');
    assert.equal(authMissing.hif_leim, 'leim_val');

    // 2. Invalid string in localStorage -> omitted
    const authInvalid = await readPageAuth(mockCdp('invalid-not-uuid'));
    assert.equal('device_id' in authInvalid, false);

    // 3. Valid RFC 4122 UUID -> included
    const validUuid = 'b5557788-29ca-4766-bd95-b9f1d07c088e';
    const authValid = await readPageAuth(mockCdp(validUuid));
    assert.equal('device_id' in authValid, true);
    assert.equal(authValid.device_id, validUuid);
});

test('Batch 1 (Pillar 2 follow-up): persistAuthResult merges existing device_id if newly captured auth lacks one', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-susp-auth-'));
    const authPath = path.join(tmpDir, 'test-auth.json');
    try {
        const uuid1 = '11111111-1111-4111-8111-111111111111';
        const uuid2 = '22222222-2222-4222-8222-222222222222';

        // 1. Fresh write with device_id
        const res1 = persistAuthResult(authPath, { token: 'tok1', cookie: 'c1', device_id: uuid1 });
        assert.equal(res1.device_id, uuid1);
        const onDisk1 = JSON.parse(fs.readFileSync(authPath, 'utf8'));
        assert.equal(onDisk1.device_id, uuid1);

        // 2. Renewal without device_id preserves existing valid device_id
        const res2 = persistAuthResult(authPath, { token: 'tok2', cookie: 'c2' });
        assert.equal(res2.device_id, uuid1);
        const onDisk2 = JSON.parse(fs.readFileSync(authPath, 'utf8'));
        assert.equal(onDisk2.device_id, uuid1);
        assert.equal(onDisk2.token, 'tok2');

        // 3. Renewal with new valid device_id updates it
        const res3 = persistAuthResult(authPath, { token: 'tok3', cookie: 'c3', device_id: uuid2 });
        assert.equal(res3.device_id, uuid2);
        const onDisk3 = JSON.parse(fs.readFileSync(authPath, 'utf8'));
        assert.equal(onDisk3.device_id, uuid2);

        // 4. If incoming has invalid device_id but existing has valid device_id, preserves valid existing
        const res4 = persistAuthResult(authPath, { token: 'tok4', cookie: 'c4', device_id: 'bad-incoming-id' });
        assert.equal(res4.device_id, uuid2);
        const onDisk4 = JSON.parse(fs.readFileSync(authPath, 'utf8'));
        assert.equal(onDisk4.device_id, uuid2);

        // 5. If existing file had corrupted device_id and incoming is invalid, strips corrupted value
        fs.writeFileSync(authPath, JSON.stringify({ token: 'tok5', cookie: 'c5', device_id: 'bad-device-id' }));
        const res5 = persistAuthResult(authPath, { token: 'tok6', cookie: 'c6', device_id: 'also-bad' });
        assert.equal('device_id' in res5, false);
        const onDisk5 = JSON.parse(fs.readFileSync(authPath, 'utf8'));
        assert.equal('device_id' in onDisk5, false);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('Batch 2 (Pillar 3): performCompactionRotation resets remote session and gives fresh repair budget', () => {
    const initialHistory = [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'hi' }];
    const session = {
        id: 'chat_old_123',
        accountId: 'account_1',
        parentMessageId: 'parent_msg_123',
        createdAt: 1700000000000,
        messageCount: 14,
        deltaMsgCount: 12,
        deltaBoundary: 'bound',
        deltaPrefixHash: 'prefix_hash_abc',
        deltaToolNames: 'tool1,tool2',
        repairHash: 'hash_failed_turn_14',
        repairAt: Date.now() - 1000,
        repairCount: 2, // Exhausted on old account
        history: initialHistory.slice(),
    };

    const rotation = serverInternals.performCompactionRotation(session, 'account_2');
    assert.equal(rotation.failedSessionId, 'chat_old_123');
    assert.equal(rotation.failedMessageCount, 14);
    assert.equal(rotation.oldAccountId, 'account_1');
    assert.equal(rotation.newAccountId, 'account_2');
    assert.equal('accountId' in rotation, false); // Low 3: no redundant accountId alongside oldAccountId

    assert.equal(session.id, null);
    assert.equal(session.parentMessageId, null);
    assert.equal(session.createdAt, null);
    assert.equal(session.accountId, 'account_2');
    assert.equal(session.messageCount, 0);
    assert.equal(session.deltaMsgCount, 0);
    assert.equal(session.deltaBoundary, null);
    assert.equal(session.deltaPrefixHash, null);
    assert.equal(session.deltaToolNames, null);

    // Fresh chat on new account must have clean repair budget
    assert.equal(session.repairCount, 0);
    assert.equal(session.repairHash, null);
    assert.equal(session.repairAt, 0);

    // Local recovery history is preserved across compaction rotation per design
    assert.deepEqual(session.history, initialHistory);
});

test('Batch 2 (Pillar 3): selectCompactionTargetAccount picks least-used ready peer and tie-breaks on lastUsedAt', () => {
    const origAccounts = serverInternals.accounts.slice();
    try {
        const now = Date.now();
        const acct1 = { id: 'acct_1', config: { token: 't1', cookie: 'c1' }, cooldownUntil: 0, failures: 0, consecutiveFailures: 0, requestTimes: [now - 10000], lastUsedAt: now - 10000 };
        const acct2 = { id: 'acct_2', config: { token: 't2', cookie: 'c2' }, cooldownUntil: 0, failures: 0, consecutiveFailures: 0, requestTimes: [now - 20000, now - 15000], lastUsedAt: now - 15000 };
        const acct3 = { id: 'acct_3', config: { token: 't3', cookie: 'c3' }, cooldownUntil: 0, failures: 0, consecutiveFailures: 0, requestTimes: [], lastUsedAt: now - 50000 };
        const acctCooling = { id: 'acct_cool', config: { token: 'tc', cookie: 'cc' }, cooldownUntil: now + 30000, failures: 1, consecutiveFailures: 2, requestTimes: [], lastUsedAt: now - 60000 };

        serverInternals.accounts.length = 0;
        serverInternals.accounts.push(acct1, acct2, acct3, acctCooling);

        // Rotating from acct_1: acct3 has 0 turns used in past hour -> least-used wins
        const session1 = { accountId: 'acct_1' };
        assert.equal(serverInternals.selectCompactionTargetAccount(session1, now), 'acct_3');

        // Rotating from acct_3: acct1 has 1 turn used, acct2 has 2 turns used -> acct1 wins
        const session3 = { accountId: 'acct_3' };
        assert.equal(serverInternals.selectCompactionTargetAccount(session3, now), 'acct_1');

        // When only cooling peers are available, stays on current account
        serverInternals.accounts.length = 0;
        serverInternals.accounts.push(acct1, acctCooling);
        assert.equal(serverInternals.selectCompactionTargetAccount(session1, now), 'acct_1');

        // Low 1: Tie-break on oldest lastUsedAt when usedSince counts are equal
        const acctTie1 = { id: 'acct_tie1', config: { token: 't1', cookie: 'c1' }, cooldownUntil: 0, failures: 0, consecutiveFailures: 0, requestTimes: [now - 1000], lastUsedAt: now - 1000 };
        const acctTie2 = { id: 'acct_tie2', config: { token: 't2', cookie: 'c2' }, cooldownUntil: 0, failures: 0, consecutiveFailures: 0, requestTimes: [now - 2000], lastUsedAt: now - 5000 };
        serverInternals.accounts.length = 0;
        serverInternals.accounts.push(acct1, acctTie1, acctTie2);
        // Both have usedSince = 1 in the window; acctTie2 has older lastUsedAt (now - 5000 < now - 1000)
        assert.equal(serverInternals.selectCompactionTargetAccount(session1, now), 'acct_tie2');

        // Finding 1 / (d): Scorer health awareness — 0-strike peer with higher usage beats 1-strike peer with 0 usage
        const acctClean = { id: 'acct_clean', config: { token: 'tc', cookie: 'cc' }, cooldownUntil: 0, failures: 0, consecutiveFailures: 0, requestTimes: [now - 1000, now - 2000], lastUsedAt: now - 1000 };
        const acctStrike = { id: 'acct_strike', config: { token: 'ts', cookie: 'cs' }, cooldownUntil: 0, failures: 1, consecutiveFailures: 1, requestTimes: [], lastUsedAt: now - 90000 };
        serverInternals.accounts.length = 0;
        serverInternals.accounts.push(acct1, acctClean, acctStrike);
        assert.equal(serverInternals.selectCompactionTargetAccount(session1, now), 'acct_clean');
    } finally {
        serverInternals.accounts.length = 0;
        serverInternals.accounts.push(...origAccounts);
    }
});

test('Batch 2 (Pillar 3): repair budget lifecycle across compaction rotation avoids cross-account contamination', () => {
    const session = {
        id: 'chat_old_456',
        accountId: 'account_old',
        messageCount: 10,
        deltaMsgCount: 10,
        repairHash: 'old_repair_hash',
        repairAt: Date.now() - 500,
        repairCount: 2, // Was capped on the old chat
    };

    // 1. Rotate to new account
    serverInternals.performCompactionRotation(session, 'account_new');
    assert.equal(session.repairCount, 0);
    assert.equal(session.repairHash, null);

    // 2. Incoming compacted prompt arrived
    const compactMessages = [
        { role: 'user', content: 'Compacted context summary...' }
    ];
    const tools = [{ type: 'function', function: { name: 'edit_file', description: 'edit' } }];
    const newTurnHash = serverInternals.repairTurnHash(compactMessages, tools);

    // 3. First attempt on fresh chat: repeat is false, capped is false
    const attempt1 = serverInternals.classifyRepairAttempt(session, newTurnHash);
    assert.equal(attempt1.repeat, false);
    assert.equal(attempt1.capped, false);

    // 4. Record first failure on fresh chat
    serverInternals.recordRepairAttempt(session, newTurnHash);
    assert.equal(session.repairHash, newTurnHash);
    assert.equal(session.repairCount, 1);

    // 5. First retry on fresh chat: repeat is true, capped is false
    const attempt2 = serverInternals.classifyRepairAttempt(session, newTurnHash);
    assert.equal(attempt2.repeat, true);
    assert.equal(attempt2.capped, false);

    // 6. Record second failure on fresh chat
    serverInternals.recordRepairAttempt(session, newTurnHash);
    assert.equal(session.repairCount, 2);

    // 7. Second retry: capped is true
    const attempt3 = serverInternals.classifyRepairAttempt(session, newTurnHash);
    assert.equal(attempt3.repeat, true);
    assert.equal(attempt3.capped, true);
});

test('Batch 3 (Pillar 4): ambient telemetry sends permitted headers only, uses literal UA fallback, and ignores 401', async () => {
    const account = {
        id: 'account_telemetry_test',
        config: { token: 'mock_token', cookie: 'mock_cookie', device_id: 'b5557788-29ca-4766-bd95-b9f1d07c088e' },
        failures: 0,
        cooldownUntil: 0,
        lastTelemetryAt: 0,
        lastTelemetryStatus: null,
    };

    let sentHeaders = null;
    let requestedUrl = null;
    const mockFetch = async (url, opts) => {
        requestedUrl = url;
        sentHeaders = opts.headers;
        return { status: 401, ok: false };
    };

    serverInternals.maybeTriggerAmbientTelemetry(account, Date.now(), mockFetch);
    await new Promise(r => setTimeout(r, 20));

    // Assert requested URL
    assert.equal(requestedUrl, 'https://chat.deepseek.com/api/v0/users/current');

    // Assert headers do NOT include any forbidden Sec-Fetch-* keys
    assert.ok(sentHeaders);
    for (const key of Object.keys(sentHeaders)) {
        assert.equal(key.toLowerCase().startsWith('sec-fetch-'), false, `Forbidden header ${key} present`);
    }
    assert.equal(sentHeaders['Authorization'], 'Bearer mock_token');
    assert.equal(sentHeaders['Cookie'], 'mock_cookie');
    assert.equal(sentHeaders['x-device-id'], 'b5557788-29ca-4766-bd95-b9f1d07c088e');
    assert.equal(sentHeaders['Referer'], 'https://chat.deepseek.com/');
    assert.equal(sentHeaders['Accept'], 'application/json, text/plain, */*');
    assert.match(sentHeaders['User-Agent'], /Mozilla\/5\.0/); // Literal UA fallback worked

    // Assert 401 was recorded for telemetry status but failures was NOT incremented
    assert.equal(account.lastTelemetryStatus, 401);
    assert.equal(account.failures, 0);
    assert.equal(account.cooldownUntil, 0);
});

test('Batch 3 (Pillar 4): ambient telemetry throttling respects TELEMETRY_INTERVAL_MS', async () => {
    const account = {
        id: 'account_telemetry_throttle',
        config: { token: 'mock_token', cookie: 'mock_cookie' },
        failures: 0,
        cooldownUntil: 0,
        lastTelemetryAt: 0,
        lastTelemetryStatus: null,
    };

    let fetchCount = 0;
    const mockFetch = async () => {
        fetchCount++;
        return { status: 200, ok: true };
    };

    const t0 = 1000000;
    serverInternals.maybeTriggerAmbientTelemetry(account, t0, mockFetch);
    await new Promise(r => setTimeout(r, 10));
    assert.equal(fetchCount, 1);
    assert.equal(account.lastTelemetryAt, t0);
    assert.equal(account.lastTelemetryStatus, 200);

    const interval = serverInternals.TELEMETRY_INTERVAL_MS;
    // Call again within the throttle window (e.g. half interval) -> throttled, no fetch
    serverInternals.maybeTriggerAmbientTelemetry(account, t0 + Math.floor(interval / 2), mockFetch);
    await new Promise(r => setTimeout(r, 10));
    assert.equal(fetchCount, 1); // Not incremented

    // Call after throttle window -> triggers next ping
    serverInternals.maybeTriggerAmbientTelemetry(account, t0 + interval + 1, mockFetch);
    await new Promise(r => setTimeout(r, 10));
    assert.equal(fetchCount, 2);
    assert.equal(account.lastTelemetryAt, t0 + interval + 1);
});

test('Batch 3 (Pillar 4 follow-up): buildTelemetryHeaders honors custom User-Agent and falls back to default', () => {
    const acctCustom = {
        config: { token: 'tok_cust', cookie: 'cookie_cust' },
        headers: { 'User-Agent': 'CustomBrowser/1.0' },
    };
    const headersCustom = serverInternals.buildTelemetryHeaders(acctCustom);
    assert.equal(headersCustom['User-Agent'], 'CustomBrowser/1.0');

    const acctDefault = {
        config: { token: 'tok_def', cookie: 'cookie_def' },
    };
    const headersDefault = serverInternals.buildTelemetryHeaders(acctDefault);
    assert.match(headersDefault['User-Agent'], /^Mozilla\/5\.0/);
});

test('Batch 3 (Pillar 4): accountStatus surfaces telemetry timestamp and status', () => {
    const mockAccount = {
        id: 'account_status_telemetry',
        config: { token: 't', cookie: 'c' },
        cooldownUntil: 0,
        failures: 0,
        lastTelemetryAt: 1700000000000,
        lastTelemetryStatus: 200,
    };
    const status = serverInternals.accountStatus(mockAccount);
    assert.equal(status.last_telemetry_at, 1700000000000);
    assert.equal(status.last_telemetry_status, 200);
});

test('Batch 4 (Pillar 5): isAgentLoopTurn correctly distinguishes human vs agent loop turns and fails closed', () => {
    // Pure user turn -> not an agent turn
    assert.equal(serverInternals.isAgentLoopTurn({ messages: [{ role: 'user', content: 'hello' }], agentId: 'main' }), false);

    // Tool result turn -> agent turn
    assert.equal(serverInternals.isAgentLoopTurn({ messages: [{ role: 'tool', content: 'output' }], agentId: 'main' }), true);
    assert.equal(serverInternals.isAgentLoopTurn({ messages: [{ role: 'user', content: '[Tool Result]\noutput' }], agentId: 'main' }), true);

    // Title request -> agent turn
    assert.equal(serverInternals.isAgentLoopTurn({ messages: [{ role: 'user', content: 'Generate a title for this conversation:' }], agentId: 'main' }), true);
    assert.equal(serverInternals.isAgentLoopTurn({ messages: [{ role: 'user', content: 'hello' }], agentId: 'dev-agent:title' }), true);

    // Compaction summary turn -> agent turn
    assert.equal(serverInternals.isAgentLoopTurn({ messages: [{ role: 'user', content: 'hello' }], agentId: 'main', compactionReset: {} }), true);

    // Empty or non-array -> fails closed (agent turn)
    assert.equal(serverInternals.isAgentLoopTurn({ messages: [], agentId: 'main' }), true);
    assert.equal(serverInternals.isAgentLoopTurn({ messages: null, agentId: 'main' }), true);
    assert.equal(serverInternals.isAgentLoopTurn({ messages: [{ role: 'assistant', content: 'hi' }], agentId: 'main' }), true);
});

test('Batch 4 (Pillar 5): calculateRequiredDelay computes uniform jitter and respects elapsed time', () => {
    // Target 1500, elapsed 2000 -> 0ms
    assert.equal(serverInternals.calculateRequiredDelay(2000, 1500, 0), 0);

    // Target 1500, elapsed 500, jitter 0 -> 1000ms
    assert.equal(serverInternals.calculateRequiredDelay(500, 1500, 0), 1000);

    // Target <= 0 -> 0ms
    assert.equal(serverInternals.calculateRequiredDelay(500, 0, 500), 0);

    // Target 1500, elapsed 0, jitter 500, rand=0.5 -> target 1750, delay 1750ms
    assert.equal(serverInternals.calculateRequiredDelay(0, 1500, 500, () => 0.5), 1750);
});

test('Batch 4 (Pillar 5): resolvePacingAction evaluates proceed, wait, and reject decisions', () => {
    // 1. Target gap <= 0 -> proceed immediately
    assert.deepEqual(serverInternals.resolvePacingAction({ elapsedMs: 500, targetGapMs: 0, jitterMs: 0, remainingMs: 60000, minUsableMs: 10000 }), { action: 'proceed', delayMs: 0 });

    // 2. Elapsed >= target -> proceed immediately
    assert.deepEqual(serverInternals.resolvePacingAction({ elapsedMs: 3000, targetGapMs: 2000, jitterMs: 0, remainingMs: 60000, minUsableMs: 10000 }), { action: 'proceed', delayMs: 0 });

    // 3. Sufficient remaining deadline -> wait
    const waitDecision = serverInternals.resolvePacingAction({ elapsedMs: 500, targetGapMs: 2000, jitterMs: 0, remainingMs: 60000, minUsableMs: 10000 });
    assert.equal(waitDecision.action, 'wait');
    assert.equal(waitDecision.delayMs, 1500);

    // 4. Insufficient remaining deadline (remaining - delay < minUsable) -> reject with typed 429
    const rejectDecision = serverInternals.resolvePacingAction({ elapsedMs: 500, targetGapMs: 3000, jitterMs: 0, remainingMs: 12000, minUsableMs: 10000 });
    assert.equal(rejectDecision.action, 'reject');
    assert.equal(rejectDecision.delayMs, 2500);
    assert.equal(rejectDecision.waitSec, 3);
    assert.ok(rejectDecision.error instanceof Error);
    assert.equal(rejectDecision.error.status, 429);
    assert.equal(rejectDecision.error.retryAfter, 3);
    assert.equal(rejectDecision.error.type, 'rate_limit');
    assert.equal(rejectDecision.error.isPacingReject, true);
    assert.match(rejectDecision.error.message, /Turn turnaround pacing delay \(2500ms\) exceeds usable upstream deadline/);
    assert.match(rejectDecision.error.message, /chat preserved/);
});

test('Batch 4 (Pillar 5): askDeepSeekStream pacing gate throws 429 reject before inflight++ when gap > 0', () => {
    const { execFileSync } = require('node:child_process');
    const childCode = `
        const assert = require('node:assert/strict');
        const serverInternals = require('./server.js').__test;
        const mockAccount = {
            id: 'acct_pacing_gate_test',
            file: 'test.json',
            config: { token: 't', cookie: 'c' },
            headers: { 'Authorization': 'Bearer t' },
            cooldownUntil: 0,
            failures: 0,
            inflight: 0,
            lastDispatchedAt: Date.now() - 1000,
        };
        serverInternals.accounts.length = 0;
        serverInternals.accounts.push(mockAccount);

        async function run() {
            try {
                await serverInternals.askDeepSeekStream('prompt', 'test_pacing_agent', 'deepseek-chat', 'prompt', {
                    isClientGone: () => false,
                    requestStartedAt: Date.now() - 118000, // 2s remaining
                    isAgentLoop: true,
                });
                assert.fail('Should have thrown pacing reject');
            } catch (err) {
                assert.equal(err.status, 429);
                assert.equal(err.isPacingReject, true);
                assert.equal(mockAccount.inflight, 0, 'inflight counter must not be incremented on pacing reject');
            }
        }
        run();
    `;
    execFileSync(process.execPath, ['-e', childCode], {
        env: { ...process.env, DEEPSEEK_AGENT_TURN_GAP_MS: '5000' },
    });
});

test('Batch 4 (Pillar 5): pacing deadline 429 carries isPacingReject and bypasses migration and in-place retry', () => {
    const pacingError = new Error('Turn turnaround pacing delay exceeds usable upstream deadline');
    pacingError.status = 429;
    pacingError.retryAfter = 2;
    pacingError.type = 'rate_limit';
    pacingError.isPacingReject = true;

    // 1. isRateLimitError predicate itself remains unchanged and detects 429
    assert.equal(serverInternals.isRateLimitError(pacingError), true);

    // 2. In-place retry check must be bypassed via && !e.isPacingReject
    const retryCheck = serverInternals.shouldRetryInPlace({
        flagOn: true,
        rateLimit: serverInternals.isRateLimitError(pacingError) && !pacingError.isPacingReject,
        migrated: false,
        gone: false,
        deadline: false,
        retryAfterSec: pacingError.retryAfter,
        anyReady: true,
    });
    assert.equal(retryCheck, false);

    // 3. Migration gate condition: if (!isRateLimitError(e) || e.isPacingReject || ...) throw e;
    const shouldThrowDirectly = !serverInternals.isRateLimitError(pacingError) || pacingError.isPacingReject;
    assert.equal(shouldThrowDirectly, true);
});
```
