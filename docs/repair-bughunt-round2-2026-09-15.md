# Repair flow: 5-round bug hunt, round 2 (2026-09-15)

Scope: B1–B4 fixes + rotation interplay + log-consumer surface + live store
evolution. Method: same as round 1 — ~3 candidates per round, genuine disproof
attempts (code read, live-log/store evidence, `node` probes). No fixes applied.

Tally: **14 candidates → 3 confirmed (all minor) + 2 observations, 9 dropped.**

## Confirmed

### C1 (minor, observability): new repair lines are invisible to the habitual log grep
The documented grep —
`Delta prompt|Created new session|Reusing session|Strict retry|Client compaction|Preserving chat|429|Restored|Repeat repair|SHELL`
— was tested against the new lines. It catches only the `Repeat repair`
line. Missed: `Lean in-chat repair…`, `escalating to full-context strict
resend…`, and the `(attempt: lean|full)` success suffix (the success line
never matched, even before B2 — pre-existing). Anyone monitoring with the old
pattern will not see attempt-1/attempt-2 flow at all. Fix sketch: extend the
pattern with `Lean in-chat repair|escalating to full-context|attempt: `.

### C2 (minor, comment): `createSession` still says the guard is never persisted
`server.js:439` — `// Repeat-repair guard (transient, never persisted)` — lies
since B3. The reset-site comment (456-458) was updated; this one was missed.
Fix sketch: `// Repeat-repair guard (client-turn scoped; persisted, window-enforced on use)`.

### C3 (minor, pre-existing): normal first-try success never clears a stale guard
Only the repair success path calls `clearRepairGuard` (single production
caller, `server.js:2741`). A stale guard from an earlier turn survives a later
unrelated success, so a future byte-identical prompt within the window is
misclassified as a repeat. Trigger requires an identical re-sent turn going
malformed — vanishingly rare, same-chat safe. Fix sketch: clear on any
successful `toolCall` response, not just repaired ones.

## Observations

### O4: first post-deploy persist will rewrite `.sessions.json` with guard keys
Live store still shows the old key set (no mutation persisted since the 08:06
restart). Expect the key diff on next write; mode stays 0600 via the existing
chmod, atomicity unchanged (tmp+rename). Downgrade-safe both ways (old code
ignores unknown keys; new code defaults missing ones — the 08:06 restart
restored the old-format file live).

### O5: attempt-2 predicate + parse purity verified
`retryUnparseable` evaluates one pure parse per content (`parseDsmlToolCall`
is string-in/object-out, log-only side effects); whitespace-only retries can't
enter attempt-2 (trim guard + entry requires markup); `session.id` is
guaranteed non-null post-`askDeepSeekStream` (create-or-throw), so the
`=== retryChatId` gate can't misfire on null.

## Dropped (disproved)

- R1: parse impurity/double evaluation (pure, single evaluation reused);
  whitespace-only retry escalation (guarded); null-id comparison (impossible).
- R2: old consumers broken by B2 suffix (prefix intact, proven last session);
  capped-path log ordering (cosmetic).
- R3: write amplification from 3 fields (negligible); `v: 1` bump needed
  (compat verified both directions).
- R4: 502 path must clear guard (it must NOT — retry classification needs it);
  reset drops guard (tested: preserved).
- R5: account rotation silently substitutes repair prompts (refuted: sticky
  account + live chat + cooldown *throws* 429 preserving the chat instead;
  prompt substitution happens only via the strict fallback on a genuinely fresh
  chat, which is the correct resurrection behavior — the rotation code defends
  repair prompts better than feared; B2 mislabel confined to the
  credential-loss path, negligible by design); 429-during-repair propagation
  (same converging class as before).
