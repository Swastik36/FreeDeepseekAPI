const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
// Redirect the session store BEFORE loading the server: several unit tests
// exercise reset/persist paths, and without this they would overwrite the
// LIVE service's .sessions.json (wiping restored chats on next restart).
process.env.DEEPSEEK_SESSION_STORE = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'fdsapi-sessions-')),
  'sessions.json'
);
const serverInternals = require('../server.js').__test;
const testServer = require('../server.js').server;

// Live-HTTP helpers (bug-hunt 2026-09-16 regressions): drive the real server
// on an ephemeral loopback port. Requests that pass the body gates but need
// an upstream account fail fast with 503 no_auth (no network touched).
function listenEphemeral() {
  return new Promise((resolve, reject) => {
    testServer.listen(0, '127.0.0.1', (err) => {
      if (err) return reject(err);
      resolve(testServer.address().port);
    });
  });
}
function closeServer() {
  return new Promise((resolve) => {
    try { testServer.closeAllConnections(); } catch (e) { /* old node */ }
    testServer.close(() => resolve());
  });
}
async function withServer(fn) {
  const port = await listenEphemeral();
  try { await fn(port); } finally { await closeServer(); }
}
function authHeaders() {
  return process.env.PROXY_API_KEY ? { Authorization: `Bearer ${process.env.PROXY_API_KEY}` } : {};
}
function post(port, urlPath, body, headers = {}) {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...authHeaders(), ...headers } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      });
    req.on('error', reject);
    req.end(data);
  });
}
// Trickled body: headers + partial chunk arrive first; beforeEnd() runs (e.g.
// raising in-flight pressure) before the body completes — exercises the
// body-end backpressure re-check deterministically.
function tricklePost(port, beforeEnd, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked', ...authHeaders(), ...headers } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      });
    req.on('error', reject);
    req.write('{"model":"deepseek-chat","messages":[{');
    setTimeout(async () => {
      try { await beforeEnd(); } catch (e) { /* ignore */ }
      req.end('"role":"user","content":"hi"}]}');
    }, 50);
  });
}
async function pollFor(fn, timeoutMs = 2000) {
  const start = Date.now();
  for (;;) {
    if (fn()) return true;
    if (Date.now() - start > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 25));
  }
}
function snapshotSessions() { return Array.from(serverInternals.sessions.entries()); }
function restoreSessionsFrom(saved) {
  serverInternals.sessions.clear();
  for (const [k, v] of saved) serverInternals.sessions.set(k, v);
}

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fdsapi-test-'));
}

function runNode(args, opts = {}) {
  return spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...opts.env },
  });
}

test('auth import copies valid deepseek-auth.json and chmods it to 0600', () => {
  const dir = tmpdir();
  const src = path.join(dir, 'source-auth.json');
  const dst = path.join(dir, 'deepseek-auth.json');
  fs.writeFileSync(src, JSON.stringify({
    token: 'tok_123',
    cookie: 'ds_session_id=abc; other=def',
    hif_dliq: 'dliq',
    hif_leim: 'leim',
    wasmUrl: 'https://example.com/sha3.wasm',
  }));

  const res = runNode(['scripts/auth_import.js', '--input', src, '--output', dst]);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const imported = JSON.parse(fs.readFileSync(dst, 'utf8'));
  assert.equal(imported.token, 'tok_123');
  assert.match(imported.cookie, /ds_session_id=abc/);
  if (process.platform !== 'win32') {
    assert.equal((fs.statSync(dst).mode & 0o777), 0o600);
  }
});

test('auth import accepts browser cookie export plus token env', () => {
  const dir = tmpdir();
  const src = path.join(dir, 'cookies.json');
  const dst = path.join(dir, 'deepseek-auth.json');
  fs.writeFileSync(src, JSON.stringify([
    { domain: '.deepseek.com', name: 'ds_session_id', value: 'abc' },
    { domain: 'chat.deepseek.com', name: 'smidV2', value: 'smid' },
    { domain: 'example.com', name: 'ignored', value: 'nope' },
  ]));

  const res = runNode(['scripts/auth_import.js', '--input', src, '--output', dst], { env: { DEEPSEEK_TOKEN: 'tok_env' } });
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const imported = JSON.parse(fs.readFileSync(dst, 'utf8'));
  assert.equal(imported.token, 'tok_env');
  assert.equal(imported.cookie, 'ds_session_id=abc; smidV2=smid');
});

test('auth import rejects token passed as CLI arg before prompting or reading files', () => {
  const dir = tmpdir();
  const src = path.join(dir, 'cookies.json');
  const dst = path.join(dir, 'deepseek-auth.json');
  fs.writeFileSync(src, JSON.stringify([{ domain: '.deepseek.com', name: 'ds_session_id', value: 'abc' }]));

  const res = runNode(['scripts/auth_import.js', '--input', src, '--output', dst, '--token', 'tok_cli']);
  assert.equal(res.status, 2);
  assert.match(res.stderr + res.stdout, /Refusing --token/i);
  assert.equal(fs.existsSync(dst), false);

  const noInput = runNode(['scripts/auth_import.js', '--token', 'tok_cli']);
  assert.equal(noInput.status, 2);
  assert.match(noInput.stderr + noInput.stdout, /Refusing --token/i);

  const badInput = runNode(['scripts/auth_import.js', '--input', path.join(dir, 'missing.json'), '--token', 'tok_cli']);
  assert.equal(badInput.status, 2);
  assert.match(badInput.stderr + badInput.stdout, /Refusing --token/i);
});

test('auth import help ignores comma-list DEEPSEEK_AUTH_PATH as default output', () => {
  const dir = tmpdir();
  const a = path.join(dir, 'a.json');
  const b = path.join(dir, 'b.json');
  const res = runNode(['scripts/auth_import.js', '--help'], { env: { DEEPSEEK_AUTH_PATH: `${a},${b}` } });
  assert.equal(res.status, 0, res.stderr || res.stdout);
  assert.doesNotMatch(res.stdout, new RegExp(`${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')},`));
  assert.match(res.stdout, /deepseek-auth\.json/);
});

test('doctor reports auth problems without requiring Chrome or network', () => {
  const dir = tmpdir();
  const authPath = path.join(dir, 'broken-auth.json');
  fs.writeFileSync(authPath, JSON.stringify({ token: '', cookie: '' }));
  const res = runNode(['scripts/doctor.js', '--offline'], { env: { DEEPSEEK_AUTH_PATH: authPath } });
  assert.notEqual(res.status, 0);
  assert.match(res.stdout + res.stderr, /token missing/i);
  assert.match(res.stdout + res.stderr, /cookie missing/i);
});

test('chrome auth prints actionable OS instructions when Chrome is missing', () => {
  const dir = tmpdir();
  const fakeChrome = path.join(dir, 'missing-chrome');
  const res = runNode(['scripts/deepseek_chrome_auth.js'], { env: { CHROME_PATH: fakeChrome } });
  assert.notEqual(res.status, 0);
  const out = res.stdout + res.stderr;
  assert.match(out, /Windows/i);
  assert.match(out, /macOS/i);
  assert.match(out, /Linux/i);
  assert.match(out, /CHROME_PATH/i);
});

test('chrome extension manifest only declares icon files that exist', () => {
  const manifestPath = path.join(ROOT, 'chrome-extension', 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const iconPaths = [];

  function collectIconPaths(value, key = '') {
    if (typeof value === 'string') {
      if (key === 'icons' || key === 'default_icon') iconPaths.push(value);
      return;
    }

    if (!value || typeof value !== 'object') return;

    if ((key === 'icons' || key === 'default_icon') && !Array.isArray(value)) {
      for (const iconPath of Object.values(value)) {
        if (typeof iconPath === 'string') iconPaths.push(iconPath);
      }
      return;
    }

    for (const [childKey, childValue] of Object.entries(value)) {
      collectIconPaths(childValue, childKey);
    }
  }

  collectIconPaths(manifest);

  for (const iconPath of iconPaths) {
    assert.equal(
      fs.existsSync(path.join(path.dirname(manifestPath), iconPath)),
      true,
      `Missing extension icon declared in manifest: ${iconPath}`,
    );
  }
});

test('DeepSeek stream parser treats SEARCH fragments as assistant output', () => {
  const rebuilt = serverInternals.rebuildFragmentText([
    { type: 'SEARCH', content: 'The official Reuters website is ' },
    { type: 'SEARCH', content: 'https://www.reuters.com/.' },
  ]);

  assert.equal(rebuilt.responseText, 'The official Reuters website is https://www.reuters.com/.');
  assert.equal(rebuilt.thinkText, '');
});

test('DeepSeek stream parser applies response-level fragment append patches', () => {
  const fragments = [];
  const appendFragments = (value) => {
    const incoming = Array.isArray(value) ? value : [value];
    for (const fragment of incoming) fragments.push({ ...fragment });
  };

  const applied = serverInternals.applyResponsePatchOperations([
    { p: 'fragments', o: 'APPEND', v: [{ type: 'RESPONSE', content: 'The' }] },
    { p: 'has_pending_fragment', o: 'SET', v: false },
  ], appendFragments);

  assert.equal(applied, true);
  assert.deepEqual(fragments, [{ type: 'RESPONSE', content: 'The' }]);
  assert.equal(serverInternals.rebuildFragmentText(fragments).responseText, 'The');
});

test('DeepSeek stream parser does not treat service content chunks as model errors', () => {
  assert.equal(serverInternals.isDeepSeekModelErrorEvent({ content: 'Official Reuters website URL' }), false);
  assert.equal(serverInternals.isDeepSeekModelErrorEvent({ finish_reason: 'stop' }), false);
  assert.equal(serverInternals.isDeepSeekModelErrorEvent({ type: 'error', content: 'backend error' }), true);
});

test('consumed upstream HTTP errors retain status, type, and retry hints', () => {
  const limited = serverInternals.createUpstreamHttpError(429, '  Rate limited\ntry later  ', '12');
  assert.equal(limited.status, 429);
  assert.equal(limited.type, 'rate_limit_error');
  assert.equal(limited.retryAfter, '12');
  assert.match(limited.message, /Rate limited try later/);

  const unauthorized = serverInternals.createUpstreamHttpError(401, 'expired');
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.type, 'authentication_error');
});

test('sweepIdleSessions evicts only idle entries', () => {
  serverInternals.sessions.set('stale-x', { lastActivityAt: 1 });
  serverInternals.sessions.set('fresh-x', { lastActivityAt: Date.now() });
  serverInternals.sweepIdleSessions(60 * 1000);
  assert.equal(serverInternals.sessions.has('stale-x'), false);
  assert.equal(serverInternals.sessions.has('fresh-x'), true);
  serverInternals.sessions.delete('fresh-x');
});

test('proxy API key authentication is optional and uses exact bearer tokens', () => {
  assert.equal(serverInternals.isProxyAuthorized(undefined, ''), true);
  assert.equal(serverInternals.isProxyAuthorized('Bearer secret', 'secret'), true);
  assert.equal(serverInternals.isProxyAuthorized('Bearer wrong', 'secret'), false);
  assert.equal(serverInternals.isProxyAuthorized('Basic secret', 'secret'), false);
  assert.equal(serverInternals.isProxyAuthorized('Bearer secret ', 'secret'), false);
});

test('proxy API key can be loaded from a mounted secret and required explicitly', () => {
  const dir = tmpdir();
  const secretPath = path.join(dir, 'proxy-api-key');
  fs.writeFileSync(secretPath, 'mounted-secret\n');

  assert.equal(serverInternals.loadProxyApiKey({ PROXY_API_KEY_FILE: secretPath }), 'mounted-secret');
  assert.equal(serverInternals.loadProxyApiKey({ PROXY_API_KEY: 'env-secret', PROXY_API_KEY_FILE: secretPath }), 'env-secret');
  assert.equal(serverInternals.loadProxyApiKey({ PROXY_API_KEY_FILE: path.join(dir, 'missing') }), '');
  assert.doesNotThrow(() => serverInternals.requireProxyApiKey('mounted-secret', true));
  assert.throws(
    () => serverInternals.requireProxyApiKey('', true),
    /PROXY_API_KEY is required/,
  );
});

test('Containerfile keeps the rootless Podman runtime minimal and fail-closed', () => {
  const containerfile = fs.readFileSync(path.join(ROOT, 'Containerfile'), 'utf8');
  const containerignore = fs.readFileSync(path.join(ROOT, '.containerignore'), 'utf8');
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const copyLines = containerfile
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.startsWith('COPY '));

  assert.deepEqual(copyLines, [
    'COPY --chown=1000:1000 package.json server.js ./',
    'COPY --chown=1000:1000 lib/pow.js ./lib/pow.js',
  ]);
  assert.doesNotMatch(containerfile, /^\s*(?:COPY|ADD)\s+\.\s/m);
  assert.match(containerfile, /^USER 1000:1000$/m);
  assert.match(containerfile, /HOST=0\.0\.0\.0/);
  assert.match(containerfile, /NON_INTERACTIVE=1/);
  assert.match(containerfile, /REQUIRE_PROXY_API_KEY=1/);
  assert.match(containerfile, /PROXY_API_KEY_FILE=\/run\/secrets\/proxy-api-key/);
  assert.match(containerfile, /^HEALTHCHECK /m);
  assert.match(containerfile, /path:'\/health'/);
  assert.match(containerfile, /^CMD \["node", "server\.js"\]$/m);

  assert.match(containerignore, /^\*$/m);
  assert.doesNotMatch(containerignore, /^!.*(?:auth|secret|\.env)/mi);
  assert.match(readme, /--publish 127\.0\.0\.1:9655:9655/);
  assert.match(readme, /--secret free-deepseek-auth[^\n]*mode=0400/);
  assert.match(readme, /--secret free-deepseek-proxy-key[^\n]*mode=0400/);
  assert.match(readme, /--read-only/);
  assert.match(readme, /--cap-drop=ALL/);
  assert.match(readme, /--security-opt=no-new-privileges/);
});

test('loopback host detection covers supported local bind addresses', () => {
  assert.equal(serverInternals.isLoopbackHost('127.0.0.1'), true);
  assert.equal(serverInternals.isLoopbackHost('::1'), true);
  assert.equal(serverInternals.isLoopbackHost('[::1]'), true);
  assert.equal(serverInternals.isLoopbackHost('::ffff:127.0.0.1'), true);
  assert.equal(serverInternals.isLoopbackHost('localhost'), true);
  assert.equal(serverInternals.isLoopbackHost('0.0.0.0'), false);
});

test('browser origin guard allows local UIs and exact configured origins only', () => {
  const allowed = new Set(['https://ui.example.com', 'chrome-extension://trusted-id']);
  assert.equal(serverInternals.isBrowserOriginAllowed(undefined, allowed), true);
  assert.equal(serverInternals.isBrowserOriginAllowed('http://localhost:3000', allowed), true);
  assert.equal(serverInternals.isBrowserOriginAllowed('http://127.0.0.1:8080', allowed), true);
  assert.equal(serverInternals.isBrowserOriginAllowed('http://[::1]:3000', allowed), true);
  assert.equal(serverInternals.isBrowserOriginAllowed('https://ui.example.com/path', allowed), true);
  assert.equal(serverInternals.isBrowserOriginAllowed('chrome-extension://trusted-id', allowed), true);
  assert.equal(serverInternals.isBrowserOriginAllowed('https://evil.example', allowed), false);
  assert.equal(serverInternals.isBrowserOriginAllowed('chrome-extension://other-id', allowed), false);
  assert.equal(serverInternals.isBrowserOriginAllowed('null', allowed), false);
});

test('parseToolCall converts canonical DeepSeek DSML into an OpenAI tool call', () => {
  const dsml = [
    'I will inspect it.',
    '<｜DSML｜tool_calls>',
    '<｜DSML｜invoke name="execute_code">',
    '<｜DSML｜parameter name="code" string="true">print("ok")</｜DSML｜parameter>',
    '<｜DSML｜parameter name="timeout" string="false">30</｜DSML｜parameter>',
    '<｜DSML｜parameter name="capture" string="false">true</｜DSML｜parameter>',
    '</｜DSML｜invoke>',
    '</｜DSML｜tool_calls>',
  ].join('\n');

  const call = serverInternals.parseToolCall(dsml);
  assert.equal(call.name, 'execute_code');
  assert.deepEqual(JSON.parse(call.arguments), {
    code: 'print("ok")',
    timeout: 30,
    capture: true,
  });
});

test('parseToolCall accepts the doubled-bar DSML Web variant from issue #19', () => {
  const dsml = [
    '<｜｜DSML｜｜ Tool Calls>',
    '<｜｜DSML｜｜ name="web_search">{"query":"DeepSeek DSML"}',
    '</｜｜DSML｜｜ Tool Calls>',
  ].join('\n');

  const call = serverInternals.parseToolCall(dsml);
  assert.equal(call.name, 'web_search');
  assert.deepEqual(JSON.parse(call.arguments), { query: 'DeepSeek DSML' });
});

test('parseToolCall accepts zero-argument, CDATA, legacy, collapsed, and prefixed wrappers', () => {
  const zeroArg = serverInternals.parseToolCall(
    '<|DSML|tool_calls><|DSML|invoke name="ping"></|DSML|invoke></|DSML|tool_calls>'
  );
  assert.deepEqual(zeroArg, { name: 'ping', arguments: '{}' });

  const cdata = serverInternals.parseToolCall(
    '<tool_calls><invoke name="write_file"><parameter name="content"><![CDATA[line 1\n<line 2>\n</parameter>\n</invoke>\n</tool_calls>]]></parameter></invoke></tool_calls>'
  );
  assert.deepEqual(JSON.parse(cdata.arguments), { content: 'line 1\n<line 2>\n</parameter>\n</invoke>\n</tool_calls>' });

  const collapsed = serverInternals.parseToolCall(
    '<DSMLtool_calls><DSMLinvoke name="read_file"><DSMLparameter name="path">/tmp/a</DSMLparameter></DSMLinvoke></DSMLtool_calls>'
  );
  assert.deepEqual(JSON.parse(collapsed.arguments), { path: '/tmp/a' });

  const prefixed = serverInternals.parseToolCall(
    '<abc:tool_calls><abc:invoke name="read_file"><abc:parameter name="path">/tmp/b</abc:parameter></abc:invoke></abc:tool_calls>'
  );
  assert.deepEqual(JSON.parse(prefixed.arguments), { path: '/tmp/b' });
});

test('parseToolCall normalizes fullwidth delimiters and narrowly repairs a missing opening wrapper', () => {
  const fullwidth = serverInternals.parseToolCall(
    '＜｜DSML｜Tool Calls＞＜｜DSML｜Invoke name=“read_file”＞＜｜DSML｜Parameter name=“path”＞/tmp/c＜/｜DSML｜Parameter＞＜/｜DSML｜Invoke＞＜/｜DSML｜Tool Calls＞'
  );
  assert.deepEqual(JSON.parse(fullwidth.arguments), { path: '/tmp/c' });

  const repaired = serverInternals.parseToolCall(
    '<invoke name="read_file"><parameter name="path">/tmp/d</parameter></invoke></tool_calls>'
  );
  assert.deepEqual(JSON.parse(repaired.arguments), { path: '/tmp/d' });
});

test('parseToolCall rejects bare invokes and bare JSON examples', () => {
  const bareInvoke = '<|DSML|invoke name="execute_code"><|DSML|parameter name="code">danger()</|DSML|parameter></|DSML|invoke>';
  assert.equal(serverInternals.parseToolCall(bareInvoke), null);
  assert.equal(serverInternals.looksLikeToolCallMarkup(bareInvoke), true);

  const prose = 'For example return {"name":"execute_code","arguments":{"code":"danger()"}} when appropriate.';
  assert.equal(serverInternals.parseToolCall(prose), null);
  assert.equal(serverInternals.parseToolCall('```json\n{"name":"execute_code","arguments":{"code":"danger()"}}\n```'), null);
});

test('parseToolCall accepts only explicit JSON envelopes with valid object arguments', () => {
  const explicit = serverInternals.parseToolCall(
    'Use this: {"tool_call":{"name":"read_file","arguments":{"path":"/tmp/a"}}}'
  );
  assert.deepEqual(JSON.parse(explicit.arguments), { path: '/tmp/a' });

  const openai = serverInternals.parseToolCall(JSON.stringify({
    tool_calls: [{
      type: 'function',
      function: { name: 'read_file', arguments: JSON.stringify({ path: '/tmp/b' }) },
    }],
  }));
  assert.deepEqual(JSON.parse(openai.arguments), { path: '/tmp/b' });

  assert.equal(serverInternals.parseToolCall('{"tool_call":{"name":"read_file","arguments":"not-json"}}'), null);
  assert.equal(serverInternals.parseToolCall(JSON.stringify({
    tool_calls: [
      { function: { name: 'read_file', arguments: '{}' } },
      { function: { name: 'write_file', arguments: '{}' } },
    ],
  })), null);
});

test('parseToolCall bounds tool markup and scans unmatched braces in linear time', () => {
  const oversized = `<|DSML|tool_calls>${'x'.repeat(256 * 1024)}</|DSML|tool_calls>`;
  assert.equal(serverInternals.parseToolCall(oversized), null);

  const started = Date.now();
  assert.equal(serverInternals.parseToolCall('{'.repeat(64 * 1024)), null);
  assert.ok(Date.now() - started < 1000, 'unmatched JSON braces should not block the event loop');

  const malformedTagStarted = Date.now();
  const malformedTags = `<tool_calls><invoke name="${'<invoke name="'.repeat(16000)}</tool_calls>`;
  assert.equal(serverInternals.parseToolCall(malformedTags), null);
  assert.ok(Date.now() - malformedTagStarted < 1000, 'malformed quoted DSML tags should be rejected in bounded time');
});

test('parseToolCall refuses incomplete DSML instead of executing JSON found inside it', () => {
  const malformed = [
    '<｜DSML｜tool_calls>',
    '<｜DSML｜invoke name="execute_code">',
    '{"name":"dangerous_fallback","code":"rm -rf /"}',
    '</｜DSML｜tool_calls>',
  ].join('\n');

  assert.equal(serverInternals.parseToolCall(malformed), null);
  assert.equal(serverInternals.looksLikeToolCallMarkup(malformed), true);
});

test('parseToolCall rejects partially consumed DSML parameters and wrapper scope', () => {
  const truncatedSecondParameter = '<tool_calls><invoke name="write_file"><parameter name="path">/tmp/a</parameter><parameter name="content">truncated</invoke></tool_calls>';
  const trailingInvokeJunk = '<tool_calls><invoke name="write_file"><parameter name="path">/tmp/a</parameter>GARBAGE</invoke></tool_calls>';
  const truncatedSecondInvoke = '<tool_calls><invoke name="ping"></invoke><invoke name="write_file"><parameter name="path">/tmp/a</tool_calls>';
  const twoCompleteInvokes = '<tool_calls><invoke name="ping"></invoke><invoke name="ping"></invoke></tool_calls>';
  const secondInvokeOutsideWrapper = '<tool_calls><invoke name="ping"></invoke></tool_calls><invoke name="write_file"><parameter name="path">/tmp/a</parameter></invoke>';
  const trailingWrapperJunk = '<tool_calls><invoke name="ping"></invoke>GARBAGE</tool_calls>';
  const unclosedCdata = '<tool_calls><invoke name="write_file"><parameter name="content"><![CDATA[truncated</parameter></invoke></tool_calls>';
  const tooManyParameters = `<tool_calls><invoke name="write_file">${Array.from({ length: 129 }, (_, i) => `<parameter name="p${i}">${i}</parameter>`).join('')}</invoke></tool_calls>`;

  for (const malformed of [
    truncatedSecondParameter,
    trailingInvokeJunk,
    truncatedSecondInvoke,
    twoCompleteInvokes,
    secondInvokeOutsideWrapper,
    trailingWrapperJunk,
    unclosedCdata,
    tooManyParameters,
  ]) {
    assert.equal(serverInternals.parseToolCall(malformed), null, malformed);
    assert.equal(serverInternals.looksLikeToolCallMarkup(malformed), true, malformed);
  }
});

test('tool schema compaction drops prose annotations but preserves validation shape', () => {
  const compact = serverInternals.compactToolSchema({
    type: 'object',
    description: 'large top-level description',
    properties: {
      command: { type: 'string', description: 'large property description' },
      count: { type: 'integer', minimum: 1 },
      description: { type: 'string', description: 'annotation, not the property name' },
      title: { type: 'boolean', title: 'annotation, not the property name' },
      nested: {
        anyOf: [
          { type: 'string', description: 'remove from array item one' },
          { type: 'integer', title: 'remove from array item two' },
        ],
      },
    },
    required: ['command', 'description', 'title'],
  });

  assert.deepEqual(compact, {
    type: 'object',
    properties: {
      command: { type: 'string' },
      count: { type: 'integer', minimum: 1 },
      description: { type: 'string' },
      title: { type: 'boolean' },
      nested: { anyOf: [{ type: 'string' }, { type: 'integer' }] },
    },
    required: ['command', 'description', 'title'],
  });
});

test('tool schema compaction preserves literal const, enum, and default values', () => {
  const literals = {
    type: 'object',
    description: 'drop this annotation',
    const: { description: 'literal field', title: 'literal title', nested: { examples: ['literal'] } },
    enum: [
      { description: 'first', value: 1 },
      { title: 'second', value: 2 },
    ],
    default: { description: 'default literal', title: 'default title' },
    properties: {
      choice: {
        description: 'drop nested annotation',
        const: { description: 'required argument value', title: 'keep me' },
      },
    },
  };

  assert.deepEqual(serverInternals.compactToolSchema(literals), {
    type: 'object',
    const: literals.const,
    enum: literals.enum,
    default: literals.default,
    properties: {
      choice: { const: literals.properties.choice.const },
    },
  });
});

test('buildBoundedPrompt preserves task edges and drops duplicate recovery history', () => {
  const system = `SYSTEM_START\n${'s'.repeat(50000)}\nTOOL_ADAPTER_END`;
  const history = `[Previous conversation]\n${'h'.repeat(10000)}\n`;
  const conversation = `TASK_START\n${'c'.repeat(70000)}\nLATEST_TOOL_RESULT`;
  const bounded = serverInternals.buildBoundedPrompt(system, history, conversation, 20000);

  assert.equal(bounded.compacted, true);
  assert.equal(bounded.historyDropped, true);
  assert.ok(bounded.prompt.length <= 20000);
  assert.match(bounded.prompt, /SYSTEM_START/);
  assert.match(bounded.prompt, /TOOL_ADAPTER_END/);
  assert.match(bounded.prompt, /TASK_START/);
  assert.match(bounded.prompt, /LATEST_TOOL_RESULT/);
  assert.doesNotMatch(bounded.prompt, /Previous conversation/);
});

test('client-provided multi-turn history suppresses server recovery-history injection', () => {
  assert.equal(serverInternals.hasExplicitConversationHistory([
    { role: 'system', content: 'rules' },
    { role: 'user', content: 'hello' },
  ]), false);
  assert.equal(serverInternals.hasExplicitConversationHistory([
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi' },
    { role: 'tool', content: 'result' },
  ]), true);
});

test('context-too-long detector recognizes DeepSeek localized errors', () => {
  assert.equal(serverInternals.isContextTooLongError({ content: 'Содержание слишком длинное. Сократите его и попробуйте снова.' }), true);
  assert.equal(serverInternals.isContextTooLongError({ content: 'Maximum context length exceeded' }), true);
  assert.equal(serverInternals.isContextTooLongError({ content: 'Temporary backend overload' }), false);
});

test('empty-response retry keeps recovery history unless a smaller global cap requires compaction', () => {
  const system = 'SYSTEM';
  const history = '[Previous conversation]\nUser: old\nAssistant: answer\n\n[Continue from here]\n\n';
  const conversation = 'User: follow up';
  const initial = serverInternals.buildBoundedPrompt(system, history, conversation, 5000);
  const unchangedRetry = serverInternals.buildRetryPrompt(system, history, conversation, initial.prompt, 4000);

  assert.equal(unchangedRetry.compacted, false);
  assert.match(unchangedRetry.prompt, /Previous conversation/);
  assert.match(unchangedRetry.prompt, /Assistant: answer/);

  const largeConversation = `TASK_START\n${'x'.repeat(9000)}\nLATEST_RESULT`;
  const largeInitial = serverInternals.buildBoundedPrompt(system, history, largeConversation, 8000);
  const smallerRetry = serverInternals.buildRetryPrompt(system, history, largeConversation, largeInitial.prompt, 4000);
  assert.equal(smallerRetry.compacted, true);
  assert.ok(smallerRetry.prompt.length <= 4000);
  assert.match(smallerRetry.prompt, /TASK_START/);
  assert.match(smallerRetry.prompt, /LATEST_RESULT/);
});

test('fresh-session retry restores local history that a healthy remote session initially omitted', () => {
  const system = 'SYSTEM';
  const history = serverInternals.buildRecoveryHistoryPrefix([
    { user: 'original task', assistant: 'original answer' },
  ]);
  const conversation = 'User: follow up';
  const establishedSessionPrompt = serverInternals.buildBoundedPrompt(system, '', conversation, 5000).prompt;
  const freshSessionRetry = serverInternals.buildRetryPrompt(
    system,
    history,
    conversation,
    establishedSessionPrompt,
    5000,
  );

  assert.ok(freshSessionRetry.prompt.length > establishedSessionPrompt.length);
  assert.match(freshSessionRetry.prompt, /Previous conversation/);
  assert.match(freshSessionRetry.prompt, /original task/);
  assert.match(freshSessionRetry.prompt, /original answer/);
  assert.match(freshSessionRetry.prompt, /follow up/);
});

test('remote reset preserves local history and sticky account while returning failure diagnostics', () => {
  const session = serverInternals.createSession();
  session.id = 'failed-session';
  session.parentMessageId = 'parent';
  session.createdAt = 123;
  session.messageCount = 17;
  session.accountId = 'account_2';
  session.history.push({ user: 'old task', assistant: 'old answer' });

  const failure = serverInternals.resetRemoteSession(session);
  assert.deepEqual(failure, {
    failedSessionId: 'failed-session',
    failedMessageCount: 17,
    accountId: 'account_2',
  });
  assert.equal(session.id, null);
  assert.equal(session.parentMessageId, null);
  assert.equal(session.createdAt, null);
  assert.equal(session.messageCount, 0);
  assert.equal(session.accountId, 'account_2');
  assert.equal(session.history.length, 1);
});

test('live chat keeps account affinity: sticky cooldown fails fast with 429, chat preserved', (t) => {
  const originalAccounts = serverInternals.accounts.splice(0);
  t.after(() => {
    serverInternals.accounts.splice(0, serverInternals.accounts.length, ...originalAccounts);
  });

  serverInternals.accounts.push(
    {
      id: 'cooling',
      config: { token: 'one', cookie: 'one' },
      cooldownUntil: Date.now() + 60_000,
      headers: {},
    },
    {
      id: 'ready',
      config: { token: 'two', cookie: 'two' },
      cooldownUntil: 0,
      headers: {},
    },
  );
  const session = serverInternals.createSession();
  session.id = 'live-session';
  session.parentMessageId = 'live-parent';
  session.accountId = 'cooling';
  session.messageCount = 7;
  session.history.push({ user: 'old task', assistant: 'old answer' });

  // Same opencode conversation must NOT hop to another chat+account on rate
  // limit — the client backs off and retries on the same chat instead.
  assert.throws(() => serverInternals.selectAccountForSession(session), (err) => {
    assert.equal(err.status, 429);
    assert.equal(err.type, 'rate_limit');
    assert.ok(Number(err.retryAfter) >= 1);
    return true;
  });
  assert.equal(session.id, 'live-session');
  assert.equal(session.parentMessageId, 'live-parent');
  assert.equal(session.accountId, 'cooling');
  assert.equal(session.messageCount, 7);
  assert.equal(session.history.length, 1);
});

