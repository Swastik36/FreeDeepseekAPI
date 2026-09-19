# Why Unit Tests Hit the Live Network (and Break Under Env Overrides)

Date: 2026-09-19. Tree: `swastik-mods` @ `c4fc4b0` + README commit `1966582`.
Status: H-3 test makes a real outbound request (≈417ms); M-B pin test fails under a
dirty parent env (proven). M-B's human-bypass half is hermetic; H-3 is not.

---

## 1. What is appearing

- `node --test --test-name-pattern="H-3" tests/anti-suspension.test.js` takes
  **≈417ms** for one test (measured `417.487255ms`). Pure-logic tests in this file
  take <1ms. The time goes to a live HTTPS round trip to `chat.deepseek.com`.
- `DEEPSEEK_AGENT_TURN_GAP_MS=3000 node --test` fails the M-B pin test with
  `AGENT_TURN_GAP_MS must be 6000ms`, although the shipped default is untouched.

Both are test-harness artifacts, not product bugs. Neither affects the running proxy.

---

## 2. Why the H-3 test reaches the network (file/line trace)

The test (`tests/anti-suspension.test.js:574-651`) drives the real
`askDeepSeekStream` in a child process to prove the reservation serializes two
turns. Its Call 1 uses `lastDispatchedAt = now - 10000` with gap 6000/jitter 0,
so the gate computes delay 0 and takes the `proceed` branch — which performs **no
network I/O itself**. The test then falls through to the turn body:

1. `tests/anti-suspension.test.js:585-592` — Call 1 invokes
   `serverInternals.askDeepSeekStream(...)` with a fake `token: 't'`.
2. `server.js:1848-1898` — the pacing gate. `proceed` path: reservation stamped,
   no sleep, no fetch. Gate is innocent.
3. `server.js:1919` — `await dsFetch('https://chat.deepseek.com/api/v0/chat/create_pow_challenge', …)`.
   `dsFetch` (`server.js:38-39`) is the real global `fetch` with a 60s abort timeout.
   **Nothing between the test and this line replaces it.**
4. Upstream answers 401 (fake token) in ≈400ms → `markAccountFailure` → throw →
   test catches and continues. The 417ms is that round trip.

Contrast the M-B human-bypass test (`tests/anti-suspension.test.js:706-763`), which
installs `global.fetch = async (url) => …` (`:738-743`) intercepting
`create_pow_challenge` with an immediate non-ok response, restoring the original in
`finally` (`:757`). Same call chain, zero network, ≈1.5ms. The H-3 child simply
never got the equivalent interception.

### Why it passes anyway (and when it stops passing)

- **Today:** upstream fast-fails the fake token, so the test is slow but green.
- **Offline with packet drop (not DNS refusal):** `dsFetch` hangs until
  `DS_FETCH_TIMEOUT_MS` (60s) — the suite stalls for a minute on one test.
- **Slow network (>6s for Call 1):** Call 2's reject math assumes Call 1 settled in
  milliseconds (`elapsed ≈ 400ms → delay ≈ 5600ms → reject`). Past ~6s elapsed,
  Call 2 takes `proceed` instead, hits the network itself, and the test fails on a
  different assertion. Two independent timing dependencies, one test.
- **Fix:** port the M-B interception (`tests/anti-suspension.test.js:734-757`
  pattern) into the H-3 child: return non-ok for `create_pow_challenge`, assert the
  reservation/timing behavior without leaving the process.

---

## 3. Why the M-B pin test breaks under env overrides (file/line trace)

1. Pacing knobs are **load-time constants**: `server.js:1092-1094`
   (`numEnv('DEEPSEEK_AGENT_TURN_GAP_MS', 6000, 0, 60000)` etc. read
   `process.env` once at `require` time; `numEnv` itself at `server.js:26-35`).
2. The pin test (`tests/anti-suspension.test.js:707-710`) asserts the **loaded
   module's** constants equal the shipped defaults — so any parent
   `DEEPSEEK_AGENT_TURN_GAP_MS` in the environment changes what was loaded and the
   assert fails. Proven: `DEEPSEEK_AGENT_TURN_GAP_MS=3000 node --test` →
   `AssertionError: AGENT_TURN_GAP_MS must be 6000ms`.
3. Same mechanism bites the spawned children from the other side: M-D's children
   (`tests/anti-suspension.test.js:653-670`) spread `...process.env`, so a parent
   `DEEPSEEK_REQUEST_DEADLINE_MS` (unbounded at `server.js:587`) silently redefines
   what "over the max" means and flips the clamp assertions.
4. **Fix:** pin/clear the relevant `DEEPSEEK_*` keys explicitly in every spawned
   child env instead of spreading `process.env` blindly.

---

## 4. What does NOT need fixing

- The M-B human-bypass half is correctly hermetic (mock + `finally` restore).
- `resolvePacingAction` unit tests are pure (explicit params, injected `rand`).
- The product gate never makes extra network calls: one turn is still exactly one
  PoW challenge + one completion request. The network traffic comes from the test
  invoking the real turn body, not from pacing logic.
- `server.js:38-39` needs no seam for this: tests can assign `global.fetch`
  (as M-B proves); `dsFetch` calls the global through.
