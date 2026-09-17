# Research round 2 — how they implemented it (2026-09-17)

Sources: shallow clones in `/tmp/opencode/research/` (`ds-rust` = NIyueeE/ds-free-api,
`ds-py` = Fly143/deepseek-free-api), plus each project's README. Read-only; nothing
copied into our tree (note §8 license).

## 1. Rust (`NIyueeE/ds-free-api`, 542★, active Sept 2026)

### 1.1 Account model (`src/config.rs`)
`Account { email, mobile, area_code, password, device_id }` (TOML, `0600`,
atomic tmp+rename save — same shape as ours but **weaker ordering**: their
`config.rs:save()` writes tmp world-readable, renames, THEN chmods `0600`
(a brief world-readable window on the final path); ours writes tmp `0600`
first, so rename never exposes. Point recorded for the CLI's write path:
keep our order, never theirs.)
Accounts deduped by email/mobile in `Config::load` (`config.rs:dedup_accounts`,
first-wins `retain`); the pool's own `insert` is last-wins but is fed the
already-deduped vec, and `add_account` guards with `contains_key` — no
observable duplicates on any path today. Notable config neighbors: `hourly_request_quota`
(default **60**), `tool_call.extra_starts/extra_ends`, `model_types`/`model_aliases`,
`default_search_enabled=true`, Responses-store caps. Identity pose is an **Android
app** (`DeepSeek/2.1.1 Android/35`, `platform=android`, `client_version=2.0.0`) —
not a desktop browser like ours (`Macintosh…Chrome/149`, `platform=web`).

### 1.2 Login flow (`ds_core/src/accounts/client.rs:338`, `pool.rs:628-700`)
- `POST {api_base}/users/login` with `LoginPayload { email?|mobile?, password,
  area_code?, device_id, os: "web" }`. Token from `biz_data.user.token`.
- WAF detection: HTTP **202 + `x-amzn-waf-action`** → error "use a non-US proxy"
  (`is_waf_challenge`, `client.rs:224`). Their hint says CloudFront WAF blocks
  US IPs and Rust clients can't run the JS challenge — proxy config provided.
- Login runs at **pool init for every account** + a health check (create temp
  session → test completion → **delete session**), failures → `Invalid` state but
  kept in pool for panel display.
- **Runtime auto re-login EXISTS (correction of an earlier misreading):**
  `start_recovery_task` (`pool.rs:565`) loops every 60s and retries **all
  `Error`-state accounts** via `re_login_account`. So: automatic, but on a
  1-minute background sweep gated to Error state — NOT inline on 401 within the
  failing request (that request still fails). The admin-panel button
  (`re_login_single`, Error/Invalid-gated, ≥3 consecutive login failures →
  Invalid) is the manual trigger onto the same path.

### 1.3 Pool rotation (`ds_core/src/accounts/pool.rs:411-455`)
Most-idle-first: skip non-`Idle`/over-quota, pick max `now - last_released`,
CAS `Idle→Busy` (lock-free `DashMap` reads), `record_request()` stamps the
sliding window. `get_account_with_wait` polls 200ms to a deadline.

### 1.4 Hourly quota (the anti-mute centerpiece)
Comment at `pool.rs:84` + `config.rs` default fn: measured **~215 reqs/hour/account
→ mute (`biz_code=5`), judgment is DELAYED**. Default quota **60/hr/account**
(deliberately far below 215; "add accounts, don't raise the value"). Over-quota
accounts sit out the window; all-exhausted → **429, never hammer upstream**.

### 1.5 device_id sharing: pool warning vs their own docs (contradiction recorded)

- Strict side: `warn_on_shared_device_ids` (`pool.rs`, called from `init`) +
  `config.example.toml:36-42` — independent id per account (own browser profile
  each); sharing correlates accounts → mute risk (`biz_code=5` after hundreds of
  requests); faked ids return `RISK_DEVICE_DETECTED` (`biz_code=11`).
- Permissive side: `README.md:83` — "same browser/machine id may be reused across
  accounts."
