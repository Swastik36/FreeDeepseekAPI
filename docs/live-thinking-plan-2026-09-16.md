# Live thinking (progressive) + thinking-phase timing — implementation plan

Status: PLANNED, not implemented. Nothing below has been applied to the tree.
Line numbers are worktree-current as of `4c1cac5` + uncommitted paperwork
(docs amend, patch-op log, snapshot guard). Re-verify each with `grep`
before editing — numbers drift.
Revised 2026-09-16 post-verification: C-1 (hold-back window),
C-2 (progress hook before transition), H-1 (sanitize parity) corrections
applied; M-1/M-2/M-3/M-4/M-6 cleanups applied. Do not use any earlier
revision of this plan — it would leak partial payloads (C-1) and
double-emit thinking (C-2).
Revised again 2026-09-16 (re-review round): MED-1 (`sawThinking` split
from `emittedAny`), MED-2 (idempotence pin), MED-4 (`liveThinkingMode`
predicate + truth table), LOW-1/2/3/4/6 notes; MED-3 closed by
verification, no plan change.

## 0. Decision: packets every ~2s, NOT word-by-word

Packet-by-packet wins, for five concrete reasons:

1. **Overhead.** Per-word emission = hundreds of `res.write` syscalls and
   client re-renders per turn for zero information gain. A 2s packet is a
   handful of writes. The user explicitly asked for less overhead.
2. **Redaction safety.** The whole-string-first rule (`server.js:2959-2960`)
   exists because per-slice redaction leaks payloads straddling chunk
   boundaries. Smaller slices = more boundaries = more leak surface.
   2s packets keep slices large and few.
3. **Upstream reality.** THINK fragments already arrive in bursts, not words.
   Per-word emission would just re-slice our own accumulator — fake
   granularity at real cost. Packets match the actual arrival shape.
4. **Perception.** A 2s burst still reads as "live" in the TUI. Nobody can
   perceive per-word deltas on a thinking block; the gain is imaginary.
5. **Wire fit.** The existing convention slices reasoning into 50-char SSE
   chunks. A 2s packet sub-slices naturally into the same shape — no new
   chunk format, no client-side surprises.

Parameters: `THINK_LIVE_INTERVAL_MS = 500`, first packet immediate (fast
feedback), subsequent packets throttled. Throttle constant lives next to
the factory so tests can override it with a fake clock. (Was 2000 during
initial verification; 500 chosen after seeing it live — cadence only,
safety comes from the hold-back window, not the interval, so no new
risk class. Diminishing returns below ~0.5s: TUI render churn approaches
per-word costs.)

## 1. `consumeDeepSeekStream`: add `onReasoningProgress` hook

Target: `server.js:1074` (signature), `~1083` (state decl),
inside `handleDataLine` BEFORE `checkReasoningTransition()` (`~1170`) —
placement is load-bearing (C-2, see WHY).

```js
// signature:
async function consumeDeepSeekStream(readable, { onReasoningDone, onReasoningProgress, isClientGone } = {}) {
// state, next to `let reasoningFlushed = false;`:
    let lastProgressThink = '';
// inside handleDataLine, after the response/status branches, BEFORE checkReasoningTransition(); :
                if (lastPath === 'response/status' && d.v !== undefined && d.v !== 'FINISHED') {
                    finishReason = d.v;
                }
                // Progress FIRST, transition second (C-2): on a combined
                // THINK+RESPONSE snapshot the pump must emit before
                // onReasoningDone runs. Placed after, the legacy burst fires
                // on emittedAny==false and progress then re-emits the same text.
                if (typeof onReasoningProgress === 'function' && reasoningContent !== lastProgressThink) {
                    lastProgressThink = reasoningContent;
                    try { onReasoningProgress(reasoningContent); } catch (e) { }
                }
                checkReasoningTransition();
```

WHY each piece:

- New option (not a change to `onReasoningDone`): the existing callback
  means "thinking phase is over, here is the whole text." We need a second
  signal meaning "thinking grew, here is everything so far." Reusing the
  old one would conflate completion with progress and break its two
  existing callers' assumptions.
