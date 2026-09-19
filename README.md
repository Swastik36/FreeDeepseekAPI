# FreeDeepseekAPI

<p align="center">
  <strong>Local OpenAI-compatible API proxy for DeepSeek Web Chat</strong>
</p>

<p align="center">
  <a href="https://github.com/Swastik36/FreeDeepseekAPI/blob/main/LICENSE"><img alt="License MIT" src="https://img.shields.io/badge/license-MIT-green.svg" /></a>
  <img alt="Node.js 18 plus" src="https://img.shields.io/badge/node-18%2B-339933.svg" />
  <img alt="No npm dependencies" src="https://img.shields.io/badge/dependencies-0-blue.svg" />
  <img alt="OpenAI compatible" src="https://img.shields.io/badge/OpenAI-compatible-111111.svg" />
</p>

<p align="center">
  <a href="#-quick-start">Quick start</a> •
  <a href="#-features">Features</a> •
  <a href="#-request-examples">Examples</a> •
  <a href="#-models">Models</a> •
  <a href="#-endpoints">Endpoints</a> •
  <a href="#-open-webui">Open WebUI</a>
</p>

##  Quick start

One-line install (Linux/macOS native; Windows under Git Bash):

```bash
curl -fsSL https://raw.githubusercontent.com/Swastik36/FreeDeepseekAPI/main/scripts/install.sh | sh
```

This clones the fork, walks you through DeepSeek login, and installs the
systemd service. Update later with `npm run update` (run it from Git Bash on
Windows) — it refuses dirty trees, fast-forwards only, runs tests before
restarting, and rolls back automatically if tests fail.
*Manual install explained below.

FreeDeepseekAPI runs a local API server for **DeepSeek Web Chat** (`chat.deepseek.com`) and lets you connect DeepSeek Web to Open WebUI, LiteLLM, Hermes, Claude Code, OpenAI SDK-style clients, and other OpenAI-compatible tools.

The project works through your regular logged-in DeepSeek account in a separate Chrome profile. The local server accepts API requests and then talks to DeepSeek Web itself using the saved browser session.

> ⚠️ This is an experimental web-chat proxy. DeepSeek may change its internal Web API without warning. For production use cases, the official paid DeepSeek API is more reliable. ⚠️

