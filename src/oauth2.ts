import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  detectHostConfigUi,
  saveOAuth2ClientCredentials,
  saveOAuth2UserTokens,
  sha256Hex,
  type CredentialSource,
  type OAuth2ClientCredentials,
} from './keychain.js';

export const DEFAULT_OAUTH2_SCOPES =
  'tweet.read tweet.write users.read media.write offline.access';

export function getApiBaseUrl(): string {
  return (process.env.X_API_BASE_URL ?? 'https://api.x.com').trim().replace(/\/+$/, '');
}

export function getOAuth2AuthorizeUrl(): string {
  return (process.env.X_OAUTH2_AUTHORIZE_URL ?? 'https://x.com/i/oauth2/authorize')
    .trim()
    .replace(/\/+$/, '');
}

export function getOAuth2TokenUrl(): string {
  const override = (process.env.X_OAUTH2_TOKEN_URL ?? '').trim();
  if (override) return override.replace(/\/+$/, '');
  return `${getApiBaseUrl()}/2/oauth2/token`;
}

export function getOAuth2Scopes(): string {
  const override = (process.env.X_OAUTH2_SCOPES ?? '').trim();
  return override || DEFAULT_OAUTH2_SCOPES;
}

export function generatePkcePair(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = randomBytes(64).toString('base64url');
  const codeChallenge = createHash('sha256').update(codeVerifier, 'utf8').digest('base64url');
  return { codeVerifier, codeChallenge };
}

export function buildOAuth2AuthorizeUrl(params: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  scopes?: string;
}): string {
  const url = new URL(getOAuth2AuthorizeUrl());
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', params.clientId);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('scope', params.scopes?.trim() || getOAuth2Scopes());
  url.searchParams.set('state', params.state);
  url.searchParams.set('code_challenge', params.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

export interface OAuth2TokenResponse {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  expiresIn: number;
  scope?: string;
  tokenType?: string;
}

export class OAuth2TokenError extends Error {
  status: number;
  oauthError?: string;
  rawBody: string;

  constructor(message: string, status: number, oauthError?: string, rawBody = '') {
    super(message);
    this.name = 'OAuth2TokenError';
    this.status = status;
    this.oauthError = oauthError;
    this.rawBody = rawBody;
  }
}

async function postTokenEndpoint(options: {
  credentials: OAuth2ClientCredentials;
  params: Record<string, string>;
}): Promise<OAuth2TokenResponse> {
  const tokenUrl = getOAuth2TokenUrl();
  const body = new URLSearchParams();
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
  };

  if (options.credentials.clientSecret) {
    // Confidential client: authenticate strictly via HTTP Basic Auth and omit client_id/client_secret from body.
    const basic = Buffer.from(
      `${options.credentials.clientId}:${options.credentials.clientSecret}`,
      'utf8',
    ).toString('base64');
    headers.Authorization = `Basic ${basic}`;
  } else {
    // Public client: omit Authorization header and include client_id in the form body.
    body.set('client_id', options.credentials.clientId);
  }

  for (const [k, v] of Object.entries(options.params)) {
    body.set(k, v);
  }

  const resp = await fetch(tokenUrl, {
    method: 'POST',
    headers,
    body: body.toString(),
  });

  const text = await resp.text();
  let parsed: Record<string, unknown> = {};
  if (text.trim()) {
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      parsed = { raw: text };
    }
  }

  if (!resp.ok) {
    const oauthErr =
      typeof parsed.error === 'string'
        ? parsed.error
        : typeof parsed.title === 'string'
          ? parsed.title
          : undefined;
    const desc =
      typeof parsed.error_description === 'string'
        ? parsed.error_description
        : typeof parsed.detail === 'string'
          ? parsed.detail
          : text;
    throw new OAuth2TokenError(
      `X OAuth 2.0 token request failed (HTTP ${resp.status}${oauthErr ? `, ${oauthErr}` : ''}): ${desc}`,
      resp.status,
      oauthErr,
      text,
    );
  }

  const accessToken = typeof parsed.access_token === 'string' ? parsed.access_token.trim() : '';
  if (!accessToken) {
    throw new OAuth2TokenError(
      `X OAuth 2.0 token response did not contain access_token: ${text}`,
      resp.status,
      undefined,
      text,
    );
  }

  const refreshToken =
    typeof parsed.refresh_token === 'string' && parsed.refresh_token.trim()
      ? parsed.refresh_token.trim()
      : undefined;
  const expiresIn = Math.max(60, Number(parsed.expires_in ?? 7200) || 7200);
  const now = Math.floor(Date.now() / 1000);
  const scope = typeof parsed.scope === 'string' ? parsed.scope.trim() : undefined;
  const tokenType = typeof parsed.token_type === 'string' ? parsed.token_type.trim() : undefined;

  return {
    accessToken,
    refreshToken,
    expiresIn,
    expiresAt: now + expiresIn,
    scope,
    tokenType,
  };
}

