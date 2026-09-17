# Research round 3 — gap map + steal/skip verdicts (2026-09-17)

Input: round-1 (ours) + round-2 (theirs). Each row: what they have, our status,
verdict, and which solution doc carries the implementation plan.

## Gap table

| # | Capability | Rust | Python | Ours today | Verdict |
|---|---|---|---|---|---|
| G1 | Per-account `device_id` (Shumei fingerprint) login support | `Account.device_id`, sharing warning (their README:83 says reuse-OK — contradiction recorded, we follow strict) | fresh-random per login event | **Missing** — we send no fingerprint at all | **STEAL** → `solution-device-id` |
| G2 | Hourly per-account request quota (anti-mute) | default 60/hr, sliding window, 429 when all spent (measured mute ≈215/hr, delayed) | — | **Missing** — unbounded per-account rate | **STEAL** → `solution-hourly-quota` |
| G3 | Dynamic model discovery | hardcoded `model_types` (default `["default"]`) | start + hourly `client/settings` poll | **Missing** — hardcoded alias table | **STEAL** → `solution-model-discovery` |
| G4 | Configurable tool-call fallback tags | `extra_starts/ends` (+fuzzy built-ins) | DSML variants in code | hardcoded matchers (`server.js:2014/2031`, caps `:1660/:2224`) | **STEAL** → `solution-tool-tags` |
| G5 | File upload into session (data-URL; URL→search) | yes | yes (`ref_file_ids` flow) | **Missing** (`ref_file_ids: []`, `server.js:1428`) | **STEAL** → `solution-file-upload` |
| G6 | Oversized-prompt fallback (chunk + upload) | yes | — | we compact instead (different, valid) | **STEAL as complement** → same doc as G5 |
| G7 | Retry on rate-limit | single 2s retry on `Overloaded` only (their diagram's 1s→16s ladder is aspirational — code does one wait) | once-retry after refresh | fail-fast 429 (deliberate, agent-friendly) | **STEAL as opt-in toggle** → `solution-retry-toggle` |
| G8 | Scoped auto re-login (saved password, 401→login→retry-once) | 60s background sweep of Error accounts (not inline) | automatic inline (Fly143) | manual Playwright re-login | **STEAL scoped** → `solution-scoped-autologin` |
| G9 | Account health check at load (temp session → test → delete) | yes | yes (login flow creates session) | load = file parse only; dead creds discovered by first failing turn | **STEAL (light)** → folded into `solution-auth-cli` check + server load probe |
| G10 | Admin panel (accounts/keys/logs/hot-reload) | full | partial | `/health` JSON + logs | **SKIP** (ops needs covered; revisit if multi-user) |
| G11 | Single binary / zero-dep | Rust binary / Node zero-dep | pip venv | already zero-dep | n/a (parity) |
| G12 | Registration automation | no | yes (`registrar.py`) | no | **SKIP explicitly** — ban-farm-shaped, mainland-blocked, captcha-prone |
| G13 | Hourly model refresh cadence | n/a | hourly | n/a | covered by G3 |

## Where we lead (do not regress)

- **Routing**: hypersensitive scorer (2-strike escalation, half-life decay, hot
  bonus) vs their most-idle-first / plain round-robin. Keep; quota (G2) composes
  as a pre-filter (over-quota ⇒ not ready), not a replacement.
- **Session stickiness + recovery, delta prompts, compaction integration,
  opencode shims, 232 tests, debug score logging**: none of theirs has these.
- **Tool-tag detection breadth**: our fuzzy DSML/fullwidth/`TOOL_CALL:`/envelope
  coverage already exceeds Rust's built-in list — G4 adds configurability, not
  capability.
- **Credential hygiene**: `.bak`-on-success, `0600` tmp+rename, no-clobber guard,
  `--token` refusal. Their password-at-rest model is weaker; G8 must not dilute ours.

## Cross-cutting constraints for all solution docs

1. Auth files stay `{token, cookie, hif_*, wasmUrl}` + optional new fields
   (never required — old files keep loading). Note: `baseUrl` may appear in
   files (writer output) but the server never reads it (round-1 §5) — new code
   must not depend on it either.
2. Filenames keep controlling `account_N` identity (round-1 §5).
3. No secrets on argv / in logs (round-1 §4 rule survives everywhere).
4. Every behavior ships behind defaults that preserve current behavior unless the
   feature is the point (quota defaults ON but generous, like theirs).
5. Tests in `tests/unit.test.js` for pure logic; live probes documented, not automated.
6. License hygiene: ideas + endpoint shapes are free; do not paste their code
   (Rust is GPL-3.0).

## Build order (recommended)

Maintenance note (2026-09-17, deferred, not forgotten): exact `file:NNN`
anchors across these docs drift as code moves — verified twice by audit.
Do not hand-fix them per edit; instead, before any commit that touches code,
re-derive anchors mechanically (`grep -n`) or replace them with symbolic
`grep` pointers. Counts (not lines) are kept current at commit time.

1. `solution-auth-cli` (unlocks everything: probe lib, Bearer-first extraction,
   file conventions) 2. `solution-device-id` (anti-ban, needs CLI capture step)
3. `solution-hourly-quota` (anti-mute, pure server) 4. `solution-model-discovery`
5. `solution-tool-tags` 6. `solution-scoped-autologin` 7. `solution-file-upload`
   (+G6 fallback) 8. `solution-retry-toggle` (smallest, last).
