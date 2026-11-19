---
name: x-articles
description: Publish a local Markdown file as an X Article via @wezzard/mcp-x-articles and the official X API v2 Articles endpoints.
---

# x-articles

Publish a Markdown file as an X Article through the `@wezzard/mcp-x-articles` MCP tools using OAuth 2.0 User Context (PKCE + long-term rotating `offline.access` refresh tokens).

1. Call `x_article_auth_status` if authentication is unverified:
   - If the host agent has a native MCP plugin configuration UI (`has_native_config_ui: true`, e.g. Antigravity `[X Articles](customization://x-articles)` or Cursor) and credentials are not yet configured (`configured: false`), **do not** open the localhost `/setup` web UI; instead, give the user the `native_config_ui_url` link (`[X Articles](customization://x-articles)`) so they can configure `X_OAUTH2_CLIENT_ID` and `X_OAUTH2_CLIENT_SECRET` in the host's plugin settings UI.
   - Once `configured: true` and `token_cached: false` (or when `has_native_config_ui` is `false` for agents without a native plugin config UI), call `x_article_auth_status({ login: true })` once to authorize via browser PKCE consent (`tweet.read tweet.write users.read media.write offline.access`, using callback URI `http://127.0.0.1:8976/oauth/callback`).
2. Call `x_article_preflight({ markdown_path, cover_image_path })` first (or optionally `x_article_list_published({ query })` to inspect previously published X Articles on this account), and visually inspect every image in `images_for_visual_review` for live credentials, financial balances, account IDs, email addresses, real names, or private file paths.
3. **Checkpoint 1:** Whenever preflight reports text `findings`, visual sensitivities, conversion `warnings`, `link_rewrite_suggestions`, or `unresolved_local_links`, ask the user with your dedicated ask-user-question tool (or directly in conversation) to rule on each item — including which `link_rewrites` (`{ "<original_href>": "<x_post_or_article_url>" }`) to apply in memory — before uploading anything to X.
4. Call `x_article_create_draft({ markdown_path, preflight_token, cover_image_path, link_rewrites })` (never mutating the local Markdown file on disk) and share the returned `editor_url` (`https://x.com/compose/articles/edit/<article_id>`).
5. **Checkpoint 2:** Stop after creating the draft, and ask the user with your dedicated ask-user-question tool (or directly in conversation) for explicit approval before calling `x_article_publish({ article_id })`.
6. Respect X API limits: the Articles API provides no update endpoint and no delete endpoint, so any post-draft edits either happen in the X web composer or create a fresh draft.
