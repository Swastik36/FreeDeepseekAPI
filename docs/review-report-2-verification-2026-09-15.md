# Second Review Report — Verification (2026-09-15)

Source: `~/Downloads/review-report.md` ("Independent Code Review Report (Second Pass)").
Method: every numbered item re-checked against the live tree (`server.js` + scripts +
store + logs); suite re-run here: **99/101** (same 2 genuine reds as report #1's R1/R2:
rollover + BUG-B policy tests vs gutted no-new-chats helpers).
Note: reviewer worked without `tests/`, `.gitignore`, `client.js` (honest scoping) and
their line numbers run ~80 ahead of this tree — bundle drift; all verdicts below are
against the live tree, including one refutation caused by that drift.

# DA record (solo, three loops, no agy/subagents — 2026-09-15)
Loops 1–2: attacked everything; demoted the impactless, killed the false. Pre-DA
backup: `/tmp/rr2-backup-pre-da.md`. Loop 3 (this round): attacked ALL survivors
again, including resurrection attempts on every kill. Two elevations, one new bug:
multi-partial silent narrowing (proven live below) and hostname disclosure were
elevated to LOW; cookie fallback was elevated back to LOW (full-jar import is a
supported flow, not contrived).

## Stands — fix these
1. **Numeric `parentMessageId` dropped by `serializeSession`** (MEDIUM). Survived three
   loops: store shows 28/28 null while logs advance even-int parents (2,4,…,24, +2 per
   turn = upstream message counter); a string-typed id would survive the guard, so the
   all-null store is strong evidence of integer ids coerced away. Silent post-restart
   threading loss. Fix: accept string|number.
2. **Cookie-import fallback too broad** (`auth_import.js:31`, LOW). Second clause
   matches any `deepseek`-containing domain; full-browser-cookie import is an
   explicitly supported flow (auth menu item 2), so a hostile jar is in-bounds, not
   contrived. Fix: anchor the fallback to `deepseek.com` or drop it.
3. **NEW — multi-turn silent narrowing on unknown tools** (LOW). Proven live with
   production code: `[valid read, unknown evil_tool]` → `parseToolCalls` correctly
   refuses (null), but the fallback `parseToolCall` delivers ONLY `read` — `evil_tool`
   vanishes with zero signal (no log, no error, no repair; `toolCall` set means the
   repair trigger never fires). Single-unknown today fails LOUD (repair → likely 502);
   multi-unknown-half fails SILENT, leaving the model believing an unexecuted call ran.
   Fix: when multi refuses but single parses and leftover envelopes exist, route to
   the repair path instead of silently narrowing.
4. **Hostname/public-IP in tool prompt** (LOW). `formatToolDefinitions` sends
   `os.hostname()` + first non-internal IPv4 to DeepSeek on every tool turn; repo
   explicitly supports VPS deployment, where that is a public IP. Orienting the model
   needs only "the proxy host". One-line fix.
12. **Smoke default port** (trivia — `9665` vs `9655`, docs say `9654`).
13. **Doc drift** (backlog — port, legacy `TOOL_CALL:`, `security-guy`, reset table;
   no external consumer found, but the no-new-chats brief already mandates the §6.1/
   §10 update in its diff).

## Demoted to notes/trivia (defect real or plausible, impact ~nil)
3. **413 unreachable** — `destroy()` suppresses `end`, but client payloads are
   bounded (~80k ≪ 10MB) and localhost-only. Trivia.
5. **Empty-exhaustion type** — cosmetic; no client branches on `type` (opencode
   surfaces `message`). Accuracy-only backlog.
9. **`uncaughtException` log-and-continue** — zero occurrences in 7d; exit(1) would
   also drop all in-flight turns. Theoretical both ways; hygiene note.
- **F12 lean budget** — verified present; breaks only with enormous tool sets.
  Trivia.

