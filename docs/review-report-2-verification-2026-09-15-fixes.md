# Review Report 2 — Proposed Fixes (2026-09-15)

Source findings: `docs/review-report-2-verification-2026-09-15.md` (items 1–4, N2).
Status: **proposed, not applied**. Derived by re-reading the live tree; each fix
cites the exact line it targets and the property it must hold.

## Status ledger (single source of truth — updated last)

| Fix | Status | Evidence |
|---|---|---|
| Fix 1 (silent narrowing) | DECLINED, do not apply | Live probes: unknown/truncated multi → repair already; benign-prose → clean single delivery; proposal would regress the latter into wasteful repairs |
| Fix 2 (parentMessageId test) | Applied | `tests/unit.test.js:2615`, passing |
| Fix 3 (dead `os` import) | Applied | Zero `os.` in server.js; client.js use intact |
| Fix 4 (trailer 1-4→1-8) | Applied | `server.js:1380`, service restarted on it |
| Fix 5 (truncation shims) | Applied | Helper + 4 call sites + test, suite green |
| Fix 6 (image branch) | Applied, INCOMPLETE | `image`/`input_image` covered; `image_url` data URLs + plain-string/unknown-text embeddings still leak — see reworked Fix 9 below |
| Fix 7 (400 guard) | Applied | Guard + extended test, suite green |
| Fix 8 (SSE tail flush) | Applied | Code + 3 tests, suite green |
| Fix 9 (redaction rework) | PENDING — spec below | DA: NO-GO as originally specified |
| Fix 10 (stream item status) | Pending, SOUND | Apply as specified + reuse `response.status` |
| Fix 11 (null-body guard) | Pending, SOUND | Apply as specified, all-modes guard |
| memory-hygiene box | N/A | Tool absent on this machine |

Verdict on the original subagent claim, after devil's-advocate re-check:

- **Item 2 (cookie fallback)** — confirmed real; fix already present in tree and
  verified against `git show HEAD:scripts/auth_import.js`. No further change.
- **Item 1 (numeric parentMessageId)** — fix present at `server.js:170`, but the
  report's "28/28 null" justification is weak; treat the change as defensive.
  Add the full round-trip test below to pin it.
- **Item 3 (silent narrowing)** — **still open**; the branch at `server.js:3662`
  only repairs when `hasLeftoverToolEnvelopes` is true. Proposed fix below.
- **Item 4 (hostname)** — fixed (`formatToolDefinitions` now says "proxy host").
- **N2 (dead `require('os')`)** — confirmed live; zero `os.` references. Fix below.

---

## Fix 1 — Item 3: silent narrowing on mixed known/unknown envelopes

### Bug

At `server.js:3655-3672`, when the model emits e.g.
`[valid read, unknown evil_tool]`:

1. `parseToolCalls(fullContent, { allowedToolNames })` returns both calls (or
   `null`), and the `every(...has(tc.name))` guard fails for the unknown one.
2. The else branch consults `hasLeftoverToolEnvelopes` (`:1976`), which only
   returns `true` when **more than one envelope** is detected **and** each is
   individually parseable.
3. If the unknown envelope does not parse, `hasLeftoverToolEnvelopes` can return
   `false`; the code then falls through to `parseToolCall(fullContent)` and
   delivers the **known** call alone — the unknown call vanishes with no log,
   no error, no repair. The model believes an unexecuted call ran.

### Fix

Replace the `hasLeftoverToolEnvelopes` gate at the call site with a count of
**all markup-looking spans**, independent of parse success. If a valid known
call coexists with any additional envelope, repair instead of narrowing.

Add helper near `hasLeftoverToolEnvelopes` (`server.js:1976`):

```js
function countToolEnvelopes(text) {
    if (!text || typeof text !== 'string') return 0;
    let count = 0;
    const lines = text.trim().split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    for (const line of lines) {
        if (looksLikeToolCallMarkup(line)) count++;
    }
    if (count > 0) return count;
    for (const span of extractBalancedJsonSpans(text, 10)) {
        if (looksLikeToolCallMarkup(span.text)) count++;
    }
    return count;
}
```

Edit the branch at `server.js:3657`:

```js
const multiCalls = parseToolCalls(fullContent, { allowedToolNames });
if (multiCalls && multiCalls.length > 0 && multiCalls.every(tc => allowedToolNames.has(tc.name))) {
    console.log(`${agentTag} Model emitted ${multiCalls.length} valid tool call(s) in turn: ${multiCalls.map(tc => tc.name).join(', ')}`);
    toolCall = multiCalls.length === 1 ? multiCalls[0] : multiCalls;
} else {
    // Count ALL markup-looking spans, not just those that parse cleanly.
    // Any envelope that did not make it into a valid, fully-allowed parse
    // means the turn is broken — repair, never narrow.
    const envelopeCount = countToolEnvelopes(fullContent);
    if (envelopeCount > 1 || (envelopeCount === 1 && (!multiCalls || multiCalls.length === 0))) {
        console.log(`${agentTag} Turn contains ${envelopeCount} envelope(s) but not all are allowed/parseable; attempting format repair instead of silently narrowing.`);
        toolCall = null;
    } else {
        toolCall = parseToolCall(fullContent);
        if (toolCall && !allowedToolNames.has(toolCall.name)) {
            console.log(`${agentTag} Model requested unknown tool ${toolCall.name}; attempting format repair.`);
            toolCall = null;
        }
    }
}
```

### Required test

Assert that `[valid read, unknown evil_tool]` yields `toolCall === null` (repair
path), not a delivered `read`. Cover the non-parsing-unknown variant too.

### Risk

Behavioral: more turns route to repair (extra upstream call) instead of
silently succeeding. Bounded by the existing repair cap. This is the intended
trade-off — loud failure over silent narrowing.

---

## Fix 2 — Item 1: pin the numeric `parentMessageId` round-trip

### Bug / status

The guard at `server.js:170` already accepts `string | finite number`. The
report's evidence (28/28 null in the store) does **not** prove ints were being
dropped — a string id from upstream would also survive HEAD's guard, and the
all-null store is equally consistent with cold sessions. The change is correct
defensively but unproven as a repair.

What is missing is a regression test exercising the **full persist→restore
path** with an integer, not just `serializeSession`.

### Fix

No production code change. Add to `tests/unit.test.js`:

```js
test('integer parentMessageId survives persist→restore round-trip (item 1, full path)', () => {
  const s = serverInternals.createSession();
  s.id = 'chat-int';
  s.parentMessageId = 42;
  s.accountId = 'acct-1';
  s.messageCount = 5;
  s.lastActivityAt = Date.now();
  const snap = serverInternals.serializeSession(s);
  const restored = serverInternals.createSession();
  Object.assign(restored, snap);
  assert.strictEqual(restored.parentMessageId, 42);
  assert.strictEqual(restored.parentMessageId, snap.parentMessageId);
});
```

Note: the existing test at `tests/unit.test.js:2211` only covers
`serializeSession`; this one covers restore. If a genuine int is proven to come
back from upstream (`resResult.messageId`, `server.js:3458`), strengthen with a
live probe; otherwise leave the reasoning as "defensive hardening".

---

## Fix 3 — N2: delete the dead `os` import

### Bug

`server.js:15` does `const os = require('os');` but there are **zero** `os.`
references anywhere in `server.js`, `scripts/`, `lib/`, or `client.js`. The
hostname/IP disclosure was fully removed (item 4), leaving the import behind.

### Fix

Delete line 15:

```js
const os = require('os');
```

### Verification

`grep -rn 'os\.' server.js scripts lib client.js` must stay empty; `npm test`
must stay green. Low risk — pure dead-code removal.

---

## Not fixed here (open from the source report)

- Empty-exhaustion error-type split (`tool_call_failed` for empty responses).
- `uncaughtException` log-and-continue vs exit(1) + `Restart=always`.
- Continuation auto-continue on `finishReason === 'stop'`.
- Literal `/new` wipes session silently.
- Upstream chat leak (no delete call on reset/rollover/sweep).
- Doc drift (port `9654` vs real `9655`; literal third-party VPS IP in docs).

---

## Recommended order

1. **Fix 3** — one line, zero risk.
2. **Fix 2** — test-only; validates the existing item-1 change.
3. **Fix 1** — behavioral; needs the mixed-envelope test.

---

## Apply checklist

- [-] Fix 1 helper — DECLINED (verified: current leftover gate already routes unknown/truncated multi to repair; benign-prose turns deliver correctly; implementing would regress them into wasteful repairs)
- [-] Fix 1 branch — DECLINED (see above)
- [x] Fix 1 behavior covered by existing leftover-gate tests (unknown→repair, truncated→repair, prose→single)
- [x] Fix 2 round-trip test added (tests/unit.test.js:2615, passing)
- [x] Fix 3 dead `require('os')` removed (verified zero uses repo-wide exc. client.js:149)
- [x] `npm test` green (130/130; fixed 2 missing `__test` exports)
- [x] N/A — tool does not exist on this machine; memory repo pushed directly

---

# Batch 2 — later verification rounds (2026-09-15)

