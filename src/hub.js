/**
 * ai-hub core — the warm daemon.
 *
 * Holds ONE long-lived Chrome CDP connection + per-provider warm tabs, and
 * dispatches each chat request IN-PROCESS through AgentChat's providerFactory
 * (no per-call `node index.js` spawn, no CDP reconnect, no provider re-discovery).
 *
 * Reuses AgentChat's shared lib untouched:
 *   - providerFactory.createProviderRunner(cfg)  → (page, prompt, timeoutMs, ctx, opts)
 *   - providers/chain.js  PROVIDER_CHAIN
 *   - providers/adapters/<key>.js  adapter configs
 *   - cdp.js  connectWithRetry / ensureChromeCdp / CDP_URL
 *   - locks.js  acquireLock / releaseLock / acquireBrowserSlot (cross-process mutex)
 *
 * Two optimizations the original CLI doesn't have:
 *   1. WARM REUSE — the page is never reloaded between calls (a Proxy skips
 *      `page.goto` when the tab is already on the provider's site). The chat
 *      continues in-place; response extraction already guards against stale
 *      answers via baselineCounts + prompt-echo.
 *   2. FAILURE MEMORY — providers that just failed get a cooldown; the "auto"
 *      chain skips them instead of re-paying the failure (e.g. Gemini's
 *      model-selector hunt, ~40s, is skipped after one miss).
 *   3. GEMINI FAST — the adapter's preInputHook is replaced with a no-op when
 *      fast mode is on, so Pro Extended / Flash activation (the 40s selector
 *      hunt) is skipped entirely and the page's default model is used.
 */
'use strict';
const path = require('path');

const cfg = require('./config');
const { PROVIDER_KEYS, PROVIDER_NAMES, resolveProvider } = require('./router');

let chromium;
try {
    ({ chromium } = require('playwright-core'));
} catch (e) {
    console.error('[ai-hub] playwright-core not installed — run `npm install` in ai-hub/');
    process.exit(1);
}

// ── AgentChat shared lib (reused, never modified) ──────────────────────────
const { createProviderRunner } = require(path.join(cfg.LIB, 'providerFactory'));
const { PROVIDER_CHAIN } = require(path.join(cfg.LIB, 'providers', 'chain'));
const { connectWithRetry, ensureChromeCdp, CDP_URL } = require(path.join(cfg.LIB, 'cdp'));
const { acquireLock, releaseLock, acquireBrowserSlot, releaseBrowserSlot } = require(path.join(cfg.LIB, 'locks'));
// Reuse the original repo's response cleaning (strips "Claude responded:" /
// "Gemini 说了:" / "Thought for Ns" UI chrome that the web pages inject).
const { cleanResponse } = require(path.join(cfg.LIB, 'execute'));

const log = (...a) => console.error('[ai-hub]', ...a);

// ── Runner factory — cached per provider, two variants for gemini ──────────
function buildRunner(key, fast) {
    const adapter = require(path.join(cfg.LIB, 'providers', 'adapters', key));
    // Aggressive completion detection — see config.js STABILITY_WINDOW_MS /
    // POLL_INTERVAL_MS. Safe because the stop-button guard resets the clock
    // while generation is visibly in progress.
    const tuned = { ...adapter, stabilityWindow: cfg.STABILITY_WINDOW_MS, pollInterval: cfg.POLL_INTERVAL_MS };
    if (key === 'gemini') {
        if (fast) tuned.preInputHook = null; // skip model-activation hunt
        // Gemini's Quill/Angular editor invalidates the runner's editor locator
        // between clear and verify, so its strict input() returns false. Re-query
        // the composer fresh, click to focus, type, lenient verify.
        tuned.input = async (page, editor, prompt) => {
            // Retry loop: the SPA can still be settling after goto in a long-lived
            // process, and insertText then silently goes nowhere. Click, clear,
            // type, verify; retry a few times with a short settle.
            for (let attempt = 0; attempt < 3; attempt++) {
                try {
                    const ed = page.getByRole('textbox').first();
                    await ed.click({ timeout: 3000 });
                    await page.keyboard.press('ControlOrMeta+a');
                    await page.keyboard.press('Backspace');
                    await page.waitForTimeout(150);
                    await page.keyboard.insertText(prompt);
                    await page.waitForTimeout(300);
                    try {
                        await ed.evaluate(node => node.dispatchEvent(
                            new Event('input', { bubbles: true, composed: true })));
                    } catch (_) {}
                    const len = await ed.evaluate(el =>
                        (el.innerText || el.textContent || '').length).catch(() => 0);
                    if (cfg.DEBUG) log(`[gemini-fix] input landed ${len}/${prompt.length} (attempt ${attempt + 1})`);
                    if (len > 0) return true;
                } catch (e) {
                    if (cfg.DEBUG) log(`[gemini-fix] attempt ${attempt + 1} threw: ${e.message}`);
                }
                await page.waitForTimeout(800);
            }
            return false;
        };
    }
    return createProviderRunner(tuned);
}
const RUNNERS = Object.fromEntries(
    PROVIDER_KEYS.map(k => [k, { fast: buildRunner(k, true), full: buildRunner(k, false) }])
);

