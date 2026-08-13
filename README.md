<div align="center">

# ai-hub

**Unified OpenAI-compatible gateway over 10 free web AIs**

Turn your logged-in Chrome AI subscriptions (Gemini / ChatGPT / Claude / Qwen / Kimi / MiniMax / ChatGLM / Doubao / MiMo / DeepSeek) into a single warm daemon with one API — name a provider, send a prompt, get an answer.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/github/v/release/Amengclass/FreeWebAI?color=blue&label=version)](https://github.com/Amengclass/FreeWebAI/releases)
[![Stars](https://img.shields.io/github/stars/Amengclass/FreeWebAI?style=social)](https://github.com/Amengclass/FreeWebAI)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey.svg)](README.md)
[![Built with Node.js](https://img.shields.io/badge/built%20with-Node.js-orange.svg)](package.json)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/Amengclass/FreeWebAI/pulls)

English | [中文](README_ZH.md) | [Changelog](CHANGELOG.md)

</div>

---

## ✨ Highlights

* **Persistent warm daemon** — one long-lived process holds the Chrome CDP connection and all provider tabs. No per-call process spawn, no CDP reconnect, no provider re-probing. Measured **~2× faster** than the original skill (15–30s vs ~75s).
* **One interface, three frontends** — HTTP REST + CLI + MCP server, all backed by the same warm core.
* **OpenAI-compatible protocol** — `POST /v1/chat/completions` + `GET /v1/models`, so any OpenAI SDK / client works by pointing its base URL at the daemon.
* **Parallel batch + sequential pipeline** — `POST /v1/parallel` fans tasks out across providers concurrently; `POST /v1/pipeline` runs a search→reason→synthesize→review chain.
* **Failure memory & self-healing** — failed providers go into a cooldown and are skipped; if Chrome dies, the daemon relaunches it and reconnects automatically.
* **Gemini adapter fix baked in** — the free web AI's UI drifted and broke the original adapter's editor input; the fix (re-query + retry-loop input) is included here without touching the upstream project.

> This project is **built on** [**AgentChat**](https://github.com/ziwang-Physics/AgentChat) and reuses its `skills/lib/` CDP provider library **with zero modification to the original**. See [How it differs](#-how-it-differs-from-the-original) below.

## 🏗️ Architecture

```
Any client (OpenAI SDK / curl / Claude Code / MCP)
        │
        ├─ HTTP REST ─────────────────────────┐
        ├─ CLI (node src/cli.js) ─────────────┤
        └─ MCP server (stdio) ────────────────┤
                                              ▼
                              ai-hub daemon (long-lived Node process)
                                │  single CDP connection + warm tabs
                                │  in-process dispatch via providerFactory
                                ▼
                         Chrome (your logged-in sessions)
                                │
                                ▼
              Gemini / ChatGPT / Claude / Qwen / Kimi / MiniMax /
                       ChatGLM / Doubao / MiMo / DeepSeek
```

## 🚀 Quick Start

```bash
git clone https://github.com/Amengclass/FreeWebAI.git
cd ai-hub
npm install

# 1. Make sure your debug Chrome is running with the AI sites logged in
#    (see the AgentChat docs; login state lives in a dedicated Chrome profile).

# 2. Start the daemon
npm start

# 3. Ask away
node src/cli.js "Hello"
node src/cli.js --provider=deepseek "Explain chain-of-thought"
```

## ⚙️ Configuration

Copy `.env.example` to `.env` (all values optional; sensible defaults below):

| Variable | Default | Description |
|---|---|---|
| `AGENTCHAT_LIB_PATH` | auto-detect | Path to AgentChat's `skills/lib` (auto-detected when ai-hub sits next to AgentChat) |
| `CDP_HOST` / `CDP_PORT` | `127.0.0.1` / `9222` | Chrome DevTools endpoint |
| `HUB_HOST` / `HUB_PORT` | `127.0.0.1` / `8787` | ai-hub HTTP daemon binding |
| `PROXY_SERVER` | *(empty)* | Required for mainland China (e.g. `http://127.0.0.1:7897`) |
| `HUB_TIMEOUT_MS` | `120000` | Default per-call budget |
| `HUB_GEMINI_FAST` | `1` | Skip Gemini Pro model activation (faster, uses the page's default model) |
| `HUB_STABILITY_WINDOW_MS` | `3000` | Response-completion quiescence window |
| `HUB_POLL_INTERVAL_MS` | `1000` | Response poll interval |

## 🔌 API

| Endpoint | Method | Description |
|---|---|---|
| `POST /v1/chat` | JSON | Single chat: `{provider|model, prompt, images?, new_chat?, timeout_ms?}` |
| `POST /v1/chat/completions` | OpenAI | OpenAI-compatible chat (`model`, `messages`, `stream`) |
| `GET /v1/models` | OpenAI | List available providers/models |
| `POST /v1/parallel` | JSON | Batch tasks across providers concurrently |
| `POST /v1/pipeline` | JSON | Search → reason → synthesize → review chain |
| `GET /v1/providers` | JSON | Per-provider warm/cooldown status |
| `GET /v1/health` | JSON | Daemon + CDP health |
| `POST /v1/shutdown` | JSON | Stop the daemon |

**Provider routing**: `provider` / `model` accept any of the provider keys, vendor names, or model names — `gemini`, `google`, `gpt-4o`, `deepseek-r1`, `豆包` … all map to a website. Omit it for auto-fallback.

> ⚠️ **What `model` actually does**: it *routes to a website*, it does **not** control which model the website runs. The web UI decides the real model based on your account/plan. The field exists so OpenAI-compatible SDKs (which always send `model`) work against this gateway.

## 🔍 How it differs from the original

Both projects drive the same logged-in Chrome via the same `skills/lib`. The difference is *lifecycle and surface*:

| | AgentChat (original skill) | ai-hub (this repo) |
|---|---|---|
| Lifecycle | spawns a new Node process per call | long-lived warm daemon |
| First-class protocol | CLI / slash command only | HTTP + CLI + **MCP** |
| OpenAI-compatible API | ❌ | ✅ `/v1/chat/completions` |
| Parallel / pipeline | separate skills (subprocess-per-worker) | in-process, same daemon |
| Typical latency | ~75s cold start | ~15–30s warm |
| Failure memory | ❌ | ✅ cooldown + auto-reconnect |

## ❓ FAQ

<details>
<summary><b>Does the browser have to be visible?</b></summary>
The Chrome debug instance must be **running** (it is the engine that talks to the free web AIs), but it can be minimized. `HUB_MINIMIZE=1` hides the window; `HUB_HEADLESS=1` runs it headless (more likely to trip bot checks — not recommended for reliability).
</details>

<details>
<summary><b>Why is a single call 15–30s?</b></summary>
The free web AI's own generation dominates (Gemini even "thinks" first). The daemon removes the per-call process/connection overhead on top of that, which the original skill paid in full (~75s).
</details>

<details>
<summary><b>Can it be used without a browser?</b></summary>
No. Free web AIs only exist inside the browser — there is no public API. If you want true browser-free latency, you need a paid API, which defeats the point of this project.
</details>

## 📁 Project Structure

```
ai-hub/
├── src/
│   ├── hub.js        # warm daemon core: CDP, warm tabs, dispatch, cooldown, reconnect
│   ├── http.js       # REST + OpenAI-compatible endpoints
│   ├── mcp.mjs       # MCP server (chat / parallel / pipeline / status)
│   ├── cli.js        # terminal client
│   ├── router.js     # provider/vendor/model name → website routing
│   └── config.js     # .env + constants
├── .env.example
├── package.json
└── README_ZH.md / CHANGELOG.md / LICENSE
```

## 🤝 Contributing

PRs welcome. The daemon core reuses AgentChat's `skills/lib` — if you find a provider adapter needs updating (UI drift), consider upstreaming the selector fix to [AgentChat](https://github.com/ziwang-Physics/AgentChat) too.

## 📜 License

[MIT](LICENSE) © Amengclass. Built on [AgentChat](https://github.com/ziwang-Physics/AgentChat) (MIT © ziwang-Physics).
