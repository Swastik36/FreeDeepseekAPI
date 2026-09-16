# Round 2 Streaming Architecture Verification Matrix (2026-09-15)

## Executive Summary

This document verifies the Round 2 streaming architecture implementation for `FreeDeepseekAPI`.
All 6 audit items from the independent verification report have been implemented, unit-tested (83/83 passing), and verified against the live proxy (`http://127.0.0.1:9655`).

| Item | Description | Severity | Status | Verification Mechanism |
|---|---|---|---|---|
| **R2-1** | Phase 1b reasoning flush at think→response transition; tool turn suppression | P0 | **VERIFIED** | Live capture with `deepseek-reasoner` + unit tests |
| **R2-2** | SSE keep-alive ping (`: ping\n\n` every 15s) with full lifecycle cleanup | P0 | **VERIFIED** | Unit test with active timers + lifecycle cancellation |
| **R2-3** | In-stream OpenAI error shape: dual payload (`error` + `choices[0]`) | P1 | **VERIFIED** | Unit test verifying dual-shape payload + `[DONE]` |
| **R2-4** | Live verification matrix saved to `docs/` | P1 | **VERIFIED** | Documented in this file |
| **R2-5** | Upstream read abort on dead socket (`readable.destroy()`) | P2 | **VERIFIED** | Unit test with stream abort + `clientGone` guard |
| **R2-6** | Split-function structure preserved (deferred `StreamEmitter` refactor) | Polish | **VERIFIED** | Code structure preserved in `server.js` |

---

## 1. Test Case 1: `deepseek-reasoner` Three-Phase Streaming (R2-1)

**Test Command:**
```bash
curl -N -s http://127.0.0.1:9655/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-reasoner","stream":true,"messages":[{"role":"user","content":"Count from 1 to 3 and explain in 5 words."}]}'
```

**Live Timestamped Capture:**
```text
[+1057ms] data: {"id":"ds-1789448950945","object":"chat.completion.chunk","created":1789448950,"model":"deepseek-reasoner","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}

[+2800ms] data: {"id":"ds-1789448950945","object":"chat.completion.chunk","created":1789448950,"model":"deepseek-reasoner","choices":[{"index":0,"delta":{"reasoning_content":"We need answer. Need comply. User asks \"Count from"},"finish_reason":null}]}
[+2801ms] data: {"id":"ds-1789448950945","object":"chat.completion.chunk","created":1789448950,"model":"deepseek-reasoner","choices":[{"index":0,"delta":{"reasoning_content":" 1 to 3 and explain in 5 words.\" Need count 1 to 3"},"finish_reason":null}]}
[+2801ms] data: {"id":"ds-1789448950945","object":"chat.completion.chunk","created":1789448950,"model":"deepseek-reasoner","choices":[{"index":0,"delta":{"reasoning_content":" and explain in 5 words. We need likely output: \"1"},"finish_reason":null}]}
[+2801ms] data: {"id":"ds-1789448950945","object":"chat.completion.chunk","created":1789448950,"model":"deepseek-reasoner","choices":[{"index":0,"delta":{"reasoning_content":", 2, 3. Numbers increase by one.\" That explanation"},"finish_reason":null}]}
[+2801ms] data: {"id":"ds-1789448950945","object":"chat.completion.chunk","created":1789448950,"model":"deepseek-reasoner","choices":[{"index":0,"delta":{"reasoning_content":" is 4? \"Numbers increase by one\" = 4 words? Number"},"finish_reason":null}]}
[+2801ms] data: {"id":"ds-1789448950945","object":"chat.completion.chunk","created":1789448950,"model":"deepseek-reasoner","choices":[{"index":0,"delta":{"reasoning_content":"s(1) increase(2) by(3) one(4). Need explain in 5 w"},"finish_reason":null}]}
[+2801ms] data: {"id":"ds-1789448950945","object":"chat.completion.chunk","created":1789448950,"model":"deepseek-reasoner","choices":[{"index":0,"delta":{"reasoning_content":"ords. Could be \"Each number increases by one.\" Eac"},"finish_reason":null}]}
[+2801ms] data: {"id":"ds-1789448950945","object":"chat.completion.chunk","created":1789448950,"model":"deepseek-reasoner","choices":[{"index":0,"delta":{"reasoning_content":"h1 number2 increases3 by4 one5. Good. Count from 1"},"finish_reason":null}]}
[+2802ms] data: {"id":"ds-1789448950945","object":"chat.completion.chunk","created":1789448950,"model":"deepseek-reasoner","choices":[{"index":0,"delta":{"reasoning_content":" to 3: 1, 2, 3. Explain in 5 words: \"Each number i"},"finish_reason":null}]}
[+2802ms] data: {"id":"ds-1789448950945","object":"chat.completion.chunk","created":1789448950,"model":"deepseek-reasoner","choices":[{"index":0,"delta":{"reasoning_content":"ncreases by one.\" So final. Ensure exactly? \"1, 2,"},"finish_reason":null}]}
[+2802ms] data: {"id":"ds-1789448950945","object":"chat.completion.chunk","created":1789448950,"model":"deepseek-reasoner","choices":[{"index":0,"delta":{"reasoning_content":" 3. Each number increases by one.\" That's count pl"},"finish_reason":null}]}
[+2802ms] data: {"id":"ds-1789448950945","object":"chat.completion.chunk","created":1789448950,"model":"deepseek-reasoner","choices":[{"index":0,"delta":{"reasoning_content":"us 5-word explanation. Good."},"finish_reason":null}]}

[+2950ms] data: {"id":"ds-1789448950945","object":"chat.completion.chunk","created":1789448950,"model":"deepseek-reasoner","choices":[{"index":0,"delta":{"content":"1, 2, 3. Each number increases by one."},"finish_reason":null}]}
[+2950ms] data: {"id":"ds-1789448950945","object":"chat.completion.chunk","created":1789448950,"model":"deepseek-reasoner","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}
[+2950ms] data: [DONE]
```

