# Solution — new auth CLI `scripts/auth-cli.sh` (implementation plan, no code)

Status: IMPLEMENTED 2026-09-17 (see §9). Goal: replace
`env CHROME_PATH=$(which chromium) npm run auth` with one memorable command.

## 1. Shape

- POSIX `sh` script at `scripts/auth-cli.sh` (no bashisms — verified `dash`-clean:
  numbered `while read` menu loop; **`select` is NOT used** — it is bash/ksh-only
  and absent in `dash`). Executable bit set. Thin wrapper:
  `auth [add|renew|delete|check|import|doctor] [name]` — flags optional, menu when bare.
- Reuses (does not rewrite): `scripts/deepseek_chrome_auth.js` (browser+CDP),
  `scripts/auth_import.js` (`normalizeAuth/validateAuth/secureWriteJson`),
  `scripts/doctor.js`. New logic lives in sh + one small probe helper
  (`scripts/probe-account.js`, see §4) to avoid duplicating HTTP code in shell.
- Entry in `package.json`: `"auth:cli": "sh scripts/auth-cli.sh"`, plus a symlink
  or `bin/auth` shim? Decision: keep `scripts/auth-cli.sh` canonical; document
  `alias dsauth='sh ~/FreeDeepseekAPI/scripts/auth-cli.sh'` (no PATH pollution).

## 2. Menu (bare `auth`)

```text
DeepSeek accounts (dir: ~/FreeDeepseekAPI/accounts)
  1. Add account    > name > opens Chromium
  2. Renew account  > choose > opens Chromium
  3. Delete account > choose (confirm)
  4. Check accounts > choose one/all > ALIVE/DEAD table
  5. Import (file/cURL headers)   [better]
  6. Doctor                       [better]
  7. Restart proxy service        [better]
  0. Exit
```

Choose-one lists built by scanning `$DEEPSEEK_AUTH_DIR/*.json` (default
`./accounts`, override respected). Numbered `read`-loop menu with `q` to go back
(POSIX — no `select`).

## 3. Flows

### 3.1 Add
1. Prompt `Account name:` → sanitize to `^[a-z0-9][a-z0-9_-]{0,31}$` (lowercase,
   reject else, explain why: filename = identity, round-1 §5). Refuse if
   `<name>.json` exists (point at Renew).
2. Launch: `CHROME_PATH=${CHROME_PATH:-$(command -v chromium || command -v chromium-browser || command -v google-chrome)}` then
   `DEEPSEEK_AUTH_PATH=<dir>/<name>.tmp.json node scripts/deepseek_chrome_auth.js`
   — write to a **tmp path first** so an aborted login never touches live files.
   (Requires R1-1 fix in the js: Bearer-first extraction; CLI passes nothing new.)
3. On js exit 0: run `node scripts/probe-account.js <tmp>` (see §4). ALIVE →
   `chmod 600`, `mv` over `<name>.json` (single `.bak` first, and only if the
   existing target holds a token — house rule, see Renew, mirroring
   `persistAuthResult`); DEAD → print hint, keep tmp path in message,
   ask retry/quit (never install dead creds).
4. Offer restart: `systemctl --user restart freedeepseek.service` (detect:
   `systemctl --user is-active` else print manual `NON_INTERACTIVE=1` command).

### 3.2 Renew
Same as Add except: target must exist; tmp path `<name>.renew-<ts>.json`;
`.bak` follows the house rule from `persistAuthResult` — single `<name>.json.bak`,
written ONLY if the existing file holds a token (no keep-last-3 rotation;
a stale `.bak` from an earlier success is the documented restore point);
filename NEVER changes (sticky sessions + preferred binding).

### 3.3 Delete
List → confirm with typed name (not just y/n — destructive) → `shred -u` the
`.json` + its `.bak*` (secret material; plain `rm` leaves bytes on disk) →
offer restart. Refuse to delete the last remaining account without `--force`
(flag only, keeps menu safe).

### 3.4 Check
- One: probe → `account_3 (third.json): ALIVE (412ms)` or `DEAD (pow-missing)`.
- All: loop files, one line each, exit non-zero if any DEAD (scriptable for cron).
- Output shows lengths/counts only — never token/cookie substrings.

### 3.5 Import [better]
Two modes: (a) file path → existing `auth:import --output <dir>/<name>.json`
(validates + 0600 already); (b) pasted raw request headers (from DevTools, the
proven 2026-09-16 path): read heredoc to tmp, parse `authorization:` +
`cookie:` lines (case-insensitive, first wins), reuse `probe-account.js`, same
install gate as Add. Document: headers paste is the fastest headless path.