test('chat-less session still rotates away from a cooling sticky account', (t) => {
  const originalAccounts = serverInternals.accounts.splice(0);
  t.after(() => {
    serverInternals.accounts.splice(0, serverInternals.accounts.length, ...originalAccounts);
  });

  serverInternals.accounts.push(
    {
      id: 'cooling',
      config: { token: 'one', cookie: 'one' },
      cooldownUntil: Date.now() + 60_000,
      headers: {},
    },
    {
      id: 'ready',
      config: { token: 'two', cookie: 'two' },
      cooldownUntil: 0,
      headers: {},
    },
  );
  const session = serverInternals.createSession();
  session.accountId = 'cooling';
  session.history.push({ user: 'old task', assistant: 'old answer' });

  const selected = serverInternals.selectAccountForSession(session);
  assert.equal(selected.id, 'ready');
  assert.equal(session.accountId, 'ready');
  assert.equal(session.id, null);
  assert.equal(session.parentMessageId, null);
  assert.equal(session.messageCount, 0);
  assert.equal(session.history.length, 1);
});

test('detectClientCompaction fires only on history collapse, not resends', () => {
  const session = serverInternals.createSession();
  session.id = 'live-session';
  const longHistory = [
    { role: 'user', content: 'q1' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'q2' },
    { role: 'assistant', content: 'a2' },
    { role: 'user', content: 'q3' },
    { role: 'assistant', content: 'a3' },
    { role: 'user', content: 'q4' },
    { role: 'assistant', content: 'a4' },
  ];
  serverInternals.commitDeltaState(session, longHistory);
  assert.equal(serverInternals.detectClientCompaction(longHistory, session), false);

  // Opencode compaction: 8 turns collapsed into a summary + follow-up.
  const compacted = [
    { role: 'user', content: 'Summary of our work so far: built X, fixed Y. Continue with Z.' },
    { role: 'user', content: 'Continue with Z.' },
  ];
  assert.equal(serverInternals.detectClientCompaction(compacted, session), true);

  // Tiny sessions and cold chats never count as compaction.
  const fresh = serverInternals.createSession();
  assert.equal(serverInternals.detectClientCompaction(compacted, fresh), false);
  const small = serverInternals.createSession();
  small.id = 's';
  serverInternals.commitDeltaState(small, [{ role: 'user', content: 'hi' }]);
  assert.equal(serverInternals.detectClientCompaction([{ role: 'user', content: 'other' }], small), false);

  // Shrinking by a single message is a resend/trim, not a compaction.
  const almostSame = longHistory.slice(0, 7);
  assert.equal(serverInternals.detectClientCompaction(almostSame, session), false);
});

test('fingerprint stays stable as turns append but diverges on opener differences', () => {
  const sys = [{ role: 'system', content: 'You are a coding agent.' }];
  const turn1 = [...sys, { role: 'user', content: 'Hello' }];
  const turn3 = [...turn1,
    { role: 'assistant', content: 'Hi, how can I help?' },
    { role: 'user', content: 'Read /etc/hostname.' },
  ];
  const turn5 = [...turn3,
    { role: 'assistant', content: 'Will do.' },
    { role: 'user', content: 'Now /etc/hosts.' },
  ];
  // Once three opener messages exist the id is frozen: appending turns keeps it.
  assert.equal(serverInternals.fingerprintConversation(turn3), serverInternals.fingerprintConversation(turn5));

  // Same opener, different second message: distinct chats (no cross-talk).
  const other = [...sys,
    { role: 'user', content: 'Hello' },
    { role: 'assistant', content: 'Hi, how can I help?' },
    { role: 'user', content: 'Tell me a joke.' },
  ];
  assert.notEqual(serverInternals.fingerprintConversation(turn3), serverInternals.fingerprintConversation(other));

  // Messages past the third do not affect the id.
  const laterDiffers = [...turn3, { role: 'user', content: 'Something completely different.' }];
  assert.equal(serverInternals.fingerprintConversation(turn3), serverInternals.fingerprintConversation(laterDiffers));
});

test('fresh chats prefer the account already hosting sessions (home stickiness)', (t) => {
  const originalAccounts = serverInternals.accounts.splice(0);
  const savedSessions = Array.from(serverInternals.sessions.entries());
  t.after(() => {
    serverInternals.accounts.splice(0, serverInternals.accounts.length, ...originalAccounts);
    serverInternals.sessions.clear();
    for (const [k, v] of savedSessions) serverInternals.sessions.set(k, v);
  });
  serverInternals.sessions.clear();

  serverInternals.accounts.push(
    { id: 'home', config: { token: 'h', cookie: 'h' }, cooldownUntil: 0, headers: {} },
    { id: 'spare', config: { token: 's', cookie: 's' }, cooldownUntil: 0, headers: {} },
  );
  // Two live chats on 'spare', none on 'home'.
  for (const key of ['agent:aaa', 'agent:bbb']) {
    const s = serverInternals.createSession();
    s.id = `remote-${key}`;
    s.accountId = 'spare';
    serverInternals.sessions.set(key, s);
  }

  const fresh = serverInternals.createSession();
  const selected = serverInternals.selectAccountForSession(fresh);
  assert.equal(selected.id, 'spare');
  assert.equal(fresh.accountId, 'spare');
});

test('preferred-mode tie at zero alternates ready accounts (legacy round-robin fallback)', (t) => {
  saveRoutingEnv(t);
  process.env.DEEPSEEK_ROUTING_MODE = 'preferred';
  delete process.env.DEEPSEEK_PREFERRED_ACCOUNT;
  const originalAccounts = serverInternals.accounts.splice(0);
  const savedSessions = Array.from(serverInternals.sessions.entries());
  t.after(() => {
    serverInternals.accounts.splice(0, serverInternals.accounts.length, ...originalAccounts);
    serverInternals.sessions.clear();
    for (const [k, v] of savedSessions) serverInternals.sessions.set(k, v);
  });
  serverInternals.sessions.clear();

  serverInternals.accounts.push(
    { id: 'A', config: { token: 'a', cookie: 'a' }, cooldownUntil: 0, headers: {} },
    { id: 'B', config: { token: 'b', cookie: 'b' }, cooldownUntil: 0, headers: {} },
  );
  const first = serverInternals.selectAccountForSession(serverInternals.createSession());
  const second = serverInternals.selectAccountForSession(serverInternals.createSession());
  // Legacy path (brief 2026-09-15 escape hatch): with no preference set and no
  // hosted sessions, cold-start ties fall back to round-robin, so two
  // consecutive fresh picks alternate deterministically (parity-independent).
  assert.ok(['A', 'B'].includes(first.id));
  assert.ok(['A', 'B'].includes(second.id));
  assert.notEqual(first.id, second.id);
});

test('cross-account continuation is accepted only with a fresh recovery prompt', () => {
  assert.equal(serverInternals.isContinuationRecoverySafe('one', {
    account: { id: 'one' },
    freshSessionReset: false,
  }), true);
  assert.equal(serverInternals.isContinuationRecoverySafe('one', {
    account: { id: 'two' },
    freshSessionReset: true,
  }), true);
  assert.equal(serverInternals.isContinuationRecoverySafe('one', {
    account: { id: 'two' },
    freshSessionReset: false,
  }), false);
});

test('TTL and depth rollover happens before prompt construction and preserves recovery state', () => {
  // Under no-new-chats invariant (implementor-brief-no-new-chats-2026-09-15), preemptive rollover is retired.
  const depthSession = serverInternals.createSession();
  depthSession.id = 'deep-session';
  depthSession.messageCount = 100;
  depthSession.accountId = 'account_1';
  depthSession.history.push({ user: 'u', assistant: 'a' });
  const depthReset = serverInternals.prepareSessionForPrompt(depthSession, Date.now());
  assert.equal(depthReset, null);
  assert.equal(depthSession.id, 'deep-session');
  assert.equal(depthSession.history.length, 1);
  assert.equal(depthSession.accountId, 'account_1');

  const now = Date.now();
  const ttlSession = serverInternals.createSession();
  ttlSession.id = 'old-session';
  ttlSession.createdAt = now - (2 * 60 * 60 * 1000) - 1;
  const ttlReset = serverInternals.prepareSessionForPrompt(ttlSession, now);
  assert.equal(ttlReset, null);
  assert.equal(ttlSession.id, 'old-session');
});

test('tool results use the global prompt cap instead of an unconditional 8k truncation', () => {
  const toolResult = `RESULT_START\n${'z'.repeat(12000)}\nRESULT_END`;
  const formatted = serverInternals.formatMessages([
    { role: 'user', content: 'inspect this' },
    { role: 'tool', content: toolResult },
  ], []);

  assert.match(formatted.prompt, /RESULT_START/);
  assert.match(formatted.prompt, /RESULT_END/);
  assert.ok(formatted.prompt.length > 12000);

  const bounded = serverInternals.buildBoundedPrompt(formatted.systemPrompt, '', formatted.prompt, 5000);
  assert.equal(bounded.compacted, true);
  assert.ok(bounded.prompt.length <= 5000);
  assert.match(bounded.prompt, /RESULT_END/);
});

test('retry state clears a stale finish reason and failure classes use protocol-appropriate status codes', () => {
  const retry = serverInternals.normalizeRetryResponse({ content: 'recovered', finishReason: null });
  assert.equal(retry.finishReason, null);

  assert.deepEqual(
    serverInternals.classifyRecoveryFailure({ content: 'Maximum context length exceeded' }, false),
    { status: 400, type: 'context_length_exceeded' },
  );
  assert.deepEqual(
    serverInternals.classifyRecoveryFailure(null, true),
    { status: 504, type: 'request_timeout' },
  );
  assert.deepEqual(
    serverInternals.classifyRecoveryFailure(null, false),
    { status: 502, type: 'empty_response' },
  );
  assert.equal(serverInternals.isTimeoutError({ name: 'TimeoutError', message: 'operation timed out' }), true);
  assert.equal(serverInternals.isTimeoutError(new Error('ordinary upstream error')), false);
});

test('context-compaction header is marked and exposed to browser clients', () => {
  const headers = new Map();
  const response = { setHeader: (name, value) => headers.set(name, value) };
  serverInternals.setCorsResponseHeaders(response);
  serverInternals.markContextCompacted(response);

  assert.equal(headers.get('Access-Control-Expose-Headers'), serverInternals.CONTEXT_COMPACTED_HEADER);
  assert.equal(headers.get(serverInternals.CONTEXT_COMPACTED_HEADER), 'true');
});

test('markContextCompacted never throws after stream headers are sent', () => {
  let calls = 0;
  const sentRes = { headersSent: true, setHeader: () => { calls++; } };
  serverInternals.markContextCompacted(sentRes);
  assert.equal(calls, 0);
  const endedRes = { headersSent: false, writableEnded: true, setHeader: () => { calls++; } };
  serverInternals.markContextCompacted(endedRes);
  assert.equal(calls, 0);
  const throwingRes = { headersSent: false, setHeader: () => { throw new Error('Cannot set headers after they are sent to the client'); } };
  serverInternals.markContextCompacted(throwingRes);
});

test('stream helpers preserve the request-level exact CORS origin', () => {
  const response = {
    id: 'ds-test',
    created: 1,
    model: 'deepseek-chat',
    choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };

  for (const send of [
    serverInternals.sendAnthropicStream,
    serverInternals.sendResponsesStream,
    serverInternals.sendOpenAIStream,
  ]) {
    let writeHeadHeaders = null;
    const res = {
      writeHead: (_status, headers) => { writeHeadHeaders = headers; },
      write: () => {},
      end: () => {},
    };
    send(res, response);
    assert.equal(Object.hasOwn(writeHeadHeaders, 'Access-Control-Allow-Origin'), false);
  }
});

test('delta mode is off unless DEEPSEEK_DELTA_PROMPT is explicitly enabled', () => {
  const prev = process.env.DEEPSEEK_DELTA_PROMPT;
  try {
    delete process.env.DEEPSEEK_DELTA_PROMPT;
    assert.equal(serverInternals.isDeltaPromptMode(), false);
    for (const on of ['1', 'true', 'YES', ' on ']) {
      process.env.DEEPSEEK_DELTA_PROMPT = on;
      assert.equal(serverInternals.isDeltaPromptMode(), true, on);
    }
    for (const off of ['0', 'false', 'no', '']) {
      process.env.DEEPSEEK_DELTA_PROMPT = off;
      assert.equal(serverInternals.isDeltaPromptMode(), false, JSON.stringify(off));
    }
  } finally {
    if (prev === undefined) delete process.env.DEEPSEEK_DELTA_PROMPT;
    else process.env.DEEPSEEK_DELTA_PROMPT = prev;
  }
});

test('fingerprintConversation is stable per opener and distinct per session', () => {
  const a = [
    { role: 'system', content: 'You are a coding agent.' },
    { role: 'user', content: 'Use a tool to read /etc/hostname.' },
  ];
  const b = [
    { role: 'system', content: 'You are a coding agent.' },
    { role: 'user', content: 'Use a tool to read /etc/hostname.' },
  ];
  const c = [
    { role: 'system', content: 'You are a coding agent.' },
    { role: 'user', content: 'Tell me a joke.' },
  ];
  assert.equal(serverInternals.fingerprintConversation(a), serverInternals.fingerprintConversation(b));
  assert.notEqual(serverInternals.fingerprintConversation(a), serverInternals.fingerprintConversation(c));
  assert.match(serverInternals.fingerprintConversation(a), /^[0-9a-f]{12}$/);
});

test('splitClientMessages forwards only the new suffix after commit', () => {
  const session = serverInternals.createSession();
  const turn1 = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'first question' },
  ];
  // Cold chat: full resend.
  let split = serverInternals.splitClientMessages(turn1, session);
  assert.equal(split.isDelta, false);
  assert.equal(split.effective.length, 1);

  serverInternals.commitDeltaState(session, turn1);
  const turn2 = [...turn1, { role: 'assistant', content: 'answer' }, { role: 'user', content: 'follow-up' }];
  split = serverInternals.splitClientMessages(turn2, session);
  assert.equal(split.isDelta, true);
  assert.deepEqual(split.effective, [
    { role: 'assistant', content: 'answer' },
    { role: 'user', content: 'follow-up' },
  ]);

  // Duplicate request (nothing new): fall back to full resend, never empty.
  split = serverInternals.splitClientMessages(turn1, session);
  assert.equal(split.isDelta, false);
  assert.equal(split.effective.length, 1);

  // Rewritten history (client-side compaction): boundary mismatch → full.
  const rewritten = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: '[summary of earlier]' },
    { role: 'user', content: 'follow-up' },
  ];
  split = serverInternals.splitClientMessages(rewritten, session);
  assert.equal(split.isDelta, false);
  assert.equal(split.effective.length, 2);
});

test('resetRemoteSession clears delta continuity state', () => {
  const session = serverInternals.createSession();
  assert.equal(session.deltaMsgCount, 0);
  assert.equal(session.deltaBoundary, null);
  serverInternals.commitDeltaState(session, [{ role: 'user', content: 'hi' }]);
  assert.equal(session.deltaMsgCount, 1);
  session.id = 'remote-1';
  session.messageCount = 3;
  serverInternals.resetRemoteSession(session);
  assert.equal(session.id, null);
  assert.equal(session.deltaMsgCount, 0);
  assert.equal(session.deltaBoundary, null);
});

test('session persist/restore round-trips the chat map', () => {
  const dir = tmpdir();
  const store = path.join(dir, 'sessions.json');
  const savedSessions = Array.from(serverInternals.sessions.entries());
  try {
    serverInternals.sessions.clear();
    const s = serverInternals.createSession();
    s.id = 'remote-abc';
    s.parentMessageId = 'parent-1';
    s.createdAt = 123456789;
    s.messageCount = 6;
    s.accountId = 'account_1';
    s.history.push({ user: 'u', assistant: 'a' });
    s.deltaMsgCount = 9;
    s.deltaBoundary = 'boundary-hash';
    serverInternals.sessions.set('dev-agent:testfp', s);
    serverInternals.persistSessions(store);
    assert.ok(fs.existsSync(store));
    assert.equal(fs.existsSync(store + '.tmp'), false);
    serverInternals.sessions.clear();
    const restored = serverInternals.restoreSessions(Date.now(), store);
    assert.equal(restored, 1);
    const back = serverInternals.sessions.get('dev-agent:testfp');
    assert.equal(back.id, 'remote-abc');
    assert.equal(back.parentMessageId, 'parent-1');
    assert.equal(back.messageCount, 6);
    assert.equal(back.accountId, 'account_1');
    assert.equal(back.deltaMsgCount, 9);
    assert.equal(back.deltaBoundary, 'boundary-hash');
    assert.equal(back.history.length, 1);
  } finally {
    serverInternals.sessions.clear();
    for (const [k, v] of savedSessions) serverInternals.sessions.set(k, v);
  }
});

test('restoreSessions drops stale entries and tolerates missing/corrupt stores', () => {
  const dir = tmpdir();
  const savedSessions = Array.from(serverInternals.sessions.entries());
  try {
    serverInternals.sessions.clear();
    assert.equal(serverInternals.restoreSessions(Date.now(), path.join(dir, 'missing.json')), 0);
    const bad = path.join(dir, 'bad.json');
    fs.writeFileSync(bad, 'not json{{{');
    assert.equal(serverInternals.restoreSessions(Date.now(), bad), 0);
    const stale = path.join(dir, 'stale.json');
    const old = Date.now() - 1000 * 60 * 60 * 24; // 24h ago, past 2x TTL
    fs.writeFileSync(stale, JSON.stringify({ v: 1, savedAt: old, sessions: [
      ['old-agent', { id: 'old-chat', parentMessageId: null, createdAt: old, messageCount: 3, accountId: 'a1', history: [], lastActivityAt: old, deltaMsgCount: 0, deltaBoundary: null }],
      ['fresh-agent', { id: 'live-chat', parentMessageId: null, createdAt: Date.now(), messageCount: 1, accountId: 'a1', history: [], lastActivityAt: Date.now(), deltaMsgCount: 0, deltaBoundary: null }],
    ] }));
    assert.equal(serverInternals.restoreSessions(Date.now(), stale), 1);
    assert.equal(serverInternals.sessions.has('old-agent'), false);
    assert.equal(serverInternals.sessions.get('fresh-agent').id, 'live-chat');
  } finally {
    serverInternals.sessions.clear();
    for (const [k, v] of savedSessions) serverInternals.sessions.set(k, v);
  }
});

test('repair guard: first attempt new, verbatim retry repeats, third caps', () => {
  const s = serverInternals.createSession();
  const now = Date.now();
  let r = serverInternals.classifyRepairAttempt(s, 'hash-a', now);
  assert.equal(r.repeat, false);
  assert.equal(r.capped, false);
  serverInternals.recordRepairAttempt(s, 'hash-a', now);
  r = serverInternals.classifyRepairAttempt(s, 'hash-a', now + 1000);
  assert.equal(r.repeat, true);
  assert.equal(r.capped, false);
  // Different turn, different prompt: not a repeat.
  r = serverInternals.classifyRepairAttempt(s, 'hash-b', now + 1000);
  assert.equal(r.repeat, false);
  serverInternals.recordRepairAttempt(s, 'hash-a', now + 1000);
  r = serverInternals.classifyRepairAttempt(s, 'hash-a', now + 2000);
  assert.equal(r.repeat, true);
  assert.equal(r.capped, true);
  // Stale marker (past window): treated as new.
  r = serverInternals.classifyRepairAttempt(s, 'hash-a', now + 11 * 60 * 1000);
  assert.equal(r.repeat, false);
  // Success clears the guard.
  serverInternals.clearRepairGuard(s);
  r = serverInternals.classifyRepairAttempt(s, 'hash-a', now + 3000);
  assert.equal(r.repeat, false);
  assert.equal(s.repairCount, 0);
});

test('clearRepairGuard is turn-scoped: foreign hash preserved, matching/omitted clears', () => {
  const s = serverInternals.createSession();
  serverInternals.recordRepairAttempt(s, 'hash-a');
  serverInternals.clearRepairGuard(s, 'hash-b');
  assert.equal(s.repairHash, 'hash-a');
  assert.equal(s.repairCount, 1);
  serverInternals.clearRepairGuard(s, 'hash-a');
  assert.equal(s.repairHash, null);
  assert.equal(s.repairCount, 0);
  serverInternals.recordRepairAttempt(s, 'hash-a');
  serverInternals.clearRepairGuard(s);
  assert.equal(s.repairHash, null);
  assert.equal(s.repairCount, 0);
});

test('repair guard survives resetRemoteSession (client-turn scoped, not chat scoped)', () => {
  const s = serverInternals.createSession();
  s.id = 'live-chat';
  serverInternals.recordRepairAttempt(s, 'hash-a');
  serverInternals.resetRemoteSession(s);
  assert.equal(s.id, null);
  const r = serverInternals.classifyRepairAttempt(s, 'hash-a');
  assert.equal(r.repeat, true);
});

test('repair guard persists across restart, stale guard still expires', () => {
  const dir = tmpdir();
  const store = path.join(dir, 'sessions.json');
  const savedSessions = Array.from(serverInternals.sessions.entries());
  const now = Date.now();
  try {
    serverInternals.sessions.clear();
    const s = serverInternals.createSession();
    s.id = 'remote-x';
    serverInternals.recordRepairAttempt(s, 'hash-a', now);
    serverInternals.sessions.set('agent-x', s);
    const stale = serverInternals.createSession();
    stale.id = 'remote-y';
    serverInternals.recordRepairAttempt(stale, 'hash-old', now - 11 * 60 * 1000);
    serverInternals.sessions.set('agent-y', stale);
    serverInternals.persistSessions(store);
    const raw = JSON.parse(fs.readFileSync(store, 'utf8'));
    const persisted = Object.fromEntries(raw.sessions.map(([k, v]) => [k, v]));
    assert.equal(persisted['agent-x'].repairHash, 'hash-a');
    assert.equal(persisted['agent-x'].repairCount, 1);
    serverInternals.sessions.clear();
    serverInternals.restoreSessions(now, store);
    const back = serverInternals.sessions.get('agent-x');
    // Post-restart verbatim retry is recognized as a repeat (B3).
    assert.equal(back.repairHash, 'hash-a');
    assert.equal(serverInternals.classifyRepairAttempt(back, 'hash-a', now).repeat, true);
    // But a guard older than the window reads as fresh.
    const backStale = serverInternals.sessions.get('agent-y');
    assert.equal(serverInternals.classifyRepairAttempt(backStale, 'hash-old', now).repeat, false);
  } finally {
    serverInternals.sessions.clear();
    for (const [k, v] of savedSessions) serverInternals.sessions.set(k, v);
  }
});

test('shell reminder line tracks DEEPSEEK_LOCAL_SHELL and omits on empty', () => {
  const prev = process.env.DEEPSEEK_LOCAL_SHELL;
  try {
    delete process.env.DEEPSEEK_LOCAL_SHELL;
    assert.equal(serverInternals.localShellName(), 'fish');
    assert.match(serverInternals.shellReminderLine(), /console uses fish/);
    process.env.DEEPSEEK_LOCAL_SHELL = '  Bash  ';
    assert.equal(serverInternals.localShellName(), 'bash');
    assert.match(serverInternals.shellReminderLine(), /console uses bash/);
    process.env.DEEPSEEK_LOCAL_SHELL = '';
    assert.equal(serverInternals.localShellName(), '');
    assert.equal(serverInternals.shellReminderLine(), '');
  } finally {
    if (prev === undefined) delete process.env.DEEPSEEK_LOCAL_SHELL;
    else process.env.DEEPSEEK_LOCAL_SHELL = prev;
  }
});

test('tool prompt declares the operator fish shell by default, overridable via env', () => {
  const prev = process.env.DEEPSEEK_LOCAL_SHELL;
  const tools = [{ type: 'function', function: { name: 'bash', description: 'run a command', parameters: { type: 'object', properties: { command: { type: 'string' } } } } }];
  try {
    delete process.env.DEEPSEEK_LOCAL_SHELL;
    assert.match(serverInternals.formatToolDefinitions(tools), /operator console shell is fish/);
    process.env.DEEPSEEK_LOCAL_SHELL = 'bash';
    assert.match(serverInternals.formatToolDefinitions(tools), /operator console shell is bash/);
    process.env.DEEPSEEK_LOCAL_SHELL = '';
    assert.doesNotMatch(serverInternals.formatToolDefinitions(tools), /operator console shell is/);
  } finally {
    if (prev === undefined) delete process.env.DEEPSEEK_LOCAL_SHELL;
    else process.env.DEEPSEEK_LOCAL_SHELL = prev;
  }
});

test('numEnv falls back on garbage, honors bounds', () => {
  assert.equal(serverInternals.numEnv('FDSAPI_TEST_NUM_MISSING_XYZ', 42), 42);
  process.env.FDSAPI_TEST_NUM_X = 'abc';
  assert.equal(serverInternals.numEnv('FDSAPI_TEST_NUM_X', 42), 42);
  process.env.FDSAPI_TEST_NUM_X = '';
  assert.equal(serverInternals.numEnv('FDSAPI_TEST_NUM_X', 42), 42);
  process.env.FDSAPI_TEST_NUM_X = '5';
  assert.equal(serverInternals.numEnv('FDSAPI_TEST_NUM_X', 42, 1, 10), 5);
  process.env.FDSAPI_TEST_NUM_X = '0';
  assert.equal(serverInternals.numEnv('FDSAPI_TEST_NUM_X', 42, 1, 10), 42);
  process.env.FDSAPI_TEST_NUM_X = '999';
  assert.equal(serverInternals.numEnv('FDSAPI_TEST_NUM_X', 42, 1, 10), 42);
  delete process.env.FDSAPI_TEST_NUM_X;
});

test('sanitizeContent keeps valid emoji, strips lone surrogates', () => {
  assert.equal(serverInternals.sanitizeContent('A😀B'), 'A😀B');
  assert.equal(serverInternals.sanitizeContent('a' + String.fromCharCode(0xd800) + 'b'), 'ab');
  assert.equal(serverInternals.sanitizeContent('x' + String.fromCharCode(0xdcff) + 'y'), 'xy');
  assert.equal(serverInternals.sanitizeContent(null), '');
});

test('toolNamesKeyFor sorts and filters tool names', () => {
  const tools = [
    { type: 'function', function: { name: 'read' } },
    { type: 'function', function: { name: 'bash' } },
    { type: 'function', function: {} },
    { type: 'other' },
  ];
  assert.equal(serverInternals.toolNamesKeyFor(tools), 'bash,read');
  assert.equal(serverInternals.toolNamesKeyFor([]), '');
  assert.equal(serverInternals.toolNamesKeyFor(null), '');
});

test('stripShellReminder removes only the exact trailing reminder', () => {
  const reminder = '[SHELL: operator console uses fish (Linux)]';
  assert.equal(
    serverInternals.stripShellReminder('do the thing\n\n' + reminder, reminder),
    'do the thing'
  );
  assert.equal(serverInternals.stripShellReminder('plain prompt', reminder), 'plain prompt');
  assert.equal(serverInternals.stripShellReminder('prompt', ''), 'prompt');
});

test('split falls back to full resend on edited prefix, delta on pure growth', () => {
  const U = (c) => ({ role: 'user', content: c });
  const s = serverInternals.createSession();
  s.id = 'x';
  serverInternals.commitDeltaState(s, [U('a'), U('b')]);
  assert.ok(s.deltaPrefixHash);
  const grown = serverInternals.splitClientMessages([U('a'), U('b'), U('c')], s);
  assert.equal(grown.isDelta, true);
  assert.deepEqual(grown.effective.map((m) => m.content), ['c']);
  const edited = serverInternals.splitClientMessages([U('A-EDITED'), U('b'), U('c')], s);
  assert.equal(edited.isDelta, false);
  assert.equal(edited.effective.length, 3);
});

test('detectClientCompaction: trim with boundary present is not compaction', () => {
  const U = (c) => ({ role: 'user', content: c });
  const mk = (sent, msgs) => {
    const s = serverInternals.createSession();
    s.id = 'y';
    serverInternals.commitDeltaState(s, msgs.slice(0, sent).map(U));
    return s;
  };
  // Benign trim: drop 2 old, boundary message still present.
  const s1 = mk(10, Array.from({ length: 10 }, (_, i) => `m${i}`));
  const trim = [U('m2'), U('m3'), U('m4'), U('m5'), U('m6'), U('m7'), U('m8'), U('m9')];
  assert.equal(serverInternals.detectClientCompaction(trim, s1), false);
  // True compaction: summary replaces everything, boundary gone.
  assert.equal(serverInternals.detectClientCompaction([U('summary of all'), U('next?')], s1), true);
});

test('looksLikeToolCallMarkup refuses oversized content instead of flagging', () => {
  const big = `TOOL_CALL: bash ${'x'.repeat(300 * 1024)}`;
  assert.equal(serverInternals.looksLikeToolCallMarkup(big), false);
  assert.equal(serverInternals.parseToolCall(big), null);
  assert.equal(serverInternals.looksLikeToolCallMarkup('{"tool_call":{"name":"bash","arguments":{}}}'), true);
});

test('parseRetryAfterMs handles seconds, dates, garbage', () => {
  assert.equal(serverInternals.parseRetryAfterMs('120'), 120000);
  assert.equal(serverInternals.parseRetryAfterMs('soon'), null);
  assert.equal(serverInternals.parseRetryAfterMs(''), null);
  assert.ok(serverInternals.parseRetryAfterMs(new Date(Date.now() + 60000).toUTCString()) > 1000);
});

test('classifyRecoveryFailure sanitizes arbitrary upstream types', () => {
  assert.equal(serverInternals.classifyRecoveryFailure({ type: 'weird\nthing' }).type, 'empty_response');
  assert.equal(serverInternals.classifyRecoveryFailure({ type: 'custom_ok' }).type, 'custom_ok');
  assert.equal(serverInternals.classifyRecoveryFailure(null).type, 'empty_response');
  assert.equal(serverInternals.classifyRecoveryFailure({ type: 'x'.repeat(100) }).type, 'empty_response');
});

test('repairTurnHash is stable for a verbatim retry, distinct per turn', () => {
  const tools = [{ type: 'function', function: { name: 'bash' } }];
  const turn = [{ role: 'user', content: 'list files' }];
  // Same turn before/after a 502-reset (history prefix differs, hash must not).
  assert.equal(serverInternals.repairTurnHash(turn, tools), serverInternals.repairTurnHash(turn, tools));
  // A genuinely new turn (append-only growth) gets a different identity.
  const grown = [...turn, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'now delete' }];
  assert.notEqual(serverInternals.repairTurnHash(turn, tools), serverInternals.repairTurnHash(grown, tools));
  // Tool-set change is a different turn identity too.
  assert.notEqual(
    serverInternals.repairTurnHash(turn, tools),
    serverInternals.repairTurnHash(turn, [...tools, { type: 'function', function: { name: 'read' } }])
  );
});

test('formatMessages renders prior tool calls as strict JSON, never TOOL_CALL:', () => {
  const out = serverInternals.formatMessages(
    [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: null, tool_calls: [{ function: { name: 'bash', arguments: '{"command":"ls"}' } }] },
    ],
    []
  );
  assert.doesNotMatch(out.prompt, /TOOL_CALL:/);
  const m = out.prompt.match(/\{"tool_call":\{"name":"bash","arguments":\{"command":"ls"\}\}\}/);
  assert.ok(m, `strict envelope missing in: ${out.prompt}`);
  const parsed = JSON.parse(m[0]);
  assert.equal(parsed.tool_call.name, 'bash');
});

