import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { convertMarkdownFile, type MediaMap } from './converter.js';
import {
  detectHostConfigUi,
  loadOAuth2ClientCredentials,
  loadOAuth2UserTokens,
} from './keychain.js';
import {
  computePreflightToken,
  resolveCoverImagePath,
  verifyPreflightToken,
} from './preflight-token.js';
import { isRemoteUrl, scanSensitiveFile } from './scanner.js';
import {
  createXArticleDraft,
  ensureAuthenticatedSession,
  guessMediaCategory,
  guessMediaType,
  loadImageBytes,
  publishXArticle,
  uploadMediaBuffer,
} from './x-api.js';

declare const __PACKAGE_VERSION__: string;

export const PACKAGE_NAME = '@wezzard/mcp-x-articles';
export const PACKAGE_VERSION = __PACKAGE_VERSION__;

const MAX_INLINE_PREVIEW_BYTES = 5 * 1024 * 1024;
const PREVIEWABLE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export const SERVER_INSTRUCTIONS = [
  'Publish local Markdown files as X Articles through a deterministic two-checkpoint workflow:',
  '1. Always call `x_article_preflight` first on the target Markdown file before calling `x_article_create_draft`.',
  '2. Visually inspect every image listed in `images_for_visual_review` (and attached MCP image blocks) for live credentials, financial balances, account IDs, email addresses, real names, or private file paths.',
  '3. Checkpoint 1: Whenever `x_article_preflight` reports text `findings`, visual sensitivities, or conversion `warnings`, ask the user via your dedicated ask-user-question tool (when available) or directly in conversation, and wait for their explicit ruling before calling `x_article_create_draft`.',
  '4. Call `x_article_create_draft` with the `preflight_token` returned by `x_article_preflight`, and share the returned `editor_url` (`https://x.com/compose/articles/edit/<id>`) with the user.',
  '5. Checkpoint 2: Never call `x_article_publish` in the same turn as `x_article_create_draft`. The X Articles API has no update endpoint and no delete endpoint; ask the user via your dedicated ask-user-question tool or in conversation, and call `x_article_publish` only after explicit approval.',
].join('\n');

const TOOLS = [
  {
    name: 'x_article_auth_status',
    title: 'Check or Setup X Articles Authentication',
    description:
      'Check X OAuth 2.0 client credential resolution (Environment Variables -> macOS Keychain -> 0600 XDG config), proactively refresh rotating offline.access tokens, and verify user token validity (`GET /2/users/me`). Set `login: true` to launch localhost OAuth 2.0 PKCE browser consent when no valid user token is available.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        login: {
          type: 'boolean',
          description:
            'When true, launches the localhost OAuth 2.0 PKCE browser consent flow if no valid user token is cached.',
        },
        verify: {
          type: 'boolean',
          description:
            'When true (default), probes GET /2/users/me against the X API to verify token validity.',
        },
      },
      additionalProperties: false,
    },
    annotations: {
      title: 'Check or Setup X Articles Authentication',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  {
    name: 'x_article_preflight',
    title: 'Run X Article Preflight Scan and Preview',
    description:
      'Required Step 1 before creating a draft. Deterministically scans the Markdown text for secrets and PII, dry-runs Markdown-to-content_state conversion to surface any lossy warnings, attaches local images for multimodal visual review, and issues a SHA-256 `preflight_token`. If findings, visual sensitivities, or warnings exist, ask the user via your ask-user-question tool or conversation before calling `x_article_create_draft`.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        markdown_path: {
          type: 'string',
          description: 'Path to the local Markdown file to publish.',
        },
        title: {
          type: 'string',
          description:
            'Optional explicit article title override (takes precedence over YAML frontmatter and first H1).',
        },
        cover_image_path: {
          type: 'string',
          description:
            'Optional cover image file path or HTTPS URL. Defaults to `cover-image-x-article.png` beside `markdown_path` when present.',
        },
        omit_cover: {
          type: 'boolean',
          description:
            'When true, skips auto-detecting `cover-image-x-article.png` beside `markdown_path`.',
        },
        include_image_previews: {
          type: 'boolean',
          description:
            'When true (default), attaches local raster images (<= 5 MiB each) as MCP image content blocks for visual secret review.',
        },
      },
      required: ['markdown_path'],
      additionalProperties: false,
    },
    annotations: {
      title: 'Run X Article Preflight Scan and Preview',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'x_article_create_draft',
    title: 'Create X Article Draft',
    description:
      'Step 2: Verify the SHA-256 `preflight_token`, upload referenced inline images and optional cover image directly in 2.5 MB chunks without streaming base64 through LLM context, compile UTF-16 `content_state` in memory, and create a reversible X Article draft. After receiving `editor_url`, STOP and ask the user (via your ask-user-question tool or conversation) before calling `x_article_publish`.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        markdown_path: {
          type: 'string',
          description: 'Path to the local Markdown file scanned during preflight.',
        },
        preflight_token: {
          type: 'string',
          description:
            'The `sha256:v1:...` token returned by `x_article_preflight` for the exact current Markdown and image files.',
        },
        title: {
          type: 'string',
          description: 'Optional explicit article title override.',
        },
        cover_image_path: {
          type: 'string',
          description: 'Optional cover image path or HTTPS URL matching preflight.',
        },
        omit_cover: {
          type: 'boolean',
          description: 'When true, omits the cover image even if `cover-image-x-article.png` exists.',
        },
      },
      required: ['markdown_path', 'preflight_token'],
      additionalProperties: false,
    },
    annotations: {
      title: 'Create X Article Draft',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: 'x_article_publish',
    title: 'Publish X Article Draft',
    description:
      'Step 3 (Irreversible): Publish a previously created X Article draft (`POST /2/articles/{article_id}/publish`). The X Articles API has NO update endpoint and NO delete endpoint. Never call this tool in the same turn as `x_article_create_draft`; call it ONLY after explicit user confirmation.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        article_id: {
          type: 'string',
          description: 'Numeric `article_id` returned by `x_article_create_draft`.',
        },
      },
      required: ['article_id'],
      additionalProperties: false,
    },
    annotations: {
      title: 'Publish X Article Draft',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
];

