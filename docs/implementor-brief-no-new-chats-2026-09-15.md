# Implementor Brief — No New Browser Chats, Ever (compaction excluded)

Date: 2026-09-15. Standing repo rules: backup-first (`/tmp/server.js.bak.*`),
`node --check` + `npm test`, minimal diff, never commit without approval, bounded live
probes (distinct `x-agent-session`, concurrency 2–4). Current suite: 101/101.

## 1. Operator invariant (non-negotiable)
One proxy session maps to at most one upstream browser chat for its entire lifetime.
No failure, retry, timeout, expiry, or rotation path may mint a replacement chat.
The SOLE exception is client-side compaction (`compactionReset`, `server.js:3122`
area), which keeps its current reset behavior. Manual `/new` also keeps working and
becomes the deliberate human escape hatch for a truly dead chat — surface that in
error text (see §4).

Accepted residual risk (operator decision, do not re-litigate): if DeepSeek kills a
chat server-side, same-chat turns fail with surfaced errors until the operator sends
`/new` or the client compacts. Churn is replaced by visible failure — that is the
explicit trade requested.

## 2. Reminder-on-retry (replaces reset as the recovery mechanism)
Until a turn stops (success or terminal error), EVERY retry carries the full system
prompt + full tool definitions (the "reminder"), never a lean/delta variant:
- Empty retries: already use the full variant — keep, and drop the reset (see §3).
- Repair attempt 1: retired lean path — send the full strict variant
  (`strictPrompt`-equivalent) on attempt 1 as well as attempt 2. `buildLeanRepairPrompt`
  falls out of the retry path (keep or remove the function; update its tests either way).
- Rationale: established chats omit the tool block, so a model that forgot the envelope
  format is re-taught every retry instead of being abandoned to a fresh chat.

## 3. Terminal behavior: toolcall error, then stop
When a retry budget exhausts (empty: `MAX_EMPTY_RETRIES`; repair: capped twice-failed
turn), end the turn immediately with an error payload and make NO further upstream
calls:
- Shape: today's error envelope (non-stream JSON / SSE `sendStreamError` dual payload),
  but with a distinct type `tool_call_failed` (include `retry_attempts`, `agent`,
  `failed_session_id`, `account`, `model`) so it is identifiable — NOT the generic
  `malformed_tool_call`.
- Do NOT synthesize executable `tool_calls` for the error (clients would run them).
- Clear nothing chat-scoped; repair guard handling unchanged. `messageCount` /
  `parentMessageId` / delta commit behavior unchanged.

## 4. Reset call-site surgery (all sites, `grep resetRemoteSession server.js`)
- `:3308` empty-retry reset → DELETE (in-place always; giveup preserves).
- `:3342` empty-giveup `chatSuspect` reset → DELETE (preserve + §3 error).
- `:3558` 502 twice-broken reset → DELETE (preserve + §3 error; repair cap already
  prevents burn loops).
- `:3657` timeout-catch reset → DELETE (preserve + §3 error; timeout cooldown from
  the BUG-C fix stays — cooling the *account* is orthogonal to keeping the *chat*).
- `:1125` upstream 400/404/500 expiry-recreate → DELETE the reset+recreate; surface
  §3 error with type `chat_expired` and text directing the operator to `/new`.
  This is the sharpest edge of the invariant: an upstream-dead chat now fails visibly
  instead of self-healing. Accepted per §1.
- `:3408` unsafe-rotation cleanup reset → REPLACE with snapshot-restore: capture
  `{id, parentMessageId, accountId, messageCount}` before the continuation call and
  restore on unsafe rotation, then §3 error. Never point the session at the foreign
  chat and never mint to escape it.
- `:372` sticky-creds-lost reset → keep ONLY when `!session.id` (state-neutral);
  with a live chat id, throw the fail-fast auth error instead and preserve.
- Pre-prompt TTL/depth rollover (`prepareSessionForPrompt` call site ~`:2924`) →
  STOP CALLING (preemptive rollover mints replacement chats). Keep the function only
  if tests require it; otherwise remove. Update its tests (`unit.test.js:809,819`).
- `:3122` compaction reset → UNTOUCHED (the sanctioned exception).

## 5. Helper-first implementation (precedent: `shouldResetOnEmptyRetry:2729`,
   `shouldAutoContinue:2733`, both exported + tested)
- Extend decision helpers rather than inlining: e.g. `resolveEmptyExhaustion(...)`,
  `resolveRepairExhaustion(...)` returning preserve+error descriptors; wire call sites
  to them; export via `__test`.
- Existing unit tests referencing removed behavior must be updated, not deleted
  silently: `resetRemoteSession` clears-state (`:981`), guard-survives-reset
  (`:1097`), rollover (`:809,819`), empty-retry policy, repair gate tests. Changed
  expectations get a one-line comment citing this brief.

## 6. Docs (required, same diff)
- `docs/api-documentation.md` §6.1 Auto-Reset Triggers table + §10 Known Limitations:
  strike/reset rows replaced with the invariant + `/new` escape hatch.
- `docs/bughunt-round4-2026-09-15.md`: append the outcome (churn-for-visibility trade).

## 7. Tests to add (~6) + acceptance
1. Empty exhaustion ×2 → `session.id` unchanged + error type `tool_call_failed`.
2. 502 twice-broken path → id unchanged (no reset).
3. Upstream 400/404/500 mid-turn → no recreate call, id preserved, `chat_expired`.
4. Unsafe rotation → pre-call snapshot restored, no reset.
5. Repair attempts (1 and 2) carry full tool definitions (assert via helper/prompt).
6. Compaction still resets (exception preserved); TTL/depth no longer resets.
- Acceptance: suite green (~107), `node --check` clean, backup present, tree
  uncommitted. Live: ordinary + multi-tool turns unaffected (regression probes only —
  forcing empty/expiry live is out of scope; unit + inspection carry those paths),
  `in_flight` 0 after probes.