// ── Tab discovery (copy of AgentChat-OneWeb's findProviderPage logic) ──────
function providerHosts(provider) {
    if (provider.tabHosts) return provider.tabHosts;
    try { return [new URL(provider.url).hostname]; } catch { return []; }
}

function findProviderPage(context, provider) {
    const hosts = providerHosts(provider);
    return context.pages().find(p => {
        try {
            const u = p.url();
            if (!u || u.startsWith('about:')) return false;
            const h = new URL(u).hostname;
            return hosts.some(hh => h === hh || h.endsWith('.' + hh));
        } catch { return false; }
    }) || null;
}

function clampInt(v, def, max, min = 10_000) {
    const n = parseInt(v, 10);
    if (!Number.isFinite(n)) return def;
    return Math.max(min, Math.min(max, n));
}

class AIHub {
    constructor(options = {}) {
        this.options = options;
        this.browser = null;
        this.context = null;
        this.warmPages = new Map();   // providerKey -> Page
        this.owns = new Map();        // providerKey -> true if WE created the page (vs a user tab)
        this.cooldowns = new Map();   // providerKey -> { until, reason }
        this.queues = new Map();      // providerKey -> promise tail (in-process serialization)
        this.stats = { calls: 0, ok: 0, fail: 0, byProvider: {} };
        this.startTime = Date.now();
    }

    // ── lifecycle ──────────────────────────────────────────────────────────
    async connect() {
        const ensured = await ensureChromeCdp(CDP_URL, log);
        if (!ensured.up) {
            throw new Error(`Chrome CDP not reachable on ${CDP_URL} — start the debug Chrome first (start-chrome.ps1)`);
        }
        if (ensured.autostarted) log(`Chrome CDP auto-started (${ensured.method})`);
        this.browser = await connectWithRetry(chromium, CDP_URL, 3, log);
        this.browser.on('disconnected', () => log('CRITICAL: CDP connection dropped'));
        this.context = this.browser.contexts()[0];
        if (!this.context) throw new Error('No browser context on CDP endpoint');
        await this.discoverPages();
        const warm = [...this.warmPages.keys()].length;
        log(`connected to Chrome CDP ${CDP_URL} — ${warm}/${PROVIDER_KEYS.length} provider tabs warm`);
        return this;
    }

    async discoverPages() {
        for (const p of PROVIDER_CHAIN) {
            const page = findProviderPage(this.context, p);
            if (page) this.warmPages.set(p.key, page);
        }
    }

