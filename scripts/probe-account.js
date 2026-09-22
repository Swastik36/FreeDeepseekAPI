#!/usr/bin/env node
/*
  Probe a DeepSeek auth file against create_pow_challenge.
  Used by scripts/auth-cli.sh (check/add/renew/import gates).

  Usage:
    node scripts/probe-account.js <auth.json> [--json]

  Output (human):  ALIVE <ms> | DEAD <reason> <ms>
  Output (--json): {"ok":true,"ms":123} | {"ok":false,"reason":"...","ms":123}
  Exit codes: 0 ALIVE, 1 DEAD, 2 usage/file error.

  Only lengths/reasons are printed — never token or cookie material.
*/
const fs = require('fs');

const POW_URL = 'https://chat.deepseek.com/api/v0/chat/create_pow_challenge';

// Quarantine allowlist (unit-tested, single source of truth for CLI + doctor):
// only reasons proving the credential itself is dead may exile an account.
// Rate limits, server errors, malformed envelopes, transport failures and
// unreadable files must NEVER trigger a move (see double-tap + breaker in
// auth-cli.sh for the remaining false-positive guards).
function isQuarantineWorthy(reason) {
  return reason === 'pow-missing' || reason === 'http-401' || reason === 'http-403';
}

// Pure verdict classifier (unit-tested): full-body parse, never slice-before-parse.
function classifyPowResponse(status, bodyText) {
  const body = String(bodyText || '');
  if (status !== 200) return { ok: false, reason: `http-${status}` };
  let json = null;
  try {
    json = JSON.parse(body);
  } catch {
    return { ok: false, reason: 'non-json' };
  }
  if (!json || typeof json !== 'object') return { ok: false, reason: 'non-json' };
  // ALIVE requires an explicit success code. A truthy `data` alone is NOT
  // enough: error envelopes can carry non-null data (e.g. code 40003), and
  // installing those would defeat the probe gate. The only exception is a
  // missing code field (some shapes omit it) with present data.
  // (Accepts numeric 0 and string "0"; nothing else falsy — Number(null) and
  // Number("") are 0 too and must NOT count as alive.)
  if (json.code === 0 || json.code === '0') return { ok: true };
  if (json.code === undefined && json.data) return { ok: true };
  return { ok: false, reason: 'pow-missing' };
}

async function probeFile(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const auth = JSON.parse(raw);
  const token = String(auth.token || '').trim();
  const cookie = String(auth.cookie || '').trim();
  if (!token || !cookie) return { ok: false, reason: 'file-missing-token-or-cookie', ms: 0 };
  const started = Date.now();
  let status = 0;
  let text = '';
  try {
    const res = await fetch(POW_URL, {
      method: 'POST',
      headers: {
        'User-Agent': 'Mozilla/5.0',
        Authorization: `Bearer ${token}`,
        Cookie: cookie,
        'Content-Type': 'application/json',
        Origin: 'https://chat.deepseek.com',
      },
      body: JSON.stringify({ target_path: '/api/v0/chat/completion' }),
      signal: AbortSignal.timeout(30000),
    });
    status = res.status;
    text = await res.text();
  } catch (e) {
    return { ok: false, reason: `network:${String((e && e.cause && e.cause.code) || (e && e.name) || 'fetch-failed').slice(0, 40)}`, ms: Date.now() - started };
  }
  const verdict = classifyPowResponse(status, text);
  verdict.ms = Date.now() - started;
  return verdict;
}

async function main(argv = process.argv.slice(2)) {
  const asJson = argv.includes('--json');
  const file = argv.find(a => !a.startsWith('-'));
  if (!file) {
    console.error('Usage: node scripts/probe-account.js <auth.json> [--json]');
    return 2;
  }
  let verdict;
  try {
    verdict = await probeFile(file);
  } catch (e) {
    console.error(`[probe] cannot read ${file}: ${e.message}`);
    return 2;
  }
  if (asJson) {
    console.log(JSON.stringify(verdict));
  } else if (verdict.ok) {
    console.log(`ALIVE ${verdict.ms}ms`);
  } else {
    console.log(`DEAD ${verdict.reason} ${verdict.ms}ms`);
  }
  return verdict.ok ? 0 : 1;
}

if (require.main === module) {
  main().then(code => process.exit(code)).catch(e => { console.error('[probe] ERROR:', e.message); process.exit(1); });
}

module.exports = { classifyPowResponse, isQuarantineWorthy, probeFile };