- String-inequality check (not length check): snapshot replacements can
  shrink or rewrite text; any change must notify so the pump's prefix-hold
  (§2) can decide emit vs hold. Comparing costs one reference/value check
  per upstream line — negligible.
- Value comparison suffices: `!==` on strings compares by value, not
  identity, so identical content doesn't re-push; no identity semantics
  involved and none should be assumed.
- Placement before the transition (not after): `appendFragments` /
  `rebuildFragmentState` already ran higher in `handleDataLine`, so
  `reasoningContent` is current; firing progress first is what makes the
  §3 `emittedAny` check valid and keeps combined snapshots exactly-once.
- Empty string notifies once at most (`lastProgressThink` starts `''`);
  the pump ignores empties, so no empty chunks ever hit the wire.

Pass-through in `readDeepSeekResponse` (call site `~4103-4110`,
`onReasoningDone: opts.onReasoningDone` line):

```js
        const resResult = await consumeDeepSeekStream(readable, {
            onReasoningDone: opts.onReasoningDone,
            onReasoningProgress: opts.onReasoningProgress,
            isClientGone: () => clientGone,
        });
```

WHY: all six `readDeepSeekResponse` call sites (main read, empty
retries, migration, continuation, strict retries) default to `readOpts`,
so one wiring covers main + retry + continuation reads with no per-site
changes. Retry reads feeding the same pump is intentional (see §3,
`reset()`).

## 2. New `createThinkingPump` factory (place `~2714`, next to `emitReasoningPhase`; export in `__test` next to `emitReasoningPhase`, `server.js:4758`)

```js
const THINK_LIVE_INTERVAL_MS = 500;
// Hold-back (C-1): never emit within this many chars of the cumulative
// frontier. A data: payload completing inside the withheld window would
// otherwise cross the wire raw (sub-floor) and redact only later.
// Equals the redactor floor so any completable match is fully decidable.
// Both redactor passes floor at 64 today; if those floors ever diverge,
// HOLD must cover the maximum (LOW-4).
const THINK_HOLD_BACK_CHARS = EMBEDDED_DATA_URL_MIN_LENGTH;
function createThinkingPump({ intervalMs = THINK_LIVE_INTERVAL_MS, onEmit, label = '' } = {}) {
    let sent = '';       // held-back redacted text already live-emitted; always a prefix of some redacted cumulative
    let lastEmitTs = 0;
    let startTs = 0;     // first non-empty think arrival
    let endTs = 0;       // last think arrival (any non-empty push; revisions inflate this — phaseMs is an upper bound, LOW-3)
    // Sticky: once anything has crossed the wire, later re-bases must not
    // un-claim emission (else the legacy burst re-arms and duplicates).
    let everEmitted = false;
    return {
        push(fullThink, now) {
            if (!fullThink) return;
            if (!startTs) startTs = now;
            endTs = now;
            let clean;
            try { clean = redactEmbeddedDataUrls(sanitizeContent(fullThink)); } catch (e) { return; }
            // Diverge → re-base (not hold-forever): upstream revision or a
            // data: payload completing past the floor rewrites already-sent
            // bytes. Re-basing to the longest common prefix resumes live
            // emission instead of stalling until a full finish burst.
            // Already-shown text may partially re-appear corrected — bounded,
            // and strictly better than stall-then-duplicate.
            if (!clean.startsWith(sent)) {
                let lcp = 0;
                const n = Math.min(sent.length, clean.length);
                while (lcp < n && sent.charCodeAt(lcp) === clean.charCodeAt(lcp)) lcp++;
                try { console.log(`[think] Live thinking diverged, re-based${label ? ` ${label}` : ''} (in=${fullThink.length}, sent=${sent.length}, clean=${clean.length}, lcp=${lcp})`); } catch (e) { }
                sent = clean.slice(0, lcp);
                return;
            }
            // Frontier hold-back: emit only what is safely behind the window.
            const frontier = Math.max(sent.length, clean.length - THINK_HOLD_BACK_CHARS);
            if (frontier <= sent.length) return; // nothing safe to emit yet
            if (sent && now - lastEmitTs < intervalMs) return; // throttle; first emit immediate
            const tail = clean.slice(sent.length, frontier);
            sent = clean.slice(0, frontier);
            lastEmitTs = now;
            everEmitted = true;
            // Crash-consistency note: sent advances before res.write, so a
            // write throw loses this tail (finish tops up from the advanced
            // sent). Accepted: a throwing socket is a dead turn anyway, and
            // the alternative (emit-then-record) duplicates on retry.
            try { onEmit(tail, sent); } catch (e) { }
        },
        reset() { sent = ''; lastEmitTs = 0; startTs = 0; endTs = 0; },
        // everEmitted is STICKY across re-bases (Concern-6 fix): a full
        // revision rewinds sent but must never re-arm the legacy burst over
        // already-streamed packets. sawThinking gates timing (MED-1).
        state() { return { sent, phaseMs: startTs ? endTs - startTs : 0, emittedAny: sent.length > 0, everEmitted, sawThinking: startTs > 0 }; },
    };
}
```

