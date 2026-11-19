import { realpathSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import {
  clearConsumerCredentials,
  clearUserOAuthTokens,
  configDirPath,
  consumerKeyId,
  DEFAULT_KEYCHAIN_SERVICE,
  detectHostConfigUi,
  keychainServiceName,
  loadConsumerCredentials,
  loadUserOAuthTokens,
  saveConsumerCredentials,
  saveUserOAuthTokens,
} from './keychain.js';
import {
  rfc3986Encode,
  runInteractiveSetupAndOAuth1Flow,
  signOAuth1Header,
} from './oauth1.js';
import { PACKAGE_NAME, PACKAGE_VERSION, runStdioMcpServer } from './server.js';
import { ensureAuthenticatedSession } from './x-api.js';

export {
  convertMarkdownFile,
  markdownToContentState,
  type ContentState,
  type ConversionResult,
  type MediaMap,
} from './converter.js';
export {
  clearConsumerCredentials,
  clearUserOAuthTokens,
  configDirPath,
  consumerKeyId,
  DEFAULT_KEYCHAIN_SERVICE,
  detectHostConfigUi,
  keychainServiceName,
  loadConsumerCredentials,
  loadUserOAuthTokens,
  saveConsumerCredentials,
  saveUserOAuthTokens,
};
export { rfc3986Encode, runInteractiveSetupAndOAuth1Flow, signOAuth1Header };
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
      '  mcp-x-articles auth       Configure X OAuth 1.0a keys in macOS Keychain and authorize in browser',
      '  mcp-x-articles status     Show current credential and OAuth token status',
      '  mcp-x-articles --version  Print package version',
      '  mcp-x-articles --help     Print this help message',
      '',
    ].join('\n'),
  );
}

async function runAuthCli(resetKeys: boolean): Promise<void> {
  let { credentials, source } = loadConsumerCredentials();

  if (!credentials || resetKeys) {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
      process.stderr.write(
        'Optional: register http://127.0.0.1:8976/oauth/callback in https://console.x.com for 1-click redirect (otherwise automatic PIN mode is used).\n\n',
      );
      const consumerKey = (await rl.question('X OAuth Consumer Key (API Key): ')).trim();
      const consumerSecret = (await rl.question('X OAuth Consumer Secret (API Key Secret): ')).trim();

      if (!consumerKey || !consumerSecret) {
        throw new Error('Consumer Key and Consumer Secret are both required.');
      }

      source = saveConsumerCredentials({ consumerKey, consumerSecret });
      credentials = { consumerKey, consumerSecret };
      process.stderr.write(`Saved consumer credentials to ${source}.\n`);
    } finally {
      rl.close();
    }
  } else {
    process.stderr.write(`Using existing consumer credentials from ${source}.\n`);
  }

  const interactive = await runInteractiveSetupAndOAuth1Flow({
    existingCredentials: credentials,
    existingCredentialSource: source,
  });
  const tokenStore = saveUserOAuthTokens(
    interactive.credentials.consumerKey,
    interactive.accessToken,
    interactive.accessSecret,
  );
  const verified = await ensureAuthenticatedSession({
    allowInteractiveLogin: false,
    verifyProbe: true,
  });

  const handle = verified.user?.username ? `@${verified.user.username}` : 'authenticated account';
  process.stdout.write(
    `Authenticated ${handle} successfully (credentials: ${verified.credentialSource}, user token: ${tokenStore}).\n`,
  );
}

async function runStatusCli(): Promise<void> {
  const { credentials, source } = loadConsumerCredentials();
  if (!credentials) {
    process.stdout.write(
      JSON.stringify(
        {
          configured: false,
          credential_source: 'none',
          token_cached: false,
          hint: 'Call x_article_auth_status({ login: true }) in your agent or run `npx @wezzard/mcp-x-articles auth`.',
        },
        null,
        2,
      ) + '\n',
    );
    return;
  }
  const tok = loadUserOAuthTokens(credentials.consumerKey);
  process.stdout.write(
    JSON.stringify(
      {
        configured: true,
        credential_source: source,
        token_cached: Boolean(tok.tokens),
        token_source: tok.source,
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