## Killed across the three loops (removed from findings, recorded here)
- **Item 4, Anthropic/Responses index** — refuted with a full path trace (offset=1 ⟺
  block 0 emitted); resurrection re-attacked the single `streamOpts` construction
  site and failed again. Dead.
- **`/readyz` counts, `client.js` path claim, `removeProfileSafely` corner** — dead
  (by-design probe; file is at repo root = bundle drift; main-catch exits cleanly).
- **Items 6, 7, 10, 11** — accepted v1 limitation / negligible / sweeper-bounded /
  tested R2 design. Notes, not findings.

## Net
Post-DA fix list: **items 1–4** (+12/13 as trivia/backlog). Three attack loops,
solo; backup of the pre-DA file retained. Reviewer batting average holds — with the
standing correction that item 4-style overclaims are why verification repeats.

---

# Later verification rounds — collected (2026-09-15, subagent-assisted, DA-verified)

## A. Subagent verdict table (H/M batch) — adjudicated
- H1 (fetch-timeout covers body), H2-partial (content buffered, reasoning mid-stream),
  H3 (no per-agent lock), M1 (`finish_reason:'error'`), M2 (Responses `[DONE]`) —
  agree. M3 (134KB sync persist/turn) agreed, watch long-term.
- Two corrections: M8's "spawnSync unused" is false (used by auth flows at
  `:3653,:3687`; core sync-WASM claim stands); M9 accepted with precision
  (pre-stream compaction headers DO land at `:3220/3231`; only the in-loop call is
  best-effort).
- Prior dirty state: subagents were failing with malformed-markup transport errors
  during this window; results above come from runs that completed — treat any
  single failed run as transport noise, not signal.

## B. Translators batch (explore 7 + DA verification)
- **1. Truncation discarded on shims — CONFIRMED.** `length` → `end_turn`/`completed`
  on both shims (+ streams). Fix: map `length` → `max_tokens`/`incomplete`.
- **2. Image fallthrough dumps base64 — CONFIRMED.** Non-`image_url` blocks hit
  `JSON.stringify(part)`; 200-char b64 probed verbatim into prompt, bounded only by
  the 80k cap. Fix: placeholder + omit data.
- 3. Multi-`tool_use` split — WEAKENED to cosmetic (Responses splits too; downstream
  self-consistent; no delta/correlation consequence).