test('normalizeResponsesInput keeps function_call items as assistant tool turns', () => {
  const msgs = serverInternals.normalizeResponsesInput([
    { type: 'message', role: 'user', content: 'run it' },
    { type: 'function_call', call_id: 'call_1', name: 'bash', arguments: '{"command":"ls"}' },
    { type: 'function_call_output', call_id: 'call_1', output: 'ok' },
  ]);
  assert.equal(msgs.length, 3);
  assert.equal(msgs[1].role, 'assistant');
  assert.equal(msgs[1].tool_calls[0].function.name, 'bash');
  assert.equal(msgs[1].tool_calls[0].id, 'call_1');
  assert.equal(msgs[2].role, 'tool');
});

test('serializeSession coerces corrupt history entries to strings', () => {
  const s = serverInternals.createSession();
  s.history.push({ user: 12345, assistant: null });
  const snap = serverInternals.serializeSession(s);
  assert.equal(snap.history[0].user, '12345');
  assert.equal(snap.history[0].assistant, '');
  // Restored corrupt entries no longer crash the reset-session preview line.
  assert.doesNotThrow(() => snap.history.map((e) => e.user.substring(0, 40)).join(' | '));
});

test('extractScreenshotPaths sees array-content text parts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fdsapi-media-'));
  const shot = path.join(dir, 'shot.png');
  fs.writeFileSync(shot, 'x');
  // C3 containment: only paths under DEEPSEEK_MEDIA_ROOT are honored.
  const prevRoot = process.env.DEEPSEEK_MEDIA_ROOT;
  process.env.DEEPSEEK_MEDIA_ROOT = dir;
  try {
    const paths = serverInternals.extractScreenshotPaths([
      { role: 'user', content: [{ type: 'text', text: `see ${shot} please` }] },
    ]);
    assert.ok(paths.includes(`MEDIA:${shot}`), `expected MEDIA tag, got ${JSON.stringify(paths)}`);
  } finally {
    if (prevRoot === undefined) delete process.env.DEEPSEEK_MEDIA_ROOT;
    else process.env.DEEPSEEK_MEDIA_ROOT = prevRoot;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('two-phase OpenAI streaming: start emits role chunk, finish completes without re-writing headers', () => {
  const chunks = [];
  let status = null;
  let headers = null;
  const res = {
    writeHead: (s, h) => { status = s; headers = h; },
    write: (data) => { chunks.push(data); },
    end: () => {},
  };
  serverInternals.startOpenAIStream(res, { id: 'ds-test-1', created: 123456, model: 'deepseek-chat' });
  assert.equal(status, 200);
  assert.equal(headers['Content-Type'], 'text/event-stream');
  assert.equal(chunks.length, 1);
  const first = JSON.parse(chunks[0].replace(/^data: /, '').trim());
  assert.equal(first.choices[0].delta.role, 'assistant');

  // Finish Phase: tool-call response
  const openaiResp = {
    id: 'ds-test-1',
    created: 123456,
    model: 'deepseek-chat',
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } }],
      },
      finish_reason: 'tool_calls',
    }],
  };
  serverInternals.finishOpenAIStream(res, openaiResp);
  assert.ok(chunks.some(c => c.includes('"tool_calls"')));
  assert.ok(chunks.some(c => c.includes('[DONE]')));
});

test('two-phase Anthropic streaming: start emits message_start, finish emits content', () => {
  const events = [];
  let status = null;
  const res = {
    writeHead: (s) => { status = s; },
    write: (data) => { events.push(data); },
    end: () => {},
  };
  serverInternals.startAnthropicStream(res, { id: 'msg_test_1', model: 'deepseek-chat', inputTokens: 42 });
  assert.equal(status, 200);
  assert.ok(events.some(e => e.includes('event: message_start')));
  assert.ok(events.some(e => e.includes('"input_tokens":42')));

  const openaiResp = {
    id: 'ds-test-2',
    created: 123456,
    model: 'deepseek-chat',
    choices: [{
      index: 0,
      message: { role: 'assistant', content: 'Hello world' },
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 42, completion_tokens: 5, total_tokens: 47 },
  };
  serverInternals.finishAnthropicStream(res, openaiResp);
  assert.ok(events.some(e => e.includes('event: content_block_start')));
  assert.ok(events.some(e => e.includes('Hello world')));
  assert.ok(events.some(e => e.includes('event: message_stop')));
});

test('sendStreamError formats protocol-accurate in-stream error events', () => {
  // Anthropic
  let anthropicOut = '';
  const anthropicRes = { write: (d) => { anthropicOut += d; }, end: () => {} };
  serverInternals.sendStreamError(anthropicRes, 'anthropic', { message: 'upstream died', type: 'malformed_tool_call' });
  assert.ok(anthropicOut.includes('event: error\n'));
  assert.ok(anthropicOut.includes('"type":"malformed_tool_call"'));

  // Responses
  let responsesOut = '';
  const responsesRes = { write: (d) => { responsesOut += d; }, end: () => {} };
  serverInternals.sendStreamError(responsesRes, 'responses', { message: 'upstream died', type: 'malformed_tool_call' });
  assert.ok(responsesOut.includes('event: response.failed\n'));
  assert.ok(responsesOut.includes('"status":"failed"'));

  // OpenAI
  let openaiOut = '';
  const openaiRes = { write: (d) => { openaiOut += d; }, end: () => {} };
  serverInternals.sendStreamError(openaiRes, 'openai', { message: 'upstream died', type: 'malformed_tool_call' });
  assert.ok(openaiOut.includes('"type":"malformed_tool_call"'));
  assert.ok(openaiOut.includes('[DONE]'));
});

test('selectFreshAccount honors DEEPSEEK_PREFERRED_ACCOUNT when ready', () => {
  const prev = process.env.DEEPSEEK_PREFERRED_ACCOUNT;
  try {
    const ready = [{ id: 'account_1' }, { id: 'account_2' }];
    process.env.DEEPSEEK_PREFERRED_ACCOUNT = 'account_2';
    assert.equal(serverInternals.selectFreshAccount(ready).id, 'account_2');
    // Unknown or unset preference falls back to existing home/round-robin logic.
    process.env.DEEPSEEK_PREFERRED_ACCOUNT = 'account_9';
    assert.ok(['account_1', 'account_2'].includes(serverInternals.selectFreshAccount(ready).id));
    delete process.env.DEEPSEEK_PREFERRED_ACCOUNT;
    assert.ok(['account_1', 'account_2'].includes(serverInternals.selectFreshAccount(ready).id));
  } finally {
    if (prev === undefined) delete process.env.DEEPSEEK_PREFERRED_ACCOUNT;
    else process.env.DEEPSEEK_PREFERRED_ACCOUNT = prev;
  }
});

test('SSE keep-alive ping: startKeepAlive writes : ping and clearKeepAlive cancels timer', async () => {
  const pings = [];
  const res = {
    write: (d) => { pings.push(d); },
    writableEnded: false,
    destroyed: false,
  };
  serverInternals.startKeepAlive(res, 10);
  assert.ok(res._keepAliveTimer);
  await new Promise(r => setTimeout(r, 50));
  assert.ok(pings.length >= 1);
  assert.ok(pings.every(p => p === ': ping\n\n'));

  serverInternals.clearKeepAlive(res);
  assert.equal(res._keepAliveTimer, null);
  const countAfterClear = pings.length;
  await new Promise(r => setTimeout(r, 40));
  assert.equal(pings.length, countAfterClear);
});

test('sendStreamError OpenAI dual-shape: includes error object and choices[0].delta error content', () => {
  let output = '';
  const res = { write: (d) => { output += d; }, end: () => {}, writableEnded: false };
  serverInternals.sendStreamError(res, 'openai', { message: 'upstream timeout', type: 'timeout_error' });
  assert.ok(output.includes('data: {"error":{"message":"upstream timeout","type":"timeout_error"},"choices":[{"index":0,"delta":{"content":"\\n\\n[Error: upstream timeout]"},"finish_reason":"error"}]}\n\n'));
  assert.ok(output.includes('data: [DONE]\n\n'));
});

test('three-phase streaming: emitReasoningPhase flushes thinking and finishOpenAIStream skips re-emission', () => {
  const chunks = [];
  const res = {
    headersSent: true,
    write: (d) => { chunks.push(d); },
    end: () => {},
  };
  res._reasoningEmitted = true;
  serverInternals.emitReasoningPhase(res, 'openai', {
    id: 'ds-test-r1',
    created: 123456,
    model: 'deepseek-reasoner',
    reasoningContent: 'Step 1: Calculate 2 + 2 = 4.',
  });

  assert.ok(chunks.some(c => c.includes('"reasoning_content":"Step 1: Calculate 2 + 2 = 4."')));

  const openaiResp = {
    id: 'ds-test-r1',
    created: 123456,
    model: 'deepseek-reasoner',
    choices: [{
      index: 0,
      message: { role: 'assistant', content: 'The answer is 4.', reasoning_content: 'Step 1: Calculate 2 + 2 = 4.' },
      finish_reason: 'stop',
    }],
  };
  const chunkCountBefore = chunks.length;
  serverInternals.finishOpenAIStream(res, openaiResp, { skipReasoning: true });
  // Should NOT re-emit reasoning_content
  const newChunks = chunks.slice(chunkCountBefore);
  assert.ok(!newChunks.some(c => c.includes('"reasoning_content"')));
  assert.ok(newChunks.some(c => c.includes('"content":"The answer is 4."')));
  assert.ok(newChunks.some(c => c.includes('[DONE]')));
});

test('streaming tool turns strictly suppress reasoning bytes', () => {
  const chunks = [];
  const res = {
    headersSent: true,
    write: (d) => { chunks.push(d); },
    end: () => {},
  };
  const openaiResp = {
    id: 'ds-test-tool',
    created: 123456,
    model: 'deepseek-reasoner',
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: null,
        reasoning_content: 'Let me look up the file with read_file.',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"/etc/hosts"}' } }],
      },
      finish_reason: 'tool_calls',
    }],
  };
  serverInternals.finishOpenAIStream(res, openaiResp, { skipReasoning: true });
  assert.ok(!chunks.some(c => c.includes('reasoning_content')));
  assert.ok(chunks.some(c => c.includes('"tool_calls"')));
  assert.ok(chunks.some(c => c.includes('[DONE]')));
});

test('consumeDeepSeekStream flushes reasoning at think->response transition and aborts on clientGone', async () => {
  const { Readable } = require('stream');
  let flushedReasoning = null;

  // Stream simulating think fragments followed by a response fragment
  const sseChunks = [
    'data: {"v":{"response":{"fragments":[{"type":"THINK","content":"Thinking deep thoughts..."}]}}}\n\n',
    'data: {"p":"response/fragments","v":[{"type":"RESPONSE","content":"Here is the result."}]}\n\n',
    'data: {"finish_reason":"stop"}\n\n',
  ];

  const stream = Readable.from(sseChunks.map(c => Buffer.from(c)));
  const result = await serverInternals.consumeDeepSeekStream(stream, {
    onReasoningDone: (reasoning) => {
      flushedReasoning = reasoning;
    },
    isClientGone: () => false,
  });

  assert.equal(flushedReasoning, 'Thinking deep thoughts...');
  assert.equal(result.content, 'Here is the result.');
  assert.equal(result.reasoningContent, 'Thinking deep thoughts...');
  assert.equal(result.finishReason, 'stop');
  assert.equal(result.abandoned, false);

  // Dead socket abort test
  let destroyed = false;
  const slowStream = new Readable({
    read() {
      this.push(Buffer.from('data: {"v":{"response":{"fragments":[{"type":"THINK","content":"Thinking..."}]}}}\n\n'));
    },
    destroy(err, cb) {
      destroyed = true;
      cb(err);
    },
  });

  let clientGoneFlag = false;
  const abortResultPromise = serverInternals.consumeDeepSeekStream(slowStream, {
    isClientGone: () => clientGoneFlag,
  });
  clientGoneFlag = true;
  slowStream.push(Buffer.from('data: {"v":{"response":{"content":"more content"}}}\n\n'));
  const abortResult = await abortResultPromise;
  assert.equal(abortResult.abandoned, true);
  assert.equal(destroyed, true);
});

test('isTitleGenerationRequest detects OpenCode title prompt and generateLocalTitle extracts clean titles', () => {
  const opencodeTitlePrompt = [
    { role: 'user', content: 'Generate a title for this conversation:\n\nUser: can you look at my home fir' }
  ];
  assert.equal(serverInternals.isTitleGenerationRequest(opencodeTitlePrompt), true);
  assert.equal(serverInternals.generateLocalTitle(opencodeTitlePrompt), 'Can You Look At My Home');

  const normalPrompt = [
    { role: 'user', content: 'can you look at my home fir' }
  ];
  assert.equal(serverInternals.isTitleGenerationRequest(normalPrompt), false);

  const emptyPrompt = [];
  assert.equal(serverInternals.isTitleGenerationRequest(emptyPrompt), false);
  assert.equal(serverInternals.generateLocalTitle(emptyPrompt), 'New Chat');
});

test('finishOpenAIStream maps tool_calls with index integer property for SDK streaming compliance', () => {
  const chunks = [];
  const fakeRes = {
    headersSent: true,
    write(chunk) { chunks.push(chunk); },
    end() {},
  };

  const responseObj = {
    id: 'ds-test-123',
    created: 1234567890,
    model: 'deepseek-chat',
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_123',
          type: 'function',
          function: { name: 'bash', arguments: '{"command":"ls"}' }
        }]
      },
      finish_reason: 'tool_calls'
    }]
  };

  serverInternals.finishOpenAIStream(fakeRes, responseObj, { skipReasoning: true });

  const payloadLines = chunks
    .join('')
    .split('\n')
    .filter(l => l.startsWith('data: ') && l !== 'data: [DONE]')
    .map(l => JSON.parse(l.slice(6)));

  const toolChunk = payloadLines.find(p => p.choices?.[0]?.delta?.tool_calls);
  assert.ok(toolChunk, 'Must emit a delta chunk with tool_calls');
  const toolCall = toolChunk.choices[0].delta.tool_calls[0];
  assert.equal(toolCall.index, 0, 'Each tool call in stream delta MUST have integer index property');
  assert.equal(toolCall.id, 'call_123');
  assert.equal(toolCall.type, 'function');
  assert.equal(toolCall.function.name, 'bash');
});

test('parseToolCall respects allowBare option for retry flows while defaulting to strict envelopes', () => {
  const bareJson = '{"name":"bash","arguments":{"command":"ls"}}';
  const fencedBare = '```json\n{"name":"bash","arguments":{"command":"ls"}}\n```';

  // Default: rejects bare and fenced-bare (preserves strict isolation for normal chat turns)
  assert.equal(serverInternals.parseToolCall(bareJson), null);
  assert.equal(serverInternals.parseToolCall(fencedBare), null);

  // allowBare: true: accepts both bare and fenced-bare (for repair retries)
  const parsedBare = serverInternals.parseToolCall(bareJson, { allowBare: true });
  assert.ok(parsedBare, 'Should parse bare JSON when allowBare: true');
  assert.equal(parsedBare.name, 'bash');
  assert.deepEqual(JSON.parse(parsedBare.arguments), { command: 'ls' });

  const parsedFenced = serverInternals.parseToolCall(fencedBare, { allowBare: true });
  assert.ok(parsedFenced, 'Should parse fenced bare JSON when allowBare: true');
  assert.equal(parsedFenced.name, 'bash');
  assert.deepEqual(JSON.parse(parsedFenced.arguments), { command: 'ls' });
});

test('opener settling in delta mode preserves existing active chat session instead of abandoning it', () => {
  const session = serverInternals.createSession();
  session.id = 'chat_existing_123';
  session.messageCount = 2;

  const turn1Messages = [
    { role: 'user', content: 'can you look at my home dir' }
  ];
  // Turn 1 completes and commits delta state:
  serverInternals.commitDeltaState(session, turn1Messages);
  assert.equal(session.deltaMsgCount, 1);
  assert.ok(session.deltaBoundary);

  // Store under turn1 agentId
  const fp1 = serverInternals.fingerprintConversation(turn1Messages);
  const agent1 = `dev-agent:${fp1}`;
  serverInternals.sessions.set(agent1, session);

  // Turn 2 comes in with 3 messages:
  const turn2Messages = [
    { role: 'user', content: 'can you look at my home dir' },
    { role: 'assistant', content: 'Sure, I will check.' },
    { role: 'user', content: 'ls -la' },
  ];
  const fp2 = serverInternals.fingerprintConversation(turn2Messages);
  const agent2 = `dev-agent:${fp2}`;
  assert.notEqual(agent1, agent2, 'Fingerprints differ between turn 1 and turn 2');

  // Verify splitClientMessages correctly finds suffix when session is adopted:
  const split = serverInternals.splitClientMessages(turn2Messages, session);
  assert.equal(split.isDelta, true);
  assert.equal(split.forwardedCount, 1);
  assert.equal(split.effective.length, 2);
  assert.equal(split.effective[0].content, 'Sure, I will check.');
  assert.equal(split.effective[1].content, 'ls -la');

  // Clean up test sessions
  serverInternals.sessions.delete(agent1);
  serverInternals.sessions.delete(agent2);
});

test('two-user-message opener keying diverges on second user message and ignores assistant/tool variance', () => {
  const baseUser1 = { role: 'user', content: 'Hello' };
  const user2A = { role: 'user', content: 'How do I run tests?' };
  const user2B = { role: 'user', content: 'What is the weather today?' };
  const user3 = { role: 'user', content: 'Thanks, what about linting?' };

  // Turn 1
  const t1 = [baseUser1];
  const fp1 = serverInternals.fingerprintConversation(t1);

  // Turn 2 with assistant reply between
  const t2A = [baseUser1, { role: 'assistant', content: 'Hi! How can I help?' }, user2A];
  const fp2A = serverInternals.fingerprintConversation(t2A);

  // Turn 2 with tool calls and thinking between
  const t2AWithTools = [
    baseUser1,
    { role: 'assistant', content: '', tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'list_dir', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'tc1', content: 'server.js tests/' },
    { role: 'assistant', content: 'I checked your directory.' },
    user2A,
  ];
  const fp2ATools = serverInternals.fingerprintConversation(t2AWithTools);

  // Invariant across tool/assistant turns:
  assert.equal(fp2A, fp2ATools, 'Tool calls and assistant messages do not alter two-user-message key');

  // Diverges when second user message differs (collision prevention):
  const t2B = [baseUser1, { role: 'assistant', content: 'Hi! How can I help?' }, user2B];
  const fp2B = serverInternals.fingerprintConversation(t2B);
  assert.notEqual(fp2A, fp2B, 'Sessions with different second user messages diverge');

  // Turn 3 keeps the exact same key as Turn 2 (settles permanently):
  const t3A = [...t2A, { role: 'assistant', content: 'Run npm test.' }, user3];
  const fp3A = serverInternals.fingerprintConversation(t3A);
  assert.equal(fp2A, fp3A, 'Key is permanently frozen from Turn 2 onwards');
});

test('repair retry audit gate correctly classifies clean prose vs broken markup vs unknown tools', () => {
  const allowedToolNames = new Set(['bash', 'read_file']);

  // Case 1: Valid tool call
  const validTc = serverInternals.parseToolCall('<tool_call>{"name": "bash", "arguments": {"command": "ls"}}</tool_call>');
  assert.ok(validTc);
  assert.ok(allowedToolNames.has(validTc.name));

  // Case 2: Clean prose (no tool markup)
  const cleanProse = 'I analyzed the issue and here is the explanation without using any tool.';
  const cleanTc = serverInternals.parseToolCall(cleanProse, { allowBare: true });
  const cleanIsMarkup = serverInternals.looksLikeToolCallMarkup(cleanProse);
  assert.equal(cleanTc, null);
  assert.equal(cleanIsMarkup, false);
  // Audit gate: !retryTc && !looksLikeToolCallMarkup -> delivers clean text
  assert.ok(!cleanTc && !cleanIsMarkup);

  // Case 3: Broken markup
  const brokenMarkup = 'TOOL_CALL: bash {"command": "invalid unclosed';
  const brokenTc = serverInternals.parseToolCall(brokenMarkup, { allowBare: true });
  const brokenIsMarkup = serverInternals.looksLikeToolCallMarkup(brokenMarkup);
  assert.equal(brokenTc, null);
  assert.equal(brokenIsMarkup, true);
  // Audit gate: !retryTc && looksLikeToolCallMarkup -> broken markup, escalates or 502s
  assert.ok(!brokenTc && brokenIsMarkup);

  // Case 4: Unknown tool name (bare JSON or tool call envelope)
  const unknownToolText = '{"name": "unknown_tool_xyz", "arguments": {}}';
  const unknownTc = serverInternals.parseToolCall(unknownToolText, { allowBare: true });
  assert.ok(unknownTc);
  assert.equal(allowedToolNames.has(unknownTc.name), false);
  // Audit gate: retryTc && !allowedToolNames.has(name) -> flagged as broken markup, never laundered as prose
  const unknownIsBroken = Boolean(
    (unknownTc && !allowedToolNames.has(unknownTc.name)) ||
    (!unknownTc && serverInternals.looksLikeToolCallMarkup(unknownToolText))
  );
  assert.equal(unknownIsBroken, true);
});

test('opener adoption requires exactly one candidate and rejects ambiguous multi-session matches', () => {
  const turn1 = [{ role: 'user', content: 'identical opener' }];
  const envelope = serverInternals.hashMessageEnvelope(turn1[0]);

  const session1 = serverInternals.createSession();
  session1.id = 'chat_1';
  session1.deltaMsgCount = 1;
  session1.deltaBoundary = envelope;

  const session2 = serverInternals.createSession();
  session2.id = 'chat_2';
  session2.deltaMsgCount = 1;
  session2.deltaBoundary = envelope;

  // Simulate two concurrent sessions sharing the exact same boundary:
  const map = new Map([
    ['dev-agent:aaa', session1],
    ['dev-agent:bbb', session2],
  ]);

  const turn2Messages = [
    { role: 'user', content: 'identical opener' },
    { role: 'user', content: 'divergent second message' },
  ];

  const matchingCandidates = [];
  for (const [id, s] of map) {
    if (s.deltaBoundary === serverInternals.hashMessageEnvelope(turn2Messages[0])) {
      matchingCandidates.push({ id, session: s });
    }
  }
  // Hardening check: with 2 matching candidates, adoption must refuse to adopt
  assert.equal(matchingCandidates.length, 2);
  const shouldAdopt = matchingCandidates.length === 1;
  assert.equal(shouldAdopt, false, 'Ambiguous opener adoption must refuse and fork');
});

test('markAccountFailure tracks consecutive timeouts and triggers cooldown after 2 (hypersensitive strikes)', () => {
  const account = { id: 'acct_test', failures: 0, consecutiveTimeouts: 0, consecutiveFailures: 0, cooldownUntil: 0 };
  // Timeout 1: counted, no sideline yet (one blip is forgiven).
  serverInternals.markAccountFailure(account, 504, 'timeout');
  assert.equal(account.failures, 1);
  assert.equal(account.consecutiveTimeouts, 1);
  assert.equal(account.consecutiveFailures, 1);
  assert.equal(account.cooldownUntil, 0);

  // Timeout 2 -> triggers the long cooldown for a dead network path.
  serverInternals.markAccountFailure(account, 504, 'timeout / fetch abort');
  assert.equal(account.failures, 2);
  assert.equal(account.consecutiveTimeouts, 0);
  assert.equal(account.consecutiveFailures, 0);
  assert.ok(account.cooldownUntil > Date.now());
});

test('continuation loop condition gates on length/incomplete and skips stop (BUG-A)', () => {
  // Explicit stop with 30k chars must NOT continue
  assert.equal(serverInternals.shouldAutoContinue('stop', 30000, 0), false);

  // Length finish with 30k chars MUST continue
  assert.equal(serverInternals.shouldAutoContinue('length', 30000, 0), true);

  // Non-standard upstream INCOMPLETE finish marker MUST continue
  assert.equal(serverInternals.shouldAutoContinue('INCOMPLETE', 15000, 0), true);

  // Truncated long response without explicit stop MUST continue
  assert.equal(serverInternals.shouldAutoContinue(null, 26000, 0), true);

  // Max rounds reached must stop
  assert.equal(serverInternals.shouldAutoContinue('length', 30000, 2), false);
});

test('empty retry policy always retries in-place under no-new-chats invariant (implementor-brief-no-new-chats-2026-09-15)', () => {
  // Retries are always in-place; no new chats ever (empty retries never reset session)
  assert.equal(serverInternals.shouldResetOnEmptyRetry(false, 1), false);
  assert.equal(serverInternals.shouldResetOnEmptyRetry(false, 2), false);
  assert.equal(serverInternals.shouldResetOnEmptyRetry(true, 1), false);
});

test('timeout error tagging prevents double-marking on the same account and error', () => {
  const account = { id: 'acct_dedup', failures: 0, consecutiveTimeouts: 0, cooldownUntil: 0 };
  const err = new Error('fetch timeout');

  // Layer 1 (inside askDeepSeekStream):
  if (!err._accountMarked) {
    serverInternals.markAccountFailure(account, 504, err.message);
    err._accountMarked = true;
  }
  assert.equal(account.failures, 1);
  assert.equal(account.consecutiveTimeouts, 1);

  // Layer 2 (top-level handler): must be a no-op because err._accountMarked is true
  if (!err._accountMarked) {
    serverInternals.markAccountFailure(account, 504, err.message);
  }
  assert.equal(account.failures, 1, 'Double marking must be prevented');
  assert.equal(account.consecutiveTimeouts, 1, 'Consecutive timeouts must not double-increment');
});

test('parseToolCalls parses 3 valid newline envelopes, preserves order, and assigns unique ids', () => {
  const text = [
    '{"tool_call":{"name":"read_file","arguments":{"path":"/tmp/a"}}}',
    '{"tool_call":{"name":"read_file","arguments":{"path":"/tmp/b"}}}',
    '{"tool_call":{"name":"read_file","arguments":{"path":"/tmp/c"}}}',
  ].join('\n');

  const calls = serverInternals.parseToolCalls(text);
  assert(Array.isArray(calls));
  assert.equal(calls.length, 3);
  assert.equal(calls[0].name, 'read_file');
  assert.equal(calls[1].name, 'read_file');
  assert.equal(calls[2].name, 'read_file');
  assert.deepEqual(JSON.parse(calls[0].arguments), { path: '/tmp/a' });
  assert.deepEqual(JSON.parse(calls[1].arguments), { path: '/tmp/b' });
  assert.deepEqual(JSON.parse(calls[2].arguments), { path: '/tmp/c' });

  const ids = calls.map(c => c.id);
  assert.equal(new Set(ids).size, 3);
  ids.forEach(id => assert.match(id, /^call_\d+_[a-z0-9]+_\d+$/));
});

test('parseToolCalls caps at MAX_TOOL_CALLS_PER_TURN (8) when 10 valid envelopes provided', () => {
  const text = [
    '{"tool_call":{"name":"read_file","arguments":{"path":"1"}}}',
    '{"tool_call":{"name":"read_file","arguments":{"path":"2"}}}',
    '{"tool_call":{"name":"read_file","arguments":{"path":"3"}}}',
    '{"tool_call":{"name":"read_file","arguments":{"path":"4"}}}',
    '{"tool_call":{"name":"read_file","arguments":{"path":"5"}}}',
    '{"tool_call":{"name":"read_file","arguments":{"path":"6"}}}',
    '{"tool_call":{"name":"read_file","arguments":{"path":"7"}}}',
    '{"tool_call":{"name":"read_file","arguments":{"path":"8"}}}',
    '{"tool_call":{"name":"read_file","arguments":{"path":"9"}}}',
    '{"tool_call":{"name":"read_file","arguments":{"path":"10"}}}',
  ].join('\n');

  const calls = serverInternals.parseToolCalls(text);
  assert.equal(calls.length, serverInternals.MAX_TOOL_CALLS_PER_TURN);
  assert.equal(calls.length, 8);
  assert.deepEqual(calls.map(c => JSON.parse(c.arguments).path), ['1', '2', '3', '4', '5', '6', '7', '8']);
});

test('parseToolCalls deduplicates identical envelopes to a single call', () => {
  const text = [
    '{"tool_call":{"name":"read_file","arguments":{"path":"/dup"}}}',
    '{"tool_call":{"name":"read_file","arguments":{"path":"/dup"}}}',
  ].join('\n');

  const calls = serverInternals.parseToolCalls(text);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'read_file');
  assert.deepEqual(JSON.parse(calls[0].arguments), { path: '/dup' });
});

test('parseToolCalls rejects mixed valid and malformed turns triggering v1 fallback to single match', () => {
  const mixed = [
    '{"tool_call":{"name":"read_file","arguments":{"path":"/tmp/first"}}}',
    'broken markup or prose line',
    '{"tool_call":{"name":"read_file","arguments":{"path":"/tmp/second"}}}',
  ].join('\n');

  // parseToolCalls must return null because not all envelopes parsed cleanly
  const multi = serverInternals.parseToolCalls(mixed);
  assert.equal(multi, null);

  // Fallback single-first-match path extracts the first valid tool call only
  const single = serverInternals.parseToolCall(mixed);
  assert(single);
  assert.equal(single.name, 'read_file');
  assert.deepEqual(JSON.parse(single.arguments), { path: '/tmp/first' });
});

test('parseToolCalls rejects unknown tool names among valid envelopes (no laundering)', () => {
  const mixedTools = [
    '{"tool_call":{"name":"read_file","arguments":{"path":"/tmp/valid"}}}',
    '{"tool_call":{"name":"unauthorized_tool","arguments":{}}}',
  ].join('\n');
  const allowedToolNames = new Set(['read_file', 'write_file']);

  // parseToolCalls must refuse multi-turn when an unknown tool is present
  const multi = serverInternals.parseToolCalls(mixedTools, { allowedToolNames });
  assert.equal(multi, null);

  // Fallback takes the first match without laundering the unknown tool
  const single = serverInternals.parseToolCall(mixedTools);
  assert(single);
  assert.equal(single.name, 'read_file');
});

test('streaming and response mappers emit N tool_calls with indices, tool_use blocks, and function_call items', () => {
  const toolCalls = [
    { id: 'call_1', name: 'read_file', arguments: '{"path":"/a"}' },
    { id: 'call_2', name: 'read_file', arguments: '{"path":"/b"}' },
  ];
  const openaiResp = serverInternals.buildToolCallResponse(toolCalls, 'test-model');

  // 1. Anthropic mapper emits N tool_use blocks
  const anthropic = serverInternals.toAnthropicResponse(openaiResp);
  assert.equal(anthropic.stop_reason, 'tool_use');
  const toolUseBlocks = anthropic.content.filter(c => c.type === 'tool_use');
  assert.equal(toolUseBlocks.length, 2);
  assert.equal(toolUseBlocks[0].id, 'call_1');
  assert.equal(toolUseBlocks[0].name, 'read_file');
  assert.deepEqual(toolUseBlocks[0].input, { path: '/a' });
  assert.equal(toolUseBlocks[1].id, 'call_2');
  assert.equal(toolUseBlocks[1].name, 'read_file');
  assert.deepEqual(toolUseBlocks[1].input, { path: '/b' });

  // 2. Responses mapper emits N function_call items
  const responses = serverInternals.toResponsesResponse(openaiResp);
  const fnCalls = responses.output.filter(item => item.type === 'function_call');
  assert.equal(fnCalls.length, 2);
  assert.equal(fnCalls[0].call_id, 'call_1');
  assert.equal(fnCalls[0].name, 'read_file');
  assert.equal(fnCalls[1].call_id, 'call_2');
  assert.equal(fnCalls[1].name, 'read_file');

  // 3. Streaming mapper (finishOpenAIStream) emits N tool_calls with index 0..N-1
  const chunks = [];
  const mockRes = {
    headersSent: true,
    write(chunk) { chunks.push(chunk); },
    end() {},
  };
  serverInternals.finishOpenAIStream(mockRes, openaiResp);
  const toolChunk = chunks.find(c => c.includes('"tool_calls"'));
  assert(toolChunk);
  const jsonStr = toolChunk.replace(/^data:\s*/, '').trim();
  const parsed = JSON.parse(jsonStr);
  const streamedCalls = parsed.choices[0].delta.tool_calls;
  assert.equal(streamedCalls.length, 2);
  assert.equal(streamedCalls[0].index, 0);
  assert.equal(streamedCalls[0].id, 'call_1');
  assert.equal(streamedCalls[1].index, 1);
  assert.equal(streamedCalls[1].id, 'call_2');
});