    /**
     * Self-heal: if the CDP link dropped (Chrome restarted/crashed/closed), auto
     * relaunch Chrome and reconnect. Long-lived daemons must not serve dead
     * connections (observed: every newPage() threw "Target closed" until restart).
     * @returns {Promise<boolean>}
     */
    async ensureConnected() {
        if (this.browser && this.browser.isConnected() && this.context) return true;
        log('CDP connection lost — relaunching Chrome & reconnecting...');
        try {
            const ensured = await ensureChromeCdp(CDP_URL, log);
            if (!ensured.up) throw new Error(`Chrome CDP not reachable on ${CDP_URL}`);
            this.browser = await connectWithRetry(chromium, CDP_URL, 3, log);
            this.browser.on('disconnected', () => log('CRITICAL: CDP connection dropped'));
            this.context = this.browser.contexts()[0];
            if (!this.context) throw new Error('No browser context on CDP endpoint');
            this.warmPages.clear(); // all old pages died with the old connection
            this.owns.clear();
            this.cooldowns.clear(); // failure state from the dead session is meaningless
            await this.discoverPages();
            log(`reconnected — ${this.warmPages.size}/${PROVIDER_KEYS.length} provider tabs warm`);
            return true;
        } catch (e) {
            log(`reconnect failed: ${e.message}`);
            return false;
        }
    }

    async close() {
        // GUEST POLICY: we are a CDP guest in the user's Chrome — never close
        // their tabs or browser. Closing every warm page here empties the last
        // window and Chrome exits (observed). Just drop our reference; the tabs
        // and Chrome stay alive. (Process exit then drops the ws connection.)
        this.warmPages.clear();
    }

    // ── page pool ──────────────────────────────────────────────────────────
    async getPage(key) {
        const page = this.warmPages.get(key);
        if (page && !page.isClosed()) return page;
        const prov = PROVIDER_CHAIN.find(p => p.key === key);
        if (prov) {
            const found = findProviderPage(this.context, prov);
            if (found) { this.warmPages.set(key, found); return found; } // user's tab — we don't own it
        }
        const fresh = await this.context.newPage(); // newPage() is async — must await
        this.warmPages.set(key, fresh);
        this.owns.set(key, true);
        return fresh;
    }

    // Drop a provider's warm tab after a failed attempt — a stuck page can poison
    // every later call (observed with Gemini). Only closes tabs WE created; a
    // user's own tab is left alone (guest policy).
    async refreshWarmPage(key) {
        if (!this.owns.get(key)) return;
        const page = this.warmPages.get(key);
        if (page && !page.isClosed()) {
            try { await page.close(); } catch (_) {}
        }
        this.warmPages.delete(key);
        this.owns.delete(key);
    }

    /**
     * Warm-reuse wrapper: intercepts `page.goto` and no-ops it when the tab is
     * already on the provider's site (same hostname). Everything else delegates
     * to the real page. `new_chat` requests skip this wrapper (real reload).
     */
    warmWrap(page, key) {
        const prov = PROVIDER_CHAIN.find(p => p.key === key);
        const hosts = providerHosts(prov);
        const sameSite = (url) => {
            try {
                const h = new URL(url).hostname;
                return hosts.some(hh => h === hh || h.endsWith('.' + hh));
            } catch { return false; }
        };
        return new Proxy(page, {
            get(t, prop) {
                if (prop === 'goto') {
                    return (url, opts) => {
                        if (!t.isClosed() && sameSite(t.url()) && sameSite(url)) {
                            if (cfg.DEBUG) log(`[warm] ${key} skip goto — reusing tab ${t.url().slice(0, 70)}`);
                            return Promise.resolve(); // warm reuse — skip reload
                        }
                        if (cfg.DEBUG) log(`[warm] ${key} real goto ${String(url).slice(0, 70)} (page=${t.url().slice(0, 40)})`);
                        return t.goto(url, opts);
                    };
                }
                const v = t[prop];
                return typeof v === 'function' ? v.bind(t) : v;
            },
        });
    }

    async runProvider(key, { prompt, images, new_chat, timeoutMs, geminiFast }) {
        const page = await this.getPage(key);
        const wrapped = new_chat ? page : this.warmWrap(page, key);
        const useFast = key === 'gemini'
            ? (geminiFast !== undefined ? !!geminiFast : cfg.GEMINI_FAST)
            : false;
        const runner = RUNNERS[key][useFast ? 'fast' : 'full'];
        const ctx = { telemetry: { per_provider_ms: {} } }; // runner guards ctx.telemetry
        return runner(wrapped, prompt, timeoutMs, ctx, { images: images || [] });
    }

