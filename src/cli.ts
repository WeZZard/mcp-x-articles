import { realpathSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import {
  clearOAuth2ClientCredentials,
  clearOAuth2UserTokens,
  clientKeyId,
  configDirPath,
  DEFAULT_KEYCHAIN_SERVICE,
  detectHostConfigUi,
  keychainServiceName,
  loadOAuth2ClientCredentials,
  loadOAuth2UserTokens,
  saveOAuth2ClientCredentials,
  saveOAuth2UserTokens,
  sha256Hex,
  withOAuth2RefreshLock,
} from './keychain.js';
import {
  buildOAuth2AuthorizeUrl,
  DEFAULT_OAUTH2_SCOPES,
  exchangeAuthorizationCode,
  generatePkcePair,
  getOAuth2AuthorizeUrl,
  getOAuth2Scopes,
  getOAuth2TokenUrl,
  OAuth2TokenError,
  refreshOAuth2Token,
  runInteractiveSetupAndOAuth2Flow,
} from './oauth2.js';
import { PACKAGE_NAME, PACKAGE_VERSION, runStdioMcpServer } from './server.js';
import { filterPublishedXArticles } from './link-resolver.js';
import {
  clearPublishedXArticlesCache,
  ensureAuthenticatedSession,
  guessMediaCategory,
  guessMediaType,
  listPublishedXArticles,
} from './x-api.js';

export {
  convertMarkdownFile,
  markdownToContentState,
  type ContentState,
  type ConversionResult,
  type ExtractedLink,
  type MediaMap,
} from './converter.js';
export {
  detectTextScript,
  extractLocalMarkdownTitle,
  filterPublishedXArticles,
  matchLinksToPublishedArticles,
  type LinkRewriteSuggestion,
  type LinkScriptKind,
  type MatchLinksResult,
  type UnresolvedLocalLink,
} from './link-resolver.js';
export {
  clearOAuth2ClientCredentials,
  clearOAuth2UserTokens,
  clientKeyId,
  configDirPath,
  DEFAULT_KEYCHAIN_SERVICE,
  detectHostConfigUi,
  keychainServiceName,
  loadOAuth2ClientCredentials,
  loadOAuth2UserTokens,
  saveOAuth2ClientCredentials,
  saveOAuth2UserTokens,
  sha256Hex,
  withOAuth2RefreshLock,
};
export {
  buildOAuth2AuthorizeUrl,
  DEFAULT_OAUTH2_SCOPES,
  exchangeAuthorizationCode,
  generatePkcePair,
  getOAuth2AuthorizeUrl,
  getOAuth2Scopes,
  getOAuth2TokenUrl,
  OAuth2TokenError,
  refreshOAuth2Token,
  runInteractiveSetupAndOAuth2Flow,
};
export {
  clearPublishedXArticlesCache,
  ensureAuthenticatedSession,
  guessMediaCategory,
  guessMediaType,
  listPublishedXArticles,
  type ListPublishedXArticlesResult,
  type PublishedXArticle,
} from './x-api.js';
export {
  computePreflightToken,
  resolveCoverImagePath,
  verifyPreflightToken,
} from './preflight-token.js';
export { extractMarkdownImageSrcs, scanSensitiveFile, scanText } from './scanner.js';
export { createMcpServer, PACKAGE_NAME, PACKAGE_VERSION, SERVER_INSTRUCTIONS } from './server.js';

function printHelp(): void {
  process.stdout.write(
    [
      `${PACKAGE_NAME} v${PACKAGE_VERSION}`,
      '',
      'Usage:',
      '  mcp-x-articles            Start the MCP server over stdio (default)',
      '  mcp-x-articles auth       Configure X OAuth 2.0 keys in macOS Keychain and authorize in browser',
      '  mcp-x-articles status     Show current OAuth 2.0 credential and token status',
      '  mcp-x-articles articles   List published X Articles from your timeline (for cross-link lookup)',
      '  mcp-x-articles --version  Print package version',
      '  mcp-x-articles --help     Print this help message',
      '',
    ].join('\n'),
  );
}

async function runAuthCli(resetKeys: boolean): Promise<void> {
  let { credentials, source } = loadOAuth2ClientCredentials();
  let cliRefreshToken = '';

  if (!credentials || resetKeys) {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
      process.stderr.write(
        'For browser PKCE login, register http://127.0.0.1:8976/oauth/callback in https://console.x.com -> App Settings -> User authentication settings.\n\n',
      );
      const clientId = (await rl.question('X OAuth 2.0 Client ID: ')).trim();
      const clientSecret =
        (await rl.question('X OAuth 2.0 Client Secret (optional for public clients): ')).trim() ||
        undefined;
      cliRefreshToken = (
        await rl.question(
          'X OAuth 2.0 Refresh Token (optional — leave blank for browser PKCE login with media.write): ',
        )
      ).trim();

      if (!clientId) {
        throw new Error('X OAuth 2.0 Client ID is required.');
      }

      source = saveOAuth2ClientCredentials({
        clientId,
        ...(clientSecret ? { clientSecret } : {}),
      });
      credentials = {
        clientId,
        ...(clientSecret ? { clientSecret } : {}),
      };
      process.stderr.write(`Saved OAuth 2.0 client credentials to ${source}.\n`);
    } finally {
      rl.close();
    }
  } else {
    process.stderr.write(`Using existing OAuth 2.0 client credentials from ${source}.\n`);
  }

  let tokenStore = source;
  if (cliRefreshToken) {
    const refreshed = await refreshOAuth2Token({
      credentials,
      refreshToken: cliRefreshToken,
    });
    tokenStore = saveOAuth2UserTokens(credentials.clientId, {
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken ?? cliRefreshToken,
      expiresAt: refreshed.expiresAt,
      scope: refreshed.scope,
      seedRefreshTokenHash: sha256Hex(cliRefreshToken),
    });
  } else {
    const interactive = await runInteractiveSetupAndOAuth2Flow({
      existingCredentials: credentials,
      existingCredentialSource: source,
    });
    tokenStore = interactive.tokenSource;
  }

  const verified = await ensureAuthenticatedSession({
    allowInteractiveLogin: false,
    verifyProbe: true,
  });

  const handle = verified.user?.username ? `@${verified.user.username}` : 'authenticated account';
  process.stdout.write(
    `Authenticated ${handle} via OAuth 2.0 successfully (credentials: ${verified.credentialSource}, user token: ${tokenStore}, refresh_token: ${Boolean(verified.refreshToken)}).\n`,
  );
}