function jsonToolResult(payload: unknown, isError = false) {
  return {
    isError,
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

export function createMcpServer(): Server {
  const server = new Server(
    {
      name: PACKAGE_NAME,
      version: PACKAGE_VERSION,
    },
    {
      capabilities: {
        tools: {},
        prompts: {},
      },
      instructions: SERVER_INSTRUCTIONS,
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: [
      {
        name: 'publish-x-article',
        description:
          'Publish a local Markdown file as an X Article with deterministic preflight scanning, visual image inspection, draft preview, and human-approved publishing.',
        arguments: [
          {
            name: 'markdown_path',
            description: 'Path to the Markdown file to publish as an X Article.',
            required: true,
          },
          {
            name: 'cover_image_path',
            description: 'Optional cover image path or URL.',
            required: false,
          },
        ],
      },
    ],
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    if (request.params.name !== 'publish-x-article') {
      throw new Error(`Unknown prompt: ${request.params.name}`);
    }
    const mdPath = request.params.arguments?.markdown_path ?? '<markdown_path>';
    const coverArg = request.params.arguments?.cover_image_path;
    const coverLine = coverArg ? ` with cover image \`${coverArg}\`` : '';

    return {
      description: `Publish ${mdPath} as an X Article`,
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: [
              `Publish \`${mdPath}\`${coverLine} as an X Article using \`@wezzard/mcp-x-articles\`:`,
              '1. Call `x_article_preflight` first and visually inspect every returned image for credentials, balances, account IDs, emails, real names, or private paths.',
              '2. If preflight reports any text findings, visual findings, or conversion warnings, ask me using your ask-user-question tool (or in chat) and wait for my ruling before creating a draft.',
              '3. Call `x_article_create_draft` with the `preflight_token` and give me the returned `editor_url`.',
              '4. Stop and ask for my explicit confirmation (via your ask-user-question tool or chat) before calling `x_article_publish`.',
            ].join('\n'),
          },
        },
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawArgs } = request.params;
    const args = (rawArgs ?? {}) as Record<string, unknown>;

    try {
      if (name === 'x_article_auth_status') {
        const login = Boolean(args.login);
        const verify = args.verify !== false;
        const hostUi = detectHostConfigUi();

        const { credentials, source: credentialSource } = loadOAuth2ClientCredentials();
        if (!credentials) {
          // Never open the localhost /setup web form when the host agent has a native plugin configuration UI.
          if (hostUi.hasNativeConfigUi || !login) {
            return jsonToolResult({
              auth_mode: 'oauth2',
              configured: false,
              credential_source: 'none',
              token_cached: false,
              has_refresh_token: false,
              access_token_expires_at: null,
              scopes: null,
              refreshed: false,
              has_native_config_ui: hostUi.hasNativeConfigUi,
              native_config_ui_url: hostUi.configUiUrl,
              setup_hint: hostUi.setupInstruction,
            });
          }
        }

        if (credentials) {
          const cached = loadOAuth2UserTokens(credentials.clientId);
          if (!cached.tokens && !login) {
            return jsonToolResult({
              auth_mode: 'oauth2',
              configured: true,
              credential_source: credentialSource,
              token_cached: false,
              token_source: 'none',
              has_refresh_token: false,
              access_token_expires_at: null,
              scopes: null,
              refreshed: false,
              has_native_config_ui: hostUi.hasNativeConfigUi,
              native_config_ui_url: hostUi.configUiUrl,
              setup_hint: hostUi.hasNativeConfigUi
                ? `OAuth 2.0 Client ID found (${credentialSource}), but no user Access Token or Refresh Token is cached yet. Ensure \`http://127.0.0.1:8976/oauth/callback\` is registered under App Settings -> User authentication settings in https://console.x.com and call \`x_article_auth_status({ login: true })\` once to authorize your account on x.com via browser PKCE (grants \`media.write\` + long-term rotating \`offline.access\`).`
                : 'OAuth 2.0 Client ID found, but no user OAuth 2.0 token is cached yet. Call `x_article_auth_status({ login: true })` to authorize in your browser.',
            });
          }
        }

        const session = await ensureAuthenticatedSession({
          allowInteractiveLogin: login,
          verifyProbe: verify,
        });

        return jsonToolResult({
          auth_mode: 'oauth2',
          configured: true,
          credential_source: session.credentialSource,
          token_cached: true,
          token_source: session.tokenSource,
          has_refresh_token: Boolean(session.refreshToken),
          access_token_expires_at: session.expiresAt
            ? new Date(session.expiresAt * 1000).toISOString()
            : null,
          scopes: session.scope ?? null,
          refreshed: Boolean(session.refreshed),
          has_native_config_ui: hostUi.hasNativeConfigUi,
          native_config_ui_url: hostUi.configUiUrl,
          verified: verify,
          authenticated_user: session.user ?? null,
        });
      }

      if (name === 'x_article_preflight') {
        const markdownPathRaw = String(args.markdown_path ?? '').trim();
        if (!markdownPathRaw) {
          return jsonToolResult({ error: '`markdown_path` is required.' }, true);
        }
        const absMd = resolve(markdownPathRaw);
        if (!existsSync(absMd)) {
          return jsonToolResult({ error: `Markdown file not found: ${absMd}` }, true);
        }

        const explicitTitle = typeof args.title === 'string' ? args.title : undefined;
        const explicitCover =
          typeof args.cover_image_path === 'string' ? args.cover_image_path : undefined;
        const omitCover = Boolean(args.omit_cover);
        const includePreviews = args.include_image_previews !== false;

        const resolvedCover = resolveCoverImagePath(absMd, explicitCover, omitCover);
        const scanRes = scanSensitiveFile(absMd);
        const dryConversion = convertMarkdownFile(absMd, { explicitTitle });

        const preflightToken = computePreflightToken({
          markdownPath: absMd,
          inlineImageSrcs: dryConversion.pending_images,
          coverImagePath: resolvedCover,
        });

        const reviewImagePaths = [
          ...scanRes.resolved_images.map((img) => ({
            role: 'inline' as const,
            src: img.src,
            resolved_path: img.resolved_path,
            is_remote: img.is_remote,
          })),
          ...(resolvedCover
            ? [
                {
                  role: 'cover' as const,
                  src: resolvedCover,
                  resolved_path: resolvedCover,
                  is_remote: isRemoteUrl(resolvedCover),
                },
              ]
            : []),
        ];

        const requiresUserRuling =
          scanRes.findings.length > 0 ||
          dryConversion.warnings.length > 0 ||
          reviewImagePaths.length > 0;

        const summary = {
          ok: true,
          markdown_path: absMd,
          resolved_title: dryConversion.title,
          cover_image_path: resolvedCover ?? null,
          block_count: dryConversion.content_state.blocks.length,
          findings: scanRes.findings,
          warnings: dryConversion.warnings,
          images_for_visual_review: reviewImagePaths,
          preflight_token: preflightToken,
          requires_user_ruling: requiresUserRuling,
          checkpoint_instruction: requiresUserRuling
            ? 'Inspect all findings, warnings, and review images. Present any sensitive items or conversion degradations to the user via your dedicated ask-user-question tool (or directly in chat) and wait for their ruling before calling `x_article_create_draft`.'
            : 'No text findings, warnings, or images detected. You may proceed to `x_article_create_draft` using `preflight_token`.',
        };

        const contentBlocks: Array<
          | { type: 'text'; text: string }
          | { type: 'image'; data: string; mimeType: string }
        > = [{ type: 'text', text: JSON.stringify(summary, null, 2) }];

        if (includePreviews) {
          for (const img of reviewImagePaths) {
            if (img.is_remote || !existsSync(img.resolved_path)) continue;
            const st = statSync(img.resolved_path);
            if (!st.isFile() || st.size > MAX_INLINE_PREVIEW_BYTES) continue;
            const mime = guessMediaType(img.resolved_path);
            if (!PREVIEWABLE_MIMES.has(mime)) continue;
            const b64 = readFileSync(img.resolved_path).toString('base64');
            contentBlocks.push({
              type: 'text',
              text: `[Visual Review (${img.role})]: ${img.src}`,
            });
            contentBlocks.push({
              type: 'image',
              data: b64,
              mimeType: mime,
            });
          }
        }

        return {
          isError: false,
          content: contentBlocks,
        };
      }

      if (name === 'x_article_create_draft') {
        const markdownPathRaw = String(args.markdown_path ?? '').trim();
        const providedToken = String(args.preflight_token ?? '').trim();
        if (!markdownPathRaw || !providedToken) {
          return jsonToolResult(
            { error: 'Both `markdown_path` and `preflight_token` are required.' },
            true,
          );
        }

        const absMd = resolve(markdownPathRaw);
        if (!existsSync(absMd)) {
          return jsonToolResult({ error: `Markdown file not found: ${absMd}` }, true);
        }

        const explicitTitle = typeof args.title === 'string' ? args.title : undefined;
        const explicitCover =
          typeof args.cover_image_path === 'string' ? args.cover_image_path : undefined;
        const omitCover = Boolean(args.omit_cover);
        const resolvedCover = resolveCoverImagePath(absMd, explicitCover, omitCover);

        const dryRun = convertMarkdownFile(absMd, { explicitTitle });
        const tokenValid = verifyPreflightToken(providedToken, {
          markdownPath: absMd,
          inlineImageSrcs: dryRun.pending_images,
          coverImagePath: resolvedCover,
        });

        if (!tokenValid) {
          return jsonToolResult(
            {
              error:
                'Invalid or stale `preflight_token`: either `x_article_preflight` was not run, or the Markdown/image files changed on disk since preflight. Call `x_article_preflight` first to scan the current files.',
            },
            true,
          );
        }

        const session = await ensureAuthenticatedSession({
          allowInteractiveLogin: true,
          verifyProbe: true,
        });

        const mdDir = dirname(absMd);
        const mediaMap: MediaMap = {};
        const uploadedInline: Array<{ src: string; media_id: string; bytes: number }> = [];

        for (const src of dryRun.pending_images) {
          const target = isRemoteUrl(src) ? src : resolve(mdDir, src);
          const loaded = await loadImageBytes(target);
          const up = await uploadMediaBuffer({
            bytes: loaded.bytes,
            mediaType: loaded.mediaType,
            mediaCategory: guessMediaCategory(loaded.mediaType),
            session,
            label: src,
          });
          mediaMap[src] = {
            media_id: up.media_id,
            media_category: up.media_category,
          };
          uploadedInline.push({
            src,
            media_id: up.media_id,
            bytes: up.bytes,
          });
        }

        let coverMediaId: string | undefined;
        if (resolvedCover) {
          const loadedCover = await loadImageBytes(resolvedCover);
          const upCover = await uploadMediaBuffer({
            bytes: loadedCover.bytes,
            mediaType: loadedCover.mediaType,
            mediaCategory: 'tweet_image',
            session,
            label: 'cover_image',
          });
          coverMediaId = upCover.media_id;
        }

        const finalConversion = convertMarkdownFile(absMd, {
          explicitTitle,
          mediaMap,
        });

        const draft = await createXArticleDraft({
          title: finalConversion.title,
          contentState: finalConversion.content_state,
          coverMediaId,
          coverMediaCategory: 'tweet_image',
          session,
        });

        return jsonToolResult({
          ok: true,
          article_id: draft.article_id,
          editor_url: draft.editor_url,
          title: finalConversion.title,
          uploaded_inline_images: uploadedInline,
          cover_media_id: coverMediaId ?? null,
          warnings: finalConversion.warnings,
          next_step:
            'CHECKPOINT: Present `editor_url` to the user and STOP. Ask the user via your dedicated ask-user-question tool (or in conversation) for explicit approval before calling `x_article_publish`, because publishing is irreversible.',
        });
      }

      if (name === 'x_article_publish') {
        const articleId = String(args.article_id ?? '').trim();
        if (!articleId) {
          return jsonToolResult({ error: '`article_id` is required.' }, true);
        }

        const session = await ensureAuthenticatedSession({
          allowInteractiveLogin: true,
          verifyProbe: true,
        });

        const published = await publishXArticle({
          articleId,
          session,
          usernameHint: session.user?.username,
        });

        return jsonToolResult({
          ok: true,
          article_id: published.article_id,
          post_id: published.post_id,
          post_url: published.post_url,
          note: 'The X Article is now published. Deleting or editing a published Article can only be performed manually in the X web UI.',
        });
      }

      return jsonToolResult({ error: `Unknown tool: ${name}` }, true);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return jsonToolResult({ error: message }, true);
    }
  });

  return server;
}

export async function runStdioMcpServer(): Promise<void> {
  // Redirect stray console.log calls to stderr so stdout remains clean JSON-RPC.
  console.log = (...args: unknown[]) => {
    process.stderr.write(args.map(String).join(' ') + '\n');
  };
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
