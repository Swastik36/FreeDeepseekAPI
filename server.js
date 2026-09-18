#!/usr/bin/env node
/**
 * OpenAI-compatible API server wrapping DeepSeek Web API
 * Supports BOTH streaming (SSE) and non-streaming modes
 * Includes tool calling: injects tool definitions into system prompt,
 * parses LLM text responses for TOOL_CALL patterns, returns OpenAI tool_calls format.
 * 
 * Per-agent sessions: each unique `user` field gets its own DeepSeek web session.
 * Auto-reset: sessions reset when message chain reaches 100 messages or age > 2 hours.
 * Listens on 127.0.0.1:9655 by default (HOST is configurable)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { solvePOW } = require('./lib/pow');

// Per-DeepSeek-request network timeout. Plain fetch() has NO default timeout, so a
// stalled upstream would hang the inbound request (and pin the account) forever.
// Validated numeric env: garbage values fall back to the default with a
// one-time warning instead of silently poisoning runtime behavior (NaN
// timeouts throw on every call; NaN deadlines/cooldowns never trigger).
function numEnv(name, def, min = -Infinity, max = Infinity) {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return def;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < min || value > max) {
        console.log(`[DS-API] Invalid ${name}=${JSON.stringify(raw)}; using default ${def}.`);
        return def;
    }
    return value;
}

const DS_FETCH_TIMEOUT_MS = numEnv('DEEPSEEK_FETCH_TIMEOUT_MS', 60000, 1);
function dsFetch(url, options = {}, timeoutMs = DS_FETCH_TIMEOUT_MS) {
    return fetch(url, { ...options, signal: options.signal || AbortSignal.timeout(timeoutMs) });
}

// Log verbosity: DEEPSEEK_LOG_LEVEL=debug enables per-pick score breakdowns and
// stage timings. Default info. Anything else falls back to info.
const LOG_LEVELS = { debug: 0, info: 1 };
const LOG_THRESHOLD = LOG_LEVELS[String(process.env.DEEPSEEK_LOG_LEVEL || 'info').trim().toLowerCase()] ?? 1;
function logDebug(...args) { if (LOG_THRESHOLD <= 0) console.log(...args); }


const FORGETMEAI_WATERMARK = 't.me/forgetmeai';
// Validated like every other numeric env: PORT=garbage used to yield NaN and
// crash server.listen (F17). Range-checked 1-65535 with a loud fallback.
const PORT = numEnv('PORT', 9655, 1, 65535);
const HOST = process.env.HOST || '127.0.0.1';

function loadProxyApiKey(env = process.env) {
    if (env.PROXY_API_KEY) return String(env.PROXY_API_KEY);
    const secretPath = String(env.PROXY_API_KEY_FILE || '').trim();
    if (!secretPath) return '';
    try {
        return fs.readFileSync(secretPath, 'utf8').trim();
    } catch (error) {
        // A missing optional secret is equivalent to an unset key. Container
        // deployments set REQUIRE_PROXY_API_KEY=1 and fail closed in main().
        if (error.code === 'ENOENT') return '';
        throw new Error(`Could not read PROXY_API_KEY_FILE (${secretPath}): ${error.message}`);
    }
}

function requireProxyApiKey(key, required) {
    if (required && !key) {
        throw new Error('PROXY_API_KEY is required. Set PROXY_API_KEY or mount a secret and set PROXY_API_KEY_FILE.');
    }
}

// Lazy proxy key (H3): module scope must not touch disk, so
// `require('../server.js').__test` never throws on an unreadable secret.
// First use caches; callers pass through getProxyKey().
let PROXY_API_KEY = '';
let _proxyKeyLoaded = false;
function getProxyKey(env = process.env) {
    // Env is read fresh (cheap, no disk); only the optional FILE read is
    // cached. Semantics match the old import-time load when env is static,
    // and unit tests can set/unset PROXY_API_KEY per case without a reset hook.
    if (env.PROXY_API_KEY) return String(env.PROXY_API_KEY);
    if (_proxyKeyLoaded) return PROXY_API_KEY;
    PROXY_API_KEY = loadProxyApiKey(env);
    _proxyKeyLoaded = true;
    return PROXY_API_KEY;
}
const PROXY_CORS_ORIGINS = new Set(String(process.env.PROXY_CORS_ORIGINS || '')
    .split(',')
    .map(value => normalizeOrigin(value))
    .filter(Boolean));
function formatWatermark(prefix = 'ForgetMeAI') { return `${prefix}: ${FORGETMEAI_WATERMARK}`; }
function printBanner() {
    console.log(`
███████ ██████  ███████ ███████ ██████  ███████ ███████ ███████ ██   ██
██      ██   ██ ██      ██      ██   ██ ██      ██      ██      ██  ██
█████   ██████  █████   █████   ██   ██ █████   █████   █████   █████
██      ██   ██ ██      ██      ██   ██ ██      ██      ██      ██  ██
██      ██   ██ ███████ ███████ ██████  ███████ ███████ ███████ ██   ██

   FreeDeepseekAPI — API proxy for DeepSeek Web Chat
   ${formatWatermark()}
`);
}
function prompt(question) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans); }));
}
function isTruthy(value) { return typeof value === 'string' && ['1','true','yes','on'].includes(value.trim().toLowerCase()); }

function isProxyAuthorized(authorization, expectedKey) {
    const key = expectedKey === undefined ? getProxyKey() : expectedKey;
    if (!key) return true;
    if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) return false;
    const supplied = Buffer.from(authorization.slice('Bearer '.length), 'utf8');
    const expected = Buffer.from(String(key), 'utf8');
    return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

function isLoopbackHost(host) {
    const normalized = String(host || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
    return normalized === '127.0.0.1'
        || normalized === '::1'
        || normalized === '::ffff:127.0.0.1'
        || normalized === 'localhost';
}

function normalizeOrigin(origin) {
    const value = String(origin || '').trim().replace(/\/+$/, '');
    if (!value) return '';
    try {
        const parsed = new URL(value);
        return parsed.origin === 'null' ? value : parsed.origin;
    } catch (e) {
        return value;
    }
}

function isBrowserOriginAllowed(origin, allowedOrigins = PROXY_CORS_ORIGINS) {
    if (!origin) return true; // curl, SDKs, and other non-browser clients
    const normalized = normalizeOrigin(origin);
    if (allowedOrigins.has(normalized)) return true;
    try {
        const parsed = new URL(normalized);
        return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
            && isLoopbackHost(parsed.hostname);
    } catch (e) {
        return false;
    }
}

const CONTEXT_COMPACTED_HEADER = 'X-FreeDeepseek-Context-Compacted';
function setCorsResponseHeaders(res) {
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Expose-Headers', CONTEXT_COMPACTED_HEADER);
}
function markContextCompacted(res) {
    // Best-effort signal only: on streams the headers are already flushed
    // (start*Stream runs before the upstream read), and setHeader would
    // throw ERR_HTTP_HEADERS_SENT out of the empty-retry loop (:3014).
    if (!res || res.headersSent || res.writableEnded) return;
    try {
        res.setHeader(CONTEXT_COMPACTED_HEADER, 'true');
    } catch (e) { /* headers flushed mid-call; header is expendable */ }
}

// === Per-Agent Session Store ===
const sessions = new Map();  // keyed by agent ID (from `user` field)
const MAX_HISTORY_LENGTH = 15;
const MAX_HISTORY_CHARS = 10000;
const MAX_MESSAGE_DEPTH = 100;  // auto-reset after this many messages
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;  // 2 hours

// === Session persistence (survive restarts) ===
// A restart used to wipe the in-memory chat map, reopening every live
// conversation as a brand-new remote chat with truncated context. The map is
// snapshotted to disk on every mutation (atomic tmp+rename, mode 0600) and
// restored at startup. Stale entries past 2x TTL are dropped on load,
// mirroring sweepIdleSessions. Persistence never throws: a failed snapshot
// only logs, so the proxy keeps serving.
const SESSION_STORE_PATH = process.env.DEEPSEEK_SESSION_STORE || path.join(__dirname, '.sessions.json');

function serializeSession(session) {
    const s = session && typeof session === 'object' ? session : {};
    return {
        id: typeof s.id === 'string' ? s.id : null,
        parentMessageId: (typeof s.parentMessageId === 'string' || Number.isFinite(s.parentMessageId)) ? s.parentMessageId : null,
        createdAt: typeof s.createdAt === 'number' ? s.createdAt : null,
        messageCount: Number(s.messageCount) || 0,
        accountId: typeof s.accountId === 'string' ? s.accountId : null,
        // Coerce entry shapes (F22): a hand-edited or corrupted store could
        // otherwise smuggle non-string fields past restore and crash readers
        // (e.g. the reset-session preview's e.user.substring) with a 500.
        // Live entries are always strings, so this is a no-op in the hot path.
        history: Array.isArray(s.history) ? s.history.slice(-MAX_HISTORY_LENGTH).map(e => ({
            user: typeof e?.user === 'string' ? e.user : String(e?.user ?? ''),
            assistant: typeof e?.assistant === 'string' ? e.assistant : String(e?.assistant ?? ''),
        })) : [],
        lastActivityAt: typeof s.lastActivityAt === 'number' ? s.lastActivityAt : Date.now(),
        deltaMsgCount: Number(s.deltaMsgCount) || 0,
        deltaBoundary: typeof s.deltaBoundary === 'string' ? s.deltaBoundary : null,
        deltaPrefixHash: typeof s.deltaPrefixHash === 'string' ? s.deltaPrefixHash : null,
        deltaToolNames: typeof s.deltaToolNames === 'string' ? s.deltaToolNames : null,
        // Repeat-repair guard rides along so a restart between a 502 and the
        // client's verbatim retry still recognizes the turn (staleness is
        // enforced by classifyRepairAttempt's window, not here). The hash is
        // one-way hex — no prompt content recoverable from disk.
        repairHash: typeof s.repairHash === 'string' ? s.repairHash : null,
        repairAt: typeof s.repairAt === 'number' ? s.repairAt : 0,
        repairCount: Number(s.repairCount) || 0,
    };
}

function persistSessionsNow(storePath = SESSION_STORE_PATH) {
    try {
        const target = String(storePath || SESSION_STORE_PATH);
        const payload = JSON.stringify({
            v: 1,
            savedAt: Date.now(),
            sessions: Array.from(sessions.entries()).map(([agentId, s]) => [agentId, serializeSession(s)]),
        });
        const tmp = `${target}.tmp`;
        fs.writeFileSync(tmp, payload);
        fs.renameSync(tmp, target);
        try { fs.chmodSync(target, 0o600); } catch (e) { /* best effort */ }
    } catch (e) {
        console.log(`[DS-API] Session persist skipped: ${e && e.message ? e.message : e}`);
    }
}

// Debounced persist (H2): the hot path (per-session creation/turn) only marks
// dirty and coalesces a trailing write 1s out, so bursts of new sessions cost
// O(1) disk writes instead of one full stringify+tmp+rename per mutation.
// Anything needing durability (shutdown, idle sweep) calls
// persistSessionsNow() directly. Timer is unref'd: never keeps the process alive.
const PERSIST_DEBOUNCE_MS = 1000;
let _sessionsDirty = false;
let _persistTimer = null;
function persistSessions(storePath = SESSION_STORE_PATH) {
    // An explicit non-default store path is the unit-test hook: write through
    // synchronously so tests don't wait out the debounce window.
    if (String(storePath || SESSION_STORE_PATH) !== String(SESSION_STORE_PATH)) {
        persistSessionsNow(storePath);
        return;
    }
    _sessionsDirty = true;
    if (_persistTimer) return;
    _persistTimer = setTimeout(() => {
        _persistTimer = null;
        if (!_sessionsDirty) return;
        _sessionsDirty = false;
        persistSessionsNow();
    }, PERSIST_DEBOUNCE_MS);
    if (_persistTimer && typeof _persistTimer.unref === 'function') _persistTimer.unref();
}

function restoreSessions(now = Date.now(), storePath = SESSION_STORE_PATH) {
    let data;
    try {
        data = JSON.parse(fs.readFileSync(String(storePath || SESSION_STORE_PATH), 'utf8'));
    } catch (e) {
        return 0; // cold start: no store yet, or unreadable — keep serving
    }
    if (!data || !Array.isArray(data.sessions)) return 0;
    let restored = 0;
    for (const entry of data.sessions) {
        const agentId = entry && entry[0];
        const snap = entry && entry[1];
        if (typeof agentId !== 'string' || !snap || typeof snap !== 'object') continue;
        const lastActive = typeof snap.lastActivityAt === 'number' ? snap.lastActivityAt : 0;
        if (snap.id && (now - lastActive) > SESSION_TTL_MS * 2) continue; // stale: mirror sweepIdleSessions
        const session = createSession();
        Object.assign(session, serializeSession(snap), { lastActivityAt: lastActive || now });
        sessions.set(agentId, session);
        restored++;
    }
    if (restored > 0) console.log(`[DS-API] Restored ${restored} session(s) from ${storePath}`);
    return restored;
}

// === DeepSeek Web API Config — loaded from external config file ===
const DS_CONFIG_PATH = process.env.DEEPSEEK_AUTH_PATH || path.join(__dirname, 'deepseek-auth.json');
const DEFAULT_ACCOUNT_COOLDOWN_MS = numEnv('DEEPSEEK_ACCOUNT_COOLDOWN_MS', 10 * 60 * 1000, 1000);
const MAX_ACCOUNT_COOLDOWN_MS = 30 * 60 * 1000; // upper clamp: a malicious or
// absurd Retry-After must never brick an account for years (8b).
// Hypersensitive smart-routing tuning (2026-09-16). All load-time env knobs:
// - FAILURE/TIMEOUT_WEIGHT: scorer penalty per effective failure / consecutive
//   timeout (timeouts still weigh 3x plain failures, as before).
// - CONSECUTIVE_STRIKES: consecutive failures (any kind except PoW-solve, see
//   F16) that sideline an account. 2 = one blip is forgiven, a repeat is not.
// - ESCALATION_COOLDOWN_MS: short sideline for strike-outs (fast failover +
//   fast recovery probe). Hard auth/rate-limit faults keep the long default.
// - FAILURE_HALFLIFE_MS: failures decay exponentially (forgives old blips, so
//   routing reacts to the last minutes, not ancient history). <=0 disables.
// - HOT_BONUS/HOT_WINDOW_MS: a small nudge toward the account with the most
//   recent success (proven-hot wins near-ties). Small on purpose: it must not
//   become a monopoly — failures still dominate within a strike or two.
const ROUTING_FAILURE_WEIGHT = numEnv('DEEPSEEK_ROUTING_FAILURE_WEIGHT', 4, 0);
const ROUTING_TIMEOUT_WEIGHT = numEnv('DEEPSEEK_ROUTING_TIMEOUT_WEIGHT', 12, 0);
const ROUTING_CONSECUTIVE_STRIKES = Math.max(1, Math.floor(numEnv('DEEPSEEK_ROUTING_CONSECUTIVE_STRIKES', 2, 1)));
const ROUTING_ESCALATION_COOLDOWN_MS = numEnv('DEEPSEEK_ROUTING_ESCALATION_COOLDOWN_MS', 60 * 1000, 1000);
const ROUTING_FAILURE_HALFLIFE_MS = numEnv('DEEPSEEK_ROUTING_FAILURE_HALFLIFE_MS', 5 * 60 * 1000, 0);
const ROUTING_HOT_BONUS = numEnv('DEEPSEEK_ROUTING_HOT_BONUS', 2, 0);
const ROUTING_HOT_WINDOW_MS = numEnv('DEEPSEEK_ROUTING_HOT_WINDOW_MS', 60 * 1000, 0);
// Hourly per-account request quota (round-3 G2, anti-mute): ~215 reqs/hour on
// one account draws a (delayed) mute upstream; default 60 keeps a wide margin
// ("add accounts, don't raise the value"). Sliding 1h window per account;
// over-quota accounts sit out exactly like cooling ones; all-spent fails fast
// 429 with Retry-After. 0 disables.
const HOURLY_QUOTA = numEnv('DEEPSEEK_HOURLY_QUOTA', 60, 0, 100000);
const QUOTA_WINDOW_MS = 3600000;
// Burst cap (pacing 4a): max turns per sliding 60s window per account.
// Default 0 = off until Sep-19 traffic measures a real number (candidate 10).
let BURST_PER_MINUTE = numEnv('DEEPSEEK_BURST_PER_MINUTE', 0, 0, 1000);
// Test hook (mirrors setExtraToolTags): swaps the burst limit for wiring
// tests. Validated like the env parse; restored by callers via t.after.
function setBurstPerMinute(n) {
    const v = Math.floor(Number(n));
    BURST_PER_MINUTE = Number.isFinite(v) ? Math.max(0, Math.min(1000, v)) : BURST_PER_MINUTE;
}
const BURST_WINDOW_MS = 60000;
// Ring capacity: fixed floor plus headroom scaled to both knobs, so a high
// HOURLY_QUOTA stays enforceable (H2 — a fixed 1024 silently uncapped large
// quotas). Pure part exported for tests.
function computeRingCap(quota, burst) {
    return Math.max(1024, 2 * (quota || 0), 2 * (burst || 0));
}
function ringCapacity() {
    return computeRingCap(HOURLY_QUOTA, BURST_PER_MINUTE);
}
function recordUpstreamTurn(account, nowMs = Date.now()) {
    if (!account) return;
    if (!Array.isArray(account.requestTimes)) account.requestTimes = [];
    account.requestTimes.push(nowMs);
    account.lastUpstreamAt = nowMs;
    const cutoff = nowMs - QUOTA_WINDOW_MS;
    // Filter-prune, not shift-while-old: front-only eviction assumes ascending
    // order, which clock skew can break (bounded anyway by the cap below).
    // Fast path skips the allocation when the head is already fresh.
    if (account.requestTimes.length > 0 && account.requestTimes[0] < cutoff) {
        account.requestTimes = account.requestTimes.filter(t => t >= cutoff);
    }
    const cap = ringCapacity();
    if (account.requestTimes.length > cap) account.requestTimes.splice(0, account.requestTimes.length - cap);
}
function recordAccountRequest(account, nowMs = Date.now()) {
    // Test/compat wrapper only — production stamp sites must use
    // recordUpstreamTurn (C1: this gate would silently disable burst under
    // DEEPSEEK_HOURLY_QUOTA=0).
    if (!(HOURLY_QUOTA > 0)) return;
    recordUpstreamTurn(account, nowMs);
}
function usedSince(account, windowMs, nowMs = Date.now()) {
    const times = account && account.requestTimes;
    if (!Array.isArray(times) || times.length === 0) return 0;
    const cutoff = nowMs - windowMs;
    let n = 0;
    for (let i = 0; i < times.length; i++) {
        if (times[i] >= cutoff) n++;
    }
    return n;
}
function usedThisHour(account, nowMs = Date.now()) {
    return usedSince(account, QUOTA_WINDOW_MS, nowMs);
}
function burstUsedThisMinute(account, nowMs = Date.now()) {
    return usedSince(account, BURST_WINDOW_MS, nowMs);
}
// Oldest in-window stamp, order-independent (arrays are chronological in
// production, but never assume it for release-time math).
function oldestInWindow(times, cutoff) {
    let oldest = null;
    for (let i = 0; i < (times || []).length; i++) {
        const t = times[i];
        if (t >= cutoff && (oldest === null || t < oldest)) oldest = t;
    }
    return oldest;
}
function withinQuota(account, nowMs = Date.now()) {
    if (!(HOURLY_QUOTA > 0)) return true;
    return usedThisHour(account, nowMs) < HOURLY_QUOTA;
}
function withinBurst(account, nowMs = Date.now(), limit = BURST_PER_MINUTE) {
    if (!(limit > 0)) return true;
    return burstUsedThisMinute(account, nowMs) < limit;
}
// Burst twin of the quota sticky-429: returns the 429 error (never throws)
// when a live chat sits on a burst-spent account, else null. Pure apart from
// reading its inputs, so the wiring ("fail fast, chat preserved, no mark")
// is unit-testable. Chat-less stickies get null and rotate freely below.
function stickyBurstReject(sticky, session, nowMs = Date.now(), limit = BURST_PER_MINUTE) {
    if (!sticky || !sticky.config || !sticky.config.token || !sticky.config.cookie) return null;
    if (!(limit > 0)) return null;
    if (burstUsedThisMinute(sticky, nowMs) < limit) return null;
    if (!session || !session.id) return null;
    const oldest = oldestInWindow(sticky.requestTimes, nowMs - BURST_WINDOW_MS);
    const waitSec = oldest !== null ? Math.max(1, Math.ceil((oldest + BURST_WINDOW_MS - nowMs) / 1000)) : 60;
    const err = new Error(`Account ${sticky.id} (owner of this chat) hit the burst cap (${limit}/min). Retry in ~${waitSec}s; chat preserved.`);
    err.status = 429; err.retryAfter = waitSec; err.type = 'rate_limit';
    return err;
}

// Earliest per-account availability across all three limiters. Shared by the
// all-spent branch and the SSE migration-exhausted path so both quote the
// same Retry-After (H1/M2 — per-site math drifted before).
function accountReleaseMs(a, nowMs = Date.now()) {
    let rel = (a && a.cooldownUntil) || 0;
    if (HOURLY_QUOTA > 0) {
        const oldest = oldestInWindow(a.requestTimes, nowMs - QUOTA_WINDOW_MS);
        if (oldest !== null && usedThisHour(a, nowMs) >= HOURLY_QUOTA) {
rel = Math.max(rel, oldest + QUOTA_WINDOW_MS);
        }
    }
    if (BURST_PER_MINUTE > 0) {
        const oldest = oldestInWindow(a.requestTimes, nowMs - BURST_WINDOW_MS);
        if (oldest !== null && burstUsedThisMinute(a, nowMs) >= BURST_PER_MINUTE) {
rel = Math.max(rel, oldest + BURST_WINDOW_MS);
        }
    }
    return rel;
}
function earliestReleaseMs(nowMs = Date.now()) {
    let best = Infinity;
    for (const a of accounts) {
        if (!(a.config.token && a.config.cookie)) continue;
        const rel = accountReleaseMs(a, nowMs);
        if (rel < best) best = rel;
    }
    return best;
}
// Optional same-chat rate-limit retry (round-3 G7): DEEPSEEK_RETRY_RATELIMIT=1
// waits once (bounded, Retry-After honored up to a cap) and retries the turn on
// the SAME account+chat before migration runs. Default off: fail-fast 429.
const RETRY_RATELIMIT = isTruthy(process.env.DEEPSEEK_RETRY_RATELIMIT);
const RATELIMIT_RETRY_BASE_MS = 2000;
const RATELIMIT_RETRY_MAX_MS = 10000;
function rateLimitRetryDelayMs(retryAfterSec) {
    const honored = Math.max(0, Number(retryAfterSec) || 0) * 1000;
    return Math.min(Math.max(RATELIMIT_RETRY_BASE_MS, honored), RATELIMIT_RETRY_MAX_MS);
}
// Shared fail-fast wording (graceful degradation, not a bare error): keeps the
// 429 status + Retry-After contract integrators back off on, while telling the
// caller exactly what to do. Smaller post-compact turns burn less quota, which
// is what protects the accounts — hammering helps nothing: while all accounts
// cool, retries never reach DeepSeek anyway.
function rateLimitExhaustedMessage(waitSec) {
    return `DeepSeek rate limit reached on all accounts. Retry in ~${waitSec}s — sooner just returns 429 again without reaching DeepSeek. Tip: /compact to shrink context first; smaller turns burn less quota.`;
}
// In-place retry is only attempted when quick recovery is plausible: unknown
// Retry-After gets one optimistic probe, brief backoffs (<= cap) are worth the
// wait, long backoffs go straight to migration (waiting out minutes in-request
// burns the deadline and the client's patience).
function shouldAttemptInPlaceRetry(retryAfterSec) {
    if (retryAfterSec === undefined || retryAfterSec === null || retryAfterSec === '') return true;
    const secs = Number(retryAfterSec);
    if (!Number.isFinite(secs) || secs < 0) return true;
    return secs * 1000 <= RATELIMIT_RETRY_MAX_MS;
}
// Full gate for the in-place retry branch, extracted pure so the wiring ("skip
// when all cooling, skip long backoffs, default off") is unit-testable without
// fetch mocks. waitMs is computed by retryWaitMs below.
function shouldRetryInPlace(o = {}) {
    if (!o.flagOn || !o.rateLimit || o.migrated || o.gone || o.deadline) return false;
    if (!shouldAttemptInPlaceRetry(o.retryAfterSec)) return false;
    if (!o.anyReady) return false;
    return true;
}
// Bounded wait: never sleep past the request deadline (H-2 — an unbounded
// sleep stalls the client, then the attempt is skipped anyway).
function retryWaitMs(retryAfterSec, remainingMs) {
    if (!(remainingMs > 0)) return 0;
    return Math.min(rateLimitRetryDelayMs(retryAfterSec), remainingMs);
}
// Latency EWMA step (display-only): alpha 0.3 reacts within ~3 turns while
// staying readable. Pure for tests; first sample seeds directly.
function nextEwmaLatency(prevMs, sampleMs) {
    const prev = Number(prevMs) || 0;
    const sample = Math.max(0, Number(sampleMs) || 0);
    if (!(prev > 0)) return Math.round(sample);
    return Math.round(0.7 * prev + 0.3 * sample);
}
// Single readiness predicate for all four admission sites (select-fresh,
// migration peers, /readyz, retry gate). The (x || 0) cooldown form admits
// missing-field accounts as ready where the old raw form excluded them —
// deliberate: the constructor always sets a numeric cooldownUntil, so only
// hand-built objects differ, and fail-open beats TypeError-crash there.
// Exported for tests.
function isAccountReady(a, nowMs = Date.now()) {
    return !!(a && a.config && a.config.token && a.config.cookie
        && (a.cooldownUntil || 0) <= nowMs && withinQuota(a, nowMs) && withinBurst(a, nowMs));
}
// Readiness pre-filter shared by the retry gate: true when at least one
// account passes the shared predicate. Exported for tests.
function anyAccountReady(list, nowMs = Date.now()) {
    return (list || []).some(a => isAccountReady(a, nowMs));
}
// Testable core of the in-place retry (no env, timers, or fetch): lifts the
// cooldown for exactly one attemptTurn() call on the SAME account and fully
// restores the account's limiter/scorer state (cooldown AND failure counters)
// if the probe fails. A failed probe therefore records nothing at all: our
// optimism never deepens the backoff and never inflates the failure score —
// the original failure's own mark stands alone.
// Returns { recovered, result?, error? }.
async function inPlaceRateLimitRetry(account, attemptTurn) {
    if (!account || typeof attemptTurn !== 'function') return { recovered: false };
    const saved = {
        cooldownUntil: Number(account.cooldownUntil) || 0,
        failures: Number(account.failures) || 0,
        consecutiveFailures: Number(account.consecutiveFailures) || 0,
        consecutiveTimeouts: Number(account.consecutiveTimeouts) || 0,
        ring: Array.isArray(account.requestTimes) ? account.requestTimes.slice() : null,
        lastUpstreamAt: Number(account.lastUpstreamAt) || 0,
    };
    account.cooldownUntil = 0;
    try {
        return { recovered: true, result: await attemptTurn() };
    } catch (retryErr) {
        // Full restore (M1): the probe's own PoW-success stamp must not spend
        // quota/burst budget either — a failed probe records nothing at all.
        // Slice-restore (not length-truncate): the stamp path reassigns the
        // array on prune, so truncating the new array would extend it with
        // holes instead of restoring contents.
        account.cooldownUntil = saved.cooldownUntil;
        account.failures = saved.failures;
        account.consecutiveFailures = saved.consecutiveFailures;
        account.consecutiveTimeouts = saved.consecutiveTimeouts;
        if (saved.ring !== null && Array.isArray(account.requestTimes)) account.requestTimes = saved.ring;
        account.lastUpstreamAt = saved.lastUpstreamAt;
        return { recovered: false, error: retryErr };
    }
}
// Operator-configurable extra tool-call sentinels (round-3 G4):
// DEEPSEEK_TOOL_TAGS="start1|start2;end1|end2". Literal substring matchers
// (never regexes), consulted by looksLikeToolCallMarkup (detection → drives
// truncated-markup retries) and parseCustomTagToolCall (extraction). Capped so
// a bloated env value can't slow the hot path.
const MAX_TOOL_TAG_LEN = 128;
const MAX_TOOL_TAGS = 32;
function parseToolTagList(raw) {
    return String(raw || '').split('|').map(s => s.trim()).filter(s => s.length > 0 && s.length <= MAX_TOOL_TAG_LEN).slice(0, MAX_TOOL_TAGS);
}
function parseToolTagEnv(value) {
    const parts = String(value || '').split(';');
    if (parts.length > 2) {
        console.warn(`[DS-API] DEEPSEEK_TOOL_TAGS has ${parts.length} ';'-sections; using the first two, ignoring the rest.`);
    }
    return { starts: parseToolTagList(parts[0] || ''), ends: parseToolTagList(parts[1] || '') };
}
const TOOL_TAG_PARTS = parseToolTagEnv(process.env.DEEPSEEK_TOOL_TAGS);
let TOOL_EXTRA_STARTS = TOOL_TAG_PARTS.starts;
let TOOL_EXTRA_ENDS = TOOL_TAG_PARTS.ends;
if (TOOL_EXTRA_STARTS.length > 0 || TOOL_EXTRA_ENDS.length > 0) {
    console.log(`[DS-API] custom tool tags: ${TOOL_EXTRA_STARTS.length} starts, ${TOOL_EXTRA_ENDS.length} ends`);
}
// Test hook (mirrors setInflightBodyBytes pattern): tests swap tag lists.
// Validated exactly like env input so tests cannot inject shapes prod rejects.
function setExtraToolTags(starts, ends) {
    const clean = (arr) => (Array.isArray(arr) ? arr : [])
        .map(s => String(s ?? '').trim())
        .filter(s => s.length > 0 && s.length <= MAX_TOOL_TAG_LEN)
        .slice(0, MAX_TOOL_TAGS);
    const rawCount = (Array.isArray(starts) ? starts.length : 0) + (Array.isArray(ends) ? ends.length : 0);
    TOOL_EXTRA_STARTS = clean(starts);
    TOOL_EXTRA_ENDS = clean(ends);
    if (TOOL_EXTRA_STARTS.length + TOOL_EXTRA_ENDS.length < rawCount) {
        console.warn(`[DS-API] custom tool tags truncated to ${MAX_TOOL_TAGS} entries of ${MAX_TOOL_TAG_LEN} chars (input had ${rawCount})`);
    }
}
let DS_CONFIG = {};
let dsHeaders = {};
const accounts = [];
let accountRoundRobin = 0;
let inFlight = 0;  // concurrent in-flight completions (backpressure cap)
// Overall wall-clock budget for one inbound request (caps the retry/continuation
// loops), max concurrent completions, and the empty-response retry cap.
const REQUEST_DEADLINE_MS = numEnv('DEEPSEEK_REQUEST_DEADLINE_MS', 120000, 1000);
const MAX_CONCURRENT = Math.max(1, Math.floor(numEnv('DEEPSEEK_MAX_CONCURRENT', 24, 1)));
// Request-body caps (§6/§7): per-request 10MB (413) plus a global
// in-flight-body budget (64MB, 503+Retry-After) so concurrent trickled
// uploads cannot balloon memory. inflightBodyBytes is charged per chunk and
// released exactly once per request (settled flag guards end+close, which
// Node fires BOTH of on normal completion). Scope is UPLOAD-IN-FLIGHT ONLY:
// the charge is released at req `end`, before JSON.parse, so parsed bodies
// retained during upstream processing are NOT counted here; those are bounded
// instead by MAX_CONCURRENT concurrent completions × MAX_BODY_BYTES each.
const MAX_BODY_BYTES = 10 * 1024 * 1024;  // chat payloads are small; cap memory before JSON.parse
const MAX_INFLIGHT_BODY_BYTES = 64 << 20;
let inflightBodyBytes = 0;
function checkBackpressure(count = inFlight) { return count >= MAX_CONCURRENT; }
function getInflightBodyBytes() { return inflightBodyBytes; }
function setInflightBodyBytes(n) { inflightBodyBytes = Math.max(0, Number(n) || 0); } // test hook
function getInFlightCount() { return inFlight; }
function setInFlightCount(n) { inFlight = Math.max(0, Math.floor(Number(n) || 0)); } // test hook
const configuredEmptyRetries = Number(process.env.DEEPSEEK_MAX_RETRIES);
const MAX_EMPTY_RETRIES = Number.isFinite(configuredEmptyRetries)
    ? Math.max(0, Math.min(10, Math.floor(configuredEmptyRetries)))
    : 2;
const MIN_UPSTREAM_PROMPT_CHARS = 16000;
const configuredPromptChars = Number(process.env.DEEPSEEK_MAX_PROMPT_CHARS);
const MAX_UPSTREAM_PROMPT_CHARS = Number.isFinite(configuredPromptChars)
    ? Math.max(MIN_UPSTREAM_PROMPT_CHARS, Math.floor(configuredPromptChars))
    : 80000;
