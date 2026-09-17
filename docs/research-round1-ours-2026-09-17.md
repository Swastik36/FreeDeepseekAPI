# Research round 1 — our own auth CLI + credential infra (2026-09-17)

Scope: `~/FreeDeepseekAPI/scripts/` + how `server.js` consumes credentials.
Method: full file reads (auth.js, auth_import.js:120, deepseek_chrome_auth.js:549).
No code changed.

## 1. Current CLI surface (what the user runs today)

| Entry | Command today | Behavior |
|---|---|---|
| Menu | `npm run auth` (`scripts/auth.js`) | Interactive menu: login / import / status / remove / help. `--login`, `--import`, `--status`, `--remove` flags |
| Browser login | option 1 → `scripts/deepseek_chrome_auth.js` | Spawns Chrome-for-Testing, user logs in manually, ENTER extracts |
| Import | option 2 → `scripts/auth_import.js` | Normalizes a ready file or cookie export → writes auth file |
| Single-file default | `deepseek-auth.json` at repo root | Used unless `DEEPSEEK_AUTH_PATH` / `DEEPSEEK_AUTH_DIR` set |
| Multi-account | `DEEPSEEK_AUTH_DIR=./accounts` | `server.js:discoverAuthPaths` sorts `*.json` → `account_1..N` |

Pain vs the requested CLI: everything is npm-wrapped, single-file-oriented
(`deepseek-auth.json` default), per-account add/renew/delete/check requires hand
`cp`/`rm`/`chmod` plus remembering env vars. No probe ("is this account alive?")
anywhere in the scripts — liveness is only observable via a live completion.

## 2. `deepseek_chrome_auth.js` — how extraction works (facts)

- Profile: disposable `DEEPSEEK_CHROME_PROFILE` (default
  `.chrome-for-testing-profile-deepseek`), wiped each run unless
  `DEEPSEEK_KEEP_CHROME_PROFILE=1`. Remote-debugging port `9334`
  (`DEEPSEEK_CHROME_PORT`). macOS-only stale-Chrome killer (`killExistingTestingChrome`
  returns early off darwin — Linux reuses whatever listens on 9334).
- Chrome resolution order: `CHROME_PATH` → puppeteer-bundled → puppeteer cache
  (`~/.cache/puppeteer/chrome/...`) → OS defaults. No Linux system-chromium
  fallback beyond `CHROME_PATH` (user's `CHROME_PATH=$(which chromium)` convention
  fills this; the script itself would fail with install help otherwise).
- Extraction (`readPageAuth`, after user presses ENTER, 20×500ms retries):
  1. `Runtime.evaluate`: dumps `localStorage` + `sessionStorage` + recent resource URLs.
  2. Token: scans stores for keys `userToken|token|auth_token|access_token|accessToken`,
     then any key matching `/token/i`. **LocalStorage wins unconditionally.**
  3. Cookies: `Network.getAllCookies` filtered to `deepseek.com$`, joined to a header.
  4. `x-hif-dliq` / `x-hif-leim` + `Authorization: Bearer` sniffed from captured CDP
     network events — but the Bearer is used **only if no store token was found**.
  5. `wasmUrl` from resource timing (`sha3*.wasm`), else hardcoded default.
- Persist (`persistAuthResult`): `.bak` written ONLY on success and ONLY if the
  existing file holds a token; tmp file created `0600` then `rename` (no
  world-readable window); `validatePageAuth` refuses to clobber on failure
  (regression-guard added after a real clobber incident — see §12 comments).

## 3. FINDING R1-1 (extraction order prefers the dead token)

Proven 2026-09-16: `localStorage.userToken` (92 chars) is **dead** (`40003 invalid
token`); the live API Bearer (64 chars) arrives only via request headers. The
script fills `token` from storage first and consults sniffed `Authorization`
only as fallback — i.e. the default path saves the dead credential. Any new CLI
must reverse the priority: **sniffed live Bearer first, storage token only as
fallback**, then verify with a `create_pow_challenge` probe before writing.

## 4. `auth_import.js` — reuse points for the new CLI

- `normalizeAuth()` accepts the token under 4 input keys (`token`,
  `access_token`, `accessToken`, `auth_token`) plus caller `extra.token` and the
  `DEEPSEEK_TOKEN` env, cookies as string / array /
  `{cookies: [...]}`, strips `Bearer ` prefix; `validateAuth()` enforces
  token+cookie+wasmUrl; `secureWriteJson()` = mkdir + `0600` write (+chmod).
- Security rule already established: **`--token` CLI arg is refused** (leaks via
  history/process list); token only via `DEEPSEEK_TOKEN` env or file. The new CLI
  must keep this rule — no secrets on argv, ever. Exported (`module.exports`)
  so a wrapper can reuse instead of reimplementing.

## 5. `server.js` auth consumption (load-time contract the CLI must satisfy)

- `discoverAuthPaths` (`server.js:359`): `DEEPSEEK_AUTH_DIR` → sorted `*.json`;
  the **hard** per-file requirement is `{token, cookie}` (ready filter
  `server.js:452`, `hasAuthConfig` `server.js:406`). Missing `wasmUrl` only
  warns (`server.js:387`); **`baseUrl` is never read by the server** — inert
  writer output from `deepseek_chrome_auth.js:381`, kept for format compat.
  (`hif_*` optional, may be `''`.)
- Account id = sorted position (`fresh.json` sorts first → `account_1`). **File
  naming controls identity** — the CLI's add/renew must preserve filenames on
  renew (never rename on refresh) or sticky sessions + `DEEPSEEK_PREFERRED_ACCOUNT`
  silently repoint.
- Auth loads once at startup: after add/renew/delete the service must restart
  (`systemctl --user restart freedeepseek.service` here; generic fallback
  `pkill -f '[s]erver\.js'` + `NON_INTERACTIVE=1` start is documented from a real
  incident where `pkill -f 'node server.js'` matched the caller's own shell).
- Multi-account pool today: score-based routing over the ready set, sticky
  `accountId` per agent session, fail-fast 429 when all cool. **No hourly quota,
  no device fingerprint, no upload** (see round-3 gaps).

## 6. Requirements distilled for `solution-auth-cli`

1. Per-account files in `DEEPSEEK_AUTH_DIR` as the only model (retire the
   single-file default in UX, keep supporting it).
2. Add = name → validate filename → launch Chromium → wait ENTER → extract with
   **Bearer-first priority (R1-1)** → probe `create_pow_challenge` → write
   `0600` (+`.bak` on renew) → offer service restart.
3. Renew = pick existing (never rename) → same pipeline → `.bak` guaranteed.
4. Delete = pick → confirm → `shred -u` (secret file, don't just `rm`).
5. Check = pick one/all → probe each → `ALIVE/DEAD (+latency)` table, no secrets printed.
6. Extras worth adding: cURL/Network-header import (paste headers → parse, avoids
   browser entirely), `doctor` shortcut, backup rotation (timestamped copies),
   restart-service prompt after any mutation.
7. Never: secrets on argv, secrets in logs, `pkill -f` self-match pattern.
