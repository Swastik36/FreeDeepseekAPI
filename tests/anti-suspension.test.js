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

test('M-C: isRetryAccountEligible scopes in-place retry to account quota and burst state', () => {
    const validConfig = { token: 'valid-token', cookie: 'valid-cookie' };
    const now = Date.now();
    const readyAccount = {
        id: 'acct-ready',
        config: validConfig,
        cooldownUntil: now + 30000, // in cooldown!
        requestTimes: [],
    };
    // Cooldown is ignored because inPlaceRateLimitRetry lifts it
    assert.equal(serverInternals.isRetryAccountEligible(readyAccount, now), true);

    // Missing token/cookie -> not eligible
    assert.equal(serverInternals.isRetryAccountEligible({ id: 'no-creds', config: {} }, now), false);

    // Burst cap check: set burst limit to 2
    serverInternals.setBurstPerMinute(2);
    try {
        const burstSpentAccount = {
            id: 'acct-burst',
            config: validConfig,
            cooldownUntil: now + 5000,
            requestTimes: [now - 1000, now - 2000],
        };
        assert.equal(serverInternals.withinBurst(burstSpentAccount, now), false);
        assert.equal(serverInternals.isRetryAccountEligible(burstSpentAccount, now), false);

        // shouldRetryInPlace with accountReady: false skips retry
        const retryCheck = serverInternals.shouldRetryInPlace({
            flagOn: true,
            rateLimit: true,
            migrated: false,
            gone: false,
            deadline: false,
            retryAfterSec: 2,
            anyReady: true,
            accountReady: serverInternals.isRetryAccountEligible(burstSpentAccount, now),
        });
        assert.equal(retryCheck, false, 'burst-blocked account skips in-place retry');
    } finally {
        serverInternals.setBurstPerMinute(0); // restore default
    }
});

test('H-3: pacing gate stamps reservation at admission and serializes concurrent turns', () => {
    const { execFileSync } = require('node:child_process');
    const childCode = `
        const assert = require('assert');
        const server = require('./server.js');
        const internals = server.__test;

        const now = Date.now();
        const mockAccount = {
            id: 'acct_reservation_test',
            file: 'test.json',
            config: { token: 't', cookie: 'c' },
            headers: { 'Authorization': 'Bearer t' },
            cooldownUntil: 0,
            failures: 0,
            inflight: 0,
            lastDispatchedAt: now - 10000,
        };
        internals.accounts.length = 0;
        internals.accounts.push(mockAccount);

        async function run() {
            const t0 = Date.now();
            // Call 1: passes gate, delay is 0, claims reservation at t0.
            // Will fail at PoW challenge network call, but reservation is stamped before PoW.
            try {
                await internals.askDeepSeekStream('p1', 'agent_1', 'deepseek-chat', 'p1', {
                    isClientGone: () => false,
                    requestStartedAt: t0,
                    isAgentLoop: true,
                });
            } catch (e) {
                // PoW fetch fails with network/auth error
            }

            // Assert mockAccount.lastDispatchedAt was updated by Call 1 to >= t0
            assert(mockAccount.lastDispatchedAt >= t0, 'Call 1 must have written reservation stamp >= t0');

            // Reset cooldown so mockAccount is admitted by selectAccountForSession for Call 2
            mockAccount.cooldownUntil = 0;

            // Call 2 arrives with only 2s remaining deadline
            const t2 = Date.now();
            try {
                await internals.askDeepSeekStream('p2', 'agent_2', 'deepseek-chat', 'p2', {
                    isClientGone: () => false,
                    requestStartedAt: t2 - 118000, // 2s remaining
                    isAgentLoop: true,
                });
                assert.fail('Call 2 should have been rejected by pacing gate because of Call 1 reservation');
            } catch (err) {
                assert.equal(err.status, 429);
                assert.equal(err.isPacingReject, true);
            }

            // Test rollback on client disconnect during sleep
            mockAccount.cooldownUntil = 0;
            const prevStamp = Date.now() - 50;
            mockAccount.lastDispatchedAt = prevStamp;
            try {
                await internals.askDeepSeekStream('p3', 'agent_3', 'deepseek-chat', 'p3', {
                    isClientGone: () => true, // client gone immediately
                    requestStartedAt: Date.now(),
                    isAgentLoop: true,
                });
                assert.fail('should have thrown client disconnected');
            } catch (e) {
                assert.equal(e.message, 'Client disconnected during pacing interval');
            }
            assert.equal(mockAccount.lastDispatchedAt, prevStamp, 'reservation must roll back when client disconnects during wait');
        }
        run();
    `;
    execFileSync(process.execPath, ['-e', childCode], {
        env: { ...process.env, DEEPSEEK_AGENT_TURN_GAP_MS: '6000', DEEPSEEK_TURN_JITTER_MS: '0' },
    });
});

