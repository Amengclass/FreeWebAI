<div align="center">

# FreeWebAI

**统一 10 个免费网页 AI 的 OpenAI 兼容网关**

把你已登录的 Chrome AI 订阅（Gemini / ChatGPT / Claude / 通义千问 / Kimi / MiniMax / 智谱清言 / 豆包 / MiMo / DeepSeek）变成一个常驻服务 + 一个 API：报名字、发 prompt、拿答案。

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/github/v/release/Amengclass/FreeWebAI?color=blue&label=version)](https://github.com/Amengclass/FreeWebAI/releases)
[![Stars](https://img.shields.io/github/stars/Amengclass/FreeWebAI?style=social)](https://github.com/Amengclass/FreeWebAI)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey.svg)](README.md)
[![Built with Node.js](https://img.shields.io/badge/built%20with-Node.js-orange.svg)](package.json)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/Amengclass/FreeWebAI/pulls)

[English](README_EN.md) | 中文 | [Changelog](CHANGELOG.md)

</div>

---

> ### ⚠️ 重要声明（使用前请阅读）
>
> 本项目**仅供个人学习、研究、技术交流使用**，与文中涉及的 AI 厂商**没有任何关联、授权或背书关系**。本项目通过浏览器自动化访问各 AI 的**网页免费端**（非官方 API），自动化访问可能违反相关平台的服务条款，**可能导致账号被风控、限制或封禁——请务必使用自己的账号，并自行承担全部风险与损失**。
>
> **如您认为本项目中的任何内容侵犯了您的著作权、商标权或其他合法权益，请通过 [GitHub Issue](https://github.com/Amengclass/FreeWebAI/issues) 联系我们，一经核实，我们将立即删除相关内容。**
>
> 完整条款见下方「声明与免责」章节。

## ✨ 本版本优化点（相对原仓）

* **常驻热 daemon** —— 一个常驻进程持有 Chrome CDP 连接和全部 provider 热 tab，**不再每次调用 spawn 新进程 / 重连 CDP / 重新探测 10 个 AI**。实测**提速约 2 倍**（15–30s vs 原 ~75s）。
* **统一接口，三个入口** —— HTTP REST + CLI + **MCP server**，同一套热核心。
* **OpenAI 兼容协议** —— 提供 `POST /v1/chat/completions` 与 `GET /v1/models`，任何 OpenAI 系 SDK/客户端把 base URL 指向本服务即可用。
* **并行批量 + 串行管道** —— `POST /v1/parallel` 并发分发任务到多个 AI；`POST /v1/pipeline` 跑"搜索→推理→合成→审查"链路。
* **失败记忆 + 自愈** —— 失败 provider 进冷却自动跳过；Chrome 挂掉时 daemon **自动重启 Chrome 并重连**，无需人工干预。
* **修复了 Gemini 自动化适配** —— 免费网页 AI 更新 UI 后原 adapter 的编辑器输入失效，本仓库内置修复（重新查询 + 重试循环输入），**未改动原仓一个字节**。

> 本仓库**基于 [AgentChat](https://github.com/ziwang-Physics/AgentChat)（原仓）二次开发**，复用其 `skills/lib/` CDP provider 库，**对原仓零改动**，并保留其 MIT 版权声明。详见下方 [与原仓的差异](#-与原仓的差异)。

## 🏗️ 架构

```
任意客户端 (OpenAI SDK / curl / Claude Code / MCP)
        │
        ├─ HTTP REST ─────────────────────────┐
        ├─ CLI (node src/cli.js) ─────────────┤
        └─ MCP server (stdio) ────────────────┤
                                              ▼
                              FreeWebAI daemon（常驻 Node 进程）
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
cd FreeWebAI
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

| | AgentChat（原仓） | FreeWebAI（本仓库） |
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

<details>
<summary><b>这个服务能给别人访问吗？安全吗？</b></summary>
**请勿将其暴露到公网。** daemon **没有任何鉴权机制**，默认只绑定 `127.0.0.1`（仅本机可访问），并把 `HUB_HOST` 指向远程地址会让任何能访问该端口的人直接调用你的已登录 AI 账号。请在可信、私有的环境（本机 / 私有网络）中使用。
</details>

## 📁 项目结构

```
FreeWebAI/
├── src/
│   ├── hub.js        # 热 daemon 核心：CDP、热 tab、调度、冷却、重连
│   ├── http.js       # REST + OpenAI 兼容端点
│   ├── mcp.mjs       # MCP server（chat / parallel / pipeline / status）
│   ├── cli.js        # 终端客户端
│   ├── router.js     # provider/厂商/模型名 → 网站 路由
│   └── config.js     # .env + 常量
├── .env.example
├── package.json
└── README.md / README_EN.md / CHANGELOG.md / LICENSE
```

## ⚠️ 声明与免责（重要）

使用本软件即表示您已阅读并同意以下条款：

**1. 用途限制**
本项目**仅供个人学习、研究、技术交流使用**，不得用于商业用途，也不得用于任何违反法律法规或第三方平台服务条款的用途。

**2. 账号与风控风险**
本项目通过浏览器自动化（CDP）访问各 AI 的**网页免费端**，**并非**各厂商的官方 API，与各厂商**不存在任何授权或合作关系**。自动化方式访问网页端可能违反相关平台的服务条款（ToS），并可能触发风控，导致账号被限制、封禁等后果。**请务必使用您本人的账号，并自行承担由此产生的全部风险与损失。**

**3. 商标与版权**
- 文中出现的所有产品名称、商标、Logo（如 Gemini、ChatGPT、Claude、通义千问、Kimi、MiniMax、智谱清言、豆包、DeepSeek 等）均归**各自所有者**所有，此处仅用于说明兼容性，**不构成任何关联、授权或背书**。
- 本项目基于 [AgentChat](https://github.com/ziwang-Physics/AgentChat)（MIT 协议）二次开发，已保留其版权声明与归属。
- **如您认为本项目中的任何内容侵犯了您的著作权、商标权、专利权或其他合法权益，请通过 [GitHub Issue](https://github.com/Amengclass/FreeWebAI/issues) 联系作者，一经核实，我们将立即删除相关内容。**

**4. 合规与法律**
使用者须自行遵守所在国家/地区的法律法规及各 AI 平台的服务条款。因违反上述约定产生的任何法律后果，由使用者本人承担，作者与贡献者不承担任何责任。

**5. 无担保与责任限制**
本项目按 **MIT 协议**以"原样"（AS-IS）提供，**不含任何明示或暗示的担保**（包括但不限于适销性、特定用途适用性、非侵权性）。在任何情况下，作者或贡献者均不对因使用本软件或其相关内容而产生的任何直接、间接、附带、特殊或后果性损害承担责任。

## 🤝 贡献

欢迎 PR。daemon 核心复用 AgentChat 的 `skills/lib`——如果发现某个 provider adapter 需要更新（UI 漂移），也请把选择器修复**上提到原仓 [AgentChat](https://github.com/ziwang-Physics/AgentChat)**。

## 📜 License

[MIT](LICENSE) © Amengclass。基于 [AgentChat](https://github.com/ziwang-Physics/AgentChat)（MIT © ziwang-Physics）。详见上方「声明与免责」章节。