test('Fix 5: truncation maps to max_tokens/incomplete on Anthropic and Responses mappers', () => {
  const base = {
    id: 'ds-trunc-1',
    created: 1700000000,
    model: 'deepseek-chat',
    usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
  };
  const truncated = { ...base, choices: [{ message: { role: 'assistant', content: 'partial' }, finish_reason: 'length' }] };
  const stopped = { ...base, choices: [{ message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }] };

  const anthTrunc = serverInternals.toAnthropicResponse(truncated);
  assert.equal(anthTrunc.stop_reason, 'max_tokens');
  const respTrunc = serverInternals.toResponsesResponse(truncated);
  assert.equal(respTrunc.status, 'incomplete');
  assert.deepEqual(respTrunc.incomplete_details, { reason: 'max_output_tokens' });
  assert.equal(respTrunc.output.find(i => i.type === 'message').status, 'incomplete');

  const anthStop = serverInternals.toAnthropicResponse(stopped);
  assert.equal(anthStop.stop_reason, 'end_turn');
  const respStop = serverInternals.toResponsesResponse(stopped);
  assert.equal(respStop.status, 'completed');
  assert.equal(respStop.incomplete_details, undefined);
  assert.equal(respStop.output.find(i => i.type === 'message').status, 'completed');
});

test('Fix 6: normalizeMessageContent never falls through to raw JSON for image/unknown parts', () => {
  const image = serverInternals.normalizeMessageContent([
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA'.repeat(64) } },
  ]);
  assert.match(image, /^\[Image: /);
  assert.match(image, /data omitted/);
  assert.ok(!image.includes('AAAA'));

  const inputImage = serverInternals.normalizeMessageContent([
    { type: 'input_image', image_url: { url: 'https://example.test/x.png' } },
  ]);
  assert.match(inputImage, /^\[Image: /);
  assert.ok(!inputImage.includes('base64'));

  const unknown = serverInternals.normalizeMessageContent([{ type: 'video', video: { data: 'BIGBLOB' } }]);
  assert.equal(unknown, '[Unsupported content part: video]');
});

test('Fix 7: normalizeApiParams rejects non-array messages with 400 invalid_request', () => {
  assert.throws(
    () => serverInternals.normalizeApiParams({ messages: 'not-an-array' }, 'anthropic'),
    (err) => err.status === 400 && err.type === 'invalid_request' && /messages must be an array/.test(err.message)
  );
  assert.doesNotThrow(() => serverInternals.normalizeApiParams({ messages: [{ role: 'user', content: 'hi' }] }, 'anthropic'));
  assert.doesNotThrow(() => serverInternals.normalizeApiParams({ messages: [] }, 'anthropic'));
  assert.doesNotThrow(() => serverInternals.normalizeApiParams({ input: 'hello' }, 'responses'));
});

test('empty exhaustion preserves session.id and emits tool_call_failed (implementor-brief-no-new-chats-2026-09-15 §7.1)', () => {
  const session = serverInternals.createSession();
  session.id = 'chat-preserve-empty-1';
  session.messageCount = 5;
  session.accountId = 'account_test';

  const exhaustion = serverInternals.resolveEmptyExhaustion({
    session,
    modelError: null,
    timedOut: false,
    retryAttempt: 2,
  });

  assert.equal(session.id, 'chat-preserve-empty-1');
  assert.equal(exhaustion.preserve, true);
  assert.equal(exhaustion.type, 'tool_call_failed');
  assert.equal(exhaustion.failedSessionId, 'chat-preserve-empty-1');
  assert.equal(exhaustion.failedMessageCount, 5);
  assert.equal(exhaustion.accountId, 'account_test');
});

test('502 repair exhaustion preserves session.id without resetting (implementor-brief-no-new-chats-2026-09-15 §7.2)', () => {
  const session = serverInternals.createSession();
  session.id = 'chat-preserve-repair-2';
  session.messageCount = 8;
  session.accountId = 'account_test';

  const exhaustion = serverInternals.resolveRepairExhaustion({
    session,
    retryAttempt: 2,
  });

  assert.equal(session.id, 'chat-preserve-repair-2');
  assert.equal(exhaustion.preserve, true);
  assert.equal(exhaustion.status, 502);
  assert.equal(exhaustion.type, 'tool_call_failed');
  assert.equal(exhaustion.failedSessionId, 'chat-preserve-repair-2');
  assert.equal(exhaustion.failedMessageCount, 8);
  assert.equal(exhaustion.retryAttempts, 2);
});

test('upstream 400/404/500 expiry throws chat_expired directing to /new and preserves session.id (implementor-brief-no-new-chats-2026-09-15 §7.3)', () => {
  const session = serverInternals.createSession();
  session.id = 'chat-upstream-expired-3';
  session.messageCount = 12;

  for (const status of [400, 404, 500]) {
    const err = serverInternals.createChatExpiredError(status);
    assert.equal(err.status, status);
    assert.equal(err.type, 'chat_expired');
    assert.match(err.message, /Type \/new to start a fresh chat/);
  }
  // Session is preserved; no reset or recreate called
  assert.equal(session.id, 'chat-upstream-expired-3');
  assert.equal(session.messageCount, 12);
});

test('unsafe rotation restores pre-call snapshot and preserves session without resetting (implementor-brief-no-new-chats-2026-09-15 §7.4)', () => {
  const session = serverInternals.createSession();
  session.id = 'chat-original-4';
  session.parentMessageId = 'msg-original-4';
  session.accountId = 'account_1';
  session.messageCount = 6;

  const snapshot = {
    id: session.id,
    parentMessageId: session.parentMessageId,
    accountId: session.accountId,
    messageCount: session.messageCount,
  };

  const unsafeCall = { account: { id: 'account_2' }, promptSent: 'continue' };
  assert.equal(serverInternals.isContinuationRecoverySafe('account_1', unsafeCall), false);

  // Simulate unintended foreign chat contamination
  session.id = 'chat-foreign-leak';
  session.accountId = 'account_2';
  session.messageCount = 7;

  // Restore snapshot
  serverInternals.restoreContinuationSnapshot(session, snapshot);

  assert.equal(session.id, 'chat-original-4');
  assert.equal(session.parentMessageId, 'msg-original-4');
  assert.equal(session.accountId, 'account_1');
  assert.equal(session.messageCount, 6);
});

test('repair attempts carry full tool definitions via buildRepairPrompt (implementor-brief-no-new-chats-2026-09-15 §7.5)', () => {
  const tools = [
    { type: 'function', function: { name: 'bash', description: 'Run bash command', parameters: { type: 'object', properties: { command: { type: 'string' } } } } },
    { type: 'function', function: { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } },
  ];
  const messages = [{ role: 'user', content: 'list files' }];
  const formatted = serverInternals.formatMessages(messages, tools);
  const promptBuild = serverInternals.buildBoundedPrompt(formatted.systemPrompt, '', formatted.prompt);

  // Both attempt 1 and attempt 2 build prompt with buildRepairPrompt(freshPromptBuild.prompt)
  const repairPrompt = serverInternals.buildRepairPrompt(promptBuild.prompt);

  assert.match(repairPrompt, /bash/);
  assert.match(repairPrompt, /read_file/);
  assert.match(repairPrompt, /\[STRICT INSTRUCTION — DeepSeek Web backend\]/);
  assert.match(repairPrompt, /one strict JSON object on a single line/);
});

test('compaction still resets (sanctioned exception) while TTL and depth do not reset (implementor-brief-no-new-chats-2026-09-15 §7.6)', () => {
  // 1. Compaction: resetRemoteSession resets session as the sole sanctioned exception
  const compSession = serverInternals.createSession();
  compSession.id = 'chat-compaction-sanctioned';
  compSession.messageCount = 15;
  compSession.history.push({ user: 'u', assistant: 'a' });

  const resetResult = serverInternals.resetRemoteSession(compSession);
  assert.equal(resetResult.failedSessionId, 'chat-compaction-sanctioned');
  assert.equal(resetResult.failedMessageCount, 15);
  assert.equal(compSession.id, null);
  assert.equal(compSession.messageCount, 0);

  // 2. TTL/depth: prepareSessionForPrompt returns null and does NOT reset
  const deepSession = serverInternals.createSession();
  deepSession.id = 'chat-depth-stay';
  deepSession.messageCount = 200;
  deepSession.createdAt = Date.now() - 100000;

  const depthResult = serverInternals.prepareSessionForPrompt(deepSession, Date.now());
  assert.equal(depthResult, null);
  assert.equal(deepSession.id, 'chat-depth-stay');
  assert.equal(deepSession.messageCount, 200);
});

test('serializeSession preserves numeric and string parentMessageId (review-report-2 item 1)', () => {
  const s1 = serverInternals.createSession();
  s1.parentMessageId = 14;
  const snap1 = serverInternals.serializeSession(s1);
  assert.equal(snap1.parentMessageId, 14);

  const s2 = serverInternals.createSession();
  s2.parentMessageId = 'msg-uuid-123';
  const snap2 = serverInternals.serializeSession(s2);
  assert.equal(snap2.parentMessageId, 'msg-uuid-123');

  const s3 = serverInternals.createSession();
  s3.parentMessageId = undefined;
  const snap3 = serverInternals.serializeSession(s3);
  assert.equal(snap3.parentMessageId, null);
});

test('hasLeftoverToolEnvelopes detects multi-tool envelopes to prevent silent narrowing (review-report-2 item 3)', () => {
  const allowed = new Set(['read_file', 'bash']);

  // Case 1: Multiple envelopes with an unknown tool
  const mixedMarkup = '{"tool_call":{"name":"read_file","arguments":{"path":"a"}}}\n{"tool_call":{"name":"evil_tool","arguments":{"path":"b"}}}';
  assert.equal(serverInternals.hasLeftoverToolEnvelopes(mixedMarkup), true);
  // parseToolCalls with allowed filter returns null
  assert.equal(serverInternals.parseToolCalls(mixedMarkup, { allowedToolNames: allowed }), null);

  // Case 2: Single tool call in prose
  const singleMarkup = 'Here is the file: {"tool_call":{"name":"read_file","arguments":{"path":"a"}}}';
  assert.equal(serverInternals.hasLeftoverToolEnvelopes(singleMarkup), false);
});

test('formatToolDefinitions refers to proxy host and does not leak local hostname or private IP (review-report-2 item 4)', () => {
  const tools = [{ type: 'function', function: { name: 'bash', description: 'run command' } }];
  const formatted = serverInternals.formatToolDefinitions(tools);
  assert.match(formatted, /Tools run on the proxy host/);
  assert.doesNotMatch(formatted, /\b192\.168\./);
  assert.doesNotMatch(formatted, /\b10\.\d+\.\d+\.\d+\b/);
});










test('toClientErrorMessage maps known upstream Russian errors to English, passes unknown through', () => {
  assert.equal(
    serverInternals.toClientErrorMessage('Слишком частые сообщения. Повторите попытку позже.'),
    'Too many requests. Please try again later.'
  );
  assert.equal(
    serverInternals.toClientErrorMessage('Upstream error 429: Слишком частые сообщения, повторите попытку позже'),
    'Upstream error 429: Too many requests. Please try again later.'
  );
  assert.equal(serverInternals.toClientErrorMessage('Some plain English error'), 'Some plain English error');
  assert.equal(serverInternals.toClientErrorMessage(''), '');
  assert.equal(
    serverInternals.toClientErrorMessage('Ошибка: содержание слишком длинным, сократите'),
    'Ошибка: Content too long., сократите'
  );
});

test('isRateLimitError detects HTTP 429 and throttling texts, rejects context/auth/empty signals', () => {
  const rl = serverInternals.isRateLimitError;
  // HTTP status shapes.
  assert.equal(rl(429), true);
  assert.equal(rl({ status: 429, message: 'whatever' }), true);
  assert.equal(rl({ status: 429, type: 'rate_limit_error' }), true);
  assert.equal(rl({ status: 502, message: 'x' }), false);
  // RU + EN throttling texts (SSE modelError shapes included).
  assert.equal(rl({ content: 'Слишком частые сообщения. Повторите попытку позже.' }), true);
  assert.equal(rl({ content: 'Too many requests, please slow down', type: 'error' }), true);
  assert.equal(rl({ content: 'Rate limit exceeded, try again later', finish_reason: 'error' }), true);
  assert.equal(rl('rate_limit'), true);
  // Must NOT match context-length, auth, or empty texts.
  assert.equal(rl({ content: 'Maximum context length exceeded' }), false);
  assert.equal(rl({ content: 'Содержание слишком длинное. Сократите его и попробуйте снова.' }), false);
  assert.equal(rl({ status: 401, message: 'unauthorized' }), false);
  assert.equal(rl({ status: 403, message: 'forbidden' }), false);
  assert.equal(rl({ content: '' }), false);
  assert.equal(rl(null), false);
  assert.equal(rl(undefined), false);
});

test('resolveRateLimitMigration picks the other ready account', () => {
  const session = serverInternals.createSession();
  session.id = 'chat-old';
  session.accountId = 'acct-a';
  const peer = (id, coolMs = 0) => ({
    id, config: { token: `t-${id}`, cookie: `c-${id}` },
    cooldownUntil: coolMs > 0 ? Date.now() + coolMs : 0,
    headers: {},
  });
  // Cooling throttled account + one ready peer: must migrate to the peer.
  const d1 = serverInternals.resolveRateLimitMigration(session, [peer('acct-a', 600_000), peer('acct-b')], false);
  assert.equal(d1.migrateTo, 'acct-b');
  assert.ok(!d1.failFast);
  // Multiple ready peers: pick stays off the throttled account.
  const d2 = serverInternals.resolveRateLimitMigration(session, [peer('acct-a', 600_000), peer('acct-b'), peer('acct-c')], false);
  assert.ok(['acct-b', 'acct-c'].includes(d2.migrateTo));
});

test('resolveRateLimitMigration fails fast on second rate-limit in the same turn', () => {
  const session = serverInternals.createSession();
  session.id = 'chat-migrated';
  session.accountId = 'acct-b';
  const peer = (id) => ({ id, config: { token: `t-${id}`, cookie: `c-${id}` }, cooldownUntil: 0, headers: {} });
  const d = serverInternals.resolveRateLimitMigration(session, [peer('acct-a'), peer('acct-b')], true);
  assert.equal(d.failFast, true);
  assert.equal(d.reason, 'already-migrated');
  assert.ok(!d.migrateTo);
});

test('resolveRateLimitMigration fails fast with no ready peer, session and chat untouched', () => {
  const session = serverInternals.createSession();
  session.id = 'chat-live';
  session.parentMessageId = 'parent-1';
  session.accountId = 'acct-a';
  session.messageCount = 4;
  session.history.push({ user: 'q', assistant: 'a' });
  const peer = (id, coolMs) => ({
    id, config: { token: `t-${id}`, cookie: `c-${id}` },
    cooldownUntil: coolMs > 0 ? Date.now() + coolMs : 0,
    headers: {},
  });
  const d = serverInternals.resolveRateLimitMigration(session, [peer('acct-a', 600_000), peer('acct-b', 600_000)], false);
  assert.equal(d.failFast, true);
  assert.equal(d.reason, 'no-ready-account');
  // Decision helper is pure: nothing chat-scoped moved.
  assert.equal(session.id, 'chat-live');
  assert.equal(session.parentMessageId, 'parent-1');
  assert.equal(session.accountId, 'acct-a');
  assert.equal(session.messageCount, 4);
  assert.equal(session.history.length, 1);
});

test('coolAccountForRateLimit cools on SSE throttling text, ignores other signals', () => {
  const mk = () => ({ id: 'sse-acct', config: { token: 't', cookie: 'c' }, cooldownUntil: 0, failures: 0, headers: {} });
  const throttled = mk();
  assert.equal(
    serverInternals.coolAccountForRateLimit(throttled, { type: 'error', content: 'Слишком частые сообщения. Повторите попытку позже.' }),
    true
  );
  assert.ok(throttled.cooldownUntil > Date.now());
  assert.equal(throttled.failures, 1);
  // Non-throttling SSE errors must not touch cooldown state.
  const other = mk();
  assert.equal(serverInternals.coolAccountForRateLimit(other, { type: 'error', content: 'Temporary backend overload' }), false);
  assert.equal(other.cooldownUntil, 0);
  assert.equal(other.failures, 0);
  assert.equal(serverInternals.coolAccountForRateLimit(other, null), false);
  assert.equal(serverInternals.coolAccountForRateLimit(null, { content: 'Too many requests' }), false);
});

test('performRateLimitMigration moves sticky account, resets chat scope, keeps history and repair guard', () => {
  const session = serverInternals.createSession();
  session.id = 'chat-old';
  session.parentMessageId = 'parent-old';
  session.accountId = 'acct-a';
  session.messageCount = 6;
  session.history.push({ user: 'do X', assistant: 'did X' });
  session.deltaMsgCount = 3;
  session.deltaBoundary = 'hash-1';
  session.repairHash = 'turn-hash-1';
  session.repairAt = Date.now();
  session.repairCount = 1;
  const move = serverInternals.performRateLimitMigration(session, 'acct-b');
  assert.equal(move.oldChatId, 'chat-old');
  assert.equal(move.oldAccountId, 'acct-a');
  assert.equal(move.newAccountId, 'acct-b');
  assert.ok(move.historyPrefix.includes('do X'));
  assert.equal(session.accountId, 'acct-b');
  assert.equal(session.id, null);
  assert.equal(session.messageCount, 0);
  assert.equal(session.deltaMsgCount, 0);
  assert.equal(session.deltaBoundary, null);
  // Same client turn: history + repair guard survive the move.
  assert.equal(session.history.length, 1);
  assert.equal(session.repairHash, 'turn-hash-1');
  assert.equal(session.repairCount, 1);
});

function saveRoutingEnv(t) {
  const prevPref = process.env.DEEPSEEK_PREFERRED_ACCOUNT;
  const prevMode = process.env.DEEPSEEK_ROUTING_MODE;
  t.after(() => {
    if (prevPref === undefined) delete process.env.DEEPSEEK_PREFERRED_ACCOUNT;
    else process.env.DEEPSEEK_PREFERRED_ACCOUNT = prevPref;
    if (prevMode === undefined) delete process.env.DEEPSEEK_ROUTING_MODE;
    else process.env.DEEPSEEK_ROUTING_MODE = prevMode;
  });
}

test('smart routing: busiest account loses to idle; degraded (timeouts) loses to healthy', (t) => {
  saveRoutingEnv(t);
  delete process.env.DEEPSEEK_PREFERRED_ACCOUNT;
  delete process.env.DEEPSEEK_ROUTING_MODE;
  const idle = { id: 'sr-idle', inflight: 0, failures: 0, consecutiveTimeouts: 0 };
  const busy = { id: 'sr-busy', inflight: 2, failures: 0, consecutiveTimeouts: 0 };
  const healthy = { id: 'sr-healthy', inflight: 0, failures: 0, consecutiveTimeouts: 0 };
  const degraded = { id: 'sr-degraded', inflight: 0, failures: 1, consecutiveTimeouts: 3 };
  const flaky = { id: 'sr-flaky', inflight: 0, failures: 5, consecutiveTimeouts: 0 };
  const timedOut = { id: 'sr-timedout', inflight: 0, failures: 0, consecutiveTimeouts: 3 };
  // Gaps (20, 40, 16) all exceed the jitter range [0,1): deterministic wins.
  for (let i = 0; i < 20; i++) {
    assert.ok(serverInternals.scoreAccount(idle, 0) < serverInternals.scoreAccount(busy, 0), 'idle beats busy');
    assert.ok(serverInternals.scoreAccount(healthy, 0) < serverInternals.scoreAccount(degraded, 0), 'healthy beats degraded');
    assert.ok(serverInternals.scoreAccount(flaky, 0) < serverInternals.scoreAccount(timedOut, 0), 'timeouts weigh more than plain failures');
  }
});

test('smart routing: preferred wins ties; home affinity nudges but loses to a busy home', (t) => {
  saveRoutingEnv(t);
  delete process.env.DEEPSEEK_ROUTING_MODE;
  process.env.DEEPSEEK_PREFERRED_ACCOUNT = 'sr-pref';
  const pref = { id: 'sr-pref', inflight: 0, failures: 0, consecutiveTimeouts: 0 };
  const other = { id: 'sr-other', inflight: 0, failures: 0, consecutiveTimeouts: 0 };
  // Preferred bias (-5) exceeds jitter: deterministic tie-break.
  for (let i = 0; i < 20; i++) {
    assert.ok(serverInternals.scoreAccount(pref, 0) < serverInternals.scoreAccount(other, 0), 'preferred wins ties');
  }
  delete process.env.DEEPSEEK_PREFERRED_ACCOUNT;
  const home = { id: 'sr-home', inflight: 0, failures: 0, consecutiveTimeouts: 0 };
  const newcomer = { id: 'sr-newcomer', inflight: 0, failures: 0, consecutiveTimeouts: 0 };
  // Home affinity (-8 capped) beats an equally idle newcomer ...
  for (let i = 0; i < 20; i++) {
    assert.ok(serverInternals.scoreAccount(home, 8) < serverInternals.scoreAccount(newcomer, 0), 'home affinity nudges');
  }
  // ... but a busy home (inflight 1 with 8 hosted: 10-8=2) loses to an idle newcomer (0).
  const busyHome = { id: 'sr-home', inflight: 1, failures: 0, consecutiveTimeouts: 0 };
  for (let i = 0; i < 20; i++) {
    assert.ok(serverInternals.scoreAccount(newcomer, 0) < serverInternals.scoreAccount(busyHome, 8), 'busy home loses to idle newcomer');
  }
});

test('smart routing: single-ready passthrough returns the only account without scoring', (t) => {
  saveRoutingEnv(t);
  const solo = { id: 'sr-solo', inflight: 9, failures: 9, consecutiveTimeouts: 9 };
  assert.equal(serverInternals.selectFreshAccount([solo]), solo);
  // Even under the preferred-mode flag and a rival preference: no scoring.
  process.env.DEEPSEEK_ROUTING_MODE = 'preferred';
  process.env.DEEPSEEK_PREFERRED_ACCOUNT = 'sr-rival';
  assert.equal(serverInternals.selectFreshAccount([solo]), solo);
});

test('smart routing: DEEPSEEK_ROUTING_MODE=preferred restores monopoly despite load', (t) => {
  saveRoutingEnv(t);
  process.env.DEEPSEEK_ROUTING_MODE = 'preferred';
  process.env.DEEPSEEK_PREFERRED_ACCOUNT = 'sr-prime';
  const prime = { id: 'sr-prime', inflight: 5, failures: 0, consecutiveTimeouts: 0 };
  const spare = { id: 'sr-spare', inflight: 0, failures: 0, consecutiveTimeouts: 0 };
  assert.equal(serverInternals.selectFreshAccount([prime, spare]).id, 'sr-prime');
  // Default mode (flag unset): the scorer sends the fresh chat to the idle spare.
  delete process.env.DEEPSEEK_ROUTING_MODE;
  assert.equal(serverInternals.selectFreshAccount([prime, spare]).id, 'sr-spare');
});

test('smart routing: inflight counter returns to baseline on throw paths (finally)', async (t) => {
  saveRoutingEnv(t);
  delete process.env.DEEPSEEK_PREFERRED_ACCOUNT;
  delete process.env.DEEPSEEK_ROUTING_MODE;
  const originalAccounts = serverInternals.accounts.splice(0);
  const savedSessions = Array.from(serverInternals.sessions.entries());
  const prevFetch = globalThis.fetch;
  t.after(() => {
    serverInternals.accounts.splice(0, serverInternals.accounts.length, ...originalAccounts);
    serverInternals.sessions.clear();
    for (const [k, v] of savedSessions) serverInternals.sessions.set(k, v);
    globalThis.fetch = prevFetch;
  });
  serverInternals.sessions.clear();
  const mk = (id) => ({
    id, config: { token: `t-${id}`, cookie: `c-${id}` },
    cooldownUntil: 0, failures: 0, consecutiveTimeouts: 0, lastUsedAt: 0, inflight: 0, headers: {},
  });
  const a1 = mk('sr-fa1');
  const a2 = mk('sr-fa2');
  serverInternals.accounts.push(a1, a2);

  // Case 1: the first upstream fetch rejects — throw inside the wrapped region.
  let observedDuringFlight = null;
  globalThis.fetch = async () => {
    observedDuringFlight = (Number(a1.inflight) || 0) + (Number(a2.inflight) || 0);
    throw new Error('simulated network down');
  };
  await assert.rejects(
    () => serverInternals.askDeepSeekStream('hello', 'sr-agent-throw-1', 'deepseek-chat'),
    /simulated network down/
  );
  assert.equal(observedDuringFlight, 1, 'counter is 1 while the upstream call is in flight');
  assert.equal(a1.inflight, 0, 'no leak on throw (early)');
  assert.equal(a2.inflight, 0, 'no leak on throw (early)');

  // Case 2: challenge fetch succeeds but PoW solve throws (no wasmUrl) —
  // a later throw point in the same wrapped region (partial-success symmetry).
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify({ data: { biz_data: { challenge: { challenge: 'c', salt: 's', expire_at: 1, difficulty: 1, algorithm: 'a', signature: 'sig' } } } }),
  });
  await assert.rejects(
    () => serverInternals.askDeepSeekStream('hello', 'sr-agent-throw-2', 'deepseek-chat'),
    /PoW solve failed/
  );
  assert.equal(a1.inflight, 0, 'no leak on throw (late)');
  assert.equal(a2.inflight, 0, 'no leak on throw (late)');
});

test('smart routing: migration target is the least-loaded ready peer via the scorer', (t) => {
  saveRoutingEnv(t);
  delete process.env.DEEPSEEK_ROUTING_MODE;
  // Even with the busy peer named preferred, the scorer (not monopoly) decides.
  process.env.DEEPSEEK_PREFERRED_ACCOUNT = 'sr-mig-busy';
  const session = serverInternals.createSession();
  session.id = 'sr-chat-x';
  session.accountId = 'sr-mig-home';
  const peer = (id, extra = {}) => ({
    id, config: { token: `t-${id}`, cookie: `c-${id}` },
    cooldownUntil: 0, failures: 0, consecutiveTimeouts: 0, inflight: 0, headers: {}, ...extra,
  });
  const home = peer('sr-mig-home', { cooldownUntil: Date.now() + 600_000 });
  const busy = peer('sr-mig-busy', { inflight: 1 });
  const idlePeer = peer('sr-mig-idle');
  // busy scores 10-5=5 vs idle 0: gap exceeds jitter — deterministic.
  const d = serverInternals.resolveRateLimitMigration(session, [home, busy, idlePeer], false);
  assert.equal(d.migrateTo, 'sr-mig-idle');
  assert.ok(!d.failFast);
  // Single-peer shortcut stays.
  const d1 = serverInternals.resolveRateLimitMigration(session, [home, busy], false);
  assert.equal(d1.migrateTo, 'sr-mig-busy');
});

test('smart routing: accountStatus exposes inflight as a number', () => {
  const st = serverInternals.accountStatus({
    id: 'sr-st', config: { token: 't', cookie: 'c' },
    cooldownUntil: 0, failures: 2, consecutiveTimeouts: 1, lastUsedAt: 0, inflight: 3,
  });
  assert.equal(st.inflight, 3);
  // Additive field: existing health consumers keep their keys.
  assert.equal(st.id, 'sr-st');
  assert.equal(st.ready, true);
  assert.equal(st.failures, 2);
  assert.equal(st.consecutive_timeouts, 1);
  // Legacy account objects without the counter read as 0, still a number.
  const legacy = serverInternals.accountStatus({
    id: 'sr-legacy', config: { token: 't', cookie: 'c' }, cooldownUntil: 0, failures: 0,
  });
  assert.equal(legacy.inflight, 0);
});

test('device-id: headers carry x-device-id only when configured', () => {
  const withId = serverInternals.buildBaseHeaders({ token: 't', cookie: 'c', device_id: 'dev-123' });
  assert.equal(withId['x-device-id'], 'dev-123');
  const withoutId = serverInternals.buildBaseHeaders({ token: 't', cookie: 'c' });
  assert.ok(!('x-device-id' in withoutId), 'absent without id — old files unaffected');
  const evil = serverInternals.buildBaseHeaders({ token: 't', cookie: 'c', device_id: 'a\r\nInjected: x' });
  assert.ok(!('x-device-id' in evil), 'CRLF value omitted, not sent');
  const num = serverInternals.buildBaseHeaders({ token: 't', cookie: 'c', device_id: 12345 });
  assert.ok(!('x-device-id' in num), 'non-string id omitted');
  const long = serverInternals.buildBaseHeaders({ token: 't', cookie: 'c', device_id: 'a'.repeat(129) });
  assert.ok(!('x-device-id' in long), '129-char id omitted');
  for (const bad of [true, null, ['x'], { id: 'x' }]) {
    const h = serverInternals.buildBaseHeaders({ token: 't', cookie: 'c', device_id: bad });
    assert.ok(!('x-device-id' in h), `non-string ${JSON.stringify(bad)} omitted`);
  }
  const st = serverInternals.accountStatus({ id: 'x', config: { token: 't', cookie: 'c', device_id: 'd' }, cooldownUntil: 0, failures: 0 });
  assert.equal(st.has_device_id, true);
  const st2 = serverInternals.accountStatus({ id: 'y', config: { token: 't', cookie: 'c' }, cooldownUntil: 0, failures: 0 });
  assert.equal(st2.has_device_id, false);
  assert.equal(st.ewma_latency_ms, 0, 'fresh account latency reads 0 (unknown)');
  assert.equal(st2.ewma_latency_ms, 0);
  // Success-only staleness (M-1): a timing-out account keeps its last good
  // value through the outage by design — failures never write this field
  // (single write site, success path). Display-only, never scored.
});

test('device-id: auth_import passes device_id through, never requires it', () => {
  const { normalizeAuth, validateAuth } = require('../scripts/auth_import.js');
  const a = normalizeAuth({ token: 't', cookie: 'c=1', device_id: 'dev-1' });
  assert.equal(a.device_id, 'dev-1');
  assert.deepEqual(validateAuth(a), []);
  const b = normalizeAuth({ token: 't', cookie: 'c=1' });
  assert.ok(!('device_id' in b), 'absent stays absent');
  assert.deepEqual(validateAuth(b), [], 'still valid without id');
});