test('M-D: pacing knobs enforce upper clamps and warn when gap >= min-usable', () => {
    const { execFileSync } = require('node:child_process');

    // 1. Exceeding max (60000ms) logs invalid warning and falls back to default 6000
    const outClamp = execFileSync(process.execPath, ['-e', 'const s = require("./server.js"); console.log("GAP:" + s.__test.AGENT_TURN_GAP_MS);'], {
        env: { ...process.env, DEEPSEEK_AGENT_TURN_GAP_MS: '300000' },
    }).toString();
    assert.match(outClamp, /\[DS-API\] Invalid DEEPSEEK_AGENT_TURN_GAP_MS="300000"; using default 6000/);
    assert.match(outClamp, /GAP:6000/);

    // 2. MIN_USABLE_UPSTREAM_MS exceeding REQUEST_DEADLINE_MS falls back to default 10000
    const outMinUsable = execFileSync(process.execPath, ['-e', 'const s = require("./server.js"); console.log("MIN:" + s.__test.MIN_USABLE_UPSTREAM_MS);'], {
        env: { ...process.env, DEEPSEEK_MIN_USABLE_UPSTREAM_MS: '200000' },
    }).toString();
    assert.match(outMinUsable, /\[DS-API\] Invalid DEEPSEEK_MIN_USABLE_UPSTREAM_MS="200000"; using default 10000/);
    assert.match(outMinUsable, /MIN:10000/);

    // 3. Gap >= min-usable emits startup warning
    const outWarn = execFileSync(process.execPath, ['-e', 'const s = require("./server.js");'], {
        env: { ...process.env, DEEPSEEK_AGENT_TURN_GAP_MS: '15000' },
    }).toString();
    assert.match(outWarn, /\[DS-API\] Warning: DEEPSEEK_AGENT_TURN_GAP_MS \(15000ms\) >= DEEPSEEK_MIN_USABLE_UPSTREAM_MS \(10000ms\)/);
});

test('M-A: parseToolCalls batch output updates account multiToolBatchCount and batchSizeCounts', () => {
    const rawContent = [
        '{"tool_call":{"name":"read_file","arguments":{"path":"a.txt"}}}',
        '{"tool_call":{"name":"read_file","arguments":{"path":"b.txt"}}}',
        '{"tool_call":{"name":"read_file","arguments":{"path":"c.txt"}}}',
    ].join('\n');
    const multiCalls = serverInternals.parseToolCalls(rawContent, { allowedToolNames: new Set(['read_file']) });
    assert.equal(multiCalls.length, 3);

    const mockAccount = {
        id: 'acct_metrics',
        multiToolBatchCount: 0,
        batchSizeCounts: {},
    };

    serverInternals.recordBatchMetrics(mockAccount, multiCalls.length);
    assert.equal(mockAccount.multiToolBatchCount, 1);
    assert.equal(mockAccount.batchSizeCounts['3'], 1);

    // Second batch of size 3 increments count to 2
    serverInternals.recordBatchMetrics(mockAccount, 3);
    assert.equal(mockAccount.multiToolBatchCount, 2);
    assert.equal(mockAccount.batchSizeCounts['3'], 2);

    // Single-call (size 1) does NOT count as a multi-tool batch
    serverInternals.recordBatchMetrics(mockAccount, 1);
    assert.equal(mockAccount.multiToolBatchCount, 2);
    assert.equal(mockAccount.batchSizeCounts['1'], undefined);
});

