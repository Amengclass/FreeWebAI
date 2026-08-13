/**
 * ai-hub config — resolve AgentChat lib path, load .env, constants.
 *
 * Must be required BEFORE lib/cdp.js so CDP_HOST/CDP_PORT land in process.env
 * before that module computes CDP_URL at require time.
 */
'use strict';
const path = require('path');
const fs = require('fs');

// Load our own .env into process.env (existing env wins — mirrors lib/cdp.js).
function loadEnv(file) {
    try {
        const text = fs.readFileSync(file, 'utf8');
        for (const raw of text.split(/\r?\n/)) {
            const line = raw.trim();
            if (!line || line.startsWith('#')) continue;
            const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
            if (!m) continue;
            let val = m[2].trim();
            if ((val.startsWith('"') && val.endsWith('"')) ||
                (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
            if (!(m[1] in process.env)) process.env[m[1]] = val;
        }
    } catch (_) {}
}
loadEnv(path.join(__dirname, '..', '.env'));

/** Locate AgentChat's skills/lib — AGENTCHAT_LIB_PATH env wins, else sibling. */
function resolveAgentChatLib() {
    const envPath = process.env.AGENTCHAT_LIB_PATH;
    if (envPath && fs.existsSync(path.join(envPath, 'providerFactory.js'))) return envPath;
    const candidates = [
        // sibling layout: <something>/AI牛马/ai-hub  +  ../AgentChat/skills/lib
        path.join(__dirname, '..', '..', 'AgentChat', 'skills', 'lib'),
        path.resolve(process.env.AGENTCHAT_REPO_DIR || '', 'skills', 'lib'),
    ];
    for (const c of candidates) {
        try { if (fs.existsSync(path.join(c, 'providerFactory.js'))) return c; } catch (_) {}
    }
    return null;
}

const LIB = resolveAgentChatLib();
if (!LIB) {
    console.error(
        '[ai-hub] Cannot find AgentChat skills/lib.\n' +
        '[ai-hub]   Place ai-hub next to the AgentChat repo, or set AGENTCHAT_LIB_PATH=' +
        'C:\\path\\to\\AgentChat\\skills\\lib'
    );
    process.exit(1);
}

const boolEnv = (name, def) => {
    const v = String(process.env[name] ?? '');
    if (v === '') return def;
    return !/^(0|false|no|off)$/i.test(v);
};
const intEnv = (name, def) => {
    const n = parseInt(process.env[name], 10);
    return Number.isFinite(n) && n > 0 ? n : def;
};

module.exports = {
    LIB,
    CDP_HOST: process.env.CDP_HOST || '127.0.0.1',
    CDP_PORT: process.env.CDP_PORT || '9222',
    HUB_HOST: process.env.HUB_HOST || '127.0.0.1',
    HUB_PORT: intEnv('HUB_PORT', 8787),
    DEFAULT_TOTAL_TIMEOUT_MS: intEnv('HUB_TIMEOUT_MS', 120_000),
    DEFAULT_PROVIDER_TIMEOUT_MS: intEnv('HUB_PROVIDER_TIMEOUT_MS', 60_000),
    MAX_CONCURRENT_PAGES: intEnv('AGENTCHAT_MAX_CONCURRENT_PAGES', 3),
    COOLDOWN_TRANSIENT_MS: intEnv('HUB_COOLDOWN_TRANSIENT_MS', 90_000),
    COOLDOWN_QUOTA_MS: intEnv('HUB_COOLDOWN_QUOTA_MS', 300_000),
    GEMINI_FAST: boolEnv('HUB_GEMINI_FAST', true),
    // Chrome 显示模式（仅影响 daemon 自动拉起 Chrome 时；已运行的 Chrome 不受影响）
    HUB_HEADLESS: boolEnv('HUB_HEADLESS', false),  // true = 无头（真·不显示，但更容易触发风控）
    HUB_MINIMIZE: boolEnv('HUB_MINIMIZE', false),  // true = 显示但自动最小化窗口（推荐，安全）
    // Completion detection — the BIGGEST per-call cost after generation itself.
    // Insight: the universal stop-button guard (visible while generating → resets
    // the stability clock) means the window only fires AFTER generation finished,
    // so it can be aggressive without truncating answers. 3s quiescence + 1s
    // poll trims ~6-8s vs the adapters' conservative 10s/2s defaults.
    STABILITY_WINDOW_MS: intEnv('HUB_STABILITY_WINDOW_MS', 3_000),
    POLL_INTERVAL_MS: intEnv('HUB_POLL_INTERVAL_MS', 1_000),
    DEBUG: boolEnv('HUB_DEBUG', false),
};
