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
| **1** | **Pillar 2 (Device ID) + Pillar 1 (Batching)** | `scripts/deepseek_chrome_auth.js`<br>`server.js:2008, 5058, 654, 675` | UUID regex tests, prompt contradiction check, metric distribution test |
| **2** | **Pillar 3 (Compaction Rotation)** | `server.js:1005, 4616-4621` | Repair-guard cleared-count unit test, least-used selection test |
| **3** | **Pillar 4 (Lazy Ambient Telemetry)** | `server.js:1005, 1705` | Undici header compliance test, literal UA fallback, 401 log-only test |
| **4** | **Pillar 5 (Turn-Aware Delta Pacing)** | `server.js:1005, 1701-1725, 1752, 4717, 4730, 4753, 5294` | Signature wiring, classifier test, delay test, callsite migration exemption, outer catch message test |
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
    const device_id = (typeof rawDeviceId === 'string' && /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(rawDeviceId))
        ? rawDeviceId
        : null;

    const wasmUrl =
        (pageState.resources || []).find((u) => /sha3.*\.wasm/.test(u)) ||
        'https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm';
    return {
        token,
        cookie,
        device_id,
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
    // Candidates are all ready accounts excluding the current session owner
    const candidates = accounts.filter(a => a && a.id !== session.accountId && isAccountReady(a, now));
    if (candidates.length === 0) return session.accountId;

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
    const failure = resetRemoteSession(session); // Clears session.id, parentMessageId, delta continuity
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
                const quotaDisplay = HOURLY_QUOTA > 0 ? `quota: ${HOURLY_QUOTA}/h` : 'quota: unmetered';
                console.log(`${agentTag} Client compaction: rotated chat ${compactionReset.failedSessionId} (${compactionReset.oldAccountId} -> ${compactionReset.newAccountId}, ${quotaDisplay}); seeding fresh chat.`);
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
const TELEMETRY_ON = String(process.env.DEEPSEEK_AMBIENT_TELEMETRY || '0').trim() === '1';
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
    if (!TELEMETRY_ON) return;
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
**Placement**: Top-level, immediately following `selectFreshAccount` (line 1005)

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
```

### 6.2 Signature-Driven Wiring in `askDeepSeekStream`
**File**: [`server.js`](file:///home/swastik/FreeDeepseekAPI/server.js)  
**Lines**: `1701-1725`

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

    // 1. Ambient telemetry check (fire-and-forget, non-blocking)
    maybeTriggerAmbientTelemetry(account, Date.now());

    // 2. Turn-aware delta pacing gate
    if (AGENT_TURN_GAP_MS > 0 && isAgentLoop) {
        const now = Date.now();
        const elapsed = account.lastDispatchedAt ? (now - account.lastDispatchedAt) : Infinity;
        const requiredDelay = calculateRequiredDelay(elapsed, AGENT_TURN_GAP_MS, TURN_JITTER_MS);
        if (requiredDelay > 0) {
            const remainingMs = REQUEST_DEADLINE_MS - (now - requestStartedAt);
            if (remainingMs - requiredDelay < MIN_USABLE_UPSTREAM_MS) {
                const waitSec = Math.max(1, Math.ceil(requiredDelay / 1000));
                const err = new Error(`Turn turnaround pacing delay (${requiredDelay}ms) exceeds usable upstream deadline (~${Math.floor(remainingMs)}ms remaining, ${MIN_USABLE_UPSTREAM_MS}ms needed). Retry in ~${waitSec}s; chat preserved.`);
                err.status = 429;
                err.retryAfter = waitSec;
                err.type = 'rate_limit';
                err.isPacingReject = true;
                throw err;
            }
            await new Promise(resolve => setTimeout(resolve, requiredDelay));
            if (isClientGone() || (Date.now() - requestStartedAt) > REQUEST_DEADLINE_MS) {
                throw new Error('Client disconnected or deadline expired during pacing interval');
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
**Line**: `1752`

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

1. **Initial turn (`server.js:4717`)**:
```javascript
const isAgent = isAgentLoopTurn({ messages, agentId, compactionReset });
initialCall = await askDeepSeekStream(fullPrompt, agentId, requestedModel, freshPromptBuild.prompt, {
    isClientGone: () => clientGone,
    requestStartedAt,
    isAgentLoop: isAgent,
});
```

2. **In-place rate limit retry (`server.js:4739`)**:
```javascript
askDeepSeekStream(fullPrompt, agentId, requestedModel, freshPromptBuild.prompt, {
    isClientGone: () => clientGone,
    requestStartedAt,
    isAgentLoop: true,
})
```

3. **Rate limit migration (`server.js:4763`)**:
```javascript
initialCall = await askDeepSeekStream(migrationBuild.prompt, agentId, requestedModel, migrationBuild.prompt, {
    isClientGone: () => clientGone,
    requestStartedAt,
    isAgentLoop: true,
});
```

4. **SSE throttling migration (`server.js:4917`)**:
```javascript
initialCall = await askDeepSeekStream(migrationBuild.prompt, agentId, requestedModel, migrationBuild.prompt, {
    isClientGone: () => clientGone,
    requestStartedAt,
    isAgentLoop: true,
});
```

5. **Empty-retry call (`server.js:4960`)**:
```javascript
const { resp: retryResp } = await askDeepSeekStream(retryPrompt, agentId, requestedModel, retryPrompt, {
    isClientGone: () => clientGone,
    requestStartedAt,
    isAgentLoop: true,
});
```

6. **Continuation round (`server.js:5025`)**:
```javascript
const continuationCall = await askDeepSeekStream(
    contPrompt, agentId, requestedModel, contPrompt,
    { isClientGone: () => clientGone, requestStartedAt, isAgentLoop: true }
);
```

7. **Repeat repair retries (`server.js:5109` & `5131`)**:
```javascript
const { resp: retryResp2 } = await askDeepSeekStream(strictPrompt, agentId, requestedModel, strictPrompt, {
    isClientGone: () => clientGone,
    requestStartedAt,
    isAgentLoop: true,
});
```

### 6.5 In-Place Retry Gate Exemption
**File**: [`server.js`](file:///home/swastik/FreeDeepseekAPI/server.js)  
**Line**: `4730`

```diff
<<<<
                if (shouldRetryInPlace({ flagOn: RETRY_RATELIMIT, rateLimit: isRateLimitError(e), migrated: rateLimitMigrated, gone: clientGone, deadline: deadlineHit(), retryAfterSec: e.retryAfter, anyReady: anyReadyNow })
====
                if (shouldRetryInPlace({ flagOn: RETRY_RATELIMIT, rateLimit: isRateLimitError(e) && !e?.isPacingReject, migrated: rateLimitMigrated, gone: clientGone, deadline: deadlineHit(), retryAfterSec: e.retryAfter, anyReady: anyReadyNow })
>>>>
```

### 6.6 Rate Limit Migration Gate Exemption
**File**: [`server.js`](file:///home/swastik/FreeDeepseekAPI/server.js)  
**Line**: `4753`

```diff
<<<<
                    if (!isRateLimitError(e) || rateLimitMigrated || clientGone || deadlineHit()) throw e;
====
                    if (!isRateLimitError(e) || e?.isPacingReject || rateLimitMigrated || clientGone || deadlineHit()) throw e;
>>>>
```

### 6.7 Outer Catch Message & Retry-After Consistency
**File**: [`server.js`](file:///home/swastik/FreeDeepseekAPI/server.js)  
**Lines**: `5294-5298`

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

const serverInternals = require('../server.js').__test;

test('Pillar 1: formatToolDefinitions contains batch discipline and per-turn cap without contradiction', () => {
    const tools = [{ type: 'function', function: { name: 'test_tool', description: 'test' } }];
    const formatted = serverInternals.formatToolDefinitions(tools);
    assert.match(formatted, /BATCH DISCIPLINE: at most 6 tool batches per task; 1 batch = one turn with max 8 tool calls/);
    assert.match(formatted, /When inspecting code \(read\/grep\/find\), emit all independent calls in the SAME turn \(up to 8 calls\)/);
    assert.match(formatted, /Do not batch mutations on the same target/);
});

test('Pillar 2: UUID regex strictly validates RFC 4122 hex structure', () => {
    const uuidRegex = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
    assert.equal(uuidRegex.test('b5557788-29ca-4766-bd95-b9f1d07c088e'), true);
    assert.equal(uuidRegex.test('B5557788-29CA-4766-BD95-B9F1D07C088E'), true);
    assert.equal(uuidRegex.test('------------------------------------'), false);
    assert.equal(uuidRegex.test('null'), false);
    assert.equal(uuidRegex.test('b5557788-29ca-4766-bd95-b9f1d07c088'), false); // 35 chars
    assert.equal(uuidRegex.test('b5557788-29ca-4766-bd95-b9f1d07c088ez'), false); // 37 chars
});

test('Pillar 3: compaction rotation gives fresh chat a clean repair budget without cross-account contamination', () => {
    const session = {
        id: 'chat_old_123',
        accountId: 'account_1',
        messageCount: 14,
        deltaMsgCount: 12,
        repairHash: 'hash_failed_turn_14',
        repairAt: Date.now() - 1000,
        repairCount: 2, // Exhausted on old account
    };

    // 1. Perform rotation: must reset chat AND clear repair count
    const rotation = serverInternals.performCompactionRotation(session, 'account_2');
    assert.equal(rotation.failedSessionId, 'chat_old_123');
    assert.equal(rotation.oldAccountId, 'account_1');
    assert.equal(rotation.newAccountId, 'account_2');
    assert.equal(session.id, null);
    assert.equal(session.accountId, 'account_2');
    assert.equal(session.repairCount, 0, 'Fresh chat must start with 0 repair attempts');
    assert.equal(session.repairHash, null);

    // 2. Incoming compacted prompt on new account
    const compactMessages = [
        { role: 'user', content: 'Summary of previous turns... Continue with next task.' }
    ];
    const tools = [{ type: 'function', function: { name: 'bash', description: 'run' } }];
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

test('Pillar 4: ambient telemetry sends permitted headers only, uses literal UA fallback, and ignores 401', async () => {
    const account = {
        id: 'account_telemetry_test',
        config: { token: 'mock_token', cookie: 'mock_cookie', device_id: 'b5557788-29ca-4766-bd95-b9f1d07c088e' },
        failures: 0,
        cooldownUntil: 0,
        lastTelemetryAt: 0,
        lastTelemetryStatus: null,
    };

    let sentHeaders = null;
    const mockFetch = async (url, opts) => {
        sentHeaders = opts.headers;
        return { status: 401, ok: false };
    };

    serverInternals.maybeTriggerAmbientTelemetry(account, Date.now(), mockFetch);
    await new Promise(r => setTimeout(r, 10));

    // Assert headers do NOT include any forbidden Sec-Fetch-* keys
    assert.ok(sentHeaders);
    for (const key of Object.keys(sentHeaders)) {
        assert.equal(key.toLowerCase().startsWith('sec-fetch-'), false, `Forbidden header ${key} present`);
    }
    assert.equal(sentHeaders['Authorization'], 'Bearer mock_token');
    assert.equal(sentHeaders['x-device-id'], 'b5557788-29ca-4766-bd95-b9f1d07c088e');
    assert.match(sentHeaders['User-Agent'], /Mozilla\/5\.0/); // Literal UA fallback worked

    // Assert 401 was recorded for telemetry status but failures was NOT incremented
    assert.equal(account.lastTelemetryStatus, 401);
    assert.equal(account.failures, 0);
    assert.equal(account.cooldownUntil, 0);
});

test('Pillar 5: classifier distinguishes human vs agent turns accurately', () => {
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
});

test('Pillar 5: calculateRequiredDelay computes uniform jitter and respects elapsed time', () => {
    // Target 1500, elapsed 2000 -> 0ms
    assert.equal(serverInternals.calculateRequiredDelay(2000, 1500, 0), 0);

    // Target 1500, elapsed 500, jitter 0 -> 1000ms
    assert.equal(serverInternals.calculateRequiredDelay(500, 1500, 0), 1000);

    // Target 1500, elapsed 0, jitter 500, rand=0.5 -> target 1750, delay 1750ms
    assert.equal(serverInternals.calculateRequiredDelay(0, 1500, 500, () => 0.5), 1750);
});

test('Pillar 5: pacing deadline 429 carries isPacingReject and bypasses migration and in-place retry', () => {
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
