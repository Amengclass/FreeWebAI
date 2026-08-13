/**
 * ai-hub router — accept provider keys / names / vendors / model names and
 * resolve them to a single provider key. Mirrors AgentChat's PROVIDER_CHAIN.
 */
'use strict';

const PROVIDER_KEYS = [
    'gemini', 'chatgpt', 'claude', 'qwen', 'kimi',
    'minimax', 'chatglm', 'doubao', 'mimo', 'deepseek',
];

const PROVIDER_NAMES = {
    gemini: 'Gemini',
    chatgpt: 'ChatGPT',
    claude: 'Claude',
    qwen: 'Qwen',
    kimi: 'Kimi',
    minimax: 'MiniMax',
    chatglm: 'ChatGLM',
    doubao: 'Doubao',
    mimo: 'MiMo',
    deepseek: 'DeepSeek',
};

// Vendor / Chinese-name aliases → provider key.
const ALIASES = {
    google: 'gemini', goog: 'gemini', '谷歌': 'gemini',
    openai: 'chatgpt', '奥特曼': 'chatgpt',
    anthropic: 'claude',
    aliyun: 'qwen', alibaba: 'qwen', tongyi: 'qwen', '通义': 'qwen',
    '千问': 'qwen', '通义千问': 'qwen',
    moonshot: 'kimi', '月之暗面': 'kimi',
    zhipu: 'chatglm', '智谱': 'chatglm', '智谱清言': 'chatglm',
    bytedance: 'doubao', '字节': 'doubao', '豆包': 'doubao',
    xiaomi: 'mimo', '小米': 'mimo', 'mi-mo': 'mimo',
    '深度求索': 'deepseek',
};

// Model-name prefixes → provider key. Ordered: more specific first.
const MODEL_PREFIXES = [
    ['nano-banana', 'gemini'],
    ['imagen', 'gemini'],
    ['gemini', 'gemini'],
    ['gpt', 'chatgpt'], ['o4', 'chatgpt'], ['o3', 'chatgpt'], ['o1', 'chatgpt'], ['dall', 'chatgpt'],
    ['claude', 'claude'],
    ['qwen', 'qwen'], ['tongyi', 'qwen'],
    ['moonshot', 'kimi'], ['kimi', 'kimi'], ['k2', 'kimi'],
    ['abab', 'minimax'], ['minimax', 'minimax'],
    ['chatglm', 'chatglm'], ['glm', 'chatglm'],
    ['doubao', 'doubao'], ['seed', 'doubao'],
    ['mimo', 'mimo'],
    ['deepseek', 'deepseek'],
];

/**
 * Resolve an arbitrary label (provider key/name/vendor/model) to a provider key.
 * @param {string} input
 * @returns {string|null} provider key, or null if unresolved
 */
function resolveProvider(input) {
    if (input === undefined || input === null) return null;
    const s = String(input).trim().toLowerCase();
    if (!s || s === 'auto' || s === 'best' || s === 'any') return null;

    // exact key / display name / vendor alias
    if (PROVIDER_KEYS.includes(s)) return s;
    if (ALIASES[s]) return ALIASES[s];
    for (const [k, n] of Object.entries(PROVIDER_NAMES)) {
        if (n.toLowerCase() === s) return k;
    }

    // model-name prefix
    for (const [prefix, key] of MODEL_PREFIXES) {
        if (s === prefix || s.startsWith(prefix + '-') || s.startsWith(prefix + ' ')) return key;
    }

    // unambiguous substring over keys (human convenience)
    const hits = PROVIDER_KEYS.filter(k => k.includes(s));
    if (hits.length === 1) return hits[0];

    return null;
}

/** Human-readable list of accepted labels, for error messages. */
function describe() {
    return PROVIDER_KEYS.join(', ') + ' (或 厂商名 / 模型名，如 openai、gpt-4o、deepseek-r1)';
}

module.exports = { PROVIDER_KEYS, PROVIDER_NAMES, resolveProvider, describe };