Source: `docs/review-report-2-verification-2026-09-15.md`, sections B (Translators)
and the N1/N2 expanded block. Line numbers verified against the live tree this
round (the source report's line numbers run ~80 ahead — bundle drift).

---

## Fix 4 — N1: prompt contradicts itself on batch cap (Medium)

### Bug

`formatToolDefinitions` tells the model two different caps in the same prompt:

- `server.js:1361` — "output EITHER (A) 1-8 newline-delimited strict-JSON …"
- `server.js:1364` — "max 8 tools/turn …"
- `server.js:1390` (REMEMBER trailer) — "strict-JSON **1-4** … lines"

The model reads all three every tool turn. A trailer-anchoring model caps itself
at 4 (halving the cap-8 throughput just shipped); a 1-8-anchoring model emits
5–8 calls the old trailer-trained path never exercised. The inconsistency, not
the cap value, is the compliance leak — and it lands exactly on the read-heavy
work the cap raise was for.

### Fix

Edit `server.js:1390`:

```js
// find
    text += 'REMEMBER: strict-JSON 1-4 {"tool_call":{...}} lines OR plain text. No fences, no mix, no bare shell.';
// replace
    text += 'REMEMBER: strict-JSON 1-8 {"tool_call":{...}} lines OR plain text. No fences, no mix, no bare shell.';
```

### Verification

- `grep -n '1-4' server.js` must return nothing inside prompt strings.
- `MAX_TOOL_CALLS_PER_TURN = 8` (`server.js:1399`) already agrees with the new
  trailer.
- Re-probe a 2-batch live via `npm run test:live` to confirm compliance did not
  shift.

### Risk

None — single prompt-string edit. The only behavioral change is the model being
allowed to emit up to 8 (already enforced by `MAX_TOOL_CALLS_PER_TURN`).

---

## Fix 5 — Translators #1: truncation discarded on shims

### Bug

`length` (OpenAI truncation signal) is mapped to a clean stop on every shim:

- Anthropic non-stream: `server.js:2230` — `length` → `end_turn`.
- Anthropic stream: `server.js:2349` — text branch always emits `end_turn`.
- Responses non-stream: `server.js:2372` item status and `:2378` top-level
  `status: 'completed'` unconditionally.
- Responses stream: `server.js:2452` always emits `response.completed`.

A client cannot tell a cut-off answer from a finished one, so it never
re-requests; Codex/Responses clients key on `status`, Anthropic clients on
`stop_reason`.

### Fix

Add one helper after `buildTextResponse` (`server.js:2082`):

```js
function shimStopReason(finishReason) {
    if (finishReason === 'tool_calls') return 'tool_use';
    if (finishReason === 'length') return 'max_tokens';
    return 'end_turn';
}
```

Anthropic non-stream (`server.js:2230`):

```js
        stop_reason: shimStopReason(choice.finish_reason),
```

Anthropic stream (`server.js:2349`) — `openaiResp` is in scope in
`finishAnthropicStream(res, openaiResp)`:

```js
        writeSse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: shimStopReason(openaiResp.choices[0]?.finish_reason), stop_sequence: null }, usage: message.usage });
```

(The tool-call branch at `:2335` already returns `tool_use`, which the helper
reproduces; switching it is optional.)

Responses non-stream (`server.js:2371-2389`) — add before `return`:

```js
    const truncated = choice.finish_reason === 'length';
```

then set the message item status (`:2372`):

```js
        output.push({ id: 'msg_' + Date.now(), type: 'message', role: 'assistant', status: truncated ? 'incomplete' : 'completed', content: [{ type: 'output_text', text: msg.content || '', annotations: [] }] });
```

the top-level status (`:2378`):

```js
        status: truncated ? 'incomplete' : 'completed',
```

and add after `object: 'response',`:

```js
        incomplete_details: truncated ? { reason: 'max_output_tokens' } : undefined,
```

Responses stream (`server.js:2452`):

```js
    const truncated = openaiResp.choices[0]?.finish_reason === 'length';
    writeSse(res, truncated ? 'response.incomplete' : 'response.completed', { type: truncated ? 'response.incomplete' : 'response.completed', response });
```

(`response` at `:2378` already carries the new status once `toResponsesResponse`
is updated; confirm the stream path builds it via that function or mirror the
`truncated` flag.)

### Required test

Feed `finish_reason: 'length'` through `toAnthropicResponse` and
`toResponsesResponse`; assert `stop_reason === 'max_tokens'` and
`status === 'incomplete'`. Also assert a normal `stop` still yields `end_turn` /
`completed`.

### Risk

Behavioral: truncation-aware clients may now re-request where they previously
silently accepted a cut-off answer. That is the intended fix; bounded by the
client's own retry policy.

---

## Fix 6 — Translators #2: image fallthrough dumps base64

### Bug

`normalizeMessageContent` (`server.js:2087-2095`) handles `text`,
`tool_result`, and `image_url`, then falls through to:

```js
            return part.text || part.content || JSON.stringify(part);
```

An Anthropic-style block `{type:'image', source:{type:'base64', data:'…'}}` has
no `text`/`content` string, so `JSON.stringify(part)` serializes the **entire
base64 payload** straight into the upstream prompt — bounded only by the 80k
prompt cap. Same for OpenAI `input_image` blocks. This both leaks binary data to
DeepSeek and burns the prompt budget.

### Fix

Replace the array branch (`server.js:2087-2095`):

```js
    if (Array.isArray(content)) {
        return content.map(part => {
            if (typeof part === 'string') return part;
            if (!part || typeof part !== 'object') return '';
            if (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text') return part.text || '';
            if (part.type === 'tool_result') return `[Tool Result ${part.tool_use_id || ''}]\n${normalizeMessageContent(part.content)}`;
            if (part.type === 'image_url') return `[Image: ${part.image_url?.url || ''}]`;
            if (part.type === 'image' || part.type === 'input_image') {
                const src = part.source && typeof part.source === 'object' ? part.source : {};
                const ref = src.url || part.image_url?.url || src.media_type || part.media_type || 'image';
                return `[Image: ${ref} (data omitted)]`;
            }
            const safe = part.text || part.content;
            if (typeof safe === 'string') return safe;
            if (Array.isArray(safe)) return normalizeMessageContent(safe);
            return `[Unsupported content part: ${String(part.type || 'unknown')}]`;
        }).filter(Boolean).join('\n');
    }
```

Key properties: base64 `data` is never serialized; unknown structured parts get
a short marker instead of a JSON dump.

### Required test

Pass `{type:'image', source:{type:'base64', data:'A'.repeat(400)}}` into
`normalizeMessageContent`; assert the output contains `data omitted` and does
**not** contain the 400-char run. Also assert an unknown
`{type:'audio', foo:1}` yields the unsupported marker, not JSON.

### Risk

Low. Image parts were never usable by DeepSeek Web in this text-only proxy; the
change only stops leaking their bytes. Text and tool_result behavior unchanged.

---

## Batch 2 apply checklist

- [x] Fix 4: `server.js:1390` trailer `1-4` → `1-8`
- [x] Fix 4: `grep -n '1-4' server.js` clean (verified live: multi-envelope batches flowing)
- [x] Fix 5: `shimStopReason` helper added
- [x] Fix 5: Anthropic non-stream uses helper
- [x] Fix 5: Anthropic stream uses helper
- [x] Fix 5: Responses non-stream + `incomplete_details`
- [x] Fix 5: Responses stream emits `response.incomplete`
- [x] Fix 5 test: `length` → `max_tokens` / `incomplete`
- [x] Fix 6: `normalizeMessageContent` array branch replaced
- [x] Fix 6 test: image base64 omitted; unknown part marked
- [x] `npm test` green (130/130; fixed 2 missing `__test` exports)

---

## Fix 7 — Translators #7: non-array `messages` → 500 instead of 400

### Bug

`normalizeApiParams` runs at `server.js:3141`, **before** the empty-messages
guard at `:3166`. In Anthropic mode it does `for (const msg of params.messages || [])`
(`:2161`). A non-array `messages` therefore misbehaves before any validation:

- `messages: {}` → `for...of` throws `is not iterable` → outer catch → **500**.
- `messages: "hello"` → iterates characters; each `msg` is a string, `msg.role`
  is `undefined`, so the else branch pushes `{role:'user', content: undefined}` —
  garbage instead of a clean 400.

The guard at `:3166` (`!Array.isArray(messages) || messages.length === 0`) is
correct but is reached too late to matter for these shapes.

### Fix

Add a shape guard at the top of `normalizeApiParams` (`server.js:2157`):

```js
function normalizeApiParams(params, apiMode) {
    if (params && params.messages !== undefined && !Array.isArray(params.messages)) {
        const err = new Error('messages must be an array');
        err.status = 400;
        err.type = 'invalid_request';
        throw err;
    }
    if (apiMode === 'anthropic') {
        ...
```

Critical detail: the outer catch at `server.js:3853` reads **`e.status`**, not
`e.statusCode`. Setting `statusCode` (as an earlier draft did) would be ignored
and the response would remain 500. `err.type` is honored at `:3866`
(`e.type || ...`).

No change is needed to the catch block. No change is needed for the Responses
path: it uses `params.input`, so `params.messages === undefined` and the guard
is skipped; `normalizeResponsesInput` already maps a non-array `input` to `[]`
(`:2122`), which the `:3166` guard then rejects with 400.

### Required test

- `normalizeApiParams({ messages: 'oops' }, 'anthropic')` throws with `status === 400`
  and `type === 'invalid_request'`.
- `POST /v1/messages` with `messages: {}` returns HTTP 400, not 500.
- `messages: []` still returns the existing 400 `No messages provided`.
- A valid Responses body (`input`, no `messages`) is unaffected.

### Risk

None — strictly narrows accepted input to the already-documented array shape.

---

## Batch 3 apply checklist

- [x] Fix 7: guard added at top of `normalizeApiParams` (`server.js:2157`)
- [x] Fix 7: uses `err.status` + `err.type` (verified in tree)
- [x] Fix 7 test (+ extended: `[]` and Responses input unaffected)
- [x] (folded into the test above)
- [x] `npm test` green (130/130; fixed 2 missing `__test` exports)

---

# Batch 4 — Upstream/retry batch: SSE tail flush (2026-09-15)

Source: `docs/review-report-2-verification-2026-09-15.md`, section C item 1
(“SSE tail flush — CONFIRMED”). Line numbers verified against the live tree.

---

## Fix 8 — C#1: unterminated final SSE event is dropped

### Bug

`consumeDeepSeekStream` (`server.js:953`) reads the upstream body with:

```js
for await (const chunk of readable) {
    ...
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';   // keep the trailing partial line
    for (const line of lines) { if (line.startsWith('data: ')) { ... } }
}
```

After the loop, `buffer` — the unterminated trailing line — is **never
processed** and is discarded. Consequences:

- If the final SSE event lacks a trailing `\n` (close/truncation without
  terminator), its `data:` line is lost. When the *entire* final event carried
  the response, `fullContent` stays `''`.
- An empty `fullContent` trips the empty-retry path
  (`readDeepSeekResponse` → `resolveEmptyExhaustion`), so a response that
  actually arrived burns a retry and may return a spurious
  `tool_call_failed` / 502.
- `decoder.decode()` is also never called with no args, so a multi-byte
  character split across the last chunk boundary can be left half-decoded.

The probe in the source report confirmed it: content without a trailing `\n`
yields `content=""`.

### Fix — extract the line handler, then flush

Duplicating the ~40-line parse block for the flush would drift; instead lift it
into a helper and call it from both sites.

**Step 1 — inside `consumeDeepSeekStream`, after `const decoder = new TextDecoder();`
(`server.js:991`), define the handler before the loop:**

```js
    const decoder = new TextDecoder();

    const handleDataLine = (line) => {
        if (!line.startsWith('data: ')) return;
        try {
            const d = JSON.parse(line.slice(6));
            if (d.response_message_id !== undefined && !newMessageId) newMessageId = d.response_message_id;
            if (isDeepSeekModelErrorEvent(d)) {
                modelError = { type: d.type || 'error', content: d.content || '', finish_reason: d.finish_reason || null };
            }
            if (d.finish_reason) {
                finishReason = d.finish_reason;
            }
            if (d.p !== undefined) lastPath = d.p;
            if (d.v && typeof d.v === 'object' && d.v.response) {
                if (d.v.response.message_id !== undefined) {
                    newMessageId = d.v.response.message_id;
                }
                if (d.v.response.content !== undefined) {
                    fullContent = d.v.response.content;
                }
                if (Array.isArray(d.v.response.fragments)) {
                    fragments.length = 0;
                    appendFragments(d.v.response.fragments);
                }
                if (d.v.response.finish_reason !== undefined) {
                    finishReason = d.v.response.finish_reason;
                }
            }
            if (lastPath === 'response/fragments' && d.v !== undefined) {
                appendFragments(d.v);
            }
            if (lastPath === 'response' && d.v !== undefined) {
                applyResponsePatchOperations(d.v, appendFragments);
            }
            if (lastPath === 'response/fragments/-1/content' && d.v !== undefined && typeof d.v !== 'object') {
                if (fragments.length > 0) {
                    const lastFragment = fragments[fragments.length - 1];
                    lastFragment.content = `${lastFragment.content || ''}${d.v}`;
                    rebuildFragmentState();
                }
            }
            if (lastPath === 'response/content' && d.v !== undefined && typeof d.v !== 'object') {
                fullContent += d.v;
            }
            if (lastPath === 'response/finish_reason' && d.v !== undefined) {
                finishReason = d.v;
            }
            if (lastPath === 'response/status' && d.v !== undefined && d.v !== 'FINISHED') {
                finishReason = d.v;
            }
            checkReasoningTransition();
        } catch (e) { }
    };

    for await (const chunk of readable) {
        ...
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) handleDataLine(line);
    }
```

**Step 2 — after the loop, before `checkReasoningTransition()`
(`server.js:1053`), flush decoder + trailing line:**

```js
    buffer += decoder.decode();
    if (buffer) handleDataLine(buffer);

    checkReasoningTransition();
```

This preserves the exact parse semantics (single source of truth) while covering
the unterminated-tail and split-multibyte cases.

### Required test

- Feed a mock readable whose final event is `data: {...}` **without** a trailing
  `\n`; assert `consumeDeepSeekStream` returns the event’s content, not `''`.
- Feed an event whose JSON is split across two chunks at a multibyte boundary;
  assert the assembled line parses (exercises `decoder.decode()` flush).
- Regression: a well-terminated stream yields identical `content`,
  `reasoningContent`, `messageId`, `finishReason` as before.

### Risk

Low. Pure additive flush of an already-retained buffer; the in-loop path is
unchanged once the handler is extracted (verify by diffing behavior on a
terminated stream).

---

## Batch 4 apply checklist

- [x] Fix 8: `handleDataLine` extracted (verified present)
- [x] (verified present)
- [x] (verified present)
- [x] Fix 8 test: unterminated final event preserved
- [x] Fix 8 test: split multibyte chunk parses
- [x] Fix 8 test: terminated stream regression identical
- [x] `npm test` green (130/130; fixed 2 missing `__test` exports)

---

## Adversarial re-verification (2026-09-15, explore subagent)

Baseline re-measured: node v26.8.1; HEAD 4580311; `npm test` = 134 tests, 134 pass, 0 fail.
server.js = 4117 lines. Line numbers below are ACTUAL (drifted from the earlier report).

### Claim verdicts

- **Claim 1 (image base64 leak) — WEAKENED.** The leak is real at `server.js:2088`
  (`image_url` returns the raw URL), but the branch at `server.js:2089-2092` does not
  redact: it appends the cosmetic literal ` (data omitted)` while `ref` still embeds the
  full base64. Probe shows `image_url`, `image`, and `input_image` all leak the data URL.
  Exposure is broader than an image_url-only asymmetry.
- **Claim 2 (Responses stream item status) — CONFIRMED.** `server.js:2459` hardcodes
  `status:'completed'`; `:2467` sends it verbatim while the top-level emits `incomplete`
  (`:2394`, `:2469`).
- **Claim 3 (tool_calls+length inconsistency) — CONFIRMED (unreachable).** Builders are
  mutually exclusive: `buildToolCallResponse` always sets `finish_reason:'tool_calls'`
  (`:2052`); `buildTextResponse` emits only `'length'|'stop'` and never tool_calls
  (`:2072`); sole selector is `toolCall ? buildToolCallResponse : buildTextResponse(...,
  finishReason)` at `:3840-3841`. Downgrade upheld; could not break it.
- **Claim 4 (null body -> bare TypeError) — CONFIRMED.** `normalizeApiParams(null,·)` throws
  a bare TypeError (`:2176`/`:2203`); `JSON.parse("null")` at `:3165` returns null, the guard
  at `:2168` skips null, and the outer catch at `:3882` yields 500.

### New issues (fix nothing yet)

- `server.js:2092` **HIGH** — the `(data omitted)` label is cosmetic; the full base64 is
  still embedded for `image`/`input_image` (and `:2088` for `image_url`).
- `server.js:2467` **MEDIUM** — streaming Responses terminal message item says `completed`
  while the enclosing response is `incomplete`.
- `server.js:3172`/`:2176`/`:2203` **MEDIUM** — a literal `null` JSON body yields a bare
  TypeError -> 500 instead of 400 invalid_request; no `params == null` guard at `:2168`.

---

## Proposed fixes for the re-verification findings (2026-09-15)

Status: **proposed, not applied**. The read-only verification left the tree untouched; these are the fix plans for the three issues found above, in the same style as Fixes 1-8.

### Fix 9 — normalizeMessageContent: actually redact image payloads (HIGH, server.js:2088-2092)

**Bug.** The `image_url` branch (`server.js:2088`) returns `part.image_url?.url` verbatim; the `image`/`input_image` branch (`:2089-2092`) builds `ref` from `src.url || part.image_url?.url ...` and labels it `(data omitted)` while `ref` still contains the entire base64 data URL. All three part types leak the payload into the prompt.

**Fix.** Add a `redactImageRef(ref)` helper next to `normalizeMessageContent` that detects `data:` URLs and replaces the payload with a short placeholder (e.g. `data:<mediatype>;base64,<omitted>`), leaving ordinary short http(s) URLs intact. Route all three branches (`image_url` at `:2088`, `image`/`input_image` at `:2089-2092`) through it.

**Property.** For a 300-char base64 probe the output contains `data omitted` and does NOT contain the base64 run.

**Required test.** Feed `image_url`, `image`, and `input_image` data URLs of 300 chars; assert output has `data omitted` and `!output.includes('A'.repeat(64))`.

### Fix 10 — Responses stream message item status on truncation (MEDIUM, server.js:2459/2467)

**Bug.** `finishResponsesStream` builds the message item with a literal `status: 'completed'` (`:2459`) and sends it verbatim at `:2467`; the truncation flag only reaches the top-level response (`:2394`, terminal `:2469`), so a truncated turn emits `response.incomplete` while its own `output_item.done` item says `completed`.

**Fix.** Derive `const truncated = choice.finish_reason === 'length';` inside `finishResponsesStream` (or reuse `response.status === 'incomplete'`) and set the message item status to `truncated ? 'incomplete' : 'completed'` at `:2459`.

**Property.** `output_item.done` item status is `incomplete` iff the enclosing `response.status` is `incomplete`.

**Required test.** Call `finishResponsesStream` with `finish_reason: 'length'` and with `'stop'`; assert the done-event message item status matches.

### Fix 11 — reject non-object bodies with 400 (MEDIUM, server.js:2168/2176/2203)

**Bug.** The guard at `:2168` (`params && params.messages !== undefined ...`) short-circuits for `params === null`; the anthropic path (`:2176`) and responses path (`:2203`) then dereference null and throw a bare TypeError, which the outer catch (`:3882`, `e.status || ...`) surfaces as 500.

**Fix.** Add an object guard at the top of `normalizeApiParams` (before the `messages` check):

```js
if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    const err = new Error('Request body must be a JSON object');
    err.status = 400;
    err.type = 'invalid_request';
    throw err;
}
```

**Property.** `normalizeApiParams(null, mode)` throws with `status === 400` and `type === 'invalid_request'` for every mode.

**Required test.** `assert.throws` for a null body against `anthropic`, `responses`, and `openai`, asserting `err.status === 400`.

---

## Devil's-advocate review of Fixes 9-11 (2026-09-15)

Baseline re-measured: node v26.8.1; HEAD 4580311; `npm test` = 134 tests, 134 pass, 0 fail.
server.js = 4117 lines. Fixes 9-11 were **not applied** at review time (no `redactImageRef`;
`:2459` still `status:'completed'`; `:2168` still `params &&`).

### Fix 9 — INCOMPLETE / FLAWED (do not apply as written)

- **Gap A (test self-defeats).** The plan's test asserts `'data omitted'` for all three
  types, but the `image_url` branch at `server.js:2088` has no such suffix. Routing it
  through `redactImageRef` alone yields `[Image: data:...<redacted>]`, so
  `.includes('data omitted')` FAILS. The plan must also edit the `:2088` template (or
  have the helper append the suffix).
- **Gap B (500 regression).** `ref` is not guaranteed a string (`src.url` may be an
  object/number). A naive `ref.startsWith('data:')`/regex throws inside
  `normalizeMessageContent` on the request path (`server.js:3176`/`:2180`/`:2191`/`:3371`)
  -> outer catch `:3882` -> 500. Needs a `typeof ref === 'string'` guard.
- **Gap C (under-specified detection).** Must be case-insensitive, handle
  `data:<mime>;base64,` AND URL-encoded `data:<mime>,`, and tolerate leading whitespace /
  not-at-index-0. `startsWith('data:')` alone misses `DATA:` and ` data:`.
- **Gap D (existing test false confidence).** Fix 6 test at `tests/unit.test.js:2052` does
  NOT exercise a data-URL `ref`: its `image` case resolves to `'image/png'` and its
  `input_image` case uses `https://example.test/x.png`; neither catches the `:2091` leak.
  The new test must use `source:{url:'data:...'}` explicitly.
- **Gap E (data at rest).** Refs feed persisted prompt/history at `:2948`/`:2958`/`:2981`;
  pre-fix data URLs are already in `.sessions.json`. No scrub/migration proposed. Medium.
- No vision regression: images were already flattened to text markers, never sent upstream
  as images.

### Fix 10 — SOUND (minor gaps)

- Diagnosis correct: `:2459` literal `status:'completed'`, `:2467` emits it in
  `response.output_item.done`; truncation only reaches top-level `:2394` and terminal
  `:2469` (which already reads `response.status`). Non-stream `:2388` is already correct.
- No regression: no existing test asserts the stream message-item status; `/new`/title
  paths (`:3222`/`:3288`) call `buildTextResponse` (finishReason null -> 'stop') and are
  unaffected.
- Gap: `:2450` `function_call` and `:2443` `reasoning` items stay hardcoded `'completed'`.
  Recommend reusing the already-computed `response.status` (`:2433`) instead of
  re-deriving `truncated`. Test must parse the `output_item.done` SSE event and assert on
  that specific `item.status`; a loose `includes('completed')` would false-pass.

### Fix 11 — SOUND

- Diagnosis correct; worse than stated: openai mode returns `params` at `:2215`, then
  caller `:3173` `params.messages` throws too — the top guard fixes all three modes.
- No regression: placed BEFORE the `:2168` messages guard, `{messages:'not-an-array'}`
  still throws the same 400 (Fix 7 test `tests/unit.test.js:2070` stays green);
  `{input:'hello'}` still passes. `Array.isArray(params)` rejection only affects bare-array
  bodies (previously fell through to a later 400 or spread weirdness). Title/`/new`
  handlers never touch `normalizeApiParams`.
- Test gap: also assert `err.type === 'invalid_request'` and `!(err instanceof TypeError)`,
  and cover a non-object primitive (`JSON.parse('"str"')` / `'null'`).

### Additional same-class instances the plans miss

- `server.js:2081` **Low** — plain-string content with an embedded `data:` URL is returned
  verbatim, unredacted.
- `server.js:2094-2096` **Medium** — unknown-type part with a string `text`/`content`
  containing a data URL is returned verbatim.
- `server.js:2450` **Low/Med** — function_call item hardcoded `'completed'`; `:2443`
  reasoning item **Low**.
- `.sessions.json` prior leakage (data-at-rest) **Medium**.

### Overall

- **Fix 10 and Fix 11: safe to apply as written**, subject to the test hardening above.
- **Fix 9: NOT safe as written** — incomplete (must change the `:2088` template), detection
  under-specified, and a real non-string-`ref` 500 regression risk. Rework Fix 9 first.

---

# Fix 9 REWORKED — five-shape redaction with false-positive gates (supersedes the Fix 9 proposal above; original kept for history)

## Match rule (exact, implement verbatim in spirit)
- Whole-ref fields (`image_url.url`, `source.url`, `media_type` slots): redact if and
  only if the ENTIRE trimmed string opens with the data scheme (case-insensitive).
  Anything else (http/https/relative/short labels) passes byte-identical.
- Embedded-in-prose (plain strings, unknown-type text, `tool_result` recursion):
  redact a span only when ALL hold: (a) left boundary is start/whitespace/quote/
  bracket/paren — never mid-token (so `https://…?x=data:foo` survives); (b) a
  mime-ish header plus comma delimiter with `;base64` present; (c) total match
  length above a short-payload floor (mentions, `data:text/plain,hello`-class toys,
  and `{"u":"data:"}` fragments pass through untouched).
- No percent-decoding before matching (avoids double-mangling encoded URLs).

## Throw-safety (hot path — any throw is a client 500)
- `typeof`-string-guard every helper entry; non-strings return as-is (or fall back
  to the pre-existing template behavior, never throw).
- Never call string methods on `src.url` / `media_type` / `part` without guards;
  keep the existing `!part || typeof part !== 'object'` early-out ahead of the helper.
- Numeric top-level content (`42` → `"42"`) and null/undefined bypass redaction entirely.

## Coverage (all five shapes + bypasses)
- `image_url.url`, `image`/`input_image` source urls, plain-string embeddings,
  unknown-type text embeddings, AND `tool_result` recursion (automatic via placement
  inside `normalizeMessageContent`).
- Responses bypasses: `normalizeResponsesInput` `input_text` verbatim path,
  `function_call_output` verbatim path, and `params.instructions` — route each
  through the normalizer or document explicitly why not.
- Keep `file`/`input_file`/`document` sinking (never echo their data fields).

## Fix 10 amendment
Reuse the already-computed `response.status` instead of re-deriving `truncated`;
leave `reasoning`/`function_call` item statuses explicitly out of scope (noted).

## Fix 11 amendment
Guard sits before the `messages` check and covers null/non-object/arrays in ALL
modes; `{}` (and empty-string-derived `{}`) must still pass; bare-array/string/number
bodies becoming 400 is intended — call it out in the test names. Assert
`err.type === 'invalid_request'` and `!(err instanceof TypeError)` plus a
non-object primitive case.

## Minimal probe set (every row must pass; first FAILURE proves bug)
- image_url / image / input_image data URLs (300ch) → marker present, 64ch payload
  run absent.
- https URL ref → byte-identical.
- Adversarial false-positives (must ALL pass through untouched): prose
  `Explain data: URLs; example {"u":"data:"}`, short `data:text/plain,hello`,
  `https://example.com/?x=data:foo`.
- Non-string urls (`{x:1}`, `12345`, missing) → no throw, marker output.
- Plain-string + unknown-text + tool_result-nested data URLs (100ch) → payload
  gone, surrounding prose intact.
- Fix 10: `finishResponsesStream` with `length` vs `stop` → parse the
  `output_item.done` event JSON, assert `item.status` equals enclosing status.
- Fix 11: null + `"str"` + `[]` in all three modes → 400 `invalid_request`;
  `{}` → no throw.

## Batch 5 apply checklist
- [ ] Fix 9: helper with anchored + length-gated rule + typeof guards
- [ ] Fix 9: all five shapes + Responses bypasses routed
- [ ] Fix 9: false-positive battery green
- [ ] Fix 10: reuse `response.status`, event-JSON assertions
- [ ] Fix 11: all-modes guard, `{}` passes, primitives 400
- [ ] `npm test` green
