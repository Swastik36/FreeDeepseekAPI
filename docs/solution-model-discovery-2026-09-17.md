# Solution — dynamic model discovery (IMPLEMENTED 2026-09-17)

Status: implemented — poller, strict parser, health exposure; advisory-only
by construction (no alias mutation anywhere). Live: startup poll logged 3 types,
`/health` shows the table.

## 1. What it is (verified facts, 2026-09-17 live probes)

- Endpoint: authed `GET client/settings?did=<any>&scope=model`. Proven by
  A/B/A/B testing same-credentials: **the `did` value is irrelevant**
  (random UUID works); the gate is the **`x-client-*` header group**
  (platform/version/locale/bundle-id/timezone). Minimal headers → perpetual
  `biz_code: 1 SETTINGS_NOT_FOUND`; full browser-like headers → `biz_code: 0`.
  Fly143's `did=uuid4` approach works for them only because they also send
  client headers — the did itself was never the trick.
- Parser path (verified shape): `data.biz_data.settings.model_configs` =
  `{id, value: [{model_type, name, enabled, switchable, ...}]}` — NOT a bare
  list at `biz_data` level (an early probe misread this; the A/B runs pinned it).
- Live values 2026-09-17: `default` enabled+switchable; `expert`/`vision`
  disabled+unswitchable — matching the Rust README. PARADOX (do not resolve by
  demotion): `deepseek-expert` completions still succeed through our proxy
  (`EXPERT-OK` live). Upstream flags ≠ serving reality; discovery stays advisory.
- Failure mode is soft: `biz_code != 0` or unparseable → keep last-good table,
  debug-log per event (no warn-once path in the tree). Discovery must never
  break serving.

## 2. Our-side design

- Poller: on startup + hourly (`setInterval` unref'd; both call sites
  `.catch(()=>{})` so a throw can never become an unhandled rejection).
  Account choice reuses the shared `isAccountReady` predicate (preferred first,
  else first ready) — no healthy account means skip tick, keep last-good.
  Timeout 15s, all failures swallowed to debug log: discovery can never break
  serving, by construction (single `try`, guarded call sites).
- Parser path (tree truth): `data.biz_data.settings.model_configs` =
  `{id, value: [{model_type, name, enabled, switchable}]}`. `enabled`/
  `switchable` use strict `=== true` (truthy-non-true reads as off).
- Policy (advisory — implemented as log + surface ONLY): the discovered table
  lands in `/health` `discovered_models` (visibility-gated like accounts).
  There are deliberately NO `model_disabled_upstream` flags, flip warnings, or
  warn-once paths in the tree — surfacing without alerting, until an operator
  asks for more.
- Knobs: `DEEPSEEK_MODEL_DISCOVERY` (`!== '0'` = on, default on) and
  `DEEPSEEK_MODEL_DISCOVERY_MS` (default 3600000, min 300000). Off = no poller,
  zero behavior change.

## 3. Explicit non-goals
Auto-adding/removing aliases; trusting `switchable:false` as failure (their
expert conclusion is disputed by our live test); blocking startup on discovery.

## 4. Tests & verification
- Unit (`tests`: model discovery block): verified shape parses to typed table;
  null/`{}`/wrong-level/bare-list/missing-`value` → null; error envelopes with
  tables at either level (`code`/`biz_code` nonzero) → null; codes accept
  numeric `0` and string `'0'`; truthy-non-true `enabled`/`switchable` read as
  off; no test asserts flags/warnings because the tree deliberately has none.
- Live: startup poll logged 3 types; `/health` shows the table.

## 5. Rollback
`DEEPSEEK_MODEL_DISCOVERY=0` + restart. No schema change.