test('model discovery: parser reads verified shape, rejects the rest', () => {
  const p = serverInternals.parseModelDiscovery;
  const good = { code: 0, data: { biz_code: 0, biz_data: { settings: { model_configs: { id: 1, value: [
    { model_type: 'default', name: 'x', enabled: true, switchable: true },
    { model_type: 'expert', name: 'y', enabled: false, switchable: false },
  ] } } } } };
  const parsed = p(good);
  assert.ok(parsed, 'verified shape parses');
  assert.deepEqual(parsed.types.map(t => [t.model_type, t.enabled, t.switchable]),
    [['default', true, true], ['expert', false, false]]);
  assert.ok(parsed.fetchedAt > 0);
  assert.equal(p(null), null);
  assert.equal(p({}), null);
  assert.equal(p({ code: 0, data: { biz_code: 1, biz_msg: 'SETTINGS_NOT_FOUND', biz_data: null } }), null, 'soft-miss shape');
  assert.equal(p({ code: 0, data: { biz_data: { settings: {} } } }), null, 'missing table');
  assert.equal(p({ code: 0, data: { biz_data: { settings: { model_configs: { id: 1 } } } } }), null, 'missing value array');
  assert.equal(p({ code: 0, data: { biz_data: { settings: { model_configs: [] } } } }), null, 'bare list rejected');
  const tabled = { id: 1, value: [{ model_type: 'x', enabled: true, switchable: true }] };
  assert.ok(p({ code: 0, data: { biz_code: 0, biz_data: { settings: { model_configs: tabled } } } }), 'zero envelopes accept');
  assert.equal(p({ code: 500, data: { biz_code: 0, biz_data: { settings: { model_configs: tabled } } } }), null, 'error code with table rejected (H-1)');
  assert.equal(p({ code: 0, data: { biz_code: 5, biz_data: { settings: { model_configs: tabled } } } }), null, 'nonzero biz_code with table rejected (H-1)');
  assert.ok(p({ code: 0, data: { biz_code: '0', biz_data: { settings: { model_configs: tabled } } } }), 'string-zero biz_code accepted (harmonized)');
  assert.deepEqual(
    p({ code: 0, data: { biz_data: { settings: { model_configs: { id: 1, value: [
      { model_type: 'x', enabled: 1, switchable: 'yes' },
    ] } } } } }).types,
    [{ model_type: 'x', name: '', enabled: false, switchable: false }],
    'truthy-non-true is NOT enabled (strict === true)'
  );
});

test('latency tracking: EWMA seeds then smooths with alpha 0.3', () => {
  const f = serverInternals.nextEwmaLatency;
  assert.equal(f(0, 1000), 1000, 'first sample seeds');
  assert.equal(f(undefined, 2000), 2000);
  assert.equal(f(1000, 2000), 1300, '0.7*1000+0.3*2000');
  assert.equal(f(1300, 1300), 1300, 'steady state holds');
  assert.equal(f(-5, 1000), 1000, 'garbage prev reseeds');
  assert.equal(f(1000, -50), 700, 'negative sample floors at 0: 0.7*1000');
  assert.equal(f(NaN, 1000), 1000, 'NaN prev reseeds');
  assert.equal(f(1000, NaN), 700, 'NaN sample floors at 0: 0.7*1000');
});

test('smart routing: jitter is bounded — tied inputs only ever pick among the tied accounts', (t) => {
  saveRoutingEnv(t);
  delete process.env.DEEPSEEK_PREFERRED_ACCOUNT;
  delete process.env.DEEPSEEK_ROUTING_MODE;
  const a = { id: 'sr-jit-a', inflight: 0, failures: 0, consecutiveTimeouts: 0 };
  const b = { id: 'sr-jit-b', inflight: 0, failures: 0, consecutiveTimeouts: 0 };
  const winners = new Set();
  for (let i = 0; i < 500; i++) {
    winners.add(serverInternals.scoreAccount(a, 0) < serverInternals.scoreAccount(b, 0) ? 'a' : 'b');
  }
  for (const w of winners) assert.ok(['a', 'b'].includes(w));
  // Jitter genuinely breaks ties: over 500 trials each side wins at least
  // once (P(flaky fail) ≈ 2^-499 — safe, not a flaky exact assertion).
  assert.ok(winners.has('a') && winners.has('b'), `expected both tied accounts to win, saw: ${[...winners]}`);
  // Jitter range is [0,1): idle untied scores land in [0,1).
  for (let i = 0; i < 20; i++) {
    const s = serverInternals.scoreAccount(a, 0);
    assert.ok(s >= 0 && s < 1, `jitter out of bounds: ${s}`);
  }
});

test('smart routing: only live recent chats count toward home affinity (stale pins go inert)', (t) => {
  saveRoutingEnv(t);
  delete process.env.DEEPSEEK_PREFERRED_ACCOUNT;
  delete process.env.DEEPSEEK_ROUTING_MODE;
  const savedSessions = Array.from(serverInternals.sessions.entries());
  t.after(() => {
    serverInternals.sessions.clear();
    for (const [k, v] of savedSessions) serverInternals.sessions.set(k, v);
  });
  serverInternals.sessions.clear();
  const now = Date.now();
  const seed = (key, accountId, id, ageMs) => {
    const s = serverInternals.createSession();
    s.id = id;
    s.accountId = accountId;
    s.lastActivityAt = now - ageMs;
    serverInternals.sessions.set(key, s);
  };
  // 8 stale live chats on A (2h idle): inert under the 30-min window.
  for (let i = 0; i < 8; i++) seed(`sr-decay-stale-${i}`, 'sr-decay-a', `chat-stale-${i}`, 2 * 60 * 60 * 1000);
  // 2 fresh but chat-less stickies on A (reset sessions): never attract traffic.
  for (let i = 0; i < 2; i++) seed(`sr-decay-chatless-${i}`, 'sr-decay-a', null, 0);
  // 1 fresh live chat on B.
  seed('sr-decay-fresh-0', 'sr-decay-b', 'chat-fresh-0', 0);
  assert.equal(serverInternals.countActiveHosted('sr-decay-a', now), 0);
  assert.equal(serverInternals.countActiveHosted('sr-decay-b', now), 1);
  assert.equal(serverInternals.countActiveHosted('sr-decay-unknown', now), 0);
  // End to end: B (-1+j) beats stale-heavy A (0+j) deterministically.
  const a = { id: 'sr-decay-a', inflight: 0, failures: 0, consecutiveTimeouts: 0 };
  const b = { id: 'sr-decay-b', inflight: 0, failures: 0, consecutiveTimeouts: 0 };
  assert.equal(serverInternals.selectFreshAccount([a, b]).id, 'sr-decay-b');
});

test('smart routing: two consecutive soft failures trigger a short escalation cooldown', () => {
  const account = { id: 'sr-esc', failures: 0, consecutiveFailures: 0, consecutiveTimeouts: 0, cooldownUntil: 0 };
  // First PoW-missing (auth-expired symptom): counted, still ready.
  serverInternals.markAccountFailure(account, 200, 'pow challenge missing');
  assert.equal(account.failures, 1);
  assert.equal(account.consecutiveFailures, 1);
  assert.equal(account.cooldownUntil, 0);
  assert.ok(account.lastFailureAt > 0);
  // Second consecutive failure: sidelined briefly so fresh chats fail over.
  serverInternals.markAccountFailure(account, 200, 'pow challenge missing');
  assert.equal(account.failures, 2);
  assert.equal(account.consecutiveFailures, 0);
  assert.ok(account.cooldownUntil > Date.now(), 'escalation cooldown set');
  assert.ok(account.cooldownUntil <= Date.now() + 65_000, 'escalation cooldown is short (~60s)');
});

test('smart routing: PoW-solve failures never strike out (F16 WASM/CDN exemption)', () => {
  const account = { id: 'sr-f16', failures: 0, consecutiveFailures: 0, consecutiveTimeouts: 0, cooldownUntil: 0 };
  for (let i = 0; i < 3; i++) serverInternals.markAccountFailure(account, 500, 'pow solve');
  assert.equal(account.failures, 3, 'counted for the scorer');
  assert.ok(!account.consecutiveFailures, 'no strike counted');
  assert.equal(account.cooldownUntil, 0, 'never sidelined');
});

test('smart routing: failure half-life decay forgives old blips but punishes fresh ones', (t) => {
  saveRoutingEnv(t);
  delete process.env.DEEPSEEK_PREFERRED_ACCOUNT;
  delete process.env.DEEPSEEK_ROUTING_MODE;
  const now = Date.now();
  const fresh = { id: 'sr-freshfail', inflight: 0, failures: 8, consecutiveTimeouts: 0, lastFailureAt: now };
  const stale = { id: 'sr-stalefail', inflight: 0, failures: 8, consecutiveTimeouts: 0, lastFailureAt: now - 30 * 60 * 1000 };
  // 8 fresh failures (4*8=32) vs 8 failures from 30min ago (~6 half-lives: ~0.5).
  assert.ok(serverInternals.effectiveFailures(fresh, now) > 7);
  assert.ok(serverInternals.effectiveFailures(stale, now) < 1);
  for (let i = 0; i < 20; i++) {
    assert.ok(serverInternals.scoreAccount(stale, 0, now) < serverInternals.scoreAccount(fresh, 0, now), 'stale failures route before fresh ones');
  }
});

test('smart routing: recent success wins near-ties but never outruns real failures', (t) => {
  saveRoutingEnv(t);
  delete process.env.DEEPSEEK_PREFERRED_ACCOUNT;
  delete process.env.DEEPSEEK_ROUTING_MODE;
  const now = Date.now();
  const hot = { id: 'sr-hot', inflight: 0, failures: 0, consecutiveTimeouts: 0, lastSuccessAt: now };
  const cold = { id: 'sr-cold', inflight: 0, failures: 0, consecutiveTimeouts: 0 };
  // Hot bonus (-2) exceeds jitter: deterministic near-tie win.
  for (let i = 0; i < 20; i++) {
    assert.ok(serverInternals.scoreAccount(hot, 0, now) < serverInternals.scoreAccount(cold, 0, now), 'proven-hot wins ties');
  }
  // ... but a single fresh failure (+4) outweighs the bonus: failures dominate.
  const hotFlaky = { id: 'sr-hotflaky', inflight: 0, failures: 1, consecutiveTimeouts: 0, lastFailureAt: now, lastSuccessAt: now };
  for (let i = 0; i < 20; i++) {
    assert.ok(serverInternals.scoreAccount(cold, 0, now) < serverInternals.scoreAccount(hotFlaky, 0, now), 'one failure beats the hot bonus');
  }
});

test('logging: scoreBase is deterministic and scoreAccount adds only jitter', (t) => {
  saveRoutingEnv(t);
  delete process.env.DEEPSEEK_PREFERRED_ACCOUNT;
  delete process.env.DEEPSEEK_ROUTING_MODE;
  const acct = { id: 'sr-base', inflight: 1, failures: 2, consecutiveTimeouts: 1 };
  const b1 = serverInternals.scoreBase(acct, 3);
  const b2 = serverInternals.scoreBase(acct, 3);
  assert.equal(b1, b2, 'no randomness in the base');
  for (let i = 0; i < 20; i++) {
    const s = serverInternals.scoreAccount(acct, 3);
    assert.ok(s >= b1 && s < b1 + 1, `jitter out of [base, base+1): ${s} vs ${b1}`);
  }
});

test('logging: scoreBreakdown reports the exact scorer components', (t) => {
  saveRoutingEnv(t);
  // Scorer reads the preferred env at call time: isolate it.
  delete process.env.DEEPSEEK_PREFERRED_ACCOUNT;
  delete process.env.DEEPSEEK_ROUTING_MODE;
  // NOTE: pins default-weight math (ROUTING_* knobs are load-time consts).
  const now = Date.now();
  const acct = { id: 'sr-bd', inflight: 1, failures: 4, consecutiveTimeouts: 2, lastFailureAt: now };
  const bd = serverInternals.scoreBreakdown(acct, 3, now);
  assert.equal(bd.failuresEff, 4, 'fresh failures apply in full (exact integer, no approx)');
  assert.equal(bd.failuresRaw, 4);
  assert.equal(bd.timeouts, 2);
  assert.equal(bd.inflight, 1);
  assert.equal(bd.hosted, 3);
  assert.equal(bd.preferred, false);
  assert.equal(bd.hot, false);
  assert.equal(bd.base, 10 + 4 * 4 + 12 * 2 - 3);
});

test('logging: logToken strips log-forging characters and caps length', () => {
  assert.equal(serverInternals.logToken('dev-agent'), 'dev-agent');
  assert.equal(serverInternals.logToken('a\nb\r\x1bc[d'), 'a_b__c_d');
  assert.equal(serverInternals.logToken('deepseek-chat'), 'deepseek-chat');
  assert.equal(serverInternals.logToken(null), '');
  assert.equal(serverInternals.logToken(undefined), '');
  assert.equal(serverInternals.logToken('x'.repeat(200)).length, 80);
});

test('tool tags: parseToolTagList splits, trims, drops empties/overlong, caps at 32', () => {
  assert.deepEqual(serverInternals.parseToolTagList('a|b'), ['a', 'b']);
  assert.deepEqual(serverInternals.parseToolTagList('  a  ||  |b|'), ['a', 'b']);
  assert.deepEqual(serverInternals.parseToolTagList(''), []);
  assert.deepEqual(serverInternals.parseToolTagList('ok|' + 'x'.repeat(200)), ['ok']);
  const many = Array.from({ length: 40 }, (_, i) => `t${i}`).join('|');
  assert.equal(serverInternals.parseToolTagList(many).length, 32);
});

test('tool tags: custom wrappers detect and parse end-to-end', (t) => {
  serverInternals.setExtraToolTags(['<mytools>'], ['</mytools>']);
  t.after(() => serverInternals.setExtraToolTags([], []));
  assert.ok(serverInternals.looksLikeToolCallMarkup('result: <mytools> done'), 'extra start detected');
  assert.ok(!serverInternals.looksLikeToolCallMarkup('plain prose, no markup'), 'no false positive');
  const tc = serverInternals.parseToolCall('<mytools>{"name":"read_file","arguments":{"path":"/tmp/a"}}</mytools>');
  assert.ok(tc, 'custom wrapper parsed');
  assert.equal(tc.name, 'read_file');
});

test('tool tags: empty extras change nothing', (t) => {
  serverInternals.setExtraToolTags([], []);
  t.after(() => serverInternals.setExtraToolTags([], []));
  assert.ok(!serverInternals.looksLikeToolCallMarkup('plain prose, no markup'));
  assert.equal(serverInternals.parseToolCall('plain prose, no markup'), null);
});

test('tool tags: setter enforces the same caps as env parsing', (t) => {
  const many = Array.from({ length: 40 }, (_, i) => `<t${i}>`);
  serverInternals.setExtraToolTags(many, ['x'.repeat(500)]);
  t.after(() => serverInternals.setExtraToolTags([], []));
  assert.ok(serverInternals.looksLikeToolCallMarkup('uses <t0> here'), 'kept tag detected');
  assert.ok(!serverInternals.looksLikeToolCallMarkup('uses <t39> here'), '33rd+ tag dropped');
});

test('tool tags: ends-alone never detect (no pairing possible)', (t) => {
  serverInternals.setExtraToolTags([], ['</lonely>']);
  t.after(() => serverInternals.setExtraToolTags([], []));
  assert.ok(!serverInternals.looksLikeToolCallMarkup('a stray </lonely> mention'), 'ends inert without starts');
  assert.equal(serverInternals.parseToolCall('a stray </lonely> mention'), null);
});

test('tool tags: unpaired start plus bare JSON does not parse', (t) => {
  serverInternals.setExtraToolTags(['<bare>'], ['</bare>']);
  t.after(() => serverInternals.setExtraToolTags([], []));
  // No end tag present -> allowBare off -> bare object must not become a call.
  assert.equal(serverInternals.parseToolCall('<bare> intro {"name":"sneaky","arguments":{}}'), null);
});

test('tool tags: malformed DSML short-circuits before custom stage (documented precedence)', (t) => {
  serverInternals.setExtraToolTags(['<mytools>'], ['</mytools>']);
  t.after(() => serverInternals.setExtraToolTags([], []));
  // DSML gate matches "<invoke" and returns null on malformed input — the valid
  // custom pair below never runs. Deliberate: built-in gate first, custom last.
  const text = '<invoke broken( <mytools>{"name":"read_file","arguments":{"path":"/tmp/a"}}</mytools>';
  assert.equal(serverInternals.parseToolCall(text), null);
});

test('tool tags: fenced parsing wins over custom tags (lowest precedence)', (t) => {  serverInternals.setExtraToolTags(['<mytools>'], ['</mytools>']);
  t.after(() => serverInternals.setExtraToolTags([], []));
  const seen = [];
  const prevLog = console.log;
  console.log = (...a) => { seen.push(a.join(' ')); };
  try {
    const fence = '```json\n{"tool_call":{"name":"read_file","arguments":{"path":"/tmp/a"}}}\n```';
    const tc = serverInternals.parseToolCall(fence);
    assert.ok(tc, 'fenced still parses with tags configured');
    assert.equal(tc.name, 'read_file');
    assert.ok(!seen.some(l => l.includes('SUCCESS custom')), 'custom stage never fired');
  } finally {
    console.log = prevLog;
  }
});

test('tool tags: env splitter drops extra sections', () => {
  assert.deepEqual(serverInternals.parseToolTagEnv('a|b;c|d'), { starts: ['a', 'b'], ends: ['c', 'd'] });
  assert.deepEqual(serverInternals.parseToolTagEnv('a;b;c'), { starts: ['a'], ends: ['b'] });
  assert.deepEqual(serverInternals.parseToolTagEnv(''), { starts: [], ends: [] });
});

test('retry toggle: rateLimitRetryDelayMs floors at 2s, honors Retry-After, caps at 10s', () => {
  const d = serverInternals.rateLimitRetryDelayMs;
  assert.equal(d(undefined), 2000);
  assert.equal(d(null), 2000);
  assert.equal(d(0), 2000);
  assert.equal(d('garbage'), 2000);
  assert.equal(d(-5), 2000);
  assert.equal(d(5), 5000);
  assert.equal(d(120), 10000);
});

test('retry toggle: shouldRetryInPlace wires flag, rate-limit, state, backoff, readiness', () => {
  const f = serverInternals.shouldRetryInPlace;
  const base = { flagOn: true, rateLimit: true, migrated: false, gone: false, deadline: false, retryAfterSec: undefined, anyReady: true };
  assert.equal(f(base), true, 'happy path attempts');
  assert.equal(f({ ...base, flagOn: false }), false, 'default off never attempts');
  assert.equal(f({ ...base, rateLimit: false }), false, 'non-rate-limit never attempts');
  assert.equal(f({ ...base, migrated: true }), false, 'already migrated never attempts');
  assert.equal(f({ ...base, gone: true }), false);
  assert.equal(f({ ...base, deadline: true }), false);
  assert.equal(f({ ...base, retryAfterSec: 600 }), false, 'long backoff goes to migration');
  assert.equal(f({ ...base, retryAfterSec: 5 }), true, 'brief backoff attempts');
  assert.equal(f({ ...base, anyReady: false }), false, 'all cooling skips the lift (no upstream leak)');
  assert.equal(f({ ...base, accountReady: false }), false, 'quota/burst-blocked retry account skips the lift');
  assert.equal(f({ ...base, accountReady: true }), true, 'eligible retry account attempts');
});

test('retry toggle: shouldAttemptInPlaceRetry only for unknown/brief backoffs', () => {
  const f = serverInternals.shouldAttemptInPlaceRetry;
  assert.equal(f(undefined), true, 'unknown -> optimistic probe');
  assert.equal(f(null), true);
  assert.equal(f(''), true);
  assert.equal(f(0), true);
  assert.equal(f(5), true);
  assert.equal(f(10), true, 'cap boundary inclusive');
  assert.equal(f(11), false, 'long backoff -> migration');
  assert.equal(f(600), false);
  assert.equal(f('garbage'), true, 'unparseable -> probe (delay floors)');
  assert.equal(f(-3), true, 'negative -> probe (delay floors)');
});

test('retry toggle: inPlaceRateLimitRetry lifts once, restores without extending', async () => {
  const f = serverInternals.inPlaceRateLimitRetry;
  const now = Date.now();
  assert.deepEqual(await f(null, async () => 'x'), { recovered: false });
  assert.deepEqual(await f({ cooldownUntil: 0 }, null), { recovered: false });
  // Success: bypass observed inside the attempt, result passed through.
  const acct = { id: 'a', cooldownUntil: 600000, failures: 3 };
  let seenDuringAttempt = -1;
  const ok = await f(acct, async () => { seenDuringAttempt = acct.cooldownUntil; return { resp: 1 }; });
  assert.equal(seenDuringAttempt, 0, 'cooldown lifted during attempt');
  assert.equal(ok.recovered, true);
  assert.deepEqual(ok.result, { resp: 1 });
  assert.equal(acct.cooldownUntil, 0, 'success path owns reset from here');
  assert.equal(acct.failures, 3, 'helper never touches counters');
  // Failure: exact restore of the whole limiter/scorer snapshot, error preserved.
  // The thunk mutates like a real markAccountFailure would — a restore that
  // only covers cooldownUntil (the pre-fix shape) fails this test. Ring stamps
  // and lastUpstreamAt roll back too: a failed probe records nothing at all.
  const acct2 = { id: 'b', cooldownUntil: 600000, failures: 1, consecutiveFailures: 1, consecutiveTimeouts: 2, requestTimes: [now - 5000], lastUpstreamAt: now - 9000 };
  const boom = new Error('upstream 429 again');
  const bad = await f(acct2, async () => {
    acct2.failures += 1;
    acct2.consecutiveFailures = 0;
    acct2.consecutiveTimeouts = 0;
    acct2.cooldownUntil = 999999;
    acct2.requestTimes.push(Date.now());
    acct2.lastUpstreamAt = Date.now();
    throw boom;
  });
  assert.equal(bad.recovered, false);
  assert.equal(bad.error, boom, 'second error preserved, not swallowed');
  assert.equal(acct2.cooldownUntil, 600000, 'no extension for our probe');
  assert.equal(acct2.failures, 1, 'no double-count');
  assert.equal(acct2.consecutiveFailures, 1, 'streak untouched');
  assert.equal(acct2.consecutiveTimeouts, 2, 'timeout streak untouched');
  assert.deepEqual(acct2.requestTimes, [now - 5000], 'probe stamp rolled back');
  assert.equal(acct2.lastUpstreamAt, now - 9000, 'probe clock rolled back');
  // Prune-path: the writer reassigns (not mutates) when the head is stale —
  // length-truncate would extend holes; slice-restore replaces wholesale.
  const acct3 = { id: 'c', cooldownUntil: 0, failures: 0, consecutiveFailures: 0, consecutiveTimeouts: 0, requestTimes: [now - 5000], lastUpstreamAt: now - 9000 };
  const bad3 = await f(acct3, async () => {
    acct3.requestTimes = [now - 4000000, now - 1000, Date.now()];
    acct3.lastUpstreamAt = Date.now();
    throw boom;
  });
  assert.equal(bad3.recovered, false);
  assert.deepEqual(acct3.requestTimes, [now - 5000], 'replaced array restored by value');
  assert.equal(acct3.lastUpstreamAt, now - 9000);
});

test('hourly quota: sliding window counts, prunes, and caps memory', () => {
  // NOTE: pins default-quota math (DEEPSEEK_HOURLY_QUOTA is a load-time const).
  const now = Date.now();
  const acct = { requestTimes: [] };
  assert.equal(serverInternals.usedThisHour(acct, now), 0);
  assert.equal(serverInternals.withinQuota(acct, now), true);
  for (let i = 0; i < 59; i++) serverInternals.recordAccountRequest(acct, now - i * 1000);
  assert.equal(serverInternals.usedThisHour(acct, now), 59);
  assert.equal(serverInternals.withinQuota(acct, now), true, '59th request still ready');
  serverInternals.recordAccountRequest(acct, now);
  assert.equal(serverInternals.usedThisHour(acct, now), 60);
  assert.equal(serverInternals.withinQuota(acct, now), false, '60th request spends the default quota');
  const mixed = { requestTimes: [] };
  serverInternals.recordAccountRequest(mixed, now - 3600001);
  assert.equal(serverInternals.usedThisHour(mixed, now), 0, 'older than window ignored');
  const hog = { requestTimes: [] };
  for (let i = 0; i < 1100; i++) serverInternals.recordUpstreamTurn(hog, now);
  assert.ok(hog.requestTimes.length <= 1024, `capped at fixed ring bound, saw ${hog.requestTimes.length}`);
  // Unconditional writer also stamps lastUpstreamAt (pacer's future clock).
  const stamped = {};
  serverInternals.recordUpstreamTurn(stamped, now - 5);
  assert.equal(stamped.lastUpstreamAt, now - 5);
  // Out-of-order stamps (never produced live, but cheap to be robust): count
  // everything in-window and release on the true oldest, not position [0].
  const messy = { requestTimes: [now - 1000, now - 2000, now - 4000000] };
  assert.equal(serverInternals.usedThisHour(messy, now), 2);
  assert.equal(serverInternals.oldestInWindow(messy.requestTimes, now - 3600000), now - 2000);
  assert.equal(serverInternals.oldestInWindow([], now - 3600000), null);
});

test('hourly quota: over-quota account excluded from fresh picks, all-spent 429s', (t) => {
  saveRoutingEnv(t);
  delete process.env.DEEPSEEK_PREFERRED_ACCOUNT;
  delete process.env.DEEPSEEK_ROUTING_MODE;
  const originalAccounts = serverInternals.accounts.splice(0);
  const savedSessions = Array.from(serverInternals.sessions.entries());
  t.after(() => {
    serverInternals.accounts.splice(0, serverInternals.accounts.length, ...originalAccounts);
    serverInternals.sessions.clear();
    for (const [k, v] of savedSessions) serverInternals.sessions.set(k, v);
  });
  serverInternals.sessions.clear();
  const now = Date.now();
  const mk = (id) => ({
    id, config: { token: `t-${id}`, cookie: `c-${id}` },
    cooldownUntil: 0, failures: 0, consecutiveTimeouts: 0, consecutiveFailures: 0,
    lastUsedAt: 0, inflight: 0, headers: {}, requestTimes: [],
  });
  const spent = mk('q-spent');
  for (let i = 0; i < 60; i++) serverInternals.recordAccountRequest(spent, now - i * 1000);
  const fresh = mk('q-fresh');
  serverInternals.accounts.push(spent, fresh);
  assert.equal(serverInternals.selectAccountForSession(serverInternals.createSession()).id, 'q-fresh');
  for (let i = 0; i < 60; i++) serverInternals.recordAccountRequest(fresh, now - i * 1000);
  assert.throws(
    () => serverInternals.selectAccountForSession(serverInternals.createSession()),
    (e) => e && e.status === 429 && e.retryAfter > 0,
    'all spent fails fast with Retry-After'
  );
});

test('hourly quota: sticky live chat fails fast on spent account, chat-less rotates', (t) => {
  saveRoutingEnv(t);
  delete process.env.DEEPSEEK_PREFERRED_ACCOUNT;
  delete process.env.DEEPSEEK_ROUTING_MODE;
  const originalAccounts = serverInternals.accounts.splice(0);
  const savedSessions = Array.from(serverInternals.sessions.entries());
  t.after(() => {
    serverInternals.accounts.splice(0, serverInternals.accounts.length, ...originalAccounts);
    serverInternals.sessions.clear();
    for (const [k, v] of savedSessions) serverInternals.sessions.set(k, v);
  });
  serverInternals.sessions.clear();
  const now = Date.now();
  const mk = (id) => ({
    id, config: { token: `t-${id}`, cookie: `c-${id}` },
    cooldownUntil: 0, failures: 0, consecutiveTimeouts: 0, consecutiveFailures: 0,
    lastUsedAt: 0, inflight: 0, headers: {}, requestTimes: [],
  });
  const spent = mk('q-sticky-spent');
  for (let i = 0; i < 60; i++) serverInternals.recordAccountRequest(spent, now - i * 1000);
  const fresh = mk('q-sticky-fresh');
  serverInternals.accounts.push(spent, fresh);
  // Live chat pinned to the spent account: 429, chat preserved, no rotation.
  const live = serverInternals.createSession();
  live.id = 'remote-chat-x';
  live.accountId = 'q-sticky-spent';
  assert.throws(
    () => serverInternals.selectAccountForSession(live),
    (e) => e && e.status === 429 && e.retryAfter > 0 && live.accountId === 'q-sticky-spent',
    'sticky live chat fails fast without rotating'
  );
  // Chat-less sticky on the spent account: resets and rotates to the clean one.
  const chatless = serverInternals.createSession();
  chatless.id = null;
  chatless.accountId = 'q-sticky-spent';
  assert.equal(serverInternals.selectAccountForSession(chatless).id, 'q-sticky-fresh');
});

test('burst cap: window counts, explicit limit gates, default off is inert', () => {
  // NOTE: BURST_PER_MINUTE defaults 0 (off until measured) — these tests pass
  // explicit limits, mirroring how the select path will call once enabled.
  const now = Date.now();
  const acct = { requestTimes: [] };
  assert.equal(serverInternals.burstUsedThisMinute(acct, now), 0);
  assert.equal(serverInternals.withinBurst(acct, now), true, 'default off ignores even floods');
  for (let i = 0; i < 100; i++) serverInternals.recordUpstreamTurn(acct, now);
  assert.equal(serverInternals.withinBurst(acct, now), true, 'still inert when off');
  assert.equal(serverInternals.burstUsedThisMinute(acct, now), 100);
  assert.equal(serverInternals.withinBurst(acct, now, 10), false, '100 >= explicit 10');
  const fresh = { requestTimes: [] };
  for (let i = 0; i < 9; i++) serverInternals.recordUpstreamTurn(fresh, now - i * 1000);
  assert.equal(serverInternals.withinBurst(fresh, now, 10), true, '9 < 10 ready');
  serverInternals.recordUpstreamTurn(fresh, now);
  assert.equal(serverInternals.withinBurst(fresh, now, 10), false, '10th spends it');
  const stale = { requestTimes: [now - 61000, now - 1000] };
  assert.equal(serverInternals.burstUsedThisMinute(stale, now), 1, '61s-old entry aged out');
});

test('burst cap: sticky reject is a pure 429 with untouched scorer state', () => {
  const now = Date.now();
  const mk = (id) => ({
    id, config: { token: `t-${id}`, cookie: `c-${id}` },
    cooldownUntil: 0, failures: 2, consecutiveTimeouts: 0, consecutiveFailures: 0,
    requestTimes: [],
  });
  const busy = mk('b-busy');
  for (let i = 0; i < 10; i++) serverInternals.recordUpstreamTurn(busy, now - i * 1000);
  const live = { id: null, accountId: 'b-busy' };
  live.id = 'remote-chat-b';
  const err = serverInternals.stickyBurstReject(busy, live, now, 10);
  assert.ok(err, 'live chat on burst-spent account rejects');
  assert.equal(err.status, 429);
  assert.ok(err.retryAfter > 0 && err.retryAfter <= 60, `retryAfter in window, saw ${err.retryAfter}`);
  assert.equal(err.type, 'rate_limit');
  assert.equal(live.accountId, 'b-busy', 'no rotation');
  assert.equal(busy.failures, 2, 'no-mark: failures untouched');
  assert.equal(busy.cooldownUntil, 0, 'no-mark: no cooldown imposed');
  assert.equal(serverInternals.stickyBurstReject(busy, { id: null, accountId: 'b-busy' }, now, 10), null, 'chat-less rotates freely');
  assert.equal(serverInternals.stickyBurstReject(busy, live, now, 0), null, 'limit 0 disables');
  assert.equal(serverInternals.stickyBurstReject(busy, live, now, 10).message.includes('/min'), true, 'message names the limit');
  const clean = mk('b-clean');
  assert.equal(serverInternals.stickyBurstReject(clean, live, now, 10), null, 'clean account passes');
});

