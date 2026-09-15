# Implementor Brief — Smart Routing for 3 Accounts (load-aware fresh-chat selection)

Date: 2026-09-15. Standing repo rules: backup-first (`/tmp/server.js.bak.*`),
`node --check` + `npm test`, minimal diff, never commit without approval, bounded live
probes only (distinct `x-agent-session`, concurrency 2–4). Current suite: 117/117.

## 1. Problem
With 3 ready logins, `selectFreshAccount` sends EVERY fresh chat to
`DEEPSEEK_PREFERRED_ACCOUNT` (monopoly until it cools), leaving the other two idle.
Home-stickiness counts sessions (not activity), and nothing tracks per-account load.
Result: primary/backup behavior instead of distribution; thundering herd onto one
account; migration target selection equally blind.

## 2. Design — score-based selection, sticky untouched
- **New per-account load signal**: `account.inflight` integer, incremented when an
  upstream call starts for that account and decremented in `finally` when it settles
  (retries included — wrap inside `askDeepSeekStream`, the single choke point all
  upstream calls flow through). Initialize `0` in `loadDeepSeekConfig`; expose as
  `inflight` in `accountStatus` (health endpoint).
- **New `scoreAccount(account, hostedCount)`** (exported, pure, tested):
  `score = 10*inflight + 2*failures + 6*consecutiveTimeouts - min(hostedCount,8) - (isPreferred ? 5 : 0) + jitter(0..1)`.
  Lowest wins. Rationale for weights: a busy account sheds load fast (10 dominates),
  degraded accounts are avoided (timeouts weigh 3× plain failures), home affinity is
  a nudge not a lock (capped at 8), preferred is bias not monopoly (-5), jitter
  breaks exact ties without nondeterminism pain (assert bounds in tests, not values).
- **Fresh chats** (`selectFreshAccount`): replace preferred-monopoly + home-max with
  score-min over the ready set. Single-ready shortcut stays.
- **Mode escape hatch**: `DEEPSEEK_ROUTING_MODE=preferred` restores today's exact
  behavior (preferred-first, then home-max, then round-robin). Default when unset:
  the new scoring. Keep the old code path intact behind the flag (small, reviewable).
- **Migration target** (`resolveRateLimitMigration` multi-peer branch): use the same
  scorer over `others` instead of `selectFreshAccount` (which would re-impose
  preferred-monopoly). Single-peer shortcut stays. Decided: in
  `DEEPSEEK_ROUTING_MODE=preferred` migration still uses the scorer and ignores
  the preferred account.
- **Explicitly out of scope**: active rebalancing (sticky sessions are inviolable —
  distribution emerges from fresh-chat scoring); half-open cooldown probing;
  changing cooldown/429/sticky semantics; touching delta, repair, stream, or title
  paths.

## 3. Constraints (do not break)
- Sticky sessions pin to creating account, period. Cooling accounts excluded from
  `ready` exactly as today. `selectFreshAccount` signature stays (callers unchanged).
- Per-fingerprint distribution must IMPROVE (spread), never collapse: no global
  pinning, no turn-scoped state in scoring (jitter via Math.random is fine).
- `inflight` must never leak: decrement in `finally`, including throw paths and
  early returns inside the wrapped region. A leaked counter permanently blackholes
  an account under this scheme — treat the finally as load-bearing and test it
  (throw inside the wrapped call → counter returns to baseline).
- `accountStatus` addition must not break existing health consumers (additive field).

## 4. Tests to add (~7) + acceptance
1. Scoring: busiest account loses to idle; degraded (timeouts) loses to healthy;
   preferred wins ties; home affinity nudges but loses to a busy home
   (e.g. home+8 sessions idle vs +0 sessions busy → newcomer wins).
2. Single-ready passthrough (no scoring).
3. `preferred` mode flag restores monopoly (preferred picked despite load).
4. `inflight` inc/dec symmetric around success AND throw (finally test).
5. Migration target = least-loaded ready peer via scorer.
6. Health `accountStatus` includes `inflight` number.
7. Jitter bounded (run scorer 50× on tied inputs; winner set ⊆ tied accounts —
   statistical, use generous loop count, no flaky exact assertions).
- Acceptance: suite green (~124), `node --check` clean, backup present, tree
  uncommitted. Live: 3+ fresh probes (distinct `x-agent-session`) land on ≥2
  accounts; `in_flight` 0 after; health shows per-account `inflight` 0 at rest.
  Restart the service and verify health + one smoke turn.