async function runStatusCli(): Promise<void> {
  const { credentials, source } = loadOAuth2ClientCredentials();
  if (!credentials) {
    process.stdout.write(
      JSON.stringify(
        {
          auth_mode: 'oauth2',
          configured: false,
          credential_source: 'none',
          token_cached: false,
          has_refresh_token: false,
          access_token_expires_at: null,
          scopes: null,
          hint: 'Call x_article_auth_status({ login: true }) in your agent or run `npx @wezzard/mcp-x-articles auth`.',
        },
        null,
        2,
      ) + '\n',
    );
    return;
  }
  const tok = loadOAuth2UserTokens(credentials.clientId);
  process.stdout.write(
    JSON.stringify(
      {
        auth_mode: 'oauth2',
        configured: true,
        credential_source: source,
        token_cached: Boolean(tok.tokens),
        token_source: tok.source,
        has_refresh_token: Boolean(tok.tokens?.refreshToken),
        access_token_expires_at: tok.tokens?.expiresAt
          ? new Date(tok.tokens.expiresAt * 1000).toISOString()
          : null,
        scopes: tok.tokens?.scope ?? null,
      },
      null,
      2,
    ) + '\n',
  );
}

async function runArticlesCli(argv: string[]): Promise<void> {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(
      'Usage: mcp-x-articles articles [--query <text>] [--limit <n>] [--max-pages <n>] [--refresh]\n',
    );
    return;
  }

  let query: string | undefined;
  let limit = 20;
  let maxPages = 3;
  const forceRefresh = argv.includes('--refresh');

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--query' && i + 1 < argv.length) {
      query = argv[i + 1];
      i += 1;
    } else if (arg === '--limit' && i + 1 < argv.length) {
      const parsed = Number(argv[i + 1]);
      if (Number.isFinite(parsed) && parsed > 0) {
        limit = Math.min(100, Math.trunc(parsed));
      }
      i += 1;
    } else if (arg === '--max-pages' && i + 1 < argv.length) {
      const parsed = Number(argv[i + 1]);
      if (Number.isFinite(parsed) && parsed > 0) {
        maxPages = Math.min(10, Math.trunc(parsed));
      }
      i += 1;
    }
  }

  const session = await ensureAuthenticatedSession({
    allowInteractiveLogin: false,
    verifyProbe: true,
  });
  const res = await listPublishedXArticles({
    session,
    maxPages,
    forceRefresh,
  });
  const filtered = filterPublishedXArticles(res.articles, query);

  process.stdout.write(
    JSON.stringify(
      {
        ok: true,
        username: res.username,
        user_id: res.user_id,
        scanned_posts: res.scanned_posts,
        pages_fetched: res.pages_fetched,
        cached: res.cached,
        total_found: res.articles.length,
        articles: filtered.slice(0, limit),
      },
      null,
      2,
    ) + '\n',
  );
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const first = argv[0] ?? '';

  if (first === '--help' || first === '-h' || first === 'help') {
    printHelp();
    return;
  }
  if (first === '--version' || first === '-v') {
    process.stdout.write(`${PACKAGE_VERSION}\n`);
    return;
  }
  if (first === 'auth' || first === 'login') {
    await runAuthCli(argv.includes('--reset'));
    return;
  }
  if (first === 'status') {
    await runStatusCli();
    return;
  }
  if (first === 'articles') {
    await runArticlesCli(argv.slice(1));
    return;
  }

  await runStdioMcpServer();
}

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  main().catch((err) => {
    const msg = err instanceof Error ? err.stack || err.message : String(err);
    process.stderr.write(`[${PACKAGE_NAME}] Fatal error: ${msg}\n`);
    process.exit(1);
  });
}
