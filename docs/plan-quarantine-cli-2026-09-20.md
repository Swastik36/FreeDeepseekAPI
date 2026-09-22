# CLI Quarantine on Dead PoW — Implementation Spec (consolidated)

Date: 2026-09-20. Sources: implementation plan + 3-round devils-advocate review
(`docs/plan-quarantine-cli-devils-advocate-2026-09-20.md`, all verdicts holding).
Read that review doc first — it constrains this spec.

## 0. Goal
`auth-cli.sh check` quarantines accounts whose probe proves credential-dead;
`doctor --quarantine` does the same opt-in. Mirrors server `quarantineAccount`
(`server.js:777-853`): dated dir `accounts-quarantined-YYYY-MM-DD/`, 0700 dir,
0600 files, json + `.bak`/`.bak-*` moved. CLI cannot unbind in-memory sessions —
quarantine takes effect on service restart (unlike the server path).

## 1. Shared allowlist (new, `scripts/probe-account.js`, exported + unit-tested)
`isQuarantineWorthy(reason)`:
- Quarantine: `pow-missing`, `http-401`, `http-403`.
- Never: `http-429`, `http-5xx`, `non-json`, `network:*`,
  `file-missing-token-or-cookie`, exit-2 unreadable.

## 2. Move helper (new, `scripts/auth-cli.sh`)
`quarantine_account_file <path> <reason>`: derive dated dir from the file's
location like the server (sibling `accounts-quarantined-<today>` when parent is
`accounts`, else under the file's dir); skip symlinks; `mkdir 0700`; move json +
`.bak`/`.bak-*`; `chmod 600`; print `quarantined: <name> (<reason>) -> <qdir>/`
plus the undo line (`auth-cli.sh restore`). **Collision: refuse, never overwrite.**
Env: `DEEPSEEK_AUTO_QUARANTINE` (opt-out; `--no-quarantine` flag; `--dry-run`
reports without moving).

## 3. Wire `check` (default auto-quarantine)
`cmd_check_one`/`cmd_check`: call `node probe-account.js --json <file>`, parse
`.reason` with `node -e` (assert JSON keys in tests). Double-tap rule: first DEAD
allowlisted verdict triggers one immediate re-probe; move only on two consecutive
allowlisted verdicts. Mass-quarantine circuit breaker: if EVERY account in one
`check all` run is dead, move NONE, print incident warning, exit 1 (single-account
`check <name>` has no quorum — double-tap only, documented). Preserve exit-1-on-any-dead.
`check all` glob expands pre-loop (safe); zero-live warning uses a FRESH glob.

## 4. Wire `doctor` (opt-in `--quarantine` only)
`doctor.js` must import `classifyPowResponse` from `probe-account.js` (no local
mapping) to map its live result to a reason; on allowlisted verdicts print
`QUARANTINE_CANDIDATE <file> <reason>`. `cmd_doctor` passes the flag through,
parses those lines, calls the Step-2 helper. All filesystem mutation stays in sh.

## 5. After any move
Offer restart on TTY only (non-interactive runs log "restart required" instead —
`ask_yn` defaults Yes on empty input, so never prompt off-TTY). Then fresh-glob
count of live `*.json`: zero → loud warn (renew/import) but proceed.

## 6. Tests (no new network)
- Allowlist table unit tests (all probe reasons + doctor-mapped inputs).
- Helper shell tests with fixture `AUTH_DIR`: move, perms, collision refusal,
  symlink skip, dated-dir derivation.
- Wiring: double-tap (stub probe to fail once then pass → no move), circuit
  breaker (all-dead fixture → no moves), `--dry-run`, JSON-key assertion.
- Follow the existing auth-cli shell-test harness already in the suite.

## 7. Locked decisions
1. `check` auto-quarantines by default (prompt-per-file incompatible with `check all`).
2. `doctor --quarantine` opt-in (diagnose-don't-mutate contract).
3. Collision refuses. 4. Zero-live proceeds + warns.
`restore` is the untouched undo path (probes read-only, moves back only if ALIVE).
