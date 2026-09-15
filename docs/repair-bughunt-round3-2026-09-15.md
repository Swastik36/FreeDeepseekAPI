# Repair flow: 10-round bug hunt, round 3 (2026-09-15) — subagent findings, audited

Two subagents (A: rounds 1–5 lifecycle, B: rounds 6–10 upstream) reported 26 bugs
+ 6 observations. Every claim below was re-verified against current code by hand
(probes used tmp session stores; live `.sessions.json` untouched). DA-1 verdicts,
fixes, and a second DA pass over the fixes follow. No commits.

## DA-1 verdicts

**Kept + fixed (20):** R1-C1 (prefix-edit blind spot — major, probe-confirmed),
R1-C2 (compaction false positives — probe-confirmed), R1-C3 (tool drift),
R2-C1 (dead-socket terminal writes), R2-C2 (arbitrary error type),
R3-C1 (`.match` TypeError — code-proven reachability via Responses `item.output`),
R3-C2 (MEDIA all-or-nothing), R3-C3 (stale MEDIA replay), R4-C1a (reset keeps
guard/delta — part (b) disproved: `establishedChat` requires `session.id`, so a
reset session can never send suffix-only), R4-C2 (raw Retry-After echo),
R4-C3 (`age_min: 0` lie — fixed to null; cap/pagination deferred, localhost),
R5-C1 (reminder persisted), R5-C2 (banned TOOL_CALL: resurrected),
R5-C3 (mid-turn chain state unpersisted), R5-C4 (logging gaps),
6a (NaN envs — probed `AbortSignal.timeout(NaN)` RangeError),
6b (PoW no-mark paths), 7a (emoji strip — first probe mangled by shell quoting,
redone via `String.fromCharCode`), 7b+9c (id-less starves count/commit/delta —
same root, one fix), 8b (unbounded Retry-After + never cleared).

**Killed or deferred, with reason:**
- 7c O(n²) rebuild → observation (KB-scale responses; restructure risk > gain).
- 8a 5xx-no-cooldown → observation (cooldown policy is a product decision, not
  a bug; note `/bin/sh` reality: 500s already route through session-recreate).
- 10b pre-body fan-out → observation (loopback-only threat model).
- 10d per-agent mutex → deferred (deadlock/latency risk dwarfs a rare,
  client-invisible coherence wrinkle; last-writer-wins still answers both).
- 6c worker-threads → slow-solve timing log only (blind difficulty cap could
  break all solves; deciding with data later).
- Agent self-drops agreed: R1-C4, R2-C3/C4, R3-C4, R4 set, 6-caller-signal,
  7-stale-lastPath, 7-snapshot-clobber, 8-tie-starve, 8-float-quirk, 9a, 9b,
  9-double-prepare, 10a, 10d-DSML-caps.

## Fixes applied (all minor, minimal diff)

- Delta: `deltaPrefixHash` (commit/verify/persist/reset/restore) + boundary-
  presence check in `detectClientCompaction` + `deltaToolNames` one-shot full
  resend on drift (additions; removals stay sticky remote-side by design).
- Handler: `clientGone` guard before `storeHistory`/success write (502 keeps
  reset-then-skip); error-type charset sanitize; per-path MEDIA append;
  dead-MEDIA scrub at prefix build; reminder stripped on store; strict-JSON
  history form; persist after chain commit; count+commit on id-less turns;
  audit one-liners on early returns + stack on 500s; manual reset clears
  delta+guard (history/account kept); `age_min: null` when unknown.
- Upstream/accounts: `numEnv` on 4 envs (+warn; `MAX_RETRIES` already guarded;
  `"0"`-concurrent footgun now floors to default); PoW no-mark paths marked;
  unpaired-surrogate-only sanitize; 30-min cooldown clamp + clear on 2xx;
  `Retry-After` validated at 429 emit; slow-PoW (>5s) timing log.
- `looksLikeToolCallMarkup` length-guards oversized content (no more false
  502 + chat burn on merely-large output).
- 9 unit tests (69/69 green): numEnv, sanitize, toolNamesKeyFor,
  stripShellReminder, prefix-edit split, compaction trim-vs-summary,
  oversized looksLike, Retry-After parsing, error-type sanitize.

## DA-2 verdicts (attacks on the fixes above)

- All early returns (incl. 3 new ones) sit inside `try` → `finally` decrements
  `inFlight` (verified 3010-3011).
- `const establishedChat` → `let` is read-only downstream; DA-2 caught the
  Delta-log line calling a tool-drift resend "new chat" — fixed with a
  `toolSetResend` branch in the log.
- `String(text||'')` in sanitize is strictly more robust (old code threw on
  null); no caller relied on the throw.
- Stale-guard theory re-checked end-to-end: capped path never succeeds, never
  clears — cap stable; success clears are null-ops when empty.
- Cross-fix trace (lean→full→502→retry→lean→cap) with persist/restore/clear
  all coherent; mid-turn persist makes the R2-C1 skip crash-safer than before.
- Deferred items stand: 7c, 8a, 10b, 10d, 6c-worker for the reasons above.

Verify: `node --check` clean, 69/69 pass, live store untouched by tests,
service restarted healthy (`Restored 1 session(s)`).