- **4. `[Tool Result]` drops id/name/is_error — CONFIRMED**, bounded (flat text prompt
  can't use correlation anyway; single-tool turns unambiguous). Cheap upgrade.
- 5. Object-args silent `{}` — mechanism real, reachability DEAD (all producers
  stringify; only hand-constructed calls could trigger — 3-line guard at most).
- 6. Missing item `status` — negligible (top-level carries the signal).
- **7. Non-array messages → 500 not 400 — CONFIRMED.** Normalization precedes the
  guard. Fix: validate before/in normalization.
- NEW from DA: (a) role-style assistant `tool_calls` arrays DROPPED by
  `normalizeResponsesInput` (Med/Low — prior tool context starved); (b) instructions-only
  input slips past the empty guard (Low); (c) continuation `finish_reason` never
  reaches shim streaming events (Low, compounds #1).
- Minors all confirmed (tool-type coercion, dropped `strict`/`cache_control`, ignored
  `tool_choice`/`max_tokens`/`stop_sequences`, reasoning in `output_tokens`). Clean
  claims spot-checked 6/6 hold. Fix list: **1, 2, 7** (+6 opportunistically).

## C. Upstream/retry/concurrency batch (explore 6 + DA verification)
- **1. SSE tail flush — CONFIRMED, weakened Med→Med.** Unterminated final `data:`
  event is dropped (probed: without trailing `\n` → `content=""`), causing spurious
  empty-retries. Reachability edge (close/truncation without terminator), cheap
  3-line fix (flush residual + final `decoder.decode()`).
- **2. Exhaustion type hardcode — CONFIRMED.** Only `.status` used; context/timeout
  get `tool_call_failed`. Fix: pass through `failureClass.type` (one line). Note
  this supersedes the older item-5 note with the exact fix.
- 3. Unconditional retry prefix — note (wasteful, guarded fallbacks exist; mint-side
  is equally unguarded).
- 4. No per-agent lock — note/document (race mapped precisely: double-mint window
  + parent/history cross-link; self-healing via boundaries; sequential clients
  unaffected; a lock is a design change).
- 5. No client-abort on fetch — note (60s fetch timeout + 120s deadline bound it).
- **6. Non-FINISHED status → finishReason — CONFIRMED + stronger consequence.**
  Transient PENDING/STREAMING leak to clients via the OpenAI streamer AND trigger
  spurious auto-continuations on long replies. Fix: allowlist at `:1047` + sanitize
  at `:2505`.
- NEW: N1/N2 are the `:2505`/continuation halves of #6. Clean claims: all 8 checked
  HOLD. Fix now: **#1, #2, #6**.

## D. Persist-area batch (prior DA-verifier round)
- Writes-after-end: try/catch cannot catch async delivery (no `res.on('error')`);
  safety rests on silent no-ops + global handler. Residual Low: error listener or
  pre-checks.
- Persist is 2×/turn back-to-back (~1ms at 200KB) — coalesce opportunistically.
- Privacy comment imprecise (about the hash, reads file-scoped) — one-line scope fix.
- Restore TTL bypass confirmed Low (restart-resurrection edge, sweeper-bounded).

---

# Persist-area findings — independent verification (DA-verifier round, 2026-09-15)
Prior reviewer (first success after subagent outage) claimed 2 kills + 3 findings;
verifier re-attacked all of it (128/128 green on its own run, probes on temp stores,
live file sized via stat only — ~200KB/31 sessions, never read).

- **KILL-A (unguarded stream writes) — WEAKENED, outcome safe but mechanism wrong.**
  Nesting confirmed (handler try/catch → sendStreamError with guards), but the
  synchronicity premise is false on this stack: destroyed-socket `res.write` returns
  false silently, and write-after-`end` surfaces `ERR_STREAM_WRITE_AFTER_END`
  *async* (no `res.on('error')` listener exists anywhere — only `res.on('close')`),
  landing in the log-only `uncaughtException` handler. So try/catch cannot catch the
  cited error; safety rests on silent no-ops + the global handler instead. Residual
  Low: add `res.on('error', …)` or `writableEnded||destroyed` pre-checks in
  `finish*Stream`.
- **KILL-B (`/new` needs no guard) — CONFIRMED clean.** State commits before reply,
  fixed bounded payload, no upstream call in between; inside the outer try.
- **Persist hot path — WEAKENED (real redundancy, ~10x overstated impact).**
  Full-map blocking persist confirmed, but measured 0.50ms median at 200KB
  (~1ms/turn for the 2 per-turn persists; ~24ms serialized stall at full 24-way
  concurrency). Real redundancy: per-turn persists happen twice back-to-back
  (messageCount bump at `:3464` + history push via `storeHistory` at `:2601`) —
  coalesce to one. Also corrected the call-site list (prior claim mixed hot + rare
  and missed the second hot persist; `getOrCreateAgentSession` persists only on
  create — good). Fix opportunistically, not urgently.
- **Privacy comment — WEAKENED to imprecise, not misleading.** The sentence covers
  `repairHash` (true of the hash alone); `history[]` verbatim persistence sits
  below it with 0600 mitigation confirmed. One-line scope fix.
- **Restore TTL bypass — CONFIRMED Low.** Null-`id` entries skip prune and are
  resurrected on restart while stale id-ful ones drop; bounded by the 10-min sweeper
  (4h threshold), so the amplifier is unique-ID creation rate vs sweep.
- **Self-withdrawal (numEnv) — CONFIRMED correct.** Both constants are hardcoded
  literals; no env override path exists.
- **New from verifier:** async write-after-end → `uncaughtException` path (Low, same
  fix as KILL-A residue); per-turn double persist (Low, coalesce).

---

# DA-subagent new issues — expanded (2026-09-15, all re-verified in-tree)

## N1. Prompt contradicts itself on batch cap (Medium — the real catch)
- Evidence: `server.js:1296` says "1-8 newline-delimited … objects", `:1299` says
  "max 8 tools/turn", but the REMEMBER trailer at `:1325` still says "strict-JSON
  1-4 … lines". The model reads all three every tool turn.
- Impact: whichever line the model weights decides the batch size. A model anchoring
  on the trailer caps itself at 4 (halving the cap-8 throughput just shipped); one
  anchoring on 1-8 may emit 5–8 calls the old trailer-trained path never exercised.
  Either way the inconsistency — not the cap value — is the compliance leak, and it
  lands exactly on the read-heavy work the cap raise was for.
- Fix: one line — change the trailer to "strict-JSON 1-8 … lines". Then re-probe a
  2-batch live to confirm compliance didn't shift.

## N2. Dead `require('os')` (Low)
- Evidence: `server.js:15` imports `os`; zero `os.` references remain repo-wide
  (hostname/IP removal was complete — verified by grep across `server.js`,
  `scripts/`, `lib/`, `client.js`). Harmless dead import; delete the line.

## N3. Unclaimed scope + error-type rename compat (process note, no code hole)
- The working diff spans all prior rounds (multi-tool, no-new-chats, fingerprinting,
  title-gen), each previously audited here — so no new hole, but review scoping must
  name the full surface in future rounds.
- Compat point verified: zero production references to `malformed_tool_call` remain
  in `server.js` (only fixture strings in `tests/unit.test.js:1461-1476`), so the
  rename to `tool_call_failed` is complete — and therefore breaking for any external
  integrator matching the old string. opencode itself doesn't branch on it (displays
  `message`), so local impact is nil; record the break explicitly rather than
  discovering it later. Fix: one line in the docs' error table + a note in the fork
  README if external users exist.

## N4. Docs drift + test gaps (minor, itemized)
- Port drift is worse than reported: `9654` appears at `docs/api-documentation.md`
  `:8,:19,:430,:570,:593,:600-605` against the real default `9655` (smoke default now
  fixed to match). Same doc embeds a literal VPS address
  (`161.97.175.214`, `host2.onldigital.com` at `:7,:430`) — a real third-party IP in
  print, worth scrubbing while touching the file.
- Hostname test (`tests/unit.test.js:2237`) asserts the "proxy host" phrasing and
  absence of `192.168.`/`10.x`, but not `172.16-31.x`, public-IP shapes, or the actual
  machine hostname. Strengthen with a generic IPv4 pattern + `os.hostname()` inequality
  (or drop the test to a comment if machine-coupling is unwanted).
- Leftover-envelope test covers mixed + single-prose only; add a valid+garbage case
  (trailing non-JSON text after valid envelopes must still deliver, not repair-loop).

## Still open from earlier rounds (not fixed, carried forward)
- **Empty-exhaustion type split**: `tool_call_failed` for empty upstream responses
  mislabels; needs `empty_response`/`request_timeout` (repair path keeps its own).
- **`uncaughtException` log-and-continue** (`server.js:3716`): zero occurrences in 7d;
  exit(1) + `Restart=always` is safer than serving on possibly-torn state.
- **Continuation stop+long refinement**: skip auto-continue when
  `finishReason === 'stop'` (latent; sole observed firing was legitimate INCOMPLETE).
- **`/new` footgun**: literal `/new` message wipes session silently. Trivia.
- **Upstream chat leak (systemic)**: resets/rollovers/sweeps abandon remote chats;
  no delete call exists. Needs upstream API recon.
- **No per-agent lock**: documented, boundary-checked, accepted.
- **F12 lean budget**: breaks only with enormous tool sets. Trivia.
- **413 unreachable / cookie note / positional IDs**: trivia-grade, recorded.
