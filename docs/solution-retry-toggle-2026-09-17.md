# Solution — optional rate-limit retry toggle (IMPLEMENTED 2026-09-17, reworked)

Status: IMPLEMENTED 2026-09-17, REWORKED same day after adversarial review
(`server.js`: `DEEPSEEK_RETRY_RATELIMIT` flag, `rateLimitRetryDelayMs` (2s floor,
Retry-After honored, 10s cap), `shouldAttemptInPlaceRetry` (unknown/brief
backoffs only), `inPlaceRateLimitRetry` (cooldown lift + exact restore, error
preserved), enriched fail-fast 429s with backoff + `/compact` guidance;
default off = byte-identical fail-fast path; tests 232 green; live REWORK-OK).
Rework (review C1/C2/M1): v1 retried through `selectAccountForSession` and
could never reach the same chat (sticky-cool throw) or account (chat-less
rotate), double-penalized failures, and swallowed the second error. v2 lifts
the just-set cooldown for exactly one direct attempt, restores without
extending, preserves the fresh error, and skips long backoffs to migration.

## 1. What they do (verified facts)

- Rust request path (`src/openai_adapter.rs:252-271`): on `CoreError::Overloaded`
  ONLY, **one** retry after `2000ms` (`MAX_RETRIES=2`, `BASE_DELAY_MS=2000`,
  wait `2000 * 2^attempt` — with 2 attempts only attempt #0 can wait). Their
  pipeline diagram's "1s→2s→4s→8s→16s" ladder does not match the code; do not
  cite it. Philosophy: ride out a transient limit inside one client call.
- Ours (deliberate opposite): fail fast — typed 429 + `Retry-After`, sticky chat
  preserved, client backs off and retries the SAME chat+account. Rationale in
  tree: rotating accounts mid-chat splits context (one flip = new remote chat).

## 2. Our-side design (opt-in, default off)

- Knob: `DEEPSEEK_RETRY_RATELIMIT=1|0` (default **0** = today's fail-fast).
  When on: on rate-limit-class failure (429, SSE throttling model error,
  `Retry-After`-carrying errors) AND same-chat resumability intact, wait
  `2000ms` once (mirroring their single-wait shape, not a ladder), honoring
  upstream `Retry-After` when larger, then retry the turn **on the same
  account+chat**; only then fall through to the existing migration/exhaustion
  paths unchanged.
- Guards (all required): total added wait capped by the existing request
  deadline (`REQUEST_DEADLINE_MS` — checked alongside `deadlineHit()`); client
  disconnect aborts immediately (`clientGone` checks, e.g. the guards at
  `server.js:4454/4723` and neighbors — line numbers drift, grep `clientGone` at
  implementation time); non-rate-limit errors never retry (no behavior change
  for auth/parse/programming faults); the single wait logged at info
  (`rate-limit retry <n>/1 in <ms>ms`) — observability for a path that
  deliberately stalls the client.
- No interaction with scorer/quota changes: the single wait doesn't touch failure counters
  until it exhausts (a recovered turn counts as success — reset path);
  quota window counts only upstream-accepted turns (per solution-hourly-quota §3).

## 3. Tests & verification
- Unit: wait math (single `2000ms`, Retry-After override takes max when larger,
  deadline truncation, client-gone abort); classifier (429/SSE-throttle =
  retryable; 401/500/parse = not).
- Live (manual, scratch): force 429s (tight quota override), confirm the single
  wait then existing exhaustion behavior; confirm default-off path byte-identical to
  today (flag-gated code path untouched when off).
- Rollback: unset (default off). Zero-diff behavior when disabled — assert by
  construction (single `if` gate at the existing catch site).

## 4. Explicit non-goals
Cross-account retry (migration already owns that, once per turn); retrying
anything but rate-limit class; changing the default.