WHY each piece:

- Factory (not inline closure): deterministic unit tests with a fake
  `now` — time-throttle logic is untestable if `Date.now()` is hardcoded
  inside the handler. Export via `__test` like the other internals.
- Sanitize-then-redact, mirroring the finish pipeline exactly (H-1):
  `redactEmbeddedDataUrls(sanitizeContent(fullThink))` matches what
  `finishOpenAIStream` redacts (`msg.reasoning_content` was sanitized at
  `~4131` before building). Same input → identical output → the prefix
  invariant holds; lone surrogates can no longer diverge it. (Finish
  double-redacts an already-redacted string — harmless, wasteful, leave it.)
- Hold-back window (C-1): emission frontier stops `THINK_HOLD_BACK_CHARS`
  short of the cumulative end, so an in-flight sub-floor payload never
  crosses the wire raw. Consequence, stated plainly: thinking shorter
  than ~64 new chars never streams live — it arrives at finish, exactly
  like today. No regression, just no gain on tiny thoughts.
  Boundary (LOW-1, policy-consistent, pinned by test 4 second half): a
  terminal sub-floor URL followed by non-continuation prose emits raw — it
  can never grow afterward (match terminated) and finish exposes the
  identical string, so this is the redactor's documented floor behavior,
  not a new leak class.
- Prefix-hold covers upstream revisions ONLY (rewritten text won't start
  with `sent`). It never covered sub-floor partials — the earlier plan
  text claiming "nothing unredacted crosses the wire" was false and is
  struck. Three sub-mechanisms (sanitize parity, hold-back, prefix-hold),
  each with its own test (§6.4, §6.5, §6.2) — not one mechanism.
- Residual: three redaction call sites (pump, `emitReasoningPhase` via
  `onReasoningDone`, finish) each re-derive the string. Durable fix is
  one shared sanitize-then-redact helper (follow-up, §8) — this plan
  keeps the three sites byte-identical by construction instead.
- First-emit-immediate: otherwise short thinking (< 2s) would never emit
  live at all and the feature would be invisible on fast turns.
- `state()` non-destructive (not a consuming `finish()`): multi-phase
  thinking (more THINK after response started) keeps extending `sent` and
  `endTs` after any read. A locking finish would corrupt that.
- `phaseMs = last − first arrival`: exactly the user's spec — measures
  the thinking phase as observed on the wire, not whole-turn wall clock.
  It is an upper bound, not the phase: revision and throttle-hold pushes
  move `endTs` without emitting (LOW-3); the log label reports observed
  wire time.
- `reset()`: for the rate-limit migration read (new remote chat = new
  thinking; stale prefix would suppress live emit on the fresh attempt).

## 3. Handler wiring (`readOpts`, `server.js:4086-4102`)

Gate predicate (place `~2714`, next to the factory; export in `__test`).
The flippable product decision — OpenAI tool-capable gets progressive
live thinking — lives here and only here, so the truth table (§6.11)
pins it.

```js
// MED-4: 'progressive' | 'legacy-burst' | 'suppressed'. The second row
// of the truth table is the feature flip; every other row is legacy.
function liveThinkingMode(apiMode, toolsOffered) {
    if (apiMode === 'openai') return 'progressive';
    return toolsOffered ? 'suppressed' : 'legacy-burst';
}
```