    // ── serialization: in-process queue + file lock + browser slot ─────────
    withProviderQueue(key, fn) {
        const tail = this.queues.get(key) || Promise.resolve();
        const run = tail.then(fn, fn); // proceed even if the previous attempt failed
        this.queues.set(key, run.catch(() => {}));
        return run;
    }

    async withBrowserSlot(fn) {
        const slot = await acquireBrowserSlot({
            max: cfg.MAX_CONCURRENT_PAGES,
            waitMs: 30_000,
            log,
        });
        try {
            return await fn();
        } finally {
            if (slot !== null && slot !== undefined) releaseBrowserSlot(slot);
        }
    }

    // Cross-process mutex on the SAME provider (interops with OneWeb / IndependentTasks).
    // Degrades to unlocked after the wait — admission control must never deadlock.
    async withProviderLock(key, fn, waitMs = 45_000) {
        const deadline = Date.now() + waitMs;
        for (;;) {
            if (acquireLock(key)) {
                try { return await fn(); }
                finally { releaseLock(key); }
            }
            if (Date.now() >= deadline) return fn();
            await new Promise(r => setTimeout(r, 350));
        }
    }

    // ── failure memory ─────────────────────────────────────────────────────
    markFailure(key, reason) {
        const isQuota = /quota|rate/i.test(String(reason || ''));
        const ms = isQuota ? cfg.COOLDOWN_QUOTA_MS : cfg.COOLDOWN_TRANSIENT_MS;
        this.cooldowns.set(key, { until: Date.now() + ms, reason });
        this.stats.fail++;
        const p = this.stats.byProvider[key] || (this.stats.byProvider[key] = {});
        p.fail = (p.fail || 0) + 1;
        p.last_error = reason;
    }

    markSuccess(key) {
        this.cooldowns.delete(key);
        this.stats.ok++;
        const p = this.stats.byProvider[key] || (this.stats.byProvider[key] = {});
        p.ok = (p.ok || 0) + 1;
        p.last_error = null;
    }

    availableOrder(startKey) {
        const now = Date.now();
        let order = PROVIDER_KEYS;
        if (startKey) {
            const idx = PROVIDER_KEYS.indexOf(startKey);
            order = PROVIDER_KEYS.slice(idx).concat(PROVIDER_KEYS.slice(0, idx));
        }
        // Skip cooled-down providers, EXCEPT the explicitly requested startKey.
        return order.filter(k =>
            k === startKey || !(this.cooldowns.get(k) && this.cooldowns.get(k).until > now)
        );
    }

