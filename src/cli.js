#!/usr/bin/env node
/**
 * ai-hub CLI — one-shot chat against the running daemon (fast, since the daemon
 * is warm). Talks HTTP to src/http.js on HUB_HOST:HUB_PORT.
 *
 *   node src/cli.js "帮我写个爬虫"
 *   node src/cli.js --provider=deepseek "解释一下 R1 的思维链"
 *   node src/cli.js --provider=openai --model=gpt-4o "翻译这段"
 *   node src/cli.js --new-chat "重新开一个会话问"
 *   node src/cli.js --stop        # 停掉 daemon
 */
'use strict';
const http = require('http');
const cfg = require('./config');

function request(pathname, body, method = 'POST') {
    return new Promise((resolve, reject) => {
        const data = body ? Buffer.from(JSON.stringify(body)) : null;
        const req = http.request({
            host: cfg.HUB_HOST,
            port: cfg.HUB_PORT,
            path: pathname,
            method,
            headers: data ? {
                'Content-Type': 'application/json',
                'Content-Length': data.length,
            } : {},
        }, (res) => {
            let s = '';
            res.on('data', c => s += c);
            res.on('end', () => {
                try { resolve(JSON.parse(s)); }
                catch (e) { reject(new Error(`bad response: ${s.slice(0, 200)}`)); }
            });
        });
        req.on('error', () => reject(new Error(
            `daemon not reachable on ${cfg.HUB_HOST}:${cfg.HUB_PORT} — start it with: npm start`
        )));
        if (data) req.write(data);
        req.end();
    });
}

async function main() {
    const args = process.argv.slice(2);
    let provider = null, model = null, newChat = false, reuse = false, timeout = null, stop = false;
    const rest = [];
    for (const a of args) {
        if (a === '--stop') stop = true;
        else if (a === '--new-chat') newChat = true;
        else if (a === '--reuse') reuse = true; // 显式复用热 tab（更快，但实验性）
        else if (a.startsWith('--provider=')) provider = a.split('=')[1];
        else if (a.startsWith('--model=')) model = a.split('=')[1];
        else if (a.startsWith('--timeout=')) timeout = parseInt(a.split('=')[1], 10);
        else if (a.startsWith('--')) { console.error(`unknown flag: ${a}`); process.exit(64); }
        else rest.push(a);
    }
    if (stop) {
        const r = await request('/v1/shutdown', {}).catch(e => { console.error(e.message); process.exit(1); });
        console.log('daemon stopped:', JSON.stringify(r));
        process.exit(0);
    }
    const prompt = rest.join(' ');
    if (!prompt) {
        console.error('Usage: node src/cli.js [--provider=NAME|auto] [--model=MODEL] [--new-chat] [--reuse] [--timeout=MS] "prompt"');
        console.error('  或:  node src/cli.js --stop');
        process.exit(64);
    }
    // IMPORTANT: omit `new_chat` unless explicitly requested — the daemon defaults
    // to FRESH conversation (reliable) when the field is absent. Sending
    // `new_chat:false` unconditionally (the old CLI default) made every call
    // reuse the warm tab and silently return the PREVIOUS answer.
    const body = { provider, model, prompt, timeout_ms: timeout };
    if (newChat) body.new_chat = true;
    if (reuse) body.new_chat = false;
    const r = await request('/v1/chat', body);
    if (r.ok) {
        console.log(r.response);
        if (!process.stdout.isTTY) {
            console.error(JSON.stringify({ provider: r.provider_name, time_ms: r.time_ms }));
        }
        process.exit(0);
    }
    console.error(`[ai-hub] 失败: ${r.error}`);
    console.error('tried:', JSON.stringify(r.tried || []));
    process.exit(1);
}

main().catch(e => { console.error(e.message); process.exit(1); });