Legacy-burst decision (Concern-6 fix; place next to the predicate,
export in `__test`). Reads the STICKY flag, never the rewindable one:

```js
// Concern-6: burst decision reads sticky everEmitted, not rewindable
// emittedAny — a full revision rewinds sent but must never re-arm the
// burst over already-streamed packets.
function shouldLegacyBurst(mode, pumpEmittedEver, reasoningEmitted) {
    if (reasoningEmitted) return false;
    if (mode === 'suppressed') return false;
    if (mode === 'progressive') return !pumpEmittedEver;
    return true;
}
```

Handler keeps a `pumpBase` string (sanitized cumulative reasoning
finalized by prior reads, `''` initially). Every statement that finalizes
handler-scope `reasoningContent` (main sanitize, migration/retry
replaces, continuation append) also assigns `pumpBase = reasoningContent`,
and progress pushes `pumpBase + '\n' + thinkText` to mirror the
continuation-append join. Without this, each read's fragments rebase the
pump and finish falls back to full re-emit (multi-read duplicate).

```js
            const thinkPump = createThinkingPump({ onEmit: (tail, sentSoFar) => {
                if (!stream || clientGone || res.writableEnded || res.destroyed) return;
                // LOW-6: record per-packet so an exception between emit and the
                // pre-build backstop below cannot orphan the sent prefix.
                res._reasoningLiveSent = sentSoFar;
                const id = streamMeta?.id || ('ds-' + Date.now());
                const created = streamMeta?.created || Math.floor(Date.now() / 1000);
                const model = streamMeta?.model || requestedModel;
                for (let i = 0; i < tail.length; i += 50) {
                    res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { reasoning_content: tail.substring(i, i + 50) }, finish_reason: null }] })}\n\n`);
                }
            } });
            const readOpts = {
                onReasoningDone: (reasoning) => {
                    if (!stream || clientGone || res.writableEnded) return;
                    const mode = liveThinkingMode(apiMode, allowedToolNames.size > 0);
                    if (!shouldLegacyBurst(mode, thinkPump.state().everEmitted, res._reasoningEmitted)) {
                        return; // progressive already emitted (even if rebased), suppressed mode, or burst already ran
                    }
                    res._reasoningEmitted = true;
                    const sanitized = sanitizeContent(reasoning || '');
                    emitReasoningPhase(res, apiMode, {
                        id: streamMeta?.id,
                        created: streamMeta?.created,
                        model: streamMeta?.model,
                        reasoningContent: sanitized,
                    });
                },
                onReasoningProgress: (thinkText) => {
                    if (liveThinkingMode(apiMode, allowedToolNames.size > 0) !== 'progressive' || res._reasoningEmitted || !stream || clientGone || res.writableEnded || res.destroyed) return;
                    // Cumulative input (multi-read fix): fragments are per-read
                    // but the handler joins reads with '\n' (continuation append)
                    // — mirror that join so the pump prefix tracks the final
                    // text instead of rebasing every read.
                    thinkPump.push(pumpBase ? pumpBase + '\n' + thinkText : thinkText, Date.now());
                },
            };
```

WHY each piece:

- `onEmit` reuses `streamMeta` ids: live chunks belong to the same SSE
  turn as the finish chunks — same `id`, so the client stitches one
  message. Fresh `Date.now()` fallback only if headers never started.
- 50-char sub-slices: identical wire shape to every existing reasoning
  emitter — no new chunk format for clients to choke on.
- Progress restricted to OpenAI mode + live streams: Anthropic/Responses
  keep today's exact behavior (documented OpenAI-only scope, no unasked
  change for shim clients). Non-stream responses already carry whole
  `reasoning_content` in the JSON body — nothing to do there.
- `onReasoningDone` keeps the legacy burst as fallback: if the pump never
  emitted (e.g. hook missed, thinking arrived atomically with content),
  behavior is byte-identical to today. The new path only *adds* emission;
  it cannot remove the old one.
- Gate flip encapsulated in `liveThinkingMode` (MED-4): the `readOpts`
  closures call the predicate instead of inlining `apiMode` /
  `allowedToolNames` checks, so the truth table (§6.11) pins the product
  decision and no future edit can silently re-flip it. The comment on the
  predicate is the behavioral record; no separate gate comment needed
  at the call sites.

Before response build (`~4469`, right after `storeHistory`, before
`const openaiResponse = ...`):

```js
            const thinkState = thinkPump.state();
            // Backstop: onEmit already records per-packet (LOW-6); this covers
            // zero-emit turns (sent stays '') and any path that skipped onEmit.
            // Authoritative writer: this must stay the LAST write to
            // res._reasoningLiveSent before the build — reset() clears pump
            // state only, so removing or reordering this line would let a
            // post-migration turn compare fresh reasoning against a dead
            // attempt's prefix (LOW-D).
            res._reasoningLiveSent = thinkState.sent;
            // MED-1: gate timing on sawThinking, NOT emittedAny — a short
            // thought (< ~64 new chars) never emits (hold-back) but was still
            // thought; its phase time must still be logged.
            if (thinkState.sawThinking) res._thinkPhaseMs = thinkState.phaseMs;