**Verification Verdict:**
- **Phase 1 (Accept)**: Role chunk emitted at $t = 1057\text{ms}$ (`delta: {"role":"assistant"}`). Client "thinking..." indicator starts immediately.
- **Phase 1b (Think Done)**: Reasoning burst emitted at $t = 2800\text{ms}$. Client thinking timer truthfully records $\approx 1743\text{ms}$ of reasoning.
- **Phase 2 (Finish)**: Content burst emitted at $t = 2950\text{ms}$ with `finish_reason: "stop"` and `[DONE]`. Reasoning is skipped during finish because it was already emitted in Phase 1b.

---

## 2. Test Case 2: Tool-Call Turn with Strict Reasoning Suppression (R2-1)

**Test Command:**
```bash
curl -N -s http://127.0.0.1:9655/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-reasoner",
    "stream": true,
    "tools": [{
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "Get current weather for a city",
        "parameters": {
          "type": "object",
          "properties": { "location": { "type": "string" } },
          "required": ["location"]
        }
      }
    }],
    "messages": [{"role": "user", "content": "What is the weather in Tokyo? Call the get_weather tool."}]
  }'
```

**Live Timestamped Capture:**
```text
[+888ms] data: {"id":"ds-1789448958277","object":"chat.completion.chunk","created":1789448958,"model":"deepseek-reasoner","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}

[+1783ms] data: {"id":"ds-1789448958277","object":"chat.completion.chunk","created":1789448958,"model":"deepseek-reasoner","choices":[{"index":0,"delta":{"content":null,"tool_calls":[{"id":"call_1789448959174_cpook6","type":"function","function":{"name":"get_weather","arguments":"{\"location\":\"Tokyo\"}"}}]},"finish_reason":null}]}
[+1784ms] data: {"id":"ds-1789448958277","object":"chat.completion.chunk","created":1789448958,"model":"deepseek-reasoner","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}
[+1784ms] data: [DONE]

--- SUMMARY: reasoning_content chunks=0, tool_calls chunks=2 ---
```

**Verification Verdict:**
- `reasoning_content` chunks: **EXACTLY 0**.
- Agent clients (OpenCode, Claude Code) receive pure tool calls without preceding text/reasoning deltas that could prematurely terminate tool execution loops.

> **2026-09-16 override note:** the "EXACTLY 0" expectation above was a
> precautionary constraint — the loop-termination risk was hypothesized
> ("could"), never observed as an incident. Commit `4c1cac5` deliberately
> overrides it for OpenAI mode: tool-call turns now carry
> `reasoning_content` so thinking displays before tool execution.
> Evidence: headless opencode run (deepseek-chat) continued the tool loop;
> live re-probe showed reasoning + tool_calls + `[DONE]` well-formed.
> Anthropic/Responses shims keep the suppression (see
> `docs/api-documentation.md`). TUI confirmation remains a follow-up.

---

## 3. Test Case 3: Anthropic and Responses Streaming

### 3.1 Anthropic Stream (`/v1/messages` with `stream: true`)
```text
[+671ms] event: message_start
[+674ms] data: {"type":"message_start","message":{"id":"ds-1789448962978","type":"message","role":"assistant","model":"deepseek-chat","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":6,"output_tokens":0}}}

[+1328ms] event: content_block_start
[+1329ms] data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

[+1329ms] event: content_block_delta
[+1329ms] data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"PONG"}}

[+1329ms] event: content_block_stop
[+1329ms] data: {"type":"content_block_stop","index":0}

[+1329ms] event: message_delta
[+1329ms] data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"input_tokens":6,"output_tokens":1}}

[+1329ms] event: message_stop
[+1329ms] data: {"type":"message_stop"}
```

