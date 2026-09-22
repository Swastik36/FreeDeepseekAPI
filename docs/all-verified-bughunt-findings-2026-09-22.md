# Comprehensive Verified Bug Hunt & Security Audit Report

**Target Codebase:** [`/home/swastik/FreeDeepseekAPI`](file:///home/swastik/FreeDeepseekAPI)  
**Date:** 2026-09-22  
**Auditors & Verifiers:**
- **Audit Agent 1:** Streaming & Protocol Specialist
- **Audit Agent 2:** Account Pool & Auth Lifecycle Specialist
- **Audit Agent 3:** Concurrency Ceiling & Race Condition Specialist
- **Verification Agent 1:** Streaming & Protocol Verification Specialist (Independent Verification)
- **Verification Agent 2:** Pool & Auth Verification Specialist (Independent Verification)

---

## Executive Summary & Triage Matrix

Across all three specialized audit and verification rounds, **29 distinct vulnerabilities and defects** were identified and independently verified with line numbers, execution traces, and empirical reproduction tests.

| Subsystem | Critical | High | Medium | Low | Total Verified |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **Concurrency Ceiling & Inflight Leases** | 2 | 2 | 1 | 0 | **5 (+10 reviewed items)** |
| **Streaming, Protocol & Tool Calling** | 2 | 3 | 3 | 4 | **12** |
| **Account Pool, Auth & Lifecycle** | 2 | 4 | 5 | 1 | **12** |
| **Totals** | **6** | **9** | **9** | **5** | **29** |

---

## Section 1: Concurrency Ceiling & Inflight Tracking (Verified)

### 1.1 Item-by-Item Review of Pending Concurrency Ceiling (10 Items)
- **Finding 1 (TOCTOU Race):** **CONFIRMED (Critical)** — In [`server.js:1887-1942`](file:///home/swastik/FreeDeepseekAPI/server.js#L1887-L1942), the pacing gate `await setTimeout(pacing.delayMs)` runs *after* `hasCapacity` selection and *before* `account.inflight++`. Concurrent requests pass `hasCapacity` during the sleep and burst upstream together.
- **Finding 2 (Missing Concurrency Tests):** **CONFIRMED (Critical)** — Tests at [`tests/unit.test.js:3356-3528`](file:///home/swastik/FreeDeepseekAPI/tests/unit.test.js#L3356-L3528) only test static objects; genuine concurrent requests via `Promise.all` are absent.
- **Finding 3 (Null-Guard Mismatch):** **CONFIRMED (High)** — Line 855 guards `a && a.config`, while lines 863, 869, 873 omit `a && a.config`, risking unhandled `TypeError` -> HTTP 500.
- **Finding 4 (Undocumented Knob):** **CONFIRMED (High)** — `DEEPSEEK_MAX_PER_ACCOUNT` is absent from `.env.example` and `README.md`.
- **Finding 5 (`saturatedWaitSec`):** **REFINED (High)** — Safe for `Retry-After`, but future-stamping during pacing clamps elapsed time to 0.
- **Finding 6 (Migration Mid-Turn 503):** **CONFIRMED (High)** — Lines 5150-5172: When all peers are saturated, mid-turn migration emits a 429 exhaustion error with up to 10-minute cooldown instead of a turn-scale 503 Overloaded.
- **Finding 7 (`stickyBurstReject`):** **REFINED (INVALID as a defect)** — Long-term quota/burst constraints correctly take precedence over temporary capacity rejection for live chat sessions.
- **Finding 8 (`hasCapacity(null)`):** **CONFIRMED (Medium)** — Line 598 fails open returning `true` on null/undefined accounts.
- **Finding 9 (`setMaxPerAccount`):** **CONFIRMED (Medium)** — Line 591 coerces invalid inputs to 0, silently disabling the ceiling.
- **Finding 10 (Git Status):** **CONFIRMED (Medium)** — Uncommitted changes on `swastik-mods`.

### 1.2 Additional Critical Concurrency Bugs Discovered
- **[CRITICAL] Bug A: Premature Inflight Decrement During Response Streaming**
  - **Location:** [`server.js:2071, 2085-2089`](file:///home/swastik/FreeDeepseekAPI/server.js#L2071-L2089) vs [`server.js:5133`](file:///home/swastik/FreeDeepseekAPI/server.js#L5133)
  - **Mechanism:** `account.inflight` is decremented in `askDeepSeekStream`'s `finally` block when HTTP headers arrive (~300ms), dropping `inflight` to `0` while the actual 30–60s SSE token streaming is still underway in `readDeepSeekResponse`. New requests collide on the same account during active streaming.
- **[HIGH] Bug B: Client Disconnect During Streaming Leaves No Account Cleanup**
  - **Location:** [`server.js:4667, 5595-5600`](file:///home/swastik/FreeDeepseekAPI/server.js#L4667-L5600)
  - **Mechanism:** The outer HTTP handler `finally` block decrements global `inFlight--` but omits `account.inflight`. Client aborts during streaming leak account inflight counts once Bug A is fixed.
- **[HIGH] Bug C: Masked Underflow in Inflight Decrement**
  - **Location:** [`server.js:2086`](file:///home/swastik/FreeDeepseekAPI/server.js#L2086)
  - **Mechanism:** `(Number(account.inflight) || 1) - 1` evaluates to `0` when `inflight === 0`. The check `if (remaining < 0)` is dead code and never warns.
- **[MEDIUM] Bug D: Code Window Between Inflight Increment and Try Block**
  - **Location:** [`server.js:1942-1954`](file:///home/swastik/FreeDeepseekAPI/server.js#L1942-L1954)
- **[HIGH] Bug E: Intra-Turn Continuations/Retries Suffer Mid-Stream 503 Abort**
  - **Location:** [`server.js:5229, 5298, 5388`](file:///home/swastik/FreeDeepseekAPI/server.js#L5229-L5388)

---

## Section 2: Streaming, Protocol & Tool Calling (Verified)

- **[CRITICAL] Finding S-1: Multi-Tool Call Batching Failure on Standard Envelopes**
  - **Location:** [`server.js:2354-2356, 2601-2605, 2832-2878, 5336-5353, 5366-5475`](file:///home/swastik/FreeDeepseekAPI/server.js#L2354-L2356)
  - **Verification Verdict:** **CONFIRMED**
  - **Impact:** `coerceToolCallObject` enforces `obj.tool_calls.length === 1` and rejects JSON arrays `[{...}]`. DSML parser rejects multiple `<invoke>` tags. `looksLikeToolCallMarkup` returns `true`, triggering false format-repair loops that exhaust to HTTP 502 Bad Gateway (`resolveRepairExhaustion`).
- **[CRITICAL] Finding S-2: Local Title Generation Protocol Violation**
  - **Location:** [`server.js:4735-4747`](file:///home/swastik/FreeDeepseekAPI/server.js#L4735-L4747)
  - **Verification Verdict:** **CONFIRMED**
  - **Impact:** `isTitleGenerationRequest` unconditionally calls `sendOpenAIStream` / returns OpenAI JSON schema, crashing Anthropic (`/v1/messages`) and Responses (`/v1/responses`) clients with schema validation errors.
- **[HIGH] Finding S-3: Broken Client Disconnect & WHATWG `.destroy()` Call**
  - **Location:** [`server.js:38-40, 1852-1856, 4666-4667`](file:///home/swastik/FreeDeepseekAPI/server.js#L38-L40)
  - **Verification Verdict:** **CONFIRMED**
  - **Impact:** Native `fetch().body` is a WHATWG `ReadableStream` with `.cancel()`, NOT `.destroy()`. Calling `.destroy()` is a no-op; streams and sockets stay open. `dsFetch` lacks `AbortController` propagation on client hangup.
- **[HIGH] Finding S-4: Thinking Stream Duplication Across In-Place Retries**
  - **Location:** [`server.js:3857-3868, 5064-5075, 5102, 5136-5137, 5229-5246, 5432-5448, 5515`](file:///home/swastik/FreeDeepseekAPI/server.js#L3857-L3868)
  - **Verification Verdict:** **CONFIRMED**
  - **Impact:** `pumpBase`, `thinkPump`, and `res._reasoningLiveSent` are not reset before in-place empty/repair retries, concatenating Attempt 1 and Attempt 2 thinking, failing `startsWith` at finish, and re-emitting full thinking twice.
- **[HIGH] Finding S-5: PoW Challenge & Session 429 Status Collapse to 500**
  - **Location:** [`server.js:1960-1974, 2009-2011, 4214-4225, 4982, 5014, 5564`](file:///home/swastik/FreeDeepseekAPI/server.js#L1960-L1974)
  - **Verification Verdict:** **CONFIRMED**
  - **Impact:** Throws raw `new Error` without `.status = 429`. `isRateLimitError` evaluates to `NaN` and fails regex, completely bypassing rate-limit pool migration and returning HTTP 500.
- **[MEDIUM] Finding S-6: `sendStreamError` Missing Required OpenAI Chunk Fields**
  - **Location:** [`server.js:3948-3958`](file:///home/swastik/FreeDeepseekAPI/server.js#L3948-L3958)
  - **Verification Verdict:** **CONFIRMED**
  - **Impact:** Omits `id`, `object: "chat.completion.chunk"`, `created`, `model`, causing Pydantic / OpenAI Python/TS SDKs to crash with schema validation errors.
- **[MEDIUM] Finding S-7: Multibyte UTF-8 Boundary Corruption in Request Body Reader**
  - **Location:** [`server.js:4635-4645`](file:///home/swastik/FreeDeepseekAPI/server.js#L4635-L4645)
  - **Verification Verdict:** **CONFIRMED**
  - **Impact:** `body += chunk` decodes Buffer per TCP packet, corrupting multibyte characters (CJK, emoji) split across packet boundaries into `\uFFFD`.
- **[MEDIUM] Finding S-8: Zero Completion Tokens Reported for Tool-Call Turns**
  - **Location:** [`server.js:2988-2990, 3000-3006`](file:///home/swastik/FreeDeepseekAPI/server.js#L2988-L2990)
  - **Verification Verdict:** **CONFIRMED**
  - **Impact:** Passes `''` as content to `buildUsage`, reporting `completion_tokens: 0` for all tool turns.
- **[LOW] Finding S-9: CORS Preflight Omits `x-agent-session` and `x-api-key`**
  - **Location:** [`server.js:157`](file:///home/swastik/FreeDeepseekAPI/server.js#L157)
  - **Verification Verdict:** **CONFIRMED**
  - **Impact:** Browser CORS preflight rejects documented session headers.
- **[LOW] Finding S-10: `decodeDsmlValue` Ignores Numeric XML Entities**
  - **Location:** [`server.js:2422-2435`](file:///home/swastik/FreeDeepseekAPI/server.js#L2422-L2435)
  - **Verification Verdict:** **CONFIRMED**
  - **Impact:** Numeric entities (`&#10;`, `&#39;`, `&#xA;`) remain unescaped in parsed tool arguments.
- **[LOW] Finding S-11: Uncaught Socket Writes in `finishOpenAIStream`**
  - **Location:** [`server.js:3864-3867, 3889-3892`](file:///home/swastik/FreeDeepseekAPI/server.js#L3864-L3867)
  - **Verification Verdict:** **CONFIRMED (REFINED)**
  - **Impact:** Chunk loops lack `res.writableEnded` / `res.destroyed` checks; writing to closed socket triggers `ERR_STREAM_WRITE_AFTER_END`.
- **[LOW] Finding S-12: Stale `res._reasoningEmitted` on Account Migration**
  - **Location:** [`server.js:5080-5083, 5098, 5189`](file:///home/swastik/FreeDeepseekAPI/server.js#L5080-L5083)
  - **Verification Verdict:** **CONFIRMED**
  - **Impact:** `res._reasoningEmitted` is not reset during migration, permanently suppressing reasoning chunks on the migrated account.

---

## Section 3: Account Pool, Auth & Lifecycle (Verified)

- **[CRITICAL] Finding P-1: Capacity Gate Bypassed During Pacing Delay Window**
  - **Location:** [`server.js:1887-1942, 597-599`](file:///home/swastik/FreeDeepseekAPI/server.js#L1887-L1942)
  - **Verification Verdict:** **CONFIRMED** (Cross-verified with Concurrency Ceiling Finding 1).
- **[CRITICAL] Finding P-2: Ephemeral Account IDs (`account_${n}`) Cause Cross-Account Desync & Bans**
  - **Location:** [`server.js:671-686, 193, 798-807`](file:///home/swastik/FreeDeepseekAPI/server.js#L671-L686)
  - **Verification Verdict:** **CONFIRMED**
  - **Impact:** Accounts are named sequentially by file sort order. Adding, deleting, or failing to load an auth file shifts array indices. Existing `.sessions.json` chats send old `chat_session_id` using a different account's credentials, causing 401/404 or account bans for session hijacking.
- **[HIGH] Finding P-3: Compaction Rotation Ignores Capacity**
  - **Location:** [`server.js:1056-1072, 4857-4859, 816-851`](file:///home/swastik/FreeDeepseekAPI/server.js#L1056-L1072)
  - **Verification Verdict:** **CONFIRMED**
  - **Impact:** `selectCompactionTargetAccount` checks `isAccountReady` but omits `hasCapacity`. Saturated targets immediately bounce or fail with 503.
- **[HIGH] Finding P-4: Agent Turn Detector Misclassifies Multimodal & Anthropic Turns**
  - **Location:** [`server.js:1135-1149, 3363-3367`](file:///home/swastik/FreeDeepseekAPI/server.js#L1135-L1149)
  - **Verification Verdict:** **CONFIRMED**
  - **Impact:** Structured message arrays (`[{ type: "text", ... }]`) and Anthropic compound turns end with `{ role: 'user' }`, misclassifying agent tool loops as human turns and completely bypassing `AGENT_TURN_GAP_MS` pacing.
- **[HIGH] Finding P-5: Auth Failures (401/403) Cooled as 429 Rate Limits**
  - **Location:** [`server.js:1219-1230, 808-823, 844-849`](file:///home/swastik/FreeDeepseekAPI/server.js#L1219-L1230)
  - **Verification Verdict:** **CONFIRMED**
  - **Impact:** `markAccountFailure` treats 401/403 like 429, setting a 10-minute cooldown. Sticky sessions loop infinitely retrying every 10 minutes on dead credentials.
- **[HIGH] Finding P-6: Pacing Gate Future Reservation Leaks on Cascading Disconnects**
  - **Location:** [`server.js:1904-1933`](file:///home/swastik/FreeDeepseekAPI/server.js#L1904-L1933)
  - **Verification Verdict:** **CONFIRMED**
  - **Impact:** Naive CAS rollback fails when multiple requests pipeline. If Request 1 disconnects after Request 2 arrives, `lastDispatchedAt` stays pinned in the future, triggering false 429 rejections.
- **[MEDIUM] Finding P-7: Telemetry Header Injection & Device ID Validation Bypass**
  - **Location:** [`server.js:1101-1103, 646`](file:///home/swastik/FreeDeepseekAPI/server.js#L1101-L1103)
  - **Verification Verdict:** **REFINED (MEDIUM)**
  - **Impact:** Telemetry path lacks device ID validation; inconsistent regexes across auth scripts.
- **[MEDIUM] Finding P-8: Post-Migration SSE Rate Limit Masked as 502 & Target Account Not Cooled**
  - **Location:** [`server.js:5146-5198, 5249-5275, 4335-4336`](file:///home/swastik/FreeDeepseekAPI/server.js#L5146-L5198)
  - **Verification Verdict:** **CONFIRMED**
  - **Impact:** Migrated turn hitting another rate limit returns 502 `tool_call_failed` instead of 429, and leaves target account uncooled.
- **[MEDIUM] Finding P-9: Ambient Telemetry Resource Leak: Unconsumed Response Body**
  - **Location:** [`server.js:1114-1126`](file:///home/swastik/FreeDeepseekAPI/server.js#L1114-L1126)
  - **Verification Verdict:** **CONFIRMED**
  - **Impact:** Node 18+ undici connection pool holds TCP sockets open when body is neither consumed nor cancelled.
- **[MEDIUM] Finding P-10: Ambient Telemetry Drops Browser Platform Headers**
  - **Location:** [`server.js:1093-1105`](file:///home/swastik/FreeDeepseekAPI/server.js#L1093-L1105)
  - **Verification Verdict:** **CONFIRMED**
  - **Impact:** Stripped platform headers create an anomalous bot fingerprint against Cloudflare/WAF.
- **[MEDIUM] Finding P-11: Insecure File Mode Window in `persistSessionsNow`**
  - **Location:** [`server.js:225-228, 198-201`](file:///home/swastik/FreeDeepseekAPI/server.js#L225-L228)
  - **Verification Verdict:** **CONFIRMED**
  - **Impact:** `.sessions.json.tmp` written with default umask (0644) before `chmodSync(0o600)`, exposing plaintext conversation history on multi-user systems.
- **[LOW] Finding P-12: Optimistic In-Place Retry Mutates Shared Account State Concurrently**
  - **Location:** [`server.js:515-541, 4990-5000`](file:///home/swastik/FreeDeepseekAPI/server.js#L515-L541)
  - **Verification Verdict:** **CONFIRMED**
  - **Impact:** Setting shared `cooldownUntil = 0` during async turn leaks readiness to concurrent queries.
