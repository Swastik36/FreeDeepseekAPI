#!/usr/bin/env node
// Manual probe: try every model_type/thinking/search combination against the
// live DeepSeek Web API and dump the raw response. Run by hand only:
//   node scripts/probe_deepseek_models.js
const fs = require('fs');
const path = require('path');
const { solvePOW } = require('../lib/pow');

const DS_CONFIG_PATH = process.env.DEEPSEEK_AUTH_PATH || path.join(__dirname, '..', 'deepseek-auth.json');

// Read lazily: merely requiring this file (e.g. from a test) must not touch
// credentials on disk or throw when they are absent.
function loadConfig() {
  return JSON.parse(fs.readFileSync(DS_CONFIG_PATH, 'utf8'));
}

function buildHeaders(config) {
  return {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
    "x-client-platform": "web",
    "x-client-version": "2.0.0",
    "x-client-locale": "ru",
    "x-client-timezone-offset": "14400",
    "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.8",
    "x-app-version": "2.0.0",
    "Authorization": `Bearer ${config.token}`,
    "x-hif-dliq": config.hif_dliq || '',
    "x-hif-leim": config.hif_leim || '',
    "Origin": "https://chat.deepseek.com",
    "Referer": "https://chat.deepseek.com/",
    "Cookie": config.cookie,
    "Content-Type": "application/json",
  };
}

async function createSession(headers) {
  const sr = await fetch('https://chat.deepseek.com/api/v0/chat_session/create', { method: 'POST', headers, body: '{}' });
  const text = await sr.text();
  if (!sr.ok) throw new Error(`create session HTTP ${sr.status}: ${text}`);
  const data = JSON.parse(text);
  return data.data.biz_data.chat_session?.id || data.data.biz_data.id;
}

async function createPow(headers, config) {
  const cr = await fetch('https://chat.deepseek.com/api/v0/chat/create_pow_challenge', {
    method: 'POST', headers,
    body: JSON.stringify({ target_path: '/api/v0/chat/completion' })
  });
  const text = await cr.text();
  if (!cr.ok) throw new Error(`pow HTTP ${cr.status}: ${text}`);
  const data = JSON.parse(text);
  const challenge = data.data.biz_data.challenge;
  const answer = await solvePOW(challenge, config.wasmUrl);
  return Buffer.from(JSON.stringify({
    algorithm: challenge.algorithm,
    challenge: challenge.challenge,
    salt: challenge.salt,
    answer,
    signature: challenge.signature,
    target_path: '/api/v0/chat/completion'
  })).toString('base64');
}

async function probe(headers, config, model_type, thinking_enabled, search_enabled) {
  const sessionId = await createSession(headers);
  const pow = await createPow(headers, config);
  const resp = await fetch('https://chat.deepseek.com/api/v0/chat/completion', {
    method: 'POST',
    headers: { ...headers, 'X-DS-PoW-Response': pow },
    body: JSON.stringify({
      chat_session_id: sessionId,
      parent_message_id: null,
      model_type,
      prompt: 'Ответь ровно OK',
      ref_file_ids: [],
      thinking_enabled,
      search_enabled,
      action: null,
      preempt: false,
    })
  });
  console.log(`\n## ${model_type} thinking=${thinking_enabled} search=${search_enabled} HTTP ${resp.status}`);
  const text = await resp.text();
  console.log(text.split('\n').filter(Boolean).slice(0,80).join('\n').slice(0,8000));
}

async function main() {
  const config = loadConfig();
  const headers = buildHeaders(config);
  const combos = [
    ['default', false, false],
    ['default', true, false],
    ['default', false, true],
    ['default', true, true],
    ['expert', false, false],
    ['expert', true, false],
    ['expert', false, true],
    ['vision', false, false],
  ];
  for (const c of combos) {
    try { await probe(headers, config, ...c); }
    catch (e) { console.log(`\n## ${c.join('/')} ERROR ${e.message}`); }
  }
}

if (require.main === module) {
  main().catch(e => {
    console.error(`probe failed: ${e.message}`);
    process.exit(1);
  });
}

module.exports = { loadConfig, buildHeaders };