- Our take: follow the strict side (per-account ids). Rationale: the warning and
  example file are newer, more specific, and describe measured mute outcomes;
  the README line reads as onboarding convenience. If ids are scarce, sharing is
  tolerated by their code (warn-only, never blocks) — same posture we adopt in
  `solution-device-id` (warn, don't refuse).

### 1.6 Tool tags (`config.rs:ToolCallTagConfig`)
Built-ins `<|tool▁calls▁begin|>` + fuzzy match; `extra_starts` defaults
`["<|tool_call_begin|>", "<tool_calls>", "<tool_call>"]` (ends mirrored).
Pure config — no code change for new variants.

### 1.7 Retry (corrected: single 2s retry, no ladder)

`src/openai_adapter.rs:252-271`: `MAX_RETRIES=2`, `BASE_DELAY_MS=2000`, retry
ONLY on `CoreError::Overloaded`, wait `2000 * 2^attempt` ms — with max 2 attempts
only attempt #0 can retry, so exactly **one 2s wait, then give up**. The
"1s→2s→4s→8s→16s ladder" in their pipeline diagram does not match the code.
(vs our fail-fast 429.)

### 1.8 Upload + oversized fallback (README-verified behavior)
Inline data-URL files (`file`/`image_url`, Anthropic image/document) auto-upload
to the session; HTTP URLs flip to search mode; over-limit prompts fall back to
chunked completion + file upload.

### 1.9 Ops surface
Admin panel (accounts CRUD + manual relogin, API keys bcrypt/JWT, request logs,
hot-reload), `runtime.log` + `stats.json` files, `RUST_LOG` levels, per-account
status (`idle/busy/error/invalid`, error counts, used-this-hour, quota_exhausted).

## 2. Python (`Fly143/deepseek-free-api` + family)

### 2.1 Login (`proxy.py:2389 deepseek_login`, `app/registrar.py:91`)
`POST /api/v0/users/login` with `{password, device_id: new_device_id(), os: "ios",
email|mobile+area_code}` over **curl_cffi**. Random iOS fingerprints
(`random_ios_headers()`, UA/version/timezone/`x-rangers-id` pools) are minted
**only at login and re-login** (`proxy.py:2418`, `:3073`); chat completions reuse
the headers saved into the account config at login time (`proxy.py:2377` reads
`cfg["headers"]`, stored at `:2482`) — NOT re-randomized per request.
`new_device_id()` prefers a bundled "real iOS fingerprint library", else random
base64. WAF-202 handling identical in spirit to Rust. Contrast: Rust reuses one
stable captured id; Python mints a fresh id per *login event* with stable headers
thereafter.

### 2.2 Auto-refresh (`proxy.py:3044 relogin`, triggers :4837/:5046)
On **401, first attempt only** (`not is_retry`): re-login with saved `_password`
(+fresh device_id + iOS headers) → **retry the request once** with the new token.
Refresh failure → mark account invalid + return `auth_error 401` to client.
Passwords live in server-side config (`_password` key). No captcha/2FA handling —
a challenge fails the refresh (returns None).

### 2.3 Model discovery (`proxy.py:2936 _discover_models`, `:2959 did`, `:3206 refresh_models`)
`GET client/settings?scope=model` (authed) on start + hourly; parses
`model_configs` → base/thinking/search variants. (Live observation 2026-09-17,
reproducible: same endpoint with a stale `did` returns `SETTINGS_NOT_FOUND`
(`biz_code=1`) — discovery must use a working account's credentials AND a fresh
device id, tying into `solution-device-id`. No fixture in-tree; the probe
command is in `solution-model-discovery.md` §4.)

### 2.4 Account surface (`proxy.py:2517-2620`, `app/config.py`)
`/health`, accounts list/add/remove, manual `relogin_account` / `relogin_all`,
export. Registration automation exists (`registrar.py`: guest PoW → email code →
register) — **deliberately out of scope**: ban-farm-shaped, mainland-IP-blocked
(`biz_code=6`), captcha-prone. Documented here so nobody "discovers" it later.

### 2.5 Trust caveat (verified by clone 2026-09-17)
GitUser200607 / xushaohuaq / yapeng99f ship byte-near-identical READMEs to Fly143:
treat the family as one codebase (canonical: Fly143) with fork-spam risk.
DeadBranches is independent and clean; its README "Concurrency" section documents
a **serialized design** (single shared signed-in client, `server/api.py:51-53`,
sequential throughput — "keep concurrent in-flight requests low"). Throughput,
not correctness, is the concern for agentic use.

## 3. Correction log (our earlier claims vs verified code)
- "Rust auto re-logins on 401 inline" — FALSE as stated; TRUE with scope:
  no inline retry, but `start_recovery_task` re-logs Error accounts every 60s
  (`pool.rs:565`). Fly143 DOES retry inline once on 401 (`not is_retry`).
- "One device_id reusable across accounts" — CONTRADICTED inside their own docs
  (README:83 reuse-OK vs example:38 + pool warning strict). We follow strict.
- "Expert retired upstream" (their README) — NOT reproduced on our web path
  2026-09-17 (`deepseek-expert` → `EXPERT-OK` live). Possibly app-path/account
  specific. Do not demote expert on their word alone.
- "Retry ladder 1s→16s" (their diagram) — FALSE vs code: single 2s retry on
  `Overloaded` only (`openai_adapter.rs:252-271).
