# pi-x-articles

Publish a Markdown file as an [X Article](https://help.x.com/en/using-x/articles) through the **official** X API v2 Articles endpoints, driven by your coding agent.

- A deterministic script converts Markdown → `content_state` (no model-generated JSON, no offset mistakes).
- Images upload through the X media endpoints; fenced code and GFM tables ride X's native `markdown` entities.
- The agent creates a **draft**, stops, and publishes only after you say so.

The conversion is a Node script (`scripts/markdown-to-content-state.mjs`, one dependency: `marked`). The agent-facing workflow lives in `skills/x-articles/SKILL.md`.

## Prerequisites

1. **[XMCP](https://github.com/xdevplatform/xmcp)** running locally (default `http://127.0.0.1:8000/mcp`) with the articles and media-upload tools enabled. The skill walks you through setup on first run if it is missing.
2. An [X Developer](https://console.x.com) app with credentials and credits — the X API is pay-per-use.
3. Node.js ≥ 18 (for the converter).

## Install

**pi:**

```sh
pi install git:github.com/WeZZard/pi-x-articles
```

**Claude Code / Codex / OpenCode:** clone this repo and make the skill visible to your agent — e.g. symlink or copy `skills/x-articles` into the agent's skills directory (`~/.claude/skills/`, `~/.codex/skills/`, or the equivalent), then run `npm install` in the repo root so the converter's dependency is available.

## Use

Ask your agent:

> 用 x-articles 把 path/to/post.md 发布为 X Article。

The agent converts the file, reports any degradations (dropped HTML, flattened nested lists), uploads images, creates a draft, prints the draft's editor URL, and waits. Say "发布" and it publishes.

## Develop

```sh
npm install
npm test   # fixture assertions + validation against the live OpenAPI schema
```

## License

MIT