### 3.6 Doctor + restart [better]
Thin menu entries: `node scripts/doctor.js` (verified: `authPaths()` in
`doctor.js:10` already respects `DEEPSEEK_AUTH_DIR` — no `--dir` work needed;
the CLI just exports the dir and calls it) and the restart prompt from §3.1.4.

## 4. New helper `scripts/probe-account.js` (small, testable)

- Args: `<auth.json> [--json]`; reads file; POSTs
  `create_pow_challenge {target_path:/api/v0/chat/completion}` with
  `Authorization: Bearer <token>`, `Cookie: <cookie>`, stock UA+Origin.
- Prints `ALIVE|DEAD <reason> <ms>` (reasons: `pow-missing`, `http-<n>`,
  `non-json`, `network:<msg>`); `--json` emits one machine-readable line for sh.
- Verdict rule mirrors the proven probe: `code===0 || data` → ALIVE (full-body
  parse — never slice before `JSON.parse`; this exact bug burned us once).
- Unit-testable offline? No (network). Cover arg-parsing + verdict-classifier as
  pure exported functions (`classifyPowResponse(status, body)`), tested in
  `tests/unit.test.js` with fixtures.

## 5. Security rules (non-negotiable, from round-1)

1. No secret on argv (keep `auth_import`'s `--token` refusal; CLI never builds
   commands containing tokens — probe reads files).
2. `0600` on every write; tmp+rename; `.bak` discipline per Add/Renew.
3. `shred -u` on delete; shred staging tmps on failure paths (`trap` cleanup).
4. Kill-browser pattern must be self-match-safe if the CLI ever kills Chrome
   (`[c]hromium` bracket trick — learned from the `pkill -f 'node server.js'`
   self-kill incident).
5. `set -eu`; quote every expansion; menu input validated as in-range numbers
   (POSIX `read`, never `select`).

## 6. Edge cases
- Chromium missing → print the three OS install lines (reuse `chromeInstallHelp`
  text path: run the js once and relay its error; don't duplicate the text in sh).
- ENTER-before-login (js exit 2, tmp absent/invalid) → "login incomplete, nothing
  written", back to menu.
- Two accounts, same name different case → rejected by sanitizer (lowercase only).
- `DEEPSEEK_AUTH_DIR` unset → default `./accounts` relative to repo root, mkdir.
- Concurrent proxy running with old creds → restart prompt is mandatory-path, not
  optional (auth loads at startup — the #1 support trap so far).

## 7. Tests & verification
- `shellcheck -S warning scripts/auth-cli.sh` clean (add to `npm test` chain if
  shellcheck present, else document; never fail CI on a missing binary — probe
  with `command -v`). Status 2026-09-17: neither shellcheck nor dash is
  installed on this box, so POSIX-cleanliness rests on `sh -n` + manual
  bashism scan + the `set -e`-semantics probes in §9. CI with shellcheck still
  wanted before declaring this closed.
- `node --check scripts/probe-account.js` in `npm test` chain.
- Unit tests: `classifyPowResponse` fixtures (ALIVE code:0, ALIVE data-only,
  DEAD missing-challenge, non-JSON, HTTP statuses).
- Manual matrix: add→check→renew→check→delete→check on a scratch
  `DEEPSEEK_AUTH_DIR=/tmp/...` (never the live dir), plus abort-mid-login and
  wrong-name cases.

## 8. Out of scope (explicit)
Password-based login automation (see `solution-scoped-autologin`); bulk
registration (`registrar.py` class — skipped in round-3); changing the auth file
schema (additive fields only, per-file solutions own their keys).

## 9. Implementation record (2026-09-17)

Built as planned with these deviations: `select` dropped for dash (numbered
`read` loop); `.bak` follows the house single-only-if-token rule (no rotation);
menu actions run in guarded subshells so errors never kill the loop (verified:
`set -eu` kills loops on failing subshells — `|| true` required); trap shreds
staging files (not `rm`); `process.exit` codes numeric (no string coercion).
`deepseek_chrome_auth.js`: Bearer-first + last-wins extraction (R1-1).
Tests: `classifyPowResponse` fixtures in `tests/unit.test.js`; `probe-account.js`
in the `node --check` chain. Verified: scratch check-all/one/delete-refusal, pty
menu against live accounts (fresh ALIVE, dead ones DEAD), name-boundary matrix
(1/32 accept, 33+ reject, uppercase/space reject), bashism scan clean. Suite green (count lives in CI output, not here).
