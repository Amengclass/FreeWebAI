# Changelog

All notable changes to FreeWebAI.

## [0.1.0] - 2026-08-13

### Added
- Persistent warm daemon (`src/hub.js`) — single Chrome CDP connection + warm per-provider tabs, in-process dispatch through AgentChat's `providerFactory` (reuses `AgentChat/skills/lib` with zero modification to the original repo).
- Three frontends over one core: HTTP REST (`src/http.js`), CLI (`src/cli.js`), MCP server (`src/mcp.mjs`, tools `chat` / `parallel` / `pipeline` / `status`).
- OpenAI-compatible endpoints: `POST /v1/chat/completions` (incl. SSE `stream`) and `GET /v1/models`.
- Custom endpoints: `POST /v1/chat`, `POST /v1/parallel` (concurrent batch, accepts `tasks` or AgentChat-format `subtasks`), `POST /v1/pipeline` (search→reason→synthesize→review, or single modes), `GET /v1/providers`, `GET /v1/health`, `GET /v1/stats`, `POST /v1/shutdown`.
- Provider/vendor/model-name routing (`src/router.js`).
- Failure memory (per-provider cooldown) and self-healing CDP reconnect (auto-relaunch Chrome).

### Changed
- Aggressive response-completion detection: 3s stability window + 1s poll (vs adapters' 10s/2s) — safe because the universal stop-button guard resets the clock while generation is visibly in progress.
- Default fresh-conversation per call (`new_chat` omitted → true) for reliability; `--reuse` / `new_chat:false` stays opt-in.
- Docs: `README.md` is now the Chinese main document (English moved to `README_EN.md`); both READMEs now include a usage/risk disclaimer, trademark notice, and copyright takedown (contact-to-delete) statement.

### Fixed
- Gemini editor automation: the web UI update broke the upstream adapter's editor input; `src/hub.js` overrides Gemini's `input` (re-query + retry loop) so automated sends work again.
- `close()` no longer closes warm tabs (closing all of them exits Chrome).
- Daemon now survives Chrome restarts (auto-reconnect + relaunch).
- CLI no longer forces `new_chat:false` (which silently returned stale answers).