export async function exchangeAuthorizationCode(options: {
  credentials: OAuth2ClientCredentials;
  code: string;
  redirectUri: string;
  codeVerifier: string;
}): Promise<OAuth2TokenResponse> {
  return postTokenEndpoint({
    credentials: options.credentials,
    params: {
      grant_type: 'authorization_code',
      code: options.code,
      redirect_uri: options.redirectUri,
      code_verifier: options.codeVerifier,
    },
  });
}

export async function refreshOAuth2Token(options: {
  credentials: OAuth2ClientCredentials;
  refreshToken: string;
}): Promise<OAuth2TokenResponse> {
  return postTokenEndpoint({
    credentials: options.credentials,
    params: {
      grant_type: 'refresh_token',
      refresh_token: options.refreshToken,
    },
  });
}

function openBrowserUrl(targetUrl: string): void {
  if (process.env.MCP_X_ARTICLES_NO_BROWSER === '1') return;
  if (process.platform === 'darwin') {
    execFile('/usr/bin/open', [targetUrl], () => {});
  } else if (process.platform === 'win32') {
    execFile('cmd', ['/c', 'start', '', targetUrl], () => {});
  } else {
    execFile('xdg-open', [targetUrl], () => {});
  }
}

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderHtmlPage(title: string, bodyHtml: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light dark; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      max-width: 560px;
      margin: 48px auto;
      padding: 0 20px;
      line-height: 1.55;
    }
    .card {
      border: 1px solid rgba(128,128,128,0.28);
      border-radius: 14px;
      padding: 26px 28px;
      background: rgba(128,128,128,0.05);
    }
    h1 { font-size: 20px; margin: 0 0 8px; }
    p.sub { opacity: 0.8; margin: 0 0 18px; font-size: 14px; }
    label { display: block; font-weight: 600; font-size: 13px; margin: 14px 0 6px; }
    input[type="text"], input[type="password"] {
      width: 100%;
      box-sizing: border-box;
      padding: 10px 12px;
      font-size: 14px;
      border: 1px solid rgba(128,128,128,0.38);
      border-radius: 8px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      background: transparent;
    }
    button {
      margin-top: 20px;
      width: 100%;
      padding: 11px 16px;
      font-size: 15px;
      font-weight: 600;
      border-radius: 9px;
      border: none;
      cursor: pointer;
      background: #eff3f4;
      color: #0f1419;
    }
    @media (prefers-color-scheme: light) {
      button { background: #0f1419; color: #ffffff; }
    }
    .err {
      margin-bottom: 14px;
      padding: 10px 12px;
      border-radius: 8px;
      border: 1px solid rgba(244,33,46,0.5);
      background: rgba(244,33,46,0.08);
      font-size: 13px;
    }
    .hint { font-size: 12px; opacity: 0.72; margin-top: 12px; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
  </style>
</head>
<body>
  <div class="card">
    ${bodyHtml}
  </div>
</body>
</html>`;
}

function sendHtml(res: ServerResponse, status: number, title: string, bodyHtml: string): void {
  const html = renderHtmlPage(title, bodyHtml);
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(html);
}

async function readFormBody(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    total += buf.length;
    if (total > 32 * 1024) {
      throw new Error('Request body too large.');
    }
    chunks.push(buf);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

export interface InteractiveOAuth2Result {
  credentials: OAuth2ClientCredentials;
  credentialSource: CredentialSource;
  tokenSource: CredentialSource;
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  scope?: string;
  redirectUri: string;
  seedRefreshTokenHash?: string;
}

function resolveCallbackConfig(): {
  host: string;
  port: number;
  callbackPath: string;
  explicitRedirectUri?: string;
} {
  const explicitRedirect = (process.env.X_OAUTH_REDIRECT_URI ?? '').trim();
  if (explicitRedirect) {
    const parsed = new URL(explicitRedirect);
    const port = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80;
    return {
      host: parsed.hostname || '127.0.0.1',
      port,
      callbackPath: parsed.pathname || '/oauth/callback',
      explicitRedirectUri: explicitRedirect,
    };
  }
  const host = (process.env.X_OAUTH_CALLBACK_HOST ?? '127.0.0.1').trim() || '127.0.0.1';
  const rawPort = (process.env.X_OAUTH_CALLBACK_PORT ?? '8976').trim();
  const port = rawPort === '0' ? 0 : Number(rawPort || 8976);
  const rawPath = (process.env.X_OAUTH_CALLBACK_PATH ?? '/oauth/callback').trim();
  const callbackPath = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
  return { host, port, callbackPath };
}

export async function runInteractiveSetupAndOAuth2Flow(options: {
  existingCredentials: OAuth2ClientCredentials | null;
  existingCredentialSource: CredentialSource;
  onServerReady?: (url: string) => void;
}): Promise<InteractiveOAuth2Result> {
  const hostUi = detectHostConfigUi();
  if (!options.existingCredentials && hostUi.hasNativeConfigUi) {
    throw new Error(
      `Missing X OAuth 2.0 Client ID. Because you are running inside ${hostUi.hostName}, configure X_OAUTH2_CLIENT_ID and X_OAUTH2_CLIENT_SECRET in the native plugin settings UI (${hostUi.configUiUrl ?? hostUi.hostName}) rather than the localhost setup page.`,
    );
  }

  const { host, port, callbackPath, explicitRedirectUri } = resolveCallbackConfig();
  const timeoutSec = Math.max(30, Number(process.env.X_OAUTH_CALLBACK_TIMEOUT ?? 300) || 300);

  let credentials: OAuth2ClientCredentials | null = options.existingCredentials;
  let credentialSource: CredentialSource = options.existingCredentialSource;
  const csrfToken = randomBytes(16).toString('hex');
  const pkce = generatePkcePair();
  const oauthState = randomBytes(24).toString('hex');
  let boundPort = port;
  let activeRedirectUri = explicitRedirectUri ?? `http://${host}:${port}${callbackPath}`;

  let finishResolve!: (res: InteractiveOAuth2Result) => void;
  let finishReject!: (err: Error) => void;
  const donePromise = new Promise<InteractiveOAuth2Result>((res, rej) => {
    finishResolve = res;
    finishReject = rej;
  });

  const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const reqUrl = new URL(req.url ?? '/', `http://${host}:${boundPort}`);
    const path = reqUrl.pathname;

    if (req.method === 'GET' && path === '/setup') {
      if (reqUrl.searchParams.get('s') !== csrfToken) {
        sendHtml(res, 403, 'Session Expired', '<h1>Session expired</h1><p>Restart login.</p>');
        return;
      }
      const errMsg = reqUrl.searchParams.get('error') ?? '';
      const errBlock = errMsg ? `<div class="err">${escapeHtml(errMsg)}</div>` : '';
      sendHtml(
        res,
        200,
        'Connect @wezzard/mcp-x-articles (OAuth 2.0)',
        `
          <h1>Connect @wezzard/mcp-x-articles</h1>
          <p class="sub">
            Enter your <strong>OAuth 2.0 Keys</strong> from
            <code>https://console.x.com</code> &rarr; Keys &amp; Tokens.
            Credentials are stored locally in your OS Keychain.
          </p>
          ${errBlock}
          <form method="POST" action="/setup">
            <input type="hidden" name="s" value="${escapeHtml(csrfToken)}" />
            <label for="client_id">X OAuth 2.0 Client ID</label>
            <input id="client_id" name="client_id" type="text" required autocomplete="off"
              value="${escapeHtml(credentials?.clientId ?? '')}"
              placeholder="Paste OAuth 2.0 Client ID" />
            <label for="client_secret">X OAuth 2.0 Client Secret (Optional for public clients)</label>
            <input id="client_secret" name="client_secret" type="password" autocomplete="off"
              placeholder="Paste Client Secret (or leave blank if public)" />
            <label for="refresh_token">X OAuth 2.0 Refresh Token (Optional — only if obtained with media.write + offline.access)</label>
            <input id="refresh_token" name="refresh_token" type="password" autocomplete="off"
              placeholder="Leave blank for browser PKCE login (recommended)" />
            <button type="submit">Save to Keychain &amp; Authorize on X &rarr;</button>
          </form>
          <p class="hint">
            For browser PKCE login, register callback URI:
            <code>${escapeHtml(activeRedirectUri)}</code>
          </p>
        `,
      );
      return;
    }

    if (req.method === 'POST' && path === '/setup') {
      const form = await readFormBody(req);
      if (form.get('s') !== csrfToken) {
        sendHtml(res, 403, 'Session Expired', '<h1>Session expired</h1><p>Restart login.</p>');
        return;
      }
      const clientId = (form.get('client_id') ?? '').trim();
      const clientSecret = (form.get('client_secret') ?? '').trim() || undefined;
      const refreshToken = (form.get('refresh_token') ?? '').trim();
      if (!clientId) {
        res.writeHead(302, {
          Location: `/setup?s=${csrfToken}&error=${encodeURIComponent('Client ID is required.')}`,
        });
        res.end();
        return;
      }

      const nextCreds: OAuth2ClientCredentials = {
        clientId,
        ...(clientSecret ? { clientSecret } : {}),
      };
      credentialSource = saveOAuth2ClientCredentials(nextCreds);
      credentials = nextCreds;

      if (refreshToken) {
        try {
          const tokenResp = await refreshOAuth2Token({
            credentials: nextCreds,
            refreshToken,
          });
          const nextRefresh = tokenResp.refreshToken ?? refreshToken;
          const seedHash = sha256Hex(refreshToken);
          const tokenSource = saveOAuth2UserTokens(nextCreds.clientId, {
            accessToken: tokenResp.accessToken,
            refreshToken: nextRefresh,
            expiresAt: tokenResp.expiresAt,
            scope: tokenResp.scope,
            seedRefreshTokenHash: seedHash,
          });
          sendHtml(
            res,
            200,
            'X Connected',
            '<h1>Authorized!</h1><p>Your OAuth 2.0 tokens have been refreshed and saved. You can close this tab and return to your agent.</p>',
          );
          finishResolve({
            credentials: nextCreds,
            credentialSource,
            tokenSource,
            accessToken: tokenResp.accessToken,
            refreshToken: nextRefresh,
            expiresAt: tokenResp.expiresAt,
            scope: tokenResp.scope,
            redirectUri: activeRedirectUri,
            seedRefreshTokenHash: seedHash,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          res.writeHead(302, {
            Location: `/setup?s=${csrfToken}&error=${encodeURIComponent(msg)}`,
          });
          res.end();
        }
        return;
      }

      const authUrl = buildOAuth2AuthorizeUrl({
        clientId: nextCreds.clientId,
        redirectUri: activeRedirectUri,
        state: oauthState,
        codeChallenge: pkce.codeChallenge,
      });
      res.writeHead(302, { Location: authUrl });
      res.end();
      return;
    }

    if (req.method === 'GET' && path === callbackPath) {
      const oauthError = reqUrl.searchParams.get('error');
      const oauthErrorDesc = reqUrl.searchParams.get('error_description');
      if (oauthError) {
        const msg = `X authorization declined (${oauthError}): ${oauthErrorDesc ?? 'no details'}`;
        sendHtml(res, 400, 'X Authorization Declined', `<h1>Authorization Declined</h1><p>${escapeHtml(msg)}</p>`);
        finishReject(new Error(msg));
        return;
      }

      const code = (reqUrl.searchParams.get('code') ?? '').trim();
      const returnedState = (reqUrl.searchParams.get('state') ?? '').trim();
      if (!code || returnedState !== oauthState || !credentials) {
        const msg = 'Invalid OAuth 2.0 callback state or missing authorization code.';
        sendHtml(res, 400, 'Invalid OAuth 2.0 Callback', `<h1>Invalid Callback</h1><p>${escapeHtml(msg)}</p>`);
        finishReject(new Error(msg));
        return;
      }

      try {
        const tokenResp = await exchangeAuthorizationCode({
          credentials,
          code,
          redirectUri: activeRedirectUri,
          codeVerifier: pkce.codeVerifier,
        });
        const tokenSource = saveOAuth2UserTokens(credentials.clientId, {
          accessToken: tokenResp.accessToken,
          refreshToken: tokenResp.refreshToken,
          expiresAt: tokenResp.expiresAt,
          scope: tokenResp.scope,
        });
        sendHtml(
          res,
          200,
          'X Connected',
          '<h1>Authorized!</h1><p>Long-term OAuth 2.0 authorization completed. You can close this tab and return to your agent.</p>',
        );
        finishResolve({
          credentials,
          credentialSource,
          tokenSource,
          accessToken: tokenResp.accessToken,
          refreshToken: tokenResp.refreshToken,
          expiresAt: tokenResp.expiresAt,
          scope: tokenResp.scope,
          redirectUri: activeRedirectUri,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        sendHtml(res, 500, 'Token Exchange Failed', `<h1>Token Exchange Failed</h1><p>${escapeHtml(msg)}</p>`);
        finishReject(err instanceof Error ? err : new Error(msg));
      }
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  };

  let server: HttpServer | null = null;
  try {
    server = await new Promise<HttpServer>((resolveServer, rejectServer) => {
      const s = createServer((req, res) => {
        handleRequest(req, res).catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          sendHtml(res, 500, 'Error', `<h1>Unexpected Error</h1><pre>${escapeHtml(msg)}</pre>`);
        });
      });
      s.once('error', rejectServer);
      s.listen(port, host, () => {
        s.removeListener('error', rejectServer);
        resolveServer(s);
      });
    });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'EADDRINUSE') {
      throw new Error(
        `OAuth 2.0 callback port ${host}:${port} is already in use (EADDRINUSE). Free port ${port}, or set X_OAUTH_CALLBACK_PORT / X_OAUTH_REDIRECT_URI to an open port registered in https://console.x.com.`,
      );
    }
    throw err;
  }

  boundPort = (server.address() as AddressInfo).port;
  activeRedirectUri = explicitRedirectUri ?? `http://${host}:${boundPort}${callbackPath}`;

  const timer = setTimeout(() => {
    finishReject(new Error(`OAuth 2.0 login timed out after ${timeoutSec}s.`));
  }, timeoutSec * 1000);

  try {
    const entryUrl = credentials
      ? buildOAuth2AuthorizeUrl({
          clientId: credentials.clientId,
          redirectUri: activeRedirectUri,
          state: oauthState,
          codeChallenge: pkce.codeChallenge,
        })
      : `http://${host}:${boundPort}/setup?s=${csrfToken}`;

    options.onServerReady?.(entryUrl);
    openBrowserUrl(entryUrl);
    return await donePromise;
  } finally {
    clearTimeout(timer);
    server?.close();
  }
}