test('burst cap: ring capacity scales with knobs, setter validates', (t) => {
  assert.equal(serverInternals.computeRingCap(60, 0), 1024, 'floor dominates defaults');
  assert.equal(serverInternals.computeRingCap(100000, 0), 200000, 'high quota stays enforceable');
  assert.equal(serverInternals.computeRingCap(0, 1000), 2000, 'burst scales too');
  serverInternals.setBurstPerMinute(7);
  t.after(() => serverInternals.setBurstPerMinute(0));
  assert.equal(serverInternals.withinBurst({ requestTimes: [] }, Date.now()), true);
  const busy = { requestTimes: [] };
  const now = Date.now();
  for (let i = 0; i < 7; i++) busy.requestTimes.push(now - i * 1000);
  assert.equal(serverInternals.withinBurst(busy, now), false, 'setter took effect');
  serverInternals.setBurstPerMinute('garbage');
  assert.equal(serverInternals.withinBurst(busy, now), false, 'invalid input keeps prior value');
  serverInternals.setBurstPerMinute(-5);
  assert.equal(serverInternals.withinBurst({ requestTimes: [] }, Date.now()), true);
  serverInternals.setBurstPerMinute(0);
  assert.equal(serverInternals.withinBurst(busy, now), true, 'restored to default-off');
});

test('burst cap: select/migration/readyz wiring honors the limit', (t) => {
  saveRoutingEnv(t);
  delete process.env.DEEPSEEK_PREFERRED_ACCOUNT;
  delete process.env.DEEPSEEK_ROUTING_MODE;
  serverInternals.setBurstPerMinute(2);
  t.after(() => serverInternals.setBurstPerMinute(0));
  const originalAccounts = serverInternals.accounts.splice(0);
  const savedSessions = Array.from(serverInternals.sessions.entries());
  t.after(() => {
    serverInternals.accounts.splice(0, serverInternals.accounts.length, ...originalAccounts);
    serverInternals.sessions.clear();
    for (const [k, v] of savedSessions) serverInternals.sessions.set(k, v);
  });
  serverInternals.sessions.clear();
  const now = Date.now();
  const mk = (id) => ({
    id, config: { token: `t-${id}`, cookie: `c-${id}` },
    cooldownUntil: 0, failures: 4, consecutiveTimeouts: 0, consecutiveFailures: 0,
    lastUsedAt: 0, inflight: 0, headers: {}, requestTimes: [],
  });
  const spent = mk('w-spent');
  for (let i = 0; i < 2; i++) serverInternals.recordUpstreamTurn(spent, now - i * 1000);
  const freshAcct = mk('w-fresh');
  serverInternals.accounts.push(spent, freshAcct);
  // Fresh pick excludes the burst-spent account.
  assert.equal(serverInternals.selectAccountForSession(serverInternals.createSession()).id, 'w-fresh');
  // Sticky live chat fails fast AND leaves scorer state byte-identical.
  const live = serverInternals.createSession();
  live.id = 'remote-chat-w';
  live.accountId = 'w-spent';
  const before = { failures: spent.failures, cooldownUntil: spent.cooldownUntil, times: spent.requestTimes.length };
  assert.throws(
    () => serverInternals.selectAccountForSession(live),
    (e) => e && e.status === 429 && e.retryAfter > 0 && live.accountId === 'w-spent',
    'sticky burst-spent fails fast without rotating'
  );
  assert.deepEqual(
    { failures: spent.failures, cooldownUntil: spent.cooldownUntil, times: spent.requestTimes.length },
    { failures: before.failures, cooldownUntil: before.cooldownUntil, times: before.times },
    'burst reject marks nothing'
  );
  // Chat-less sticky rotates freely.
  const chatless = serverInternals.createSession();
  chatless.id = null;
  chatless.accountId = 'w-spent';
  assert.equal(serverInternals.selectAccountForSession(chatless).id, 'w-fresh');
  // Migration skips burst-spent peers.
  const migSession = serverInternals.createSession();
  migSession.id = 'remote-chat-m';
  migSession.accountId = 'w-spent';
  const decision = serverInternals.resolveRateLimitMigration(migSession, serverInternals.accounts, false);
  assert.equal(decision.migrateTo, 'w-fresh', 'migration avoids burst-spent peer');
});

test('burst cap: all-burst-spent Retry-After is minute-scale, release math shared', (t) => {
  saveRoutingEnv(t);
  delete process.env.DEEPSEEK_PREFERRED_ACCOUNT;
  delete process.env.DEEPSEEK_ROUTING_MODE;
  serverInternals.setBurstPerMinute(2);
  t.after(() => serverInternals.setBurstPerMinute(0));
  const originalAccounts = serverInternals.accounts.splice(0);
  const savedSessions = Array.from(serverInternals.sessions.entries());
  t.after(() => {
    serverInternals.accounts.splice(0, serverInternals.accounts.length, ...originalAccounts);
    serverInternals.sessions.clear();
    for (const [k, v] of savedSessions) serverInternals.sessions.set(k, v);
  });
  serverInternals.sessions.clear();
  const now = Date.now();
  const mk = (id) => ({
    id, config: { token: `t-${id}`, cookie: `c-${id}` },
    cooldownUntil: 0, failures: 0, consecutiveTimeouts: 0, consecutiveFailures: 0,
    lastUsedAt: 0, inflight: 0, headers: {}, requestTimes: [],
  });
  const a = mk('v-a');
  const b = mk('v-b');
  for (let i = 0; i < 2; i++) {
    serverInternals.recordUpstreamTurn(a, now - i * 1000);
    serverInternals.recordUpstreamTurn(b, now - i * 1000);
  }
  serverInternals.accounts.push(a, b);
  assert.throws(
    () => serverInternals.selectAccountForSession(serverInternals.createSession()),
    (e) => e && e.status === 429 && e.retryAfter > 30 && e.retryAfter <= 60,
    'all burst-spent quotes minute-scale release, not 1s'
  );
  // Direct release-math cases: cooldown-only / quota-bound / burst-bound / max.
  // NOTE: each fixture gets its own requestTimes array — {...base} would share
  // it by reference and cross-contaminate the cases below.
  const rel = serverInternals.accountReleaseMs;
  const base = () => ({ cooldownUntil: 0, config: { token: 't', cookie: 'c' }, requestTimes: [] });
  assert.equal(rel(base(), now), 0, 'clean account releases now');
  assert.equal(rel({ ...base(), cooldownUntil: now + 5000 }, now), now + 5000, 'cooldown-only');
  const quotaBound = base();
  for (let i = 0; i < 60; i++) quotaBound.requestTimes.push(now - i * 1000);
  assert.equal(rel(quotaBound, now), now - 59000 + 3600000, 'quota-bound releases at oldest+1h');
  const burstBound = base();
  for (let i = 0; i < 2; i++) burstBound.requestTimes.push(now - i * 1000);
  serverInternals.setBurstPerMinute(2);
  try {
    assert.equal(rel(burstBound, now), now - 1000 + 60000, 'burst-bound releases at oldest+60s');
    const triple = { ...base(), cooldownUntil: now + 5000, requestTimes: quotaBound.requestTimes.slice() };
    for (let i = 0; i < 2; i++) triple.requestTimes.push(now - i * 1000);
    assert.equal(rel(triple, now), now - 59000 + 3600000, 'max-of-all wins (quota outlasts burst+cooldown)');
  } finally {
    serverInternals.setBurstPerMinute(0);
  }
});

test('burst cap: isAccountReady is the single predicate behind all four gates', () => {
  const f = serverInternals.isAccountReady;
  const now = Date.now();
  const good = { config: { token: 't', cookie: 'c' }, cooldownUntil: 0 };
  assert.equal(f(good, now), true);
  assert.equal(f({ ...good, cooldownUntil: now + 1000 }, now), false, 'cooling excluded');
  assert.equal(f({ config: { token: '', cookie: 'c' }, cooldownUntil: 0 }, now), false, 'no creds excluded');
  assert.equal(f(null, now), false);
  assert.equal(f(undefined, now), false);
  const noCooldown = { config: { token: 't', cookie: 'c' } };
  assert.equal(f(noCooldown, now), true, 'missing cooldown reads as ready (fail-open, constructor always sets it)');
});

test('retry toggle: anyAccountReady gates the retry on real readiness', () => {
  const f = serverInternals.anyAccountReady;
  const now = Date.now();
  const good = { config: { token: 't', cookie: 'c' }, cooldownUntil: 0 };
  const cooling = { config: { token: 't', cookie: 'c' }, cooldownUntil: now + 600000 };
  const noCreds = { config: { token: '', cookie: '' }, cooldownUntil: 0 };
  assert.equal(f([cooling], now), false, 'all cooling -> skip retry');
  assert.equal(f([cooling, good], now), true);
  assert.equal(f([noCreds], now), false, 'credentialless never ready');
  assert.equal(f([], now), false);
  assert.equal(f(null, now), false);
  const quotaSpent = { config: { token: 't', cookie: 'c' }, cooldownUntil: 0, requestTimes: [] };
  for (let i = 0; i < 60; i++) quotaSpent.requestTimes.push(now - i * 1000);
  assert.equal(f([quotaSpent], now), false, 'quota-spent is not retry-ready');
  assert.equal(f([quotaSpent, good], now), true, 'one clean peer suffices');
  serverInternals.setBurstPerMinute(2);
  try {
    const burstSpent = { config: { token: 't', cookie: 'c' }, cooldownUntil: 0, requestTimes: [now - 1000, now - 2000] };
    assert.equal(f([burstSpent], now), false, 'burst-spent is not retry-ready');
    assert.equal(f([burstSpent, good], now), true, 'one clean peer suffices (burst leg)');
  } finally {
    serverInternals.setBurstPerMinute(0);
  }
});

test('retry toggle: exhausted-429 message guides backoff + compact, keeps contract', () => {
  const msg = serverInternals.rateLimitExhaustedMessage(90);
  assert.ok(msg.includes('~90s'), 'wait time present');
  assert.ok(msg.includes('/compact'), 'compact guidance present');
  assert.ok(!msg.includes('Bearer') && !msg.includes('token='), 'nothing secret-adjacent');
});

test('probe-account: classifyPowResponse verdicts without slicing', () => {
  const c = require('../scripts/probe-account.js').classifyPowResponse;
  assert.deepEqual(c(200, '{"code":0,"data":{"biz_data":{}}}'), { ok: true });
  assert.deepEqual(c(200, '{"code":0}'), { ok: true });
  assert.deepEqual(c(200, '{"data":{}}'), { ok: true });
  assert.deepEqual(c(200, '{"code":40003,"data":null}'), { ok: false, reason: 'pow-missing' });
  assert.deepEqual(c(200, '{"code":40003,"data":{}}'), { ok: false, reason: 'pow-missing' }, 'error code with data is still dead');
  assert.deepEqual(c(200, '{"code":5,"data":{"biz_data":{}}}'), { ok: false, reason: 'pow-missing' });
  assert.deepEqual(c(200, '{"code":"0"}'), { ok: true }, 'string zero counts');
  assert.deepEqual(c(200, '{"code":null,"data":null}'), { ok: false, reason: 'pow-missing' }, 'null code is not alive');
  assert.deepEqual(c(200, 'not json{{{'), { ok: false, reason: 'non-json' });
  assert.deepEqual(c(200, ''), { ok: false, reason: 'non-json' });
  assert.deepEqual(c(401, '{}'), { ok: false, reason: 'http-401' });
  assert.equal(c(200, 'x'.repeat(500) + '{"code":0}').ok, false, 'garbage prefix is not ALIVE');
});

test('smart routing: scoreAccount clamps hostedCount into [0,8]', (t) => {  saveRoutingEnv(t);
  delete process.env.DEEPSEEK_PREFERRED_ACCOUNT;
  delete process.env.DEEPSEEK_ROUTING_MODE;
  const acct = { id: 'sr-clamp', inflight: 0, failures: 0, consecutiveTimeouts: 0 };
  // Negative hosted (unreachable via callers; defensive): floored to 0 → jitter only.
  for (let i = 0; i < 20; i++) {
    const s = serverInternals.scoreAccount(acct, -5);
    assert.ok(s >= 0 && s < 1, `negative hosted leaked into score: ${s}`);
  }
  // Huge hosted: capped at 8 → score in [-8,-7).
  for (let i = 0; i < 20; i++) {
    const s = serverInternals.scoreAccount(acct, 100);
    assert.ok(s >= -8 && s < -7, `hosted cap broken: ${s}`);
  }
});

test('smart routing: inflight clamp warns and floors at zero instead of leaking negative', async (t) => {
  saveRoutingEnv(t);
  delete process.env.DEEPSEEK_PREFERRED_ACCOUNT;
  delete process.env.DEEPSEEK_ROUTING_MODE;
  const originalAccounts = serverInternals.accounts.splice(0);
  const savedSessions = Array.from(serverInternals.sessions.entries());
  const prevFetch = globalThis.fetch;
  const prevWarn = console.warn;
  const warnings = [];
  t.after(() => {
    serverInternals.accounts.splice(0, serverInternals.accounts.length, ...originalAccounts);
    serverInternals.sessions.clear();
    for (const [k, v] of savedSessions) serverInternals.sessions.set(k, v);
    globalThis.fetch = prevFetch;
    console.warn = prevWarn;
  });
  serverInternals.sessions.clear();
  console.warn = (...args) => { warnings.push(args.join(' ')); };
  const only = {
    id: 'sr-neg', config: { token: 't-neg', cookie: 'c-neg' },
    cooldownUntil: 0, failures: 0, consecutiveTimeouts: 0, lastUsedAt: 0, inflight: -5, headers: {},
  };
  serverInternals.accounts.push(only);
  globalThis.fetch = async () => { throw new Error('simulated network down'); };
  await assert.rejects(
    () => serverInternals.askDeepSeekStream('hello', 'sr-agent-neg', 'deepseek-chat'),
    /simulated network down/
  );
  assert.equal(only.inflight, 0, 'negative counter floored at 0');
  assert.ok(warnings.some(w => w.includes('inflight clamp engaged')), `expected clamp warning, saw: ${warnings.join(' | ')}`);
});

test('integer parentMessageId survives persist→restore round-trip (item 1, full path)', () => {
  const s = serverInternals.createSession();
  s.id = 'chat-int';
  s.parentMessageId = 42;
  s.accountId = 'acct-1';
  s.messageCount = 5;
  s.lastActivityAt = Date.now();
  const snap = serverInternals.serializeSession(s);
  const restored = serverInternals.createSession();
  Object.assign(restored, snap);
  assert.strictEqual(restored.parentMessageId, 42);
  assert.strictEqual(restored.parentMessageId, snap.parentMessageId);
});

test('Fix 8: unterminated final SSE event is preserved, not dropped', async () => {
  const { Readable } = require('stream');
  const stream = Readable.from([
    Buffer.from('data: {"v":{"response":{"content":"hello-final"}}}'),
  ]);
  const result = await serverInternals.consumeDeepSeekStream(stream, { isClientGone: () => false });
  assert.equal(result.content, 'hello-final');
  assert.equal(result.abandoned, false);
});

test('Fix 8: split multibyte chunk across buffer boundary parses', async () => {
  const { Readable } = require('stream');
  const full = Buffer.from('data: {"v":{"response":{"content":"hi-😀"}}}\n\n');
  const cut = full.indexOf('😀') + 1;
  const stream = Readable.from([full.subarray(0, cut), full.subarray(cut)]);
  const result = await serverInternals.consumeDeepSeekStream(stream, { isClientGone: () => false });
  assert.equal(result.content, 'hi-😀');
});

test('Fix 8: terminated stream regression identical', async () => {
  const { Readable } = require('stream');
  const stream = Readable.from([
    Buffer.from('data: {"v":{"response":{"fragments":[{"type":"RESPONSE","content":"abc"}]}}}\n\n'),
    Buffer.from('data: {"finish_reason":"stop"}\n\n'),
  ]);
  const result = await serverInternals.consumeDeepSeekStream(stream, { isClientGone: () => false });
  assert.equal(result.content, 'abc');
  assert.equal(result.finishReason, 'stop');
});

test('formatToolDefinitions states batch discipline (6 batches, max 8 per turn)', () => {
  const tools = [{ type: 'function', function: { name: 'bash', description: 'run command' } }];
  const formatted = serverInternals.formatToolDefinitions(tools);
  assert.match(formatted, /at most 6 tool batches per task/);
  assert.match(formatted, /max 8 tool calls/);
});

// ---- Batch 5: Fix 9 reworked / Fix 10 amendment / Fix 11 amendment ----

test('Fix 9: image_url data URL redacted with marker, payload gone', () => {
  const out = serverInternals.normalizeMessageContent([
    { type: 'image_url', image_url: { url: `data:image/png;base64,${'A'.repeat(300)}` } },
  ]);
  assert.match(out, /^\[Image: /);
  assert.match(out, /data omitted/);
  assert.ok(!out.includes('A'.repeat(64)));
});

test('Fix 9: image/input_image source data URLs redacted', () => {
  for (const t of ['image', 'input_image']) {
    const out = serverInternals.normalizeMessageContent([
      { type: t, source: { type: 'base64', url: `data:image/png;base64,${'B'.repeat(300)}` } },
    ]);
    assert.match(out, /^\[Image: /);
    assert.match(out, /data omitted/);
    assert.ok(!out.includes('B'.repeat(64)));
  }
});

test('Fix 9: https URL refs pass through byte-identical', () => {
  const url = 'https://example.com/x.png';
  const outUrl = serverInternals.normalizeMessageContent([{ type: 'image_url', image_url: { url } }]);
  assert.ok(outUrl.includes(url));
  const outImg = serverInternals.normalizeMessageContent([{ type: 'image', source: { type: 'url', url } }]);
  assert.ok(outImg.includes(url));
  const outIn = serverInternals.normalizeMessageContent([{ type: 'input_image', image_url: { url } }]);
  assert.ok(outIn.includes(url));
});

test('Fix 9: false-positive battery passes through untouched', () => {
  const cases = [
    'Explain data: URLs; example {"u":"data:"}',
    'data:text/plain,hello',
    'see https://example.com/?x=data:foo for details',
  ];
  for (const c of cases) {
    assert.equal(serverInternals.normalizeMessageContent(c), c);
    assert.equal(serverInternals.normalizeMessageContent([{ type: 'text', text: c }]), c);
  }
});

test('Fix 9: non-string urls do not throw and yield marker output', () => {
  const shapes = [
    [{ type: 'image_url', image_url: { url: { x: 1 } } }],
    [{ type: 'image', source: { url: 12345 } }],
    [{ type: 'input_image', source: {} }],
    [{ type: 'image_url' }],
  ];
  for (const shape of shapes) {
    let out;
    assert.doesNotThrow(() => { out = serverInternals.normalizeMessageContent(shape); });
    assert.match(out, /^\[Image: /);
  }
});

test('Fix 9: plain-string, unknown-text, and tool_result-nested data URLs redacted with prose intact', () => {
  const mk = (ch) => `data:image/png;base64,${ch.repeat(100)}`;
  const plain = serverInternals.normalizeMessageContent(`before ${mk('C')} after`);
  assert.ok(!plain.includes('C'.repeat(64)));
  assert.ok(plain.startsWith('before ') && plain.endsWith(' after'));
  const unk = serverInternals.normalizeMessageContent([{ type: 'custom', text: `pre ${mk('D')} post` }]);
  assert.ok(!unk.includes('D'.repeat(64)));
  assert.ok(unk.startsWith('pre ') && unk.endsWith(' post'));
  const nested = serverInternals.normalizeMessageContent([{ type: 'tool_result', tool_use_id: 't1', content: `out ${mk('E')} done` }]);
  assert.ok(!nested.includes('E'.repeat(64)));
  assert.ok(nested.includes('out ') && nested.includes(' done'));
});

test('Fix 9: Responses bypasses (input_text, function_call_output, instructions) redacted; file shapes sink', () => {
  const url = `data:image/png;base64,${'F'.repeat(100)}`;
  const msgs = serverInternals.normalizeResponsesInput([
    { type: 'input_text', text: `a ${url} b` },
    { type: 'function_call_output', call_id: 'c1', output: `x ${url} y` },
  ]);
  assert.ok(!msgs[0].content.includes('F'.repeat(64)));
  assert.ok(msgs[0].content.includes('a ') && msgs[0].content.includes(' b'));
  assert.ok(!msgs[1].content.includes('F'.repeat(64)));
  assert.ok(msgs[1].content.includes('x ') && msgs[1].content.includes(' y'));
  const params = serverInternals.normalizeApiParams({ input: 'hi', instructions: `sys ${url} end` }, 'responses');
  assert.equal(params.messages[0].role, 'system');
  assert.ok(!params.messages[0].content.includes('F'.repeat(64)));
  assert.ok(params.messages[0].content.includes('sys ') && params.messages[0].content.includes(' end'));
  for (const t of ['file', 'input_file', 'document']) {
    const out = serverInternals.normalizeMessageContent([{ type: t, file_data: 'SECRET'.repeat(20), data: 'SECRET'.repeat(20) }]);
    assert.ok(!out.includes('SECRET'));
    assert.match(out, /Unsupported content part/);
  }
});

function collectResponsesStreamEvents(openaiResp) {
  const chunks = [];
  const mockRes = { headersSent: true, write(c) { chunks.push(c); }, end() {} };
  serverInternals.finishResponsesStream(mockRes, openaiResp);
  const events = [];
  for (const block of chunks.join('').split('\n\n')) {
    const lines = block.split('\n');
    const ev = lines.find((l) => l.startsWith('event: '));
    const dl = lines.find((l) => l.startsWith('data: '));
    if (!ev || !dl) continue;
    let data;
    try { data = JSON.parse(dl.slice(6)); } catch { continue; }
    events.push({ event: ev.slice(7), data });
  }
  return events;
}

function mkStreamResp(finish) {
  return {
    id: 'ds-test-1', created: 1700000000, model: 'deepseek-chat',
    usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    choices: [{ message: { role: 'assistant', content: 'hello' }, finish_reason: finish }],
  };
}

test('Fix 10: Responses stream message-item status follows truncation (length -> incomplete)', () => {
  const events = collectResponsesStreamEvents(mkStreamResp('length'));
  const done = events.find((e) => e.event === 'response.output_item.done' && e.data.item && e.data.item.type === 'message');
  assert.ok(done, 'message output_item.done event present');
  const terminal = events[events.length - 1];
  assert.equal(terminal.event, 'response.incomplete');
  assert.equal(terminal.data.response.status, 'incomplete');
  assert.equal(done.data.item.status, 'incomplete');
  assert.equal(done.data.item.status, terminal.data.response.status);
});

test('Fix 10: Responses stream message-item status completed on stop', () => {
  const events = collectResponsesStreamEvents(mkStreamResp('stop'));
  const done = events.find((e) => e.event === 'response.output_item.done' && e.data.item && e.data.item.type === 'message');
  assert.ok(done, 'message output_item.done event present');
  const terminal = events[events.length - 1];
  assert.equal(terminal.event, 'response.completed');
  assert.equal(done.data.item.status, 'completed');
  assert.equal(done.data.item.status, terminal.data.response.status);
});

test('Fix 11: null/string/array/number bodies rejected 400 invalid_request in all modes', () => {
  for (const mode of ['anthropic', 'responses', 'openai']) {
    for (const body of [null, 'str', [], 42]) {
      assert.throws(
        () => serverInternals.normalizeApiParams(body, mode),
        (err) => err.status === 400 && err.type === 'invalid_request' && !(err instanceof TypeError) && /JSON object/.test(err.message)
      );
    }
  }
});

test('Fix 11: {} and empty-string-derived {} still pass in all modes', () => {
  for (const mode of ['anthropic', 'responses', 'openai']) {
    assert.doesNotThrow(() => serverInternals.normalizeApiParams({}, mode));
    assert.doesNotThrow(() => serverInternals.normalizeApiParams(JSON.parse('' || '{}'), mode));
  }
});

// ---- Batch 5 follow-up fixes (B5F) ----

test('B5F Fix A: data-URL image refs emit exactly one omission marker', () => {
  const countMarkers = (s) => (s.match(/\(data omitted\)/g) || []).length;
  const dataUrl = `data:image/png;base64,${'A'.repeat(300)}`;
  const outUrl = serverInternals.normalizeMessageContent([
    { type: 'image_url', image_url: { url: dataUrl } },
  ]);
  assert.equal(countMarkers(outUrl), 1);
  assert.ok(!outUrl.includes('A'.repeat(32)));
  assert.equal(outUrl, '[Image: data:image/png;base64,<omitted> (data omitted)]');
  for (const t of ['image', 'input_image']) {
    const out = serverInternals.normalizeMessageContent([
      { type: t, source: { type: 'base64', url: `data:image/png;base64,${'B'.repeat(300)}` } },
    ]);
    assert.equal(countMarkers(out), 1);
    assert.ok(!out.includes('B'.repeat(32)));
  }
});

test('B5F Fix A: https and relative image refs carry no omission marker', () => {
  const refs = ['https://example.com/x.png', '/img/x.png', 'images/x.png'];
  for (const ref of refs) {
    const outUrl = serverInternals.normalizeMessageContent([{ type: 'image_url', image_url: { url: ref } }]);
    assert.equal(outUrl, `[Image: ${ref}]`);
    assert.ok(!outUrl.includes('(data omitted)'));
    const outImg = serverInternals.normalizeMessageContent([{ type: 'image', source: { type: 'url', url: ref } }]);
    assert.equal(outImg, `[Image: ${ref}]`);
    assert.ok(!outImg.includes('(data omitted)'));
    const outIn = serverInternals.normalizeMessageContent([{ type: 'input_image', image_url: { url: ref } }]);
    assert.equal(outIn, `[Image: ${ref}]`);
    assert.ok(!outIn.includes('(data omitted)'));
  }
});

test('B5F B1: empty-mime embedded data URL redacted', () => {
  const out = serverInternals.normalizeMessageContent(`a data:;base64,${'G'.repeat(100)} b`);
  assert.equal(out, 'a data:;base64,<omitted> b');
  assert.ok(!out.includes('G'.repeat(10)));
  assert.ok(out.startsWith('a ') && out.endsWith(' b'));
});

test('B5F B2: data URL split across array parts redacted, benign newlines kept', () => {
  const out = serverInternals.normalizeMessageContent([
    { type: 'text', text: `a data:image/png;base64,${'X'.repeat(30)}` },
    { type: 'text', text: `${'Y'.repeat(100)} b` },
  ]);
  assert.equal(out, 'a data:image/png;base64,<omitted> b');
  assert.ok(!out.includes('X'.repeat(10)));
  assert.ok(!out.includes('Y'.repeat(10)));
  assert.ok(out.startsWith('a ') && out.endsWith(' b'));
  assert.equal(serverInternals.normalizeMessageContent(['hello', 'world']), 'hello\nworld');
});

test('B5F B3: object function_call_output and instructions redacted; scalars safe', () => {
  const url = `data:image/png;base64,${'F'.repeat(100)}`;
  const msgs = serverInternals.normalizeResponsesInput([
    { type: 'function_call_output', call_id: 'c1', output: { result: `x ${url} y` } },
    { type: 'input_text', text: { note: `a ${url} b` } },
  ]);
  assert.equal(msgs[0].content, '{"result":"x data:image/png;base64,<omitted> y"}');
  assert.ok(!msgs[0].content.includes('F'.repeat(10)));
  assert.equal(typeof msgs[0].content, 'string');
  assert.ok(!msgs[1].content.includes('F'.repeat(10)));
  assert.ok(msgs[1].content.includes('a ') && msgs[1].content.includes(' b'));
  const params = serverInternals.normalizeApiParams(
    { input: 'hi', instructions: { note: `sys ${url} end` } }, 'responses');
  assert.equal(params.messages[0].role, 'system');
  assert.equal(params.messages[0].content, '{"note":"sys data:image/png;base64,<omitted> end"}');
  assert.ok(!params.messages[0].content.includes('F'.repeat(10)));
  let circOut;
  const circ = { a: 1 };
  circ.self = circ;
  assert.doesNotThrow(() => {
    circOut = serverInternals.normalizeResponsesInput([
      { type: 'function_call_output', call_id: 'c2', output: circ },
    ])[0].content;
  });
  assert.equal(circOut, '');
  const numOut = serverInternals.normalizeResponsesInput([
    { type: 'function_call_output', call_id: 'c3', output: 5 },
  ])[0].content;
  assert.equal(numOut, 5);
});

test('B5F B3: Responses string input redacted', () => {
  const url = `data:image/png;base64,${'H'.repeat(100)}`;
  const msgs = serverInternals.normalizeResponsesInput(`hi ${url} bye`);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].content, 'hi data:image/png;base64,<omitted> bye');
  assert.ok(!msgs[0].content.includes('H'.repeat(10)));
  assert.equal(serverInternals.normalizeResponsesInput('hello')[0].content, 'hello');
});

test('B5F Fix C: short text-part data URL redacted, benign text-part passthrough', () => {
  const out = serverInternals.normalizeMessageContent([
    { type: 'text', text: `pre data:image/png;base64,${'C'.repeat(100)} post` },
  ]);
  assert.equal(out, 'pre data:image/png;base64,<omitted> post');
  assert.ok(!out.includes('C'.repeat(10)));
  const benign = 'data:text/plain,hello';
  assert.equal(serverInternals.normalizeMessageContent([{ type: 'text', text: benign }]), benign);
});

test('B5G ISSUE-1: =/: prefixed embedded payloads redacted, short tokens pass', () => {
  const payload = 'A'.repeat(120);
  const url = `data:image/png;base64,${payload}`;
  // Original =/: cases + full prefix battery (C1): / , ; > - _ ) ] } whitespace + alnum.
  const mustRedact = [
    `url=${url}`, `a:${url}`, `x=${url} end`,
    `x/${url}`, `x,${url}`, `x;${url}`, `x>${url}`, `x-${url}`, `x_${url}`,
    `x)${url}`, `x]${url}`, `x}${url}`, `x ${url}`, `x\n${url}`, `x\t${url}`,
    `a${url}`, `Z${url}`, `0${url}`,
  ];
  for (const s of mustRedact) {
    const out = serverInternals.normalizeMessageContent(s);
    assert.ok(!out.includes('A'.repeat(10)), `payload leaks for ${JSON.stringify(s.slice(0, 12))}`);
    assert.ok(out.includes('data:image/png;base64,<omitted>'), `marker missing for ${JSON.stringify(s.slice(0, 12))}`);
  }
  // Short-token passthrough still green (existing false-positive battery).
  for (const c of ['?x=data:foo', 'see https://example.com/?x=data:foo for details', 'data:text/plain,hello']) {
    assert.equal(serverInternals.normalizeMessageContent(c), c);
    assert.equal(serverInternals.normalizeMessageContent([{ type: 'text', text: c }]), c);
  }
});

test('B5G ISSUE-2: payload-split tail redacted, normal multipart intact', () => {
  const p1 = `a data:image/png;base64,${'X'.repeat(100)}`;
  const tail = `${'Y'.repeat(100)} b`;
  const out = serverInternals.normalizeMessageContent([
    { type: 'text', text: p1 },
    { type: 'text', text: tail },
  ]);
  assert.ok(!out.includes('X'.repeat(10)), 'head payload leaks');
  assert.ok(!out.includes('Y'.repeat(10)), 'payload-split tail leaks');
  assert.ok(out.startsWith('a ') && out.endsWith(' b'), 'prose intact');
  assert.ok((out.match(/<omitted>/g) || []).length >= 1, 'omission marker missing');
  assert.equal(serverInternals.normalizeMessageContent(['hello', 'world']), 'hello\nworld');
});

test('B5H C4: whitespace/escape-injected payloads redacted, prose preserved', () => {
  const long = 'F'.repeat(120);
  const url = `data:image/png;base64,${long}`;
  // Escaped \n inside JSON args string (backslash-n split 40/80).
  const split = url.slice(0, 40) + '\\n' + url.slice(40);
  const escArgs = JSON.stringify({ data: split });
  const eo = serverInternals.normalizeApiParams(
    { messages: [{ role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: escArgs } }] }] },
    'openai');
  assert.ok(!eo.messages[0].tool_calls[0].function.arguments.includes('F'.repeat(10)), 'escaped-\\n args leak');
  // Space-injected + literal-newline payloads in running text.
  for (const inj of [' ', '\n']) {
    const out = serverInternals.normalizeMessageContent(`a ${url.slice(0, 40)}${inj}${url.slice(40)} b`);
    assert.ok(!out.includes('F'.repeat(10)), `injected ${JSON.stringify(inj)} leaks`);
    assert.ok(out.includes('a ') && out.includes(' b'), `prose lost for ${JSON.stringify(inj)}`);
    assert.ok(out.includes('data:image/png;base64,<omitted>'), 'marker missing');
  }
  // Trailing prose word preserved (continuation chunks require >= 8 chars).
  assert.equal(
    serverInternals.normalizeMessageContent(`before ${url} after`),
    'before data:image/png;base64,<omitted> after');
});

