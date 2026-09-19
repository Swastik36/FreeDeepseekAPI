# Contributing to FreeDeepseekAPI

Thanks for considering a contribution. This project is a local, zero-dependency
Node.js proxy in front of DeepSeek Web Chat. Keep changes small, tested, and
free of new runtime dependencies.

## Prerequisites

- Node.js 18 or newer (`package.json` enforces `>=18.0.0`).
- No npm dependencies are installed at runtime or test time. Do not add any.
- A Chromium/Chrome install for the interactive login (`npm run auth`).

## Getting started

```bash
git clone https://github.com/Swastik36/FreeDeepseekAPI.git
cd FreeDeepseekAPI
npm run auth      # opens the login flow, writes deepseek-auth.json
npm start         # starts the proxy on http://localhost:9655
npm test          # syntax checks + unit + anti-suspension suites
```

Live smoke tests against a running proxy:

```bash
BASE_URL=http://127.0.0.1:9655 MODEL=deepseek-chat npm run test:live
```

If something stops working, run `npm run doctor` first — it checks the auth
files, JSON validity, and (online) PoW endpoint reachability.

## Project layout

- `server.js` — the proxy: API shims, account pool, routing, retries, streaming.
- `client.js` — small CLI client.
- `lib/pow.js` — proof-of-work WASM solver.
- `scripts/` — auth, import, doctor, probe, and live smoke helpers.
- `tests/` — `unit.test.js` and `anti-suspension.test.js` (run by `npm test`).
- `docs/` — design notes, briefs, and verification reports.
- `chrome-extension/` — optional browser helper.

## Tests

`npm test` runs `node --check` over the main entry points and scripts, then all
test files with the built-in `node:test` runner. `tests/update.test.js` and
`tests/install.test.js` shell out to `git` and `sh`, so the test target assumes
both are on `PATH` (the installer already requires them).

Rules that are easy to get wrong:

- **Point the session store at a temp dir.** Any test that loads `server.js`
  must set `DEEPSEEK_SESSION_STORE` to a temporary path *before* `require`.
  Loading the server without it can wipe the live `.sessions.json`.
- **Do not touch the live account or session files.** Tests use temporary
  fixtures only.
- **Pure helpers are exported for tests.** When you add logic that can be
  tested without network or timers, expose it via the `__test` object and test
  it directly.
- **New behavior needs a test.** Bug fixes should include a regression test;
  new knobs should assert both the default and the boundary.

## Adding a configuration knob

1. Read it with `numEnv(name, default, min, max)` so invalid values warn and
   fall back instead of poisoning runtime behavior. Pass a real `max` when the
   value has a safe ceiling; if you omit it, say why in a comment.
2. Document it in `README.md` next to the related knobs.
3. Add a test that pins the default and at least one boundary.
4. Keep the default conservative; behavior-changing defaults need a reason in
   the commit message.

## Security rules

Auth material is live access to a DeepSeek account. Never commit it.

- Never commit `deepseek-auth.json`, `accounts/*.json`,
  `accounts-quarantined-*/*.json`, `.sessions.json`, `.env`, or any browser
  profile directory (`.chrome-profile-*`, `.chrome-for-testing-profile-*`).
  These are covered by `.gitignore`; do not force-add them.
- The `accounts/` rules cover the `*.json` files **and** their `.bak`/`.bak-*`
  siblings — the auth CLI writes those backups and they hold the same secrets.
  If you add a new secret-bearing path, ignore its backups in the same change.
- Store auth files with `0600` permissions.
- Do not log tokens, cookies, or session ids. Use the existing redaction and
  `logToken` helpers.
- When adding a new file that can contain secrets, add it to `.gitignore` in
  the same change.

## Code style

- Zero runtime dependencies. Standard Node APIs only.
- Minimal diffs. Match the surrounding house patterns rather than introducing
  new abstractions.
- Back up before large edits (for example `cp server.js /tmp/server.js.bak`).
- Keep comments about *why*, not *what*; this codebase relies on them to avoid
  regressing hard-won fixes.
- Run `npm test` before opening a pull request. A change that fails the syntax
  checks fails everything.

## Commits and pull requests

- Write a plain, descriptive commit message; say what changed and why.
- One logical change per commit where practical.
- Do not commit unrelated formatting churn alongside a fix.
- Pull requests should describe the problem, the change, and how it was
  verified (tests run, live checks, etc.).

## Reporting bugs

Open an issue with:

1. The command you ran and the request/response involved (redact tokens).
2. `npm run doctor` output.
3. Relevant server log lines.
4. Node version and OS.

## License

By contributing you agree your contributions are licensed under the MIT
License (see `LICENSE`).