function buildBaseHeaders(config = DS_CONFIG) {
    return {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
        "x-client-platform": "web",
        "x-client-version": "2.0.0",
        "x-client-locale": "ru",
        "x-client-timezone-offset": "14400",
        "x-app-version": "2.0.0",
        "Authorization": `Bearer ${config.token || ''}`,
        "x-hif-dliq": config.hif_dliq || '',
        "x-hif-leim": config.hif_leim || '',
        ...(typeof config.device_id === 'string' && /^[A-Za-z0-9_.:~/-]{1,128}$/.test(config.device_id) ? { "x-device-id": config.device_id } : {}),
        "Origin": "https://chat.deepseek.com",
        "Referer": "https://chat.deepseek.com/",
        "Cookie": config.cookie || '',
        "Content-Type": "application/json",
    };
}
function discoverAuthPaths() {
    if (process.env.DEEPSEEK_AUTH_DIR) {
        try {
            return fs.readdirSync(process.env.DEEPSEEK_AUTH_DIR)
                .filter(f => f.endsWith('.json') && !f.startsWith('.'))
                .sort()
                .map(f => path.join(process.env.DEEPSEEK_AUTH_DIR, f));
        } catch (e) {
            console.error(`[DS-API] Could not read DEEPSEEK_AUTH_DIR: ${e.message}`);
            return [];
        }
    }
    if (process.env.DEEPSEEK_AUTH_PATH && process.env.DEEPSEEK_AUTH_PATH.includes(',')) {
        return process.env.DEEPSEEK_AUTH_PATH.split(',').map(s => s.trim()).filter(Boolean);
    }
    return [DS_CONFIG_PATH];
}
function loadDeepSeekConfig({ fatal = true } = {}) {
    accounts.length = 0;
    const paths = discoverAuthPaths();
    for (const file of paths) {
        try {
            const raw = fs.readFileSync(file, 'utf8');
            const config = JSON.parse(raw);
            const id = `account_${accounts.length + 1}`;
            if (!config.wasmUrl) {
                // Fail-loud at load, not per-turn: without wasmUrl every PoW
                // solve throws and the account 500s every request (F16).
                console.error(`[DS-API] ${id} (${file}) has no wasmUrl; PoW solves will fail until it is imported.`);
            }
            accounts.push({ id, file, config, headers: buildBaseHeaders(config), cooldownUntil: 0, failures: 0, consecutiveTimeouts: 0, consecutiveFailures: 0, lastFailureAt: 0, lastSuccessAt: 0, lastUsedAt: 0, inflight: 0, requestTimes: [], lastUpstreamAt: 0, ewmaLatencyMs: 0 });
        } catch (e) {
            console.error(`[DS-API] Could not load auth config ${file}: ${e.message}`);
        }
    }
    DS_CONFIG = accounts[0]?.config || {};
    dsHeaders = accounts[0]?.headers || buildBaseHeaders({});
    if (accounts.length > 0) {
        console.log(`[DS-API] Loaded ${accounts.length} auth account(s): ${accounts.map(a => a.id).join(', ')}`);
        for (const a of accounts) {
            if (a.config.device_id) logDebug(`[DS-API] ${a.id} carries device_id ${String(a.config.device_id).slice(0, 12)}...`);
        }
        return true;
    }
    if (fatal) {
        console.error(`[DS-API] FATAL: Could not load any auth config. Expected ${paths.join(', ') || DS_CONFIG_PATH}`);
        process.exit(1);
    }
    return false;
}
function hasAuthConfig() { return accounts.some(a => a.config.token && a.config.cookie); }
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
    };
}
// Dynamic model discovery (round-3 G3): hourly advisory poll of
// client/settings?scope=model. Advisory ONLY — never adds/removes aliases;
// surfaces upstream flag flips in /health for operators. Verified 2026-09-17:
// the did value is irrelevant (random UUID works); the x-client-* header group
// is the actual gate (minimal headers -> perpetual SETTINGS_NOT_FOUND).
const MODEL_DISCOVERY_ON = process.env.DEEPSEEK_MODEL_DISCOVERY !== '0';
const MODEL_DISCOVERY_MS = numEnv('DEEPSEEK_MODEL_DISCOVERY_MS', 3600000, 300000);
let discoveredModels = { types: [], fetchedAt: 0 };
function parseModelDiscovery(body) {
    try {
        // Envelope gate (H-1): a table-shaped biz_data inside an error
        // envelope (e.g. stale cache on biz_code != 0) must not parse as live.
        if (!body || typeof body !== 'object') return null;
        if (body.code !== undefined && body.code !== 0 && body.code !== '0') return null;
        const data = body.data;
        if (!data || typeof data !== 'object') return null;
        if (data.biz_code !== undefined && data.biz_code !== 0 && data.biz_code !== '0') return null;
        const mc = data.biz_data && data.biz_data.settings
            && data.biz_data.settings.model_configs;
        const vals = mc && Array.isArray(mc.value) ? mc.value : null;
        if (!vals) return null;
        return {
            types: vals.map(m => ({
                model_type: String((m && m.model_type) || ''),
                name: String((m && m.name) || ''),
                enabled: (m && m.enabled) === true,
                switchable: (m && m.switchable) === true,
            })),
            fetchedAt: Date.now(),
        };
    } catch {
        return null;
    }
}
async function refreshDiscoveredModels() {
    if (!MODEL_DISCOVERY_ON) return;
    try {
        const now = Date.now();
        const preferred = (process.env.DEEPSEEK_PREFERRED_ACCOUNT || '').trim();
        // Shared readiness predicate (M8-R1): same admission as every other
        // gate, and any throw here must stay inside the try — an unhandled
        // rejection would take the whole process down hourly.
        const ready = accounts.filter(a => isAccountReady(a, now));
        const account = (preferred && ready.find(a => a.id === preferred)) || ready[0];
        if (!account) return;
        const res = await dsFetch(
            `https://chat.deepseek.com/api/v0/client/settings?did=${crypto.randomUUID()}&scope=model`,
            { headers: account.headers },
            15000
        );
        const parsed = parseModelDiscovery(await res.json().catch(() => null));
        // Empty table keeps last-good too (H-2): assigning it would wipe the
        // display to indistinguishable-from-never-fetched. HTTP status logged
        // (never the body) so auth failures surface instead of vanishing (M-5).
        if (!parsed || parsed.types.length === 0) {
            logDebug(`[DS-API] model discovery: HTTP ${res.status}, empty/unparseable response, keeping last-good table`);
            return;
        }
        discoveredModels = parsed;
        logDebug(`[DS-API] model discovery: ${parsed.types.length} types (${parsed.types.map(t => `${t.model_type}:${t.enabled ? 'on' : 'off'}`).join(', ')})`);
    } catch (e) {
        logDebug(`[DS-API] model discovery failed (${String((e && e.message) || e).slice(0, 100)}); keeping last-good table`);
    }
}
function startModelDiscovery() {
    if (!MODEL_DISCOVERY_ON) return;
    refreshDiscoveredModels().catch(() => {});
    setInterval(() => { refreshDiscoveredModels().catch(() => {}); }, MODEL_DISCOVERY_MS).unref();
}
function selectAccountForSession(session, sessionKey = '') {
    const now = Date.now();
    if (session.accountId) {
        const sticky = accounts.find(a => a.id === session.accountId);
        const stickyUsable = sticky && sticky.config.token && sticky.config.cookie;
        // A live DeepSeek chat_session belongs to the auth account that created
        // it and cannot be reused under a different account. Rotating here would
        // silently move one opencode conversation across chats AND accounts
        // (each rate-limit flip = a new remote chat with split context). Fail
        // fast with 429 instead so the client backs off and retries on the SAME
        // chat+account once the cooldown lifts. Fresh sessions (no remote chat
        // yet) still rotate freely to a ready account below.
        const stickyCooling = stickyUsable && sticky.cooldownUntil > now;
        // Quota mirrors cooling: a live chat stays on its account, so an
        // over-quota sticky fails fast (chat preserved) instead of rotating
        // (which would split context) or hammering past the quota (which
        // would defeat the anti-mute purpose). Chat-less stickies fall through
        // to reset + free rotation below, exactly like cooling ones.
        const stickyOverQuota = stickyUsable && HOURLY_QUOTA > 0 && !withinQuota(sticky, now);
        const stickyOverBurst = stickyUsable && BURST_PER_MINUTE > 0 && !withinBurst(sticky, now);
        if (stickyUsable && !stickyCooling && !stickyOverQuota && !stickyOverBurst) return sticky;
        if (stickyCooling && session.id) {
            const waitSec = Math.max(1, Math.ceil((sticky.cooldownUntil - now) / 1000));
            const err = new Error(`Account ${sticky.id} (owner of this chat) is cooling down. Retry in ~${waitSec}s; chat preserved.`);
            err.status = 429; err.retryAfter = waitSec; err.type = 'rate_limit';
            throw err;
        }
        if (stickyOverQuota && session.id) {
            const oldest = oldestInWindow(sticky.requestTimes, now - QUOTA_WINDOW_MS);
            const waitSec = oldest !== null ? Math.max(1, Math.ceil((oldest + QUOTA_WINDOW_MS - now) / 1000)) : 60;
            const err = new Error(`Account ${sticky.id} (owner of this chat) spent its hourly quota (${HOURLY_QUOTA}/h). Retry in ~${waitSec}s; chat preserved.`);
            err.status = 429; err.retryAfter = waitSec; err.type = 'rate_limit';
            throw err;
        }
        // Burst mirrors quota exactly (separate knob, separate message).
        const burstErr = stickyBurstReject(sticky, session, now);
        if (burstErr) throw burstErr;
        // A DeepSeek chat_session belongs to the auth account that created it.
        // If that account disappeared, lost credentials, or (for a chat-less
        // session) is cooling down, never reuse its session id under a
        // different account. If a live chat id exists, fail-fast and preserve (no new chats).
        if (session.id) {
            const err = new Error(`Account ${session.accountId || 'unknown'} (owner of this chat) lost credentials or is unavailable; chat preserved. Run npm run auth.`);
            err.status = 503;
            err.type = 'auth_unavailable';
            throw err;
        }
        resetRemoteSession(session);
        session.accountId = null;
    }
    const ready = accounts.filter(a => isAccountReady(a, now));
    if (ready.length === 0) {
        const waiting = accounts.filter(a => a.config.token && a.config.cookie).sort((a, b) => a.cooldownUntil - b.cooldownUntil)[0];
        if (waiting) {
            // Earliest availability across cooldown, quota, AND burst via the
            // shared earliestReleaseMs helper (H1/M2 — per-site math drifted).
            const releaseMs = earliestReleaseMs(now);
            if (HOURLY_QUOTA > 0) {
                const capped = accounts.filter(a => a.config.token && a.config.cookie && !withinQuota(a, now)).map(a => a.id);
                if (capped.length > 0) logDebug(`[DS-API] hourly quota spent, sitting out: ${capped.join(',')} (quota ${HOURLY_QUOTA}/h)`);
            }
            if (BURST_PER_MINUTE > 0) {
                const capped = accounts.filter(a => a.config.token && a.config.cookie && !withinBurst(a, now)).map(a => a.id);
                if (capped.length > 0) logDebug(`[DS-API] burst cap spent, sitting out: ${capped.join(',')} (${BURST_PER_MINUTE}/min)`);
            }
            const waitSec = Math.max(1, Math.ceil((releaseMs - now) / 1000));
            // Tagged so the request handler returns 429 + Retry-After instead of a
            // generic 500 (integrator backoff keys on the status code, not the text).
            const err = new Error(rateLimitExhaustedMessage(waitSec) + ' Or import a fresh account with npm run auth:import.');
            err.status = 429; err.retryAfter = waitSec; err.type = 'rate_limit';
            throw err;
        }
        const noAuth = new Error('No valid DeepSeek auth accounts. Run npm run auth or npm run auth:import.');
        noAuth.status = 503; noAuth.type = 'no_auth';
        throw noAuth;
    }
    const detail = selectFreshAccountDetail(ready, sessionKey);
    const account = detail.account;
    if (detail.mode !== 'scored') {
        logDebug(`[session:${logToken(sessionKey)}] pick acct:${account.id} mode=${detail.mode} from ${ready.length} ready (no scoring)`);
    }
    session.accountId = account.id;
    persistSessions();
    return account;
}

