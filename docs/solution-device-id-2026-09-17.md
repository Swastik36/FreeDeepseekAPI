# Solution — machine `device_id` support (implementation plan, no code)

Status: plan only, REVISED 2026-09-17 (round-3 G1). Revision: single
machine-wide id attached to every account — from one laptop, per-account
captures would reproduce the same fingerprint four times (theater). The value
is fixing the missing-fingerprint class (nothing sent at all today), not fake
diversity. Rank: anti-ban item.

## 1. What it is (verified facts)

- DeepSeek's Shumei risk SDK fingerprints the device (`device_id`, per
  browser/machine). Rust project: missing fingerprint → `biz_code=11
  RISK_DEVICE_DETECTED` login rejection (`client.rs`, `config.example.toml`).
- On the per-account question their own docs contradict (README:83 reuse-OK vs
  `config.example` + pool warning strict). Resolution adopted here: from ONE
  laptop, per-account captures reproduce the same fingerprint — so we capture
  ONCE per machine and attach the same id everywhere. No theater, no spoofing
  (faked ids are documented to trip `RISK_DEVICE_DETECTED` worse than reuse).
- Their login payload: `{email?|mobile?, password, area_code?, device_id,
  os}` (`ds_core/src/accounts/client.rs:101`). Python mints a fresh random id
  **per login event only** (login `proxy.py:2418`, relogin `:3073`; chat turns
  reuse the saved headers) — not per-request churn. We follow the stable-id
  school (Rust), not the churn school (Python): one real id, everywhere,
  matching our long-lived sessions.
- Capture (their documented method, no automation needed): open
  `chat.deepseek.com/sign_in` in Chrome → DevTools Network → `users/login`
  payload → copy `device_id`; or console `SMSdk.getDeviceId()`.

## 2. Our-side design (single machine id — see header)

- **Storage**: one optional `device_id` per `accounts/*.json` file (same value
  everywhere in practice; per-file so a future second machine can differ).
  Optional = old files load unchanged (round-3 constraint 1).
  `auth_import.js normalizeAuth` passes it through; `validateAuth` does NOT
  require it (warn only).
- **Capture UX**: new `auth-cli.sh` step after the FIRST login only
  ("paste machine device_id (ENTER to skip)" + the 3-step guide); Renew
  pre-fills from the existing file and asks only if empty. Also accept
  `DEEPSEEK_DEVICE_ID` env for the headers-paste import path. Store `0600`.
- **No sharing guard** (deliberately dropped): sharing is the design, not a
  smell, on one machine — a warning would fire on the intended configuration.
  If a second machine ever joins the pool, differing ids are expected and
  also fine; no warning either way.
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
- **Rotation policy**: stable machine id; re-capture only if logins start
  failing with `RISK_DEVICE_DETECTED` (fingerprint drift), never on a schedule.
  Never auto-mint random ids.

## 3. Server changes (for the implementer)

1. `normalizeAuth`/`validateAuth` (`scripts/auth_import.js`): pass-through +
   warn-if-missing.
2. `buildBaseHeaders` (`server.js:342`): include the stored id in the verified
   placement (header and/or payload — TBD by capture).
3. Load-time presence log (one line listing which accounts carry an id —
   ids truncated to 12 chars, never full values).
4. `accountStatus` additive field `has_device_id: bool` (observability).
5. Tests: passthrough/validation unit tests; presence-log test with fake
   accounts; no live-device assertions.

## 4. Verification
- `npm test` green; manual: add id to one account → restart → confirm header
  present via debug log (lengths only) → live completion OK → presence log
  lists the id-carrying accounts (truncated).
- Rollback: delete the key from the file (optional field; loader ignores absence).