### 3.2 Responses API Stream (`/v1/responses` with `stream: true`)
```text
[+658ms] event: response.created
[+661ms] data: {"type":"response.created","response":{"id":"resp_1789448967235","object":"response","created_at":1789448967,"status":"in_progress","model":"deepseek-chat","output":[],"usage":{"input_tokens":3,"output_tokens":0,"total_tokens":3}}}

[+661ms] event: response.in_progress
[+661ms] data: {"type":"response.in_progress","response":{"id":"resp_1789448967235","object":"response","created_at":1789448967,"status":"in_progress","model":"deepseek-chat","output":[],"usage":{"input_tokens":3,"output_tokens":0,"total_tokens":3}}}

[+1314ms] event: response.output_item.added
[+1314ms] data: {"type":"response.output_item.added","output_index":0,"item":{"id":"msg_1789448967893","type":"message","role":"assistant","status":"in_progress","content":[]}}

[+1315ms] event: response.content_part.added
[+1315ms] data: {"type":"response.content_part.added","output_index":0,"content_index":0,"item_id":"msg_1789448967893","part":{"type":"output_text","text":"","annotations":[]}}

[+1315ms] event: response.output_text.delta
[+1315ms] data: {"type":"response.output_text.delta","output_index":0,"content_index":0,"item_id":"msg_1789448967893","delta":"HELLO"}

[+1315ms] event: response.output_text.done
[+1315ms] data: {"type":"response.output_text.done","output_index":0,"content_index":0,"item_id":"msg_1789448967893","text":"HELLO"}

[+1315ms] event: response.content_part.done
[+1315ms] data: {"type":"response.content_part.done","output_index":0,"content_index":0,"item_id":"msg_1789448967893","part":{"type":"output_text","text":"HELLO","annotations":[]}}

[+1315ms] event: response.output_item.done
[+1315ms] data: {"type":"response.output_item.done","output_index":0,"item":{"id":"msg_1789448967893","type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":"HELLO","annotations":[]}]}}

[+1315ms] event: response.completed
[+1315ms] data: {"type":"response.completed","response":{"id":"resp_1789448967235","object":"response","created_at":1789448967,"status":"completed","model":"deepseek-chat","output":[{"id":"msg_1789448967893","type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":"HELLO","annotations":[]}]}],"output_text":"HELLO","usage":{"input_tokens":3,"output_tokens":2,"total_tokens":5,"output_tokens_details":{"reasoning_tokens":0}},"watermark":"t.me/forgetmeai"}}

[+1316ms] data: [DONE]
```

---

## 4. Test Case 4: In-Stream Error Shape (R2-3)

**Dual-Compatibility Payload Specification:**
- Top-level `error` object: `{ "error": { "message": "...", "type": "..." } }`
- Standard SDK compatibility: `choices: [{ index: 0, delta: { content: "\n\n[Error: ...]" }, finish_reason: "error" }]`
- Termination: `data: [DONE]\n\n`

**Unit Test Output:**
```json
data: {"error":{"message":"upstream timeout","type":"timeout_error"},"choices":[{"index":0,"delta":{"content":"\n\n[Error: upstream timeout]"},"finish_reason":"error"}]}

data: [DONE]
```

**Verification Verdict:**
- Custom UIs parsing `chunk.error` receive the structured error object.
- Strict OpenAI SDKs (`for chunk in stream: delta = chunk.choices[0].delta`) do not encounter `IndexError: list index out of range` and safely terminate with `finish_reason: "error"`.

---

## 5. Test Case 5: SSE Keep-Alive Ping (R2-2)

**Mechanism:**
- Unref'd `setInterval` timer (15s interval) starts upon `start*Stream(res)`.
- Emits `: ping\n\n` (standard SSE comment ignored by parsers).
- Cleared synchronously on `finish*Stream`, `sendStreamError`, `clientGone`, and `res.on('close')`.

---

## 6. Test Case 6: Dead Socket Upstream Read Abort (R2-5)

**Mechanism:**
- Within `consumeDeepSeekStream(readable, { isClientGone })`, each iteration of `for await (const chunk of readable)` checks `isClientGone()`.
- If `true`, `readable.destroy()` is invoked immediately, and `{ abandoned: true }` is returned.
- Upstream socket and CPU resources are freed without completing unneeded downstream parsing.

---

## 7. Test Suite Summary

Executed test command: `npm test`
- Total tests: **83**
- Passing: **83**
- Failing: **0**
- Execution duration: **~540ms**
