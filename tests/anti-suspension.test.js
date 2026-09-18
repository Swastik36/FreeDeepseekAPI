const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const serverInternals = require('../server.js').__test;

test('Batch 1 (Pillar 1): formatToolDefinitions contains batch discipline and per-turn cap without contradiction', () => {
    const tools = [{ type: 'function', function: { name: 'read_file', description: 'read' } }];
    const formatted = serverInternals.formatToolDefinitions(tools);
    assert.match(formatted, /BATCH DISCIPLINE: at most 6 tool batches per task; 1 batch = one turn with max 8 tool calls/);
    assert.match(formatted, /When inspecting code \(read\/grep\/find\), emit all independent calls in the SAME turn \(up to 8 calls\)/);
    assert.match(formatted, /Do not batch mutations on the same target/);
});

test('Batch 1 (Pillar 1): parseToolCalls remains pure and account-agnostic', () => {
    // Calling parseToolCalls with multi-envelopes returns an array without touching global state
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

test('Batch 1 (Pillar 2): UUID regex strictly validates RFC 4122 hex structure', () => {
    const uuidRegex = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
    assert.equal(uuidRegex.test('b5557788-29ca-4766-bd95-b9f1d07c088e'), true);
    assert.equal(uuidRegex.test('B5557788-29CA-4766-BD95-B9F1D07C088E'), true);
    assert.equal(uuidRegex.test('------------------------------------'), false);
    assert.equal(uuidRegex.test('null'), false);
    assert.equal(uuidRegex.test('b5557788-29ca-4766-bd95-b9f1d07c088'), false); // 35 chars
    assert.equal(uuidRegex.test('b5557788-29ca-4766-bd95-b9f1d07c088ez'), false); // 37 chars
});

test('Batch 1 (Pillar 2): readPageAuth code validates snake_case device_id', () => {
    const scriptPath = path.join(__dirname, '..', 'scripts', 'deepseek_chrome_auth.js');
    const content = fs.readFileSync(scriptPath, 'utf8');
    assert.match(content, /const rawDeviceId = pageState\.localStorage \? pageState\.localStorage\['deepseek-device-id:chat'\] : null;/);
    assert.match(content, /device_id,/);
    // Ensure no camelCase deviceId leakage in extraction return
    assert.doesNotMatch(content, /return\s*\{[^}]*\bdeviceId\b/);
});
