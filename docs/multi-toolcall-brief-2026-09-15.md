# Implementor Brief — Multi-Envelope Turns (N tool calls per upstream cycle)

Date: 2026-09-15. Standing repo rules apply: backup-first (`/tmp/server.js.bak.*`),
`node --check` + `npm test`, minimal diff, never commit without approval, bounded live
probes only (distinct `x-agent-session`, concurrency 2–4). Current suite: 95/95.

## 1. Objective
Let one model turn carry up to N tool calls (reads first) so opencode executes them in
parallel. Proven client behavior: opencode runs same-turn `tool_calls` arrays in parallel
and returns all results in ONE follow-up (3.16s for 2×`sleep 3` vs ≥6s sequential).
Today the pipeline is single-lane by construction (prompt says "ONLY one", parser takes
first match, response builder emits one call), so 10 reads = 10 upstream cycles (~20s+).

## 2. Protocol (v1 scope: all-valid-or-fallback; partial delivery is v2)
- **Prompt** (`formatToolDefinitions`, `server.js:1346-1376`): replace the single-call
  constraint (`:1347` "EXACTLY ONE of (A)/(B)", `:1350` "one tool/turn") with: per turn
  output EITHER (A) 1–4 newline-delimited strict-JSON `{"tool_call":{...}}` objects
  (one per line, no fences, no prose between), OR (B) plain text. Keep "Never mix."
  Cap: `MAX_TOOL_CALLS_PER_TURN = 8` (raised from 4 per operator request for read-heavy work). Batch discipline (prompt-level, advisory): at most 6 tool batches per task; no server-side counter (a hard cap would break legitimate long sessions). Add the ordering rule: independent calls only
  (reads/parallel-safe); mutations touching the same target must NOT batch (genuine
  races — completion order is not request order).
- **Parse-all**: new `parseToolCalls(text, options)` returning an array (each via the
  existing `parseToolCall` single path + `buildToolCall` validation). Reuse the
  newline as the primary split; fall back to scanning balanced objects (existing
  `extractBalancedJsonObjects`, capped at 32 candidates, take first 4 valid).
  Each call independently validated (name regex, args object, size caps).
- **Acceptance gate** (replaces single `parseToolCall` at `:3218` area): if ≥1 envelope
  AND ALL parse AND ALL names ∈ allowedToolNames → multi success. Else → today's
  exact fallback chain (single-first-match → lean/full repair → prose fallback → 502).
  Rationale: v1 must not widen the malformed surface; partial success ships in v2
  after compliance data exists.
- **Response**: extend `buildToolCallResponse` (`:1844`) with a plural path emitting
  `tool_calls: [{id, type, function} × N]` — fresh `call_<ts>_<rand>` id per call,
  per-call `index` (the `:2278-2283` streaming mapper already handles `index`; keep).
  Stream as ONE delta carrying the array (matches current single-chunk style), then
  `finish_reason: 'tool_calls'` + `[DONE]` unchanged.
- **Guards** (non-negotiable, same brief): batch cap 8 enforced at parse; exact-duplicate
  envelopes deduped (same name+args twice = one call); same-target mutation batches are
  the caller's responsibility per the prompt rule above (no server-side AST needed v1).
- **Untouched**: history rendering (already loops `msg.tool_calls`, F20), delta/
  fingerprint/adoption (same turn, same messages), repair prompts for the fallback
  path, Anthropic/Responses mappers (derive from the same `tool_calls` array —
  verify with one test each), `storeHistory` (store all N envelopes).

## 3. Tests to add (~6)
1. Parse-all: 3 valid newline envelopes → 3 calls, order preserved, ids unique.
2. Cap: 10 envelopes → first 8 kept.
3. Duplicates: identical twice → one call.
4. Mixed: 2 valid + 1 malformed → v1 fallback (single-first-match path, no array).
5. Unknown name among valid → fallback (no laundering), consistent with audit gate.
6. Streaming mapper: N calls → N `index` values 0..N-1; Anthropic mapper emits N
   `tool_use` blocks; Responses mapper emits N `function_call` items.

## 4. Acceptance (live, bounded)
- 95→~101 green, `node --check` clean, backup present, tree uncommitted.
- Live: coax the model to batch 2 reads in one turn (may take retries — compliance is
  the experiment); verify in opencode that wall-time < sequential sum and both results
  return in one follow-up; `in_flight` returns to 0; journal shows one
  `Streamed openai (tool=true)` per batched turn.

## 5. Explicit non-goals / risks
- No partial delivery in v1 (all-valid-or-fallback). No same-target race protection
  beyond the prompt rule + cap. No change to single-call behavior when only one
  envelope is present (byte-identical path). If model compliance is poor (<50% batch
  rate after prompt tuning), report back instead of forcing — sequential remains.