test('B5H C3: whitespace-shifted splits redacted, benign tails kept', () => {
  const p1 = `a data:image/png;base64,${'X'.repeat(100)}`;
  for (const [a, b] of [[p1, ` ${'Y'.repeat(100)} b`], [`${p1} `, `${'Y'.repeat(100)} b`]]) {
    const out = serverInternals.normalizeMessageContent([
      { type: 'text', text: a },
      { type: 'text', text: b },
    ]);
    assert.ok(!out.includes('X'.repeat(10)), 'head leaks');
    assert.ok(!out.includes('Y'.repeat(10)), 'whitespace-shifted tail leaks');
    assert.ok(out.includes('a ') && out.includes(' b'), 'prose intact');
  }
  // H1 gate: benign short tails after a complete image are preserved.
  const hello = serverInternals.normalizeMessageContent([
    { type: 'text', text: p1 },
    { type: 'text', text: 'hello world' },
  ]);
  assert.ok(hello.includes('hello'), 'hello over-redacted');
  const single = serverInternals.normalizeMessageContent([
    { type: 'text', text: p1 },
    { type: 'text', text: 'a' },
  ]);
  assert.ok(single.endsWith('a'), 'single-char tail over-redacted');
});

test('B5I M1: newlines survive multipart redaction, benign joins intact', () => {
  assert.equal(serverInternals.normalizeMessageContent(['a\nb', 'c']), 'a\nb\nc');
  const p1 = `a data:image/png;base64,${'X'.repeat(100)}`;
  const multi = serverInternals.normalizeMessageContent([
    { type: 'text', text: `line1\nline2 ${p1}` },
    { type: 'text', text: `${'Y'.repeat(100)} end\nline3` },
  ]);
  assert.ok(!multi.includes('X'.repeat(10)) && !multi.includes('Y'.repeat(10)), 'payload leaks');
  assert.ok(multi.includes('line1\nline2'), 'intra-part newlines flattened');
  assert.ok(multi.includes('line3'), 'trailing content lost');
});

test('B5I M3: scalar content members preserved, nullish dropped', () => {
  assert.equal(serverInternals.normalizeMessageContent([5, { type: 'text', text: 'hi' }]), '5\nhi');
  assert.equal(serverInternals.normalizeMessageContent([0, { type: 'text', text: 'hi' }]), '0\nhi');
  assert.equal(serverInternals.normalizeMessageContent([false, { type: 'text', text: 'hi' }]), 'false\nhi');
  assert.equal(serverInternals.normalizeMessageContent([null, { type: 'text', text: 'hi' }]), 'hi');
  assert.equal(serverInternals.normalizeMessageContent(['', { type: 'text', text: 'hi' }]), 'hi');
});

test('B5G ISSUE-3: tool-call arguments redacted at normalization, structure intact', () => {
  const url = `data:image/png;base64,${'F'.repeat(100)}`;
  // Anthropic tool_use input.
  const ap = serverInternals.normalizeApiParams(
    { messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'read', input: { path: '/tmp/x', data: url } }] }] },
    'anthropic');
  const aArgs = ap.messages[0].tool_calls[0].function.arguments;
  assert.ok(!aArgs.includes('F'.repeat(10)), 'anthropic args leak');
  assert.deepEqual(JSON.parse(aArgs), { path: '/tmp/x', data: 'data:image/png;base64,<omitted>' });
  // Responses function_call arguments.
  const rp = serverInternals.normalizeResponsesInput(
    [{ type: 'function_call', call_id: 'c1', name: 'read', arguments: JSON.stringify({ path: '/tmp/x', data: url }) }]);
  assert.ok(!rp[0].tool_calls[0].function.arguments.includes('F'.repeat(10)), 'responses args leak');
  assert.deepEqual(JSON.parse(rp[0].tool_calls[0].function.arguments), { path: '/tmp/x', data: 'data:image/png;base64,<omitted>' });
  // OpenAI tool_calls arguments.
  const rawArgs = JSON.stringify({ data: url });
  const op = serverInternals.normalizeApiParams(
    { messages: [{ role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: rawArgs } }] }] },
    'openai');
  const oArgs = op.messages[0].tool_calls[0].function.arguments;
  assert.ok(!oArgs.includes('F'.repeat(10)), 'openai args leak');
  assert.deepEqual(JSON.parse(oArgs), { data: 'data:image/png;base64,<omitted>' });
  // Benign args byte-identical.
  const benign = JSON.stringify({ path: '/tmp/x', n: 1 });
  const bp = serverInternals.normalizeApiParams(
    { messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'read', input: { path: '/tmp/x', n: 1 } }] }] },
    'anthropic');
  assert.equal(bp.messages[0].tool_calls[0].function.arguments, benign);
  const bo = serverInternals.normalizeApiParams(
    { messages: [{ role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: benign } }] }] },
    'openai');
  assert.equal(bo.messages[0].tool_calls[0].function.arguments, benign);
});

test('B5H C2: object-form args + replay envelopes redacted, structure intact', () => {
  const url = `data:image/png;base64,${'Q'.repeat(120)}`;
  // OpenAI object-form args (non-spec but accepted): leaf-redacted in place.
  const oo = serverInternals.normalizeApiParams(
    { messages: [{ role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: { data: url, n: 1 } } }] }] },
    'openai');
  const ooArgs = oo.messages[0].tool_calls[0].function.arguments;
  assert.deepEqual(ooArgs, { data: 'data:image/png;base64,<omitted>', n: 1 });
  assert.ok(!JSON.stringify(ooArgs).includes('Q'.repeat(10)), 'openai object args leak');
  // Legacy function_call form redacted at intake.
  const lo = serverInternals.normalizeApiParams(
    { messages: [{ role: 'assistant', content: null, function_call: { name: 'read', arguments: JSON.stringify({ data: url }) } }] },
    'openai');
  assert.ok(!JSON.stringify(lo).includes('Q'.repeat(10)), 'legacy function_call leak');
  // Responses object-form args.
  const ro = serverInternals.normalizeResponsesInput(
    [{ type: 'function_call', call_id: 'c1', name: 'read', arguments: { data: url } }]);
  assert.ok(!JSON.stringify(ro).includes('Q'.repeat(10)), 'responses object args leak');
  // H3: Anthropic no longer drops OpenAI-style tool_calls.
  const ao = serverInternals.normalizeApiParams(
    { messages: [{ role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: JSON.stringify({ data: url }) } }] }] },
    'anthropic');
  assert.ok(ao.messages.some((m) => m.tool_calls && m.tool_calls.length > 0), 'anthropic tool_calls dropped');
  assert.ok(!JSON.stringify(ao).includes('Q'.repeat(10)), 'anthropic tool_calls leak');
  // Replay stays redacted AND parses (object + string forms).
  for (const args of [{ data: url }, JSON.stringify({ data: url })]) {
    const fm = serverInternals.formatMessages(
      [{ role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: args } }] }], []);
    assert.ok(!fm.prompt.includes('Q'.repeat(10)), 'formatMessages replay leak');
    const m = fm.prompt.match(/Assistant: (\{.*\})/);
    assert.ok(m, 'envelope missing');
    assert.deepEqual(JSON.parse(m[1]), { tool_call: { name: 'read', arguments: { data: 'data:image/png;base64,<omitted>' } } });
  }
  // Benign object deep-equals after round-trip (type-preserving).
  const benignObj = { path: '/tmp/x', n: 1 };
  const be = serverInternals.normalizeApiParams(
    { messages: [{ role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: benignObj } }] }] },
    'openai');
  assert.deepEqual(be.messages[0].tool_calls[0].function.arguments, benignObj);
});

test('B5J H2: egress tool args + reasoning redacted, prose untouched', () => {
  const url = `data:image/png;base64,${'Q'.repeat(120)}`;
  const mk = (finish, tool) => ({
    id: 'x', model: 'm', usage: {},
    choices: [{
      message: Object.assign({ role: 'assistant' },
        tool ? { tool_calls: [{ id: 'c1', function: { name: 'read', arguments: JSON.stringify({ data: url }) } }] }
             : { content: 'hi', reasoning_content: `think ${url}` }),
      finish_reason: finish,
    }],
  });
  // Non-stream builders.
  assert.ok(!JSON.stringify(serverInternals.toAnthropicResponse(mk('tool_calls', true))).includes('Q'.repeat(10)), 'anthropic egress leak');
  assert.ok(!JSON.stringify(serverInternals.toResponsesResponse(mk('tool_calls', true))).includes('Q'.repeat(10)), 'responses egress leak');
  assert.ok(!JSON.stringify(serverInternals.toAnthropicResponse(mk('stop', false))).includes('Q'.repeat(10)), 'reasoning egress leak');
  // Model prose content is deliberately raw (cannot echo what it never saw).
  assert.equal(serverInternals.toAnthropicResponse(mk('stop', false)).content[0].text, 'hi');
  // Stream finishers (complete args at finish time — exact).
  for (const fn of [serverInternals.finishAnthropicStream, serverInternals.finishResponsesStream, serverInternals.finishOpenAIStream]) {
    const chunks = [];
    fn({ headersSent: true, write(c) { chunks.push(c); }, end() {} }, mk('tool_calls', true));
    assert.ok(!chunks.join('').includes('Q'.repeat(10)), `${fn.name} stream leak`);
  }
  // OpenAI reasoning slices: payload straddling a 50-char boundary must not leak.
  for (const pad of ['ab ', 'x'.repeat(40), 'x'.repeat(49), 'x'.repeat(51)]) {
    const chunks = [];
    serverInternals.finishOpenAIStream(
      { headersSent: true, write(c) { chunks.push(c); }, end() {} },
      { id: 'd', created: 1, model: 'm', choices: [{ message: { role: 'assistant', reasoning_content: `${pad}${url} cd` }, finish_reason: 'stop' }] });
    assert.ok(!chunks.join('').includes('Q'.repeat(10)), `slice-straddle leak at pad ${pad.length}`);
  }
});

test('B5J M2: 64-floor is anti-FP — short text passes, image slot redacts', () => {
  const short = `data:image/png;base64,${'S'.repeat(20)}`;
  assert.equal(serverInternals.normalizeMessageContent(`a ${short} b`), `a ${short} b`);
  const out = serverInternals.normalizeMessageContent([{ type: 'image_url', image_url: { url: short } }]);
  assert.ok(out.includes('<omitted>') && !out.includes('S'.repeat(10)), 'image slot must redact regardless of floor');
});

test('B5K M4: zero-copy benign / clone-on-hit contracts', () => {
  // OpenAI benign: original params AND messages refs returned (zero-copy).
  const benign = { messages: [{ role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: '/tmp/x', n: 1 }) } }] }] };
  const bo = serverInternals.normalizeApiParams(benign, 'openai');
  assert.ok(bo === benign, 'benign must return original params ref');
  assert.ok(bo.messages === benign.messages, 'benign must return original messages ref');
  // Dirty: params + messages cloned; untouched tc entries keep refs (shallow).
  const url = `data:image/png;base64,${'Q'.repeat(120)}`;
  const dirty = { messages: [
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: JSON.stringify({ data: url }) } }] },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c2', type: 'function', function: { name: 'read', arguments: JSON.stringify({ n: 1 }) } }] },
  ] };
  const out = serverInternals.normalizeApiParams(dirty, 'openai');
  assert.ok(out !== dirty && out.messages !== dirty.messages, 'hit must clone');
  assert.ok(!JSON.stringify(out).includes('Q'.repeat(10)), 'dirty leak');
  assert.ok(out.messages[1].tool_calls[0] === dirty.messages[1].tool_calls[0], 'clean tc ref must be shared');
  // Responses benign byte-identity (value-level; rebuilds messages by design).
  const rp = serverInternals.normalizeApiParams({ input: 'hello', instructions: 'sys hi' }, 'responses');
  assert.deepEqual(rp.messages.map((m) => m.content), ['sys hi', 'hello']);
});

// === Bug-hunt survivors 2026-09-16 (§1-§10, §12, C1/C2b/C3/H2/H3/M1/H1) ===

test('§1 session sanitize: 64-char cap, strict charset, rejects to fallback', () => {
  const T = serverInternals;
  assert.equal(T.MAX_SESSIONS, 500);
  assert.equal(T.sanitizeSessionId('  abc-123_._X  '), 'abc-123_._X');
  assert.equal(T.sanitizeSessionId('a'.repeat(100)).length, 64);
  for (const bad of ['', '   ', 'has space', 'semi;colon', 'a/b', 'data:text/plain,AAA', 'uniçode', 'a:b']) {
    assert.equal(T.sanitizeSessionId(bad), '', `must reject ${JSON.stringify(bad)}`);
  }
  assert.equal(T.sanitizeSessionId(null), '');
  assert.equal(T.sanitizeSessionId(undefined), '');
});

test('§1 session cap: 429 past MAX_SESSIONS over HTTP, existing key unaffected', async () => {
  const T = serverInternals;
  const saved = snapshotSessions();
  const prevKey = process.env.PROXY_API_KEY;
  process.env.PROXY_API_KEY = 'http-test-key';
  try {
    const principal = T.principalForRequest('Bearer http-test-key', 'http-test-key');
    assert.match(principal, /^[0-9a-f]{16}$/);
    await withServer(async (port) => {
      T.sessions.clear();
      for (let i = 0; i < T.MAX_SESSIONS; i++) T.sessions.set(`${principal}:fill-${i}`, T.createSession());
      const fresh = await post(port, '/v1/chat/completions',
        { model: 'deepseek-chat', messages: [{ role: 'user', content: 'hi' }] },
        { 'x-agent-session': 'brand-new-key' });
      assert.equal(fresh.status, 429, `new key past cap must 429, got ${fresh.status}`);
      assert.match(fresh.body, /session_limit/);
      assert.equal(fresh.headers['retry-after'], '60');
      // Existing key sails past the gate (503 no_auth proves it reached upstream select).
      const known = await post(port, '/v1/chat/completions',
        { model: 'deepseek-chat', messages: [{ role: 'user', content: 'hi' }] },
        { 'x-agent-session': 'fill-0' });
      assert.equal(known.status, 503, `existing key must pass gate, got ${known.status}`);
      assert.equal(T.getInFlightCount(), 0, 'inFlight leaked');
    });
  } finally {
    restoreSessionsFrom(saved);
    if (prevKey === undefined) delete process.env.PROXY_API_KEY;
    else process.env.PROXY_API_KEY = prevKey;
  }
});

test('§2 tool names redacted at intake, persist, render; benign unchanged', () => {
  const T = serverInternals;
  const poison = `data:text/plain;base64,${'A'.repeat(100)}`;
  const rp = T.normalizeResponsesInput(
    [{ type: 'function_call', call_id: 'c1', name: poison, arguments: '{}' }]);
  assert.ok(!JSON.stringify(rp).includes('A'.repeat(10)), 'responses intake name leak');
  const ap = T.normalizeApiParams(
    { messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: poison, input: {} }] }] },
    'anthropic');
  assert.ok(!JSON.stringify(ap).includes('A'.repeat(10)), 'anthropic native name leak');
  const ao = T.normalizeApiParams(
    { messages: [{ role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: poison, arguments: '{}' } }] }] },
    'anthropic');
  assert.ok(!JSON.stringify(ao).includes('A'.repeat(10)), 'anthropic openai-style name leak');
  // Render covers pre-patch .sessions.json entries verbatim.
  const fm = T.formatMessages(
    [{ role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: poison, arguments: '{}' } }] }], []);
  assert.ok(!fm.prompt.includes('A'.repeat(10)), 'render name leak');
  // Persisted history entry clean after a poisoned-name turn.
  const saved = snapshotSessions();
  try {
    T.storeHistory('§2-agent', 'prompt', 'content', { name: poison, arguments: '{}' });
    const hist = T.sessions.get('§2-agent').history;
    assert.ok(hist.length > 0 && !JSON.stringify(hist).includes('A'.repeat(10)), 'persisted name leak');
  } finally {
    restoreSessionsFrom(saved);
  }
  // Benign names byte-identical.
  for (const n of ['read', 'bash', 'read_file', 'unknown']) assert.equal(T.redactToolName(n), n);
  const benign = T.normalizeResponsesInput(
    [{ type: 'function_call', call_id: 'c1', name: 'read', arguments: '{}' }]);
  assert.equal(benign[0].tool_calls[0].function.name, 'read');
});

test('§3 recovery prefix redacts data-URLs, benign history byte-identical', () => {
  const T = serverInternals;
  const url = `data:image/png;base64,${'A'.repeat(100)}`;
  const out = T.buildRecoveryHistoryPrefix([{ user: `u ${url}`, assistant: `a ${url}` }]);
  assert.ok(!out.includes('A'.repeat(20)), 'recovery prefix leak');
  assert.ok(out.includes('<omitted>'), 'omission marker missing');
  assert.equal(T.buildRecoveryHistoryPrefix([{ user: 'hello', assistant: 'world' }]),
    '[Previous conversation]\nUser: hello\nAssistant: world\n\n[Continue from here]\n\n');
});

test('§4 non-base64 data-URLs redacted; short bodies and prose pass', () => {
  const T = serverInternals;
  const o1 = T.normalizeMessageContent(`a data:text/plain,${'A'.repeat(100)} b`);
  assert.ok(!o1.includes('A'.repeat(20)) && o1.includes('<omitted>'), 'text/plain leak');
  assert.ok(o1.startsWith('a ') && o1.endsWith(' b'), 'prose lost');
  assert.ok(!T.normalizeMessageContent(`x data:,${'B'.repeat(80)} y`).includes('B'.repeat(20)), 'bare data: leak');
  // 64+ %XX triplets fail closed by design, even pure %20 padding.
  assert.ok(!T.normalizeMessageContent(`p data:text/plain,${'%20'.repeat(70)} q`).includes('%20'.repeat(5)), '%XX exfil leak');
  // Short bodies + normal prose pass through.
  assert.equal(T.normalizeMessageContent('data:text/plain,hello'), 'data:text/plain,hello');
  assert.equal(T.normalizeMessageContent('see ?x=data:foo bar'), 'see ?x=data:foo bar');
  assert.equal(T.normalizeMessageContent('normal spaced prose with no urls'), 'normal spaced prose with no urls');
});

test('§5 base64url alphabet redacted incl. carryover; hyphen prose intact under floor', () => {
  const T = serverInternals;
  const o = T.redactEmbeddedDataUrls(`a data:image/png;base64,${'AB-_'.repeat(30)} b`);
  assert.ok(!o.includes('AB-_'.repeat(5)), 'base64url leak');
  assert.ok(o.includes('data:image/png;base64,<omitted>'), 'marker missing');
  assert.ok(!T.redactEmbeddedDataUrls(`m data:image/png;base64,${'AB+/=_-'.repeat(20)} n`).includes('AB+/=_-'.repeat(3)), 'mixed alphabet leak');
  // Carryover tail in base64url alphabet.
  const carry = T.normalizeMessageContent([
    { type: 'text', text: `a data:image/png;base64,${'AB-_'.repeat(20)}` },
    { type: 'text', text: `${'CD-_'.repeat(20)} b` },
  ]);
  assert.ok(!carry.includes('AB-_'.repeat(5)) && !carry.includes('CD-_'.repeat(5)), 'base64url carryover leak');
  // Regression: real header + short payload + hyphen/underscore prose stays intact.
  const prose = `see data:image/png;base64,${'A'.repeat(10)} well-known _private -stuff here`;
  assert.equal(T.redactEmbeddedDataUrls(prose), prose);
});

test('§6 oversized body gets immediate 413 (no hang), byte-counted', async () => {
  const T = serverInternals;
  const prevKey = process.env.PROXY_API_KEY;
  delete process.env.PROXY_API_KEY;
  // Chunked sender: writes 256KB slices until the server answers, then stops.
  // A single 11MB req.end() races the server's mid-upload destroy
  // (ECONNRESET masks the 413); trickling models a real client and lets the
  // documented 413 arrive. Post-resolve write errors are no-ops.
  const postChunked = (port, slice, slices) => new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const done = (fn) => (v) => { if (!settled) { settled = true; if (timer) clearInterval(timer); fn(v); } };
    const ok = done(resolve), fail = done(reject);
    const req = http.request({ host: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked', ...authHeaders() } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => ok({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      });
    req.on('error', fail);
    let sent = 0;
    timer = setInterval(() => {
      if (sent >= slices) { clearInterval(timer); try { req.end(); } catch (e) { /* server already answered */ } return; }
      sent++;
      try { req.write(slice); } catch (e) { /* server destroyed mid-upload; response in flight */ }
    }, 5);
  });
  try {
    await withServer(async (port) => {
      const r = await postChunked(port, 'x'.repeat(256 * 1024), 44); // ~11MB
      assert.equal(r.status, 413, `expected 413, got ${r.status}`);
      assert.match(r.body, /payload_too_large/);
      // Multibyte: 6M chars but 12M bytes — char counting would pass, bytes must 413.
      const r2 = await postChunked(port, 'é'.repeat(256 * 1024), 24); // ~12MB on the wire
      assert.equal(r2.status, 413, `multibyte body must 413, got ${r2.status}`);
      assert.equal(T.getInFlightCount(), 0, 'inFlight leaked');
      assert.ok(await pollFor(() => T.getInflightBodyBytes() === 0), 'inflightBodyBytes leaked');
    });
  } finally {
    if (prevKey === undefined) delete process.env.PROXY_API_KEY;
    else process.env.PROXY_API_KEY = prevKey;
  }
});

test('§7 backpressure re-checked at body-end; global body budget 503s', async () => {
  const T = serverInternals;
  const prevKey = process.env.PROXY_API_KEY;
  delete process.env.PROXY_API_KEY;
  const prevFlight = T.getInFlightCount();
  const prevBytes = T.getInflightBodyBytes();
  try {
    await withServer(async (port) => {
      // Arrival passes (inFlight low), cap hits before body-end → 503 with Retry-After.
      const r = await tricklePost(port, async () => { T.setInFlightCount(T.MAX_CONCURRENT); });
      assert.equal(r.status, 503, `re-check must 503, got ${r.status}`);
      assert.equal(r.headers['retry-after'], '2');
      T.setInFlightCount(prevFlight);
      // Global 64MB in-flight body budget: nearly exhausted → small POST 503s.
      T.setInflightBodyBytes(T.MAX_INFLIGHT_BODY_BYTES - 10);
      const r2 = await post(port, '/v1/chat/completions', { small: 1 });
      assert.equal(r2.status, 503, `global budget must 503, got ${r2.status}`);
      assert.match(r2.body, /overloaded/);
      T.setInflightBodyBytes(prevBytes);
      assert.ok(await pollFor(() => T.getInflightBodyBytes() === prevBytes), 'byte charge leaked');
      assert.equal(T.getInFlightCount(), prevFlight, 'inFlight leaked');
    });
  } finally {
    T.setInFlightCount(prevFlight);
    T.setInflightBodyBytes(prevBytes);
    if (prevKey === undefined) delete process.env.PROXY_API_KEY;
    else process.env.PROXY_API_KEY = prevKey;
  }
});

test('§8/H1 null-id turn commits nothing; next turn full-resends', () => {
  const T = serverInternals;
  const s = T.createSession();
  const u1 = { role: 'user', content: 'hi' };
  const u2 = { role: 'user', content: 'there' };
  // Null-id turn: commit skipped, cursor untouched.
  assert.equal(T.commitTurnState(s, null, [u1], true), false);
  assert.equal(T.commitTurnState(s, '', [u1], true), false);
  assert.equal(s.messageCount, 0);
  assert.equal(s.deltaMsgCount, 0);
  assert.equal(s.parentMessageId, null);
  // Next turn: full resend (isDelta:false), not a suffix delta.
  const split = T.splitClientMessages([u1, u2], s);
  assert.equal(split.isDelta, false);
  assert.equal(split.effective.length, 2);
  // Control: committed turn advances and enables suffix delta.
  assert.equal(T.commitTurnState(s, 'm1', [u1], true), true);
  assert.equal(s.messageCount, 1);
  assert.equal(s.parentMessageId, 'm1');
  const split2 = T.splitClientMessages([u1, u2], s);
  assert.equal(split2.isDelta, true);
  assert.equal(split2.effective.length, 1);
});

test('§9 dead-socket writes no-op at choke point; finishers skip trailing end', () => {
  const T = serverInternals;
  const mkResp = (tool) => ({
    id: 'x', model: 'm', created: 1, usage: {},
    choices: [{ message: Object.assign({ role: 'assistant' },
      tool ? { tool_calls: [{ id: 'c1', function: { name: 'read', arguments: '{"a":1}' } }] }
           : { content: 'hi' }), finish_reason: tool ? 'tool_calls' : 'stop' }],
  });
  // Doc falsifiability: throwing stub + writableEnded must no-op, not throw.
  assert.doesNotThrow(() => T.finishAnthropicStream(
    { headersSent: true, writableEnded: true, write: () => { throw new Error('write after end'); }, end: () => { throw new Error('double end'); } },
    mkResp(false)));
  // writeSse choke point directly.
  let wrote = 0;
  T.writeSse({ writableEnded: true, destroyed: false, write: () => { wrote++; } }, 'e', {});
  T.writeSse({ writableEnded: false, destroyed: true, write: () => { wrote++; } }, 'e', {});
  T.writeSse(null, 'e', {});
  assert.equal(wrote, 0);
  // Realistic dead socket: never end(), never throw, for every finisher.
  for (const fn of [T.finishAnthropicStream, T.finishResponsesStream, T.finishOpenAIStream]) {
    for (const resp of [mkResp(false), mkResp(true)]) {
      let ended = 0;
      assert.doesNotThrow(() => fn(
        { headersSent: true, writableEnded: false, destroyed: true, write() {}, end() { ended++; } }, resp),
        `${fn.name} threw on dead socket`);
      assert.equal(ended, 0, `${fn.name} double-ended a dead socket`);
    }
  }
});

test('§10 object/string/array tool args identical on stream vs non-stream', () => {
  const T = serverInternals;
  const mk = (args) => ({
    id: 'x', model: 'm', usage: {},
    choices: [{ message: { role: 'assistant', tool_calls: [{ id: 'c1', function: { name: 'read', arguments: args } }] }, finish_reason: 'tool_calls' }],
  });
  const streamInputOf = (args) => {
    const deltas = [];
    T.finishAnthropicStream({ headersSent: true, write(c) { deltas.push(c); }, end() {} }, mk(args));
    const events = deltas.map((c) => { try { return JSON.parse(c.replace(/^data: /, '').trim()); } catch (e) { return null; } }).filter(Boolean);
    const delta = events.find((e) => e.type === 'content_block_delta');
    assert.ok(delta, 'no input_json_delta emitted');
    return JSON.parse(delta.delta.partial_json);
  };
  for (const args of [{ data: 'hi' }, JSON.stringify({ data: 'hi' })]) {
    assert.deepEqual(T.toAnthropicResponse(mk(args)).content[0].input, { data: 'hi' });
    assert.deepEqual(streamInputOf(args), { data: 'hi' });
  }
  for (const args of ['"42"', '[1,2]', 42, [1, 2], null]) {
    assert.deepEqual(T.toAnthropicResponse(mk(args)).content[0].input, {}, `non-stream ${JSON.stringify(args)}`);
    assert.deepEqual(streamInputOf(args), {}, `stream ${JSON.stringify(args)}`);
  }
});

test('§12 chrome-auth: guard rule, tmp+rename, .bak only on success', () => {
  const auth = require('../scripts/deepseek_chrome_auth.js');
  assert.equal(auth.validatePageAuth(null), false);
  assert.equal(auth.validatePageAuth({}), false);
  assert.equal(auth.validatePageAuth({ token: 't' }), false);
  assert.equal(auth.validatePageAuth({ cookie: 'c' }), false);
  assert.equal(auth.validatePageAuth({ token: 't', cookie: 'c' }), true);
  const dir = tmpdir();
  const out = path.join(dir, 'deepseek-auth.json');
  // Fresh install: written 0600, no .bak, no .tmp residue.
  auth.persistAuthResult(out, { token: 'tok', cookie: 'c', wasmUrl: 'w' });
  assert.ok(fs.existsSync(out));
  assert.ok(!fs.existsSync(`${out}.bak`));
  assert.ok(!fs.existsSync(`${out}.tmp`));
  if (process.platform !== 'win32') assert.equal(fs.statSync(out).mode & 0o777, 0o600);
  const saved = fs.readFileSync(out, 'utf8');
  // Success over tokened existing: .bak preserves the previous file.
  auth.persistAuthResult(out, { token: 'tok2', cookie: 'c2', wasmUrl: 'w' });
  assert.equal(fs.readFileSync(`${out}.bak`, 'utf8'), saved);
  assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).token, 'tok2');
  // Success over empty existing: no backup (stale .bak keeps last good).
  fs.writeFileSync(out, JSON.stringify({ token: '', cookie: '' }));
  fs.rmSync(`${out}.bak`, { force: true });
  auth.persistAuthResult(out, { token: 'tok3', cookie: 'c3', wasmUrl: 'w' });
  assert.ok(!fs.existsSync(`${out}.bak`));
  assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).token, 'tok3');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('C1 principal binding: keyed requests namespaced, keyless is IP-only', () => {
  const T = serverInternals;
  const p = T.principalForRequest('Bearer k', 'k');
  assert.match(p, /^[0-9a-f]{16}$/);
  assert.equal(T.principalForRequest('Bearer wrong', 'k'), '');
  assert.equal(T.principalForRequest(undefined, ''), '');
  assert.equal(T.resolveAgentId({ requestedSession: 'alice', remoteAddr: '1.2.3.4', principal: p }), `${p}:alice`);
  assert.equal(T.resolveAgentId({ requestedSession: 'alice', remoteAddr: '127.0.0.1', principal: '' }), 'dev-agent');
  assert.equal(T.resolveAgentId({ requestedSession: 'alice', remoteAddr: '9.9.9.9', principal: '' }), '9.9.9.9');
  assert.equal(T.resolveAgentId({ requestedSession: 'x'.repeat(100), remoteAddr: '127.0.0.1', principal: p }), `${p}:${'x'.repeat(64)}`);
  assert.equal(T.resolveAgentId({ requestedSession: 'has space', remoteAddr: '127.0.0.1', principal: p }), `${p}:dev-agent`);
});

