---
name: x-articles
description: Publish a Markdown file as an X Article (long-form) through XMCP and the official X API v2 Articles endpoints. Converts Markdown to content_state with a deterministic script, uploads images, creates a draft, waits for explicit human approval, then publishes. Use when the user asks to post/publish a Markdown document, blog post, or article to X (Twitter) Articles.
---

# x-articles

Publish a Markdown file as an X Article. Conversion is deterministic (a script, not model-generated JSON); the X API calls go through XMCP tools.

## Prerequisites

- **XMCP** running and reachable (default `http://127.0.0.1:8000/mcp`) with these tools available: `articleCreateDraft`, `articlePublish`, `initializeMediaUpload`, `appendMediaUpload`, `finalizeMediaUpload`, `getMediaUploadStatus`.
- An X Developer app with credits (the X API is pay-per-use; a depleted balance returns `402 Payment Required`).

If XMCP is not running or the articles tools are missing, run the setup procedure below **before** anything else. If it is running, skip setup.

### Setup procedure (first run only)

1. Clone https://github.com/xdevplatform/xmcp and install dependencies per its README (Python 3.9+, virtual environment). Choose commands for the user's OS — do not assume Unix.
2. Create its `.env` from `env.example`. Leave `X_OAUTH_CONSUMER_KEY`, `X_OAUTH_CONSUMER_SECRET`, `X_BEARER_TOKEN` blank and **stop**: the user fills these from https://console.x.com.
3. Set `X_API_TOOL_ALLOWLIST=articleCreateDraft,articlePublish,initializeMediaUpload,appendMediaUpload,finalizeMediaUpload,getMediaUploadStatus` in `.env`.
4. Tell the user to register the callback URL `http://127.0.0.1:8976/oauth/callback` in their Developer App settings and **wait** for confirmation.
5. Start `python server.py`. First start opens a browser for OAuth consent — tell the user to complete it.
6. Verify the MCP endpoint responds. Do not make any X API call before credentials are in place.

## Publish workflow

Resolve `<pkg>` as the directory containing this skill's package (the `scripts/` directory sits beside `skills/`).

1. **Convert.** Run:
   ```sh
   node <pkg>/scripts/markdown-to-content-state.mjs <file.md> --out draft.json
   ```
   Read `draft.json`. Title resolution: `--title` flag > YAML frontmatter `title` > first H1 > file name.
2. **Report degradations.** Show the user every entry in `draft.json.warnings` (nested lists flattened, HTML blocks dropped, heading clamping, title fallback). Do not silently proceed past content loss.
3. **Upload images.** For each src in `draft.json.pending_images`, upload the local file via `initializeMediaUpload` → `appendMediaUpload` → `finalizeMediaUpload` (check `getMediaUploadStatus` until processing succeeds), media category `tweet_image`. Build a media map `{ "<src>": { "media_id": "...", "media_category": "tweet_image" } }`, save it as `media-map.json`, and re-run the converter with `--media-map media-map.json`. Remote image URLs: download them first, then upload. If an image cannot be uploaded, tell the user and ask whether to drop it or abort.
4. **Optional cover.** If the user wants a cover image, upload it the same way and include `cover_media: { media_category, media_id }` in the draft call.
5. **Create the draft.** Call `articleCreateDraft` with `{ title, content_state }` (plus `cover_media` if any) from the final `draft.json`. Report the returned article ID and the editor URL `https://x.com/compose/articles/edit/<id>`.
6. **CHECKPOINT — stop here.** Do not publish until the user explicitly says to (e.g. "发布" / "publish"). Creating the draft is reversible; publishing is not.
7. **Publish.** On explicit approval, call `articlePublish` with the article ID. Report the returned `post_id` — the published Article is attached to that post (`https://x.com/<handle>/status/<post_id>`).

## Conversion rules (what the script already handles)

- First H1 (or frontmatter/`--title`) → article title; `##`/`###`/`####+` → header-one/two/three.
- Bold/italic/strikethrough → `inline_style_ranges`; inline code degrades to plain text (X has no inline-code style). Offsets are UTF-16 code units.
- Links → `link` entities; a standalone `x.com`/`twitter.com` status URL on its own line → embedded `post`.
- Fenced code and GFM tables → `markdown` entities (X renders them natively — do not degrade them further).
- `---` → `divider`; images → `image` entities referencing uploaded `media_id`s.
- Nested lists are flattened; raw HTML blocks are dropped. Both appear in `warnings` — surface them per step 2.

If the X API rejects the content_state, do not hand-patch the JSON: fix the Markdown or the script, re-run, and retry. The schema of record is the live spec at `https://api.twitter.com/2/openapi.json` (`ArticleCreateDraft*` schemas).
