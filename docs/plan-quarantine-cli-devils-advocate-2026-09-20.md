# Devil's-Advocate Review: CLI Quarantine Plan (3 perspectives)

Date: 2026-09-20. Target: the implementation plan for auto-quarantining accounts
when `check`/`doctor` report dead PoW. Method: three adversarial perspectives,
each trying to kill or reshape the plan. Verdicts: SURVIVED (stands as drawn),
AMENDED (stands with a recorded change), KILLED (dropped).

---

## Perspective 1 — The operator at 2am (safety / reversibility lens)

Wants: no irreversible surprise, no hang in cron, clear undo, honest exit codes.

### Attack 1.1 — Default-on file moves with no prompt
Proposed auto-quarantine on `check` means a routine diagnostic would silently
relocate credential files (`cmd_check`/`cmd_check_one` at
`scripts/auth-cli.sh:411-436` move nothing today). At 2am, "where did my accounts
go" is terror, and an opt-out env var nobody remembers is not consent.
**Verdict: AMENDED, not killed.** Moves stay default-on (prompt-per-file does not
survive `check all`), but three mitigations become mandatory: (a) every quarantine
line prints the exact undo (`auth-cli.sh restore`, implemented at
`scripts/auth-cli.sh:308-353`), (b) a new `--dry-run` flag shows what *would*
move without moving (no such flag exists today), (c) `--no-quarantine` / opt-out
env remains (no such flag/env exists today — new). Reversibility + visibility
substitute for consent.

### Attack 1.2 — `offer_restart` in non-interactive runs
`offer_restart` (`scripts/auth-cli.sh:150-153`) funnels into `ask_yn`
(`scripts/auth-cli.sh:40-44`), which via `ask` (`scripts/auth-cli.sh:32-39`)
defaults to Yes on empty input. Today that only matters for interactive flows —
`cmd_add` (`scripts/auth-cli.sh:196`), `cmd_renew` (`scripts/auth-cli.sh:292`),
`cmd_delete` (`scripts/auth-cli.sh:409`), `cmd_rename` (`scripts/auth-cli.sh:383`),
`cmd_restore` (`scripts/auth-cli.sh:352`), `cmd_import`
(`scripts/auth-cli.sh:494`) call it — six callers, which strengthens the TTY-gate
requirement — while `cmd_check`/`cmd_check_one` (`scripts/auth-cli.sh:411-436`) never
do — but auto-quarantine makes `check all` cron-worthy, and a cron `check all`
that quarantines *and then restarts the proxy unattended* is a behavior change
nobody approved. The only TTY gate in the CLI today guards bare-menu entry
(`[ -t 0 ] || usage` at `scripts/auth-cli.sh:517`), not the
`offer_restart`/quarantine path; the only `NON_INTERACTIVE` mention is the server
restart hint at `scripts/auth-cli.sh:166`.
**Verdict: AMENDED (emerged requirement).** The quarantine path must only offer
restart on a TTY (or honor a `NON_INTERACTIVE`-style opt-out). Non-interactive runs
log "restart required for quarantine to take effect" and exit.

### Attack 1.3 — Collision-refuse confuses the verdict
Refusing the move on name collision leaves a DEAD account live while `check` exits 1.
The operator reads "dead but still serving" — incoherent.
**Verdict: AMENDED.** Collision output must name the situation explicitly:
`DEAD <reason> (quarantine blocked: <qdir>/<name>.json already quarantined —
likely a renewed duplicate; remove one manually)`. Distinct message, same exit code.
(Note: the server's `quarantineAccount` (`server.js:777-853`) does the opposite —
`renameSync` with no existence guard (`server.js:814-815`) silently overwrites the
target. The CLI refuse is intentionally stricter; do not "align" the CLI to the
server here.)

