# Implementation plan: better server logging (detailed request lifecycle + router transparency)

Date: 2026-09-16. Status: **implemented and verified live** (commit pending).
Target repo: FreeDeepseekAPI (`server.js`), tests in `tests/unit.test.js`.

## 1. Goal

Make the proxy's runtime behavior observable from logs alone:

1. Every inbound turn logs a **start line** and an **outcome line** (model, account, timing, size, result).
2. Every routing decision logs **why** an account was picked (score + components) at debug level.
3. Upstream stage timings (PoW solve, session create/reuse) are visible without guessing.

## 2. Non-goals / constraints

- **No secret ever reaches logs**: no prompts, message content, tokens, cookies,
  request headers, or auth-file paths. The `/health` status endpoint already
  redacts these — logs must match that bar.
- **No churn to existing log calls**: all 113 current `console.log` calls stay
  exactly as they are (info-level by default). Only *new* detail lines are added,
  verbose ones gated behind a level flag. Rationale: several tests capture console
  output; moving existing calls risks breaking them for zero benefit.
- **No behavior change**: logging only. No routing, retry, session, or API change.
- Follows the existing `numEnv` validated-env convention for the new knob.

## 3. Step 1 — log-level helper (server.js, near `numEnv`, ~line 26)

Add after the `numEnv` definition:

```js
const LOG_LEVEL = String(process.env.DEEPSEEK_LOG_LEVEL || 'info').trim().toLowerCase();
const LOG_LEVELS = { debug: 0, info: 1 };
const LOG_THRESHOLD = LOG_LEVELS[LOG_LEVEL] ?? 1;
function logDebug(...args) { if (LOG_THRESHOLD <= 0) console.log(...args); }
```

- `DEEPSEEK_LOG_LEVEL`: `debug` | `info` (default `info`; anything else falls back to `info`).
  Only these two are advertised — no `warn`/`error` values that would suppress
  nothing. (Validation is intentionally not `numEnv`: that helper is numeric-only.
  The fallback-on-garbage contract matches it.)
- Only `logDebug` is needed: everything existing is info-or-louder and stays put.
- Document the knob in README under Diagnostics (one bullet + example).

## 4. Step 2 — deterministic score core + breakdown helper (~line 498)

Refactor `scoreAccount` into a jitter-free core plus wrapper, and add a
breakdown reporter. Pure functions, no state:

```js
function scoreBase(account, hostedCount = 0, nowMs = Date.now()) {
    // ... exact current body of scoreAccount, minus Math.random()
}
function scoreAccount(account, hostedCount = 0, nowMs = Date.now()) {
    return scoreBase(account, hostedCount, nowMs) + Math.random();
}
function scoreBreakdown(account, hostedCount = 0, nowMs = Date.now()) {
    // returns { base, inflight, failuresRaw, failuresEff, timeouts, hosted,
    //           preferred: bool, hot: bool } using the same terms as scoreBase
}
```

- `scoreBreakdown` must reuse the same term computations (extract small helpers
  if needed so the formula exists exactly once — scorer and reporter cannot drift).
- Export `scoreBase` and `scoreBreakdown` via `__test` (next to `scoreAccount`,
  ~line 4959) for tests.
- **The logged score is the jittered score that actually won the pick, never the
  bare base.** `pickLowestScoredAccount` is changed to return
  `{ winner, score }` (score = the jittered value compared in the loop) instead
  of just the winner. Its two call sites (`selectFreshAccount`, ~line 536;
  `resolveRateLimitMigration`, ~line 3505) are updated; no test calls it directly
  (verify with grep at implementation time). The debug line prints that exact
  `score` plus the deterministic `base` from `scoreBreakdown` for interpretation.
- **Log-safe interpolation.** `requestedModel` and `agentId` are client-influenced;
  sanitize once, at the new log call sites (hot-path logic keeps raw values):
```js
function logToken(value) {
    return String(value ?? '').replace(/[^A-Za-z0-9_.:#/-]/g, '_').slice(0, 80);
}
```
  `agentTag` values already in logs today stay as they are (existing calls untouched);
  the sanitizer applies to the *new* start/outcome lines only. Newline/control-char
  injection forges journal lines, so this is load-bearing, not cosmetic.

## 5. Step 3 — log the pick decision (debug)

**3a. Fresh-chat pick** — `selectAccountForSession`, after the fresh-assignment
branch (`selectFreshAccount(ready)` call site is inside `selectAccountForSession`,
~line 414+; `selectFreshAccount` itself is ~line 542). The log call goes in
`selectAccountForSession` right before `session.accountId = account.id`, and it
must reflect *which path* decided the pick:

- **Scorer path** (default mode, ≥2 ready): log the exact jittered winning score
  returned by the updated `pickLowestScoredAccount`, plus `base` and components
  from `scoreBreakdown` computed with **the pick's own `nowMs`** (thread it through
  from `pickLowestScoredAccount` — never call `Date.now()` again for the same
  decision, and never re-read `countActiveHosted` with a fresh timestamp):
```text
[session:<agentId>] pick acct:<id> score=<jittered 2dp> base=<base 2dp> (fail <eff>/<raw>, timeouts <n>, hosted <n>, preferred <y/n>, hot <y/n>) from <readyCount> ready
```
- **Single-ready shortcut** (`ready.length === 1`, ~line 543) and **preferred-mode
  direct hit** (`ready.find(...)`, ~line 554): no score was computed, so log an
  explicit mode marker instead of a fabricated score:
```text
[session:<agentId>] pick acct:<id> mode=<single|preferred> from <readyCount> ready (no scoring)
```

**3b. Migration pick** — `resolveRateLimitMigration` (~line 3493; pick at ~line 3505).
Same rules: single-peer shortcut logs `mode=single`; otherwise log the exact
jittered winning score from `pickLowestScoredAccount` plus base/components with
the pick's `nowMs`:

```text
migrate acct:<old> -> acct:<new> score=<jittered 2dp> base=<base 2dp> (<same components>)
```

- Session key is not passed in; log is keyed by old→new account ids, which is sufficient to correlate with the existing info-level migration line.

## 6. Step 4 — request lifecycle lines (completions handler)

**4a. Start line** — after `getOrCreateAgentSession(agentId)` (~line 4096, `agentTag`
is `[<agentId>]` at line 4048). One info line:

```text
[<agentId>] -> model=<requestedModel> stream=<true|false> api=<openai|anthropic|responses> sess=<new|chat#<msgCount>/acct:<accountId|null>>
```

- All values already in scope (`requestedModel`, `stream`, `apiMode`, `session`).
- `requestedModel` and `agentId` go through `logToken()` (Step 2) — they are
  client-influenced. No prompt text, no token counts of content — only routing metadata.

**4b. Outcome line** — extend the existing line at 4329 (do not move it):

```text
[<agentId}] Got <chars> chars (+<reasoning> reasoning chars) in <ms>ms (msg#<n>) acct:<initialCall.account.id> finish=<finishReason>
```

- `finishReason` is in scope (destructured line 4323); `initialCall.account` is set
  (`askDeepSeekStream` returns `{ resp, agentId, account, ... }`, ~line 1402 —
  verified, not assumed).
- Error/early-return paths (`abandoned || clientGone`, 429 fail-fast, 503 paths):
  append `acct:<id or none>` + upstream HTTP status where the variable exists.
  Touch only the message string, never control flow.

## 7. Step 5 — upstream stage timings

- PoW solve (~line 1336): keep the existing slow-only info log; add
  `logDebug(`[account:<id>] PoW solve: <ms>ms (difficulty <d>)`)` unconditionally.
- Session create/reuse logs (lines ~1291/1293, `[agent/acct] Created/Reusing session`):
  already info-level and sufficient — no change.

## 8. Step 6 — tests (tests/unit.test.js)