// Fresh-chat account choice. Default: score-min over the ready set (home
// affinity is a nudge via the scorer, not a lock). Blind round-robin scatters
// every new fingerprint across logins — and fingerprints legitimately change
// for compaction summarizer calls (different system prompt) and post-compaction
// turns (rewritten opener), so one opencode session ended up with chats in two
// DeepSeek accounts. Overflow to the other account still happens automatically
// while home is cooling down (cooling accounts are excluded from `ready`).
// DEEPSEEK_ROUTING_MODE=preferred restores the legacy preferred-first /
// home-max / round-robin path below.
// Smart-routing scorer (implementor-brief-smart-routing-2026-09-15 §2, tuned
// hypersensitive 2026-09-16): lowest score wins. A busy account sheds load
// fast (10 dominates), degraded accounts are avoided fast (failures weigh 4,
// timeouts 3x that at 12), failures decay with a 5-minute half-life so the
// score tracks the last minutes not ancient history, a recently-successful
// account gets a small hot bonus (-2, never a monopoly), home affinity is a
// nudge not a lock (capped at 8), preferred is bias not monopoly (-5), jitter
// breaks exact ties. Exported pure for tests (reads only its args + routing
// env, no turn-scoped state). nowMs is injectable so tests can age failures.
// Time-decayed failure count: recent failures hit hard, old blips fade.
// Accounts without a lastFailureAt timestamp (legacy/test objects) decay
// nothing — their raw count applies in full, keeping scoring deterministic.
function effectiveFailures(account, nowMs = Date.now()) {
    const raw = Math.max(0, Number(account?.failures) || 0);
    if (raw === 0) return 0;
    const half = ROUTING_FAILURE_HALFLIFE_MS;
    const last = Number(account?.lastFailureAt) || 0;
    if (!(half > 0) || !(last > 0)) return raw;
    const age = nowMs - last;
    if (age <= 0) return raw;
    return raw * Math.pow(0.5, age / half);
}
function isPreferredAccount(account) {
    const preferred = (process.env.DEEPSEEK_PREFERRED_ACCOUNT || '').trim();
    return !!preferred && !!account && account.id === preferred;
}
function isHotAccount(account, nowMs) {
    const lastOk = Number(account?.lastSuccessAt) || 0;
    const okAge = nowMs - lastOk;
    return ROUTING_HOT_BONUS > 0 && lastOk > 0 && okAge >= 0 && okAge <= ROUTING_HOT_WINDOW_MS;
}
function scoreBase(account, hostedCount = 0, nowMs = Date.now()) {
    const inflight = Number(account?.inflight) || 0;
    const failures = effectiveFailures(account, nowMs);
    const timeouts = Number(account?.consecutiveTimeouts) || 0;
    const hosted = Math.min(Math.max(Number(hostedCount) || 0, 0), 8);
    let score = 10 * inflight + ROUTING_FAILURE_WEIGHT * failures + ROUTING_TIMEOUT_WEIGHT * timeouts - hosted - (isPreferredAccount(account) ? 5 : 0);
    if (isHotAccount(account, nowMs)) score -= ROUTING_HOT_BONUS;
    return score;
}
function scoreAccount(account, hostedCount = 0, nowMs = Date.now()) {
    return scoreBase(account, hostedCount, nowMs) + Math.random();
}
// Same terms as scoreBase, reported for observability. Single-sourced via the
// shared isPreferredAccount/isHotAccount/effectiveFailures helpers —
// scoreBase and scoreBreakdown cannot drift apart.
function scoreBreakdown(account, hostedCount = 0, nowMs = Date.now()) {
    const raw = Math.max(0, Number(account?.failures) || 0);
    const hosted = Math.min(Math.max(Number(hostedCount) || 0, 0), 8);
    return {
        base: scoreBase(account, hostedCount, nowMs),
        inflight: Number(account?.inflight) || 0,
        failuresRaw: raw,
        failuresEff: effectiveFailures(account, nowMs),
        timeouts: Number(account?.consecutiveTimeouts) || 0,
        hosted,
        preferred: isPreferredAccount(account),
        hot: isHotAccount(account, nowMs),
    };
}
// Sanitize client-influenced values before log interpolation: newline and
// control characters forge journal lines. Hot-path logic keeps raw values;
// only new log lines use this.
function logToken(value) {
    return String(value ?? '').replace(/[^A-Za-z0-9_.:#/-]/g, '_').slice(0, 80);
}
function isPreferredRoutingMode() {
    return (process.env.DEEPSEEK_ROUTING_MODE || '').trim().toLowerCase() === 'preferred';
}
// Active-hosted count for smart routing (rich-get-richer fix): only sessions
// that actually hold a live remote chat (`session.id`) on this account AND
// were active within the last 30 minutes attract fresh chats. Stale pins
// (test residue, abandoned fingerprints) go inert, and chat-less stickies —
// which rotate freely on their next turn anyway — never attract traffic.
// Resetting a session clears `session.id`, so POST /reset-session releases
// its pin immediately. Cap still 8 (matches the scorer's home term).
const ACTIVE_HOSTED_WINDOW_MS = 30 * 60 * 1000;
function countActiveHosted(accountId, nowMs = Date.now()) {
    let count = 0;
    for (const [, s] of sessions) {
        if (!s || s.accountId !== accountId || !s.id) continue;
        if ((nowMs - (s.lastActivityAt || 0)) <= ACTIVE_HOSTED_WINDOW_MS) count++;
    }
    return count;
}
// Score-min pick over ready candidates using active session-host counts.
// Shared by fresh-chat selection (default mode) and rate-limit migration
// (always — migration must never re-impose preferred-monopoly).
// Returns { winner, score, nowMs }: score is the exact jittered value that won,
// nowMs the timestamp shared by all candidates, so callers can log the decision
// truthfully without re-sampling time or sessions.
function pickLowestScoredAccount(candidates, nowMs = Date.now()) {
    let best = Infinity;
    let winner = null;
    for (const candidate of candidates) {
        const score = scoreAccount(candidate, countActiveHosted(candidate.id, nowMs), nowMs);
        if (score < best) { best = score; winner = candidate; }
    }
    return { winner, score: best, nowMs };
}
// One debug line per scored decision. bd comes from scoreBreakdown with the
// pick's own nowMs — never recomputed.
function logScoredPick(tag, account, hosted, pick, bd, readyCount) {
    logDebug(`${tag} pick acct:${account.id} score=${pick.score.toFixed(2)} base=${bd.base.toFixed(2)} (fail ${bd.failuresEff.toFixed(2)}/${bd.failuresRaw}, timeouts ${bd.timeouts}, hosted ${hosted}, preferred ${bd.preferred ? 'y' : 'n'}, hot ${bd.hot ? 'y' : 'n'}) from ${readyCount} ready`);
}
function selectFreshAccountDetail(ready, sessionKey = '') {
    if (ready.length === 1) return { account: ready[0], mode: 'single' };
    // Escape hatch (brief §2): DEEPSEEK_ROUTING_MODE=preferred restores
    // today's exact behavior. Default when unset: score-based selection.
    // Asymmetry note (deliberate): the decay fix (countActiveHosted) applies
    // ONLY to score-based selection and migration — this legacy branch keeps
    // counting all pins (stale and chat-less included), and migration always
    // uses the scorer even in preferred mode. Audited; do not "fix" without
    // a brief update.
    if (isPreferredRoutingMode()) {
        const preferred = (process.env.DEEPSEEK_PREFERRED_ACCOUNT || '').trim();
        if (preferred) {
            const pick = ready.find(a => a.id === preferred);
            if (pick) return { account: pick, mode: 'preferred' };
        }
        const hosted = new Map();
        for (const [, s] of sessions) {
            if (s && s.accountId) hosted.set(s.accountId, (hosted.get(s.accountId) || 0) + 1);
        }
        let best = -1;
        let winner = null;
        for (const candidate of ready) {
            const count = hosted.get(candidate.id) || 0;
            if (count > best) { best = count; winner = candidate; }
        }
        // Tie at zero (cold start, or all hosted sessions belong to a cooling
        // account): fall back to round-robin for fairness. Ties above zero keep
        // the first ready account deterministically — stable home wins.
        if (best === 0) {
            winner = ready[accountRoundRobin % ready.length];
            accountRoundRobin++;
            return { account: winner, mode: 'preferred-rr' };
        }
        return { account: winner, mode: 'preferred-home' };
    }
    const pick = pickLowestScoredAccount(ready);
    const hosted = countActiveHosted(pick.winner.id, pick.nowMs);
    const bd = scoreBreakdown(pick.winner, hosted, pick.nowMs);
    logScoredPick(`[session:${logToken(sessionKey)}]`, pick.winner, hosted, pick, bd, ready.length);
    return { account: pick.winner, mode: 'scored', score: pick.score, breakdown: bd };
}
function selectFreshAccount(ready) {
    return selectFreshAccountDetail(ready).account;
}
// Parse a Retry-After header value into a cooldown duration in ms, or null if
// absent/unparseable. Supports both forms: delta-seconds (e.g. "120") and an
// HTTP-date (e.g. "Wed, 21 Oct 2025 07:28:00 GMT"). Clamped to >= 1s.
function parseRetryAfterMs(retryAfterRaw) {
    if (!retryAfterRaw) return null;
    const raw = String(retryAfterRaw).trim();
    if (/^\d+$/.test(raw)) return Math.max(1000, Number(raw) * 1000);
    const t = Date.parse(raw);
    if (!Number.isNaN(t)) return Math.max(1000, t - Date.now());
    return null;
}
function markAccountFailure(account, status, reason = '', retryAfterRaw = null) {
    if (!account) return;
    const now = Date.now();
    account.failures++;
    account.lastFailureAt = now;
    // F16: a PoW SOLVE failure is a WASM/CDN fault, not a login fault — count
    // it for the scorer but never let it strike out or sideline the account.
    if (/pow solve/i.test(reason || '')) return;
    account.consecutiveFailures = (account.consecutiveFailures || 0) + 1;
    if (status === 504 || isTimeoutError({ message: reason }) || /timeout|abort/i.test(reason)) {
        account.consecutiveTimeouts = (account.consecutiveTimeouts || 0) + 1;
        // A dead network path backs off hard; anything else trips the short
        // escalation sideline so traffic fails over within a strike or two.
        if (account.consecutiveTimeouts >= ROUTING_CONSECUTIVE_STRIKES) {
            account.cooldownUntil = now + DEFAULT_ACCOUNT_COOLDOWN_MS;
            account.consecutiveTimeouts = 0;
            account.consecutiveFailures = 0;
            console.log(`[account:${account.id}] cooldown for ${Math.round(DEFAULT_ACCOUNT_COOLDOWN_MS / 1000)}s after ${ROUTING_CONSECUTIVE_STRIKES} consecutive timeouts/network aborts (${reason})`);
        } else if (account.consecutiveFailures >= ROUTING_CONSECUTIVE_STRIKES) {
            account.cooldownUntil = now + ROUTING_ESCALATION_COOLDOWN_MS;
            account.consecutiveFailures = 0;
            console.log(`[account:${account.id}] cooldown for ${Math.round(ROUTING_ESCALATION_COOLDOWN_MS / 1000)}s after ${ROUTING_CONSECUTIVE_STRIKES} consecutive failures (last: ${reason})`);
        }
        return;
    }
    account.consecutiveTimeouts = 0;
    if ([401, 403, 429].includes(Number(status))) {
        // On 429, honor a valid Retry-After header (seconds or HTTP-date) when present;
        // otherwise fall back to the fixed env-configured cooldown. Clamped above
        // so a malicious/absurd value can't brick the account (8b).
        const retryMs = Number(status) === 429 ? parseRetryAfterMs(retryAfterRaw) : null;
        const cooldownMs = retryMs != null
            ? Math.min(retryMs, MAX_ACCOUNT_COOLDOWN_MS)
            : DEFAULT_ACCOUNT_COOLDOWN_MS;
        account.cooldownUntil = now + cooldownMs;
        account.consecutiveFailures = 0;
        console.log(`[account:${account.id}] cooldown for ${Math.round(cooldownMs / 1000)}s after HTTP ${status}${reason ? ` (${reason})` : ''}${retryMs != null ? ' (Retry-After)' : ''}`);
        return;
    }
    // Hypersensitive escalation (2026-09-16): repeated soft failures
    // (auth-expired PoW, 5xx, bad payloads) sideline the account briefly so
    // fresh chats fail over fast; the short cooldown re-probes it soon after.
    if (account.consecutiveFailures >= ROUTING_CONSECUTIVE_STRIKES) {
        account.cooldownUntil = now + ROUTING_ESCALATION_COOLDOWN_MS;
        account.consecutiveFailures = 0;
        console.log(`[account:${account.id}] cooldown for ${Math.round(ROUTING_ESCALATION_COOLDOWN_MS / 1000)}s after ${ROUTING_CONSECUTIVE_STRIKES} consecutive failures (last: ${reason || status})`);
    }
}
async function readDeepSeekJsonResponse(resp, label, account) {
    const text = await resp.text();
    let json = null;
    if (text) {
        try { json = JSON.parse(text); }
        catch (e) {
            markAccountFailure(account, resp.status, label);
            throw new Error(`DeepSeek returned non-JSON ${label} response (HTTP ${resp.status}). Run npm run doctor. First chars: ${text.substring(0, 120)}`);
        }
    }
    if (!resp.ok) markAccountFailure(account, resp.status, label);
    return { json, text };
}
if (require.main === module) {
    loadDeepSeekConfig({ fatal: false });
}

function createSession() {
    return {
        id: null,
        parentMessageId: null,
        createdAt: null,
        messageCount: 0,
        accountId: null,
        history: [],
        lastActivityAt: Date.now(),
        // Delta-prompt mode (DEEPSEEK_DELTA_PROMPT=1): tracks how many client
        // (non-system) messages were already forwarded to the remote chat, plus
        // a hash of the last forwarded one for continuity checks.
        deltaMsgCount: 0,
        deltaBoundary: null,
        // Full-prefix anchor for edit detection (R1-C1): sha256 over every
        // forwarded envelope hash. Lets splitClientMessages tell an edited
        // prefix (full resend) from pure growth (suffix-only).
        deltaPrefixHash: null,
        // Sorted client tool names last sent to the remote chat (R1-C3).
        // Established chats omit the tool block, so a mid-session tool-set
        // change must force one full resend to teach the new tools.
        deltaToolNames: null,
        // Repeat-repair guard (client-turn scoped; persisted, window-enforced
        // on use): hash/window/count of strict-retry prompts already attempted
        // for the current turn.
        repairHash: null,
        repairAt: 0,
        repairCount: 0,
    };
}

function resetRemoteSession(session) {
    const failed = {
        failedSessionId: session.id,
        failedMessageCount: session.messageCount,
        accountId: session.accountId,
    };
    session.id = null;
    session.parentMessageId = null;
    session.createdAt = null;
    session.messageCount = 0;
    // A fresh remote chat has seen nothing: drop delta continuity state so the
    // next prompt is a full resend (with tool definitions re-injected).
    session.deltaMsgCount = 0;
    session.deltaBoundary = null;
    session.deltaPrefixHash = null;
    session.deltaToolNames = null;
    // Keep local recovery history and the sticky account assignment. A remote
    // chat can be unhealthy without invalidating either of those local hints.
    // The repeat-repair guard (repairHash/repairAt/repairCount) intentionally
    // survives: it describes the CLIENT turn, so a verbatim client retry of a
    // twice-failed turn must still be recognized as a repeat. It also survives
    // restarts via serializeSession — staleness is enforced by
    // classifyRepairAttempt's window on use, so a stale restored guard simply
    // reads as a fresh turn.
    persistSessions();
    return failed;
}

function prepareSessionForPrompt(session, now = Date.now()) {
    // Under no-new-chats invariant (implementor-brief-no-new-chats-2026-09-15):
    // Preemptive rollover retired to prevent minting replacement chats.
    return null;
}

function getOrCreateAgentSession(agentId) {
    if (!sessions.has(agentId)) {
        sessions.set(agentId, createSession());
        persistSessions();
    }
    const session = sessions.get(agentId);
    session.lastActivityAt = Date.now();
    return session;
}

// Evict idle sessions so the Map (keyed by client IP / user id) can't grow without
// bound on a long-running process. Drops entries untouched for 2× the session TTL.
function sweepIdleSessions(maxIdleMs = SESSION_TTL_MS * 2) {
    const now = Date.now();
    let removed = 0;
    for (const [agentId, session] of sessions) {
        if (now - (session.lastActivityAt || 0) > maxIdleMs) { sessions.delete(agentId); removed++; }
    }
    if (removed) console.log(`[DS-API] swept ${removed} idle session(s); ${sessions.size} remain`);
    if (removed) persistSessionsNow();
    return removed;
}

// === Session identity hardening (§1 cap+sanitize, C1 principal binding) ===
// §1: client-supplied session keys are capped (64 chars, strict charset) and
// the GLOBAL session count is capped at MAX_SESSIONS, enforced at intake
// pre-creation (429 for new keys past the cap). getOrCreateAgentSession keeps
// its unconditional contract; the gate lives at request entry. No eviction.
// C1: the key is namespaced under a principal derived from the proxy
// credential (sha256 hex prefix; no sub/rotation exists with a single static
// key). With no proxy key configured the header path is disabled (IP-only),
// so keyless deployments cannot mint arbitrary buckets.
const MAX_SESSIONS = 500;
const SESSION_ID_MAX_LENGTH = 64;
const SESSION_ID_CHARSET = /^[A-Za-z0-9._-]+$/;
function sanitizeSessionId(value) {
    const s = String(value === null || value === undefined ? '' : value).trim().slice(0, SESSION_ID_MAX_LENGTH);
    if (!s || !SESSION_ID_CHARSET.test(s)) return '';
    return s;
}
function principalForRequest(authorization, key) {
    const k = key === undefined ? getProxyKey() : key;
    if (!k) return '';
    if (!isProxyAuthorized(authorization, k)) return '';
    return crypto.createHash('sha256').update(String(k)).digest('hex').slice(0, 16);
}
function resolveAgentId({ requestedSession, remoteAddr, authorization, principal } = {}) {
    const addr = String(remoteAddr || 'unknown');
    const ipFallback = (addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1') ? 'dev-agent' : addr;
    const bound = principal === undefined ? principalForRequest(authorization) : principal;
    // No principal (keyless, or unauthorized which the 401 gate already
    // rejected): header path disabled, IP-only bucket.
    const requested = bound ? sanitizeSessionId(requestedSession) : '';
    const base = requested || ipFallback;
    return bound ? `${bound}:${base}` : base;
}

// Shared title-bucket check (C1 companion): only the title override in the
// request handler produces this shape ('dev-agent:title', bare when keyless,
// '<16-hex-principal>:dev-agent:title' when keyed). The strict full-shape
// match is deliberate: a bare endsWith would also match
// '<anything>:dev-agent:title' if sanitizeSessionId's charset ever allowed
// ':' (today it cannot — ^[A-Za-z0-9._-]+$). Tied to principalForRequest's
// sha256-hex-16 format; change both together.
function isSharedTitleBucket(agentId) {
    if (agentId === 'dev-agent:title') return true;
    return /^[0-9a-f]{16}:dev-agent:title$/.test(String(agentId || ''));
}

// === Delta-prompt mode (DEEPSEEK_DELTA_PROMPT=1) ===
// Goal: one stable chat.deepseek.com chat per opencode conversation, with the
// tool-definition block sent ONCE at chat creation and suffix-only prompts on
// later turns (the remote chat already holds earlier turns server-side).
// Inactive unless explicitly enabled; every fallback returns to full resends.

// Canonical per-message hash for continuity checks (content + tool envelopes).
function hashMessageEnvelope(msg) {
    const role = msg && typeof msg.role === 'string' ? msg.role : '';
    let content = '';
    try {
        const c = msg ? msg.content : '';
        content = typeof c === 'string' ? c : JSON.stringify(c || '');
    } catch (e) { content = String((msg && msg.content) || ''); }
    let extra = '';
    if (msg && msg.role === 'assistant' && Array.isArray(msg.tool_calls)) {
        try {
            extra = JSON.stringify(msg.tool_calls.map(tc => [
                tc?.function?.name || '',
                typeof tc?.function?.arguments === 'string' ? tc.function.arguments : JSON.stringify((tc?.function?.arguments) || ''),
            ]));
        } catch (e) { extra = String(msg.tool_calls.length); }
    } else if (msg && msg.role === 'tool') {
        extra = String(msg.tool_call_id || msg.id || '');
    }
    return crypto.createHash('sha256').update(role + '\n' + content + '\n' + extra).digest('hex');
}

// Stable per-conversation id from system instructions + the first TWO user messages.
// Same opencode session always maps to the same chat: the opening prefix never
// changes as turns are appended, while a new session (different opener) gets a
// fresh chat. By hashing the first TWO user messages (ignoring assistant and tool turns):
// - Turn 1: hashes [u1] -> chat A
// - Turn 2: hashes [u1, u2] -> chat B (or adopts chat A via opener settling)
// - Turn 3+: hashes [u1, u2] -> stable forever!
// This avoids infinite collisions between unrelated sessions opening with "Hello",
// while settling strictly after turn 2 without churn across tool/assistant turns.
// Model is excluded on purpose: switching models mid-session reuses the chat
// (thinking_enabled is per-message upstream).
function fingerprintConversation(messages) {
    const systemText = (messages || [])
        .filter(m => m && m.role === 'system' && m.content)
        .map(m => normalizeMessageContent(m.content))
        .join('\n');
    const userTexts = (messages || [])
        .filter(m => m && m.role === 'user' && m.content)
        .slice(0, 2)
        .map(m => `user:${normalizeMessageContent(m.content)}`);
    return crypto.createHash('sha256').update(systemText + '\n---\n' + userTexts.join('\n---\n')).digest('hex').substring(0, 12);
}

function isDeltaPromptMode() {
    return ['1', 'true', 'yes', 'on'].includes(String(process.env.DEEPSEEK_DELTA_PROMPT || '').trim().toLowerCase());
}

// Canonical client tool-set key: sorted function names. Names (not schemas)
// determine callability, so a name change is the drift signal worth a full
// resend; description/schema edits ride along on the next full prompt.
function toolNamesKeyFor(tools) {
    return (tools || [])
        .map(t => t && t.function && t.function.name)
        .filter(n => typeof n === 'string' && n.length > 0)
        .sort()
        .join(',');
}

// Split client (non-system) messages into already-forwarded prefix vs new
// suffix. Returns the full list with isDelta=false on ANY doubt (cold chat,
// boundary mismatch after client-side compaction/rewrites, empty suffix).
function splitClientMessages(messages, session) {
    const turnMessages = (messages || []).filter(m => m && m.role !== 'system');
    const sent = Number(session && session.deltaMsgCount) || 0;
    const boundary = session ? session.deltaBoundary : null;
    if (sent > 0 && sent <= turnMessages.length && boundary) {
        // Whole-prefix check (R1-C1): the boundary anchor alone cannot see
        // edits to earlier messages. A diverged prefix falls back to a full
        // resend — the remote chat is append-only, but the model still gets
        // the corrected context in-prompt.
        if (session.deltaPrefixHash) {
            const prefixHash = crypto.createHash('sha256')
                .update(turnMessages.slice(0, sent).map(hashMessageEnvelope).join('|'))
                .digest('hex');
            if (prefixHash !== session.deltaPrefixHash) {
                return { effective: turnMessages, isDelta: false, forwardedCount: 0 };
            }
        }
        if (hashMessageEnvelope(turnMessages[sent - 1]) === boundary) {
            const suffix = turnMessages.slice(sent);
            if (suffix.length > 0) {
                return { effective: suffix, isDelta: true, forwardedCount: sent };
            }
        }
    }
    return { effective: turnMessages, isDelta: false, forwardedCount: 0 };
}

// Single commit point for a turn (§8 deferred commit, H1): only a
// deliverable turn advances the cursor. Poisoned/empty/rate-limited turns
// return before the commit, leaving parentMessageId/messageCount/delta
// untouched so the next turn retries from the last good parent (no rewind
// needed — we simply never advanced). A null/empty messageId commits
// nothing: deltaMsgCount stays put and the next turn full-resends
// (isDelta:false). Returns true when the cursor advanced.
function commitTurnState(session, messageId, messages, deltaMode) {
    if (!session || !messageId) return false;
    session.parentMessageId = messageId;
    session.messageCount++;
    if (deltaMode) commitDeltaState(session, messages);
    persistSessions();
    return true;
}

// Record the full client message list as forwarded after a successful
// upstream call. Idempotent: retries/continuations re-record the same state.
function commitDeltaState(session, messages) {
    if (!session) return;
    const turnMessages = (messages || []).filter(m => m && m.role !== 'system');
    const envelopes = turnMessages.map(hashMessageEnvelope);
    session.deltaMsgCount = turnMessages.length;
    session.deltaBoundary = turnMessages.length > 0
        ? hashMessageEnvelope(turnMessages[turnMessages.length - 1])
        : null;
    session.deltaPrefixHash = envelopes.length > 0
        ? crypto.createHash('sha256').update(envelopes.join('|')).digest('hex')
        : null;
}

// Detect an opencode client-side compaction: the message list shrank well below
// what was already forwarded to the live chat AND the continuity boundary no
// longer matches. A plain retry resends the same count; an edit resend keeps
// the prefix — only a compaction collapse (dozens of turns -> one summary)
// shrinks by several messages at once. Returns false on any doubt.
function detectClientCompaction(messages, session) {
    if (!session || !session.id) return false;
    const turnMessages = (messages || []).filter(m => m && m.role !== 'system');
    const sent = Number(session.deltaMsgCount) || 0;
    if (sent < 3 || turnMessages.length === 0) return false;
    if (turnMessages.length >= sent) return false;
    if ((sent - turnMessages.length) < 2) return false;
    // Under a stable fingerprint the client list only grows (new turns) or
    // resends identically. A multi-message shrink means the client collapsed
    // history into a summary — i.e. an opencode compaction.
    if (!session.deltaBoundary) return false;
    // A benign trim keeps already-forwarded messages (oldest dropped first),
    // so the boundary envelope is still present. A compaction summary is new
    // text: boundary absent. Only the latter burns the chat (R1-C2).
    if (turnMessages.some(m => hashMessageEnvelope(m) === session.deltaBoundary)) return false;
    return true;
}

function isTitleGenerationRequest(messages) {
    if (!Array.isArray(messages) || messages.length === 0) return false;
    const firstUser = messages.find(m => m && m.role === 'user' && typeof m.content === 'string');
    return Boolean(firstUser && /^\s*Generate a title for this conversation\s*:/i.test(firstUser.content));
}

function generateLocalTitle(messages) {
    let targetText = '';
    for (const msg of messages || []) {
        if (!msg || typeof msg.content !== 'string') continue;
        const text = msg.content.trim();
        if (/^\s*Generate a title for this conversation\s*:/i.test(text)) {
            const stripped = text.replace(/^\s*Generate a title for this conversation\s*:\s*/i, '').trim();
            if (stripped) {
                targetText = stripped;
                break;
            }
        } else if (msg.role === 'user' && text) {
            targetText = text;
            break;
        }
    }
    targetText = targetText.replace(/^User:\s*/i, '').trim();
    if (!targetText) return 'New Chat';
    const firstLine = targetText.split('\n')[0].trim();
    const words = firstLine.split(/\s+/).filter(Boolean);
    if (words.length === 0) return 'New Chat';
    const titleWords = words.slice(0, 6).map(w => w.charAt(0).toUpperCase() + w.slice(1));
    let title = titleWords.join(' ');
    if (title.length > 50) title = title.substring(0, 47) + '...';
    return title || 'New Chat';
}

// solvePOW() lives in lib/pow (compiled-module cache + WASM-fetch timeout),
// shared with client.js. Called as solvePOW(challenge, wasmUrl).

const MODEL_CONFIGS = {
    // DeepSeek Web real model_type: default / UI name: "Быстрый".
    // Public model family: DeepSeek-V3.2-Exp chat mode (fast, no visible reasoning).
    'deepseek-chat': {
        model_type: 'default', thinking_enabled: false, search_enabled: false,
        real_model: 'DeepSeek-V4-Flash non-thinking (DeepSeek Web “Быстрый” / default)',
        capabilities: { reasoning: false, web_search: false, files: true },
        supported: true,
    },
    'deepseek-v3': {
        model_type: 'default', thinking_enabled: false, search_enabled: false,
        real_model: 'DeepSeek-V4-Flash non-thinking (DeepSeek Web “Быстрый” / default)',
        capabilities: { reasoning: false, web_search: false, files: true },
        supported: true,
    },
    'deepseek-default': {
        model_type: 'default', thinking_enabled: false, search_enabled: false,
        real_model: 'DeepSeek-V4-Flash non-thinking (DeepSeek Web “Быстрый” / default)',
        capabilities: { reasoning: false, web_search: false, files: true },
        supported: true,
    },
    // Same DeepSeek Web default model, but with thinking_enabled=true. UI exposes it as thinking/reasoning mode.
    'deepseek-reasoner': {
        model_type: 'default', thinking_enabled: true, search_enabled: false,
        real_model: 'DeepSeek-V4-Flash thinking mode (DeepSeek Web “Быстрый” + thinking_enabled)',
        capabilities: { reasoning: true, web_search: false, files: true },
        supported: true,
    },
    'deepseek-r1': {
        model_type: 'default', thinking_enabled: true, search_enabled: false,
        real_model: 'DeepSeek-V4-Flash thinking mode; R1-compatible alias, not a separate R1 model_type in current Web API',
        capabilities: { reasoning: true, web_search: false, files: true },
        supported: true,
    },
    'deepseek-chat-search': {
        model_type: 'default', thinking_enabled: false, search_enabled: true,
        real_model: 'DeepSeek-V4-Flash non-thinking (DeepSeek Web “Быстрый” / default) + web search',
        capabilities: { reasoning: false, web_search: true, files: true },
        supported: true,
    },
    'deepseek-default-search': {
        model_type: 'default', thinking_enabled: false, search_enabled: true,
        real_model: 'DeepSeek-V4-Flash non-thinking (DeepSeek Web “Быстрый” / default) + web search',
        capabilities: { reasoning: false, web_search: true, files: true },
        supported: true,
    },
    'deepseek-reasoner-search': {
        model_type: 'default', thinking_enabled: true, search_enabled: true,
        real_model: 'DeepSeek-V4-Flash thinking mode + web search',
        capabilities: { reasoning: true, web_search: true, files: true },
        supported: true,
    },
    'deepseek-r1-search': {
        model_type: 'default', thinking_enabled: true, search_enabled: true,
        real_model: 'DeepSeek-V4-Flash thinking mode + web search; R1-compatible alias',
        capabilities: { reasoning: true, web_search: true, files: true },
        supported: true,
    },
    // DeepSeek Web UI name: “Эксперт”. Requires current web client headers (x-client-version=2.0.0).
    'deepseek-expert': {
        model_type: 'expert', thinking_enabled: false, search_enabled: false,
        real_model: 'DeepSeek Web “Эксперт” (limited resources)',
        capabilities: { reasoning: false, web_search: false, files: false },
        supported: true,
    },
    'deepseek-v4-pro': {
        model_type: 'expert', thinking_enabled: true, search_enabled: false,
        real_model: 'DeepSeek Web “Эксперт” + thinking mode (exposed as deepseek-v4-pro alias)',
        capabilities: { reasoning: true, web_search: false, files: false },
        supported: true,
    },
    'deepseek-expert-search': {
        model_type: 'expert', thinking_enabled: false, search_enabled: true,
        real_model: 'DeepSeek Web “Эксперт” + search requested, but Expert has search_feature=null in remote config',
        capabilities: { reasoning: false, web_search: false, files: false },
        supported: false,
        unavailable_reason: 'Expert mode is rejected; remote config says search is not available for Expert.',
    },
    'deepseek-vision': {
        model_type: 'vision', thinking_enabled: false, search_enabled: false,
        real_model: 'DeepSeek Web “Распознавание” / image understanding beta',
        capabilities: { reasoning: false, web_search: false, files: true, vision: true },
        supported: false,
        unavailable_reason: 'Current Web API returns: Vision is temporarily unavailable (backend_err_by_model).',
    },
};

const SUPPORTED_MODEL_IDS = Object.keys(MODEL_CONFIGS).filter(id => MODEL_CONFIGS[id].supported);
const ALL_MODEL_CAPABILITIES = Object.fromEntries(Object.entries(MODEL_CONFIGS).map(([id, cfg]) => [id, {
    id,
    real_model: cfg.real_model,
    model_type: cfg.model_type,
    thinking_enabled: cfg.thinking_enabled,
    search_enabled: cfg.search_enabled,
    capabilities: cfg.capabilities,
    supported: cfg.supported,
    unavailable_reason: cfg.unavailable_reason || null,
}]));

function isAssistantOutputFragment(fragment) {
    return fragment
        && (fragment.type === 'RESPONSE' || fragment.type === 'SEARCH')
        && typeof fragment.content === 'string';
}

function isReasoningFragment(fragment) {
    return fragment
        && (fragment.type === 'THINK' || fragment.type === 'REASONING')
        && typeof fragment.content === 'string';
}

function isDeepSeekModelErrorEvent(event) {
    return event && event.type === 'error';
}

function createUpstreamHttpError(status, body = '', retryAfter = null) {
    const code = Number(status) || 502;
    const detail = toClientErrorMessage(String(body || '').replace(/\s+/g, ' ').trim().substring(0, 300));
    const type = code === 429
        ? 'rate_limit_error'
        : ((code === 401 || code === 403) ? 'authentication_error' : 'upstream_http_error');
    const error = new Error(`DeepSeek upstream HTTP ${code}${detail ? `: ${detail}` : ''}`);
    error.status = code;
    error.type = type;
    if (retryAfter) error.retryAfter = retryAfter;
    return error;
}

function createChatExpiredError(status) {
    const err = new Error(`DeepSeek chat session expired or invalidated upstream (HTTP ${status}). Type /new to start a fresh chat.`);
    err.type = 'chat_expired';
    err.status = Number(status) || 500;
    return err;
}

function rebuildFragmentText(fragments) {
    const responseText = fragments
        .filter(isAssistantOutputFragment)
        .map(f => f.content)
        .join('');
    const thinkText = fragments
        .filter(isReasoningFragment)
        .map(f => f.content)
        .join('');
    return { responseText, thinkText };
}

function applyResponsePatchOperations(ops, appendFragments) {
    if (!Array.isArray(ops)) return false;
    let applied = false;
    for (const op of ops) {
        if (!op || typeof op !== 'object') continue;
        if (op.p === 'fragments' && op.o === 'APPEND' && op.v !== undefined) {
            appendFragments(op.v);
            applied = true;
        } else {
            // Observability: non-APPEND ops are dropped by design (never
            // observed upstream); log them so a future SET/REPLACE silently
            // diverging the client becomes visible instead of silent data loss.
            try { console.log(`[fragments] Ignoring unknown patch op: ${JSON.stringify(op).slice(0, 200)}`); } catch (e) { }
        }
    }
    return applied;
}

async function consumeDeepSeekStream(readable, { onReasoningDone, onReasoningProgress, isClientGone } = {}) {
    let buffer = '';
    let lastPath = null;
    const fragments = [];
    let fullContent = '';
    let reasoningContent = '';
    let newMessageId = null;
    let finishReason = null;
    let modelError = null;
    let reasoningFlushed = false;
    let lastProgressThink = '';
    let snapshotAfterFlushWarned = false;

    const checkReasoningTransition = () => {
        if (reasoningFlushed) return;
        if (!reasoningContent || reasoningContent.trim().length === 0) return;
        const hasResponseFragment = fragments.some(isAssistantOutputFragment);
        const hasResponseContent = fullContent.length > 0;
        if (hasResponseFragment || hasResponseContent || finishReason) {
            reasoningFlushed = true;
            if (typeof onReasoningDone === 'function') {
                try { onReasoningDone(reasoningContent); } catch (e) { }
            }
        }
    };

    const rebuildFragmentState = () => {
        const { responseText, thinkText } = rebuildFragmentText(fragments);
        if (responseText) fullContent = responseText;
        reasoningContent = thinkText;
    };

    const appendFragments = (value) => {
        const incoming = Array.isArray(value) ? value : [value];
        for (const fragment of incoming) {
            if (fragment && typeof fragment === 'object') fragments.push({ ...fragment });
        }
        rebuildFragmentState();
    };

    const decoder = new TextDecoder();
    const handleDataLine = (line) => {
        if (line.startsWith('data: ')) {
            try {
                const d = JSON.parse(line.slice(6));
                if (d.response_message_id !== undefined && !newMessageId) newMessageId = d.response_message_id;
                if (isDeepSeekModelErrorEvent(d)) {
                    modelError = { type: d.type || 'error', content: d.content || '', finish_reason: d.finish_reason || null };
                }
                if (d.finish_reason) {
                    finishReason = d.finish_reason;
                }
                if (d.p !== undefined) lastPath = d.p;
                if (d.v && typeof d.v === 'object' && d.v.response) {
                    if (d.v.response.message_id !== undefined) {
                        newMessageId = d.v.response.message_id;
                    }
                    if (d.v.response.content !== undefined) {
                        fullContent = d.v.response.content;
                    }
                    if (Array.isArray(d.v.response.fragments)) {
                        // Guard: a full snapshot after the reasoning flush would
                        // supersede already-emitted thinking (irreversible).
                        // Never observed; warn once per turn if it ever happens.
                        if (reasoningFlushed && !snapshotAfterFlushWarned) {
                            snapshotAfterFlushWarned = true;
                            console.log('[fragments] Full snapshot arrived after reasoning flush; client may hold superseded thinking');
                        }
                        fragments.length = 0;
                        appendFragments(d.v.response.fragments);
                    }
                    if (d.v.response.finish_reason !== undefined) {
                        finishReason = d.v.response.finish_reason;
                    }
                }
                if (lastPath === 'response/fragments' && d.v !== undefined) {
                    appendFragments(d.v);
                }
                if (lastPath === 'response' && d.v !== undefined) {
                    applyResponsePatchOperations(d.v, appendFragments);
                }
                if (lastPath === 'response/fragments/-1/content' && d.v !== undefined && typeof d.v !== 'object') {
                    if (fragments.length > 0) {
                        const lastFragment = fragments[fragments.length - 1];
                        lastFragment.content = `${lastFragment.content || ''}${d.v}`;
                        rebuildFragmentState();
                    }
                }
                if (lastPath === 'response/content' && d.v !== undefined && typeof d.v !== 'object') {
                    fullContent += d.v;
                }
                if (lastPath === 'response/finish_reason' && d.v !== undefined) {
                    finishReason = d.v;
                }
                if (lastPath === 'response/status' && d.v !== undefined && d.v !== 'FINISHED') {
                    finishReason = d.v;
                }
                // Progress BEFORE transition (live-thinking pump): on a combined
                // THINK+RESPONSE snapshot the pump must emit before onReasoningDone
                // runs, or the legacy burst fires on an unused pump and the same
                // thinking emits twice. Value comparison suffices (no identity).
                if (typeof onReasoningProgress === 'function' && reasoningContent !== lastProgressThink) {
                    lastProgressThink = reasoningContent;
                    try { onReasoningProgress(reasoningContent); } catch (e) { }
                }
                checkReasoningTransition();
            } catch (e) { }
        }
    };
    for await (const chunk of readable) {
        if (isClientGone && isClientGone()) {
            try { if (typeof readable.destroy === 'function') readable.destroy(); } catch (e) { }
            return { content: '', reasoningContent: '', messageId: null, finishReason: null, modelError: null, abandoned: true };
        }
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) handleDataLine(line);
    }

    buffer += decoder.decode();
    if (buffer) handleDataLine(buffer);

    checkReasoningTransition();
    return { content: fullContent, reasoningContent, messageId: newMessageId, finishReason, modelError, abandoned: false };
}

function resolveModelConfig(model) {
    const requested = String(model || 'deepseek-chat').toLowerCase();
    return MODEL_CONFIGS[requested] || MODEL_CONFIGS['deepseek-chat'];
}
function isKnownModel(model) { return Object.prototype.hasOwnProperty.call(MODEL_CONFIGS, String(model || '').toLowerCase()); }
function isSupportedModel(model) { return resolveModelConfig(model).supported === true; }

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
    const agentTag = `[${agentId}/acct:${account.id}]`;

    // Rollover retired per implementor-brief-no-new-chats-2026-09-15
    const rollover = null;
    const accountRotationReset = hadRemoteSession && !session.id;
    const recoveredFreshSession = accountRotationReset;
    let effectivePrompt = recoveredFreshSession ? freshSessionPrompt : prompt;
    if (accountRotationReset) {
        console.log(`${agentTag} Account rotation reset the previous remote session; using recovery prompt.`);
    }

    try {
        const cr = await dsFetch('https://chat.deepseek.com/api/v0/chat/create_pow_challenge', {
            method: 'POST', headers: dsHeaders,
            body: JSON.stringify({ target_path: '/api/v0/chat/completion' })
        });
    const chalText = await cr.text();
    if (!cr.ok) {
        markAccountFailure(account, cr.status, 'pow challenge');
        throw new Error(`DeepSeek auth/network error while creating PoW challenge: HTTP ${cr.status}. Run npm run doctor. If auth expired, run npm run auth or npm run auth:import.`);
    }
    let chalJson;
    try { chalJson = JSON.parse(chalText); }
    catch (e) {
        markAccountFailure(account, cr.status, 'pow challenge non-JSON');
        throw new Error(`DeepSeek returned non-JSON PoW response. Run npm run doctor. First chars: ${chalText.substring(0, 120)}`);
    }
    const challenge = chalJson?.data?.biz_data?.challenge;
    if (!challenge) {
        markAccountFailure(account, cr.status, 'pow challenge missing');
        throw new Error('DeepSeek PoW response has no data.biz_data.challenge. Auth may be expired, captcha may be required, or DeepSeek changed Web API. Run npm run doctor, then npm run auth.');
    }
    // Quota clock starts here: the turn reached upstream (challenge issued),
    // whether the completion that follows succeeds or not. Earlier failures
    // (network/auth before this point) cost no quota. Unconditional writer:
    // burst needs the ring even when quota is off (C1 — the gated wrapper
    // here would silently disable burst under DEEPSEEK_HOURLY_QUOTA=0).
    recordUpstreamTurn(account);
    const powT0 = Date.now();
    // A PoW failure is an account-level upstream fault, not a chat fault — but
    // it must not cool the account: a stalled WASM CDN is not a rate limit,
    // and sidelining a healthy login over it would be worse (F16). Count the
    // failure, surface a typed 502, keep the chat (caller preserves it).
    let answer;
    try {
        answer = await solvePOW(challenge, account.config.wasmUrl);
    } catch (e) {
        markAccountFailure(account, 500, 'pow solve');
        const powErr = new Error(`DeepSeek PoW solve failed (${e && e.message ? e.message : e}). Run npm run doctor.`);
        powErr.status = 502; powErr.type = 'pow_error';
        throw powErr;
    }
    const powMs = Date.now() - powT0;
    // solvePOW is synchronous WASM: a high-difficulty challenge blocks the
    // whole single-process server. No blind cap (normal difficulty unknown);
    // log slow solves so a future worker-threads move has real data (6c).
    if (powMs > 5000) console.log(`[account:${account.id}] slow PoW solve: ${powMs}ms (difficulty ${challenge.difficulty})`);
    logDebug(`[account:${account.id}] PoW solve: ${powMs}ms (difficulty ${challenge.difficulty})`);

    if (!session.id) {
        const sr = await dsFetch('https://chat.deepseek.com/api/v0/chat_session/create', {
            method: 'POST', headers: dsHeaders, body: '{}'
        });
        const { json: sessionData, text: sessionText } = await readDeepSeekJsonResponse(sr, 'session create', account);
        const createdSessionId = sessionData?.data?.biz_data?.chat_session?.id || sessionData?.data?.biz_data?.id;
        if (!sr.ok || !createdSessionId) {
            throw new Error(`Could not create DeepSeek chat session (HTTP ${sr.status}). Auth may be expired/captcha-blocked. Run npm run doctor, then npm run auth. First chars: ${String(sessionText || '').substring(0, 120)}`);
        }
        session.id = createdSessionId;
        session.accountId = account.id;
        session.parentMessageId = null;
        session.createdAt = Date.now();
        session.messageCount = 0;
        persistSessions();
        console.log(`${agentTag} Created new session: ${session.id}`);
    } else {
        console.log(`${agentTag} Reusing session: ${session.id} (parent: ${session.parentMessageId}, msg#${session.messageCount})`);
    }

    const powB64 = Buffer.from(JSON.stringify({
        algorithm: challenge.algorithm, challenge: challenge.challenge,
        salt: challenge.salt, answer: answer,
        signature: challenge.signature, target_path: '/api/v0/chat/completion'
    })).toString('base64');
    const resp = await dsFetch('https://chat.deepseek.com/api/v0/chat/completion', {
        method: 'POST',
        headers: { ...dsHeaders, 'X-DS-PoW-Response': powB64 },
        body: JSON.stringify({
            chat_session_id: session.id,
            parent_message_id: session.parentMessageId,
            model_type: modelCfg.model_type,
            prompt: effectivePrompt, ref_file_ids: [],
            thinking_enabled: modelCfg.thinking_enabled, search_enabled: modelCfg.search_enabled,
            action: null, preempt: false,
        })
    });

    // If session expired, reset and retry once
    if (resp.status !== 200) {
        // Pass Retry-After so a 429 honors the server-requested cooldown (#16).
        const retryAfter = resp.headers.get('retry-after');
        markAccountFailure(account, resp.status, 'completion', retryAfter);
        const errText = await resp.text();
        console.log(`${agentTag} Session error (${resp.status}): ${errText.substring(0, 100)}`);
        if (resp.status === 400 || resp.status === 404 || resp.status === 500) {
            console.log(`${agentTag} Session ${session.id} expired or invalidated upstream (${resp.status}); preserving session per invariant.`);
            throw createChatExpiredError(resp.status);
        }
        // The body was consumed for diagnostics, so returning this Response
        // would hand a locked stream to readDeepSeekResponse. Surface a typed
        // error instead and retain the real upstream status/Retry-After.
        throw createUpstreamHttpError(resp.status, errText, retryAfter);
    }

    // Upstream answered 200: the account is healthy. Clear any cooldown and
    // reset the consecutive-failure counter (8b) — stale backoff must not
    // outlive the outage, and `failures` becomes consecutive (meaningful for
    // any future backoff policy instead of write-only).
    account.cooldownUntil = 0;
    account.failures = 0;
    account.consecutiveFailures = 0;
    account.consecutiveTimeouts = 0;
    account.lastSuccessAt = Date.now();
    // Latency EWMA (display-only, never scored): alpha 0.3 reacts within ~3
    // turns while staying readable. Failures never touch it.
    const turnMs = Date.now() - askTurnStartedAt;
    account.ewmaLatencyMs = nextEwmaLatency(account.ewmaLatencyMs, turnMs);
    return { resp, agentId, account, promptUsed: effectivePrompt, freshSessionReset: recoveredFreshSession };
    } catch (e) {
        if (isTimeoutError(e) || e.name === 'AbortError' || /timeout|abort/i.test(e.message || '')) {
            markAccountFailure(account, 504, 'timeout / fetch abort');
            try { e._accountMarked = true; } catch (_) {}
        } else if (isNetworkError(e)) {
            // DNS/reset/refused-class failures are not timeouts, but a dead network
            // path must back off like one — otherwise sticky sessions pin to it at
            // full retry rate. Deliberately excludes PoW solve failures ('POW failed'
            // carries no network cause) and parse/programming errors.
            markAccountFailure(account, 504, `network unreachable (${e.cause?.code || 'fetch failed'})`);
            try { e._accountMarked = true; } catch (_) {}
        }
        throw e;
    } finally {
        const remaining = (Number(account.inflight) || 1) - 1;
        if (remaining < 0) console.warn(`[account:${account.id}] inflight clamp engaged (counter would go negative); floored at 0 — investigate for a leak.`);
        account.inflight = Math.max(0, remaining);
    }
}

// === Repeat-repair guard ===
// A twice-failed turn makes the client retry it verbatim, which used to
// re-run the identical 80k repair (minting another dead chat) once per
// cycle. Repairs for one unique turn are recognized by prompt hash and
// capped: the first inbound tries full-context strict resends in the same chat,
// a verbatim client retry gets one more full reminder attempt, and any further
// repeat fails fast to the 502 below without another upstream call.
const REPAIR_GUARD_MS = 10 * 60 * 1000;

function classifyRepairAttempt(session, repairHash, now = Date.now()) {
    const prev = session ? session.repairHash : null;
    const at = session ? (session.repairAt || 0) : 0;
    const count = session ? (session.repairCount || 0) : 0;
    const repeat = !!prev && prev === repairHash && (now - at) < REPAIR_GUARD_MS && count >= 1;
    return { repeat, capped: repeat && count >= 2 };
}

function recordRepairAttempt(session, repairHash, now = Date.now()) {
    if (!session) return;
    session.repairHash = repairHash;
    session.repairAt = now;
    session.repairCount = (Number(session.repairCount) || 0) + 1;
}

function clearRepairGuard(session, repairHash = null) {
    if (!session) return;
    // Turn-scoped clear: a success must not wipe a DIFFERENT in-flight
    // turn's guard when two same-agent requests interleave (no per-agent
    // lock exists). Omitted hash preserves the old clear-everything behavior.
    if (repairHash && session.repairHash && session.repairHash !== repairHash) return;
    session.repairHash = null;
    session.repairAt = 0;
    session.repairCount = 0;
}

// Stable client-turn identity for the repeat-repair guard (F1). The old hash
// covered the fully-built strict prompt, which embeds the recovery history
// prefix only when session.id is null — so a 502-reset changed the hash and
// the verbatim client retry classified as fresh, buying an extra lean+full
// cycle before the cap engaged. Hashing the canonical turn inputs instead
// (messages + tool-set key) is identical for verbatim retries on either side
// of a reset, and differs for any genuinely new turn (append-only growth).
function repairTurnHash(messages, tools) {
    let canon;
    try {
        canon = JSON.stringify(messages || []);
    } catch (e) {
        canon = String((messages || []).length);
    }
    return crypto.createHash('sha256').update(canon + '\n---\n' + toolNamesKeyFor(tools)).digest('hex');
}


// === Tool Calling Support ===

const TOOL_SCHEMA_ANNOTATION_KEYS = new Set(['description', 'examples', '$comment', 'title']);
const TOOL_SCHEMA_MAP_KEYS = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']);
const TOOL_SCHEMA_ARRAY_KEYS = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems']);
const TOOL_SCHEMA_SINGLE_KEYS = new Set([
    'additionalItems', 'additionalProperties', 'contains', 'contentSchema', 'else', 'if',
    'items', 'not', 'propertyNames', 'then', 'unevaluatedItems', 'unevaluatedProperties',
]);

function compactToolSchema(value) {
    if (Array.isArray(value)) return value.map(compactToolSchema);
    if (!value || typeof value !== 'object') return value;
    const compact = {};
    for (const [key, child] of Object.entries(value)) {
        // Descriptions/examples dominate large agent tool payloads but do not
        // affect argument validation. Traverse only keywords whose values are
        // themselves schemas. Literal instance values under const/enum/default
        // must remain byte-for-byte equivalent, even when they contain fields
        // named "description" or "title".
        if (TOOL_SCHEMA_ANNOTATION_KEYS.has(key)) continue;
        if (TOOL_SCHEMA_MAP_KEYS.has(key) && child && typeof child === 'object' && !Array.isArray(child)) {
            compact[key] = Object.fromEntries(Object.entries(child).map(([name, schema]) => [name, compactToolSchema(schema)]));
        } else if (TOOL_SCHEMA_ARRAY_KEYS.has(key) && Array.isArray(child)) {
            compact[key] = child.map(compactToolSchema);
        } else if (TOOL_SCHEMA_SINGLE_KEYS.has(key)) {
            compact[key] = Array.isArray(child) ? child.map(compactToolSchema) : compactToolSchema(child);
        } else if (key === 'dependencies' && child && typeof child === 'object' && !Array.isArray(child)) {
            compact[key] = Object.fromEntries(Object.entries(child).map(([name, dependency]) => [
                name,
                Array.isArray(dependency) ? dependency : compactToolSchema(dependency),
            ]));
        } else {
            compact[key] = child;
        }
    }
    return compact;
}

function formatToolArgType(schema) {
    if (!schema || typeof schema !== 'object') return 'string';
    if (Array.isArray(schema.enum) && schema.enum.length > 0) {
        return schema.enum.map(v => String(v)).join('|').substring(0, 60);
    }
    if (Array.isArray(schema.type)) return schema.type[0] || 'string';
    return schema.type || 'string';
}

function formatToolLine(fn) {
    const name = fn.name || 'unknown';
    const desc = String(fn.description || '').replace(/\s+/g, ' ').trim().substring(0, 120);
    const props = (fn.parameters && typeof fn.parameters === 'object' && fn.parameters.properties && typeof fn.parameters.properties === 'object') ? fn.parameters.properties : {};
    const required = (fn.parameters && Array.isArray(fn.parameters.required) && fn.parameters.required.length > 0) ? fn.parameters.required : Object.keys(props);
    const reqParts = required.filter(n => typeof n === 'string').slice(0, 12).map(n => `${n}:${formatToolArgType(props[n] || {})}`);
    const optional = Object.keys(props).filter(n => !required.includes(n)).slice(0, 8);
    let line = `${name}: ${desc}`;
    line += reqParts.length > 0 ? ` | req: ${reqParts.join(',')}` : ' | req: none';
    if (optional.length > 0) line += ` | opt: ${optional.slice(0, 8).map(n => `${n}:${formatToolArgType(props[n] || {})}`).join(',')}`;
    return line.substring(0, 300);
}

// Operator console shell (default fish). The full SHELL line lives in the
// tool block, which is only sent at chat creation — so suffix-only turns
// carry a one-line reminder instead (see the established-chat prompt build).
function localShellName() {
    const v = process.env.DEEPSEEK_LOCAL_SHELL;
    return (v === undefined ? 'fish' : String(v)).trim().toLowerCase();
}

function shellReminderLine() {
    const shell = localShellName();
    if (!shell) return '';
    // Compact by design: this rides every suffix-only turn, so one short
    // paragraph covers both shell compat and tool-call discipline.
    return `[SHELL: operator console uses ${shell} — write ${shell}-compatible commands, no bash-isms. ` +
        `Tool discipline: prefer read/edit/grep/glob over bash; batch independent calls in one block; no prose alongside tool calls (thinking OK); keep call count tight.]`;
}

function formatToolDefinitions(tools) {
    if (!tools || tools.length === 0) return '';
    const rawSchemaChars = tools.reduce((total, tool) => {
        try { return total + JSON.stringify(tool?.function?.parameters || {}).length; }
        catch (e) { return total; }
    }, 0);
    const compactSchemas = rawSchemaChars > Math.floor(MAX_UPSTREAM_PROMPT_CHARS * 0.4);
    const fullMode = String(process.env.DEEPSEEK_TOOL_PROMPT_MODE || 'compact').trim().toLowerCase() === 'full';
    let text = '\n\n--- TOOL REQUEST SYSTEM (DeepSeek Web backend) ---\n';
    text += 'DeepSeek Web behind an OpenAI-compatible proxy for an opencode agent. Per turn output EITHER (A) 1-8 newline-delimited strict-JSON {"tool_call":{...}} objects (one per line, no fences, no prose between), OR (B) plain text. Never mix.\n';
    text += 'JSON: {"tool_call":{"name":"<function_name>","arguments":{...}}}\n';
    text += 'FORBIDDEN: fences, <tool_call> XML, DSML, TOOL_CALL:, bare shell, fake [Tool Result]. Old formats parse for compat \u2014 do NOT generate them.\n';
    text += 'Gateway runs the tool, returns [Tool Result] next message. Tools run on the proxy host \u2014 NOT on DeepSeek. args MUST be a JSON object, compact, max 8 tools/turn (independent/parallel-safe only; do NOT batch mutations touching the same target), name must exist below.\n';
    text += 'PREF: read/edit/grep > bash/cat/grep/find; MCP-FS only for batch (multi-read/write, ls, info, move).\n';
    text += 'BATCH DISCIPLINE: at most 6 tool batches per task; 1 batch = one turn with max 8 tool calls. Plan multi-step work to fit: batch independent calls together, then answer from results. Do not re-batch the same calls and do not split one batch across turns.\n';
    const localShell = localShellName();
    if (localShell) text += `SHELL: operator console shell is ${localShell} (Linux). Any command sent via a shell tool MUST be ${localShell}-compatible — no bash-isms ([[ ]], <(), export FOO=bar, source x.sh, function f()); use ${localShell} equivalents. When in doubt prefer read/edit/grep tools over shell.\n`;
    text += 'Ex: {"tool_call":{"name":"bash","arguments":{"command":"ls -la"}}}\n';
    text += 'Tools (name: what | req: name:type | opt: names):\n';
    if (fullMode) {
        for (const tool of tools) {
            if (tool.type === 'function' && tool.function) {
                const fn = tool.function;
                text += `\n## ${fn.name}\n`;
                const description = String(fn.description || '').replace(/\s+/g, ' ').trim();
                text += `${description.length > 500 ? description.substring(0, 497) + '...' : description}\n`;
                if (fn.parameters) {
                    text += `Parameters: ${JSON.stringify(compactSchemas ? compactToolSchema(fn.parameters) : fn.parameters)}\n`;
                }
            }
        }
    } else {
        for (const tool of tools) {
            if (tool.type === 'function' && tool.function) {
                text += formatToolLine(tool.function) + '\n';
            }
        }
    }
    text += '--- END TOOL REQUEST SYSTEM ---\n';
    text += 'REMEMBER: strict-JSON 1-8 {"tool_call":{...}} lines OR plain text. No fences, no mix, no bare shell.';
    const extraPrompt = String(process.env.DEEPSEEK_TOOL_PROMPT_EXTRA || '').trim();
    if (extraPrompt) text += '\n\n[Local operator override]\n' + extraPrompt;
    return text;
}

const MAX_TOOL_MARKUP_CHARS = 256 * 1024;
const MAX_TOOL_ARGUMENT_CHARS = 128 * 1024;
const MAX_TOOL_JSON_CANDIDATES = 32;
const MAX_TOOL_CALLS_PER_TURN = 8;
const MAX_DSML_PARAMETERS = 128;
const MAX_DSML_STRUCTURAL_TAGS = MAX_DSML_PARAMETERS * 2 + 16;
const MAX_DSML_TAG_CHARS = 2048;

function extractBalancedJsonAt(text, startIndex) {
    if (text[startIndex] !== '{') return null;
    let braceDepth = 0;
    let inString = false;
    let escape = false;
    for (let i = startIndex; i < text.length; i++) {
        const ch = text[i];
        if (escape) { escape = false; continue; }
        if (ch === '\\' && inString) { escape = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (!inString) {
            if (ch === '{') braceDepth++;
            if (ch === '}') {
                braceDepth--;
                if (braceDepth === 0) return text.substring(startIndex, i + 1);
            }
        }
    }
    return null;
}

function extractBalancedJsonObjects(text, maxObjects = MAX_TOOL_JSON_CANDIDATES) {
    const objects = [];
    let start = -1;
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (start === -1) {
            if (ch === '{') {
                start = i;
                depth = 1;
                inString = false;
                escape = false;
            }
            continue;
        }
        if (escape) { escape = false; continue; }
        if (ch === '\\' && inString) { escape = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (ch === '{') depth++;
        if (ch === '}') {
            depth--;
            if (depth === 0) {
                objects.push(text.substring(start, i + 1));
                if (objects.length >= maxObjects) return objects;
                start = -1;
            }
        }
    }
    return objects;
}

function buildToolCall(name, args = {}) {
    const toolName = typeof name === 'string' ? name.trim() : '';
    if (!/^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$/.test(toolName)) return null;
    let parsedArgs = args;
    if (typeof parsedArgs === 'string') {
        if (parsedArgs.length > MAX_TOOL_ARGUMENT_CHARS) return null;
        try { parsedArgs = JSON.parse(parsedArgs); } catch (e) { return null; }
    }
    if (parsedArgs === null || parsedArgs === undefined) parsedArgs = {};
    if (typeof parsedArgs !== 'object' || Array.isArray(parsedArgs)) return null;
    let serialized;
    try { serialized = JSON.stringify(parsedArgs); } catch (e) { return null; }
    if (serialized.length > MAX_TOOL_ARGUMENT_CHARS) return null;
    return { name: toolName, arguments: serialized };
}

function coerceToolCallObject(obj, { allowBare = false } = {}) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    let candidate = null;
    if (Object.prototype.hasOwnProperty.call(obj, 'tool_call')) {
        candidate = obj.tool_call;
    } else if (Object.prototype.hasOwnProperty.call(obj, 'function_call')) {
        candidate = obj.function_call;
    } else if (Object.prototype.hasOwnProperty.call(obj, 'tool_calls')) {
        if (!Array.isArray(obj.tool_calls) || obj.tool_calls.length !== 1) return null;
        candidate = obj.tool_calls[0];
    } else if (allowBare) {
        candidate = obj;
    }
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
    const fn = candidate.function && typeof candidate.function === 'object'
        ? candidate.function
        : candidate;
    return buildToolCall(
        fn.name ?? candidate.name,
        fn.arguments ?? candidate.arguments ?? candidate.input ?? {}
    );
}

function parseJsonToolCandidate(raw, label = 'json', options = {}) {
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw);
        const tc = coerceToolCallObject(parsed, options);
        if (tc) {
            console.log(`[parseToolCall] SUCCESS ${label}: ${tc.name} (args=${tc.arguments.length} chars)`);
            return tc;
        }
    } catch (e) {
        console.log(`[parseToolCall] ${label} JSON.parse failed: ${e.message.substring(0, 100)}`);
    }
    return null;
}