test('M-B: shipped pacing defaults are pinned and human turns bypass pacing gate without delay', async () => {
    // 1. Shipped defaults pinned
    assert.equal(serverInternals.AGENT_TURN_GAP_MS, 6000, 'AGENT_TURN_GAP_MS must be 6000ms');
    assert.equal(serverInternals.TURN_JITTER_MS, 2000, 'TURN_JITTER_MS must be 2000ms');
    assert.equal(serverInternals.MIN_USABLE_UPSTREAM_MS, 10000, 'MIN_USABLE_UPSTREAM_MS must be 10000ms');

    // 2. Human turns bypass classifier
    const humanMessages = [
        { role: 'system', content: 'You are an assistant.' },
        { role: 'user', content: 'Can you help me write code?' },
    ];
    assert.equal(serverInternals.isAgentLoopTurn({ messages: humanMessages, agentId: 'human-user' }), false, 'genuine user turn must evaluate to false');

    // 3. Human turns bypass gate completely (isAgentLoop: false)
    const mockAccount = {
        id: 'acct_human_bypass',
        file: 'test.json',
        config: { token: 't', cookie: 'c' },
        headers: { 'Authorization': 'Bearer t' },
        cooldownUntil: 0,
        failures: 0,
        inflight: 0,
        lastDispatchedAt: Date.now() - 50, // 50ms ago; if paced, would require ~5950ms delay
    };
    const prevDispatchedAt = mockAccount.lastDispatchedAt;
    serverInternals.accounts.length = 0;
    serverInternals.accounts.push(mockAccount);

    // Hermetic fetch mock: intercepts create_pow_challenge so test never hits network
    // and throws before line 1945 dispatch timestamping
    const origFetch = global.fetch;
    let powChallengeReached = false;
    global.fetch = async (url, opts) => {
        if (String(url).includes('create_pow_challenge')) {
            powChallengeReached = true;
            return { ok: false, status: 500, text: async () => 'mock-pow-abort' };
        }
        return origFetch(url, opts);
    };

    // Drive askDeepSeekStream with isAgentLoop: false
    const t0 = Date.now();
    try {
        await serverInternals.askDeepSeekStream('hello', 'human_agent', 'deepseek-chat', 'hello', {
            isClientGone: () => false,
            requestStartedAt: t0,
            isAgentLoop: false, // human turn bypass!
        });
    } catch (e) {
        // expected: throws at mocked cr.ok === false
    } finally {
        global.fetch = origFetch;
    }
    const elapsed = Date.now() - t0;
    assert.equal(powChallengeReached, true, 'Human turn must proceed directly through gate to upstream call');
    // Pacing delay of 5950ms was NOT scheduled; returns immediately (< 500ms)
    assert.ok(elapsed < 500, `Human turn must not sleep (elapsed: ${elapsed}ms)`);
    // Reservation stamp was NOT claimed (lastDispatchedAt remained unchanged by gate)
    assert.equal(mockAccount.lastDispatchedAt, prevDispatchedAt, 'Gate must not stamp reservation on human bypass');
});

test('L-D: calculateRequiredDelay clamps jitter to jitterMs when rand returns 1', () => {
    // With targetGapMs = 6000, jitterMs = 2000, elapsed = 0:
    // rand = 1: Math.floor(1 * 2001) = 2001 -> clamped to 2000 -> target = 8000
    assert.equal(serverInternals.calculateRequiredDelay(0, 6000, 2000, () => 1), 8000);
    // rand = 0: jitter = 0 -> target = 6000
    assert.equal(serverInternals.calculateRequiredDelay(0, 6000, 2000, () => 0), 6000);
    // rand = 0.5: Math.floor(0.5 * 2001) = 1000 -> target = 7000
    assert.equal(serverInternals.calculateRequiredDelay(0, 6000, 2000, () => 0.5), 7000);
});

test('L-E: stickyBurstReject accepts precomputed isOverBurst to avoid redundant evaluation', () => {
    const now = Date.now();
    const sticky = {
        id: 'acct_burst_check',
        config: { token: 't', cookie: 'c' },
        requestTimes: [now - 10000],
    };
    const session = { id: 'sess_live' };

    // When isOverBurst is precomputed as false -> immediately returns null
    const resFalse = serverInternals.stickyBurstReject(sticky, session, now, 10, false);
    assert.equal(resFalse, null);

    // When isOverBurst is precomputed as true -> returns 429 Error
    const resTrue = serverInternals.stickyBurstReject(sticky, session, now, 10, true);
    assert.ok(resTrue instanceof Error);
    assert.equal(resTrue.status, 429);
    assert.equal(resTrue.type, 'rate_limit');
    assert.match(resTrue.message, /hit the burst cap/);
});





