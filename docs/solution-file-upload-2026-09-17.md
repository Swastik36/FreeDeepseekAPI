# Solution — file upload into session + oversized-prompt fallback (plan, no code)

Status: plan only (round-3 G5+G6).

## 1. What they do (verified facts)

- Rust README (behavioral): inline data-URL files in OpenAI `file`/`image_url`
  parts and Anthropic image/document blocks auto-upload to the DeepSeek session;
  HTTP URLs flip that turn to search mode; over-limit prompts fall back to
  **chunked completion + file upload**.
- Python: same `ref_file_ids` flow as the web client (upload → fork_file_task →
  ids attached to completion). Our completion payload already sends
  `ref_file_ids: []` (`server.js:1428`) — the wire slot exists, only the upload
  leg is missing.

## 2. Our-side design

### 2a. Upload leg (new `uploadDeepSeekFile(account, {filename, bytes, mime})`)
1. Accept from OpenAI `messages[].content[]` parts (`image_url`, `file`) and
   Anthropic blocks (`image`, `document`) — data-URL only in v1 (HTTP-URL fetch
   is a later step; note SSRF guard requirement if ever added: allowlist
   schemes, size caps, no credentials forwarded).
2. Limits: per-file 10MB, per-turn 3 files, allowlist mime
   (`text/*`, `image/png|jpeg|webp`, `application/pdf` — extend deliberately).
   Oversize → 413-style client error, never silent drop.
3. Flow per verified upstream contracts (NOT "poll fork_file_task" — no such
   poll exists in either project):
   - Rust (`ds_core/src/accounts.rs:150-203 upload_and_poll`): upload, then poll
     **`fetch_files` until status `SUCCESS`**, bounded **30 × 2s**
     (`UPLOAD_POLL_MAX_RETRIES=30`, `UPLOAD_POLL_INTERVAL_MS=2000`).
   - Python (`proxy.py:3386 fork_file_to_vision`): **single-shot** fork call for
     the vision path, separate from upload.
   Our v1 follows Rust: upload → poll `fetch_files`→`SUCCESS`, same 30×2s bound,
   then attach ids to the completion call for the SAME `chat_session_id`.
4. Failure semantics: upload failure fails the turn fast with a typed error
   (don't send a file-less completion pretending context exists).

### 2b. Oversized-prompt fallback (complements, not replaces, compaction)
When the bounded prompt still exceeds the model's input budget AND the overflow
is file-attachable content (long pasted logs, docs — not tool schemas):
1. Spill the oldest history chunk to a `text/plain` upload, replace inline with
   `[spilled to file: <name> (<chars> chars)]` marker.
2. Bounded: one spill per turn, spill file ≤ budget remainder; if still over →
   existing compaction path takes over (order: spill first (lossless), compact
   second (lossy)). Never loop spill→compact→spill.
3. Knob: `DEEPSEEK_SPILL_TO_FILE=1|0` (default 1 once upload lands; 0 = today's
   behavior).

## 3. Server changes (for the implementer)
1. Content-part parser: walk OpenAI/Anthropic content arrays, extract data-URLs
   (validate `data:<mime>;base64,` shape, base64-decode with length cap).
2. Uploader with the poll loop; ids threaded into the completion body in place
   of `[]`.
3. Token accounting: spilled/uploaded bytes counted in usage estimates
   (document the estimation rule; upstream doesn't bill web — keep estimates
   honest, not exact).
4. Debug logs: `upload <mime> <bytes>B -> <n> file ids in <ms>ms` (no content).

## 4. Tests & verification
- Unit: data-URL parser fixtures (valid/oversize/bad-mime/truncated-base64);
  spill decision matrix (fits → no spill; overflow-attachable → spill;
  overflow-tool-schemas → compact; both → spill-then-compact-once).
- Live (scratch session): image turn → confirm model references the image;
  100KB-log turn with tiny budget override → confirm spill marker + answer
  quality sane; upload-failure stub → typed fast failure.
- Rollback: `DEEPSEEK_SPILL_TO_FILE=0`; upload leg inert when no file parts
  present (zero behavior change for text-only traffic).

## 5. Explicit non-goals
Fetching remote HTTP URLs server-side (SSRF surface — separate proposal if ever
wanted); video/audio mimes; multiple spill rounds.