    // ── main entry: dispatch ───────────────────────────────────────────────
    /**
     * @param {object} req
     * @param {string} req.prompt
     * @param {string} [req.provider]  provider key/name/vendor/model, or 'auto'
     * @param {string} [req.model]     model name to route (if provider omitted)
     * @param {Array}  [req.images]    [{base64, mimeType, fileName}]
     * @param {boolean} [req.new_chat] force fresh conversation (default false)
     * @param {number} [req.timeout_ms] total budget
     * @param {boolean} [req.gemini_fast]
     */
    async chat(req) {
        const { provider, model, prompt, images, new_chat, timeout_ms, gemini_fast } = req || {};
        const text = String(prompt || '').trim();
        if (!text) return { ok: false, error: 'empty prompt' };

        // Self-heal CDP link first — a long-lived daemon must survive Chrome restarts.
        if (!(await this.ensureConnected())) {
            return { ok: false, error: 'Chrome CDP unreachable after reconnect attempt', tried: [], time_ms: 0 };
        }

        // RELIABILITY FIRST: default to a FRESH conversation per call (the
        // original pipeline's tested behavior — goto reloads to a new chat).
        // Warm-tab skip-nav reuse (new_chat:false) is faster but can return a
        // STALE previous answer when the fresh assistant node mounts slowly, so
        // it stays an explicit opt-in.
        const freshChat = new_chat === undefined ? true : !!new_chat;

        const total = clampInt(timeout_ms, cfg.DEFAULT_TOTAL_TIMEOUT_MS, 600_000);
        const startKey = resolveProvider(provider) || (model ? resolveProvider(model) : null);
        const order = this.availableOrder(startKey);
        const tried = [];
        const t0 = Date.now();
        this.stats.calls++;

        for (const key of order) {
            const remaining = total - (Date.now() - t0);
            if (remaining < 15_000) {
                tried.push({ provider: key, reason: 'total_timeout' });
                break;
            }
            const perProv = Math.min(cfg.DEFAULT_PROVIDER_TIMEOUT_MS, remaining);

            const attempt = () => this.withProviderQueue(key, () =>
                this.withBrowserSlot(() =>
                    this.withProviderLock(key, () =>
                        this.runProvider(key, {
                            prompt: text,
                            images,
                            new_chat: freshChat,
                            timeoutMs: perProv,
                            geminiFast: gemini_fast,
                        })
                    )
                )
            );

            let result;
            try {
                result = await attempt();
            } catch (e) {
                tried.push({
                    provider: key, reason: 'error',
                    message: String(e.message || e).slice(0, 160),
                });
                this.markFailure(key, 'error');
                await this.refreshWarmPage(key); // stuck tab → fresh one next time
                continue;
            }

            tried.push({
                provider: key,
                reason: result.reason || 'ok',
                ...(result.error_details
                    ? {
                        stage: result.error_details.stage,
                        message: String(result.error_details.message || '').slice(0, 160),
                    }
                    : {}),
            });
            if (result.success) {
                this.markSuccess(key);
                return {
                    ok: true,
                    provider: key,
                    provider_name: PROVIDER_NAMES[key],
                    response: cleanResponse(result.response, key),
                    tried,
                    time_ms: Date.now() - t0,
                    new_chat: freshChat,
                };
            }
            this.markFailure(key, result.reason || 'error');
            await this.refreshWarmPage(key); // stuck tab → fresh one next time
        }

        return {
            ok: false,
            error: 'all providers failed',
            tried,
            time_ms: Date.now() - t0,
        };
    }

    // ── parallel batch (mirrors AgentChat-IndependentTasks core) ───────────
    /**
     * Run independent tasks concurrently across providers.
     * @param {Array} tasks  [{id?, provider?, model?, prompt, images?}]
     * @param {object} [o]  {timeout_ms, max_concurrent}
     */
    async parallel(tasks, o = {}) {
        const list = (tasks || []).filter(t => t && String(t.prompt || '').trim());
        if (list.length === 0) return { ok: false, error: 'no tasks', total: 0, completed: 0, failed: 0, results: [] };
        const t0 = Date.now();
        const total = clampInt(o.timeout_ms, 300_000, 900_000);
        const cap = Math.max(1, Math.min(parseInt(o.max_concurrent, 10) || 6, 16));
        const results = new Array(list.length).fill(null);
        let next = 0;
        const worker = async () => {
            for (;;) {
                const i = next++;
                if (i >= list.length) return;
                const t = list[i];
                try {
                    const r = await this.chat({
                        provider: t.provider, model: t.model, prompt: t.prompt,
                        images: t.images, timeout_ms: total,
                    });
                    results[i] = {
                        id: t.id || `task_${i + 1}`,
                        ok: !!r.ok,
                        provider: r.provider || null,
                        response: r.ok ? r.response : null,
                        error: r.ok ? null : r.error,
                        tried: r.tried || [],
                        time_ms: r.time_ms,
                    };
                } catch (e) {
                    results[i] = {
                        id: t.id || `task_${i + 1}`, ok: false, provider: null,
                        response: null, error: String(e.message || e).slice(0, 160),
                        time_ms: Date.now() - t0,
                    };
                }
            }
        };
        const n = Math.min(cap, list.length);
        await Promise.all(Array.from({ length: n }, () => worker()));
        const okCount = results.filter(r => r && r.ok).length;
        return {
            success: okCount > 0,
            total: list.length,
            completed: okCount,
            failed: list.length - okCount,
            total_ms: Date.now() - t0,
            results: results.filter(Boolean),
        };
    }

