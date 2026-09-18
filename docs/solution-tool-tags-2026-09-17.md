# Solution — configurable tool-call fallback tags (IMPLEMENTED 2026-09-17, reworked)

Status: IMPLEMENTED 2026-09-17, REWORKED same day after adversarial review
(`server.js`: `parseToolTagList`, `TOOL_EXTRA_STARTS/ENDS`, `looksLike` wiring,
`parseCustomTagToolCall` stage, `setExtraToolTags` test hook. Suite green (count lives in CI output);
live IMPL-OK/REWORK-OK).
Design deviations from plan: extraction stage added (plan only specified
sentinels) — required, else extras were detection-only; DSML-gate wiring
deliberately NOT done (that gate returns null on miss, which would have
broken fenced/legacy parsing for tagged text).
Rework (review C1/H1/H2/H3): stage moved to lowest precedence
(XML→fenced→legacy→custom→inline); bare-object parsing requires a PAIRED
region (end tag found), unpaired regions try strict envelopes only;
ends-alone never detect; setter enforces the same 32×128 caps as env;
`a;b;c` warns and drops `c`.

## 1. What it is (verified facts)

- Rust `config.rs:ToolCallTagConfig`: built-ins `<|tool▁calls▁begin|>` + fuzzy
  matching; `extra_starts` defaults `["<|tool_call_begin|>","<tool_calls>",
  "<tool_call>"]` (ends mirrored). New variant = config edit, no deploy.
- Our coverage is already broader: fuzzy DSML + fullwidth `｜` + `TOOL_CALL:` +
  quoted envelopes + 10+ structural patterns (`looksLikeToolCallMarkup`
  `server.js:2014`, DSML scan `server.js:2031`, caps `MAX_TOOL_CALLS_PER_TURN`
  `server.js:1660` (+`MAX_DSML_PARAMETERS=128`, slice `server.js:2224`) —
  bounded so new sentinels can't blow up parse cost.

## 2. Our-side design

> Mechanism correction: this repo's server has NO JSON config-file support
> (no `*.jsonc`, no `.opencode/` wiring in `server.js` — verified). Config
> therefore rides the existing channel: **environment variable**.
- Config: `DEEPSEEK_TOOL_TAGS="start1|start2;end1|end2"` (`;` separates starts
  from ends, `|` separates entries; empty = default `[]` = today's behavior).
  Rationale documented: env keeps it deploy-consistent with every other routing
  knob; a config file would need a whole new loader.
- Wiring: normalize entries (trim, drop empties, cap count at 32 and length at
  128 chars each — anti-ReDoS/anti-bloat), compile to case-sensitive literal
  matchers (NOT regexes — user input must never become a pattern), consulted in
  `looksLikeToolCallMarkup` (`server.js:2014`) and the DSML scan (`:2031`) as
  additional start/end sentinels alongside built-ins. Detection nuance (see the
  Status record at top): ends-without-starts never detect; once starts exist, a
  lone end tag fires as a truncation-tail signal. Extraction is stricter
  (paired regions only).
- Semantics: extras are *additive observers* — they can trigger capture/parse
  paths, never suppress built-ins; parse still goes through the existing
  validators (balanced JSON, param caps). A garbage entry degrades to no-match.
- Logging: debug line listing active extra counts (never values? values are
  operator-authored, non-secret — safe to log; still keep to counts to match
  house style).

## 3. Tests & verification
- Unit: each default Rust tag recognized once configured; fuzzy/fullwidth
  built-ins unaffected; cap enforcement (33rd entry ignored, 200-char entry
  truncated/ignored); malformed entry (empty string) inert; parse still rejects
  unbalanced JSON with extras present.
- Live: add `<tool_calls>` extra, send a turn that emits it, confirm `tool_calls`
  in the OpenAI response (scratch session, then remove the config).

## 4. Rollback
Delete the config keys (default `[]` = today's behavior). No schema change.
