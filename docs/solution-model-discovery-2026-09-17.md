# Solution — dynamic model discovery (implementation plan, no code)

Status: plan only (round-3 G3).

## 1. What it is (verified facts)

- Python (`proxy.py:2936 _discover_models` with `did=uuid4()` at `:2959`,
  hourly `refresh_models` at `:3206`): authed
  `GET client/settings?scope=model` at startup + hourly → parses `model_configs`
  → base/thinking/search variants. (Their snippet confirmed in round-2.)
- Our probe 2026-09-17: the endpoint needs a **live `did`** — stale did returns
  `SETTINGS_NOT_FOUND` (`biz_code=1`). Discovery must use a working account's
  credentials AND a fresh device id (ties into `solution-device-id`).
- Cautionary datum: Rust hardcoded `model_types=["default"]` because THEIR
  settings read showed expert/vision `enabled:false` — but OUR live probe the
  same month returned `EXPERT-OK` on the web path. Discovery must be
  **advisory, never destructive** (see §3).

## 2. Our-side design

- Poller: on startup + hourly (`setInterval`, unref'd so it never holds the
  process open; skip while no healthy account exists), using the preferred
  account's token+cookie. Timeout 15s, failures swallowed with a debug log
  (discovery must never break serving).
- Parser: read `data.biz_data.model_configs[]` → `{model_type, enabled,
  switchable, name?}`. Unknown shapes → keep current table, warn once.
- Policy (advisory):
  - Newly-seen `enabled:true` model_type → log + surface in `/health`
    (`discovered_models`), do NOT auto-expose until an operator maps it
    (prevents surprise alias routing).
  - Currently-exposed alias whose type flips to `enabled:false` → log a
    **warning** + `/health` flag (`model_disabled_upstream`), keep serving
    (our live evidence beats their README; demotion is a human decision).
  - Cache last-good snapshot in memory; restart re-polls.
- No new knobs except `DEEPSEEK_MODEL_DISCOVERY=1|0` (default 1) and
  `DEEPSEEK_MODEL_DISCOVERY_MS` (default 3600000, min 300000). Off = today's
  hardcoded table, zero behavior change.

## 3. Explicit non-goals
Auto-adding/removing aliases; trusting `switchable:false` as failure (their
expert conclusion is disputed by our live test); blocking startup on discovery.

## 4. Tests & verification
- Unit: parser fixtures (their shape, our observed shape, garbage, null
  `biz_data`) → table/flags; advisory-only assertion (exposed set unchanged).
- Live: run with discovery on, confirm `/health` shows `discovered_models`
  matching the live `default` (+`expert` while it answers), then force-check by
  comparing against a manual capture.

## 5. Rollback
`DEEPSEEK_MODEL_DISCOVERY=0` + restart. No schema change.
