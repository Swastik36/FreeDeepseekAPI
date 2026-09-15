# Implementor Brief — Dedicated Compaction-Prime Chat (2026-09-15)

Standing repo rules: backup-first (`/tmp/server.js.bak.*`), `node --check` +
`npm test`, minimal diff, never commit without approval, bounded live probes
(distinct `x-agent-session`, concurrency 2–4). Current suite: 133/133.

## 0. Problem and goal
Today, on client-side compaction (`detectClientCompaction`, `server.js:739`;
call site `:3322-3325`), the proxy resets and lazily bundles tools + summary +
the next user question into ONE founding prompt for the new chat. That prompt
passes through `buildBoundedPrompt` (`:2703`), which middle-truncates the
conversation slice at 25% head ratio — a 10–20k summary can be silently gutted
while the new chat looks healthy.

Goal: prime the post-compaction chat EAGERLY with a dedicated,
truncation-protected exchange (system + tools + summary first), then continue
subsequent turns in that chat. No new concepts: detection, mint, and resend
machinery are all reused.

## 1. Step-by-step implementation

### Step 1 — Add `buildCompactionPrimePrompt(systemWithTools, summary, budget)` (pure, exported via `__test`)
Location: next to `buildBoundedPrompt` (`:2703`). Signature:
`buildCompactionPrimePrompt(systemWithTools, summary, budget = MAX_UPSTREAM_PROMPT_CHARS)`
→ `{ prompt, summaryIntact }`.
1a. If `!summary || !summary.trim()` → return `null` (caller falls back to today's
lazy path; an empty summary needs no priming).
1b. Compose `candidate = system + '\n\n' + summary` (system already includes the
full tool block — reuse the exact `systemPrompt` variable the handler built).
1c. If `candidate.length <= budget` → return `{ prompt: candidate, summaryIntact: true }`
(no truncation at all — the common case).
1d. Else two-pass budgeting (add optional `conversationShare` param to
`buildBoundedPrompt`, default preserves current 50/50 for ALL existing callers):
pass 1 with `conversationShare = 0.7`; if the result still cuts the summary
(detect: `result.prompt` does not contain summary's first 200 chars AND last
200 chars), pass 2 with `conversationShare = 0.85`.
1e. If STILL cut → hard-truncate the summary TAIL with an explicit
`[...compacted summary truncated...]` marker (never silent middle-cut), set
`summaryIntact: false`, and let the caller log a warning. Never return an
unmarked gutted summary.
1f. No acknowledgement instruction: ANY non-empty model response counts as prime
success (the chat holds context regardless of ack wording; keeps the spec robust
against model non-compliance).