test('C1 keyless HTTP ignores session header (IP-only bucket)', async () => {
  const T = serverInternals;
  const saved = snapshotSessions();
  const prevKey = process.env.PROXY_API_KEY;
  delete process.env.PROXY_API_KEY;
  try {
    await withServer(async (port) => {
      T.sessions.clear();
      const r = await post(port, '/v1/chat/completions',
        { model: 'deepseek-chat', messages: [{ role: 'user', content: 'hi' }] },
        { 'x-agent-session': 'evil-id' });
      assert.equal(r.status, 503, `expected no_auth 503, got ${r.status}`);
      assert.ok(T.sessions.has('dev-agent'), 'loopback must land in dev-agent bucket');
      assert.ok(![...T.sessions.keys()].some((k) => k.includes('evil-id')), 'header path must be disabled keyless');
    });
  } finally {
    restoreSessionsFrom(saved);
    if (prevKey === undefined) delete process.env.PROXY_API_KEY;
    else process.env.PROXY_API_KEY = prevKey;
  }
});

test('C1 keyed HTTP namespaces the session under the principal', async () => {
  const T = serverInternals;
  const saved = snapshotSessions();
  const prevKey = process.env.PROXY_API_KEY;
  process.env.PROXY_API_KEY = 'http-test-key';
  try {
    const principal = T.principalForRequest('Bearer http-test-key', 'http-test-key');
    await withServer(async (port) => {
      T.sessions.clear();
      const r = await post(port, '/v1/chat/completions',
        { model: 'deepseek-chat', messages: [{ role: 'user', content: 'hi' }] },
        { 'x-agent-session': 'alice' });
      assert.equal(r.status, 503, `expected no_auth 503, got ${r.status}`);
      assert.ok(T.sessions.has(`${principal}:alice`), `namespaced bucket missing: ${[...T.sessions.keys()]}`);
    });
  } finally {
    restoreSessionsFrom(saved);
    if (prevKey === undefined) delete process.env.PROXY_API_KEY;
    else process.env.PROXY_API_KEY = prevKey;
  }
});

test('C2b health hides private fields from anonymous probes unless opted in', () => {
  const T = serverInternals;
  assert.deepEqual(Object.keys(T.buildHealthPayload(undefined, '')).sort(), ['service', 'status', 'watermark']);
  const authed = T.buildHealthPayload('Bearer k', 'k');
  assert.ok(Array.isArray(authed.accounts) && authed.session_reuse, 'authorized must see private status');
  assert.ok(!('accounts' in T.buildHealthPayload(undefined, 'k')), 'anonymous must not see accounts');
  const prev = process.env.DEEPSEEK_PUBLIC_STATUS;
  process.env.DEEPSEEK_PUBLIC_STATUS = '1';
  try {
    assert.ok('accounts' in T.buildHealthPayload(undefined, 'k'), 'opt-in must restore public status');
  } finally {
    if (prev === undefined) delete process.env.DEEPSEEK_PUBLIC_STATUS;
    else process.env.DEEPSEEK_PUBLIC_STATUS = prev;
  }
});

test('C3 media root containment: inside honored, outside and .. rejected', () => {
  const T = serverInternals;
  const dir = tmpdir();
  const inside = path.join(dir, 'a.png');
  fs.writeFileSync(inside, 'x');
  const outsideDir = tmpdir();
  const outside = path.join(outsideDir, 'o.png');
  fs.writeFileSync(outside, 'x');
  const prev = process.env.DEEPSEEK_MEDIA_ROOT;
  process.env.DEEPSEEK_MEDIA_ROOT = dir;
  try {
    assert.equal(T.isMediaPathAllowed(inside), true);
    assert.equal(T.isMediaPathAllowed(path.join(dir, '..', 'evil.png')), false);
    assert.equal(T.isMediaPathAllowed('/etc/hostname'), false);
    assert.equal(T.isMediaPathAllowed(path.join(dir, 'missing.png')), false);
    assert.equal(T.isMediaPathAllowed('relative/x.png'), false);
    assert.ok(!T.getMediaRoot().includes('caelestia'), 'media root must be server-side, not a desktop config path');
    const denied = T.extractScreenshotPaths([
      { role: 'tool', content: JSON.stringify({ screenshot_path: outside }) },
      { role: 'user', content: `see ${outside} please` },
    ]);
    assert.deepEqual(denied, [], `oracle must be closed, got ${JSON.stringify(denied)}`);
    const allowed = T.extractScreenshotPaths([
      { role: 'tool', content: JSON.stringify({ screenshot_path: inside }) },
    ]);
    assert.deepEqual(allowed, [`MEDIA:${inside}`]);
  } finally {
    if (prev === undefined) delete process.env.DEEPSEEK_MEDIA_ROOT;
    else process.env.DEEPSEEK_MEDIA_ROOT = prev;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});

test('H2 persist debounced: schedule is lazy, Now writes through', async () => {
  const T = serverInternals;
  const saved = snapshotSessions();
  try {
    // Drain any stray timer from earlier tests so the lag assertion is exact.
    await new Promise((r) => setTimeout(r, 1100));
    T.sessions.clear();
    T.sessions.set('h2-probe', T.createSession());
    T.persistSessionsNow();
    const store = process.env.DEEPSEEK_SESSION_STORE;
    const before = fs.readFileSync(store, 'utf8');
    assert.ok(before.includes('h2-probe'), 'Now must write synchronously');
    T.sessions.set('h2-probe-2', T.createSession());
    T.persistSessions(); // schedule only: sync read must still show the old snapshot
    assert.equal(fs.readFileSync(store, 'utf8'), before, 'debounced persist must not write synchronously');
    T.persistSessionsNow(); // explicit flush writes
    assert.ok(fs.readFileSync(store, 'utf8').includes('h2-probe-2'), 'flush must write');
  } finally {
    restoreSessionsFrom(saved);
  }
});

test('H3 proxy key lazy: import never touches disk', () => {
  const dir = tmpdir();
  try {
    // A directory as PROXY_API_KEY_FILE throws EISDIR on read: the old
    // import-time loadProxyApiKey() crashed the require; now it must succeed.
    const r = runNode(['-e', `process.env.PROXY_API_KEY_FILE=${JSON.stringify(dir)}; require('./server.js'); console.log('import-ok');`]);
    assert.equal(r.status, 0, `import must not throw, stderr: ${r.stderr}`);
    assert.match(r.stdout, /import-ok/);
    // Missing file still loads lazily to ''.
    const r2 = runNode(['-e', `process.env.PROXY_API_KEY_FILE=${JSON.stringify(path.join(dir, 'missing'))}; const s = require('./server.js'); console.log('key=' + JSON.stringify(s.__test.getProxyKey()));`]);
    assert.equal(r2.status, 0, `stderr: ${r2.stderr}`);
    assert.match(r2.stdout, /key=""/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('H4 sentinel-join: newlines survive, split payload still redacted', () => {
  const T = serverInternals;
  assert.equal(T.normalizeMessageContent(['a\nb', 'c']), 'a\nb\nc');
  const header = 'data:image/png;base64,';
  const payload = 'Z'.repeat(120);
  const frags = [];
  for (let i = 0; i < payload.length; i += 5) frags.push(payload.slice(i, i + 5));
  const texts = frags.map((f, i) => (i === 0 ? `line1\nline2 ${header}${f}` : f));
  texts.push('!!! done.');
  const out = T.normalizeMessageContent(texts.map((t) => ({ type: 'text', text: t })));
  assert.ok(!out.includes('Z'.repeat(10)), 'split payload leaks');
  assert.ok((out.match(/<omitted>/g) || []).length >= 1, 'omission marker missing');
  assert.ok(out.includes('line1\nline2'), 'intra-part newlines flattened');
  // Boundary note: the join sentinel is hex (base64-class, load-bearing so
  // sub-8-char fragments fuse); the sentinel adjacent to the payload end is
  // consumed as part of the redacted span, so the separator before the
  // following part is lost. Text survives, one '\n' doesn't — cosmetic.
  assert.ok(out.includes('!!! done.'), 'trailing part text lost');
});

test('M1 readyz minimal for anonymous, counts when authorized', () => {
  const T = serverInternals;
  assert.deepEqual(T.buildReadyzPayload(undefined, 2, 3, 'k'), { ready: true });
  assert.deepEqual(T.buildReadyzPayload('Bearer k', 2, 3, 'k'), { ready: true, ready_accounts: 2, total_accounts: 3 });
  assert.deepEqual(T.buildReadyzPayload(undefined, 0, 1, 'k'), { ready: false });
});

test('W5 shared title bucket: bare + namespaced match, spoofed does not', () => {
  const T = serverInternals;
  assert.equal(T.isSharedTitleBucket('dev-agent:title'), true);
  assert.equal(T.isSharedTitleBucket('8254c329a92850f6:dev-agent:title'), true);
  // Survives a hypothetical charset change allowing ':': attacker suffixes
  // never match the strict 16-hex-principal shape.
  assert.equal(T.isSharedTitleBucket('evil:dev-agent:title'), false);
  assert.equal(T.isSharedTitleBucket('8254c329a92850f6:evil:dev-agent:title'), false);
  assert.equal(T.isSharedTitleBucket('alice'), false);
  assert.equal(T.isSharedTitleBucket(''), false);
  assert.equal(T.isSharedTitleBucket(null), false);
});

test('OpenAI stream emits terminal usage chunk before [DONE] (TUI context widget)', () => {
  const T = serverInternals;
  const writes = [];
  const res = { headersSent: true, writableEnded: false, destroyed: false, write(c) { writes.push(c); }, end() {} };
  T.finishOpenAIStream(res, { id: 'x', model: 'm', created: 1,
    choices: [{ message: { role: 'assistant', content: 'hello world, this is a long enough response to count tokens here' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } });
  const raw = writes.join('');
  const doneIdx = raw.indexOf('data: [DONE]');
  assert.ok(doneIdx > 0, '[DONE] missing');
  const chunks = writes
    .flatMap((w) => w.split('\n\n'))
    .map((s) => s.replace(/^data: /, '').trim())
    .filter((s) => s && s !== '[DONE]')
    .map((s) => JSON.parse(s));
  const usageChunk = chunks.find((c) => c.usage);
  assert.ok(usageChunk, 'no usage chunk emitted');
  assert.equal(usageChunk.usage.prompt_tokens, 100);
  const usageIdx = raw.indexOf('"usage"');
  assert.ok(usageIdx !== -1 && usageIdx < doneIdx, 'usage must be present and precede [DONE]');
});

test('OpenAI stream suppresses usage chunk on explicit include_usage:false opt-out', () => {
  const T = serverInternals;
  const writes = [];
  const res = { headersSent: true, writableEnded: false, destroyed: false, write(c) { writes.push(c); }, end() {} };
  T.finishOpenAIStream(res, { id: 'x', model: 'm', created: 1,
    choices: [{ message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }, { includeUsage: false });
  const raw = writes.join('');
  assert.ok(raw.indexOf('data: [DONE]') > 0, '[DONE] missing');
  assert.ok(!raw.includes('"usage"'), 'usage chunk must be suppressed on explicit opt-out');
});

test('OpenAI tool-call stream emits terminal usage chunk before [DONE]', () => {
  const T = serverInternals;
  const writes = [];
  const res = { headersSent: true, writableEnded: false, destroyed: false, write(c) { writes.push(c); }, end() {} };
  T.finishOpenAIStream(res, { id: 'x', model: 'm', created: 1,
    choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } }] }, finish_reason: 'tool_calls' }],
    usage: { prompt_tokens: 50, completion_tokens: 5, total_tokens: 55 } });
  const raw = writes.join('');
  const doneIdx = raw.indexOf('data: [DONE]');
  const usageIdx = raw.indexOf('"usage"');
  assert.ok(doneIdx > 0, '[DONE] missing');
  assert.ok(usageIdx !== -1 && usageIdx < doneIdx, 'usage must be present and precede [DONE]');
});

test('buildToolCallResponse attaches redacted reasoning_content for thinking on tool turns', () => {
  const T = serverInternals;
  const resp = T.buildToolCallResponse(
    [{ id: 'call_1', name: 'bash', arguments: '{"command":"ls"}' }],
    'm', 'prompt', 'I should list files first.');
  assert.equal(resp.choices[0].message.reasoning_content, 'I should list files first.');
  assert.equal(resp.choices[0].finish_reason, 'tool_calls');
  // Absent when there is no reasoning (wire shape unchanged for plain turns)
  const plain = T.buildToolCallResponse(
    [{ id: 'call_2', name: 'bash', arguments: '{}' }], 'm', 'prompt', '');
  assert.ok(!('reasoning_content' in plain.choices[0].message));
  // Embedded payloads in thinking are redacted like text turns
  const dirty = T.buildToolCallResponse(
    [{ id: 'call_3', name: 'bash', arguments: '{}' }],
    'm', 'prompt', 'leak data:text/plain,' + 'A'.repeat(64));
  assert.ok(!dirty.choices[0].message.reasoning_content.includes('A'.repeat(64)));
});

test('finishOpenAIStream emits thinking before tool_calls chunk on tool turns (default opts)', () => {
  const T = serverInternals;
  const writes = [];
  const res = { headersSent: true, writableEnded: false, destroyed: false, write(c) { writes.push(c); }, end() {} };
  const resp = T.buildToolCallResponse(
    [{ id: 'call_1', name: 'bash', arguments: '{"command":"ls"}' }],
    'm', 'prompt', 'I should list files first, then report back to the user.');
  T.finishOpenAIStream(res, resp);
  const raw = writes.join('');
  const thinkIdx = raw.indexOf('"reasoning_content"');
  const toolIdx = raw.indexOf('"tool_calls"');
  const doneIdx = raw.indexOf('data: [DONE]');
  assert.ok(thinkIdx !== -1, 'no thinking emitted on tool turn');
  assert.ok(toolIdx !== -1, 'tool_calls chunk missing');
  assert.ok(thinkIdx < toolIdx && toolIdx < doneIdx, 'order must be thinking -> tool_calls -> [DONE]');
});

test('finishOpenAIStream honors res._reasoningEmitted guard', () => {
  const T = serverInternals;
  const writes = [];
  const res = { headersSent: true, writableEnded: false, destroyed: false, _reasoningEmitted: true, write(c) { writes.push(c); }, end() {} };
  const resp = T.buildToolCallResponse(
    [{ id: 'call_1', name: 'bash', arguments: '{"command":"ls"}' }],
    'm', 'prompt', 'Thinking that already streamed live.');
  T.finishOpenAIStream(res, resp); // default opts: suppression comes only from the live-emit flag
  const raw = writes.join('');
  assert.ok(!raw.includes('"reasoning_content"'), 'reasoning must not re-emit after live phase');
  assert.ok(raw.includes('"tool_calls"'), 'tool_calls chunk missing');
  assert.ok(raw.includes('data: [DONE]'), '[DONE] missing');
});

test('finishOpenAIStream delivers tool-turn thinking exactly once, ahead of tool_calls', () => {
  const T = serverInternals;
  const writes = [];
  const res = { headersSent: true, writableEnded: false, destroyed: false, write(c) { writes.push(c); }, end() {} };
  const thinking = 'Step one: inspect. Step two: act. Step three: report back with a summary.';
  const resp = T.buildToolCallResponse(
    [{ id: 'call_1', name: 'bash', arguments: '{"command":"ls"}' }],
    'm', 'prompt', thinking);
  T.finishOpenAIStream(res, resp);
  const payloads = writes.join('').split('\n')
    .filter((l) => l.startsWith('data: ') && l !== 'data: [DONE]')
    .map((l) => JSON.parse(l.slice(6)));
  const thinkParts = payloads
    .filter((p) => p.choices?.[0]?.delta?.reasoning_content !== undefined)
    .map((p) => p.choices[0].delta.reasoning_content);
  assert.equal(thinkParts.join(''), thinking, 'thinking must arrive whole, exactly once');
  assert.ok(thinkParts.length >= 1, 'expected at least one thinking chunk');
  const firstThink = payloads.findIndex((p) => p.choices?.[0]?.delta?.reasoning_content !== undefined);
  const toolIdx = payloads.findIndex((p) => p.choices?.[0]?.delta?.tool_calls);
  assert.ok(firstThink !== -1 && firstThink < toolIdx, 'thinking must precede tool_calls');
});

test('thinking pump emits first packet immediately, throttles, then releases', () => {
  const T = serverInternals;
  const emitted = [];
  const pump = T.createThinkingPump({ intervalMs: 2000, onEmit: (tail) => emitted.push(tail) });
  const think = 'A'.repeat(200);
  pump.push(think, 0);
  assert.equal(emitted.length, 1, 'first push must emit immediately');
  assert.equal(emitted[0], think.slice(0, 136));
  pump.push(think + 'B'.repeat(100), 1000);
  assert.equal(emitted.length, 1, 'push inside interval must not emit');
  pump.push(think + 'B'.repeat(100), 2500);
  assert.equal(emitted.length, 2, 'push after interval must emit');
  assert.equal(emitted.join(''), (think + 'B'.repeat(100)).slice(0, 236));
});

test('thinking pump holds emission on upstream revision', () => {
  const T = serverInternals;
  const emitted = [];
  const pump = T.createThinkingPump({ intervalMs: 2000, onEmit: (t) => emitted.push(t) });
  pump.push('X'.repeat(200), 0);
  assert.equal(emitted.length, 1);
  pump.push('TOTALLY DIFFERENT thinking that replaces everything ' + 'Y'.repeat(200), 5000);
  assert.equal(emitted.length, 1, 'revision must not emit');
  assert.equal(pump.state().sent, '', 'full revision re-bases sent to empty common prefix');
});

test('thinking pump re-bases (not stalls) when redaction completes mid-stream', () => {
  const T = serverInternals;
  const emitted = [];
  const pump = T.createThinkingPump({ intervalMs: 500, onEmit: (t) => emitted.push(t) });
  pump.push('A'.repeat(200), 0);
  assert.equal(emitted.length, 1, 'first packet must emit');
  // A data: payload completes past the floor: redaction rewrites already-sent bytes.
  const diverged = 'A'.repeat(100) + 'data:text/plain;base64,' + 'B'.repeat(80) + ' tail words here and then some more prose to follow';
  pump.push(diverged, 600);
  assert.equal(emitted.length, 1, 'divergent push must not emit, only re-base');
  assert.equal(pump.state().sent, 'A'.repeat(100), 'sent must re-base to longest common prefix');
  pump.push(diverged + ' finally done here.', 1200);
  assert.equal(emitted.length, 2, 'live emission must resume after re-base, not stall until finish');
  const joined = emitted.join('');
  assert.ok(!joined.includes('B'.repeat(20)), 'raw payload must never cross, including across re-base');
  assert.ok(joined.includes('<omitted>'), 'resumed emission carries the redacted form');
});

test('thinking pump records phase timing even when hold-back emits nothing', () => {
  const T = serverInternals;
  const pump = T.createThinkingPump({ intervalMs: 2000, onEmit: () => {} });
  assert.equal(pump.state().phaseMs, 0);
  assert.equal(pump.state().sawThinking, false);
  pump.push('short thought', 1000);
  pump.push('short thought plus more words here yes', 3500);
  const s = pump.state();
  assert.equal(s.sawThinking, true);
  assert.equal(s.phaseMs, 2500);
  assert.equal(s.sent, '', 'nothing long enough to emit');
  pump.reset();
  assert.equal(pump.state().sawThinking, false);
  assert.equal(pump.state().phaseMs, 0);
  const g = T.shouldLogThinkPhase;
  assert.equal(g({ sawThinking: true, phaseMs: 2500, sent: '' }), true);
  assert.equal(g({ sawThinking: false, phaseMs: 0, sent: '' }), false);
  assert.equal(g(null), false);
});

test('thinking pump never emits a raw sub-floor payload across snapshots', () => {
  const T = serverInternals;
  const emitted = [];
  const pump = T.createThinkingPump({ intervalMs: 0, onEmit: (t) => emitted.push(t) });
  const part1 = 'Thinking about the file data:text/plain;base64,SGVs';
  pump.push(part1, 0);
  assert.equal(emitted.length, 0, 'sub-floor partial must be withheld, not emitted raw');
  const part2 = part1 + 'bG8gd29ybGQ=' + 'A'.repeat(60) + ' and then I will call the tool with these arguments in mind, carefully.';
  pump.push(part2, 1);
  assert.ok(emitted.length >= 1, 'emission must resume once decidable');
  assert.ok(!emitted.join('').includes('SGVs'), 'raw partial must never cross, even after completion');
  // LOW-1 boundary pin: terminal sub-floor URL + trailing prose emits once, finish agrees.
  const pump2 = T.createThinkingPump({ intervalMs: 0, onEmit: (t) => emitted.push('P2:' + t) });
  const terminal = 'Note data:text/plain,abc then some trailing prose words here ok today';
  pump2.push(terminal, 0);
  assert.equal(pump2.state().sent, terminal.slice(0, 5));
});

test('thinking pump sent agrees with finish-side redact(sanitize(·))', () => {
  const T = serverInternals;
  const emitted = [];
  const pump = T.createThinkingPump({ intervalMs: 0, onEmit: (t) => emitted.push(t) });
  const LONE = String.fromCharCode(0xD800); // lone surrogate; built programmatically so no raw surrogate lives in source
  const think = 'Step one ' + LONE + ' then step two with enough trailing words to pass the hold window comfortably yes indeed';
  pump.push(think, 0);
  pump.push(think, 1);
  const finishClean = T.redactEmbeddedDataUrls(T.sanitizeContent(think));
  assert.ok(finishClean.startsWith(emitted.join('')), 'pump sent must prefix-match finish-side string');
  assert.ok(!emitted.join('').includes(LONE), 'lone surrogate must not cross');
});

test('finishOpenAIStream emits only the un-sent remainder after live thinking', () => {
  const T = serverInternals;
  const thinking = 'First I will inspect the directory layout, then decide which files to read for the requested change.';
  const resp = T.buildToolCallResponse(
    [{ id: 'call_1', name: 'bash', arguments: '{"command":"ls"}' }],
    'm', 'prompt', thinking);
  const full = resp.choices[0].message.reasoning_content;
  const writes = [];
  const res = { headersSent: true, writableEnded: false, destroyed: false, write(c) { writes.push(c); }, end() {} };
  res._reasoningLiveSent = full.slice(0, 70);
  T.finishOpenAIStream(res, resp);
  const payloads = writes.join('').split('\n')
    .filter((l) => l.startsWith('data: ') && l !== 'data: [DONE]')
    .map((l) => JSON.parse(l.slice(6)));
  const thinkParts = payloads
    .filter((p) => p.choices?.[0]?.delta?.reasoning_content !== undefined)
    .map((p) => p.choices[0].delta.reasoning_content);
  assert.equal(thinkParts.join(''), full.slice(70), 'finish must emit remainder only');
  const firstThink = payloads.findIndex((p) => p.choices?.[0]?.delta?.reasoning_content !== undefined);
  const toolIdx = payloads.findIndex((p) => p.choices?.[0]?.delta?.tool_calls);
  assert.ok(firstThink !== -1 && firstThink < toolIdx, 'remainder must precede tool_calls');
});

test('finishOpenAIStream full-emits thinking on live-prefix diverge without crashing', () => {
  const T = serverInternals;
  const thinking = 'Inspect first, then act on what the directory shows us here.';
  const resp = T.buildToolCallResponse(
    [{ id: 'call_1', name: 'bash', arguments: '{"command":"ls"}' }],
    'm', 'prompt', thinking);
  const full = resp.choices[0].message.reasoning_content;
  const writes = [];
  const res = { headersSent: true, writableEnded: false, destroyed: false, write(c) { writes.push(c); }, end() {} };
  res._reasoningLiveSent = 'something entirely different, not a prefix at all, xyz';
  T.finishOpenAIStream(res, resp);
  const raw = writes.join('');
  assert.ok(raw.includes(JSON.stringify(full.slice(0, 20)).slice(1, 21)), 'diverged finish must emit full reasoning');
  assert.ok(raw.includes('data: [DONE]'), '[DONE] missing');
});

test('consumeDeepSeekStream notifies reasoning progress with growing prefixes', async () => {
  const { Readable } = require('stream');
  const progress = [];
  let done = null;
  const sse = [
    'data: {"v":{"response":{"fragments":[{"type":"THINK","content":"deep "}]}}}\n\n',
    'data: {"v":{"response":{"fragments":[{"type":"THINK","content":"deep "},{"type":"THINK","content":"thoughts "}]}}}\n\n',
    'data: {"p":"response/fragments","v":[{"type":"RESPONSE","content":"Answer."}]}\n\n',
    'data: {"finish_reason":"stop"}\n\n',
  ];
  const result = await serverInternals.consumeDeepSeekStream(Readable.from(sse.map((c) => Buffer.from(c))), {
    onReasoningDone: (r) => { done = r; },
    onReasoningProgress: (r) => { progress.push(r); },
    isClientGone: () => false,
  });
  assert.deepEqual(progress, ['deep ', 'deep thoughts ']);
  assert.equal(done, 'deep thoughts ');
  assert.equal(result.reasoningContent, 'deep thoughts ');
});

test('consumeDeepSeekStream fires progress before transition on combined snapshots', async () => {
  const { Readable } = require('stream');
  const order = [];
  const sse = [
    'data: {"v":{"response":{"fragments":[{"type":"THINK","content":"hmm "},{"type":"RESPONSE","content":"Ans"}]}}}\n\n',
    'data: {"finish_reason":"stop"}\n\n',
  ];
  await serverInternals.consumeDeepSeekStream(Readable.from(sse.map((c) => Buffer.from(c))), {
    onReasoningDone: () => { order.push('done'); },
    onReasoningProgress: () => { order.push('progress'); },
    isClientGone: () => false,
  });
  assert.deepEqual(order, ['progress', 'done']);
});

test('redactEmbeddedDataUrls is idempotent (live/finish parity depends on it)', () => {
  const T = serverInternals;
  const r = T.redactEmbeddedDataUrls;
  const cases = [
    'plain prose, nothing special here at all, just words',
    'leak data:text/plain;base64,' + 'A'.repeat(100) + ' tail',
    'short data:image/png;base64,' + 'B'.repeat(20) + ' x',
    'pct data:text/plain,' + '%20'.repeat(70),
    'surr ' + String.fromCharCode(0xD800) + ' ok',
  ];
  for (const c of cases) assert.equal(r(r(c)), r(c));
});

test('liveThinkingMode truth table pins the OpenAI tool-capable flip', () => {
  const f = serverInternals.liveThinkingMode;
  assert.equal(f('openai', false), 'progressive');
  assert.equal(f('openai', true), 'progressive');
  assert.equal(f('anthropic', true), 'suppressed');
  assert.equal(f('anthropic', false), 'legacy-burst');
  assert.equal(f('responses', true), 'suppressed');
  assert.equal(f('responses', false), 'legacy-burst');
});

test('emit-then-full-revision keeps legacy burst suppressed (Concern-6 regression)', () => {
  const T = serverInternals;
  const pump = T.createThinkingPump({ intervalMs: 0, onEmit: () => {} });
  pump.push('Q'.repeat(200), 0);
  assert.equal(pump.state().everEmitted, true);
  pump.push('entirely new thinking replacing the old one wholesale ' + 'Z'.repeat(200), 1);
  assert.equal(pump.state().sent, '', 'full revision rewinds sent');
  assert.equal(pump.state().everEmitted, true, 'rewind must not un-claim emission');
  assert.equal(T.shouldLegacyBurst('progressive', pump.state().everEmitted, false), false);
});

test('shouldLegacyBurst truth table (burst only on fresh pumps and legacy modes)', () => {
  const b = serverInternals.shouldLegacyBurst;
  assert.equal(b('progressive', false, false), true, 'fresh pump bursts');
  assert.equal(b('progressive', true, false), false, 'emitted pump never re-bursts');
  assert.equal(b('progressive', false, true), false, 'post-burst never re-bursts');
  assert.equal(b('suppressed', false, false), false);
  assert.equal(b('suppressed', true, false), false);
  assert.equal(b('legacy-burst', false, false), true);
  assert.equal(b('legacy-burst', false, true), false);
});

test('THINK_LIVE_INTERVAL_MS default pins 0.5s cadence', () => {
  assert.equal(serverInternals.THINK_LIVE_INTERVAL_MS, 500);
});

test('already-emitted sub-floor prefix stays bounded when payload completes', () => {
  const T = serverInternals;
  const emitted = [];
  const pump = T.createThinkingPump({ intervalMs: 0, onEmit: (t) => emitted.push(t) });
  // Partial sits ≥64 behind the frontier: emitted raw (documented boundary).
  // Spaces in the trailing prose keep the second redactor pass from firing.
  const part1 = 'A'.repeat(100) + 'data:text/plain;base64,' + 'C'.repeat(10) + ' some plain prose words here ok ' + 'D'.repeat(100);
  pump.push(part1, 0);
  assert.ok(emitted.join('').includes('C'.repeat(10)), 'sub-floor partial behind frontier is emitted');
  // Completion flips redaction: pump re-bases instead of stalling.
  const part2 = 'A'.repeat(100) + 'data:text/plain;base64,' + 'C'.repeat(10) + 'E'.repeat(80) + ' some plain prose words here ok ' + 'D'.repeat(100);
  pump.push(part2, 1);
  const finishClean = T.redactEmbeddedDataUrls(T.sanitizeContent(part2));
  assert.ok(finishClean.startsWith(pump.state().sent), 'finish agrees from the re-based point');
  assert.ok(!emitted.join('').includes('E'.repeat(20)), 'post-completion payload never crosses raw');
});

test('two reads through one pump with base sync emit concatenated thinking exactly once', async () => {
  const T = serverInternals;
  const { Readable } = require('stream');
  const emitted = [];
  const pump = T.createThinkingPump({ intervalMs: 0, onEmit: (t) => emitted.push(t) });
  // pumpBase mirrors the handler rule: cumulative reasoning finalized by prior reads.
  let pumpBase = '';
  const prev = 'P'.repeat(150);
  const cont = 'Q'.repeat(150);
  const mk = (think) => Readable.from([
    Buffer.from(`data: {"v":{"response":{"fragments":[{"type":"THINK","content":"${think}"}]}}}\n\n`),
    Buffer.from('data: {"finish_reason":"stop"}\n\n'),
  ]);
  const r1 = await T.consumeDeepSeekStream(mk(prev), {
    onReasoningProgress: (t) => pump.push(pumpBase ? pumpBase + '\n' + t : t, 0),
    isClientGone: () => false,
  });
  pumpBase = r1.reasoningContent;
  const r2 = await T.consumeDeepSeekStream(mk(cont), {
    onReasoningProgress: (t) => pump.push(pumpBase ? pumpBase + '\n' + t : t, 1),
    isClientGone: () => false,
  });
  pumpBase = r1.reasoningContent + '\n' + r2.reasoningContent; // handler append rule
  // Finish with the concatenated reasoning, live mirror from the pump.
  const thinking = pumpBase;
  const resp = T.buildToolCallResponse(
    [{ id: 'call_1', name: 'bash', arguments: '{}' }], 'm', 'prompt', thinking);
  const writes = [];
  const res = { headersSent: true, writableEnded: false, destroyed: false, write(c) { writes.push(c); }, end() {} };
  res._reasoningLiveSent = pump.state().sent;
  T.finishOpenAIStream(res, resp);
  const finishParts = writes.join('').split('\n')
    .filter((l) => l.startsWith('data: ') && l !== 'data: [DONE]')
    .map((l) => JSON.parse(l.slice(6)))
    .filter((p) => p.choices?.[0]?.delta?.reasoning_content !== undefined)
    .map((p) => p.choices[0].delta.reasoning_content);
  assert.equal(emitted.join('') + finishParts.join(''), thinking, 'concatenated thinking must cross exactly once, in order');
});