```

WHY here and not earlier: this point runs after ALL reads (main +
retries + continuations), so `sent`/timestamps cover the whole turn.
`finishOpenAIStream` reads `res._reasoningLiveSent` (§4). `res` is the
existing cross-function channel (`_reasoningEmitted` precedent) — no
signature changes to any finisher.

Migration reset — call IMMEDIATELY BEFORE the migrated read (call site `~4176`).
Order is direction-critical: placed after the read, the fresh attempt's
progress pushes compare against the dead attempt's `sent` and live emit
silently disables itself for the turn. Correct order:

```js
                thinkPump.reset(); // BEFORE the read below: new remote chat; the dead attempt's prefix must not suppress the fresh attempt
                const migratedResult = await readDeepSeekResponse(dsResp.body);
```

WHY: without it, the fresh attempt's thinking won't prefix-match the dead
attempt's `sent`, live emit silently disables itself, and finish falls
into the diverge-duplicate branch. One line restores full live behavior
post-migration. (Strict same-chat retries intentionally do NOT reset.
Consequence, stated plainly (M-5): on re-sample the new thinking won't
prefix-match, live emit disables itself, already-shown chunks orphan, and
finish full-emits over them. Defensible — correct text wins over elegance
— not clean.)

## 4. `finishOpenAIStream` top-up (`server.js:2957-2966`)

Replace:

```js
        const cleanReasoning = redactEmbeddedDataUrls(msg.reasoning_content);
        for (let i = 0; i < cleanReasoning.length; i += 50) {
```

with:

```js
        const cleanReasoning = redactEmbeddedDataUrls(msg.reasoning_content);
        let tail = cleanReasoning;
        const liveSent = typeof res._reasoningLiveSent === 'string' ? res._reasoningLiveSent : '';
        if (liveSent) {
            if (cleanReasoning.startsWith(liveSent)) tail = cleanReasoning.slice(liveSent.length);
            else try { console.log('[think] Live-sent thinking prefix diverged at finish; emitting full reasoning (possible duplicate)'); } catch (e) { }
        }
        for (let i = 0; i < tail.length; i += 50) {
            const chunk = tail.substring(i, i + 50);
            res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { reasoning_content: chunk }, finish_reason: null }] })}\n\n`);
        }
```

WHY: remainder-only emission is what makes live + finish exactly-once
instead of double. Empty remainder → loop no-ops → no empty chunks.
Mismatch branch favors correctness (show everything) over elegance, and
logs so a revision storm becomes visible. Prefix comparison here is
apples-to-apples with the pump ONLY because of H-1 sanitize parity —
both sides redact already-sanitized text. Explicit `skipReasoning: true`
still suppresses all (gate order unchanged) — the old suppression test
keeps passing untouched.

## 5. Thinking-phase timing in logs (`server.js:4486`, `:4496` ONLY)

NOT `:4133`: that line runs after the first read only, before the
migration/retry/continuation loops, while `_thinkPhaseMs` is assigned
`~4469` after all reads — appending there would read `undefined`
forever. Keep the phase log on the two completion lines only.
Scope (MED-A, accepted): thinking-phase timing is OpenAI-mode-only. The
progress hook fires the pump solely in progressive mode, so shim turns
never set `sawThinking` and the `(think Nms)` clause never fires for
them. The operator consumes OpenAI mode only — no code change.