function canonicalizeToolMarkupTag(rawTag) {
    let token = String(rawTag || '').trim()
        .replace(/｜/g, '|')
        .replace(/[“”＂]/g, '"')
        .replace(/[‘’＇]/g, "'");
    let closing = false;
    if (token.startsWith('/')) {
        closing = true;
        token = token.substring(1).trim();
    }
    token = token.replace(/^\|+\s*DSML\s*\|+\s*/i, '');
    if (token.startsWith('/')) {
        closing = true;
        token = token.substring(1).trim();
    }
    token = token.replace(/^DSML(?=(?:tool[\s_-]*calls|function[\s_-]*calls|invoke|parameter)\b)/i, '');

    if (!closing && /^name\s*=/i.test(token)) return `<direct ${token}>`;

    const semantic = token.match(/^(?:(?:[A-Za-z_][\w.-]*):)?(tool[\s_-]*calls|function[\s_-]*calls|invoke|parameter)\b([\s\S]*)$/i);
    if (!semantic) return null;
    const localName = semantic[1].replace(/[\s_-]/g, '').toLowerCase();
    const canonicalName = localName === 'toolcalls' || localName === 'functioncalls'
        ? 'tool_calls'
        : localName;
    const attrs = closing ? '' : semantic[2];
    return `<${closing ? '/' : ''}${canonicalName}${attrs}>`;
}

function normalizeToolMarkupTags(text) {
    const withAsciiAngles = String(text || '').replace(/＜/g, '<').replace(/＞/g, '>');
    return withAsciiAngles.replace(/<([^<>]{0,1024})>/g, (whole, rawTag) => {
        const canonical = canonicalizeToolMarkupTag(rawTag);
        return canonical || whole;
    });
}

function decodeDsmlValue(value) {
    return String(value || '')
        .replace(/&quot;/gi, '"')
        .replace(/&apos;/gi, "'")
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&amp;/gi, '&');
}

function decodeDsmlParameterValue(value) {
    const raw = String(value || '');
    const cdata = raw.trim().match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/i);
    return cdata ? cdata[1] : decodeDsmlValue(raw);
}

function getMarkupAttribute(attrs, attribute) {
    const match = String(attrs || '').match(new RegExp(`\\b${attribute}\\s*=\\s*(["'])([^"']+)\\1`, 'i'));
    return match ? match[2] : null;
}

function readDsmlTagAt(text, start) {
    if (text[start] !== '<') return null;
    const prefix = text.substring(start + 1, Math.min(text.length, start + 40)).trimStart();
    if (!/^\/?(?:tool_calls|invoke|parameter|direct)\b/i.test(prefix)) return null;
    let quote = null;
    let end = -1;
    const scanEnd = Math.min(text.length, start + MAX_DSML_TAG_CHARS + 1);
    for (let i = start + 1; i < scanEnd; i++) {
        const ch = text[i];
        if (quote) {
            if (ch === quote) quote = null;
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            continue;
        }
        if (ch === '>') {
            end = i;
            break;
        }
    }
    if (end === -1) return { invalid: true };

    let token = text.substring(start + 1, end).trim();
    let closing = false;
    if (token.startsWith('/')) {
        closing = true;
        token = token.substring(1).trim();
    }
    let selfClosing = false;
    if (!closing && token.endsWith('/')) {
        selfClosing = true;
        token = token.substring(0, token.length - 1).trim();
    }
    const match = token.match(/^(tool_calls|invoke|parameter|direct)\b([\s\S]*)$/i);
    if (!match) return null;
    return {
        name: match[1].toLowerCase(),
        attrs: closing ? '' : match[2],
        closing,
        selfClosing,
        start,
        end: end + 1,
    };
}

function scanDsmlStructuralTags(text) {
    const tags = [];
    const value = String(text || '');
    for (let i = 0; i < value.length;) {
        if (value.substring(i, i + 9).toUpperCase() === '<![CDATA[') {
            const cdataEnd = value.indexOf(']]>', i + 9);
            if (cdataEnd === -1) return null;
            i = cdataEnd + 3;
            continue;
        }
        if (value[i] !== '<') {
            i++;
            continue;
        }
        const tag = readDsmlTagAt(value, i);
        if (!tag) {
            i++;
            continue;
        }
        if (tag.invalid) return null;
        tags.push(tag);
        if (tags.length > MAX_DSML_STRUCTURAL_TAGS) return null;
        i = tag.end;
    }
    return tags;
}

function parseDsmlParameter(attrs, rawBody, args, seenNames) {
    const parameterName = getMarkupAttribute(attrs, 'name');
    if (!parameterName || !/^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$/.test(parameterName) || seenNames.has(parameterName)) return false;
    seenNames.add(parameterName);
    const stringMode = getMarkupAttribute(attrs, 'string');
    const rawValue = decodeDsmlParameterValue(rawBody);
    if (rawValue.length > MAX_TOOL_ARGUMENT_CHARS) return false;
    let value = rawValue;
    if (stringMode && stringMode.toLowerCase() === 'false') {
        try { value = JSON.parse(rawValue.trim()); } catch (e) { return false; }
    }
    args[parameterName] = value;
    return true;
}

function parseDsmlInvoke(name, body) {
    const structuralTags = scanDsmlStructuralTags(body);
    if (!structuralTags) return null;
    const parameterTags = structuralTags.filter(tag => tag.name === 'parameter');
    if (structuralTags.some(tag => tag.name !== 'parameter')) return null;

    const args = {};
    let parameterCount = 0;
    const seenNames = new Set();
    let cursor = 0;
    for (let i = 0; i < parameterTags.length; i += 2) {
        const opening = parameterTags[i];
        const closing = parameterTags[i + 1];
        if (!opening || opening.closing || opening.selfClosing || !closing || !closing.closing) return null;
        if (body.substring(cursor, opening.start).trim()) return null;
        parameterCount++;
        if (parameterCount > MAX_DSML_PARAMETERS) return null;
        if (!parseDsmlParameter(opening.attrs, body.substring(opening.end, closing.start), args, seenNames)) return null;
        cursor = closing.end;
    }
    if (parameterCount > 0) {
        if (body.substring(cursor).trim()) return null;
        return buildToolCall(name, args);
    }

    const decodedBody = decodeDsmlValue(body).trim();
    if (!decodedBody) return buildToolCall(name, {});
    const objects = extractBalancedJsonObjects(decodedBody, 2);
    if (objects.length !== 1 || decodedBody !== objects[0]) return null;
    try { return buildToolCall(name, JSON.parse(objects[0])); }
    catch (e) { return null; }
}

function extractToolCallScope(normalized) {
    const tags = scanDsmlStructuralTags(normalized);
    if (!tags) return null;
    const wrappers = tags.filter(tag => tag.name === 'tool_calls');
    const openings = wrappers.filter(tag => !tag.closing);
    const closings = wrappers.filter(tag => tag.closing);
    if (openings.length > 0) {
        if (openings.length !== 1 || openings[0].selfClosing || closings.length === 0) return null;
        const opening = openings[0];
        const closing = closings[closings.length - 1];
        if (wrappers.some(tag => tag.closing && tag.start < opening.end) || closing.start < opening.end) return null;
        if (tags.some(tag => tag.name !== 'tool_calls' && (tag.start < opening.end || tag.start >= closing.start))) return null;
        return normalized.substring(opening.end, closing.start);
    }
    // Narrow repair: tolerate a missing opening wrapper only when a closing
    // wrapper exists. A bare invoke without this sentinel is never executable.
    if (closings.length > 0) {
        const closing = closings[closings.length - 1];
        const invokeOpenings = tags.filter(tag => tag.name === 'invoke' && !tag.closing && tag.start < closing.start);
        if (invokeOpenings.length === 1 && !invokeOpenings[0].selfClosing) {
            if (tags.some(tag => tag.name !== 'tool_calls' && (tag.start < invokeOpenings[0].start || tag.start >= closing.start))) return null;
            return normalized.substring(invokeOpenings[0].start, closing.start);
        }
    }
    return null;
}

function parseDsmlToolCall(text) {
    if (String(text || '').length > MAX_TOOL_MARKUP_CHARS) return null;
    const normalized = normalizeToolMarkupTags(text);
    const scope = extractToolCallScope(normalized);
    if (scope === null) return null;
    const tags = scanDsmlStructuralTags(scope);
    if (!tags || tags.length === 0) return null;
    const first = tags[0];
    if (scope.substring(0, first.start).trim()) return null;

    if (first.name === 'invoke' && !first.closing && !first.selfClosing) {
        const invokeTags = tags.filter(tag => tag.name === 'invoke');
        if (invokeTags.length !== 2 || invokeTags[0] !== first || invokeTags[1].closing !== true) return null;
        const closing = invokeTags[1];
        if (scope.substring(closing.end).trim()) return null;
        if (tags.some(tag => (tag.name === 'tool_calls' || tag.name === 'direct'))) return null;
        const parsed = parseDsmlInvoke(getMarkupAttribute(first.attrs, 'name'), scope.substring(first.end, closing.start));
        if (parsed) {
            console.log(`[parseToolCall] SUCCESS dsml: ${parsed.name} (args=${parsed.arguments.length} chars)`);
            return parsed;
        }
    }

    if (first.name === 'direct' && !first.closing && !first.selfClosing) {
        if (tags.some((tag, index) => index > 0 && (tag.name === 'direct' || tag.name === 'invoke' || tag.name === 'tool_calls'))) return null;
        const parsed = parseDsmlInvoke(getMarkupAttribute(first.attrs, 'name'), scope.substring(first.end));
        if (parsed) {
            console.log(`[parseToolCall] SUCCESS dsml-direct: ${parsed.name} (args=${parsed.arguments.length} chars)`);
            return parsed;
        }
    }
    return null;
}

function looksLikeToolCallMarkup(text) {
    const value = String(text || '');
    // Oversized content is never executable markup (parseToolCall refuses it
    // above MAX_TOOL_MARKUP_CHARS): don't flag it, and especially don't burn
    // a healthy chat with a 502 on content that was merely large (10c).
    if (value.length > MAX_TOOL_MARKUP_CHARS) return false;
    if (/TOOL_CALL:\s*[\w-]+|<\s*tool_call\b|[|｜]+\s*DSML\s*[|｜]+|[<＜]\s*\/?\s*(?:DSML)?(?:[\w.-]+:)?(?:tool[\s_-]*calls|function[\s_-]*calls|invoke)\b|["'](?:tool_call|tool_calls|function_call)["']\s*:/i.test(value)) return true;
    // Operator-configured extra sentinels: literal substring match only.
    for (const tag of TOOL_EXTRA_STARTS) if (tag && value.includes(tag)) return true;
    // End tags need configured starts to mean anything (no pairing possible
    // otherwise), but once starts exist an end tag alone is a truncation-tail
    // signal worth retrying on — see the paired-region rule in
    // parseCustomTagToolCall for the stricter extraction side.
    if (TOOL_EXTRA_STARTS.length > 0) {
        for (const tag of TOOL_EXTRA_ENDS) if (tag && value.includes(tag)) return true;
    }
    return false;
}

function parseCustomTagToolCall(text) {
    if (TOOL_EXTRA_STARTS.length === 0) return null;
    const MAX_CUSTOM_TAG_REGIONS = 4;
    const MAX_CUSTOM_TAG_REGION_CHARS = 2048;
    let attempts = 0;
    let from = 0;
    while (attempts < MAX_CUSTOM_TAG_REGIONS) {
        let startTag = '';
        let startIdx = -1;
        for (const tag of TOOL_EXTRA_STARTS) {
            if (!tag) continue;
            const i = text.indexOf(tag, from);
            if (i !== -1 && (startIdx === -1 || i < startIdx)) { startIdx = i; startTag = tag; }
        }
        if (startIdx === -1) return null;
        let endIdx = -1;
        for (const tag of TOOL_EXTRA_ENDS) {
            if (!tag) continue;
            const i = text.indexOf(tag, startIdx + startTag.length);
            if (i !== -1 && (endIdx === -1 || i < endIdx)) endIdx = i;
        }
        const regionEnd = endIdx === -1
            ? Math.min(text.length, startIdx + startTag.length + MAX_CUSTOM_TAG_REGION_CHARS)
            : endIdx;
        const inner = text.substring(startIdx + startTag.length, regionEnd).trim();
        // Bare objects only inside a PAIRED region (end tag found): a lone
        // start mention plus unrelated later JSON must not become a tool call.
        // Unpaired regions still try strict explicit envelopes.
        const tc = parseJsonToolCandidate(inner, 'custom', { allowBare: endIdx !== -1 })
            || (endIdx !== -1 ? firstCustomJsonCandidate(inner) : null);
        if (tc) return tc;
        attempts++;
        from = startIdx + 1;
    }
    return null;
}
function firstCustomJsonCandidate(inner) {
    for (const rawJson of extractBalancedJsonObjects(inner)) {
        const tc = parseJsonToolCandidate(rawJson, 'custom', { allowBare: true });
        if (tc) return tc;
    }
    return null;
}

function parseToolCall(text, options = {}) {
    if (!text || typeof text !== 'string') return null;
    if (text.length > MAX_TOOL_MARKUP_CHARS) {
        console.log(`[parseToolCall] Refusing oversized tool markup candidate (${text.length} chars)`);
        return null;
    }
    const allowBare = Boolean(options.allowBare);

    if (/[|｜]+\s*DSML\s*[|｜]+|[<＜]\s*\/?\s*(?:DSML)?(?:[\w.-]+:)?(?:tool[\s_-]*calls|function[\s_-]*calls|invoke)\b/i.test(text)) {
        const dsml = parseDsmlToolCall(text);
        if (dsml) return dsml;
        console.log('[parseToolCall] Tool markup found but wrapper/invoke was incomplete or malformed');
        return null;
    }

    // XML-ish wrappers used by some agent prompts.
    const xmlMatch = text.match(/<tool_call[^>]*>([\s\S]*?)<\/tool_call>/i);
    if (xmlMatch) {
        const inner = xmlMatch[1].trim();
        const tc = parseJsonToolCandidate(inner, 'xml', { allowBare: true });
        if (tc) return tc;
    }

    // Fenced JSON blocks.
    const fenceRe = /```(?:json)?\s*([\s\S]*?)```/gi;
    let fence;
    while ((fence = fenceRe.exec(text)) !== null) {
        const tc = parseJsonToolCandidate(fence[1].trim(), 'fenced', { allowBare });
        if (tc) return tc;
    }

    // Legacy TOOL_CALL: name + first balanced JSON object after it.
    const match = text.match(/TOOL_CALL:\s*([\w-]+)\s*/i);
    if (match) {
        const name = match[1];
        const afterMatch = text.substring(match.index + match[0].length);
        const braceIdx = afterMatch.indexOf('{');
        if (braceIdx !== -1) {
            const rawJson = extractBalancedJsonAt(afterMatch, braceIdx);
            if (rawJson) {
                try {
                    const args = JSON.parse(rawJson);
                    const tc = buildToolCall(name, args);
                    if (tc) {
                        console.log(`[parseToolCall] SUCCESS legacy: ${name} (args=${rawJson.length} chars)`);
                        return tc;
                    }
                } catch (e) {
                    console.log(`[parseToolCall] legacy JSON.parse failed: ${e.message.substring(0,100)}`);
                }
            } else {
                console.log(`[parseToolCall] TOOL_CALL:${name} found but JSON braces are unbalanced`);
            }
        } else {
            console.log(`[parseToolCall] TOOL_CALL:${name} found but no { after it`);
        }
    }

    // Operator-configured custom wrappers (DEEPSEEK_TOOL_TAGS), lowest
    // precedence: only runs when XML/fenced/legacy found nothing, so explicit
    // operator tags can never shadow a built-in parse. Misses fall through to
    // the inline scan below.
    const customTc = parseCustomTagToolCall(text);
    if (customTc) return customTc;

    // Scan each top-level balanced object once (linear time). Only explicit
    // tool-call envelopes are executable; bare {name, arguments} examples are not.
    for (const rawJson of extractBalancedJsonObjects(text)) {
        const tc = parseJsonToolCandidate(rawJson, 'inline', { allowBare });
        if (tc) return tc;
    }

    console.log(`[parseToolCall] No tool call match in ${text.length} chars`);
    return null;
}

function toolCallDedupKey(tc) {
    if (!tc) return '';
    let argsObj;
    try {
        argsObj = typeof tc.arguments === 'string' ? JSON.parse(tc.arguments) : tc.arguments;
    } catch (e) {
        argsObj = tc.arguments;
    }
    const canonicalJson = (obj) => {
        if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
        if (Array.isArray(obj)) return '[' + obj.map(canonicalJson).join(',') + ']';
        const keys = Object.keys(obj).sort();
        return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}';
    };
    return (tc.name || '') + ':' + canonicalJson(argsObj);
}

function extractBalancedJsonSpans(text, maxObjects = MAX_TOOL_JSON_CANDIDATES) {
    const spans = [];
    let start = -1;
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (start === -1) {
            if (ch === '{') {
                start = i;
                depth = 1;
                inString = false;
                escape = false;
            }
            continue;
        }
        if (escape) { escape = false; continue; }
        if (ch === '\\' && inString) { escape = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (ch === '{') depth++;
        if (ch === '}') {
            depth--;
            if (depth === 0) {
                spans.push({ start, end: i + 1, text: text.substring(start, i + 1) });
                if (spans.length >= maxObjects) return spans;
                start = -1;
            }
        }
    }
    return spans;
}

function parseToolCalls(text, options = {}) {
    if (!text || typeof text !== 'string') return null;
    if (text.length > MAX_TOOL_MARKUP_CHARS) {
        console.log(`[parseToolCalls] Refusing oversized tool markup candidate (${text.length} chars)`);
        return null;
    }

    const allowedToolNames = options.allowedToolNames;
    const isNameAllowed = (name) => {
        if (!allowedToolNames) return true;
        if (allowedToolNames instanceof Set) return allowedToolNames.has(name);
        if (Array.isArray(allowedToolNames)) return allowedToolNames.includes(name);
        return true;
    };

    let rawCalls = null;

    // Primary split: newline-delimited envelopes
    const lines = text.trim().split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (lines.length > 0) {
        let allValid = true;
        const candidateCalls = [];
        for (const line of lines) {
            const tc = parseToolCall(line, options);
            if (!tc || !isNameAllowed(tc.name)) {
                allValid = false;
                break;
            }
            candidateCalls.push(tc);
        }
        if (allValid && candidateCalls.length > 0) {
            rawCalls = candidateCalls;
        }
    }

    // Fallback: scan top-level balanced JSON objects
    if (!rawCalls) {
        const spans = extractBalancedJsonSpans(text, MAX_TOOL_JSON_CANDIDATES);
        if (spans.length > 0) {
            let clean = text.substring(0, spans[0].start).trim() === '';
            for (let i = 0; clean && i < spans.length - 1; i++) {
                if (text.substring(spans[i].end, spans[i + 1].start).trim() !== '') {
                    clean = false;
                }
            }
            if (clean && text.substring(spans[spans.length - 1].end).trim() !== '') {
                clean = false;
            }

            if (clean) {
                const candidateCalls = [];
                let allParsed = true;
                for (const span of spans) {
                    const tc = parseJsonToolCandidate(span.text, 'inline', options);
                    if (!tc || !isNameAllowed(tc.name)) {
                        allParsed = false;
                        break;
                    }
                    candidateCalls.push(tc);
                }
                if (allParsed && candidateCalls.length > 0) {
                    rawCalls = candidateCalls;
                }
            }
        }
    }

    if (!rawCalls || rawCalls.length === 0) return null;

    // Deduplicate exact duplicates (same name + canonical arguments)
    const seen = new Set();
    const deduped = [];
    for (const tc of rawCalls) {
        const key = toolCallDedupKey(tc);
        if (!seen.has(key)) {
            seen.add(key);
            deduped.push(tc);
        }
    }

    // Cap at MAX_TOOL_CALLS_PER_TURN (8)
    const capped = deduped.slice(0, MAX_TOOL_CALLS_PER_TURN);

    // Ensure unique IDs
    const now = Date.now();
    for (let i = 0; i < capped.length; i++) {
        if (!capped[i].id) {
            capped[i].id = 'call_' + now + '_' + Math.random().toString(36).substring(2, 8) + '_' + i;
        }
    }

    return capped;
}

function hasLeftoverToolEnvelopes(text) {
    if (!text || typeof text !== 'string') return false;
    const rawMulti = parseToolCalls(text);
    if (rawMulti && rawMulti.length > 1) return true;

    const lines = text.trim().split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (lines.length > 1) {
        let markupCount = 0;
        for (const line of lines) {
            if (looksLikeToolCallMarkup(line) || parseToolCall(line)) {
                markupCount++;
                if (markupCount > 1) return true;
            }
        }
    }

    const spans = extractBalancedJsonSpans(text, 10);
    if (spans.length > 1) {
        let markupCount = 0;
        for (const span of spans) {
            if (looksLikeToolCallMarkup(span.text) || parseToolCall(span.text)) {
                markupCount++;
                if (markupCount > 1) return true;
            }
        }
    }

    return false;
}

/**
 * Strip surrogate characters and other problematic Unicode from text
 * to prevent httpx/urlencode crashes when the gateway sends to Telegram.
 * Removes only UNPAIRED surrogates — valid pairs (emoji, CJK-ext) survive.
 */
function sanitizeContent(text) {
    return String(text || '').replace(/([\ud800-\udbff])(?![\udc00-\udfff])|(?<![\ud800-\udbff])([\udc00-\udfff])/g, '');
}

function estimateTokens(text) {
    return text ? Math.ceil(String(text).length / 4) : 0;
}

function buildUsage(prompt, content, reasoningContent = '') {
    const promptTokens = estimateTokens(prompt);
    const contentTokens = estimateTokens(content);
    const reasoningTokens = estimateTokens(reasoningContent);
    const completionTokens = contentTokens + reasoningTokens;
    return {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
        completion_tokens_details: {
            reasoning_tokens: reasoningTokens
        }
    };
}

function buildToolCallResponse(toolCall, model = 'deepseek-default', prompt = '', reasoningContent = '') {
    const calls = Array.isArray(toolCall) ? toolCall : [toolCall];
    const now = Date.now();
    const tool_calls = calls.map((tc, idx) => ({
        id: tc.id || ('call_' + now + '_' + Math.random().toString(36).substring(2, 8) + (calls.length > 1 ? `_${idx}` : '')),
        type: 'function',
        function: { name: tc.name, arguments: tc.arguments }
    }));
    const message = {
        role: 'assistant',
        content: null,
        tool_calls
    };
    if (reasoningContent) message.reasoning_content = redactEmbeddedDataUrls(reasoningContent);
    // Attach reasoning to tool-call turns (same redaction as text turns) so
    // clients with first-class reasoning parts (opencode TUI thinking toggle)
    // can display thinking before the tool executes. Reasoning travels as its
    // own delta chunks ahead of the tool_calls chunk — never as final text —
    // so tool-loop clients keep looping. OpenAI mode only: the Anthropic and
    // Responses shims suppress reasoning on tool-call turns by design
    // (see docs/api-documentation.md).
    return {
        id: 'ds-' + now,
        object: 'chat.completion',
        created: Math.floor(now / 1000),
        model,
        choices: [{
            index: 0,
            message,
            finish_reason: 'tool_calls'
        }],
        usage: buildUsage(prompt, '', reasoningContent),
        watermark: FORGETMEAI_WATERMARK
    };
}

function buildTextResponse(content, prompt, model = 'deepseek-default', reasoningContent = '', finishReason = null) {
    const message = { role: 'assistant', content };
    // H2 egress: reasoning redacted (no-op in practice — intake-clean context
    // means the model never saw a raw payload; log hygiene if one ever flows).
    // Model prose `content` is deliberately left raw: redacting it could corrupt
    // legitimate output, and the model cannot echo a payload it was never shown.
    if (reasoningContent) message.reasoning_content = redactEmbeddedDataUrls(reasoningContent);
    return {
        id: 'ds-' + Date.now(),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{
            index: 0,
            message,
            // Surface truncation: a 'length' finish lets length-aware clients re-request
            // instead of silently treating a cut-off answer as a clean stop.
            finish_reason: finishReason === 'length' ? 'length' : 'stop'
        }],
        usage: buildUsage(prompt, content, reasoningContent),
        watermark: FORGETMEAI_WATERMARK
    };
}

// M2 policy (documented, not a security boundary): embedded text redaction
// requires header + comma + payload >= 64 chars to avoid false positives on
// prose mentions (`data:text/plain,hello`, `?x=data:foo`). Consequence:
// sub-64 text blobs pass, and chunked exfil (N x <64 data URLs across turns)
// is NOT stopped by this floor — accepted tradeoff. Note the deliberate
// divergence: image/file parts (`redactImageRef`) redact ANY data: ref with no
// floor, since a typed image slot carrying a data URL is never prose.
const EMBEDDED_DATA_URL_MIN_LENGTH = 64;

function redactImageRef(ref) {
    if (typeof ref !== 'string') return 'image';
    if (!/^\s*data:/i.test(ref)) return ref;
    const trimmed = ref.trim();
    const commaIdx = trimmed.indexOf(',');
    let header = 'data:';
    if (commaIdx > 0 && commaIdx <= 128) {
        const candidate = trimmed.slice(0, commaIdx);
        if (/^data:[a-z0-9\/\-\+\.]+(?:;[a-z0-9\-\+\.=]+)*$/i.test(candidate)) header = candidate;
    }
    if (!/;base64/i.test(header)) header += ';base64';
    return `${header},<omitted> (data omitted)`;
}

