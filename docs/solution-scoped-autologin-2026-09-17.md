# Solution — scoped auto re-login (implementation plan, no code)

Status: plan only (round-3 G8). This is the user-approved scoped variant of
password auto-refresh (NOT always-on).

## 1. What they do (verified facts)

- Fly143 (`proxy.py:3044 relogin`, triggers `:4837/:5046`): on HTTP **401, first
  attempt only** (`not is_retry`), re-login with saved `_password` (+ fresh
  `new_device_id()`, `os:"ios"`, random iOS fingerprint headers via curl_cffi),
  token from `biz_data.user.token`, then **retry the request once**. Refresh
  failure → mark account invalid + return `auth_error 401`. WAF-202 and
  non-JSON guarded with distinct log lines. No captcha/2FA path (returns None).
- Rust: runtime auto re-login EXISTS but scoped — `start_recovery_task`
  (`pool.rs:565`) retries Error-state accounts every 60s; the panel button is
  the manual trigger onto the same path. No inline on-401 retry within the
  failing request (that request still fails) — which is exactly the gap our
  scoped variant fills differently (auth-class-gated, backoff, captcha
  stand-down).

## 2. Our-side design (scoped variant)

- **Credential storage**: separate `accounts/<name>.login.json`
  `{email|mobile, area_code?, password}` — NEVER inside the hot auth file.
  `0600`, tmp+rename writes, `.bak` discipline (reuse `secureWriteJson`). No
  file = feature inert for that account (zero behavior change by default).
- **Trigger (narrow)**: only after `ROUTING_CONSECUTIVE_STRIKES` consecutive
  **auth-class** failures (401/403, PoW-missing with dead-token signature) AND
  only when the account holds a login file AND a per-account backoff has expired
  (first wait 10m, doubling to max 6h; persisted in memory only). Never on
  429/5xx/timeout (those are not credential death).
- **Attempt (bounded)**: one login try via `users/login`
  `{email|mobile, password, area_code?, device_id? (from solution-device-id if
  present), os:"web"}` with our stock web headers (no fingerprint rotation —
  deliberate: stable identity matches our long-lived-session posture; document
  the divergence from Fly143's churn approach). Handle: WAF-202 → stand down +
  warn; captcha/2FA-shaped response (`biz_msg` match list: captcha, verify,
  challenge, 2fa, mfa) → **permanent stand-down for that file** + `/health`
  flag `login_action_required` + error log (never retry blind).
- **Success path**: extract `biz_data.user.token`; rebuild cookie jar — login
  response sets cookies via `set-cookie`: capture them with
  `response.headers.getSetCookie()` (**not** `headers.get('set-cookie')` — undici
  coalesces multi-cookie headers with commas, which corrupts `Expires` dates
  and drops cookies; verified `node -e` 2026-09-17) and join `name=value` pairs; probe `create_pow_challenge`; on ALIVE write the
  normal auth file (`.bak` first), reset failure/backoff state, resume traffic.
  On any failure: mark account cooling (existing path), keep password file.
- **Security rules**: password value never logged (lengths only, and only at
  debug); password file excluded from `/health`, `/sessions`, dumps, and the
  CLI `check` output; `shred -u` on CLI delete (extend solution-auth-cli §3.3 to
  cover `*.login.json`); never accept password via argv/env (file only —
  extends the round-1 rule).

## 3. Server changes (for the implementer)

1. Loader: read `*.login.json` into a non-serialized side map (never into
   `account.config` that status/dumps touch — audit every `accountStatus`/
   spread site).
2. Failure classifier: `isAuthClassFailure(status, reason)` helper (401/403,
   `pow challenge missing` with prior 401, `invalid token` message match).
3. `maybeAutoRelogin(account)` async: backoff check → attempt → probe →
   install-or-cool. Called from the failure path, fire-and-forget with
   inflight guard (one attempt per account at a time; concurrent turns skip).
4. `/health`: per-account `login_configured: bool`, `login_action_required: bool`.
5. Knobs: `DEEPSEEK_AUTOLOGIN=1|0` (default 0 — explicit opt-in),
   `DEEPSEEK_AUTOLOGIN_BACKOFF_MS` (default 600000, doubling, cap 6h).

## 4. Tests & verification
- Unit (no network): classifier fixtures; backoff math; captcha-biz_msg list
  matching; login-file loader (missing file = inert; bad JSON = warn+inert);
  audit test asserting `accountStatus` output never contains `password`.
- Live (scratch account ONLY, never the working three): plant expired token +
  login file → force 401s → observe one login attempt, backoff growth in logs,
  success path installing fresh creds; captcha path covered by pointing the
  login URL override (test-only hook) at a local stub returning a
  captcha-shaped biz_msg, asserting permanent stand-down + health flag.
- Rollback: `DEEPSEEK_AUTOLOGIN=0` or delete `*.login.json` + restart.

## 5. Explicit non-goals
Always-on refresh, password via env/argv, fingerprint rotation, registration
automation, retrying through captchas.