> Fork of [ForgetMeAI/FreeDeepseekAPI](https://github.com/ForgetMeAI/FreeDeepseekAPI), maintained at [Swastik36/FreeDeepseekAPI](https://github.com/Swastik36/FreeDeepseekAPI).

---

## Navigation

- [What it gives you](#-what-it-gives-you)
- [Features](#-features)
- [Quick start](#-quick-start)
- [Windows setup](#-windows-setup)
- [Linux / Chromium setup](#-linux--chromium-setup)
- [VPS / headless setup](#-vps--headless-setup)
- [Rootless Podman](#-rootless-podman)
- [Diagnostics / doctor](#-diagnostics--doctor)
- [Session reuse and chat resets](#-session-reuse-and-chat-resets)
- [Multi-account pool](#-multi-account-pool)
- [Ideas for console auth](#-ideas-for-console-auth)
- [Smoke test](#-smoke-test)
- [Request examples](#-request-examples)
  - [Chat Completions](#chat-completions)
  - [Reasoning](#reasoning)
  - [Web search](#web-search)
  - [Streaming](#streaming)
  - [Anthropic Messages API](#anthropic-messages-api)
  - [OpenAI Responses API](#openai-responses-api)
  - [Tool calling](#tool-calling)
- [Models](#-models)
- [Endpoints](#-endpoints)
- [Open WebUI](#-open-webui)
- [Refresh the login](#-refresh-the-login)
- [Project status](#-project-status)

---

##  What it gives you

- Use DeepSeek Web as a local API endpoint.
- Connect DeepSeek to Open WebUI and other OpenAI-compatible clients.
- Get plain JSON responses or SSE streaming.
- Use reasoning models with a separate `reasoning_content`.
- Work with the Anthropic Messages API shim for Claude Code / Anthropic SDK.
- Use the OpenAI Responses API shim for new OpenAI/Codex-style clients.
- Keep separate web sessions for different agents/users.

##  Features

- **OpenAI-compatible API:** `POST /v1/chat/completions`
- **Anthropic-compatible shim:** `POST /v1/messages`
- **OpenAI Responses shim:** `POST /v1/responses`
- **Streaming:** SSE chunks and plain non-stream JSON responses
- **Reasoning output:** separate `reasoning_content` for thinking models
- **Tool calling:** parsing OpenAI tools, Anthropic tools, and Responses function tools
- **Model capabilities:** `GET /v1/model-capabilities` with alias → real web mode
- **Agent sessions:** a separate DeepSeek session per `user` / agent id
- **Session recovery:** auto-reset of stale chains/sessions
- **Zero dependencies:** Node.js 18+, no npm dependencies

---

Manual install:

```bash
git clone https://github.com/Swastik36/FreeDeepseekAPI.git
cd FreeDeepseekAPI
npm run auth
npm start
```

`npm run auth` opens the authorization menu:

1. select item `1`;
2. log in to DeepSeek in a separate Chrome profile;
3. send a short message like `ok`;
4. go back to the terminal and press Enter.

`npm start` shows the launch menu:

- `1` — authorize / refresh the DeepSeek login
- `2` — show models and statuses
- `3` — start the proxy
- `4` — exit

For headless/CI runs without the menu:

```bash
NON_INTERACTIVE=1 npm start
# or
SKIP_ACCOUNT_MENU=1 npm start
```

By default the server listens on:

```text
http://localhost:9655
```

By default the proxy is reachable only from this machine. For network access,
explicitly set a bind address and a separate proxy key:

```bash
HOST=0.0.0.0 PROXY_API_KEY='replace-with-a-long-random-value' npm start
```

After that, pass the key as `Authorization: Bearer <key>`. Without
`PROXY_API_KEY`, non-health endpoints stay unauthenticated, so do not
expose such an instance to the network.

Browser requests are allowed from loopback origins. If the UI is open on a different address,
add its exact origin, comma-separated, e.g.
`PROXY_CORS_ORIGINS=https://ui.example.com,http://192.168.1.20:3000`.

---

##  Windows setup

```powershell
git clone https://github.com/Swastik36/FreeDeepseekAPI.git
cd FreeDeepseekAPI
npm run auth
npm start
```

If Chrome is installed in a non-standard location, point to it explicitly:

```powershell
$env:CHROME_PATH="C:\Program Files\Google\Chrome\Application\chrome.exe"
npm run auth
```

If Chrome is not found, `npm run auth` now prints ready-made instructions for Windows/macOS/Linux instead of a cryptic stack trace.

---

## 🐧 Linux / Chromium setup

```bash
git clone https://github.com/Swastik36/FreeDeepseekAPI.git
cd FreeDeepseekAPI
CHROME_PATH=$(which chromium) npm run auth
npm start
```

If Chromium is named differently:

```bash
CHROME_PATH=$(which chromium-browser) npm run auth
# or
CHROME_PATH=$(which google-chrome) npm run auth
```

---

##  VPS / headless setup

The most reliable flow without Chrome on the server:

1. On your home PC with a GUI/Chrome:

```bash
npm run auth
```

2. Copy `deepseek-auth.json` to the VPS:

```bash
scp deepseek-auth.json user@your-vps:/opt/FreeDeepseekAPI/deepseek-auth.json
```

3. On the VPS, import/verify the file and set safe permissions:

```bash
cd /opt/FreeDeepseekAPI
npm run auth:import -- --input ./deepseek-auth.json
npm run doctor -- --offline
```

4. Run the proxy without the interactive menu:

```bash
NON_INTERACTIVE=1 npm start
```

You can import not only a ready `deepseek-auth.json` but also a browser cookie export:

```bash
DEEPSEEK_TOKEN="<token>" npm run auth:import -- --input ./cookies.json
```

> Important: `deepseek-auth.json` is access to your DeepSeek Web login. Do not commit or publish it; store it with `0600` permissions.

---

##  Rootless Podman

The container is intended only for non-interactive proxy runs. Do the
browser-based authorization on the host with `npm run auth`: the auth scripts and
`deepseek-auth.json` are not copied into the image.

Run Podman as a regular user, without `sudo`.

1. Build the local image:

```bash
podman build --tag localhost/free-deepseek-api:local --file Containerfile .
```

2. Pass the DeepSeek auth and a separate proxy key via Podman secrets:

```bash
podman secret create --replace free-deepseek-auth ./deepseek-auth.json

printf 'Proxy API key: '
IFS= read -r -s PROXY_API_KEY
printf '\n'
printf '%s' "$PROXY_API_KEY" |
  podman secret create --replace free-deepseek-proxy-key -
```

Use a long random key. The value stays in the current shell's
`PROXY_API_KEY` variable so you can check the API; it does not end up in the image or
the Podman command line.

3. Run the container with minimal privileges:

```bash
podman run --detach \
  --name free-deepseek-api \
  --publish 127.0.0.1:9655:9655 \
  --secret free-deepseek-auth,target=deepseek-auth.json,uid=1000,gid=1000,mode=0400 \
  --secret free-deepseek-proxy-key,target=proxy-api-key,uid=1000,gid=1000,mode=0400 \
  --read-only \
  --cap-drop=ALL \
  --security-opt=no-new-privileges \
  localhost/free-deepseek-api:local
```

Inside the container, `NON_INTERACTIVE=1`, `HOST=0.0.0.0`, and the
paths to both secrets are pre-set. `REQUIRE_PROXY_API_KEY=1` prevents the container from starting
if the key secret is missing or empty. On the host, the port is published only on
`127.0.0.1`; do not remove that address without a separate network firewall/access
policy.

4. Check liveness, account readiness, and the protected endpoint:

```bash
podman healthcheck run free-deepseek-api
curl --fail http://127.0.0.1:9655/readyz
curl --fail \
  -H "Authorization: Bearer $PROXY_API_KEY" \
  http://127.0.0.1:9655/v1/models
```

The built-in healthcheck verifies the local `/health` (whether the process is alive).
`/readyz` additionally returns `503` if no DeepSeek auth account is currently
ready to serve requests. Container diagnostics:

```bash
podman logs free-deepseek-api
podman inspect --format '{{.State.Health.Status}}' free-deepseek-api
```

Stopping and removing the container together with the saved Podman secrets:

```bash
podman stop free-deepseek-api
podman rm free-deepseek-api
podman secret rm free-deepseek-auth free-deepseek-proxy-key
unset PROXY_API_KEY
```

When rotating the auth or proxy key, replace the corresponding secret and recreate
the container, so behavior does not depend on the Podman version.

---

## 🩺 Diagnostics / doctor

```bash
npm run doctor
# without network requests to DeepSeek:
npm run doctor -- --offline
```

`doctor` checks:

- whether `deepseek-auth.json` / `DEEPSEEK_AUTH_DIR` is found;
- whether the JSON is valid;
- whether `token`, `cookie`, `wasmUrl` are present;
- whether the file permissions are safe on macOS/Linux (`0600`);
- on a normal run — whether the DeepSeek PoW endpoint is reachable.

If you see `data.biz_data is null`, `fetch failed`, `401/403/429`, or Hermes/OpenCode doesn't see the models — run `npm run doctor` first.

---

## ♻️ Session reuse and chat resets

FreeDeepseekAPI does not create a new DeepSeek chat for every HTTP request without reason. The logic is:

- one `x-agent-session`, `session`, or `user` → one DeepSeek chat session;
- if the session id already exists — the proxy reuses it and continues the chain via `parent_message_id`;
- auto-reset happens on TTL, DeepSeek session errors, or an overlong message chain;
- local history is kept as a short context so a new DeepSeek session can continue the conversation.
- long agent requests are capped by `DEEPSEEK_MAX_PROMPT_CHARS` before sending (default 80,000 chars): the task start, fresh tool results, and the tool adapter are preserved;
- if the client already sent multi-turn history, the local recovery history is not appended a second time;
- an empty response is retried at most `DEEPSEEK_MAX_RETRIES` times (default 2), with a shrinking context on each retry.

To set the agent/session explicitly:

```bash
curl -X POST http://localhost:9655/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "x-agent-session: my-agent" \
  -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"Hello"}]}'
```

To list active sessions:

```bash
curl http://localhost:9655/v1/sessions
```

To reset one session:

```bash
curl -X POST "http://localhost:9655/reset-session?agent=my-agent"
```

To reset all sessions:

```bash
curl -X POST "http://localhost:9655/reset-session?agent=all"
```

Why chats still show up in DeepSeek Web: the proxy works through the internal Web Chat API, and DeepSeek stores the real chat sessions on its side. That is normal for a web proxy. The point of session reuse is to avoid spawning new chats without need and to reset carefully only when the chain has gone stale/broken.

---

## 👥 Multi-account pool

You can connect multiple auth files. The correct model: sticky account per agent/session — the proxy never switches accounts inside a live DeepSeek session. If an account gets `401/403/429` and goes into cooldown, the session is safely reset and a new request may move to another available account.

Option 1 — a directory with auth files:

```bash
mkdir -p accounts
cp deepseek-auth-main.json accounts/main.json
cp deepseek-auth-backup.json accounts/backup.json
chmod 600 accounts/*.json
DEEPSEEK_AUTH_DIR=./accounts NON_INTERACTIVE=1 npm start
```

Option 2 — a file list:

```bash
DEEPSEEK_AUTH_PATH="./accounts/main.json,./accounts/backup.json" NON_INTERACTIVE=1 npm start
```

How the pool works:

- a new agent/session gets the lowest-scoring ready account (smart routing, see below);
- the chosen account sticks to the session (`sticky`);
- on `401`, `403`, `429` the account goes into cooldown;
- if a session's sticky account goes into cooldown, the old DeepSeek session is reset so it stops hammering the rate-limited/expired account;
- account status is visible in `/health` without auth-file paths or file names;
- auth files must be stored with `0600` permissions.

### Smart routing

Fresh chats are assigned by lowest score: busy accounts shed load, failing accounts are avoided within a strike or two, old failures decay, and a recently successful account gets a small bonus. Preferred account and home affinity are biases, not locks. Tune it with:

```bash
DEEPSEEK_ROUTING_CONSECUTIVE_STRIKES=2 npm start        # failures before an account is sidelined
DEEPSEEK_ROUTING_ESCALATION_COOLDOWN_MS=60000 npm start # short sideline for repeated soft failures
DEEPSEEK_ROUTING_FAILURE_HALFLIFE_MS=300000 npm start   # failure half-life (0 disables decay)
DEEPSEEK_ROUTING_FAILURE_WEIGHT=4 npm start             # scorer penalty per failure
DEEPSEEK_ROUTING_TIMEOUT_WEIGHT=12 npm start            # scorer penalty per consecutive timeout
DEEPSEEK_ROUTING_HOT_BONUS=2 npm start                  # bonus for the most recently successful account
DEEPSEEK_ROUTING_HOT_WINDOW_MS=60000 npm start          # how recent "recently successful" means
```

Extra tool-call fallback tags (literal substring sentinels, `;` splits starts
from ends, `|` splits entries — no regexes ever; max 32 tags of 128 chars each,
extra `;`-sections ignored with a warning; read once at startup, restart to apply):

```bash
DEEPSEEK_TOOL_TAGS="<mytools>|<tool_begin>;</mytools>|<tool_end>" npm start
```

Optional same-chat rate-limit retry (default off — fail-fast 429 preserved):

```bash
DEEPSEEK_RETRY_RATELIMIT=1 npm start  # one 2s wait + in-place retry, only for unknown/brief backoffs
```

With the retry on, a rate-limited turn waits once (2s, or the upstream
`Retry-After` up to a 10s cap — longer backoffs go straight to migration), lifts
the account cooldown for exactly one same-account+chat attempt, and restores it
without extending on failure. When everything is exhausted the proxy answers
429 with a backoff + `/compact` guidance message (status and `Retry-After`
unchanged, so clients keep backing off instead of hammering).

To configure the cooldown:

```bash
DEEPSEEK_ACCOUNT_COOLDOWN_MS=600000 npm start
```

Hourly per-account request quota (anti-mute — upstream quiets accounts that
sustain hundreds of requests/hour; over-quota accounts sit out like cooling
ones, all-spent answers 429 with `Retry-After`):

```bash
DEEPSEEK_HOURLY_QUOTA=60 npm start  # 0 disables; sliding 1h window per account
```

Burst cap (anti-velocity — most turns per sliding 60s window; rejects fast
429 without touching scorer state; off until measured):

```bash
DEEPSEEK_BURST_PER_MINUTE=0 npm start  # 0 disables; candidate 10 post-measurement
```

Turn-aware pacing (anti-velocity — enforces a minimum gap between consecutive
agent-loop turns on one account; human turns are never delayed). The pacer
sleeps only while enough request-deadline budget remains; otherwise it answers
429 with `Retry-After` and preserves the chat. Defaults are ON — set the gap to
`0` to disable:

```bash
DEEPSEEK_AGENT_TURN_GAP_MS=6000 npm start       # target minimum gap between agent turns (0 disables; max 60000)
DEEPSEEK_TURN_JITTER_MS=2000 npm start          # uniform random jitter added to the gap (max 60000)
DEEPSEEK_MIN_USABLE_UPSTREAM_MS=10000 npm start # min deadline budget required to sleep instead of reject (max: request deadline)
```
Out-of-range values warn and fall back to defaults; a gap at or above the usable minimum logs a boot warning since tight deadlines will reject instead of sleep.

Ambient telemetry (advisory — periodic `GET /api/v0/users/current` per account
so the login shows normal browser route presence; off by default, fire-and-forget,
401 is logged but never cools the account):

```bash
DEEPSEEK_AMBIENT_TELEMETRY=1 npm start          # 0 disables
DEEPSEEK_TELEMETRY_INTERVAL_MS=900000 npm start # minimum interval between pings (default 15m)
```

Model discovery (advisory — hourly poll of upstream model flags into `/health`;
never adds/removes aliases):

```bash
DEEPSEEK_MODEL_DISCOVERY=1 npm start   # 0 disables
```

---

## 🔑 Ideas for console auth

The password flow from PR #3 is doable, but it is safer not to store the password and not to make it the default. A sane implementation:

1. `npm run auth:console` asks for email/phone and password via a hidden prompt.
2. The password lives only in process memory — never written to files/logs/history.
3. The script replays the Web login flow via `fetch`/CDP: gets a captcha/verify challenge, hands the human a link/code, waits for confirmation.
4. After a successful login, only the standard-format `deepseek-auth.json` is saved.
5. If DeepSeek asks for captcha/2FA — the script honestly says "open the link, pass the check, press Enter" instead of trying to bypass protection.
6. For VPS, `auth:console --no-save-password --output deepseek-auth.json` mode is better.

Minimal safe MVP: console auth is interactive-only, no env password. An acceptable automation option: `DEEPSEEK_EMAIL=... npm run auth:console`, but the password is still entered via hidden prompt.

---

## ✅ Smoke test

```bash
curl http://localhost:9655/
curl http://localhost:9655/v1/models
curl http://localhost:9655/v1/model-capabilities
```

If all is well, `/health` returns the server status, the list of supported aliases, and `config_ready: true`.

---

## 🧪 Request examples

### Chat Completions

```bash
curl -X POST http://localhost:9655/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-chat",
    "messages": [{"role": "user", "content": "Hello! Reply in one sentence."}],
    "stream": false
  }'
```

### Reasoning

```bash
curl -X POST http://localhost:9655/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-reasoner",
    "messages": [{"role": "user", "content": "Briefly: why is the sky blue?"}],
    "stream": false
  }'
```

For reasoning models, the API returns the thinking chain separately from the final answer:

- non-stream: `choices[0].message.reasoning_content`
- stream: `choices[0].delta.reasoning_content`
- usage: `usage.completion_tokens_details.reasoning_tokens`

`reasoning_tokens` is a rough estimate from the extracted DeepSeek Web `THINK` text, because the web stream does not report official per-reasoning token usage separately.

### Web search

```bash
curl -X POST http://localhost:9655/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-chat-search",
    "messages": [{"role": "user", "content": "Find a fresh fact about DeepSeek and answer briefly."}],
    "stream": false
  }'
```

### Streaming

```bash
curl -N -X POST http://localhost:9655/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-chat",
    "messages": [{"role": "user", "content": "Write a short joke."}],
    "stream": true
  }'
```

### Anthropic Messages API

```bash
curl -X POST http://localhost:9655/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-chat",
    "max_tokens": 512,
    "messages": [{"role": "user", "content": "Reply with exactly OK"}],
    "stream": false
  }'
```

For Claude Code you can point the backend directly:

```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:9655"
export ANTHROPIC_AUTH_TOKEN="dummy-key"
export CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1
claude --model deepseek-chat
```

### OpenAI Responses API

```bash
curl -X POST http://localhost:9655/v1/responses \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-chat",
    "input": "Reply with exactly OK",
    "stream": false
  }'
```

### Tool calling

FreeDeepseekAPI accepts:

- OpenAI `tools`;
- Anthropic `tools`;
- Responses API function tools.

The proxy asks DeepSeek to return a strict JSON tool call, but can also parse fallback formats:

- `TOOL_CALL:`
- fenced JSON with an explicit `tool_call`, `tool_calls`, or `function_call` envelope
- `<tool_call>...</tool_call>`
- DeepSeek DSML (`<｜DSML｜tool_calls>...`) and the Web variant with `<｜｜DSML｜｜ Tool Calls>`

---

## 🧠 Models

`GET /v1/models` returns only aliases that are currently verified to work through this proxy.

### Working aliases

| Alias | Web mode | Reasoning | Web search | Comment |
| --- | --- | --- | --- | --- |
| `deepseek-chat` | `Fast` / `default` | no | no | base chat |
| `deepseek-v3` | `Fast` / `default` | no | no | compatible alias |
| `deepseek-default` | `Fast` / `default` | no | no | compatible alias |
| `deepseek-reasoner` | `Fast` / `default` | yes | no | `thinking_enabled=true` |
| `deepseek-r1` | `Fast` / `default` | yes | no | R1-compatible alias |
| `deepseek-chat-search` | `Fast` / `default` | no | yes | web search |
| `deepseek-default-search` | `Fast` / `default` | no | yes | web search alias |
| `deepseek-reasoner-search` | `Fast` / `default` | yes | yes | reasoning + search |
| `deepseek-r1-search` | `Fast` / `default` | yes | yes | R1-compatible + search |
| `deepseek-expert` | `Expert` / `expert` | no | no | Expert mode |
| `deepseek-v4-pro` | `Expert` / `expert` | yes | no | Expert + reasoning |

Full mapping:

```bash
curl http://localhost:9655/v1/model-capabilities
```

Per the official DeepSeek V4 Preview page, `deepseek-chat` and `deepseek-reasoner` currently route to `deepseek-v4-flash` non-thinking/thinking. In `chat.deepseek.com` itself, the direct stream does not report the exact checkpoint name (`model: ""`), so the proxy pins both the web mode (`default` / `Fast`) and the current official routing (`DeepSeek-V4-Flash`).

The current DeepSeek Web remote config output shows these web modes:

- `default` / UI `Fast` — works; supports `thinking_enabled` and `search_enabled`.
- `expert` / UI `Expert` — works via the current web contract (`x-client-version=2.0.0`) and supports `thinking_enabled`. `/v1/models` exposes `deepseek-expert` without reasoning and `deepseek-v4-pro` as Expert + reasoning.
- `vision` / UI image recognition — visible in remote config, but right now the direct Web API returns `backend_err_by_model` (`Vision is temporarily unavailable`). So `deepseek-vision` is hidden from `/v1/models`.

Search is unavailable for Expert per remote config, so `deepseek-expert-search` stays unsupported.

---

## 🔌 Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/` or `/health` | proxy status |
| `GET` | `/v1/models` | list of working OpenAI-compatible aliases |
| `GET` | `/v1/model-capabilities` | full mapping of aliases, real model, capabilities |
| `POST` | `/v1/chat/completions` | OpenAI-compatible Chat Completions |
| `POST` | `/v1/messages` | Anthropic Messages API shim |
| `POST` | `/v1/responses` | OpenAI Responses API shim |
| `GET` | `/v1/sessions` | active local agent sessions |
| `POST` | `/reset-session?agent=<id>` | reset one session |
| `POST` | `/reset-session?agent=all` | reset all sessions |

---

## 🖥 Open WebUI

Base URL for Open WebUI in Docker:

```text
http://host.docker.internal:9655/v1
```

For local runs without Docker:

```text
http://localhost:9655/v1
```

If `PROXY_API_KEY` is not set, the API key can be anything. If the key is set,
the client must pass exactly that key — the proxy checks the bearer token before
granting access to models, sessions, and completions.

---

## 🔐 Refresh the login

```bash
npm run auth
npm start
```

If DeepSeek starts answering `401`, `403`, or asks for a new PoW/session — repeat `npm run auth` and refresh the saved browser session.

For multi-account management (add / renew / delete / check with live probes):

```bash
npm run auth:cli
npm run auth:cli -- check all
```

Local auth files must not end up on GitHub:

- `deepseek-auth.json`
- `.chrome-profile-deepseek/`
- `.env`

They are already in `.gitignore`.

---

## 🧪 Tests

Syntax-check the project:

```bash
npm test
```

Live smoke tests against a running local proxy:

```bash
BASE_URL=http://127.0.0.1:9655 MODEL=deepseek-chat npm run test:live
```

---

## 📌 Project status

FreeDeepseekAPI is an experimental web-chat proxy for local use and integrations. It depends on the current DeepSeek Web Chat contract, so when DeepSeek changes something, the auth/session logic or model mapping may need an update.

If something stops working:

1. refresh the login via `npm run auth`;
2. check `/v1/model-capabilities`;
3. retry the request on a fresh session;
4. if the problem persists — DeepSeek likely changed its internal Web API.

---

<p align="center">
  <strong>ForgetMeAI</strong> · <a href="https://t.me/forgetmeai">Telegram</a>
</p>