function redactEmbeddedDataUrls(text) {
    if (typeof text !== 'string') return text;
    // Deny-by-default: no left-boundary allowlist. Any `data:...;base64,<payload>`
    // match redacts regardless of prefix (`=`, `:`, `/`, `,`, `;`, `>`, `-`, `_`,
    // `)`, `]`, `}`, whitespace, or alnum like `a-data:`/`mydata:`). The `;base64`
    // + comma + 64-char floor still guard short mentions (`?x=data:foo`,
    // `data:text/plain,hello`) so existing false-positive tests stay green.
    // Whitespace/escape-tolerant (C4): payload chunks may be separated by
    // backslash escapes (`\n`, `\r`, `\t`, `\\`) or whitespace runs (literal
    // newlines, spaces from pretty-print/part splits). Each continuation chunk
    // must be >= 8 base64 chars so trailing prose (` b`, ` after`) is preserved.
    // Length is checked on the stripped payload (separators removed).
    // base64url (§5): payload classes also accept `-`/`_` (RFC 4648 §5) —
    // Buffer.from(s,'base64') decodes that alphabet upstream, so excluding it
    // let the match stop at the first `-` and the remainder slide under the
    // floor. Accepted side effect: the continuation matcher now also swallows
    // `-`/`_` prose tokens >= 8 chars after a real header — benign (only
    // fires post-header), pinned by regression test.
    const once = text.replace(/(data:[A-Za-z0-9\/\-\+\.]*(?:;[A-Za-z0-9\-\+\.=]+)*;base64),([A-Za-z0-9+/\-_=]+(?:(?:\\[nrt\\]|[\s\\]+)[A-Za-z0-9+/\-_=]{8,})*)/gi,
        (match, header, rawPayload) => {
            const stripped = rawPayload.replace(/\\[nrt\\]|[\s\\]/g, '');
            if (header.length + 1 + stripped.length < EMBEDDED_DATA_URL_MIN_LENGTH) return match;
            return `${header},<omitted>`;
        });
    // Second pass (§4): non-`base64` data-URLs (`data:text/plain,`,
    // `data:,`, percent-encoded bodies) that the `;base64` pass above never
    // sees. Body-only floor >= 64 on REAL chars (`%XX` collapses to 1):
    // deliberately fail-closed — 64+ triplets (even pure `%20` padding)
    // redact by design, so percent-encoded exfil cannot escape via padding.
    // Documented FP surface: long percent-encoded prose in a data: body
    // redacts too. No percent-decoding before the gate. `?x=data:…` matches
    // by design (no left-boundary allowlist); short bodies pass via the floor.
    return once.replace(/(data:(?:[A-Za-z0-9\/\-\+\.]+)?(?:;[A-Za-z0-9\-\+\.=]+)*,)([A-Za-z0-9%\-_.~!$&'()*+,;=:@\/?]{64,})/gi,
        (m, h, b) => {
            const real = b.replace(/%[0-9A-Fa-f]{2}/g, 'X').replace(/[\s\\]/g, '');
            return (real.length >= 64 ? h + '<omitted>' : m);
        });
}

// Recursively redact string leaves in tool-call arguments (C2). Preserves
// types (numbers/booleans/null untouched, arrays/objects same shape) so
// structural JSON survives except redacted payload spans. Circular-safe via
// `seen` — circular refs are left as-is and the caller's JSON.stringify
// try/catch handles them as before.
function redactStringLeavesDeep(value, seen = null) {
    if (typeof value === 'string') return redactEmbeddedDataUrls(value);
    if (!value || typeof value !== 'object') return value;
    if (!seen) seen = new WeakSet();
    if (seen.has(value)) return value;
    seen.add(value);
    if (Array.isArray(value)) return value.map((v) => redactStringLeavesDeep(v, seen));
    const out = {};
    for (const k of Object.keys(value)) out[k] = redactStringLeavesDeep(value[k], seen);
    return out;
}

// Normalize tool-call arguments at intake (C2): strings redacted directly,
// objects/arrays leaf-redacted (type-preserving). Returns the original ref
// when nothing redacts (callers use this for cheap change detection).
function redactToolArguments(args) {
    if (typeof args === 'string') return args ? redactEmbeddedDataUrls(args) : args;
    if (args && typeof args === 'object') return redactStringLeavesDeep(args);
    return args;
}

// Tool/function NAME redaction (§2): names replay verbatim upstream and into
// persisted history, so a `data:`-carrying name exfiltrates like an argument.
// Redact embedded data-URLs, collapse anything outside the inert allowlist to
// `_`, cap at 64 chars. Benign names (`read`, `bash`, `read_file`) pass
// through byte-identical.
function redactToolName(name) {
    return redactEmbeddedDataUrls(String(name || 'unknown')).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64);
}

function normalizeMessageContent(content) {
    if (content === null || content === undefined) return '';
    if (typeof content === 'string') return redactEmbeddedDataUrls(content);
    if (Array.isArray(content)) {
        // Header-carryover: when a part ends with an unterminated data-URL
        // header whose head was already redacted standalone, its continuation
        // tail in the next part is orphaned (no `data:` prefix of its own, so
        // neither the per-part nor the fused pass below can see it). Redact
        // the next part's leading base64 run as that continuation, stopping
        // at the first non-base64 char. Gated on the trailing match meeting
        // the redact floor AND the previous part actually being redacted, so
        // short header-splits still fuse below and benign text is untouched.
        const rawPartText = (part) => {
            if (typeof part === 'string') return part;
            if (part && typeof part === 'object') {
                if (typeof part.text === 'string') return part.text;
                if (typeof part.content === 'string') return part.content;
            }
            return null;
        };
        const rawTexts = content.map(rawPartText);
        const redactCarryoverTail = (text, idx) => {
            if (idx <= 0 || typeof text !== 'string' || !text) return text;
            const prev = rawTexts[idx - 1];
            if (typeof prev !== 'string' || !prev) return text;
            // Whitespace-tolerant (C3): allow trailing whitespace after prev's
            // payload run (`p1 + ' '` splits). Length gate + prev-redacted gate
            // unchanged so short header-splits still fuse below.
            const tail = prev.match(/(data:[^,\s]*;base64),([A-Za-z0-9+/\-_=]*)\s*$/i);
            if (!tail || tail[1].length + 1 + tail[2].length < EMBEDDED_DATA_URL_MIN_LENGTH) return text;
            if (redactEmbeddedDataUrls(prev) === prev) return text;
            if (/^\s*data:/i.test(text)) return text;
            // Leading-whitespace tolerant + length-gated (H1): only redact the
            // next part's leading base64 run when it is >= 20 chars, preserving
            // benign `hello world` / `a` after a complete image. Keeps leading
            // whitespace, stops at first non-base64 char.
            const lead = text.match(/^(\s*)([A-Za-z0-9+/\-_=]+)/);
            if (!lead || lead[2].length < 20) return text;
            return text.replace(/^(\s*)[A-Za-z0-9+/\-_=]+/, '$1<omitted>');
        };
        const pieces = content.map((part, idx) => {
            if (typeof part === 'string') return redactEmbeddedDataUrls(redactCarryoverTail(part, idx));
            // M3: preserve scalar content members (numbers/booleans) via
            // String() instead of silently dropping them; only null/undefined
            // (and empty results via filter(Boolean) below) vanish.
            if (part === null || part === undefined) return '';
            if (typeof part === 'number' || typeof part === 'boolean' || typeof part === 'bigint') return String(part);
            if (typeof part !== 'object') return '';
            if (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text') return redactEmbeddedDataUrls(redactCarryoverTail(part.text || '', idx));
            if (part.type === 'tool_result') return `[Tool Result ${part.tool_use_id || ''}]\n${normalizeMessageContent(part.content)}`;
            if (part.type === 'image_url') {
                const url = (part.image_url && typeof part.image_url === 'object' ? part.image_url.url : undefined) || '';
                const redacted = redactImageRef(url);
                // redactImageRef already appends "(data omitted)" for data: refs.
                // Label only genuinely-omitted (non-string) refs, never plain URLs.
                const suffix = (!/\(data omitted\)/.test(redacted) && typeof url !== 'string') ? ' (data omitted)' : '';
                return `[Image: ${redacted}${suffix}]`;
            }
            if (part.type === 'image' || part.type === 'input_image') {
                const src = part.source && typeof part.source === 'object' ? part.source : {};
                const ref = src.url || part.image_url?.url || src.media_type || part.media_type || 'image';
                const redacted = redactImageRef(ref);
                // As above, plus: an inlined base64 payload (source.data) is
                // genuinely dropped here, so keep the label for that shape.
                const droppedInlineData = src && typeof src.data === 'string' && src.data.length > 0;
                const suffix = (!/\(data omitted\)/.test(redacted) && (typeof ref !== 'string' || droppedInlineData)) ? ' (data omitted)' : '';
                return `[Image: ${redacted}${suffix}]`;
            }
            if (part.type === 'file' || part.type === 'input_file' || part.type === 'document') {
                return `[Unsupported content part: ${String(part.type)}]`;
            }
            const safe = part.text || part.content;
            if (typeof safe === 'string') return redactEmbeddedDataUrls(redactCarryoverTail(safe, idx));
            if (Array.isArray(safe)) return normalizeMessageContent(safe);
            return `[Unsupported content part: ${String(part.type || 'unknown')}]`;
        }).filter(Boolean);
        const joined = pieces.join('\n');
        // Second pass on the joined string: catches data-URL payloads split
        // across array parts. Bounded: skipped for short outputs that cannot
        // carry a redactable URL. The tolerant `once` pass above already spans
        // the "\n" join separator (whitespace-tolerant payload), so this fused
        // fallback only fires for pathological sub-8-char fragments.
        // M1: fuse from the per-part pieces with ONLY join separators omitted,
        // so intra-part content newlines survive (the old
        // `joined.replace(/\n/g,'')` flattened every newline in the whole
        // prompt on a hit).
        if (joined.length <= EMBEDDED_DATA_URL_MIN_LENGTH) return joined;
        const once = redactEmbeddedDataUrls(joined);
        if (once !== joined) return once;
        const fused = pieces.join('');
        if (fused === joined) return joined;
        // H4 sentinel-join: the old code returned the redacted separator-free
        // `fused` text, flattening every intra-part newline on a hit. Join
        // with a per-call random token instead, redact, then split back, so
        // newlines survive. The token is hex (base64-class, no regex meaning)
        // so a payload assembled from sub-8-char fragments still matches as
        // one run across it; a consumed span eats its interior tokens (correct
        // — the payload owned those separators), survivors split back to \n.
        // Collision-checked against the input (never a fixed literal). Known
        // shift: the token counts toward the 64-floor inside a matched span,
        // so a borderline split payload may redact where its single-part twin
        // would not — fail-closed, documented.
        let sentinel = null;
        for (let attempt = 0; attempt < 8; attempt++) {
            const candidate = crypto.randomBytes(8).toString('hex');
            if (!fused.includes(candidate)) { sentinel = candidate; break; }
        }
        if (!sentinel) return redactEmbeddedDataUrls(fused); // astronomically unlikely; fail closed
        const fusedSent = pieces.join(sentinel);
        const twiceSent = redactEmbeddedDataUrls(fusedSent);
        if (twiceSent === fusedSent) return joined;
        return twiceSent.split(sentinel).join('\n');
    }
    return String(content);
}

function shimStopReason(finishReason) {
    if (finishReason === 'tool_calls') return 'tool_use';
    if (finishReason === 'length') return 'max_tokens';
    return 'end_turn';
}

function normalizeAnthropicTools(tools = []) {
    return (tools || []).map(tool => ({
        type: 'function',
        function: {
            name: tool.name,
            description: tool.description || '',
            parameters: tool.input_schema || tool.parameters || { type: 'object', properties: {} }
        }
    })).filter(tool => tool.function.name);
}

function normalizeResponsesTools(tools = []) {
    return (tools || []).map(tool => {
        if (tool.type === 'function' && tool.function) return tool;
        if (tool.type === 'function' && tool.name) {
            return { type: 'function', function: { name: tool.name, description: tool.description || '', parameters: tool.parameters || { type: 'object', properties: {} } } };
        }
        return null;
    }).filter(Boolean);
}

function redactResponsesScalar(value) {
    if (typeof value === 'string') return normalizeMessageContent(value);
    if (value && typeof value === 'object') {
        try { return normalizeMessageContent(JSON.stringify(value)); } catch (e) { return ''; }
    }
    return value || '';
}

function normalizeResponsesInput(input) {
    if (typeof input === 'string') return [{ role: 'user', content: normalizeMessageContent(input) }];
    if (!Array.isArray(input)) return [];
    const messages = [];
    for (const item of input) {
        if (!item || typeof item !== 'object') continue;
        if (item.type === 'message') {
            messages.push({ role: item.role || 'user', content: normalizeMessageContent(item.content) });
        } else if (item.role) {
            messages.push({ role: item.role, content: normalizeMessageContent(item.content) });
        } else if (item.type === 'function_call') {
            // Prior assistant tool calls in Responses history used to be
            // dropped, starving the model of its own tool context (F21).
            // Map to the assistant tool_calls shape the prompt builder
            // already renders.
            let fnArgs = item.arguments;
            if (fnArgs !== null && fnArgs !== undefined && typeof fnArgs !== 'string') {
                try { fnArgs = JSON.stringify(fnArgs); } catch (e) { fnArgs = '{}'; }
            }
            if (typeof fnArgs === 'string' && fnArgs) fnArgs = redactEmbeddedDataUrls(fnArgs);
            messages.push({
                role: 'assistant',
                content: null,
                tool_calls: [{
                    id: item.call_id || item.id || ('call_' + Date.now()),
                    type: 'function',
                    function: { name: redactToolName(item.name), arguments: fnArgs || '{}' },
                }],
            });
        } else if (item.type === 'function_call_output') {
            messages.push({ role: 'tool', tool_call_id: item.call_id, content: redactResponsesScalar(item.output) });
        } else if (item.type === 'input_text') {
            messages.push({ role: 'user', content: redactResponsesScalar(item.text) });
        }
    }
    return messages;
}

function normalizeApiParams(params, apiMode) {
    if (params === null || typeof params !== 'object' || Array.isArray(params)) {
        const err = new Error('Request body must be a JSON object');
        err.status = 400;
        err.type = 'invalid_request';
        throw err;
    }
    if (params.messages !== undefined && !Array.isArray(params.messages)) {
        const err = new Error('messages must be an array');
        err.status = 400;
        err.type = 'invalid_request';
        throw err;
    }
    if (apiMode === 'anthropic') {
        const messages = [];
        if (params.system) messages.push({ role: 'system', content: normalizeMessageContent(params.system) });
        for (const msg of params.messages || []) {
            // H3: cross-protocol OpenAI-style tool_calls in Anthropic mode were
            // silently dropped (fell through to content-only normalization).
            // Map them through redacted tool_calls regardless of content shape.
            if (msg && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
                const text = Array.isArray(msg.content)
                    ? normalizeMessageContent(msg.content.filter(part => !part || part.type !== 'tool_use'))
                    : normalizeMessageContent(msg.content);
                if (text) messages.push({ role: msg.role || 'assistant', content: text });
                for (const tc of msg.tool_calls) {
                    let args = tc && tc.function ? tc.function.arguments : '{}';
                    try { args = redactToolArguments(args === undefined || args === null ? '{}' : args); } catch (e) { /* keep raw */ }
                    if (typeof args !== 'string') {
                        try { args = JSON.stringify(args); } catch (e) { args = '{}'; }
                    }
                    messages.push({ role: 'assistant', content: null, tool_calls: [{ id: tc && tc.id, type: 'function', function: { name: redactToolName(tc && tc.function && tc.function.name), arguments: args || '{}' } }] });
                }
                continue;
            }
            if (msg.role === 'assistant' && Array.isArray(msg.content)) {
                const toolUses = msg.content.filter(part => part && part.type === 'tool_use');
                const text = normalizeMessageContent(msg.content.filter(part => !part || part.type !== 'tool_use'));
                if (text) messages.push({ role: 'assistant', content: text });
                for (const tu of toolUses) {
                    messages.push({ role: 'assistant', content: null, tool_calls: [{ id: tu.id, type: 'function', function: { name: redactToolName(tu.name), arguments: redactEmbeddedDataUrls(JSON.stringify(tu.input || {})) } }] });
                }
            } else if (msg.role === 'user' && Array.isArray(msg.content) && msg.content.some(part => part && part.type === 'tool_result')) {
                for (const part of msg.content) {
                    if (part && part.type === 'tool_result') messages.push({ role: 'tool', tool_call_id: part.tool_use_id, content: normalizeMessageContent(part.content) });
                    else messages.push({ role: 'user', content: normalizeMessageContent(part) });
                }
            } else {
                messages.push({ role: msg.role || 'user', content: normalizeMessageContent(msg.content) });
            }
        }
        return {
            ...params,
            model: params.model || 'deepseek-chat',
            messages,
            tools: normalizeAnthropicTools(params.tools || []),
            stream: params.stream === true,
            user: params.metadata?.user_id || params.user,
        };
    }
    if (apiMode === 'responses') {
        const messages = normalizeResponsesInput(params.input);
        if (params.instructions) messages.unshift({ role: 'system', content: redactResponsesScalar(params.instructions) });
        return {
            ...params,
            model: params.model || 'deepseek-chat',
            messages,
            tools: normalizeResponsesTools(params.tools || []),
            stream: params.stream === true,
            user: params.user,
        };
    }
    // OpenAI (default): redact tool-call arguments at intake so stored and
    // replayed copies are clean from birth (ISSUE-3 + C2). Content paths are
    // already normalized at replay; arguments are not, so clean them here.
    // Strings redacted directly; objects/arrays leaf-redacted type-preserving.
    // M4 contract (pinned by tests): benign input returns the ORIGINAL `params`
    // ref (zero-copy fast path); a hit shallow-clones `params`/`messages`/the
    // touched `msg`+`function`, while untouched `tc` entries keep their refs.
    // Also covers legacy `msg.function_call` (same-class object/string form).
    if (Array.isArray(params.messages)) {
        let touched = false;
        const sameArgs = (a, b) => {
            if (a === b) return true;
            try { return JSON.stringify(a) === JSON.stringify(b); } catch (e) { return false; }
        };
        const messages = params.messages.map((msg) => {
            if (!msg || typeof msg !== 'object') return msg;
            let clone = null;
            if (Array.isArray(msg.tool_calls)) {
                const tool_calls = msg.tool_calls.map((tc) => {
                    const args = tc && tc.function && tc.function.arguments;
                    if (args === null || args === undefined || args === '') return tc;
                    let clean;
                    try { clean = redactToolArguments(args); } catch (e) { return tc; }
                    if (sameArgs(clean, args)) return tc;
                    return { ...tc, function: { ...tc.function, arguments: clean } };
                });
                if (tool_calls.some((tc, i) => tc !== msg.tool_calls[i])) clone = { ...msg, tool_calls };
            }
            const fc = msg.function_call;
            if (fc && typeof fc === 'object' && fc.arguments !== null && fc.arguments !== undefined && fc.arguments !== '') {
                let cleanFc;
                try { cleanFc = redactToolArguments(fc.arguments); } catch (e) { cleanFc = null; }
                if (cleanFc !== null && !sameArgs(cleanFc, fc.arguments)) {
                    clone = { ...(clone || msg), function_call: { ...fc, arguments: cleanFc } };
                }
            }
            if (!clone) return msg;
            touched = true;
            return clone;
        });
        if (touched) return { ...params, messages };
    }
    return params;
}

function safeJsonParseObject(text, fallback = {}) {
    try {
        const parsed = JSON.parse(text || '{}');
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
    } catch (e) {
        return fallback;
    }
}

function toAnthropicResponse(openaiResp) {
    const choice = openaiResp.choices[0];
    const msg = choice.message || {};
    const hasToolCalls = msg.tool_calls && msg.tool_calls.length > 0;
    const content = [];
    if (hasToolCalls) {
        for (const tc of msg.tool_calls) {
            // H2 egress: model→client tool args redacted (same helper as
            // intake). No-op when clean — and clean is the norm, since the
            // model never saw a raw payload (intake-clean context).
            // §10: branch on type BEFORE parsing (mirrors the stream finisher
            // below). Anthropic `input` must be an object: object → redacted
            // object; string parsing to an object → parsed+redacted; any other
            // shape (`"42"`, `"[1,2]"`, arrays, numbers, null) → `{}`.
            const rawArgs = tc.function && tc.function.arguments;
            let input;
            if (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)) {
                try { input = redactStringLeavesDeep(rawArgs); } catch (e) { input = {}; }
            } else if (typeof rawArgs === 'string') {
                try { input = redactStringLeavesDeep(safeJsonParseObject(redactEmbeddedDataUrls(rawArgs))); } catch (e) { input = {}; }
            } else {
                input = {};
            }
            content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
        }
    } else {
        content.push({ type: 'text', text: msg.content || '' });
    }
    const response = {
        id: 'msg_' + openaiResp.id,
        type: 'message',
        role: 'assistant',
        model: openaiResp.model,
        content,
        stop_reason: shimStopReason(choice.finish_reason),
        stop_sequence: null,
        usage: {
            input_tokens: openaiResp.usage?.prompt_tokens || 0,
            output_tokens: openaiResp.usage?.completion_tokens || 0,
        },
        watermark: FORGETMEAI_WATERMARK,
    };
    if (!hasToolCalls && msg.reasoning_content) response.reasoning_content = redactEmbeddedDataUrls(msg.reasoning_content);
    return response;
}

function startKeepAlive(res, intervalMs = 15000) {
    if (!res || res.writableEnded || res._keepAliveTimer) return;
    res._keepAliveTimer = setInterval(() => {
        if (res.writableEnded || res.destroyed) {
            clearKeepAlive(res);
            return;
        }
        try {
            if (typeof res.write === 'function') {
                res.write(': ping\n\n');
            }
        } catch (e) {
            clearKeepAlive(res);
        }
    }, intervalMs);
    if (res._keepAliveTimer && typeof res._keepAliveTimer.unref === 'function') {
        res._keepAliveTimer.unref();
    }
}

function clearKeepAlive(res) {
    if (!res || !res._keepAliveTimer) return;
    clearInterval(res._keepAliveTimer);
    res._keepAliveTimer = null;
}

function writeSse(res, event, data) {
    // Choke point for all SSE finishers (§9): a disconnected client must
    // no-op here instead of throwing ERR_STREAM_WRITE_AFTER_END / double-end
    // (or emitting async stream errors) mid-flight.
    if (!res || res.writableEnded || res.destroyed) return;
    if (event) res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function emitReasoningPhase(res, apiMode, meta = {}) {
    if (!res || res.writableEnded) return;
    // H2 egress: reasoning redacted once up front (exact for all three
    // branches below, since slicing happens after redaction).
    const reasoning = redactEmbeddedDataUrls(meta.reasoningContent || '');
    if (!reasoning) return;
    const id = meta.id || ('ds-' + Date.now());
    const created = meta.created || Math.floor(Date.now() / 1000);
    const model = meta.model || 'deepseek-default';
    if (apiMode === 'anthropic') {
        writeSse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
        writeSse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `[reasoning]\n${reasoning}\n[/reasoning]\n` } });
        writeSse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
    } else if (apiMode === 'responses') {
        const reasoningItem = { id: 'rs_' + Date.now(), type: 'reasoning', summary: [], status: 'completed' };
        writeSse(res, 'response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { ...reasoningItem, status: 'in_progress' } });
        writeSse(res, 'response.reasoning_summary_text.delta', { type: 'response.reasoning_summary_text.delta', output_index: 0, summary_index: 0, delta: reasoning });
        writeSse(res, 'response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: { ...reasoningItem, summary: [{ type: 'summary_text', text: reasoning }] } });
    } else {
        for (let i = 0; i < reasoning.length; i += 50) {
            const chunk = reasoning.substring(i, i + 50);
            res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { reasoning_content: chunk }, finish_reason: null }] })}\n\n`);
        }
    }
}

const THINK_LIVE_INTERVAL_MS = 500;
// Hold-back (C-1): never emit within this many chars of the cumulative
// frontier. A data: payload completing inside the withheld window would
// otherwise cross the wire raw (sub-floor) and redact only later.
// Equals the redactor floor; both redactor passes floor at 64 today, so if
// those floors ever diverge HOLD must cover the maximum (LOW-4).
const THINK_HOLD_BACK_CHARS = EMBEDDED_DATA_URL_MIN_LENGTH;
// Progressive live-thinking pump: emits sanitized+redacted thinking in
// throttled packets while guaranteeing (a) only strict prefixes of a
// redacted cumulative cross the wire (revision-safe) and (b) nothing
// within the hold-back window is emitted (sub-floor-safe). Finish emits
// the remainder (§finishOpenAIStream top-up).
function createThinkingPump({ intervalMs = THINK_LIVE_INTERVAL_MS, onEmit, label = '' } = {}) {
    let sent = '';
    let lastEmitTs = 0;
    let startTs = 0;
    let endTs = 0;
    // Sticky: once anything has crossed the wire, later re-bases must not
    // un-claim emission (else the legacy burst re-arms and duplicates).
    let everEmitted = false;
    return {
        push(fullThink, now) {
            if (!fullThink) return;
            if (!startTs) startTs = now;
            endTs = now;
            let clean;
            try { clean = redactEmbeddedDataUrls(sanitizeContent(fullThink)); } catch (e) { return; }
            if (!clean.startsWith(sent)) {
                // Diverged (upstream revision, or a data: payload completing
                // past the floor rewrites already-sent bytes): re-base to
                // the longest common prefix instead of holding forever. The
                // next push resumes from there; already-shown text may partially
                // re-appear corrected — bounded, and strictly better than the
                // old stall-then-full-burst-at-finish. Lengths only in logs
                // (inLen distinguishes a wiped base from a flipped cumulative).
                let lcp = 0;
                const n = Math.min(sent.length, clean.length);
                while (lcp < n && sent.charCodeAt(lcp) === clean.charCodeAt(lcp)) lcp++;
                try { console.log(`[think] Live thinking diverged, re-based${label ? ` ${label}` : ''} (in=${fullThink.length}, sent=${sent.length}, clean=${clean.length}, lcp=${lcp})`); } catch (e) { }
                sent = clean.slice(0, lcp);
                return;
            }
            const frontier = Math.max(sent.length, clean.length - THINK_HOLD_BACK_CHARS);
            if (frontier <= sent.length) return;
            if (sent && now - lastEmitTs < intervalMs) return;
            const tail = clean.slice(sent.length, frontier);
            sent = clean.slice(0, frontier);
            lastEmitTs = now;
            everEmitted = true;
            // Crash-consistency note: sent advances before res.write, so a
            // write throw loses this tail (finish tops up from the advanced
            // sent). Accepted: a throwing socket is a dead turn anyway, and
            // the alternative (emit-then-record) duplicates on retry.
            try { onEmit(tail, sent); } catch (e) { }
        },
        reset() { sent = ''; lastEmitTs = 0; startTs = 0; endTs = 0; everEmitted = false; },
        state() { return { sent, phaseMs: startTs ? endTs - startTs : 0, everEmitted, sawThinking: startTs > 0 }; },
    };
}
// MED-1: timing gate reads sawThinking (any thinking observed), NOT whether
// anything streamed — short held-back thoughts are still timed.
function shouldLogThinkPhase(thinkState) {
    return Boolean(thinkState && thinkState.sawThinking);
}
// Legacy-burst decision, extracted for unit coverage (Concern-6 re-review).
// pumpEmittedEver is sticky across re-bases: a full revision rewinds sent
// but must never re-arm the burst over already-streamed packets.
function shouldLegacyBurst(mode, pumpEmittedEver, reasoningEmitted) {
    if (reasoningEmitted) return false;
    if (mode === 'suppressed') return false;
    if (mode === 'progressive') return !pumpEmittedEver;
    return true;
}
// MED-4 gate predicate: 'progressive' | 'legacy-burst' | 'suppressed'.
// The OpenAI+tools row is the feature flip; all other rows are legacy rules.
function liveThinkingMode(apiMode, toolsOffered) {
    if (apiMode === 'openai') return 'progressive';
    return toolsOffered ? 'suppressed' : 'legacy-burst';
}

function startAnthropicStream(res, meta = {}) {
    if (!res.headersSent) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
        res.headersSent = true;
    }
    startKeepAlive(res);
    const usage = { input_tokens: meta.inputTokens || 0, output_tokens: 0 };
    writeSse(res, 'message_start', {
        type: 'message_start',
        message: {
            id: meta.id || ('msg_' + Date.now()),
            type: 'message',
            role: 'assistant',
            model: meta.model || 'deepseek-default',
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage,
        },
    });
}

function finishAnthropicStream(res, openaiResp, opts = {}) {
    clearKeepAlive(res);
    const choice = openaiResp.choices[0];
    const msg = choice.message || {};
    const message = toAnthropicResponse(openaiResp);
    if (!res.headersSent) {
        startAnthropicStream(res, { id: message.id, model: message.model, inputTokens: message.usage?.input_tokens });
    }
    const hasToolCalls = msg.tool_calls && msg.tool_calls.length > 0;
    const skipReasoning = Boolean(opts.skipReasoning || res._reasoningEmitted);
    if (hasToolCalls) {
        msg.tool_calls.forEach((tc, i) => {
            writeSse(res, 'content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: tc.id, name: tc.function.name, input: {} } });
            // H2 egress: complete args string available at finish time — exact redaction.
            // §10 convergence: the non-stream mapper coerces non-object args
            // to `{}` (Anthropic `input` must be an object), so the stream
            // emits `{}` for the same shapes instead of the raw string.
            // Client-visible change for malformed args (was `"42"`, now `{}`).
            let partial = (tc.function && tc.function.arguments) || '{}';
            if (typeof partial === 'string') {
                const redacted = redactEmbeddedDataUrls(partial);
                const parsed = safeJsonParseObject(redacted, null);
                partial = (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? redacted : '{}';
            } else if (partial && typeof partial === 'object' && !Array.isArray(partial)) {
                try { partial = JSON.stringify(redactStringLeavesDeep(partial)); } catch (e) { partial = '{}'; }
            } else {
                partial = '{}';
            }
            writeSse(res, 'content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: partial } });
            writeSse(res, 'content_block_stop', { type: 'content_block_stop', index: i });
        });
        writeSse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: message.usage });
    } else {
        if (msg.reasoning_content && !skipReasoning) {
            writeSse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
            writeSse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `[reasoning]\n${redactEmbeddedDataUrls(msg.reasoning_content)}\n[/reasoning]\n` } });
            writeSse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
        }
        const offset = (res._reasoningEmitted || msg.reasoning_content) ? 1 : 0;
        writeSse(res, 'content_block_start', { type: 'content_block_start', index: offset, content_block: { type: 'text', text: '' } });
        const text = msg.content || '';
        for (let i = 0; i < text.length; i += 80) {
            writeSse(res, 'content_block_delta', { type: 'content_block_delta', index: offset, delta: { type: 'text_delta', text: text.substring(i, i + 80) } });
        }
        writeSse(res, 'content_block_stop', { type: 'content_block_stop', index: offset });
        writeSse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: shimStopReason(choice.finish_reason), stop_sequence: null }, usage: message.usage });
    }
    writeSse(res, 'message_stop', { type: 'message_stop' });
    if (res.writableEnded || res.destroyed) return; // §9: no double-end on dead sockets
    res.end();
}

function sendAnthropicStream(res, openaiResp) {
    finishAnthropicStream(res, openaiResp);
}

function toResponsesResponse(openaiResp) {
    const choice = openaiResp.choices[0];
    const msg = choice.message || {};
    const hasToolCalls = msg.tool_calls && msg.tool_calls.length > 0;
    const truncated = choice.finish_reason === 'length';
    const output = [];
    if (!hasToolCalls && msg.reasoning_content) {
        // H2 egress: reasoning redacted (model never saw a raw payload, so
        // this is a no-op in practice; log hygiene if one ever flows).
        output.push({ id: 'rs_' + Date.now(), type: 'reasoning', summary: [{ type: 'summary_text', text: redactEmbeddedDataUrls(msg.reasoning_content) }] });
    }
    if (hasToolCalls) {
        for (const tc of msg.tool_calls) {
            // H2 egress: same redaction as intake; type-preserving (string
            // stays string, object stays object) so well-formed clients parse.
            let egressArgs = (tc.function && tc.function.arguments) || '{}';
            try { egressArgs = redactToolArguments(egressArgs); } catch (e) { /* keep raw */ }
            output.push({ type: 'function_call', id: 'fc_' + tc.id, call_id: tc.id, name: tc.function.name, arguments: egressArgs });
        }
    } else {
        output.push({ id: 'msg_' + Date.now(), type: 'message', role: 'assistant', status: truncated ? 'incomplete' : 'completed', content: [{ type: 'output_text', text: msg.content || '', annotations: [] }] });
    }
    return {
        id: openaiResp.id.replace(/^ds-/, 'resp_'),
        object: 'response',
        created_at: openaiResp.created,
        status: truncated ? 'incomplete' : 'completed',
        incomplete_details: truncated ? { reason: 'max_output_tokens' } : undefined,
        model: openaiResp.model,
        output,
        output_text: msg.content || '',
        usage: {
            input_tokens: openaiResp.usage?.prompt_tokens || 0,
            output_tokens: openaiResp.usage?.completion_tokens || 0,
            total_tokens: openaiResp.usage?.total_tokens || 0,
            output_tokens_details: { reasoning_tokens: openaiResp.usage?.completion_tokens_details?.reasoning_tokens || 0 },
        },
        watermark: FORGETMEAI_WATERMARK,
    };
}

function startResponsesStream(res, meta = {}) {
    if (!res.headersSent) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
        res.headersSent = true;
    }
    startKeepAlive(res);
    const respId = String(meta.id || ('resp_' + Date.now())).replace(/^ds-/, 'resp_');
    const created = meta.created || Math.floor(Date.now() / 1000);
    const model = meta.model || 'deepseek-default';
    const initialResponse = {
        id: respId,
        object: 'response',
        created_at: created,
        status: 'in_progress',
        model,
        output: [],
        usage: { input_tokens: meta.inputTokens || 0, output_tokens: 0, total_tokens: meta.inputTokens || 0 },
    };
    writeSse(res, 'response.created', { type: 'response.created', response: initialResponse });
    writeSse(res, 'response.in_progress', { type: 'response.in_progress', response: initialResponse });
}

function finishResponsesStream(res, openaiResp, opts = {}) {
    clearKeepAlive(res);
    const response = toResponsesResponse(openaiResp);
    if (!res.headersSent) {
        startResponsesStream(res, { id: response.id, created: response.created_at, model: response.model, inputTokens: response.usage?.input_tokens });
    }
    const choice = openaiResp.choices[0];
    const msg = choice.message || {};
    const hasToolCalls = msg.tool_calls && msg.tool_calls.length > 0;
    const skipReasoning = Boolean(opts.skipReasoning || res._reasoningEmitted);
    let outputIndex = (res._reasoningEmitted || (!hasToolCalls && msg.reasoning_content)) ? 1 : 0;
    if (!hasToolCalls && msg.reasoning_content && !skipReasoning) {
        const reasoningItem = { id: 'rs_' + Date.now(), type: 'reasoning', summary: [], status: 'completed' };
        // H2 egress: complete reasoning string — exact redaction.
        const cleanReasoning = redactEmbeddedDataUrls(msg.reasoning_content);
        writeSse(res, 'response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { ...reasoningItem, status: 'in_progress' } });
        writeSse(res, 'response.reasoning_summary_text.delta', { type: 'response.reasoning_summary_text.delta', output_index: 0, summary_index: 0, delta: cleanReasoning });
        writeSse(res, 'response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: { ...reasoningItem, summary: [{ type: 'summary_text', text: cleanReasoning }] } });
    }
    if (hasToolCalls) {
        msg.tool_calls.forEach((tc) => {
            // H2 egress: complete args available at finish time — exact redaction, type-preserving.
            let egressArgs = (tc.function && tc.function.arguments) || '{}';
            try { egressArgs = redactToolArguments(egressArgs); } catch (e) { /* keep raw */ }
            const item = { type: 'function_call', id: 'fc_' + tc.id, call_id: tc.id, name: tc.function.name, arguments: egressArgs, status: 'completed' };
            writeSse(res, 'response.output_item.added', { type: 'response.output_item.added', output_index: outputIndex, item: { ...item, arguments: '', status: 'in_progress' } });
            writeSse(res, 'response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', output_index: outputIndex, item_id: item.id, delta: item.arguments });
            writeSse(res, 'response.function_call_arguments.done', { type: 'response.function_call_arguments.done', output_index: outputIndex, item_id: item.id, arguments: item.arguments });
            writeSse(res, 'response.output_item.done', { type: 'response.output_item.done', output_index: outputIndex, item });
            outputIndex++;
        });
    } else {
        const text = msg.content || '';
        const item = { id: 'msg_' + Date.now(), type: 'message', role: 'assistant', status: response.status, content: [{ type: 'output_text', text, annotations: [] }] };
        writeSse(res, 'response.output_item.added', { type: 'response.output_item.added', output_index: outputIndex, item: { ...item, status: 'in_progress', content: [] } });
        writeSse(res, 'response.content_part.added', { type: 'response.content_part.added', output_index: outputIndex, content_index: 0, item_id: item.id, part: { type: 'output_text', text: '', annotations: [] } });
        for (let i = 0; i < text.length; i += 80) {
            writeSse(res, 'response.output_text.delta', { type: 'response.output_text.delta', output_index: outputIndex, content_index: 0, item_id: item.id, delta: text.substring(i, i + 80) });
        }
        writeSse(res, 'response.output_text.done', { type: 'response.output_text.done', output_index: outputIndex, content_index: 0, item_id: item.id, text });
        writeSse(res, 'response.content_part.done', { type: 'response.content_part.done', output_index: outputIndex, content_index: 0, item_id: item.id, part: item.content[0] });
        writeSse(res, 'response.output_item.done', { type: 'response.output_item.done', output_index: outputIndex, item });
    }
    writeSse(res, response.status === 'incomplete' ? 'response.incomplete' : 'response.completed', { type: response.status === 'incomplete' ? 'response.incomplete' : 'response.completed', response });
    if (res.writableEnded || res.destroyed) return; // §9: no double-end on dead sockets
    res.write('data: [DONE]\n\n');
    res.end();
}

function sendResponsesStream(res, openaiResp) {
    finishResponsesStream(res, openaiResp);
}

function startOpenAIStream(res, meta = {}) {
    if (!res.headersSent) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
        res.headersSent = true;
    }
    startKeepAlive(res);
    const id = meta.id || ('ds-' + Date.now());
    const created = meta.created || Math.floor(Date.now() / 1000);
    const model = meta.model || 'deepseek-default';
    res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })}\n\n`);
}