### Attack 1.4 — Exit-code contract
Monitoring may key on `check`'s exit 1 = dead. Quarantine must not turn dead into
success.
**Verdict: SURVIVED.** Plan already preserves exit 1 regardless of moves. No change.
(Mechanics, verified: `cmd_check` accumulates `_fail` and returns it
(`scripts/auth-cli.sh:423,429,433`); `probe-account.js` exits 0 ALIVE / 1 DEAD /
2 tool failure (`scripts/probe-account.js:77-78,94`); `doctor.js` exits 0/2
(`scripts/doctor.js:89`). The quarantine implementation must not remap a
dead verdict to 0.)

---

## Perspective 2 — Upstream DeepSeek / the adversary (false-positive lens)

Wants: prove the plan exiles healthy accounts. Strongest perspective in this review.

### Attack 2.1 — The 200-with-error-envelope incident (LANDS — plan's worst case)
`classifyPowResponse` (`scripts/probe-account.js:20-39`) returns `pow-missing`
for HTTP 200 + valid JSON carrying an *error* code — the code comment itself cites
`code 40003` envelopes. If DeepSeek has an incident shape that answers 200 with
error envelopes (rate-limit wave, partial outage), **every** account probes
`pow-missing` simultaneously, and default-on auto-quarantine exiles the entire live
pool on the basis of one upstream sneeze. The allowlist cannot distinguish "my
credential is dead" from "upstream is sick" because the reason conflates them.
**Verdict: AMENDED with two new rules (both emerged here):**
1. **Double-tap before exile.** A first DEAD allowlisted verdict triggers one
   immediate re-probe; quarantine only on two consecutive allowlisted verdicts.
   Cost is bounded (extra latency falls only on already-dead accounts; ALIVE path
   unchanged). This also covers token-rotation races (renew replacing the file
   mid-probe).
2. **Mass-quarantine circuit breaker.** If *every* account probed in a single
   `check all` run is dead, quarantine **none**: that quorum is evidence of an
   upstream incident, not N independent credential deaths. Print
   `all accounts dead — suspected upstream incident; quarantined nothing`, exit 1.
   (Honest asymmetry: single-account `check <name>` has no quorum, so it relies on
   double-tap alone — documented, not hidden.)

### Attack 2.2 — Quarantine rhythm leaks operational state
Moving files on a schedule could fingerprint automation cadence to an observer.
**Verdict: KILLED.** File moves are local disk operations; nothing traverses the
network. No signal exists to leak.

### Attack 2.3 — 401/403 transients
A 401 during an upstream auth blip is not a dead credential. (Mechanics, verified:
any non-200 status maps to `http-<status>` at `scripts/probe-account.js:22`, so a
blip 401 presents as `http-401` — indistinguishable from a dead credential at the
classifier level.)
**Verdict: SURVIVED with double-tap as the answer.** Single 401/403 no longer moves
anything by itself (see 2.1); two consecutive ones across an immediate re-probe is
accepted as dead. The allowlist itself stands.

---

## Perspective 3 — The second maintainer (codebase-integrity lens)

Wants: no duplicated knowledge, no fragile parsing, no litter, no drift.

### Attack 3.1 — Reason mapping duplicated across probe, doctor, and sh
The plan puts the allowlist in `probe-account.js`, a *mapping* in `doctor.js`
(status → synthetic reason), and parsing in sh. Three places must agree on what
"dead" means; they will drift.
**Verdict: AMENDED.** `doctor.js` must not reimplement classification:
`liveCheck` (`scripts/doctor.js:37-64`) currently keeps only `status` plus a
regex test on the body (`scripts/doctor.js:58-59`) and discards the body text,
while `probe-account.js` already exports the single source of truth
`classifyPowResponse` (`scripts/probe-account.js:101`). Doctor must capture the
response text and classify it through that import (per-file loop
`scripts/doctor.js:69-85`, `main` `scripts/doctor.js:65-90`). The sh layer
(`probe_file` `scripts/auth-cli.sh:86-89`, `probe_or_die`
`scripts/auth-cli.sh:90-100`) then only ever consumes reasons, never invents
them.

