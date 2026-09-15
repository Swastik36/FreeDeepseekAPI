# Implementor Brief — Rate-Limit Auto-Migration (compact + move, transparent retry)

Date: 2026-09-15. Standing repo rules: backup-first (`/tmp/server.js.bak.*`),
`node --check` + `npm test`, minimal diff, never commit without approval, bounded live
probes only (distinct `x-agent-session`, concurrency 2–4). Current suite: 111/111.

## 1. Objective
When DeepSeek rate-limits a turn, migrate the session to the other ready account
with compacted context and retry the turn transparently — the client never sees a 429
when migration succeeds. No new chats except this cross-account move (chats cannot
change logins; this extends the sanctioned compaction exception, it does not reopen
general churn).

## 2. Detection — `isRateLimitError()` (new helper, exported + tested)
True when ANY holds: HTTP status === 429; modelError matches upstream throttling text
(RU `Слишком частые сообщения`, EN variants like `too many requests` / `rate limit`,
plus the existing ` finish_reason`/type shapes if present). Case-insensitive;
keep the matcher narrow (only throttling signals — must NOT match context-length or
auth errors; reuse `isContextTooLongError` as an exclusion).

## 3. Migration flow (same client turn, at most ONCE per turn)
On rate-limit detection for the active turn:
1. Cool the throttled account via existing `markAccountFailure` semantics (unchanged).
2. If already migrated once this turn → fail fast with 429 + `Retry-After` (today's
   behavior). A per-turn boolean flag (not persisted) guarantees no ping-pong.
3. If NO other account is ready (missing creds or cooling) → fail fast 429 exactly
   as today. No behavior change.
4. Else: build the compacted context from `session.history` (existing
   `buildRecoveryHistoryPrefix` — verbatim recent exchanges, no LLM summary call),
   clear the sticky `accountId` to the other ready account, `resetRemoteSession`,
   and let the normal mint path create the new chat seeded with full tools + summary
   (same payload shape as the resurrection path). Log one line:
   `migrated <agent> chat <old> (acct:X) -> <new> (acct:Y): rate-limit`.
5. Retry the turn once against the new chat. All existing repair/empty/timeout
   handling applies to the retried turn unchanged.

## 4. SSE-embedded throttling must also cool
Today only HTTP 429 cools; SSE error events carrying throttling text do not. Route
detected SSE throttling through `markAccountFailure` (429-equivalent with the
upstream `retry-after` when present, else default cooldown) IN ADDITION to migrating.
Without this, fresh sessions keep hitting the degraded account.

## 5. Constraints (do not break)
- Sticky sessions on healthy accounts: untouched. Preferred-account routing:
  untouched. Compaction flow: untouched (this reuses its reset+reseed shape).
- Per-fingerprint account distribution must keep working: distinct opencode sessions
  (including subagent sessions, which arrive as distinct fingerprints) continue to
  spread across ready accounts via `selectFreshAccount` — do not pin everything to
  one account and do not key migration state globally (per-turn flag only).
- Repair guard (`repairHash` etc.) is turn-scoped and survives migration (same client
  turn) — do not clear it on move.
- Delta continuity (`deltaMsgCount`/`deltaBoundary`/prefix) resets with the session
  (already handled inside `resetRemoteSession`); the post-migration turn is a full
  resend by construction.
- `messageCount` restarts at 0 on the new chat (existing reset semantics); keep.
- No new upstream chats in ANY other path as part of this change.

## 6. Tests to add (~5) + acceptance
1. `isRateLimitError`: HTTP 429 → true; RU + EN throttling texts → true;
   context-length/auth/empty texts → false.
2. Migration picks the other ready account and preserves nothing chat-scoped
   (unit-test the decision helper, e.g. `resolveRateLimitMigration(session, accounts)`
   returning `{migrateTo}` or `{failFast}`).
3. Single-migration flag: second rate-limit in the same turn → fail-fast 429.
4. No-ready-account → fail-fast 429, session + chat untouched.
5. SSE throttling increments account failure/cooldown state (via `markAccountFailure`
   wiring — test at helper level).
- Acceptance: suite green (~116), `node --check` clean, backup present, tree
  uncommitted. Live: ordinary + multi-tool turns unaffected (regression probes only;
  forcing a real 429 live is out of scope — unit + inspection carry it),
  `in_flight` 0 after probes. Restart the service after implementing and verify
  health + one smoke turn.