function finishOpenAIStream(res, openaiResp, opts = {}) {
    clearKeepAlive(res);
    if (!res.headersSent) {
        startOpenAIStream(res, openaiResp);
    }
    const choice = openaiResp.choices[0];
    const msg = choice.message || {};
    const id = openaiResp.id;
    const created = openaiResp.created;
    const model = openaiResp.model;
    const hasToolCalls = msg.tool_calls && msg.tool_calls.length > 0;
    const skipReasoning = Boolean(opts.skipReasoning || res._reasoningEmitted);
    if (msg.reasoning_content && !skipReasoning) {
        // H2 egress exact: redact the whole reasoning string first, then slice
        // (a payload straddling a 50-char boundary would otherwise leak).
        // Runs for text AND tool-call turns: reasoning chunks always precede
        // the tool_calls/content chunks so thinking displays before execution.
        const cleanReasoning = redactEmbeddedDataUrls(msg.reasoning_content);
        let tail = cleanReasoning;
        const liveSent = typeof res._reasoningLiveSent === 'string' ? res._reasoningLiveSent : '';
        if (liveSent) {
            if (cleanReasoning.startsWith(liveSent)) tail = cleanReasoning.slice(liveSent.length);
            else try { console.log(`[think] Live-sent thinking prefix diverged at finish (sent=${liveSent.length}, clean=${cleanReasoning.length}); emitting full reasoning (possible duplicate)`); } catch (e) { }
        }
        for (let i = 0; i < tail.length; i += 50) {
            const chunk = tail.substring(i, i + 50);
            res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { reasoning_content: chunk }, finish_reason: null }] })}\n\n`);
        }
    }
    if (hasToolCalls) {
        // H2 egress: complete args available at finish time — exact redaction.
        const streamingToolCalls = msg.tool_calls.map((tc, idx) => {
            let fn = tc.function;
            if (fn && fn.arguments !== null && fn.arguments !== undefined) {
                try {
                    const clean = redactToolArguments(fn.arguments);
                    if (clean !== fn.arguments) fn = { ...fn, arguments: clean };
                } catch (e) { /* keep raw */ }
            }
            return {
                index: typeof tc.index === 'number' ? tc.index : idx,
                id: tc.id,
                type: tc.type || 'function',
                function: fn,
            };
        });
        res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { content: null, tool_calls: streamingToolCalls }, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
    } else {
        for (let i = 0; i < (msg.content || '').length; i += 50) {
            const chunk = msg.content.substring(i, i + 50);
            res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }] })}\n\n`);
        }
        const finishReason = choice.finish_reason || 'stop';
        res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: finishReason }] })}\n\n`);
    }
    // Usage egress: emit a terminal usage chunk by default so OpenAI-compatible
    // clients that never set stream_options (e.g. opencode, whose TUI context
    // widget stays at 0% when it records zero tokens) still learn per-turn
    // token counts. Suppressed only on explicit opt-out (literal boolean
    // false under stream_options; other falsy shapes still emit), plumbed via
    // opts.includeUsage.
    // Deviation from strict OpenAI spec (default omit) is intentional
    // client-compat behavior. Display-only: same chars/4 estimates as the
    // non-stream path, no upstream behavior change.
    // Must precede [DONE] — SSE parsers stop there and ignore the rest.
    if (opts.includeUsage !== false && openaiResp.usage && !res.writableEnded && !res.destroyed) {
        res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [], usage: openaiResp.usage })}\n\n`);
    }
    if (!res.writableEnded && !res.destroyed) res.write('data: [DONE]\n\n');
    if (res.writableEnded || res.destroyed) return; // §9: no double-end on dead sockets
    res.end();
}

function sendOpenAIStream(res, openaiResp) {
    finishOpenAIStream(res, openaiResp);
}

// Upstream DeepSeek error strings arrive in Russian. Map the known ones to English
// before they reach clients; unknown text passes through untouched. Detection
// regexes (isContextTooLongError) intentionally keep matching the original
// languages — translation happens only at the client boundary.
const UPSTREAM_ERROR_TRANSLATIONS = [
    [/Слишком частые сообщения[\s,.]*Повторите попытку позже\.?/gi, 'Too many requests. Please try again later.'],
    [/содержани[ея][\s\S]{0,40}слишком\s+длин[а-яё]*/gi, 'Content too long.'],
    [/контекст[\s\S]{0,30}(?:длин[а-яё]*|лимит\w*)/gi, 'Context limit reached.'],
];
function toClientErrorMessage(message) {
    let text = String(message || '');
    if (!text) return text;
    for (const [pattern, replacement] of UPSTREAM_ERROR_TRANSLATIONS) {
        pattern.lastIndex = 0;
        text = text.replace(pattern, replacement);
    }
    return text;
}

function sendStreamError(res, apiMode, error) {
    clearKeepAlive(res);
    if (res.writableEnded) return;
    const message = toClientErrorMessage((error && error.message) || 'Upstream error');
    const type = (error && error.type) || 'api_error';
    try {
        if (apiMode === 'anthropic') {
            writeSse(res, 'error', { type: 'error', error: { type, message } });
        } else if (apiMode === 'responses') {
            writeSse(res, 'response.failed', { type: 'response.failed', response: { status: 'failed', error: { message, type } } });
        } else {
            const errPayload = {
                error: { message, type },
                choices: [{
                    index: 0,
                    delta: { content: `\n\n[Error: ${message}]` },
                    finish_reason: 'error',
                }],
            };
            res.write(`data: ${JSON.stringify(errPayload)}\n\n`);
            res.write('data: [DONE]\n\n');
        }
    } catch (e) { /* client gone / socket closed */ }
    try { res.end(); } catch (e) { }
}

// Strip the per-turn shell reminder before persisting: it is re-attached at
// every send, so storing it only bloats history and the recovery prefix.
function stripShellReminder(promptText, reminder) {
    const text = String(promptText || '');
    const tail = String(reminder || '');
    if (tail && text.endsWith(tail)) {
        return text.substring(0, text.length - tail.length).replace(/\n+$/, '');
    }
    return text;
}

function storeHistory(agentId, prompt, content, toolCall) {
    const session = getOrCreateAgentSession(agentId);
    let assistantResponse = content;
    if (toolCall) {
        // Store the strict-JSON envelope the model must generate — never the
        // legacy TOOL_CALL: form, which the tool block FORBIDs and which
        // would otherwise replay banned few-shot pressure into fresh chats.
        const calls = Array.isArray(toolCall) ? toolCall : [toolCall];
        const envelopes = [];
        for (const tc of calls) {
            try {
                let args = typeof tc.arguments === 'string'
                    ? JSON.parse(tc.arguments)
                    : (tc.arguments && typeof tc.arguments === 'object' ? tc.arguments : {});
                // Defense-in-depth (C2): intake is already clean, but pre-existing
                // stored sessions + object paths replay here — leaf-redact (no-op
                // when clean) so envelopes never persist a data-URL payload.
                try { args = redactStringLeavesDeep(args); } catch (e) { /* keep raw */ }
                envelopes.push(JSON.stringify({ tool_call: { name: redactToolName(tc.name), arguments: args } }));
            } catch (e) {
                envelopes.push(`Assistant called ${redactToolName(tc.name)}`);
            }
        }
        assistantResponse = envelopes.join('\n');
    }
    // Save last 500 chars of the prompt for history context
    const shortPrompt = prompt.length > 500 ? '...' + prompt.substring(prompt.length - 500) : prompt;
    session.history.push({ user: shortPrompt, assistant: assistantResponse });
    while (session.history.length > MAX_HISTORY_LENGTH) session.history.shift();
    let historyChars = session.history.reduce((sum, e) => sum + e.user.length + e.assistant.length, 0);
    while (historyChars > MAX_HISTORY_CHARS && session.history.length > 1) {
        const removed = session.history.shift();
        historyChars -= removed.user.length + removed.assistant.length;
    }
    persistSessions();
}

// Media-path containment (C3): absolute image paths mentioned in turns are
// an authenticated-only existence oracle (existsSync hits get echoed into
// responses). Confine honoring to a server-side media root — default
// `<repo>/media`, overridable via `DEEPSEEK_MEDIA_ROOT` — and reject `..`
// segments plus symlink escapes. Paths outside the root are never probed
// (no existsSync) and never echoed. User/assistant prose keeps its
// fail-closed existsSync gate, now confined to the root.
function getMediaRoot() {
    return path.resolve(process.env.DEEPSEEK_MEDIA_ROOT || path.join(__dirname, 'media'));
}
function isMediaPathAllowed(filePath, root) {
    if (typeof filePath !== 'string' || !filePath.startsWith('/')) return false;
    if (filePath.split('/').includes('..')) return false;
    const base = root === undefined ? getMediaRoot() : root;
    const resolved = path.resolve(filePath);
    if (resolved !== base && !resolved.startsWith(base + path.sep)) return false;
    try {
        const real = fs.realpathSync(resolved);
        if (real !== base && !real.startsWith(base + path.sep)) return false;
    } catch (e) {
        return false; // missing/unresolvable: not honored either way
    }
    return true;
}