Append think phase to the existing completion logs, e.g.:

```js
`${agentTag} Streamed ${apiMode} (tool=${!!toolCall}) in ${Date.now() - startTime}ms${res._thinkPhaseMs !== undefined ? ` (think ${res._thinkPhaseMs}ms)` : ''}`
```

WHY logs and not the wire: no OpenAI schema field exists for it; an
unknown `usage` subfield would be ignored by clients anyway, so the wire
buys nothing and risks strict-parser complaints. Logs are where the
operator watches. WHY still not browser-equal (state this in the commit
message, not code): proxy phase time = first→last THINK packet arrival,
which excludes server-side queueing before first packet and includes
network transit — closer than whole-turn wall clock, never identical.

## 6. Tests to add (`tests/unit.test.js`, appended)

1. Pump: immediate first emit, throttle hold inside interval, release
   after interval (fake `now`: 0, 1000, 2000, 2500 with injected
   `intervalMs: 2000` — test clock, not the 500 default).
2. Pump: revision re-base — push A…, push non-prefix B… → no emit,
   `sent` becomes the longest common prefix; next push resumes from
   there (never stalls to finish).
3. Pump: timestamps — `phaseMs === last − first` non-empty arrival;
   `0` when nothing pushed; `reset()` clears all; `sawThinking` true
   with `phaseMs > 0` even when hold-back emitted nothing (MED-1: short
   thoughts are timed, not dropped); `shouldLogThinkPhase` gates on
   `sawThinking`, not `emittedAny`.
4. Pump hold-back (C-1): push `...data:text/plain;base64,SGVs` (sub-floor
   partial) → assert the raw partial appears in NO `onEmit` argument;
   push the completion past the floor → assert emission resumes and the
   raw partial never crossed. Fails if the hold-back is removed.
   Live-incident variant (2026-09-16, freeze-then-burst): split, redaction
   completion, then continuation → emission resumes from the common
   prefix instead of stalling to finish.
   Second half (LOW-1 pin): terminal sub-floor URL + non-continuation
   prose → assert it emits once live AND finish emits remainder only
   (no diverge) — pins the policy-consistent boundary as intended.
5. Pump sanitize parity (H-1): reasoning with a lone surrogate → pump
   `sent` is a prefix of `redactEmbeddedDataUrls(sanitizeContent(full))`
   (not of the unsanitized redact). Fails if sanitize is dropped.
6. Finish top-up: `_reasoningLiveSent` = true prefix → remainder chunks
   only, whole reassembles to original, order before `tool_calls`.
7. Finish diverge: `_reasoningLiveSent` = non-prefix → full emit + no
   crash.
8. Consume hook: fake readable with THINK fragments → collected
   progress calls are growing prefixes ending at full think text
   (mirrors the existing `consumeDeepSeekStream` test style ~`1620`).
9. Consume order (C-2): one upstream line carrying BOTH a THINK and a
   RESPONSE fragment → assert the progress callback fires BEFORE the
   transition callback (record call order), i.e. the pump — not the
   legacy burst — owns the emission. Fails if the hook sits after the
   transition.
10. Redactor idempotence pin (MED-2): assert
    `redactEmbeddedDataUrls(redactEmbeddedDataUrls(x)) === redactEmbeddedDataUrls(x)`
    over payload-bearing, sub-floor, non-base64, and surrogate strings
    (verified live 5/5 on 2026-09-16; the test keeps it true). H-1 parity
    depends on this property.
11. `liveThinkingMode` truth table (MED-4): (openai, no-tools) →
    progressive; (openai, tools) → progressive (THE flip — fails if it
    regresses); (anthropic, tools) → suppressed; (anthropic, no-tools)
    → legacy-burst; (responses, tools) → suppressed; (responses, no-tools)
    → legacy-burst.
12. Concern-6 regression: pump emits → full revision (sent rewinds to '')
    → `everEmitted` stays true → `shouldLegacyBurst('progressive', true,
    false)` is false (burst stays suppressed). Catches the re-armed-burst
    duplicate.
