# Solution — hourly per-account request quota (implementation plan, no code)

Status: IMPLEMENTED 2026-09-17 — see §7 record. Rank: #2 anti-mute item (round-3 G2).

## 1. What it is (verified facts)

- Rust `pool.rs:84` + `config.rs`: measured **~215 reqs/hour/account → mute
  (`biz_code=5`), judgment DELAYED** (damage visible after the fact). Default
  quota **60/hr/account** — deliberately far below 215; "add accounts, don't
  raise the value". Sliding window per account; over-quota accounts sit out;
  all-exhausted → **429 instead of hammering upstream**.
- Complements (not replaces) our hypersensitive scorer: quota is a readiness
  pre-filter; scoring still picks among ready accounts.

## 2. Our-side design

- Knob: `DEEPSEEK_HOURLY_QUOTA` (default `60`, `0` = disabled), `numEnv`-validated
  like all routing knobs. Documented in README + this doc.
- Accounting: per-account in-memory ring of request timestamps (cap stored
  entries at, e.g., 2× quota — bounded memory; on success path where we already
  reset failure counters, `push(Date.now())` + prune older than 1h).
- Readiness: extend the `ready` filter in `selectAccountForSession`
  (`server.js:452`) with `withinQuota(account)`; `resolveRateLimitMigration`'s
  `others` filter likewise. Over-quota ⇒ treated exactly like cooling (excluded;
  fail-fast 429 with `Retry-After` = seconds until oldest entry ages out when
  all are spent).
- Observability: `accountStatus` += `used_this_hour`, `quota_exhausted`;
  debug log line when an account sits out (`quota 60/60, oldest ages out in Ns`).
  `/health` already renders `accountStatus` — no endpoint work.
- Interaction with existing mechanics: quota filter runs BEFORE scorer, so
  preferred bias can never drag traffic to a spent account; success-path reset
  (`failures=0`) does NOT reset the window (different signal — document why).
  Persistence: none (in-memory; restart resets windows — acceptable, note it).

## 3. Calibration note (ours vs theirs)

- Their 215/hr mute threshold was measured on password-login app-path accounts.
  Ours are cookie web-path accounts; threshold may differ. Default 60 keeps a
  ~3.5× safety margin either way. If we ever observe a mute below ~100/hr,
  lower the default and record the datum here.
- With 1 healthy + 2 dead accounts (today's reality): dead ones burn no quota
  (failures ≠ counted requests — count only upstream-accepted turns? Decision:
  count a request when `askDeepSeekStream` gets past PoW challenge creation;
  failed-before-upstream turns don't consume quota. Rationale: quota exists to
  pace *upstream-visible* load).

## 4. Tests & verification
- Unit: sliding-window count/prune, boundary (exactly 60th allowed, 61st not),
  `0`=disabled, all-spent → 429 path with `Retry-After` present, quota ignored
  for scorer ordering among ready accounts.
- Live: set `DEEPSEEK_HOURLY_QUOTA=2`, burn 2 turns, third turn → 429 with
  `Retry-After`; after window expiry, traffic resumes. Then unset and restart.

## 5. Rollback
Unset env (or `0`) + restart. No schema change (in-memory only).

## 7. Implementation record (2026-09-17)

Built as planned (`server.js`: `DEEPSEEK_HOURLY_QUOTA` default 60 / 0 disables,
sliding-window `requestTimes` ring capped at 2× quota, readiness pre-filter in
fresh picks + migration + `/readyz`, earliest-release `Retry-After` on
all-spent, `used_this_hour`/`quota_exhausted` in `accountStatus`; clock starts
at PoW-challenge success; success reset does NOT clear the window — different
signal). Tests 234 green. Live verified with quota=2: two turns served, third
fails fast 429 with `Retry-After`.