### Step 2 — Wire the prime into the handler (between reset `:3324` and established computation `:3334`)
2a. After the existing `compactionReset` reset + log line, insert (only when
`compactionReset` is truthy):
```
const primeBuild = buildCompactionPrimePrompt(systemPrompt, <summary text>, MAX_UPSTREAM_PROMPT_CHARS);
let compactionPrimed = false;
if (primeBuild && !clientGone && !deadlineHit()) {
    try {
        const primeCall = await askDeepSeekStream(primeBuild.prompt, agentId, requestedModel, primeBuild.prompt);
        const primeResult = await readDeepSeekResponse(primeCall.resp.body);
        const primeContent = <sanitize+normalize as the main path does>;
        if (primeContent && primeContent.trim()) {
            compactionPrimed = true;
            if (primeBuild.<compaction-flag>) { promptCompacted = true; markContextCompacted(res); }
            console.log(`${agentTag} Compaction primed new chat ${session.id} (summary ${summary.length} chars, intact=${primeBuild.summaryIntact})`);
        }
    } catch (e) { /* fall through to lazy path below */ }
    if (!compactionPrimed) console.log(`${agentTag} Compaction prime failed; falling back to lazy founding prompt.`);
}
```
2b. `<summary text>`: the client's collapsed summary as received in `messages`
(the same text the lazy path would embed — extract with the existing
`normalizeMessageContent` join the lazy path uses; do NOT invent a new extractor).
2c. `readDeepSeekResponse` MUST be used (not a raw read): it advances
`parentMessageId`/`messageCount` and commits delta state, which the follow-up
turn needs. Do NOT call `storeHistory` for the prime (keeps local history clean;
the turn's own `storeHistory` covers the user-visible exchange afterward).
2d. Single prime attempt, no retry loop (compaction is already slow). `clientGone`
/ `deadlineHit()` abort everything (return, exactly like neighboring paths).
2e. Ordering constraint: the prime block MUST complete (await) BEFORE the
`establishedChat` computation (`:3334`), because a successful prime sets
`session.id` + `messageCount`, which flips the turn into the established path:
tools omitted (already in chat from priming ✓), full conversation sent with shell
reminder, then `commitDeltaState` records it normally.
2f. Accepted duplication (document, don't fix): the turn re-sends the summary
text into a chat that already holds it from priming (~summary chars extra on ONE
turn). Stripping it would need fragile boundary detection; reinforcement is
harmless. Note it in a code comment at the call site.

### Step 3 — Failure fallback (no new failure modes)
Any prime failure (PoW throw, mint failure, empty ack, thrown error) → proceed
EXACTLY as today (lazy founding prompt via the turn's own `askDeepSeekStream`).
The fallback is the current code path unchanged; the prime block only ever
*adds* a prior attempt. Log the fallback (line above).

### Step 4 — Concurrency note (accepted, no lock — standing architecture)
A second same-agent turn racing the prime `await` may also detect compaction and
reset/prime independently (last-writer-wins, bounded, same class as all existing
same-agent races; opencode is sequential per session so this needs deliberate
concurrency to trigger). Do NOT add locking; do NOT share prime state across
requests (local `compactionPrimed` flag only).

### Step 5 — Logging (exact lines, grep-able)
- Success: `[<agent>] Compaction primed new chat <id> (summary <n> chars, intact=<bool>)`
- Fallback: `[<agent>] Compaction prime failed (<reason>); falling back to lazy founding prompt.`
- Existing lines (reset log `:3325`, delta log `:3394`) unchanged; extend the `:3394`
  template with a `primed` marker, e.g. `new chat after compaction (primed), full prompt + tools + summary`.

## 2. Tests to add (~8, production-coupled via `__test`, no mirror lambdas)
1. Fits-without-cut: summary intact, tools present, order system→tools→summary.
2. Pressure: oversized input cuts SYSTEM first (summary intact, flag true).
3. Extreme: summary tail hard-truncated WITH marker, `summaryIntact: false`.
4. Empty/blank summary → `null` (lazy fallback path).
5. `conversationShare` default preserves legacy 50/50 split (existing
   `buildBoundedPrompt` callers unaffected — pin with a fixture).
6. Established-follows-prime: session with id + messageCount>0 → established path
   treats tools as already-sent (assert via existing prompt-split helpers).
7. Prime-failure fallback: helper-level (null build) or documented inspection-only
   if handler-wiring can't be unit-driven — state which in the test comment.
8. Log-line format test only if the repo already tests log lines (check precedent;
   do not invent log-assertion harness).

## 3. Acceptance
- Suite green (+~8), `node --check` clean, backup present, tree uncommitted.
- Live forcing of a real client compaction is OUT OF SCOPE (same standing rule as
  all prior compaction work): acceptance = unit + inspection + regression probes
  (ordinary + multi-tool turns unaffected), `in_flight` 0.
- Post-deploy watch (paste into handoff):
  `journalctl --user -u freedeepseek.service --since "30 minutes ago" --no-pager | grep -E "Compaction primed|prime failed|Client compaction"`.
- Docs: one paragraph in `docs/api-documentation.md` compaction section describing
  prime-then-continue + fallback (required in same diff).

## 4. Explicit non-goals
- No change to `detectClientCompaction` thresholds, TTL/depth behavior (retired),
  sticky routing, delta mechanics, repair, streams, title, or sampling params.
- No LLM summarization step (verbatim client summary; zero extra quota beyond the
  single prime call).
- No cross-request prime state, no locks, no new env vars.
