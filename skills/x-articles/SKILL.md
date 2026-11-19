---
name: x-articles
description: Publish a local Markdown file as an X Article via @wezzard/mcp-x-articles and the official X API v2 Articles endpoints.
---

# x-articles

Publish a Markdown file as an X Article through the `@wezzard/mcp-x-articles` MCP tools using OAuth 2.0 User Context (PKCE + long-term rotating `offline.access` refresh tokens).

1. Call `x_article_auth_status` if authentication is unverified:
   - If the host agent has a native MCP plugin configuration UI (`has_native_config_ui: true`, e.g. Antigravity `[X Articles](customization://x-articles)` or Cursor) and credentials are not yet configured, **do not** open the localhost `/setup` web UI; instead, give the user the `native_config_ui_url` link (`[X Articles](customization://x-articles)`) so they can configure `X_OAUTH2_CLIENT_ID`, optional `X_OAUTH2_CLIENT_SECRET`, and optional `X_OAUTH2_REFRESH_TOKEN` (from `console.x.com` → `OAuth 2.0 Keys` → `Access Token` → `Generate`) in the host's plugin settings UI.
   - Only call `x_article_auth_status({ login: true })` when `has_native_config_ui` is `false` (to open the fallback local browser `/setup` card for agents without a native plugin config UI), or when `configured: true` and `token_cached: false` and the user wants to authorize via browser PKCE login with `offline.access` instead of pasting `X_OAUTH2_REFRESH_TOKEN` in the plugin UI.
2. Call `x_article_preflight({ markdown_path, cover_image_path })` first, and visually inspect every image in `images_for_visual_review` for live credentials, financial balances, account IDs, email addresses, real names, or private file paths.
3. **Checkpoint 1:** Whenever preflight reports text `findings`, visual sensitivities, or conversion `warnings`, ask the user with your dedicated ask-user-question tool (or directly in conversation) to rule on each item before uploading anything to X.
4. Call `x_article_create_draft({ markdown_path, preflight_token, cover_image_path })` and share the returned `editor_url` (`https://x.com/compose/articles/edit/<article_id>`).
5. **Checkpoint 2:** Stop after creating the draft, and ask the user with your dedicated ask-user-question tool (or directly in conversation) for explicit approval before calling `x_article_publish({ article_id })`.
6. Respect X API limits: the Articles API provides no update endpoint and no delete endpoint, so any post-draft edits either happen in the X web composer or create a fresh draft.
