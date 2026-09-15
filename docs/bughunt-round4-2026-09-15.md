# Bug Hunt Round 4 — 10 Rounds + 2 DA Loops + Disproof Forensics (2026-09-15)

Method: 10 systematic rounds (streams, loops, sessions, accounts, delta, title/validation,
parity, concurrency, headers/env, logs), 20 candidates → 2 DA loops → 3 survivors →
disproof pass against 7 days of service logs (journalctl) → all 3 survive (1 narrowed).

## BUG-A — continuation fires on explicitly-complete long responses (narrowed, low)
- Location: `server.js:3196` — `while (finishReason === 'length' || fullContent.length > 25000)`.
- Claim: a *complete* response (`finish: stop`) over 25k chars triggers 2 `continue` calls
  (full 80k prompt each), appending model-generated extra text to a finished answer.
- Disproof attempted: only 1 continuation in 7d logs, and it had `finish=INCOMPLETE`
  (non-standard upstream truncation marker, Sep 14 20:20) — a legitimate trigger the
  length clause backstops. So the clause is NOT pure waste.
- Surviving core: `finish === 'stop'` (explicit complete) + long still fires. Observed
  zero times in 7d → latent. Fix sketch: gate on `length`, unrecognized non-stop
  markers (e.g. `INCOMPLETE`), or long — but skip when `finishReason === 'stop'`.

## BUG-B — empty-retry burns a fresh chat per attempt (low, efficiency)
- Location: `server.js:3123` — `resetRemoteSession(session)` runs *before* each retry.
- One empty turn can mint 3 upstream chats (original + 2 retries), orphaning 2. Nothing
  requires the reset up front: an empty turn poisons nothing, and same-chat retries are
  proven safe by the markup-repair path. Necessity is unproven (the 10:02 case succeeded
  post-reset, which proves nothing about same-chat).
- Fix sketch: retry in place first; reset only if the second attempt also comes back empty.

## BUG-C — timeouts never cool, sticky pins a hanging account (low — see disproof round)
- Location: `markAccountFailure` (no marking on fetch-throw) + `selectAccountForSession:348`.
- `dsFetch` abort/timeout rejects; the throw path skips all failure marking (no status to
  mark with). `cooldownUntil` stays 0, so sticky sessions return to a degrading account
  forever while every turn slow-fails to the 120s deadline (and each timeout *resets the
  chat* in the catch block — churn with no escape).
- Forensic support: 20 timeout/fetch-fail events in 7d, clustered in bursts (16:02 x3,
  18:49–51 x5, 20:18 x2) — repeated slow-fails with no backoff response possible by
  construction. `failures` counter is write-mostly for this class (reset on success, never
  incremented on throw; no decision reads it).
- Fix sketch: count consecutive timeouts in `failures`; cool the account after N (~3) so
  sticky 429-fail-fast + fresh-session rotation route around partial degradation.

# Disproof round — every bug re-attacked with 7d log forensics + code review
- BUG-A DEMOTED to note (was bug, low): the sole observed firing in 478 turns
  (Sep 14 20:20, 41855 chars, finish=INCOMPLETE) was legitimate AND load-bearing —
  the 238-char continuation completed a truncated tool call that `length`-only gating
  would have missed entirely. The `stop`+long case is real code but zero-observed;
  retained below as latent inefficiency with the precise refinement (skip when
  `finishReason === 'stop'`).
- BUG-B SURVIVES (low): no code path requires reset-before-retry — askDeepSeekStream
  resends the full prompt anew and parent linkage tolerates staleness. Necessity
  unprovable either way; kept as unproven-necessary churn (up to 3 chats/turn).
- BUG-C SURVIVES (low): 20 timeout/fetch events in 478 turns (~4%), clustered in
  bursts (16:02 x3, 18:49-51 x5) with no backoff possible by construction. Downgraded:
  impact is bursty added latency (self-resolving), not outage.
- BUG-D SURVIVES (severity contextual): factually proven — no chmod anywhere in
  `deepseek_chrome_auth.js`, umask 022 verified, secret content verified. Low blast
  radius on this single-user box (`/home` has only swastik); medium+ on any shared
  machine, backup, or file-indexed host.
- KILLED outright: unknown-role drop (no evidence any client sends non-standard roles),
  unknown-fragment blindness (pure forward-compat speculation).
- DOWNGRADED to trivia: positional account IDs — worst case (file removal renumbers
  identities) is rendered safe by the sticky-mismatch guard (`server.js:367-372`,
  never reuses a chat id under the wrong login; degrades to churn, not misuse);
  `/new` footgun (opencode never sends a literal `/new` turn).

## Notes (not bugs)
- Upstream chat leak, systemic: resets/rollovers/sweeps/evictions abandon remote chats;
  no delete call exists in code. Every churn event is a permanent dead browser chat.
- `/new` footgun: a literal user message exactly `/new` wipes session + history silently.
- No per-agent lock: concurrent same-agent turns interleave counters; boundary checks
  self-heal. Documented in code; no action.

## Verified clean (no findings)
Stream lifecycle x3 modes, repair gate + prose fallback, adoption ordering, fingerprint
keying, title intercept, inFlight try/finally, CORS top-level headers, preferred-account
overflow, input validation + model gating, Anthropic/Responses parity, usage estimates,
HOST default + warning, PII (logs are lengths-only; store 0600 + git-ignored).

