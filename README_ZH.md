<div align="center">

# ai-hub

**统一 10 个免费网页 AI 的 OpenAI 兼容网关**

把你已登录的 Chrome AI 订阅（Gemini / ChatGPT / Claude / 通义千问 / Kimi / MiniMax / 智谱清言 / 豆包 / MiMo / DeepSeek）变成一个常驻服务 + 一个 API：报名字、发 prompt、拿答案。

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/github/v/release/Amengclass/FreeWebAI?color=blue&label=version)](https://github.com/Amengclass/FreeWebAI/releases)
[![Stars](https://img.shields.io/github/stars/Amengclass/FreeWebAI?style=social)](https://github.com/Amengclass/FreeWebAI)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey.svg)](README_ZH.md)
[![Built with Node.js](https://img.shields.io/badge/built%20with-Node.js-orange.svg)](package.json)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/Amengclass/FreeWebAI/pulls)

[English](README.md) | 中文 | [Changelog](CHANGELOG.md)

</div>

---

## ✨ 本版本优化点（相对原仓）

* **常驻热 daemon** —— 一个常驻进程持有 Chrome CDP 连接和全部 provider 热 tab，**不再每次调用 spawn 新进程 / 重连 CDP / 重新探测 10 个 AI**。实测**提速约 2 倍**（15–30s vs 原 ~75s）。
* **统一接口，三个入口** —— HTTP REST + CLI + **MCP server**，同一套热核心。
* **OpenAI 兼容协议** —— 提供 `POST /v1/chat/completions` 与 `GET /v1/models`，任何 OpenAI 系 SDK/客户端把 base URL 指向本服务即可用。
* **并行批量 + 串行管道** —— `POST /v1/parallel` 并发分发任务到多个 AI；`POST /v1/pipeline` 跑"搜索→推理→合成→审查"链路。
* **失败记忆 + 自愈** —— 失败 provider 进冷却自动跳过；Chrome 挂掉时 daemon **自动重启 Chrome 并重连**，无需人工干预。
* **修复了 Gemini 自动化适配** —— 免费网页 AI 更新 UI 后原 adapter 的编辑器输入失效，本仓库内置修复（重新查询 + 重试循环输入），**未改动原仓一个字节**。

> 本仓库**基于 [AgentChat](https://github.com/ziwang-Physics/AgentChat)（原仓）二次开发**，复用其 `skills/lib/` CDP provider 库，**对原仓零改动**。详见下方 [与原仓的差异](#-与原仓的差异)。

## 🏗️ 架构

```
任意客户端 (OpenAI SDK / curl / Claude Code / MCP)
        │
        ├─ HTTP REST ─────────────────────────┐
        ├─ CLI (node src/cli.js) ─────────────┤
        └─ MCP server (stdio) ────────────────┤
                                              ▼
                              ai-hub daemon（常驻 Node 进程）
                                │  单次 CDP 连接 + 热 tab
                                │  进程内调度（复用 providerFactory）
                                ▼
                         Chrome（你的已登录会话）
                                │
                                ▼
              Gemini / ChatGPT / Claude / 通义 / Kimi / MiniMax /
                        智谱清言 / 豆包 / MiMo / DeepSeek
```

## 🚀 快速开始

```bash
git clone https://github.com/Amengclass/FreeWebAI.git
cd ai-hub
npm install

# 1. 确保专用调试 Chrome 已跑且各 AI 网页已登录
#    （登录态存在独立 Chrome profile 里，见 AgentChat 文档）

# 2. 启动 daemon
npm start

# 3. 开问
node src/cli.js "你好"
node src/cli.js --provider=deepseek "解释一下思维链"
```

## ⚙️ 配置

复制 `.env.example` 为 `.env`（全部可选，默认值合理）：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `AGENTCHAT_LIB_PATH` | 自动探测 | AgentChat 的 `skills/lib` 路径（与 AgentChat 同级时自动找到） |
| `CDP_HOST` / `CDP_PORT` | `127.0.0.1` / `9222` | Chrome DevTools 端点 |
| `HUB_HOST` / `HUB_PORT` | `127.0.0.1` / `8787` | daemon HTTP 绑定 |
| `PROXY_SERVER` | 空 | 中国大陆必须（如 `http://127.0.0.1:7897`） |
| `HUB_TIMEOUT_MS` | `120000` | 单次调用预算 |
| `HUB_GEMINI_FAST` | `1` | 跳过 Gemini Pro 模型激活（更快，用页面默认模型） |
| `HUB_STABILITY_WINDOW_MS` | `3000` | 完成判定静默窗口 |
| `HUB_POLL_INTERVAL_MS` | `1000` | 响应轮询间隔 |

## 🔌 API 一览

| 端点 | 方法 | 说明 |
|---|---|---|
| `POST /v1/chat` | JSON | 单次问答：`{provider\|model, prompt, images?, new_chat?, timeout_ms?}` |
| `POST /v1/chat/completions` | OpenAI | OpenAI 兼容（`model`、`messages`、`stream`） |
| `GET /v1/models` | OpenAI | 列出可用 provider/模型 |
| `POST /v1/parallel` | JSON | 多任务并发分发到多个 AI |
| `POST /v1/pipeline` | JSON | 搜索→推理→合成→审查 链路 |
| `GET /v1/providers` | JSON | 各 AI 的 warm/冷却状态 |
| `GET /v1/health` | JSON | daemon + CDP 健康 |
| `POST /v1/shutdown` | JSON | 停止 daemon |

**provider 路由**：`provider` / `model` 接受任意写法 —— `gemini`、`google`、`gpt-4o`、`deepseek-r1`、`豆包`…… 全部自动路由到对应网站；省略则 auto 降级。

> ⚠️ **关于 `model` 的准确说明**：它**路由到网站**，**不能控制网页实际跑哪个模型**——真正用什么模型由网页按你的账号/套餐决定。保留该字段是为了兼容 OpenAI 协议（SDK 必带 `model`）。

## 🔍 与原仓的差异

两者驱动同一个已登录 Chrome、复用同一套 `skills/lib`。区别在**生命周期与接口面**：

| | AgentChat（原仓） | ai-hub（本仓库） |
|---|---|---|
| 生命周期 | 每次调用 spawn 新进程 | 常驻热 daemon |
| 一等接口 | 仅 CLI / 斜杠命令 | HTTP + CLI + **MCP** |
| OpenAI 兼容 API | ❌ | ✅ `/v1/chat/completions` |
| 并行 / 管道 | 独立 skill（每 worker 一个子进程） | 进程内，同一 daemon |
| 典型延迟 | ~75s 冷启动 | ~15–30s 保温 |
| 失败记忆 | ❌ | ✅ 冷却 + 自动重连 |

## ❓ 常见问题

<details>
<summary><b>浏览器一定要可见吗？</b></summary>
调试 Chrome 必须**在跑**（它是访问免费网页 AI 的引擎），但可以最小化。`HUB_MINIMIZE=1` 隐藏窗口；`HUB_HEADLESS=1` 无头运行（更容易触发风控，不推荐用于追求可靠性的场景）。
</details>

<details>
<summary><b>为什么一次调用要 15–30s？</b></summary>
大头是免费网页 AI 自身的生成时间（Gemini 还会先"思考"）。daemon 已经替你去掉了原仓每次都要付的进程/连接开销（原仓约 75s）。
</details>

<details>
<summary><b>能完全不用浏览器吗？</b></summary>
不能。免费网页 AI 只存在于浏览器里，没有公开 API。想要真正的"无浏览器低延迟"，只能上付费 API——那就不是本项目的目的了。
</details>

## 📁 项目结构

```
ai-hub/
├── src/
│   ├── hub.js        # 热 daemon 核心：CDP、热 tab、调度、冷却、重连
│   ├── http.js       # REST + OpenAI 兼容端点
│   ├── mcp.mjs       # MCP server（chat / parallel / pipeline / status）
│   ├── cli.js        # 终端客户端
│   ├── router.js     # provider/厂商/模型名 → 网站 路由
│   └── config.js     # .env + 常量
├── .env.example
├── package.json
└── README.md / CHANGELOG.md / LICENSE
```

## 🤝 贡献

欢迎 PR。daemon 核心复用 AgentChat 的 `skills/lib`——如果发现某个 provider adapter 需要更新（UI 漂移），也请把选择器修复**上提到原仓 [AgentChat](https://github.com/ziwang-Physics/AgentChat)**。

## 📜 License

[MIT](LICENSE) © Amengclass。基于 [AgentChat](https://github.com/ziwang-Physics/AgentChat)（MIT © ziwang-Physics）。
