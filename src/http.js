#!/usr/bin/env node
/**
 * ai-hub HTTP daemon — the unified interface.
 *
 *   npm start
 *
 * 自定义端点:
 *   POST /v1/chat       {"provider":"chatgpt","model":"gpt-4o","prompt":"...",
 *                        "images":[...],"new_chat":false,"timeout_ms":120000}
 *   POST /v1/parallel   {"tasks":[{"id","provider","model","prompt","images"}], "max_concurrent":6}
 *   POST /v1/pipeline   {"prompt":"...", "mode":"full|search|reason|review", "steps":[...]}
 *   GET  /v1/providers  list providers + warm/cooldown status
 *   GET  /v1/health     daemon + CDP health
 *   POST /v1/shutdown   stop the daemon
 *
 * OpenAI 兼容端点（主流大模型协议，任意 OpenAI 系 SDK/客户端可直接指向本服务）:
 *   POST /v1/chat/completions  {"model":"gpt-4o","messages":[{role,content}],"stream":false}
 *   GET  /v1/models
 *
 * Binds 127.0.0.1 only. This process drives a logged-in Chrome, so do not
 * expose HUB_HOST=0.0.0.0 on an untrusted network.
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const cfg = require('./config');
const { AIHub, PROVIDER_CHAIN } = require('./hub');
const { resolveProvider, PROVIDER_NAMES } = require('./router');

const MIME_BY_EXT = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml', tiff: 'image/tiff',
    ico: 'image/x-icon', avif: 'image/avif',
};

const log = (...a) => console.error('[ai-hub]', ...a);

function readImages(paths) {
    const out = [];
    for (const raw of (paths || [])) {
        const abs = path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
        try {
            const buf = fs.readFileSync(abs);
            const ext = path.extname(abs).toLowerCase().replace('.', '');
            out.push({
                base64: buf.toString('base64'),
                mimeType: MIME_BY_EXT[ext] || 'image/png',
                fileName: path.basename(abs),
            });
        } catch (e) {
            throw new Error(`cannot read image ${abs}: ${e.message}`);
        }
    }
    return out;
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

// ── OpenAI-compatible helpers ───────────────────────────────────────────────
function messagesToPrompt(messages) {
    const parts = [];
    let system = '';
    for (const m of (messages || [])) {
        const role = m.role || 'user';
        const content = Array.isArray(m.content)
            ? m.content.map(c => c.type === 'text' ? String(c.text || '') : `[image:${c.type || 'attachment'}]`).join('\n')
            : String(m.content || '');
        if (!content) continue;
        if (role === 'system') { system += (system ? '\n' : '') + content; }
        else parts.push(`${role === 'assistant' ? '助手' : '用户'}：${content}`);
    }
    let prompt = parts.join('\n');
    if (system) prompt = `[系统指令]\n${system}\n\n${prompt}`;
    return prompt.trim();
}

const estTokens = s => Math.max(1, Math.ceil(String(s || '').length / 3));

// 常见模型名别名 → provider（用于 /v1/models 列表）
const COMMON_MODELS = [
    'gpt-4o', 'gpt-4o-mini', 'gpt-4', 'gpt-4-turbo', 'o1', 'o3', 'o4-mini', 'dall-e-3',
    'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash', 'imagen',
    'claude-sonnet-4-5', 'claude-opus-4', 'claude-haiku-4-5',
    'qwen3', 'qwen-max', 'qwen-turbo', 'tongyi',
    'kimi-k2', 'kimi-latest', 'moonshot-v1',
    'abab6.5', 'minimax-text-01',
    'glm-4', 'glm-4-plus',
    'doubao-1.5-pro', 'doubao-seed',
    'mi-mo-7b', 'mimo',
    'deepseek-v3', 'deepseek-r1', 'deepseek-chat', 'deepseek-reasoner',
];

async function main() {
    const hub = await new AIHub().connect();

    // HUB_MINIMIZE: 隐藏 Chrome 窗口（headful 但最小化）— 比 headless 安全（不触发风控）
    if (cfg.HUB_MINIMIZE) {
        const r = minimizeManagedChrome();
        log(`minimize managed Chrome: ${r}`);
    }

    const server = http.createServer(async (req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

        const url = new URL(req.url, `http://${req.headers.host}`);
        const json = (code, obj) => {
            const s = JSON.stringify(obj);
            res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(s) });
            res.end(s);
        };

        try {
            // ── 健康/状态 ──
            if (req.method === 'GET' && url.pathname === '/v1/health') return json(200, hub.health());
            if (req.method === 'GET' && url.pathname === '/v1/providers') return json(200, await hub.providers());
            if (req.method === 'GET' && url.pathname === '/v1/stats') return json(200, hub.stats);

            // ── 自定义 chat ──
            if (req.method === 'POST' && url.pathname === '/v1/chat') {
                const body = JSON.parse((await readBody(req)) || '{}');
                body.images = readImages(body.images);
                const r = await hub.chat(body);
                return json(r.ok ? 200 : 502, r);
            }

            // ── 并行批量（IndependentTasks 核心） ──
            // 兼容两种输入：`tasks:[{provider,prompt}]` 或原项目计划格式
            // `subtasks:[{id,primary,prompt,depends_on}]`（depends_on 在本实现里
            // 视作独立任务并行执行）。
            if (req.method === 'POST' && url.pathname === '/v1/parallel') {
                const body = JSON.parse((await readBody(req)) || '{}');
                let tasks = body.tasks || [];
                if (!tasks.length && Array.isArray(body.subtasks)) {
                    tasks = body.subtasks.map(st => ({
                        id: st.id || st.role,
                        provider: st.primary || st.ai,
                        prompt: st.prompt,
                    }));
                }
                for (const t of tasks) t.images = readImages(t.images);
                const r = await hub.parallel(tasks, { timeout_ms: body.timeout_ms, max_concurrent: body.max_concurrent });
                return json(r.success ? 200 : 502, r);
            }

            // ── 串行管道（WebSubAgent 核心） ──
            if (req.method === 'POST' && url.pathname === '/v1/pipeline') {
                const body = JSON.parse((await readBody(req)) || '{}');
                const r = await hub.pipeline(body);
                return json(r.ok ? 200 : 502, r);
            }

            // ── OpenAI 兼容端点 ──
            if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
                const body = JSON.parse((await readBody(req)) || '{}');
                const prompt = messagesToPrompt(body.messages);
                const r = await hub.chat({
                    provider: body.model, // 模型名/厂商名 → 自动路由
                    prompt,
                    images: readImages(body.images),
                    timeout_ms: body.timeout_ms,
                    new_chat: body.new_chat,
                });
                const id = 'chatcmpl-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
                const model = r.provider_name ? `${r.provider_name} (${r.provider})` : String(body.model || 'auto');
                const created = Math.floor(Date.now() / 1000);

                if (body.stream) {
                    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
                    const chunk = {
                        id, object: 'chat.completion.chunk', created, model,
                        choices: [{ index: 0, delta: { role: 'assistant', content: r.ok ? r.response : `[ai-hub 错误] ${r.error}` }, finish_reason: 'stop' }],
                    };
                    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
                    res.write('data: [DONE]\n\n');
                    return res.end();
                }

                const content = r.ok ? r.response : `[ai-hub 错误] ${r.error}`;
                return json(r.ok ? 200 : 502, {
                    id, object: 'chat.completion', created, model,
                    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
                    usage: { prompt_tokens: estTokens(prompt), completion_tokens: estTokens(content), total_tokens: estTokens(prompt) + estTokens(content) },
                });
            }

            // ── OpenAI 模型列表 ──
            if (req.method === 'GET' && url.pathname === '/v1/models') {
                const seen = new Set();
                const data = [];
                for (const p of PROVIDER_CHAIN) {
                    if (seen.has(p.key)) continue;
                    seen.add(p.key);
                    data.push({ id: p.key, object: 'model', created: 0, owned_by: p.name });
                }
                for (const m of COMMON_MODELS) {
                    const prov = resolveProvider(m) || 'auto';
                    data.push({ id: m, object: 'model', created: 0, owned_by: prov });
                }
                return json(200, { object: 'list', data });
            }

            if (req.method === 'POST' && url.pathname === '/v1/shutdown') {
                json(200, { ok: true, bye: true });
                setTimeout(() => { try { server.close(); } catch (_) {} process.exit(0); }, 100);
                return;
            }

            return json(404, { error: 'not found', hint: 'POST /v1/chat | /v1/chat/completions | /v1/parallel | /v1/pipeline | GET /v1/providers | /v1/models | /v1/health' });
        } catch (e) {
            return json(400, { ok: false, error: String(e.message || e) });
        }
    });

    server.listen(cfg.HUB_PORT, cfg.HUB_HOST, () => {
        log(`ai-hub HTTP daemon listening on http://${cfg.HUB_HOST}:${cfg.HUB_PORT}`);
        log(`CDP: ${cfg.CDP_HOST}:${cfg.CDP_PORT}`);
        log('自定义: POST /v1/chat | /v1/parallel | /v1/pipeline');
        log('OpenAI兼容: POST /v1/chat/completions | GET /v1/models');
    });
}

// 最小化受管调试 Chrome 窗口（Windows；仅操作 PID 文件记录的实例，不碰用户浏览器）
function minimizeManagedChrome() {
    const pidFile = path.join(os.tmpdir(), 'chrome-debug.chrome.pid');
    let pid = null;
    try { pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10); } catch (_) {}
    if (!pid || !Number.isFinite(pid) || pid <= 0) return 'no-pid-file';
    try {
        const ps = `
Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class WMin{[DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h,int c);}';
$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue;
if ($p -and $p.MainWindowHandle -ne 0) { [WMin]::ShowWindowAsync($p.MainWindowHandle, 6) | Out-Null; "minimized" } else { "no-window" }`;
        const out = execFileSync('powershell.exe',
            ['-NoProfile', '-NonInteractive', '-Command', ps],
            { timeout: 15_000, encoding: 'utf8', windowsHide: true });
        return String(out).trim() || 'ok';
    } catch (e) {
        return 'failed: ' + String(e.message || e).slice(0, 80);
    }
}

main().catch(e => { console.error('[ai-hub] FATAL:', e.message); process.exit(1); });