Killed in DA (17): mid-finish disconnect spam, /new-stream 15s self-cleaning ping,
compaction-header-on-stream gap, abandoned-read waste (no extra call — sunk cost only),
perf of adoption scan, compaction interplay, title/fingerprint ordering, empty/edit/system
fingerprint variance, fetch-throw *success-path* handling, delta drift/prefix/boundary,
same-opener-different-tools sharing, image-part fingerprint blinds, dead-entry home bias,
safeJsonParseObject fallback (unreachable — args pre-validated), 413 unhandled-rejection
(speculative; destroy() suppresses 'end'), stale-guard restores (window-enforced).

---

# Round 5 — 10 Fresh Rounds: pow, scripts, builders, parsers, stream core, taxonomy,
# input normalization, aux endpoints, config (2026-09-15) + DA Loop 3

## BUG-D — `npm run auth` writes world-readable live tokens (contextual severity — see disproof round)
- Location: `scripts/deepseek_chrome_auth.js:472` — bare `fs.writeFileSync(outPath, ...)`
  with no mode, vs `scripts/auth_import.js:66-67` which enforces 0600 explicitly.
- Proof: machine umask is `0022`, so a fresh `npm run auth` lands a live
  token+cookie bundle at 0644 (default `deepseek-auth.json`, or wherever
  `DEEPSEEK_AUTH_PATH` points). Current `accounts/*.json` are 0600 only because they
  arrived via a different path — the next chrome-flow refresh would not be.
- Inconsistency citation: `scripts/doctor.js:33` already flags `mode & 0o077` as a
  defect, so the project standard is 0600 and this writer violates it.
- Fix sketch: `{ mode: 0o600 }` + `chmodSync` fallback, mirroring auth_import.

## Notes (not bugs)
- Sampling params silently ignored: `max_tokens`/`temperature`/`top_p`/`stop` have zero
  references in `server.js` (inherent — web backend has no such knobs), yet
  `docs/api-documentation.md:272` shows `max_tokens` in a request example implying
  support. Doc-truth gap; either document as ignored or strip from examples.
- `buildRetryPrompt:2498` mislabels budget-shrink as `compacted` (length ratio, not
  actual truncation) — dilutes the compaction header's meaning.
- `formatMessages` silently drops non-user/assistant/tool/system roles (e.g. `developer`);
  such roles still count toward the fingerprint. Truncation-safe, but context loss if a
  client ever sends them.
- Unknown upstream fragment types (non-RESPONSE/SEARCH/THINK/REASONING) are ignored —
  forward-compat blind spot; consider logging unknown types.
- Positional account IDs (`account_${n+1}` from sorted dir listing): removing/renaming
  an auth file renumbers identities — sticky pins, home counts, and
  `DEEPSEEK_PREFERRED_ACCOUNT` silently follow the wrong login (self-healing via
  reset+rotate, but churny). Filename-derived stable IDs would fix.
- PoW solve blocks the event loop (sync WASM) with upstream-controlled difficulty —
  0 slow solves in 7d logs, upstream TLS-trusted: accepted risk, no action.

## Verified clean
lib/pow.js memory discipline (fresh instance per solve, fresh DataView post-solve,
failed-download cache eviction), auth secret handling otherwise (lengths-only logs,
deepseek.com-scoped cookies, no-sync/password-store flags, full-storage never
persisted), doctor/probe/smoke/client scripts, extractBalancedJsonAt (quote/escape
aware), DSML/parser caps, persist/restore atomicity + 0600, /reset-session auth gating,
MEDIA existsSync gates, estimateTokens, loadDeepSeekConfig validation.
Killed in DA-3: loop-blocking PoW (no occurrences), MEDIA disclosure (same-trust +
gates), O(n²) rebuild (pre-existing deferred item), unbounded stream buffers
(upstream trusted), CJK token undercount (display-only), legacy `human` role.

---

# Outcome — Churn-for-Visibility Trade (No New Browser Chats Invariant)

Date: 2026-09-15. Implemented per `implementor-brief-no-new-chats-2026-09-15.md`.

## Core Resolution
Silent upstream chat churn across error, retry, timeout, expiry, and rotation paths has been eliminated in favor of visible failure:
- **Operator Invariant**: Exactly one upstream browser chat per proxy agent session for its entire lifecycle. The sole sanctioned auto-reset exception is client-side compaction (`compactionReset` in delta mode). Manual `/new` remains the explicit human escape hatch.
- **BUG-B Resolved**: Empty retries no longer reset or mint fresh chats. Retries stay in-place in the live chat with full tool definitions re-attached (Reminder-on-Retry). On exhaustion, returns typed `tool_call_failed` without discarding the session.
- **Upstream Expiry Surfaced**: Upstream 400/404/500 no longer silently recreates chats. It preserves the session and surfaces `chat_expired` instructing the operator to send `/new`.
- **Repair Exhaustion (502)**: Twice-failed malformed tool markup preserves the chat and returns `tool_call_failed` rather than resetting.
- **Unsafe Rotation Defended**: Continuation cross-account anomalies restore the pre-call session snapshot instead of resetting or minting new chats.
- **Pre-Prompt Rollover Retired**: TTL and depth preemptive resets (`prepareSessionForPrompt`) are retired.