### Attack 3.2 — `--json` + `node -e` parsing fragility
Shell scraping of structured output rots (whitespace, field renames).
**Verdict: SURVIVED.** The `--json` branch exists (`probe-account.js:87-88` inside
`main` `probe-account.js:73-95`): it emits `JSON.stringify(verdict)`, i.e.
`{ok, reason?, ms}` (verdict shapes from `probeFile`: `probe-account.js:41-71`).
`node -e` JSON parsing (not text scraping) is the established shell pattern
(`auth-cli.sh:126,133,136`). Caveat, verified: the current `probe_file`
(`auth-cli.sh:86-89`) still calls the probe *without* `--json` and passes human
text through, so the implementation must switch that call site to
`--json` + `JSON.parse`. (Guard the contract with one assertion on the JSON keys
in the shell test.)

### Attack 3.3 — Dated-dir litter and mid-loop mutation
A new `accounts-quarantined-*` dir per incident day litters the repo root, and
moving files during `check all` mutates the iterated set.
**Verdict: SURVIVED.** The dated-dir convention is the server's
(`quarantineAccount` `server.js:777-853`, dir layout `server.js:798-808`) — and
the CLI already shares it (`accounts-quarantined-*` globs at
`auth-cli.sh:206,250,296`); one convention beats two. The `for _f in
"$AUTH_DIR"/*.json` glob in `cmd_check` (`auth-cli.sh:424`) expands before the
loop, so mid-loop moves are safe; the "zero live remain" recount must use a
*fresh* glob after the loop (implementation note, not a design change).

### Attack 3.4 — Env-var naming
The plan's `FREEDSEEK_AUTO_QUARANTINE` breaks the repo's `DEEPSEEK_` prefix
convention (`DEEPSEEK_AUTH_DIR` at `auth-cli.sh:9` / `doctor.js:12,68`,
`DEEPSEEK_AUTH_PATH` at `doctor.js:6,17` / `auth-cli.sh:186,271,455`,
`DEEPSEEK_PREFERRED_ACCOUNT` at `auth-cli.sh:380-381`, plus the `DEEPSEEK_*`
knobs in `server.js`).
**Verdict: AMENDED (emerged).** Name it `DEEPSEEK_AUTO_QUARANTINE`. Trivial,
prevents a permanent naming scar.

### Attack 3.5 — Menu path behavior
The interactive menu dispatch (`auth-cli.sh:529-530`) picks one account then calls
the same `cmd_check` (`cmd_check_one` `auth-cli.sh:411-419`, `cmd_check`
`auth-cli.sh:420-436`) — no separate semantics needed.
**Verdict: SURVIVED.** No fork in behavior; noted so nobody re-litigates it.

---

## What survived vs what emerged

**Survived unchanged:** allowlist contents as plan-defined (`pow-missing`,
`http-401/403`; never 429/5xx/non-json/network/corrupt-file — stated by the plan
under review, not observable in current source, which has no allowlist);
collision-refuse (plus explicit message, intentionally stricter than the
server's overwrite at `server.js:814-815`); exit-1 preservation
(`auth-cli.sh:423,429,433`); `restore` as the untouched undo path
(`auth-cli.sh:308-353`); dated-dir convention shared by server
(`server.js:798-808`) and CLI (`auth-cli.sh:206,250,296`).

**Emerged (must enter the plan before implementation):**
1. Double-tap rule — two consecutive allowlisted verdicts before any move.
2. Mass-quarantine circuit breaker — all-dead quorum quarantines nothing.
3. TTY-gated restart offer; non-interactive runs log instead.
4. `--dry-run` flag for `check`.
5. Doctor classifies via imported `classifyPowResponse`, no local mapping.
6. `DEEPSEEK_AUTO_QUARANTINE` naming; undo line (`restore`) printed per move.
7. Fresh-glob recount for the zero-live warning; JSON-key assertion in tests.

**Killed (no plan change):** network-fingerprinting worry (2.2); prompt-per-file
alternative (1.1 — incompatible with `check all`); separate menu semantics
(3.5, verdict SURVIVED — unified `cmd_check` path confirmed, nothing to fork).