    // ── sequential pipeline (mirrors AgentChat-WebSubAgent) ────────────────
    /**
     * Chain of steps; each step's prompt can reference prior outputs via
     * {{stepName}}. Every step falls back across providers automatically.
     * @param {object} req {prompt, mode: 'full'|'search'|'reason'|'review', steps?, timeout_ms}
     */
    async pipeline(req = {}) {
        const { prompt, timeout_ms } = req || {};
        const text = String(prompt || '').trim();
        if (!text) return { ok: false, error: 'empty prompt' };
        const mode = req.mode || 'full';
        const total = clampInt(timeout_ms, 300_000, 900_000);
        const perStep = Math.floor(total / 5);

        let steps;
        if (Array.isArray(req.steps) && req.steps.length > 0) {
            steps = req.steps.map(s => ({ name: s.name || `step_${s.provider}`, primary: s.provider, template: s.template }));
        } else if (mode === 'search') {
            steps = [{ name: 'search', primary: 'kimi', template: `请进行联网搜索，用要点列出关键事实和数据，不要运行代码。\n\n搜索内容：${text}` }];
        } else if (mode === 'reason') {
            steps = [{ name: 'reason', primary: 'gemini', template: `请从理论/机制层面严谨推理并得出结论。\n\n问题：${text}` }];
        } else if (mode === 'review') {
            steps = [{ name: 'review', primary: 'chatgpt', template: `请逐一审查以下内容，列出所有问题点并给出具体修改建议，不要重写整个方案。\n\n${text}` }];
        } else {
            steps = [
                { name: 'search', primary: 'kimi', template: `请进行联网搜索，用要点列出关键事实和数据，不要运行代码。\n\n搜索内容：${text}` },
                { name: 'reason', primary: 'gemini', template: `请基于以下资料进行严谨的深度推理并得出结论。\n\n原始问题：${text}\n\n搜索资料：\n{{search}}` },
                { name: 'synthesize', primary: 'claude', template: `请综合以下素材，撰写一份结构清晰、可直接交付的最终回答。\n\n原始问题：${text}\n\n搜索资料：\n{{search}}\n\n推理结论：\n{{reason}}` },
                { name: 'review', primary: 'chatgpt', template: `请审查以下最终回答，列出问题点并给出修改建议。\n\n{{synthesize}}` },
            ];
        }

        const outputs = {};
        const stepsResult = [];
        const t0 = Date.now();
        for (const s of steps) {
            let p = s.template;
            for (const [k, v] of Object.entries(outputs)) {
                p = p.split(`{{${k}}}`).join(v || '（该步骤未产出内容）');
            }
            const r = await this.chat({ provider: s.primary, prompt: p, timeout_ms: perStep });
            outputs[s.name] = r.ok ? r.response : null;
            stepsResult.push({
                step: s.name,
                provider: r.provider || null,
                ok: !!r.ok,
                response: r.ok ? r.response : (r.error || 'failed'),
                time_ms: r.time_ms,
                error: r.ok ? null : r.error,
            });
        }

        return {
            ok: stepsResult.some(s => s.ok),
            mode,
            final: outputs.review || outputs.synthesize || outputs.reason || outputs.search || null,
            steps: stepsResult,
            total_ms: Date.now() - t0,
        };
    }

    // ── status ─────────────────────────────────────────────────────────────
    async providers() {
        const now = Date.now();
        return PROVIDER_KEYS.map(key => {
            const prov = PROVIDER_CHAIN.find(p => p.key === key);
            const cd = this.cooldowns.get(key);
            const page = this.warmPages.get(key);
            return {
                key,
                name: prov.name,
                url: prov.url,
                warm: !!(page && !page.isClosed()),
                cooldown: cd && cd.until > now
                    ? { reason: cd.reason, seconds_left: Math.ceil((cd.until - now) / 1000) }
                    : null,
            };
        });
    }

    health() {
        return {
            cdp: !!(this.browser && this.browser.isConnected()),
            uptime_ms: Date.now() - this.startTime,
            calls: this.stats.calls,
            ok: this.stats.ok,
            fail: this.stats.fail,
        };
    }
}

module.exports = { AIHub, PROVIDER_KEYS, PROVIDER_CHAIN };
