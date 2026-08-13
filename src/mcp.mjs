#!/usr/bin/env node
/**
 * ai-hub MCP server — expose the unified AI hub to any MCP client (Claude Code,
 * Cursor, Claude Desktop, ...).
 *
 *   claude mcp add ai-hub -- node C:\Users\Ameng\Desktop\claude_woker\cc_work\AI牛马\ai-hub\src\mcp.mjs
 *
 * Backend strategy:
 *   1. If the ai-hub HTTP daemon is already running (or HUB_STANDALONE=1),
 *      proxy to it — ONE long-lived warm state shared by every client.
 *   2. Otherwise spawn the daemon detached, then proxy.
 *   3. If the daemon cannot start, embed the hub in-process (still warm for the
 *      life of this MCP session; reconnect costs ~2s on next session).
 *
 * Tools: chat, providers, health.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { spawn } from 'child_process';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';
import { z } from 'zod';

const require = createRequire(import.meta.url);
const cfg = require('./config.js');
const { PROVIDER_KEYS } = require('./router.js');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTTP_PATH = path.join(__dirname, 'http.js');
const BASE = `http://${cfg.HUB_HOST}:${cfg.HUB_PORT}`;

const PROVIDER_ENUM = ['auto', ...PROVIDER_KEYS];

// ── Remote backend (thin proxy to the warm daemon) ─────────────────────────
async function httpJson(pathname, init) {
    const resp = await fetch(BASE + pathname, init);
    return resp.json();
}

function remoteHealth() {
    return httpJson('/v1/health').then(() => true).catch(() => false);
}

async function ensureDaemon() {
    if (await remoteHealth()) return 'running';
    const child = spawn(process.execPath, [HTTP_PATH], {
        detached: true,
        stdio: 'ignore',
        cwd: path.join(__dirname, '..'),
    });
    child.unref();
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
        if (await remoteHealth()) return 'spawned';
        await new Promise(r => setTimeout(r, 800));
    }
    return 'failed';
}

let backendPromise = null;
function backend() {
    if (!backendPromise) backendPromise = (async () => {
        const mode = await ensureDaemon();
        if (mode === 'failed') {
            // Fallback: embed the hub in-process (still warm within this session).
            const { AIHub } = require('./hub.js');
            const hub = await new AIHub().connect();
            return {
                chat: a => hub.chat(a),
                providers: () => hub.providers(),
                health: () => hub.health(),
                mode: 'embedded',
            };
        }
        return {
            chat: a => httpJson('/v1/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(a) }),
            providers: () => httpJson('/v1/providers'),
            health: () => ({ cdp: true, mode: 'daemon' }),
            mode: `daemon(${mode})`,
        };
    })();
    return backendPromise;
}

// ── MCP server ─────────────────────────────────────────────────────────────
const server = new McpServer({ name: 'ai-hub', version: '0.1.0' });

server.tool(
    'chat',
    'Send a prompt to a free web AI through the unified hub (drives your local logged-in Chrome). ' +
    'Pass provider (key/name/vendor/model name, e.g. "chatgpt", "openai", "gpt-4o", "deepseek-r1") ' +
    'or omit for auto-fallback. Response text is the AI answer.',
    {
        prompt: z.string().describe('要发送给 AI 的问题/需求'),
        provider: z.enum(PROVIDER_ENUM).optional().describe('provider 或厂商/模型名；缺省 "auto" 自动降级链'),
        model: z.string().optional().describe('模型名路由（如 gpt-4o / deepseek-r1）；provider 未给时生效'),
        new_chat: z.boolean().optional().describe('默认 true=每次新会话（可靠，原项目行为）；设 false 复用热 tab 续聊（更快，但可能偶发返回旧答案，实验性）'),
        timeout_ms: z.number().optional().describe('总超时（毫秒），默认 120000'),
        images: z.array(z.string()).optional().describe('本地图片绝对路径，发送前附上'),
        gemini_fast: z.boolean().optional().describe('跳过 Gemini Pro 模型激活（默认开，省时；深度推理时设 false）'),
    },
    async (args) => {
        const hub = await backend();
        let r;
        try {
            r = await hub.chat(args);
        } catch (e) {
            return { content: [{ type: 'text', text: `[ai-hub] 后端调用失败: ${e.message}` }], isError: true };
        }
        if (r.ok) {
            const head = `[ai-hub] provider=${r.provider_name || r.provider} time_ms=${r.time_ms}`;
            return { content: [{ type: 'text', text: `${r.response}\n\n${head}` }] };
        }
        const tried = (r.tried || []).map(t => `${t.provider}(${t.reason})`).join(', ') || 'none';
        return { content: [{ type: 'text', text: `[ai-hub] 所有 provider 失败: ${r.error}\ntried: ${tried}` }], isError: true };
    }
);

server.tool(
    'parallel',
    'Parallel batch: run independent tasks concurrently across multiple web AIs. ' +
    'Each task: {provider|model, prompt}. Results returned per task.',
    {
        tasks: z.array(z.object({
            id: z.string().optional(),
            provider: z.string().optional().describe('AI 名/厂商/模型名，省略 = auto'),
            model: z.string().optional(),
            prompt: z.string(),
        })).min(1),
        timeout_ms: z.number().optional(),
        max_concurrent: z.number().optional().describe('并发上限，默认 6'),
    },
    async (args) => {
        const hub = await backend();
        const r = await hub.parallel(args.tasks, { timeout_ms: args.timeout_ms, max_concurrent: args.max_concurrent });
        const lines = (r.results || []).map(x =>
            `[${x.id}] ${x.ok ? '✅' : '❌'} ${x.provider || ''} ${x.time_ms}ms\n${(x.response || x.error || '').slice(0, 400)}`
        );
        const head = `completed=${r.completed}/${r.total} total_ms=${r.total_ms}`;
        return { content: [{ type: 'text', text: `${head}\n\n${lines.join('\n\n')}` }], isError: !r.success };
    }
);

server.tool(
    'pipeline',
    'Sequential multi-step pipeline (mirrors AgentChat-WebSubAgent): search(Kimi) → reason(Gemini) → synthesize(Claude) → review(ChatGPT). ' +
    'mode: full|search|reason|review, or pass custom steps [{name, provider, template}] where template can use {{stepName}} placeholders.',
    {
        prompt: z.string(),
        mode: z.enum(['full', 'search', 'reason', 'review']).optional(),
        steps: z.array(z.object({
            name: z.string().optional(),
            provider: z.string(),
            template: z.string(),
        })).optional(),
        timeout_ms: z.number().optional(),
    },
    async (args) => {
        const hub = await backend();
        const r = await hub.pipeline(args);
        const stepLines = (r.steps || []).map(s => `[${s.step}] ${s.ok ? '✅' : '❌'} ${s.provider || ''} ${s.time_ms}ms\n${(s.response || '').slice(0, 500)}`);
        const head = `mode=${r.mode} total_ms=${r.total_ms}`;
        return { content: [{ type: 'text', text: `${head}\n\n${stepLines.join('\n\n')}` }], isError: !r.ok };
    }
);

server.tool(
    'status',
    'Check the hub backend: daemon + Chrome CDP health, plus each AI provider\'s warm / cooldown status.',
    {},
    async () => {
        const hub = await backend();
        const [h, list] = await Promise.all([hub.health(), hub.providers()]);
        const healthLine = `cdp=${h.cdp ? 'online' : 'offline'} calls=${h.calls} ok=${h.ok} fail=${h.fail} mode=${hub.mode}`;
        const lines = list.map(p =>
            `${p.name} (${p.key})  warm=${p.warm ? '✅' : '❌'}` +
            (p.cooldown ? `  cooldown ${p.cooldown.seconds_left}s (${p.cooldown.reason})` : '')
        );
        return { content: [{ type: 'text', text: `${healthLine}\n` + lines.join('\n') }] };
    }
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[ai-hub-mcp] ready. backend will start on demand. tools: chat, parallel, pipeline, status`);