Add near the routing tests (~line 2710+); extend `saveRoutingEnv` only if new env
vars are touched (they aren't — knobs are load-time consts, tests use defaults):

1. `scoreBase is deterministic and matches scoreAccount minus jitter` — two
   `scoreBase` calls strictly equal; `scoreAccount` within `[base, base+1)`.
2. `scoreBreakdown reports the same components the scorer uses` — craft account
   `{ inflight: 1, failures: 4 (fresh timestamp), consecutiveTimeouts: 2 }`,
   assert `failuresEff === 4` exactly (age ≤ 0 bypasses decay — integer, no approx),
   `timeouts === 2`, `base === 10 + 4*4 + 12*2`. Save/clear `DEEPSEEK_PREFERRED_ACCOUNT`
   in the test ( scorer reads it at call time) and do not rely on ambient
   `DEEPSEEK_ROUTING_*` weight overrides — knobs are load-time consts, so the test
   pins default-weight math; note that in the test comment.
3. `debug pick log fires on fresh assignment` — temporarily set `LOG_THRESHOLD`?
   **No**: threshold is a load-time const. Instead, capture `console.log` around
   `selectAccountForSession` with a fresh session and assert a line matching
   `/pick acct:/` appears **only if** the test spawns with `DEEPSEEK_LOG_LEVEL=debug`.
   Simpler and hermetic: assert the *breakdown object shape* (covered by test 2)
   and assert via code inspection that the log call site passes. Decision: test 2
   + a spawn-based test (`node -e` child with `DEEPSEEK_LOG_LEVEL=debug` requiring
   server internals and calling `scoreBreakdown`) is overkill — **skip log-emission
   tests**; cover math only. Rationale documented here so a reviewer doesn't ask.
4. Existing suite must stay 213+ green (`npm test` runs `node --check` + unit tests).

## 9. Step 7 — verify live

1. `npm test` green.
2. `systemctl --user restart freedeepseek.service`; `curl /health` → ok.
3. One completion at default level: expect exactly the start + outcome lines.
4. `systemctl --user set-environment DEEPSEEK_LOG_LEVEL=debug` (or edit unit) +
   restart; one completion + one forced-failover turn: expect score-breakdown
   lines; confirm **no prompt text, tokens, or cookies** in journal.
5. Set level back to `info`, restart, final health check.

## 10. Risks and rollback

| Risk | Mitigation |
|---|---|
| Log line in hot path throws (e.g. undefined field) | All interpolated values are numbers/strings already in scope; optional chaining where touched; tests cover helpers |
| Debug volume on a busy proxy | Debug is opt-in; default output grows by exactly 2 short lines per turn |
| Secret leak via new lines | Allowlist approach: only sanitized ids, counts, timings, scores (`logToken` on all client-influenced interpolation). Verification step 4 explicitly greps the journal |
| Drift between scorer and breakdown | Single-source formula (step 4); test 2 pins equality |

Rollback: `git revert` the single commit; restart the service. No schema, session-store, or config-format change, so revert is clean.

## 11. Out of scope (future ideas, not this change)

- Structured JSON logs / log shipping.
- Per-account latency EWMA in scoring (needs instrumentation + design; logged timings here are the prerequisite data).
- Request IDs correlating start→outcome lines (current `agentTag` + timestamp is enough at this volume).

## 12. Review disposition (2026-09-16)

An adversarial review of v1 of this plan returned 10 findings. Verified one by
one against the tree; disposition:

- **Accepted, fixed**: #1 (log the jittered deciding score, not the base) → §4/§5
  now return and log `{ winner, score }` from `pickLowestScoredAccount`.
- **Accepted, fixed**: #2 (single-ready and preferred paths score nothing) →
  explicit `mode=<single|preferred>` marker, no fabricated score.
- **Accepted, fixed**: #3 (migration pick under-specified; winner-only return) →
  same `{ winner, score }` change covers both call sites.
- **Accepted, fixed**: #4 (post-hoc `Date.now()` / session re-read) → the pick's
  `nowMs` is threaded through to the breakdown; no re-sampling.
- **Accepted, fixed**: #5 (knob contradicted its docs) → only `debug|info`
  advertised; fallback contract documented as numEnv-like, not numEnv.
- **Accepted, fixed**: #6 (log injection via `requestedModel`/`agentId`) →
  `logToken()` sanitizer on all new client-influenced interpolation; allowlist
  claim corrected.
- **Rejected**: #7 ("suite is 209, not 213+") — stale baseline. Live run at plan
  time: `tests 213, pass 213, fail 0` (`node --test tests/unit.test.js`). 209 was
  the count before the 4 routing tests landed. "213+" stands.
- **Rejected**: #8 ("`initialCall.account` unverified, possibly undefined") —
  wrong function cited. `askDeepSeekStream` returns
  `{ resp, agentId, account, promptUsed, freshSessionReset }` (server.js:1402);
  the `:1263` return quoted in the finding belongs to the inner
  `readDeepSeekResponse` stream reader. `initialCall.account` is set.
- **Partially accepted**: #9 (line-ref rot) — `selectAccountForSession` call-site
  ref corrected (was "~441", the function is ~414 with the fresh-pick call after
  it; `selectFreshAccount` itself ~542). The claimed "`__test` block is 4799" is
  itself wrong: the export block is at ~4958–4960 (verified by grep), so the
  plan's "~4959" stands.
- **Accepted, fixed**: #10 (test pins env-overridable weights; float approx on an
  exact integer) → exact `=== 4` assertion, preferred-env isolation, and a comment
  noting the test pins default-weight math.