// Extract MEDIA: paths from tool results that contain screenshot paths
function extractScreenshotPaths(messages) {
    const paths = [];
    const fs = require('fs');
    for (const msg of messages) {
        if (msg.role === 'tool' && msg.content) {
            // Look for screenshot_path or path fields in JSON tool results
            // These come DIRECTLY from browser_vision — always the real path.
            // Non-string content (e.g. Responses API object output) is skipped:
            // .match on it would throw a TypeError and 500 the turn.
            const text = typeof msg.content === 'string' ? msg.content : '';
            const pngMatch = text.match(/["'](screenshot_path|path)["']\s*:\s*["']([^"']+\.(?:png|jpg|jpeg|webp|gif))["']/i);
            if (pngMatch) {
                const filePath = pngMatch[2];
                if (isMediaPathAllowed(filePath) && fs.existsSync(filePath)) {
                    paths.push(`MEDIA:${filePath}`);
                }
            }
            // Also catch plain MEDIA: tags
            const mediaMatch = text.match(/MEDIA:(\S+)/g);
            if (mediaMatch) {
                for (const tag of mediaMatch) {
                    const extractedPath = tag.replace(/^MEDIA:/, '');
                    if (isMediaPathAllowed(extractedPath) && fs.existsSync(extractedPath) && !paths.includes(tag)) {
                        paths.push(tag);
                    }
                }
            }
        }
        // Check user/assistant messages for paths mentioned in conversation text
        // Only include if the file ACTUALLY EXISTS (DeepSeek hallucinates paths)
        if ((msg.role === 'user' || msg.role === 'assistant') && msg.content) {
            // Flatten array-content parts too (F23): OpenAI array messages
            // (e.g. text parts alongside images) used to be skipped outright.
            // The existsSync gate below keeps this fail-safe — remote URLs and
            // hallucinations still never match.
            const content = normalizeMessageContent(msg.content);
            const pathRegex = /(\/[^\s<>"']+\.(?:png|jpg|jpeg|webp|gif))/gi;
            let match;
            while ((match = pathRegex.exec(content)) !== null) {
                const filePath = match[1];
                if (isMediaPathAllowed(filePath) && fs.existsSync(filePath) && !paths.includes(`MEDIA:${filePath}`)) {
                    paths.push(`MEDIA:${filePath}`);
                }
            }
        }
    }
    return paths;
}

const PROMPT_COMPACTION_MARKER = '\n\n[Earlier context compacted by FreeDeepseekAPI]\n\n';

function truncatePromptMiddle(text, maxChars, headRatio = 0.35) {
    const value = String(text || '');
    if (value.length <= maxChars) return value;
    if (maxChars <= 0) return '';
    if (maxChars <= PROMPT_COMPACTION_MARKER.length) return value.substring(value.length - maxChars);
    const payloadChars = maxChars - PROMPT_COMPACTION_MARKER.length;
    const headChars = Math.max(0, Math.min(payloadChars, Math.floor(payloadChars * headRatio)));
    const tailChars = payloadChars - headChars;
    return value.substring(0, headChars) + PROMPT_COMPACTION_MARKER + value.substring(value.length - tailChars);
}

function hasExplicitConversationHistory(messages) {
    const turns = (messages || []).filter(msg => msg && msg.role !== 'system');
    return turns.length > 1 || turns.some(msg => msg.role === 'assistant' || msg.role === 'tool');
}

function buildRecoveryHistoryPrefix(history) {
    if (!Array.isArray(history) || history.length === 0) return '';
    const scrubMedia = (text) => String(text || '').replace(/MEDIA:(\S+)/g, (m, p) => {
        // Re-validate at resurrection time: injected screenshot paths may
        // have been moved/deleted since the turn ran. Drop dead references
        // instead of inviting the model to cite missing files. Confined to
        // MEDIA_ROOT like intake (C3 mirror): outside paths are dropped
        // without probing. Data-URL redaction (§3) applies on both sides
        // below, so stored payloads cannot resurrect into fresh prompts.
        try { return (isMediaPathAllowed(p) && fs.existsSync(p)) ? m : ''; } catch (e) { return ''; }
    });
    let prefix = '[Previous conversation]\n';
    for (const exchange of history) {
        prefix += `User: ${redactEmbeddedDataUrls(scrubMedia(exchange?.user))}\nAssistant: ${redactEmbeddedDataUrls(scrubMedia(exchange?.assistant))}\n\n`;
    }
    return prefix + '[Continue from here]\n\n';
}

function buildBoundedPrompt(systemPrompt, historyPrefix, conversationPrompt, maxChars = MAX_UPSTREAM_PROMPT_CHARS) {
    const system = String(systemPrompt || '').trim();
    const history = String(historyPrefix || '');
    const conversation = String(conversationPrompt || '').trim();
    const original = system ? `${system}\n\n${history}${conversation}` : `${history}${conversation}`;
    const safeMax = Math.max(1, Math.floor(Number(maxChars) || MAX_UPSTREAM_PROMPT_CHARS));
    if (original.length <= safeMax) {
        return { prompt: original, compacted: false, historyDropped: false, originalChars: original.length, promptChars: original.length };
    }

    // Server-side history is only a recovery hint. Drop it before truncating
    // client-provided messages, which may already contain the same turns.
    const historyDropped = history.length > 0;
    const currentConversation = conversation;
    const separatorLength = system && currentConversation ? 2 : 0;
    let systemBudget = system ? Math.floor((safeMax - separatorLength) * 0.5) : 0;
    let conversationBudget = Math.max(0, safeMax - separatorLength - systemBudget);

    // Give unused capacity from a short side to the other side.
    if (system.length < systemBudget) {
        systemBudget = system.length;
        conversationBudget = Math.max(0, safeMax - separatorLength - systemBudget);
    } else if (currentConversation.length < conversationBudget) {
        conversationBudget = currentConversation.length;
        systemBudget = Math.max(0, safeMax - separatorLength - conversationBudget);
    }

    // Preserve the start of the task/system instructions and the most recent
    // tool loop. The injected tool adapter lives at the end of systemPrompt.
    const boundedSystem = truncatePromptMiddle(system, systemBudget, 0.35);
    const boundedConversation = truncatePromptMiddle(currentConversation, conversationBudget, 0.25);
    let bounded = boundedSystem && boundedConversation
        ? `${boundedSystem}\n\n${boundedConversation}`
        : (boundedSystem || boundedConversation);
    if (bounded.length > safeMax) bounded = bounded.substring(0, safeMax);
    return {
        prompt: bounded,
        compacted: true,
        historyDropped,
        originalChars: original.length,
        promptChars: bounded.length,
    };
}

function buildRetryPrompt(systemPrompt, historyPrefix, conversationPrompt, currentPrompt, maxChars) {
    const retryBuild = buildBoundedPrompt(systemPrompt, historyPrefix, conversationPrompt, maxChars);
    const current = String(currentPrompt || '');
    return {
        ...retryBuild,
        compacted: retryBuild.compacted || retryBuild.prompt.length < current.length,
        originalChars: retryBuild.originalChars,
        promptChars: retryBuild.prompt.length,
        previousPromptChars: current.length,
    };
}

function appendPromptInstruction(promptText, instruction, maxChars = MAX_UPSTREAM_PROMPT_CHARS) {
    const suffix = `\n\n${String(instruction || '').trim()}`;
    const baseBudget = Math.max(0, maxChars - suffix.length);
    return truncatePromptMiddle(promptText, baseBudget, 0.35) + suffix;
}

function isContinuationRecoverySafe(previousAccountId, continuationCall) {
    const nextAccountId = continuationCall?.account?.id;
    return !previousAccountId
        || !nextAccountId
        || nextAccountId === previousAccountId
        || continuationCall?.freshSessionReset === true;
}

function restoreContinuationSnapshot(session, snapshot) {
    if (!session || !snapshot) return;
    session.id = snapshot.id;
    session.parentMessageId = snapshot.parentMessageId;
    session.accountId = snapshot.accountId;
    session.messageCount = snapshot.messageCount;
    persistSessions();
}

function isContextTooLongError(error) {
    const message = typeof error === 'string'
        ? error
        : `${error?.content || ''} ${error?.message || ''} ${error?.finish_reason || ''} ${error?.type || ''}`;
    return /(?:content|prompt|context).{0,40}(?:too\s+long|too\s+large|length|limit|maximum)|maximum.{0,30}(?:context|token)|too\s+many\s+tokens|содержани[ея]\s+слишком\s+длин|контекст.{0,30}(?:длин|лимит)|内容.{0,12}(?:过长|太长)|上下文.{0,12}(?:过长|超出)/i.test(message);
}

// Rate-limit signal (implementor-brief-ratelimit-migration-2026-09-15 §2).
// True when ANY holds: numeric/HTTP status === 429; upstream throttling text
// (RU `Слишком частые сообщения`, EN `too many requests` / `rate limit`
// variants, plus finish_reason/type shapes). Case-insensitive, deliberately
// narrow: context-length and auth errors must NOT match (isContextTooLongError
// is consulted as an exclusion first).
function isRateLimitError(error) {
    if (error == null) return false;
    if (typeof error === 'number') return error === 429;
    const status = Number(error?.status ?? error?.code);
    if (status === 429) return true;
    if (isContextTooLongError(error)) return false;
    const text = typeof error === 'string'
        ? error
        : `${error?.content || ''} ${error?.message || ''} ${error?.finish_reason || ''} ${error?.type || ''}`;
    if (!text || !text.trim()) return false;
    return /(?:too\s+many\s+requests|rate[\s_-]*limit(?:ed|ing)?|rate[\s_-]*exceed|request[\s_-]*limit|too\s+frequent|slow\s*down|try\s+again\s+later\s+during\s+peak|Слишком\s+частые\s+сообщения|请求过于频繁|请求频率|频率限制)/i.test(text);
}

// Per-turn rate-limit migration decision (brief §3, pure except for the
// selectFreshAccount pick among other-ready accounts — never keyed globally,
// so per-fingerprint distribution is preserved). Returns { migrateTo } or
// { failFast, reason }.
function resolveRateLimitMigration(session, accountList, alreadyMigrated = false) {
    if (alreadyMigrated) return { failFast: true, reason: 'already-migrated' };
    const now = Date.now();
    const list = Array.isArray(accountList) ? accountList : accounts;
    const others = list.filter(a => a
        && a.id !== (session ? session.accountId : undefined)
        && isAccountReady(a, now));
    if (others.length === 0) return { failFast: true, reason: 'no-ready-account' };
    // Smart routing (brief §2): score-min over the ready peers via the same
    // scorer — never selectFreshAccount, which would re-impose
    // preferred-monopoly. Single-peer shortcut stays.
    if (others.length === 1) {
        logDebug(`migrate acct:${session ? session.accountId : 'none'} -> acct:${others[0].id} mode=single (no scoring)`);
        return { migrateTo: others[0].id };
    }
    const pick = pickLowestScoredAccount(others, now);
    const hosted = countActiveHosted(pick.winner.id, pick.nowMs);
    logScoredPick('migrate', pick.winner, hosted, pick, scoreBreakdown(pick.winner, hosted, pick.nowMs), others.length);
    return { migrateTo: pick.winner.id };
}

// SSE-embedded throttling cooling (brief §4): a 429-equivalent via the
// existing markAccountFailure semantics (upstream retry-after when present,
// else the default cooldown). Returns false (no state touched) when the
// signal is not a rate-limit error.
function coolAccountForRateLimit(account, modelError, retryAfterRaw = null, reason = 'sse throttling') {
    if (!account) return false;
    if (!isRateLimitError(modelError)) return false;
    markAccountFailure(account, 429, reason, retryAfterRaw);
    return true;
}

// Cross-account move (brief §3 step 4): compacted context comes from
// session.history via buildRecoveryHistoryPrefix (verbatim, no LLM call);
// the sticky accountId is cleared to the other ready account and
// resetRemoteSession drops chat-scoped state (id/delta/messageCount) while
// the repair guard survives (same client turn). The caller lets the normal
// mint path create the new chat seeded with full tools + summary.
function performRateLimitMigration(session, targetAccountId) {
    const oldChatId = session ? session.id : null;
    const oldAccountId = session ? session.accountId : null;
    const historyPrefix = buildRecoveryHistoryPrefix(session ? session.history : []);
    resetRemoteSession(session);
    session.accountId = targetAccountId;
    persistSessions();
    return { oldChatId, oldAccountId, newAccountId: targetAccountId, historyPrefix };
}

function normalizeRetryResponse(result) {
    return {
        content: result?.content ? sanitizeContent(result.content) : '',
        reasoningContent: result?.reasoningContent ? sanitizeContent(result.reasoningContent) : '',
        finishReason: result?.finishReason ?? null,
        modelError: result?.modelError || null,
    };
}

function classifyRecoveryFailure(modelError, timedOut = false) {
    if (isContextTooLongError(modelError)) return { status: 400, type: 'context_length_exceeded' };
    if (timedOut) return { status: 504, type: 'request_timeout' };
    // Upstream SSE error types are arbitrary strings; integrators key on
    // ours. Pass through only safe-charset values, else fall back — never
    // leak control characters or unbounded text into the client taxonomy.
    const rawType = modelError?.type;
    const safeType = (typeof rawType === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(rawType))
        ? rawType
        : 'empty_response';
    return { status: 502, type: safeType };
}

function isTimeoutError(error) {
    const name = String(error?.name || '');
    const message = String(error?.message || '');
    return name === 'TimeoutError' || name === 'AbortError' || /(?:timed?\s*out|timeout)/i.test(message);
}

// Network-layer failures that are neither timeouts nor account faults:
// DNS, reset, refused. Shares the timeout consecutive-failure budget so a dead
// path backs off; excludes PoW solve failures and parse/programming errors
// (no network cause, wrong message shape).
function isNetworkError(error) {
    if (!error || isTimeoutError(error)) return false;
    const code = error?.cause?.code;
    if (typeof code === 'string' && /^(ENOTFOUND|ECONNRESET|EPIPE|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH)$/i.test(code)) return true;
    const message = String(error?.message || '');
    if (/fetch failed/i.test(message) && error?.name === 'TypeError') return true;
    return false;
}

function shouldResetOnEmptyRetry(contextTooLong, retryAttempt) {
    // Under no-new-chats invariant (implementor-brief-no-new-chats-2026-09-15),
    // retries are always in-place; no new chats ever.
    return false;
}

function resolveEmptyExhaustion({ session, modelError, timedOut, retryAttempt }) {
    const failureClass = classifyRecoveryFailure(modelError, timedOut);
    const errorMessage = toClientErrorMessage(modelError?.content)
        || (timedOut
            ? 'DeepSeek request deadline reached while recovering an empty response'
            : `DeepSeek returned empty content after ${retryAttempt} retr${retryAttempt === 1 ? 'y' : 'ies'}`);
    return {
        preserve: true,
        status: failureClass.status,
        type: 'tool_call_failed',
        message: errorMessage,
        failedSessionId: session ? session.id : null,
        failedMessageCount: session ? session.messageCount : 0,
        accountId: session ? session.accountId : null,
    };
}

function resolveRepairExhaustion({ session, retryAttempt = 0, message = 'DeepSeek returned malformed tool-call markup after in-chat repair attempts' } = {}) {
    return {
        preserve: true,
        status: 502,
        type: 'tool_call_failed',
        message,
        failedSessionId: session ? session.id : null,
        failedMessageCount: session ? session.messageCount : 0,
        accountId: session ? session.accountId : null,
        retryAttempts: retryAttempt,
    };
}

function buildRepairPrompt(fullPrompt) {
    return appendPromptInstruction(
        fullPrompt,
        '[STRICT INSTRUCTION — DeepSeek Web backend] Your previous response had incomplete/invalid tool markup (bare shell, fences, mixed prose+JSON, or truncated envelope). Output ONLY one strict JSON object on a single line, no fences, no explanation: {"tool_call":{"name":"<one of allowed tools>","arguments":{...}}}. If no tool is needed, output plain text with no JSON at all.'
    );
}

function shouldAutoContinue(finishReason, contentLength, rounds, maxRounds = 2) {
    return finishReason !== 'stop' && (finishReason === 'length' || finishReason === 'INCOMPLETE' || contentLength > 25000) && rounds < maxRounds;
}

function formatMessages(messages, tools) {
    let systemPrompt = '';
    for (const msg of messages) {
        if (msg.role === 'system' && msg.content) {
            systemPrompt += normalizeMessageContent(msg.content) + '\n';
        }
    }
    systemPrompt += formatToolDefinitions(tools);

    // Build full conversation history for DeepSeek's context
    let conversation = '';
    for (const msg of messages) {
        if (msg.role === 'system') continue;  // already in systemPrompt
        if (msg.role === 'user' && msg.content) {
            conversation += `User: ${normalizeMessageContent(msg.content)}\n\n`;
        } else if (msg.role === 'assistant') {
            if (msg.tool_calls && msg.tool_calls.length > 0) {
                // This was a tool call response from a previous turn. Render
                // the strict-JSON envelope the model must generate — never
                // the legacy TOOL_CALL: form, which the tool block FORBIDs
                // and which would otherwise replay banned few-shot pressure
                // into every full-prompt turn (F20; cf. R5-C2 in history).
                for (const tc of msg.tool_calls) {
                    let tcArgs = tc && tc.function ? tc.function.arguments : {};
                    if (typeof tcArgs === 'string') {
                        try { tcArgs = JSON.parse(tcArgs); } catch (e) { /* keep raw string */ }
                    }
                    if (tcArgs === null || tcArgs === undefined) tcArgs = {};
                    // Defense-in-depth (C2): intake redaction is primary, but
                    // object-form / pre-existing stored args replay here verbatim
                    // without this. Leaf-redact is a no-op when already clean.
                    if (typeof tcArgs === 'string') tcArgs = redactEmbeddedDataUrls(tcArgs);
                    else { try { tcArgs = redactStringLeavesDeep(tcArgs); } catch (e) { /* keep raw */ } }
                    let envelope;
                    try {
                        envelope = JSON.stringify({ tool_call: { name: redactToolName(tc && tc.function && tc.function.name), arguments: tcArgs } });
                    } catch (e) {
                        envelope = `Assistant called ${redactToolName(tc && tc.function && tc.function.name)}`;
                    }
                    conversation += `Assistant: ${envelope}\n\n`;
                }
            } else if (msg.content) {
                conversation += `Assistant: ${normalizeMessageContent(msg.content)}\n\n`;
            }
        } else if (msg.role === 'tool' && msg.content) {
            // Tool execution result — send back to DeepSeek as context
            const toolContent = normalizeMessageContent(msg.content);
            // Do not impose a second, per-result 8k limit: one large tool result
            // may be the essential input. buildBoundedPrompt applies the single
            // global request cap while preserving the latest conversation tail.
            conversation += `[Tool Result]\n${toolContent}\n\n`;
        }
    }
    // The last user message + full conversation context
    return { prompt: conversation.trim(), systemPrompt: systemPrompt.trim() };
}

// Status visibility (C2b/M1): private fields (accounts, agents, session
// reuse, ready counts) are shown only to callers presenting the configured
// proxy key, or when the operator opts in via DEEPSEEK_PUBLIC_STATUS=1.
// Anonymous probes get minimal liveness ({status,service,watermark} on
// /health, {ready} on /readyz) with unchanged 200/503 LB semantics.
// NOTE: this intentionally differs from the reviewer's literal one-liner
// (`isProxyAuthorized(...)` alone), which is a no-op: with no key configured
// isProxyAuthorized() returns true for everyone, so the `!PROXY_API_KEY` arm
// it drops never mattered. The predicate below is what actually closes the
// keyless off-loopback leak.
function isStatusVisible(authorization, key) {
    if (isTruthy(process.env.DEEPSEEK_PUBLIC_STATUS)) return true;
    const k = key === undefined ? getProxyKey() : key;
    return Boolean(k) && isProxyAuthorized(authorization, k);
}
function buildHealthPayload(authorization, key) {
    const health = { status: 'ok', service: 'FreeDeepseekAPI', watermark: FORGETMEAI_WATERMARK };
    if (isStatusVisible(authorization, key)) Object.assign(health, {
        models: SUPPORTED_MODEL_IDS,
        unsupported_models: Object.keys(MODEL_CONFIGS).filter(id => !MODEL_CONFIGS[id].supported),
        agents: sessions.size,
        in_flight: inFlight,
        accounts: accounts.map(accountStatus),
        config_ready: hasAuthConfig(),
        discovered_models: discoveredModels.types.length > 0 ? discoveredModels : undefined,
        session_reuse: { strategy: 'sticky per x-agent-session/user', ttl_minutes: Math.round(SESSION_TTL_MS / 60000), max_messages: MAX_MESSAGE_DEPTH, reset_all: 'POST /reset-session?agent=all' },
    });
    return health;
}
function buildReadyzPayload(authorization, ready, total, key) {
    if (!isStatusVisible(authorization, key)) return { ready: ready > 0 };
    return { ready: ready > 0, ready_accounts: ready, total_accounts: total };
}

// === HTTP Server ===
const server = http.createServer(async (req, res) => {
    const requestOrigin = req.headers.origin;
    res.setHeader('Vary', 'Origin');
    if (!isBrowserOriginAllowed(requestOrigin)) {
        console.log(`[DS-API] 403 blocked browser origin ${requestOrigin} from ${req.socket.remoteAddress}`);
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Browser origin is not allowed', type: 'cors_error' } }));
        return;
    }
    if (requestOrigin) res.setHeader('Access-Control-Allow-Origin', normalizeOrigin(requestOrigin));
    setCorsResponseHeaders(res);
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const isPublicProbe = req.method === 'GET' && (url.pathname === '/' || url.pathname === '/health' || url.pathname === '/readyz');
    if (!isPublicProbe && !isProxyAuthorized(req.headers.authorization)) {
        console.log(`[DS-API] 401 unauthorized ${req.method} ${url.pathname} from ${req.socket.remoteAddress}`);
        res.writeHead(401, {
            'Content-Type': 'application/json',
            'WWW-Authenticate': 'Bearer',
        });
        res.end(JSON.stringify({ error: { message: 'Invalid or missing proxy API key', type: 'authentication_error' } }));
        return;
    }

    // Health check
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(buildHealthPayload(req.headers.authorization)));
        return;
    }

    // Readiness probe (distinct from the liveness check above): 503 unless at least
    // one account can serve right now, so an aggregator/LB won't route to a cold pool.
    if (req.method === 'GET' && url.pathname === '/readyz') {
        const now = Date.now();
        const ready = accounts.filter(a => isAccountReady(a, now)).length;
        res.writeHead(ready > 0 ? 200 : 503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(buildReadyzPayload(req.headers.authorization, ready, accounts.length)));
        return;
    }

    // Models: OpenAI-compatible list exposes only aliases verified to work through this proxy.
    if (req.method === 'GET' && url.pathname === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: SUPPORTED_MODEL_IDS.map(id => ({ id, object: 'model', created: 1700000000, owned_by: 'deepseek-web', real_model: MODEL_CONFIGS[id].real_model, capabilities: MODEL_CONFIGS[id].capabilities })) }));
        return;
    }

    // Full mapping, including Web models observed but not currently usable through the direct API.
    if (req.method === 'GET' && (url.pathname === '/v1/model-capabilities' || url.pathname === '/api/model-capabilities')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ object: 'model_capabilities', watermark: FORGETMEAI_WATERMARK, data: ALL_MODEL_CAPABILITIES }));
        return;
    }

    // Sessions status
    if (req.method === 'GET' && url.pathname === '/v1/sessions') {
        const agentList = [];
        for (const [agentId, session] of sessions) {
            agentList.push({
                agent: agentId,
                session_id: session.id,
                message_count: session.messageCount,
                delta_forwarded: session.deltaMsgCount || 0,
                account: session.accountId,
                history_size: session.history.length,
                age_min: session.createdAt ? Math.round((Date.now() - session.createdAt) / 60000) : null,
            });
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ agents: agentList, total: agentList.length }));
        return;
    }

    // Reset session for a specific agent (or all if no agent specified)
    if (req.method === 'POST' && url.pathname === '/reset-session') {
        const agentId = url.searchParams.get('agent') || 'default';
        if (agentId === 'all') {
            const count = sessions.size;
            sessions.clear();
            persistSessions();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'all_sessions_cleared', count }));
            return;
        }
        const session = sessions.get(agentId);
        if (!session) {
            console.log(`[DS-API] 404 reset-miss: no session for agent ${agentId}`);
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `No session for agent: ${agentId}` }));
            return;
        }
        const historyCount = session.history.length;
        const historyPreview = session.history.map(e => e.user.substring(0, 40)).join(' | ');
        session.id = null;
        session.parentMessageId = null;
        session.createdAt = null;
        session.messageCount = 0;
        // Manual reset means fresh turn state: drop delta continuity AND the
        // repeat-repair guard (R4-C1). A post-reset verbatim retry must not
        // fail-fast on a previous turn's budget. History + sticky account stay.
        session.deltaMsgCount = 0;
        session.deltaBoundary = null;
        session.deltaPrefixHash = null;
        session.deltaToolNames = null;
        session.repairHash = null;
        session.repairAt = 0;
        session.repairCount = 0;
        persistSessions();
        console.log(`[DS-API] session_reset agent=${agentId} history_preserved=${historyCount}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'session_reset', agent: agentId, history_preserved: historyCount, history: historyPreview }));
        return;
    }

    const apiMode = url.pathname === '/v1/messages'
        ? 'anthropic'
        : (url.pathname === '/v1/responses' ? 'responses' : 'openai');
    const acceptedPostPaths = ['/v1/chat/completions', '/v1/messages', '/v1/responses'];
    if (req.method !== 'POST' || !acceptedPostPaths.includes(url.pathname)) {
        console.log(`[DS-API] 404 ${req.method} ${url.pathname} from ${req.socket.remoteAddress}`);
        res.writeHead(404); res.end('Not found'); return;
    }

    // Backpressure: reject rather than fan out unbounded concurrent upstream work.
    // Shared 503 writer for both gates (arrival here + body-end re-check): one
    // status/headers/payload shape by design. Defined before first use (const).
    const replyBackpressure = () => {
        res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '2' });
        res.end(JSON.stringify({ error: { message: `Server busy (${inFlight}/${MAX_CONCURRENT} requests in flight). Retry shortly.`, type: 'overloaded' } }));
    };
    if (checkBackpressure()) {
        console.log(`[DS-API] 503 backpressure: ${inFlight}/${MAX_CONCURRENT} in flight, rejecting ${req.socket.remoteAddress}`);
        replyBackpressure();
        return;
    }

    let body = '';
    let reqBytes = 0;
    let bodySettled = false;
    let responded = false;
    // Release this request's in-flight body charge exactly once. Node fires
    // BOTH `end` and `close` on normal completion — the flag keeps the global
    // counter from drifting negative (which would disable the cap).
    const settleBody = () => {
        if (bodySettled) return;
        bodySettled = true;
        inflightBodyBytes -= reqBytes;
        if (inflightBodyBytes < 0) inflightBodyBytes = 0;
    };
    // Cap replies (§6): single `responded` flag guards every reply site (not
    // res.headersSent alone — racy vs `close` ordering). res.end FIRST, then
    // req.destroy() ONLY in the end callback (callback form — a sync destroy
    // can truncate the flush). One parameterized writer keeps the 413 and the
    // global-budget 503 byte-identical over refactors; only status/headers/
    // log line/payload differ per call site.
    const replyCap = (status, headers, logMsg, errType, errMsg) => {
        if (responded) return;
        responded = true;
        console.log(logMsg);
        try {
            res.writeHead(status, headers);
            res.end(JSON.stringify({ error: { message: errMsg, type: errType } }),
                () => { try { req.destroy(); } catch (e) { /* already gone */ } });
        } catch (e) {
            try { req.destroy(); } catch (_) { /* already gone */ }
        }
    };
    const replyBodyTooLarge = () => replyCap(413, { 'Content-Type': 'application/json' },
        `[DS-API] 413 body too large (${reqBytes} bytes) from ${req.socket.remoteAddress}`,
        'payload_too_large', 'Request body too large');
    const replyInflightBodyCap = () => replyCap(503, { 'Content-Type': 'application/json', 'Retry-After': '2' },
        `[DS-API] 503 global in-flight body cap (${inflightBodyBytes}/${MAX_INFLIGHT_BODY_BYTES} bytes) — rejecting ${req.socket.remoteAddress}`,
        'overloaded', 'Server busy (global upload budget exceeded). Retry shortly.');
    req.on('data', chunk => {
        if (responded) return; // stop accumulating after a cap reply
        const len = Buffer.byteLength(chunk);
        reqBytes += len;
        inflightBodyBytes += len;
        // Both the per-request 10MB (413) and the global 64MB (503-ish)
        // checks live in this one handler, both routed through `responded`.
        if (reqBytes > MAX_BODY_BYTES) { replyBodyTooLarge(); return; }
        if (inflightBodyBytes > MAX_INFLIGHT_BODY_BYTES) { replyInflightBodyCap(); return; }
        body += chunk;
    });
    req.on('error', (err) => {
        // Without this listener an 'error' event throws and takes the process
        // down; the `close` handler below still releases the byte charge.
        console.log(`[DS-API] request stream error from ${req.socket.remoteAddress}: ${(err && err.message) || err}`);
    });
    req.on('close', () => { settleBody(); });
    req.on('end', async () => {
        settleBody();
        if (responded) return; // a cap reply already went out; never touch inFlight
        // Re-check the gate inside `end` (§7 preferred): the arrival gate
        // raced the async body, so burst trickled POSTs would otherwise all
        // slip through. No arrival reservation (that would let slowloris
        // sockets hold MAX_CONCURRENT forever with no error/abort decrement).
        if (checkBackpressure()) {
            console.log(`[DS-API] 503 backpressure at body-end: ${inFlight}/${MAX_CONCURRENT} in flight, rejecting ${req.socket.remoteAddress}`);
            replyBackpressure();
            return;
        }
        inFlight++;
        let inFlightCounted = true;
        let clientGone = false;
        res.on('close', () => { clientGone = true; clearKeepAlive(res); });
        const requestStartedAt = Date.now();
        const deadlineHit = () => Date.now() - requestStartedAt > REQUEST_DEADLINE_MS;
        let activeSession = null;
        let activeAgentId = null;
        try {
            // Malformed bodies are a client fault, not a server fault: answer
            // 400 so integrators fix the payload instead of retry-storming a
            // 500 that can never succeed (F13).
            let rawParams;
            try {
                rawParams = JSON.parse(body || '{}');
            } catch (e) {
                console.log(`[DS-API] 400 malformed JSON body from ${req.socket.remoteAddress}`);
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'Request body is not valid JSON', type: 'invalid_request' } }));
                return;
            }
            const params = normalizeApiParams(rawParams, apiMode);
            const messages = params.messages || [];
            const tools = params.tools || [];
            const allowedToolNames = new Set(tools
                .filter(tool => (tool?.type === 'function' && tool.function?.name) || tool?.name)
                .map(tool => tool.function?.name || tool.name));
            const stream = params.stream === true;
            const requestedModel = String(params.model || 'deepseek-chat').toLowerCase();
            if (!isKnownModel(requestedModel)) {
                console.log(`[DS-API] 400 unknown model ${requestedModel}`);
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: `Unknown model: ${requestedModel}`, type: 'invalid_model', supported_models: SUPPORTED_MODEL_IDS, model_capabilities_url: '/v1/model-capabilities' } }));
                return;
            }
            if (!isSupportedModel(requestedModel)) {
                const cfg = resolveModelConfig(requestedModel);
                console.log(`[DS-API] 400 unsupported model ${requestedModel}`);
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: `${requestedModel} is not currently supported through this DeepSeek Web API path`, type: 'unsupported_model', model: requestedModel, real_model: cfg.real_model, reason: cfg.unavailable_reason, capabilities: cfg.capabilities, supported_models: SUPPORTED_MODEL_IDS } }));
                return;
            }
            // An empty turn has no prompt to send: fail fast before minting a
            // session, burning PoW solves, and hitting the empty-retry loop
            // with a 0-char prompt (F12). Placed after model validation so
            // unknown-model errors keep their specific type.
            if (!Array.isArray(messages) || messages.length === 0) {
                console.log(`[DS-API] 400 empty messages from ${req.socket.remoteAddress}`);
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'No messages provided', type: 'invalid_request' } }));
                return;
            }
            // Session identity (§1 sanitize+cap, C1 principal binding): the
            // client key is sanitized (64 chars, strict charset, else '') and
            // namespaced under the proxy-key principal; keyless deployments
            // are IP-only (header path disabled). Fallback preserves the old
            // loopback/external split.
            const remoteAddr = req.socket.remoteAddress || 'unknown';
            const requestedSession = req.headers['x-agent-session'] || params.session || params.user;
            const principal = principalForRequest(req.headers.authorization);
            const deltaMode = isDeltaPromptMode();
            let agentId = resolveAgentId({ requestedSession, remoteAddr, authorization: req.headers.authorization, principal });
            // Title Decouple: OpenCode fires an internal title summarizer request
            // at session start (agent=title, small=true, messages start with "Generate a title for this conversation:").
            // Premise adjustment & safety note: OpenCode-internal parameters (agent=title, small=true)
            // are not transmitted on the HTTP wire. Detection relies on prompt-shape matching on
            // /^\s*Generate a title for this conversation\s*:/i, which is coupled to OpenCode's internal prompt
            // template (brittle if OpenCode alters it).
            // We fulfill this locally in ~3ms without burning upstream quota, PoW, or creating phantom chats.
            // If DEEPSEEK_LOCAL_TITLE=0 is set, we bypass local generation and route all title calls to a
            // single shared upstream entry ('dev-agent:title') to decouple them from user conversation chats.
            if (isTitleGenerationRequest(messages)) {
                if (process.env.DEEPSEEK_LOCAL_TITLE !== '0') {
                    const title = generateLocalTitle(messages);
                    console.log(`[DS-API] Handled title generation locally: "${title}"`);
                    const responseObj = buildTextResponse(title, messages[0]?.content || '', requestedModel);
                    if (stream) {
                        sendOpenAIStream(res, responseObj);
                    } else {
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify(responseObj));
                    }
                    return;
                }
                agentId = (principal ? principal + ':' : '') + 'dev-agent:title';
            }

            // Delta mode: no explicit client session key (opencode sends none),
            // so derive a stable per-conversation chat id from the opener.
            // If routed to 'dev-agent:title' (DEEPSEEK_LOCAL_TITLE=0), skip per-conversation
            // fingerprinting so all title calls truly share the single 'dev-agent:title' session.
            // isSharedTitleBucket (not ===): C1 principal binding namespaces the bucket
            // as '<principal>:dev-agent:title'; a sanitized client key can
            // never contain ':' so only the title override matches this shape.
            if (deltaMode && !requestedSession && !isSharedTitleBucket(agentId) && Array.isArray(messages) && messages.length > 0) {
                const turnMessages = messages.filter(m => m && m.role !== 'system');
                const fp = fingerprintConversation(messages);
                let candidateId = `${agentId}:${fp}`;

                // Opener settling: when the conversation expands from Turn 1 (1 msg) to Turn 2 (3 msgs),
                // fingerprintConversation's opener hash shifts. Check if an active session under this
                // agent prefix matches turnMessages prefix (via deltaBoundary). If so, adopt it to
                // preserve the live remote chat and enable suffix-only delta streaming!
                // Hardening: adopt ONLY on an unambiguous single-candidate match. If multiple sessions
                // share the same boundary (identical opener collision), do not guess — fork to a fresh chat.
                if (!sessions.has(candidateId) && turnMessages.length > 1) {
                    const matchingCandidates = [];
                    for (const [existingId, existingSession] of sessions) {
                        if (!existingId.startsWith(agentId + ':')) continue;
                        if (!existingSession || !existingSession.id || !existingSession.deltaBoundary) continue;
                        const sent = Number(existingSession.deltaMsgCount) || 0;
                        if (sent > 0 && sent < turnMessages.length) {
                            if (hashMessageEnvelope(turnMessages[sent - 1]) === existingSession.deltaBoundary) {
                                matchingCandidates.push({ id: existingId, session: existingSession });
                            }
                        }
                    }
                    if (matchingCandidates.length === 1) {
                        const { id: existingId, session: existingSession } = matchingCandidates[0];
                        sessions.delete(existingId);
                        sessions.set(candidateId, existingSession);
                        console.log(`[DS-API] Adopted active session from ${existingId} -> ${candidateId} (chat ${existingSession.id}, msg#${existingSession.messageCount})`);
                        persistSessions();
                    } else if (matchingCandidates.length > 1) {
                        console.log(`[DS-API] Ambiguous opener adoption for ${candidateId} (${matchingCandidates.length} candidates match boundary); forking to fresh chat.`);
                    }
                }
                agentId = candidateId;
            }
            const agentTag = `[${agentId}]`;
            activeAgentId = agentId;

            // Session cardinality cap (§1): earliest point where the final key
            // is known (post-parse, post-fingerprint — the key needs the body).
            // New keys past MAX_SESSIONS get 429; existing keys are unaffected.
            // Covers both creation sites below (`/new` reset + getOrCreate).
            if (!sessions.has(agentId) && sessions.size >= MAX_SESSIONS) {
                console.log(`[DS-API] 429 session cap: ${sessions.size}/${MAX_SESSIONS} sessions, rejecting new key from ${req.socket.remoteAddress}`);
                res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '60' });
                res.end(JSON.stringify({ error: { message: `Too many sessions (${sessions.size}/${MAX_SESSIONS}). Retry shortly.`, type: 'session_limit' } }));
                return;
            }

            // "/new" command: if the latest user message is exactly "/new" (whitespace-insensitive),
            // reset this agent's DeepSeek session/history instead of forwarding anything to DeepSeek.
            const lastUserMessage = [...messages].reverse().find(m => m && m.role === 'user');
            const lastUserText = lastUserMessage && typeof lastUserMessage.content === 'string'
                ? lastUserMessage.content.trim()
                : '';
            if (lastUserText === '/new') {
                const existing = sessions.get(agentId);
                const historyCount = existing ? existing.history.length : 0;
                sessions.set(agentId, createSession());
                persistSessions();
                console.log(`${agentTag} /new received — session reset (history cleared: ${historyCount})`);
                const confirmation = buildTextResponse('Started a new chat. Session and history have been reset.', '/new', requestedModel);
                if (stream) {
                    if (apiMode === 'anthropic') {
                        sendAnthropicStream(res, confirmation);
                    } else if (apiMode === 'responses') {
                        sendResponsesStream(res, confirmation);
                    } else {
                        sendOpenAIStream(res, confirmation);
                    }
                } else {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    if (apiMode === 'anthropic') {
                        res.end(JSON.stringify(toAnthropicResponse(confirmation)));
                    } else if (apiMode === 'responses') {
                        res.end(JSON.stringify(toResponsesResponse(confirmation)));
                    } else {
                        res.end(JSON.stringify(confirmation));
                    }
                }
                return;
            }

            const session = getOrCreateAgentSession(agentId);
            activeSession = session;
            console.log(`[${logToken(agentId)}] -> model=${logToken(requestedModel)} stream=${stream === true} api=${apiMode} sess=${session.id ? `chat#${session.messageCount}/acct:${session.accountId || 'none'}` : 'new'}`);

            // Rollover retired per implementor-brief-no-new-chats-2026-09-15.
            const promptRollover = null;

            // Compaction (delta mode only): the client collapsed its history
            // into a summary. The live chat never saw that summary and still
            // holds the stale pre-compaction turns, so continuing there would
            // fork context — and a suffix/boundary fallback would additionally
            // drop the tool definitions. Start a fresh chat carrying the full
            // tools block plus the compaction summary instead.
            let compactionReset = null;
            if (deltaMode && detectClientCompaction(messages, session)) {
                compactionReset = resetRemoteSession(session);
                console.log(`${agentTag} Client compaction detected (old chat ${compactionReset.failedSessionId} had ${compactionReset.failedMessageCount} msgs); starting fresh chat with tools + summary.`);
            }

            // Delta mode: an established remote chat already holds the system
            // instructions, the tool definitions (sent once at creation), and
            // all previously forwarded turns — so forward only the new suffix
            // and skip the tool block. Any doubt falls back to a full resend.
            // A compaction reset above clears session.id, so this naturally
            // becomes a full-prompt + tools send to the new chat.
            let establishedChat = deltaMode && !!session.id && session.messageCount > 0;
            let promptMessages = messages;
            let deltaActive = false;
            if (establishedChat) {
                const split = splitClientMessages(messages, session);
                if (split.isDelta) {
                    promptMessages = split.effective;
                    deltaActive = true;
                }
            }
            // Tool-set drift (R1-C3): established chats omit the tool block,
            // so a mid-session tool addition would never reach the model.
            // Force one full resend to teach the new set, then resume deltas.
            // Removals stay sticky remote-side (append-only chat) by design.
            const toolNamesKey = toolNamesKeyFor(tools);
            let toolSetResend = false;
            if (deltaMode && establishedChat && session.deltaToolNames != null && session.deltaToolNames !== toolNamesKey) {
                console.log(`${agentTag} Tool set changed mid-session; sending full prompt + tools once.`);
                establishedChat = false;
                promptMessages = messages;
                deltaActive = false;
                toolSetResend = true;
            }
            if (deltaMode && session) session.deltaToolNames = toolNamesKey;
            const toolsForPrompt = (!deltaMode || !establishedChat) ? tools : [];
            const { prompt: basePrompt, systemPrompt } = formatMessages(promptMessages, toolsForPrompt);
            // The tool block (with the SHELL line) is skipped on established
            // chats — without this the model forgot fish after turn one and
            // kept emitting bash-isms. Re-attach a one-line shell reminder to
            // every tools-omitted prompt: it rides the conversation tail
            // (never truncated away) and costs ~100 chars.
            const shellReminder = (deltaMode && establishedChat && toolsForPrompt.length === 0) ? shellReminderLine() : '';
            const prompt = shellReminder ? `${basePrompt}\n\n${shellReminder}` : basePrompt;
            // For usage accounting, count the CLIENT's original input — not the
            // proxy-expanded fullPrompt (system + injected tools + history) — so
            // prompt_tokens reflects what the caller actually sent.
            const clientPromptText = messages.map(m => normalizeMessageContent(m.content)).join('\n');

            // Full variant (tools + whole conversation) for chat creation and
            // every resurrection path: a replacement chat must receive the tool
            // definitions, never a lean delta prompt (cf. tool-blind rollovers).
            let fullConversation = prompt;
            let fullSystemPrompt = systemPrompt;
            if (deltaMode && establishedChat) {
                const fullBuild = formatMessages(messages, tools);
                fullConversation = fullBuild.prompt;
                fullSystemPrompt = fullBuild.systemPrompt;
            }

            // Keep a recovery prompt available even while the upstream session
            // is healthy. If that remote chat expires mid-request, its opaque
            // state disappears and the replacement must receive local history.
            const recoveryHistoryPrefix = hasExplicitConversationHistory(messages)
                ? ''
                : buildRecoveryHistoryPrefix(session.history);
            const historyPrefix = !session.id ? recoveryHistoryPrefix : '';

            const promptBuild = buildBoundedPrompt(systemPrompt, historyPrefix, prompt);
            const freshPromptBuild = buildBoundedPrompt(fullSystemPrompt, recoveryHistoryPrefix, fullConversation);
            if (deltaMode) {
                console.log(`${agentTag} Delta prompt: ${!establishedChat ? (toolSetResend ? 'full resend (tool set changed), tools re-sent' : (compactionReset ? 'new chat after compaction, full prompt + tools + summary' : 'new chat, full prompt + tools')) : (deltaActive ? `suffix-only (${promptMessages.length} new msgs, tools sent once${shellReminder ? ' + shell reminder' : ''})` : `full resend (boundary mismatch), tools omitted${shellReminder ? ' + shell reminder' : ''}`)}`);
            }
            let fullPrompt = promptBuild.prompt;
            let promptCompacted = promptBuild.compacted;
            if (promptBuild.compacted) {
                markContextCompacted(res);
                console.log(`${agentTag} Compacted upstream prompt ${promptBuild.originalChars} -> ${promptBuild.promptChars} chars${promptBuild.historyDropped ? ' (recovery history dropped)' : ''}`);
            }

            const startTime = Date.now();
            // Per-turn rate-limit migration (implementor-brief-ratelimit-migration-2026-09-15
            // §3): at most ONE cross-account move per client turn. A local
            // boolean — never persisted, never global — so per-fingerprint
            // distribution and the turn-scoped repair guard are untouched.
            let rateLimitMigrated = false;
            // Post-migration turn resends the full-tools resurrection prompt
            // (same payload shape as the resurrection path).
            const rebuildMigrationFreshPrompt = () => buildBoundedPrompt(
                fullSystemPrompt,
                buildRecoveryHistoryPrefix(session.history),
                fullConversation
            );
            let initialCall;
            // Optional same-chat rate-limit retry (DEEPSEEK_RETRY_RATELIMIT=1,
            // default off): one bounded wait + a single in-place retry on the
            // SAME account+chat. Returns true with initialCall set on recovery;
            // false leaves everything for the fail-fast/migration path below.
            let recoveredInPlace = false;
            try {
                initialCall = await askDeepSeekStream(fullPrompt, agentId, requestedModel, freshPromptBuild.prompt);
            } catch (e) {
                // askDeepSeekStream already cooled the throttled account.
                // Order: optional in-place retry first (same account+chat),
                // then migration, then fail-fast - each stage preserves the
                // freshest error for the next.
                // All-cooling errors skip the retry entirely: lifting a cooldown
                // when NO account is ready would send one request upstream that
                // the exhausted message promises never happens. Migration below
                // then throws the proper all-cooling 429.
                const anyReadyNow = anyAccountReady(accounts);
                const remainingMs = Math.max(0, REQUEST_DEADLINE_MS - (Date.now() - requestStartedAt));
                const waitMs = retryWaitMs(e.retryAfter, remainingMs);
                if (shouldRetryInPlace({ flagOn: RETRY_RATELIMIT, rateLimit: isRateLimitError(e), migrated: rateLimitMigrated, gone: clientGone, deadline: deadlineHit(), retryAfterSec: e.retryAfter, anyReady: anyReadyNow })
                    && waitMs > 0) {
                    const retryAccount = accounts.find(a => a.id === session.accountId);
                    if (retryAccount) {
                        console.log(`${agentTag} rate-limit: one in-place retry on acct:${retryAccount.id} in ${waitMs}ms (lifting cooldown once)`);
                        await new Promise(r => setTimeout(r, waitMs));
                    }
                    if (retryAccount && !clientGone && !deadlineHit()) {
                        const attempt = await inPlaceRateLimitRetry(retryAccount, () =>
                            askDeepSeekStream(fullPrompt, agentId, requestedModel, freshPromptBuild.prompt));
                        if (attempt.recovered) {
                            initialCall = attempt.result;
                            recoveredInPlace = true;
                            console.log(`${agentTag} in-place rate-limit retry recovered the turn`);
                        } else if (attempt.error) {
                            const msg = String((attempt.error && attempt.error.message) || attempt.error || '').substring(0, 120);
                            console.log(`${agentTag} in-place retry failed (${msg}); continuing below`);
                            e = attempt.error;
                        }
                    }
                }
                // Recovered turns skip everything below (initialCall is set).
                if (!recoveredInPlace) {
                    if (!isRateLimitError(e) || rateLimitMigrated || clientGone || deadlineHit()) throw e;
                    const decision = resolveRateLimitMigration(session, accounts, rateLimitMigrated);
                    if (!decision.migrateTo) throw e;
                    const move = performRateLimitMigration(session, decision.migrateTo);
                    rateLimitMigrated = true;
                    const migrationBuild = rebuildMigrationFreshPrompt();
                    if (migrationBuild.compacted) {
                        promptCompacted = true;
                        markContextCompacted(res);
                    }
                    initialCall = await askDeepSeekStream(migrationBuild.prompt, agentId, requestedModel, migrationBuild.prompt);
                    console.log(`${agentTag} migrated ${agentId} chat ${move.oldChatId} (acct:${move.oldAccountId}) -> ${session.id} (acct:${move.newAccountId}): rate-limit`);
                }
            }
            let dsResp = initialCall.resp;
            if (initialCall.promptUsed !== fullPrompt) {
                fullPrompt = initialCall.promptUsed;
                if (freshPromptBuild.compacted) {
                    promptCompacted = true;
                    markContextCompacted(res);
                }
            }

            const streamMeta = stream ? {
                id: 'ds-' + Date.now(),
                created: Math.floor(Date.now() / 1000),
                model: requestedModel,
                inputTokens: estimateTokens(clientPromptText),
            } : null;

            if (stream && !clientGone) {
                if (apiMode === 'anthropic') {
                    startAnthropicStream(res, streamMeta);
                } else if (apiMode === 'responses') {
                    startResponsesStream(res, streamMeta);
                } else {
                    startOpenAIStream(res, streamMeta);
                }
            }

            // Cumulative reasoning finalized by prior reads this turn. Progress
            // fragments are per-read; prepending the base keeps the pump input
            // cumulative so multi-read turns (continuation/retries) preserve
            // the prefix invariant instead of rebasing every read (High).
            // Synced after each read finalizes reasoningContent below.
            let pumpBase = '';
            const thinkPump = createThinkingPump({ label: agentTag, onEmit: (tail, sentSoFar) => {
                if (!stream || clientGone || res.writableEnded || res.destroyed) return;
                // LOW-6: record per-packet so an exception between emit and the
                // pre-build backstop cannot orphan the sent prefix.
                res._reasoningLiveSent = sentSoFar;
                const id = streamMeta?.id || ('ds-' + Date.now());
                const created = streamMeta?.created || Math.floor(Date.now() / 1000);
                const model = streamMeta?.model || requestedModel;
                for (let i = 0; i < tail.length; i += 50) {
                    res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { reasoning_content: tail.substring(i, i + 50) }, finish_reason: null }] })}\n\n`);
                }
            } });
            const readOpts = {
                onReasoningDone: (reasoning) => {
                    if (!stream || clientGone || res.writableEnded) return;
                    const mode = liveThinkingMode(apiMode, allowedToolNames.size > 0);
                    if (!shouldLegacyBurst(mode, thinkPump.state().everEmitted, res._reasoningEmitted)) {
                        return; // progressive already emitted (even if rebased), suppressed mode, or burst already ran
                    }
                    res._reasoningEmitted = true;
                    const sanitized = sanitizeContent(reasoning || '');
                    emitReasoningPhase(res, apiMode, {
                        id: streamMeta?.id,
                        created: streamMeta?.created,
                        model: streamMeta?.model,
                        reasoningContent: sanitized,
                    });
                },
                onReasoningProgress: (thinkText) => {
                    // Concern-6 freeze: once the legacy burst has fired
                    // (_reasoningEmitted), the pump stays frozen — later
                    // thinking is dropped from the stream rather than
                    // duplicated over the burst prefix. Full text survives
                    // in the non-stream body. Truncation beats duplication.
                    if (liveThinkingMode(apiMode, allowedToolNames.size > 0) !== 'progressive' || res._reasoningEmitted || !stream || clientGone || res.writableEnded || res.destroyed) return;
                    // Cumulative input (High fix): fragments are per-read but the
                    // handler joins reads with '\n' (continuation append) — mirror
                    // that join here so the pump prefix tracks the final text.
                    thinkPump.push(pumpBase ? pumpBase + '\n' + thinkText : thinkText, Date.now());
                },
            };

            // Process streaming response from DeepSeek — returns { content, reasoningContent, messageId, finishReason, modelError, abandoned }
            // Deferred commit (no rewind): cursor advances only once per
            // turn, at the success point below. Failures return before the
            // commit, so the next turn re-sends the last good parent instead
            // of pinning a poisoned node. parent_message_id branches upstream.
            let pendingMessageId = null;
            async function readDeepSeekResponse(readable, opts = readOpts) {
                const resResult = await consumeDeepSeekStream(readable, {
                    onReasoningDone: opts.onReasoningDone,
                    onReasoningProgress: opts.onReasoningProgress,
                    isClientGone: () => clientGone,
                });
                if (resResult.abandoned) return resResult;

                // H1: ALWAYS track the delivering read's id (null when the
                // read carried none). A conditional assignment would leave a
                // STALE id from an earlier read in `pendingMessageId`, which
                // the single commit below would then attach to the wrong
                // content. Null-id turns commit nothing (§8 deferred commit).
                pendingMessageId = resResult.messageId || null;
                if (!pendingMessageId) {
                    console.log(`${agentTag} WARNING: could not extract message_id`);
                }

                return resResult;
            }

            let { content: fullContent, reasoningContent, finishReason, modelError, abandoned } = await readDeepSeekResponse(dsResp.body);
            if (abandoned || clientGone) return;
            fullContent = sanitizeContent(fullContent);
            reasoningContent = sanitizeContent(reasoningContent || '');
            pumpBase = reasoningContent; // cumulative base for later reads' progress (§High fix)
            const elapsed = Date.now() - startTime;
            console.log(`${agentTag} Got ${fullContent.length} chars (+${reasoningContent.length} reasoning chars) in ${elapsed}ms (msg#${session.messageCount}) acct:${initialCall.account?.id ?? 'none'} finish=${finishReason ?? 'none'}`);

            // SSE-embedded throttling (brief §3+§4): an SSE error event
            // carrying throttling text cools the degraded account (HTTP 429
            // cooling alone misses this path) and migrates the turn once with
            // compacted context + transparent retry. Already-migrated turns
            // and turns with no ready peer fail fast with 429 + Retry-After.
            if (!abandoned && !clientGone && !deadlineHit() && isRateLimitError(modelError)) {
                const throttled = accounts.find(a => a.id === session.accountId) || initialCall.account;
                coolAccountForRateLimit(throttled, modelError);
                const decision = resolveRateLimitMigration(session, accounts, rateLimitMigrated);
                if (rateLimitMigrated || !decision.migrateTo) {
                    // Shared earliest-release math (M2): quota/burst-spent peers
                    // count, not just the throttled account's cooldown.
                    const rel = earliestReleaseMs();
                    const waitSec = Number.isFinite(rel)
                        ? Math.max(1, Math.ceil((rel - Date.now()) / 1000))
                        : 2;
                    console.log(`${agentTag} rate-limit migration exhausted (${rateLimitMigrated ? 'already migrated this turn' : 'no other ready account'}); failing fast 429.`);
                    if (res.headersSent) {
                        sendStreamError(res, apiMode, { message: rateLimitExhaustedMessage(waitSec), type: 'rate_limit_error' });
                        return;
                    }
                    res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(waitSec) });
                    res.end(JSON.stringify({ error: {
                        message: rateLimitExhaustedMessage(waitSec),
                        type: 'rate_limit_error',
                        agent: agentId,
                        failed_session_id: session.id,
                        message_count: session.messageCount,
                        history_length: session.history.length,
                        account: session.accountId,
                    } }));
                    return;
                }
                const move = performRateLimitMigration(session, decision.migrateTo);
                rateLimitMigrated = true;
                const migrationBuild = rebuildMigrationFreshPrompt();
                if (migrationBuild.compacted) {
                    promptCompacted = true;
                    markContextCompacted(res);
                }
                fullPrompt = migrationBuild.prompt;
                initialCall = await askDeepSeekStream(migrationBuild.prompt, agentId, requestedModel, migrationBuild.prompt);
                console.log(`${agentTag} migrated ${agentId} chat ${move.oldChatId} (acct:${move.oldAccountId}) -> ${session.id} (acct:${move.newAccountId}): rate-limit`);
                dsResp = initialCall.resp;
                thinkPump.reset(); // BEFORE the read: new remote chat; the dead attempt's prefix must not suppress the fresh attempt
                const migratedResult = await readDeepSeekResponse(dsResp.body);
                if (migratedResult.abandoned || clientGone) return;
                const migratedState = normalizeRetryResponse(migratedResult);
                fullContent = migratedState.content;
                reasoningContent = migratedState.reasoningContent;
                pumpBase = reasoningContent; // new attempt supersedes; base tracks it
                finishReason = migratedState.finishReason;
                modelError = migratedState.modelError;
            }

            // Empty/context-overflow recovery. Each retry gets a smaller prompt
            // and a fresh remote session; bounded attempts prevent retry storms.
            let retryAttempt = 0;
            while (!fullContent || fullContent.trim().length === 0) {
                // Stop early if the client hung up or we've blown the request budget —
                // no point burning more PoW solves + account quota for a dead socket.
                if (clientGone) { console.log(`${agentTag} client disconnected; abandoning empty-retry loop`); return; }
                if (deadlineHit()) { console.log(`${agentTag} request deadline hit; stopping empty-retry loop`); break; }
                const contextTooLong = isContextTooLongError(modelError);
                if (modelError && !contextTooLong) break;
                if (retryAttempt >= MAX_EMPTY_RETRIES) break;
                retryAttempt++;

                const retryRatio = contextTooLong
                    ? Math.max(0.35, 0.8 - retryAttempt * 0.2)
                    : Math.max(0.5, 1 - retryAttempt * 0.2);
                const retryBudget = Math.max(MIN_UPSTREAM_PROMPT_CHARS, Math.floor(MAX_UPSTREAM_PROMPT_CHARS * retryRatio));
                // Empty retries stay in-place in the same remote chat (no-new-chats invariant),
                // rebuilding from the full variant with tool definitions — never a lean delta prompt.
                const retryBuild = buildRetryPrompt(fullSystemPrompt, recoveryHistoryPrefix, fullConversation, fullPrompt, retryBudget);
                const retryPrompt = retryBuild.prompt;
                if (retryBuild.compacted) {
                    promptCompacted = true;
                    markContextCompacted(res);
                }
                const reason = contextTooLong ? 'context-too-long response' : 'empty response';
                console.log(`${agentTag} ${reason} (msg#${session.messageCount}, retry ${retryAttempt}/${MAX_EMPTY_RETRIES}, prompt=${retryPrompt.length} chars). Retrying in-place in same chat...`);
                // Brief delay before retry to let DeepSeek breathe
                await new Promise(r => setTimeout(r, Math.min(500 * retryAttempt, 1500)));
                const { resp: retryResp } = await askDeepSeekStream(retryPrompt, agentId, requestedModel);
                const retryResult = await readDeepSeekResponse(retryResp.body);
                const retryState = normalizeRetryResponse(retryResult);
                fullPrompt = retryPrompt;
                modelError = retryState.modelError;
                // A previous empty response may have carried finish_reason=length.
                // Never leak it into a successful retry that supplied no reason.
                finishReason = retryState.finishReason;
                if (retryState.content && retryState.content.trim().length > 0) {
                    console.log(`${agentTag} Retry ${retryAttempt} succeeded`);
                    fullContent = retryState.content;
                    reasoningContent = retryState.reasoningContent;
                    pumpBase = reasoningContent; // retry replaces: base tracks the new attempt
                }
            }

            if (!fullContent || fullContent.trim().length === 0) {
                const timedOut = deadlineHit();
                const exhaustion = resolveEmptyExhaustion({ session, modelError, timedOut, retryAttempt });
                console.log(`${agentTag} ${exhaustion.type} after ${retryAttempt} retr${retryAttempt === 1 ? 'y' : 'ies'}. Preserving chat ${session.id}; giving up.`);
                if (res.headersSent) {
                    sendStreamError(res, apiMode, { message: exhaustion.message, type: exhaustion.type });
                    return;
                }
                res.writeHead(exhaustion.status, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    error: {
                        message: exhaustion.message,
                        type: exhaustion.type,
                        agent: agentId,
                        failed_session_id: exhaustion.failedSessionId,
                        message_count: exhaustion.failedMessageCount,
                        history_length: session.history.length,
                        account: exhaustion.accountId,
                        retry_attempts: retryAttempt,
                        upstream_prompt_chars: fullPrompt.length,
                        prompt_compacted: promptCompacted,
                        model: requestedModel,
                        real_model: resolveModelConfig(requestedModel).real_model,
                    }
                }));
                return;
            }

            // Auto-continuation: if finish_reason is 'length', 'INCOMPLETE', or content is long (>25000 chars),
            // send a continuation request to get the rest of the response.
            // Skip when finishReason === 'stop' (explicitly complete response).
            let continuationRounds = 0;
            const MAX_CONTINUATION = 2;
            while (shouldAutoContinue(finishReason, fullContent.length, continuationRounds, MAX_CONTINUATION)) {
                if (clientGone || deadlineHit()) break;
                continuationRounds++;
                console.log(`${agentTag} Response ${fullContent.length} chars (finish=${finishReason}). Auto-continuing (${continuationRounds}/${MAX_CONTINUATION})...`);
                await new Promise(r => setTimeout(r, 500));
                const contBeforeId = session.accountId;
                const contSnapshot = {
                    id: session.id,
                    parentMessageId: session.parentMessageId,
                    accountId: session.accountId,
                    messageCount: session.messageCount,
                };
                const continuationRecoveryPrompt = appendPromptInstruction(
                    `${freshPromptBuild.prompt}\n\n[Assistant response so far]\n${fullContent}`,
                    'Continue the assistant response from exactly where it stopped. Do not restart or repeat completed sections.'
                );
                const continuationCall = await askDeepSeekStream(
                    'continue',
                    agentId,
                    requestedModel,
                    continuationRecoveryPrompt
                );
                const { resp: contResp, account: contAccount } = continuationCall;
                // A cross-account continuation is valid only when the call
                // detected that reset and sent the full recovery prompt. If an
                // unexpected rotation ever bypasses that guard, restore the pre-call
                // session snapshot rather than minting or resetting (implementor-brief-no-new-chats-2026-09-15).
                if (!isContinuationRecoverySafe(contBeforeId, continuationCall)) {
                    console.log(`${agentTag} continuation rotated to ${contAccount.id} ≠ ${contBeforeId} — restoring pre-continuation snapshot`);
                    restoreContinuationSnapshot(session, contSnapshot);
                    break;
                }
                const contResult = await readDeepSeekResponse(contResp.body);
                const contContent = contResult && contResult.content ? sanitizeContent(contResult.content) : '';
                const contReasoning = contResult && contResult.reasoningContent ? sanitizeContent(contResult.reasoningContent) : '';
                if (contContent && contContent.trim().length > 0 && !contContent.includes('I am an AI')) {
                    fullContent += '\n' + contContent;
                    if (contReasoning) reasoningContent += (reasoningContent ? '\n' : '') + contReasoning;
                    pumpBase = reasoningContent; // continuation appends: base stays cumulative
                    finishReason = contResult.finishReason;
                    console.log(`${agentTag} Continuation added ${contContent.length} chars (total: ${fullContent.length})`);
                } else {
                    console.log(`${agentTag} Continuation returned nothing useful, stopping`);
                    break;
                }
            }

            let toolCall = null;
            if (allowedToolNames.size > 0) {
                const multiCalls = parseToolCalls(fullContent, { allowedToolNames });
                if (multiCalls && multiCalls.length > 0 && multiCalls.every(tc => allowedToolNames.has(tc.name))) {
                    console.log(`${agentTag} Model emitted ${multiCalls.length} valid tool call(s) in turn: ${multiCalls.map(tc => tc.name).join(', ')}`);
                    toolCall = multiCalls.length === 1 ? multiCalls[0] : multiCalls;
                } else {
                    if (hasLeftoverToolEnvelopes(fullContent)) {
                        console.log(`${agentTag} Model emitted multiple tool envelopes but some are disallowed or malformed; attempting format repair instead of silently narrowing.`);
                        toolCall = null;
                    } else {
                        toolCall = parseToolCall(fullContent);
                        if (toolCall && !allowedToolNames.has(toolCall.name)) {
                            console.log(`${agentTag} Model requested unknown tool ${toolCall.name}; attempting format repair.`);
                            toolCall = null;
                        }
                    }
                }
            }
            
            // Retry when legacy, XML, or DSML tool markup was truncated or
            // malformed. Never pass raw DSML through as a normal assistant turn.
            // All retries STAY in the live chat: the repair instruction answers
            // the malformed turn ("your previous response..."), and burning a
            // fresh chat per malformed output was the dominant source of silent
            // session churn. Only a repeatedly-broken turn is discarded (below).
            //
            // Attempt 1 and attempt 2 are both full-context strict resends in the
            // same chat (reminder-on-retry): the model is re-taught the format
            // with full tool definitions each time. Kept for turns whose
            // arguments need earlier history to ground.
            if (allowedToolNames.size > 0 && !toolCall && looksLikeToolCallMarkup(fullContent) && !clientGone && !deadlineHit()) {
                console.log(`${agentTag} Tool-call markup detected but invalid/truncated (${fullContent.length} chars). Retrying with stricter prompt...`);
                // Reminder-on-retry (implementor-brief-no-new-chats-2026-09-15):
                // Both attempt 1 and attempt 2 carry full tool definitions + full system prompt.
                const strictPrompt = buildRepairPrompt(freshPromptBuild.prompt);
                const retryChatId = session.id;
                const repairHash = repairTurnHash(messages, tools);
                const repair = classifyRepairAttempt(session, repairHash);
                if (repair.repeat) {
                    if (repair.capped) {
                        console.log(`${agentTag} Same repair already attempted twice for this turn; failing fast without another upstream call.`);
                    } else {
                        console.log(`${agentTag} Repeat repair detected — retrying with full reminder prompt (${strictPrompt.length} chars).`);
                    }
                } else {
                    console.log(`${agentTag} Strict retry (attempt 1): full reminder prompt (${strictPrompt.length} chars) into same chat.`);
                }
                if (!repair.capped) {
                    // Rate-limit spacing applies only when an upstream call
                    // follows; the capped path logs and returns with no sleep.
                    await new Promise(r => setTimeout(r, 1000));
                    recordRepairAttempt(session, repairHash);
                    const { resp: retryResp2 } = await askDeepSeekStream(strictPrompt, agentId, requestedModel, strictPrompt);
                    if (session.id !== retryChatId) {
                        console.log(`${agentTag} Strict retry landed on a new chat ${session.id} (was ${retryChatId}); full tools+context were resent.`);
                    }
                    let retryResult2 = await readDeepSeekResponse(retryResp2.body);
                    let retryContent2 = retryResult2 && retryResult2.content ? sanitizeContent(retryResult2.content) : '';
                    let retryTc = retryContent2 && retryContent2.trim()
                        ? (parseToolCall(retryContent2) || parseToolCall(retryContent2, { allowBare: true }))
                        : null;
                    let succeededAttempt = 'attempt_1';
                    // Audit gate:
                    // 1. Valid tool call: parsed and name in allowedToolNames.
                    // 2. Broken markup: either parsed with an unknown tool name, or unparseable text matching looksLikeToolCallMarkup.
                    // 3. Clean prose: no tool call candidate AND !looksLikeToolCallMarkup(retryContent2).
                    // Attempt 2 fires ONLY when retryContent2 is non-empty and broken markup. Clean prose bypasses Attempt 2.
                    const retryIsBrokenMarkup = Boolean(
                        (retryTc && !allowedToolNames.has(retryTc.name)) ||
                        (!retryTc && looksLikeToolCallMarkup(retryContent2))
                    );
                    const retryUnparseable = Boolean(retryContent2 && retryContent2.trim() && retryIsBrokenMarkup);
                    if (retryUnparseable && !repair.repeat && session.id === retryChatId && !clientGone && !deadlineHit()) {
                        console.log(`${agentTag} Strict retry: attempt 1 still malformed; escalating to attempt 2 in same chat.`);
                        const { resp: retryResp3 } = await askDeepSeekStream(strictPrompt, agentId, requestedModel, strictPrompt);
                        if (session.id !== retryChatId) {
                            console.log(`${agentTag} Strict retry landed on a new chat ${session.id} (was ${retryChatId}); full tools+context were resent.`);
                        }
                        retryResult2 = await readDeepSeekResponse(retryResp3.body);
                        retryContent2 = retryResult2 && retryResult2.content ? sanitizeContent(retryResult2.content) : '';
                        retryTc = retryContent2 && retryContent2.trim()
                            ? (parseToolCall(retryContent2) || parseToolCall(retryContent2, { allowBare: true }))
                            : null;
                        succeededAttempt = 'attempt_2';
                    }
                    if (retryContent2 && retryContent2.trim()) {
                        if (retryTc && allowedToolNames.has(retryTc.name)) {
                            console.log(`${agentTag} Retry with strict prompt succeeded: ${retryTc.name} (attempt: ${succeededAttempt})`);
                            fullContent = retryContent2;
                            reasoningContent = retryResult2.reasoningContent ? sanitizeContent(retryResult2.reasoningContent) : '';
                            pumpBase = reasoningContent; // retry replaces: base tracks the new attempt
                            toolCall = retryTc;
                            clearRepairGuard(session, repairHash);
                        } else if (!retryTc && !looksLikeToolCallMarkup(retryContent2)) {
                            console.log(`${agentTag} Retry produced clean text response (${retryContent2.length} chars). Recovered from malformed turn.`);
                            fullContent = retryContent2;
                            reasoningContent = retryResult2.reasoningContent ? sanitizeContent(retryResult2.reasoningContent) : '';
                            pumpBase = reasoningContent; // retry replaces: base tracks the new attempt
                            toolCall = null;
                            clearRepairGuard(session, repairHash);
                        } else {
                            console.log(`${agentTag} Retry still has broken tool markup: ${retryContent2.substring(0, 160)}. Returning a safe error instead of leaking it as text.`);
                            reasoningContent = retryResult2.reasoningContent ? sanitizeContent(retryResult2.reasoningContent) : reasoningContent;
                            pumpBase = reasoningContent; // retry replaces: base tracks the new attempt
                        }
                    }
                }
            }

            if (allowedToolNames.size > 0 && !toolCall && looksLikeToolCallMarkup(fullContent)) {
                const exhaustion = resolveRepairExhaustion({ session });
                console.log(`${agentTag} ${exhaustion.type}: preserving chat ${session.id} after failed repair attempts.`);
                if (clientGone) return;
                if (res.headersSent) {
                    sendStreamError(res, apiMode, { message: exhaustion.message, type: exhaustion.type });
                    return;
                }
                res.writeHead(exhaustion.status, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: {
                    message: exhaustion.message,
                    type: exhaustion.type,
                    agent: agentId,
                    failed_session_id: exhaustion.failedSessionId,
                    message_count: exhaustion.failedMessageCount,
                    history_length: session.history.length,
                    account: exhaustion.accountId,
                    prompt_compacted: promptCompacted,
                    model: requestedModel,
                    real_model: resolveModelConfig(requestedModel).real_model,
                } }));
                return;
            }

            // Single commit point for the turn: only a deliverable turn
            // advances the cursor. Poisoned/empty/rate-limited turns return
            // above, leaving parentMessageId/messageCount/delta untouched so
            // the next turn retries from the last good parent (no rewind
            // needed — we simply never advanced).
            commitTurnState(session, pendingMessageId, messages, deltaMode);

            // A successful tool call proves the turn complied; any stale guard
            // from an earlier turn must not leak into future classifications.
            // Unconditional clear is safe under concurrency: the worst case is
            // a concurrent turn's retry classifying as fresh, which only buys
            // it the default lean+full same-chat repair (never a new chat).
            if (toolCall) clearRepairGuard(session);

            // No point burning PoW + quota for a dead socket — and an
            // undelivered turn must not pollute recovery history (R2-C1).
            if (clientGone) return;
            
            // Check if any tool results in the current conversation contained a screenshot path.
            // If so, and the response doesn't already have MEDIA:, inject it so the gateway
            // delivers the file to Telegram.
            const screenshotPaths = extractScreenshotPaths(messages)
                .filter(p => !fullContent.includes(p));
            if (screenshotPaths.length > 0) {
                fullContent += '\n\n' + screenshotPaths.join('\n');
                console.log(`${agentTag} Injected MEDIA paths into response: ${screenshotPaths.join(', ')}`);
            }

            storeHistory(agentId, stripShellReminder(prompt, shellReminder), fullContent, toolCall);

            const thinkState = thinkPump.state();
            // Backstop: onEmit already records per-packet (LOW-6); this covers
            // zero-emit turns (sent stays '') and any path that skipped onEmit.
            // Authoritative writer: this must stay the LAST write to
            // res._reasoningLiveSent before the build — reset() clears pump
            // state only, so removing or reordering this line would let a
            // post-migration turn compare fresh reasoning against a dead
            // attempt's prefix (LOW-D).
            res._reasoningLiveSent = thinkState.sent;
            // MED-1: gate timing on sawThinking — a short
            // thought (< ~64 new chars) never emits (hold-back) but was still
            // thought; its phase time must still be logged.
            if (shouldLogThinkPhase(thinkState)) res._thinkPhaseMs = thinkState.phaseMs;

            const openaiResponse = toolCall
                ? buildToolCallResponse(toolCall, requestedModel, clientPromptText, reasoningContent)
                : buildTextResponse(fullContent, clientPromptText, requestedModel, reasoningContent, finishReason);

            if (stream) {
                if (streamMeta) {
                    openaiResponse.id = streamMeta.id;
                    openaiResponse.created = streamMeta.created;
                }
                const streamOpts = { skipReasoning: Boolean(res._reasoningEmitted), includeUsage: params.stream_options?.include_usage !== false };
                if (apiMode === 'anthropic') {
                    finishAnthropicStream(res, openaiResponse, streamOpts);
                } else if (apiMode === 'responses') {
                    finishResponsesStream(res, openaiResponse, streamOpts);
                } else {
                    finishOpenAIStream(res, openaiResponse, streamOpts);
                }
                console.log(`${agentTag} Streamed ${apiMode} (tool=${!!toolCall}) in ${Date.now() - startTime}ms${res._thinkPhaseMs !== undefined ? ` (think ${res._thinkPhaseMs}ms)` : ''}`);
            } else {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                if (apiMode === 'anthropic') {
                    res.end(JSON.stringify(toAnthropicResponse(openaiResponse)));
                } else if (apiMode === 'responses') {
                    res.end(JSON.stringify(toResponsesResponse(openaiResponse)));
                } else {
                    res.end(JSON.stringify(openaiResponse));
                }
                console.log(`${agentTag} Response ${apiMode} (tool=${!!toolCall}, ${Date.now() - startTime}ms, ${fullContent.length} chars${res._thinkPhaseMs !== undefined ? `, think ${res._thinkPhaseMs}ms` : ''})`);
            }
        } catch (e) {
            console.log('[DS-API] Error:', (e && e.stack) || (e && e.message) || e);
            if (activeSession && activeSession.accountId && isTimeoutError(e) && !e._accountMarked) {
                const act = accounts.find(a => a.id === activeSession.accountId);
                if (act) markAccountFailure(act, 504, 'stream read timeout');
            }
            if (clientGone) return;
            if (res.headersSent) {
                sendStreamError(res, apiMode, e);
                return;
            }
            // Pool exhaustion / no-auth carry an explicit status so integrators see
            // 429/503 (not a generic 500) and can honor Retry-After.
            const timedOut = isTimeoutError(e);
            const status = e.status || (timedOut ? 504 : 500);
            const headers = { 'Content-Type': 'application/json' };
            // Validate server-provided Retry-After (R4-C2): raw upstream
            // strings ('soon', absurd dates) must not reach clients verbatim.
            if (status === 429 && e.retryAfter) {
                const waitMs = parseRetryAfterMs(e.retryAfter);
                if (waitMs != null) headers['Retry-After'] = String(Math.max(1, Math.ceil(waitMs / 1000)));
            }
            res.writeHead(status, headers);
            // On timeout, preserve activeSession per no-new-chats invariant (implementor-brief-no-new-chats-2026-09-15).
            // Do NOT reset the remote session. Cooling the account is orthogonal to preserving the chat.
            res.end(JSON.stringify({ error: {
                message: (() => {
                    // All-cooling / exhausted 429s land here (not just the
                    // in-turn fail-fast above): same enriched wording so every
                    // 429 carries backoff + /compact guidance. Other errors
                    // keep the sanitized passthrough.
                    if (status !== 429) return toClientErrorMessage(e.message);
                    const ms = parseRetryAfterMs(e.retryAfter);
                    if (ms == null) return toClientErrorMessage(e.message);
                    return rateLimitExhaustedMessage(Math.max(1, Math.ceil(ms / 1000)));
                })(),
                type: e.type || (timedOut ? 'request_timeout' : 'server_error'),
                ...(activeSession ? {
                    agent: activeAgentId,
                    failed_session_id: activeSession.id,
                    message_count: activeSession.messageCount,
                    history_length: activeSession.history ? activeSession.history.length : 0,
                    account: activeSession.accountId,
                } : {}),
            } }));
        } finally {
            // Every early return above that never incremented must not
            // decrement: unconditional inFlight-- drifts the counter negative
            // on 400/413/503 paths and silently disables the backpressure gate.
            if (inFlightCounted) inFlight--;
        }
    });
});

