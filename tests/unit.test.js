const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
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

test('fresh-chat tie at zero picks a ready account (round-robin fallback)', (t) => {
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
  // Parity-independent: both picks valid, and the tie-break alternates.
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
  const depthSession = serverInternals.createSession();
  depthSession.id = 'deep-session';
  depthSession.messageCount = 100;
  depthSession.accountId = 'account_1';
  depthSession.history.push({ user: 'u', assistant: 'a' });
  const depthReset = serverInternals.prepareSessionForPrompt(depthSession, Date.now());
  assert.equal(depthReset.reason, 'max_message_depth');
  assert.equal(depthSession.id, null);
  assert.equal(depthSession.history.length, 1);
  assert.equal(depthSession.accountId, 'account_1');

  const now = Date.now();
  const ttlSession = serverInternals.createSession();
  ttlSession.id = 'old-session';
  ttlSession.createdAt = now - (2 * 60 * 60 * 1000) - 1;
  const ttlReset = serverInternals.prepareSessionForPrompt(ttlSession, now);
  assert.equal(ttlReset.reason, 'session_ttl');
  assert.equal(ttlReset.failedSessionId, 'old-session');
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

test('lean repair prompt keeps instruction intact and carries tools + latest turn', () => {
  const tools = [{ type: 'function', function: { name: 'read', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } }];
  const messages = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'first question' },
    { role: 'assistant', content: 'an answer' },
    { role: 'user', content: 'read /etc/hostname now' },
  ];
  const prev = process.env.DEEPSEEK_LOCAL_SHELL;
  try {
    delete process.env.DEEPSEEK_LOCAL_SHELL;
    const lean = serverInternals.buildLeanRepairPrompt(tools, messages);
    assert.ok(lean.startsWith('[STRICT INSTRUCTION — DeepSeek Web backend, repair attempt]'));
    assert.match(lean, /read: Read a file/);
    assert.match(lean, /read \/etc\/hostname now/);
    assert.doesNotMatch(lean, /first question/);
    // Huge latest turn gets bounded, instruction never truncated.
    const big = [...messages.slice(0, 3), { role: 'user', content: 'x'.repeat(100000) }];
    const leanBig = serverInternals.buildLeanRepairPrompt(tools, big);
    assert.ok(leanBig.startsWith('[STRICT INSTRUCTION — DeepSeek Web backend, repair attempt]'));
    assert.ok(leanBig.length < 80000);
  } finally {
    if (prev === undefined) delete process.env.DEEPSEEK_LOCAL_SHELL;
    else process.env.DEEPSEEK_LOCAL_SHELL = prev;
  }
});

test('lean repair prompt carries SHELL + tool preference so same-chat repairs stay fish-compatible', () => {
  const prev = process.env.DEEPSEEK_LOCAL_SHELL;
  const tools = [
    { type: 'function', function: { name: 'bash', description: 'run a command', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } },
    { type: 'function', function: { name: 'read', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  ];
  const messages = [
    { role: 'user', content: 'check the distinctive-earlier-question status' },
    { role: 'assistant', content: 'an answer' },
    { role: 'user', content: 'run the distinctive-latest-request now' },
  ];
  try {
    delete process.env.DEEPSEEK_LOCAL_SHELL;
    const lean = serverInternals.buildLeanRepairPrompt(tools, messages);
    // First-attempt repair shape: nudge + tools, no history resend.
    assert.ok(lean.startsWith('[STRICT INSTRUCTION — DeepSeek Web backend, repair attempt]'));
    assert.match(lean, /SHELL: operator console shell is fish/);
    assert.match(lean, /prefer read\/edit\/grep tools over shell/);
    assert.match(lean, /distinctive-latest-request/);
    assert.doesNotMatch(lean, /distinctive-earlier-question/);
  } finally {
    if (prev === undefined) delete process.env.DEEPSEEK_LOCAL_SHELL;
    else process.env.DEEPSEEK_LOCAL_SHELL = prev;
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
  try {
    const paths = serverInternals.extractScreenshotPaths([
      { role: 'user', content: [{ type: 'text', text: `see ${shot} please` }] },
    ]);
    assert.ok(paths.includes(`MEDIA:${shot}`), `expected MEDIA tag, got ${JSON.stringify(paths)}`);
  } finally {
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


