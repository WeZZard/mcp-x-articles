# pi-x-articles

Publish a Markdown file as an [X Article](https://help.x.com/en/using-x/articles) through the **official** X API v2 Articles endpoints, driven by your coding agent.

- A deterministic script converts Markdown → `content_state` (no model-generated JSON, no offset mistakes).
- Images upload through the X media endpoints; fenced code and GFM tables ride X's native `markdown` entities.
- The agent creates a **draft**, stops, and publishes only after you say so.

The conversion is a Node script (`scripts/markdown-to-content-state.mjs`, one dependency: `marked`). The agent-facing workflow lives in `skills/x-articles/SKILL.md`.

## Prerequisites

1. **[XMCP](https://github.com/xdevplatform/xmcp)** — either auto-launched over stdio on Antigravity (`mcp_config.json`) or running locally over HTTP (`http://127.0.0.1:8000/mcp`) with the articles and media-upload tools enabled. The skill walks you through setup on first run if it is missing.
2. An [X Developer](https://console.x.com) app with credentials and credits — the X API is pay-per-use.
3. Node.js ≥ 18 (for the converter).

## Install

One repo serves five agents: the shared `skills/x-articles/SKILL.md` plus a thin manifest per platform.

**Antigravity:** clone this repo, install dependencies, and symlink it into `~/.gemini/config/plugins/`:

```sh
git clone https://github.com/WeZZard/pi-x-articles
cd pi-x-articles && npm install
ln -s "$PWD" ~/.gemini/config/plugins/x-articles
```

Then open `customization://x-articles` in Antigravity, fill in `X_OAUTH_CONSUMER_KEY`, `X_OAUTH_CONSUMER_SECRET`, and `X_BEARER_TOKEN` (with `http://127.0.0.1:8976/oauth/callback` registered on your X Developer App), and toggle the plugin on.

**pi:**

```sh
pi install git:github.com/WeZZard/pi-x-articles
```

**Claude Code:** install the repo as a plugin (it carries `.claude-plugin/plugin.json`), e.g. add this repo as a marketplace and `/plugin install x-articles`, or clone it and point Claude Code at the directory.

**Codex:** install the repo as a plugin (it carries `.codex-plugin/plugin.json`).

**OpenCode:** clone this repo and symlink the skill into your skills directory, then install the converter's dependency:

```sh
git clone https://github.com/WeZZard/pi-x-articles
cd pi-x-articles && npm install
ln -s "$PWD/skills/x-articles" ~/.config/opencode/skills/x-articles
```

Whichever agent you use, keep `skills/` and `scripts/` side by side — the skill resolves the converter relative to the package root. Symlink, don't copy.

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
