# Solution — per-account `device_id` support (implementation plan, no code)

Status: plan only. Rank: #1 anti-ban item (round-3 G1).

## 1. What it is (verified facts)

- DeepSeek's Shumei risk SDK fingerprints the device (`device_id`, per
  browser/machine). Rust project (`NIyueeE/ds-free-api` README + `pool.rs`
  sharing-warning): missing fingerprint → `biz_code=11 RISK_DEVICE_DETECTED`
  login rejection; **sharing one id across accounts increases mute-correlation
  risk** — capture one id per account (one browser profile each).
- Their login payload: `{email?|mobile?, password, area_code?, device_id,
  os}` (`ds_core/src/accounts/client.rs:101`). Python mints a fresh random id
  **per login event only** (login `proxy.py:2418`, relogin `:3073`; chat turns
  reuse the saved headers) — not per-request churn. We follow Rust: **stable
  per-account id**, since our sessions are long-lived cookies, not fresh logins.
- Capture (their documented method, no automation needed): open
  `chat.deepseek.com/sign_in` in Chrome → DevTools Network → `users/login`
  payload → copy `device_id`; or console `SMSdk.getDeviceId()`.

## 2. Our-side design

- **Storage**: optional `device_id` string inside each `accounts/*.json`
  (alongside token/cookie). Optional = old files load unchanged (round-3
  constraint 1). `auth_import.js normalizeAuth` passes it through;
  `validateAuth` does NOT require it (warn only).
- **Capture UX**: new `auth-cli.sh` step after login (solution-auth-cli §3.1):
  "paste device_id (ENTER to skip)" + print the 4-step capture guide. Also
  accept `DEEPSEEK_DEVICE_ID` env for the headers-paste import path. Store with
  the account file at `0600`.
- **Sharing guard**: at server load, group accounts by `device_id`; log a
  warning per shared id (mirror their pool warning text, adapted). No hard
  failure — shared id still loads.
- **Usage**: send as an extra signal where the web API accepts it. Exact header/
  payload placement is **UNVERIFIED — capture required before coding**. A prior
  draft claimed `x-device-id` was observed in a 2026-09-16 browser capture;
  that capture's secret-bearing artifacts were shredded per credential hygiene,
  no redacted copy was kept, and `grep -rn x-device-id` across this tree
  returns zero hits outside this doc — so the claim is unfalsifiable as it
  stands and is WITHDRAWN. Candidates to check in the fresh capture: an
  `x-device-id`-style request header and/or a `device_id` field in the
  `users/login` payload. Our proxy sends neither today (`buildBaseHeaders`,
  `server.js:342`, has no such header). Do not code placement until the new
  capture lands in-tree (redacted) or this section is updated with its path.
- **Rotation policy**: stable per account; re-capture only on Renew (prompt,
  prefilled with existing). Never auto-mint random ids (anti-correlation >
  anti-clustering for our long-lived sessions; document the tradeoff vs the
  Python approach).

## 3. Server changes (for the implementer)

1. `normalizeAuth`/`validateAuth` (`scripts/auth_import.js`): pass-through +
   warn-if-missing.
2. `buildBaseHeaders` (`server.js:342`): include the stored id in the verified
   placement (header and/or payload — TBD by capture).
3. Load-time sharing warning in `loadDeepSeekConfig` (same shape as their pool
   warning; ids truncated to 12 chars in logs — never full values).
4. `accountStatus` additive field `has_device_id: bool` (observability).
5. Tests: passthrough/validation unit tests; sharing-warning test with fake
   accounts; no live-device assertions.

## 4. Verification
- `npm test` green; manual: add id to one account → restart → confirm header
  present via debug log (lengths only) → live completion OK → sharing warning
  fires with two accounts on one id in a scratch dir.
- Rollback: delete the key from the file (optional field; loader ignores absence).