async function runAuthScript() {
    const script = path.join(__dirname, 'scripts', 'deepseek_chrome_auth.js');
    const result = spawnSync(process.execPath, [script], { stdio: 'inherit', env: process.env });
    loadDeepSeekConfig({ fatal: false });
    return result.status === 0 && hasAuthConfig();
}

function printStatus() {
    console.log(`\n${formatWatermark()}`);
    console.log(`Auth: ${hasAuthConfig() ? '✅ OK' : '❌ deepseek-auth.json not found'}`);
    console.log(`Auth source: ${process.env.DEEPSEEK_AUTH_DIR || DS_CONFIG_PATH}`);
    console.log(`Accounts: ${accounts.length ? accounts.map(a => `${a.id}${a.cooldownUntil > Date.now() ? ' (cooldown)' : ''}`).join(', ') : 'none'}`);
    console.log(`Working models: ${SUPPORTED_MODEL_IDS.join(', ')}`);
    console.log('Unsupported/hidden aliases: ' + Object.keys(MODEL_CONFIGS).filter(id => !MODEL_CONFIGS[id].supported).join(', '));
    console.log('Capabilities: GET /v1/model-capabilities');
}

async function showStartupMenu() {
    if (isTruthy(process.env.SKIP_ACCOUNT_MENU) || isTruthy(process.env.NON_INTERACTIVE)) {
        if (!hasAuthConfig()) loadDeepSeekConfig({ fatal: true });
        return true;
    }
    while (true) {
        printStatus();
        console.log('\n=== Menu ===');
        console.log(`ForgetMeAI: ${FORGETMEAI_WATERMARK}`);
        console.log('1 - Log in / refresh DeepSeek login');
        console.log('2 - Import auth file / cookies');
        console.log('3 - Show models and statuses');
        console.log('4 - Start proxy (default)');
        console.log('5 - Exit');
        let choice = await prompt('Your choice (Enter = 4): ');
        if (!choice) choice = '4';
        if (choice === '1') {
            await runAuthScript();
        } else if (choice === '2') {
            spawnSync(process.execPath, [path.join(__dirname, 'scripts', 'auth_import.js')], { stdio: 'inherit', env: process.env });
            loadDeepSeekConfig({ fatal: false });
        } else if (choice === '3') {
            console.log(JSON.stringify(ALL_MODEL_CAPABILITIES, null, 2));
            await prompt('\nPress Enter to return to the menu...');
        } else if (choice === '4') {
            if (!hasAuthConfig()) {
                console.log('Need deepseek-auth.json. Run option 1 or 2.');
                continue;
            }
            return true;
        } else if (choice === '5') {
            return false;
        }
    }
}

async function main() {
    printBanner();
    requireProxyApiKey(getProxyKey(), isTruthy(process.env.REQUIRE_PROXY_API_KEY));
    if (!isLoopbackHost(HOST) && !getProxyKey()) {
        console.warn(`[DS-API] WARNING: HOST=${HOST} exposes the proxy without authentication. Set PROXY_API_KEY or bind to 127.0.0.1.`);
    }
    const shouldStart = await showStartupMenu();
    if (!shouldStart) process.exit(0);
    server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') console.error(`[DS-API] FATAL: port ${PORT} already in use. Set PORT=<other> or stop the other instance.`);
        else console.error('[DS-API] server error:', err);
        process.exit(1);
    });
    // Restore the pre-restart chat map so live conversations keep their remote
    // chat (fixes silent new-chat + truncated context after every restart).
    restoreSessions();
    // Periodically evict idle sessions (unref'd so it never keeps the process alive).
    setInterval(sweepIdleSessions, 10 * 60 * 1000).unref();
    // Hourly advisory model discovery (unref'd; never breaks serving).
    startModelDiscovery();
    server.listen(PORT, HOST, () => {
        console.log(`[DS-API] Server on http://${HOST}:${PORT} (multi-agent sessions enabled)`);
        console.log(`[DS-API] ${formatWatermark()}`);
        console.log('[DS-API] POST /v1/chat/completions (OpenAI Chat Completions, stream=true|false)');
        console.log('[DS-API] POST /v1/messages — Anthropic Messages shim for Claude Code');
        console.log('[DS-API] POST /v1/responses — OpenAI Responses API shim');
        console.log('[DS-API] GET  /v1/models — supported OpenAI-compatible models');
        console.log('[DS-API] GET  /v1/model-capabilities — real model mapping and capabilities');
        console.log('[DS-API] GET  /v1/sessions — list active agent sessions');
        console.log('[DS-API] POST /reset-session?agent=<id> — reset agent session');
        console.log('[DS-API] POST /reset-session?agent=all — reset ALL sessions');
    });
}

if (require.main === module) {
    // Don't let a stray rejection/throw take the whole proxy down silently.
    process.on('unhandledRejection', (reason) => console.error('[DS-API] unhandledRejection:', reason));
    process.on('uncaughtException', (err) => console.error('[DS-API] uncaughtException:', err));
    // Graceful shutdown: stop accepting, drain, then exit (force-exit after 10s).
    const shutdown = (sig) => {
        console.log(`[DS-API] ${sig} received — shutting down…`);
        persistSessionsNow();
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 10000).unref();
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
    main().catch(err => { console.error('[DS-API] FATAL:', err); process.exit(1); });
}

module.exports = {
    server,
    __test: {
        isAssistantOutputFragment,
        isReasoningFragment,
        isDeepSeekModelErrorEvent,
        createUpstreamHttpError,
        createChatExpiredError,
        rebuildFragmentText,
        applyResponsePatchOperations,
        compactToolSchema,
        formatToolDefinitions,
        parseToolCall,
        parseToolCalls,
        hasLeftoverToolEnvelopes,
        MAX_TOOL_CALLS_PER_TURN,
        ACTIVE_HOSTED_WINDOW_MS,
        buildToolCallResponse,
        toAnthropicResponse,
        toResponsesResponse,
        normalizeMessageContent,
        redactImageRef,
        redactEmbeddedDataUrls,
        redactToolName,
        sanitizeSessionId,
        principalForRequest,
        resolveAgentId,
        isSharedTitleBucket,
        MAX_SESSIONS,
        SESSION_ID_MAX_LENGTH,
        MAX_BODY_BYTES,
        MAX_INFLIGHT_BODY_BYTES,
        MAX_CONCURRENT,
        checkBackpressure,
        getInflightBodyBytes,
        setInflightBodyBytes,
        getInFlightCount,
        setInFlightCount,
        getMediaRoot,
        isMediaPathAllowed,
        isStatusVisible,
        buildHealthPayload,
        buildReadyzPayload,
        commitTurnState,
        getProxyKey,
        redactStringLeavesDeep,
        redactToolArguments,
        normalizeApiParams,
        parseDsmlToolCall,
        looksLikeToolCallMarkup,
        parseToolTagList,
        setExtraToolTags,
        setBurstPerMinute,
        computeRingCap,
        parseToolTagEnv,
        rateLimitRetryDelayMs,
        shouldAttemptInPlaceRetry,
        shouldRetryInPlace,
        retryWaitMs,
        inPlaceRateLimitRetry,
        anyAccountReady,
        recordAccountRequest,
        recordUpstreamTurn,
        usedSince,
        usedThisHour,
        oldestInWindow,
        withinQuota,
        burstUsedThisMinute,
        withinBurst,
        stickyBurstReject,
        accountReleaseMs,
        earliestReleaseMs,
        rateLimitExhaustedMessage,
        truncatePromptMiddle,
        hasExplicitConversationHistory,
        buildRecoveryHistoryPrefix,
        buildBoundedPrompt,
        buildRetryPrompt,
        isContinuationRecoverySafe,
        restoreContinuationSnapshot,
        isContextTooLongError,
        isRateLimitError,
        resolveRateLimitMigration,
        performRateLimitMigration,
        coolAccountForRateLimit,
        normalizeRetryResponse,
        classifyRecoveryFailure,
        isTimeoutError,
        shouldResetOnEmptyRetry,
        shouldAutoContinue,
        formatMessages,
        normalizeResponsesInput,
        extractScreenshotPaths,
        isDeltaPromptMode,
        fingerprintConversation,
        hashMessageEnvelope,
        splitClientMessages,
        commitDeltaState,
        detectClientCompaction,
        createSession,
        resetRemoteSession,
        storeHistory,
        serializeSession,
        persistSessions,
        persistSessionsNow,
        restoreSessions,
        classifyRepairAttempt,
        recordRepairAttempt,
        clearRepairGuard,
        repairTurnHash,
        resolveEmptyExhaustion,
        buildRepairPrompt,
        resolveRepairExhaustion,
        localShellName,
        shellReminderLine,
        prepareSessionForPrompt,
        sweepIdleSessions,
        sessions,
        accounts,
        selectAccountForSession,
        selectFreshAccount,
        selectFreshAccountDetail,
        buildBaseHeaders,
        scoreAccount,
        scoreBase,
        effectiveFailures,
        scoreBreakdown,
        isAccountReady,
        nextEwmaLatency,
        parseModelDiscovery,
        logToken,
        countActiveHosted,
        accountStatus,
        askDeepSeekStream,
        markAccountFailure,
        isProxyAuthorized,
        loadProxyApiKey,
        requireProxyApiKey,
        isLoopbackHost,
        normalizeOrigin,
        isBrowserOriginAllowed,
        setCorsResponseHeaders,
        markContextCompacted,
        CONTEXT_COMPACTED_HEADER,
        startKeepAlive,
        clearKeepAlive,
        emitReasoningPhase,
        createThinkingPump,
        liveThinkingMode,
        shouldLegacyBurst,
        shouldLogThinkPhase,
        THINK_LIVE_INTERVAL_MS,
        THINK_HOLD_BACK_CHARS,
        consumeDeepSeekStream,
        writeSse,
        sendAnthropicStream,
        startAnthropicStream,
        finishAnthropicStream,
        sendResponsesStream,
        startResponsesStream,
        finishResponsesStream,
        sendOpenAIStream,
        startOpenAIStream,
        finishOpenAIStream,
        sendStreamError,
        toClientErrorMessage,
        numEnv,
        sanitizeContent,
        toolNamesKeyFor,
        stripShellReminder,
        parseRetryAfterMs,
        isTitleGenerationRequest,
        generateLocalTitle,
    },
};