13. `shouldLegacyBurst` truth table: (progressive,F,F)→true (fresh pump
    bursts); (progressive,T,F)→false; (progressive,F,T)→false;
    (suppressed,*,*)→false; (legacy-burst,F,F)→true;
    (legacy-burst,*,T)→false.
14. `THINK_LIVE_INTERVAL_MS === 500` pin + bounded-raw-prefix test:
    already-emitted sub-floor prefix stays bounded when its payload
    completes (re-base path); finish agrees from the re-based point.
15. Mutation checks (sandbox `/tmp`, never the tree; verified 2026-09-16):
    revert §4 top-up branch → remainder test fails ONLY (diverge test
    passes: fallback emits full either way — by design, not a gap); drop
    `startsWith` in pump → test 2 fails; drop throttle → test 1 fails;
    emit to `clean.length` (no hold-back) → tests 1, 3, 4 fail; drop
    pump sanitize → test 5 fails; move hook after transition → test 9
    fails; flip predicate openai+tools row → test 11 fails; gate timing
    on `emittedAny` → test 3 helper asserts fail; force
    `shouldLegacyBurst` true on emitted pumps → tests 12–13 fail.
16. Handler-gate note (M-6, updated): the product flip is unit-covered
    via the predicate (test 11) and the burst decision via test 13; what
    remains closure-bound is only the wiring (closures call the
    predicates). Coverage for the wiring is the
    §7 live probe + the TUI release gate (§7.4), not a unit test — stated,
    not pretended.

## 7. Verification procedure (after implementation)

1. `node --check server.js && node --check tests/unit.test.js && npm test`
   (expect 192 + 16 = 208 green).
2. Restart `freedeepseek.service`; timestamped curl probe (reasoner +
   forced tool call): assert thinking chunks arrive in ≥2 timestamp
   clusters ~0.5s apart, then tool_calls, then `[DONE]`; assert the
   reassembled thinking contains no raw sub-floor partial (spot-check
   against C-1 with a prompt that invites a long answer).
3. Headless `opencode run` tool turn (tool-loop regression check, same
   method as `4c1cac5`).
4. TUI tool-loop probe with reasoning present — RELEASE GATE, not a
   follow-up: observe a real tool turn in the TUI (thinking shows
   progressively, tool executes, no duplication). Do not merge/release
   without this observation on record (M-6).

## 8. Open risks / explicit non-goals

- R1 (accepted): retried/discarded turns leave orphaned live thinking on
  screen — unretractable by protocol design. Retry path logs exist to
  diagnose confusion if reported.
- R2 (accepted): multi-phase thinking (THINK after response start) extends
  live emission; finish top-up still exact via prefix rule.
- Concern-6 freeze (accepted, implemented): if the legacy burst fires
  first (sub-64 first phase, or pre-migration burst), the progress guard
  freezes the pump (`res._reasoningEmitted` check) — later thinking is
  dropped from the stream rather than duplicated over the burst prefix.
  Full text survives in the non-stream body. Truncation beats
  duplication; the JSON body is always whole.
- MED-3 closed by verification (no plan change): `normalizeRetryResponse`
  sanitizes both fields (`server.js:3376-77`); every `reasoningContent`
  reassignment flows through it (`4180`, `4225`) or sanitizes inline
  (`4398`/`4404`/`4409`). Finish-side parity holds on all paths.
- FOLLOW-UP (not this change): consolidate the three redaction call
  sites (pump, `emitReasoningPhase`, finish) into one shared
  sanitize-then-redact helper so C-1/H-1 cannot recur by drift. This
  plan keeps them byte-identical by construction; the helper makes that
  structural.
- NON-GOAL: live normal text (upstream revises content mid-stream;
  repair flows resend; envelopes need complete content; per-slice
  redaction re-opens the straddle-leak class). Burst-at-finish stays.
- NON-GOAL: browser-equal thinking time (no server-side value exists on
  the wire; client TUI timers are client clocks).
- Staging discipline unchanged: M-A hunk (`@@ -1456`, `shellReminderLine`)
  stays out of every commit; verify with the post-stage
  `grep -c shellReminderLine → 0` check.
