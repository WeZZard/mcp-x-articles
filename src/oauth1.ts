import { execFile } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  detectHostConfigUi,
  saveConsumerCredentials,
  type ConsumerCredentials,
  type CredentialSource,
} from './keychain.js';

function getOAuthBaseUrl(): string {
  return (process.env.X_OAUTH_BASE_URL ?? 'https://api.x.com').trim().replace(/\/+$/, '');
}

export interface OAuth1SigningCredentials {
  consumerKey: string;
  consumerSecret: string;
  tokenKey?: string;
  tokenSecret?: string;
}

export interface SignOAuth1Options {
  method: string;
  url: string;
  credentials: OAuth1SigningCredentials;
  extraOAuthParams?: Record<string, string>;
  formBodyParams?: Record<string, string>;
  timestamp?: string;
  nonce?: string;
}

export function rfc3986Encode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export function signOAuth1Header(options: SignOAuth1Options): string {
  const parsedUrl = new URL(options.url);
  const baseUri = `${parsedUrl.protocol}//${parsedUrl.host}${parsedUrl.pathname}`;
  const method = options.method.toUpperCase();

  const oauthParams: Record<string, string> = {
    oauth_consumer_key: options.credentials.consumerKey,
    oauth_nonce: options.nonce ?? randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: options.timestamp ?? String(Math.floor(Date.now() / 1000)),
    oauth_version: '1.0',
    ...(options.credentials.tokenKey ? { oauth_token: options.credentials.tokenKey } : {}),
    ...(options.extraOAuthParams ?? {}),
  };

  const pairs: Array<[string, string]> = [];
  for (const [k, v] of Object.entries(oauthParams)) {
    pairs.push([rfc3986Encode(k), rfc3986Encode(v)]);
  }
  for (const [k, v] of parsedUrl.searchParams.entries()) {
    pairs.push([rfc3986Encode(k), rfc3986Encode(v)]);
  }
  if (options.formBodyParams) {
    for (const [k, v] of Object.entries(options.formBodyParams)) {
      pairs.push([rfc3986Encode(k), rfc3986Encode(v)]);
    }
  }

  pairs.sort((a, b) => {
    if (a[0] === b[0]) return a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0;
    return a[0] < b[0] ? -1 : 1;
  });

  const normalizedParams = pairs.map(([k, v]) => `${k}=${v}`).join('&');
  const baseString = `${method}&${rfc3986Encode(baseUri)}&${rfc3986Encode(normalizedParams)}`;
  const signingKey = `${rfc3986Encode(options.credentials.consumerSecret)}&${rfc3986Encode(
    options.credentials.tokenSecret ?? '',
  )}`;
  const signature = createHmac('sha1', signingKey).update(baseString, 'utf8').digest('base64');

  const headerEntries: Array<[string, string]> = [
    ...Object.entries(oauthParams),
    ['oauth_signature', signature] as [string, string],
  ].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  const headerBody = headerEntries
    .map(([k, v]) => `${rfc3986Encode(k)}="${rfc3986Encode(v)}"`)
    .join(', ');

  return `OAuth ${headerBody}`;
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

function renderHtmlPage(title: string, bodyHtml: string, allowOpenLink = false): string {
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
      margin: 0; padding: 2.5rem 1.25rem;
      display: flex; justify-content: center;
      background: Canvas; color: CanvasText;
    }
    .card {
      width: 100%; max-width: 460px;
      border: 1px solid GrayText; border-radius: 12px;
      padding: 1.75rem; box-sizing: border-box;
    }
    h1 { font-size: 1.15rem; margin: 0 0 0.5rem; }
    p { font-size: 0.88rem; line-height: 1.5; opacity: 0.85; margin: 0 0 1rem; }
    label { display: block; font-size: 0.8rem; font-weight: 600; margin: 0.85rem 0 0.35rem; }
    input[type="text"], input[type="password"] {
      width: 100%; box-sizing: border-box; padding: 0.55rem 0.7rem;
      border-radius: 8px; border: 1px solid GrayText;
      background: Field; color: FieldText; font-family: ui-monospace, monospace; font-size: 0.85rem;
    }
    button, .btn {
      display: inline-block; margin-top: 1.1rem; width: 100%; text-align: center;
      padding: 0.65rem 1rem; border-radius: 8px; border: none;
      background: #0f1419; color: #ffffff; font-weight: 600; font-size: 0.88rem;
      cursor: pointer; text-decoration: none; box-sizing: border-box;
    }
    @media (prefers-color-scheme: dark) {
      button, .btn { background: #eff3f4; color: #0f1419; }
    }
    .err {
      padding: 0.65rem 0.8rem; border-radius: 8px; border: 1px solid #d93025;
      font-size: 0.8rem; margin-bottom: 0.9rem;
    }
    code { font-family: ui-monospace, monospace; font-size: 0.8rem; }
  </style>
</head>
<body>
  <div class="card">
    ${bodyHtml}
  </div>
  ${allowOpenLink ? '' : ''}
</body>
</html>`;
}

async function readFormBody(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > 32 * 1024) {
      throw new Error('Form payload too large.');
    }
    chunks.push(buf);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

async function requestXToken(
  consumerKey: string,
  consumerSecret: string,
  oauthCallback: string,
): Promise<{ ok: true; requestToken: string; requestTokenSecret: string } | { ok: false; status: number; body: string }> {
  const url = `${getOAuthBaseUrl()}/oauth/request_token`;
  const auth = signOAuth1Header({
    method: 'POST',
    url,
    credentials: { consumerKey, consumerSecret },
    extraOAuthParams: { oauth_callback: oauthCallback },
  });
  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: auth },
  });
  const body = await resp.text();
  if (!resp.ok) {
    return { ok: false, status: resp.status, body };
  }
  const params = new URLSearchParams(body);
  const requestToken = params.get('oauth_token') ?? '';
  const requestTokenSecret = params.get('oauth_token_secret') ?? '';
  if (!requestToken || !requestTokenSecret) {
    return { ok: false, status: 500, body: `Malformed request_token response: ${body}` };
  }
  return { ok: true, requestToken, requestTokenSecret };
}

async function exchangeXAccessToken(options: {
  consumerKey: string;
  consumerSecret: string;
  requestToken: string;
  requestTokenSecret: string;
  verifier: string;
}): Promise<{ accessToken: string; accessSecret: string }> {
  const url = `${getOAuthBaseUrl()}/oauth/access_token`;
  const auth = signOAuth1Header({
    method: 'POST',
    url,
    credentials: {
      consumerKey: options.consumerKey,
      consumerSecret: options.consumerSecret,
      tokenKey: options.requestToken,
      tokenSecret: options.requestTokenSecret,
    },
    extraOAuthParams: { oauth_verifier: options.verifier },
  });
  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: auth },
  });
  const body = await resp.text();
  if (!resp.ok) {
    throw new Error(`Failed to exchange X OAuth access token (HTTP ${resp.status}): ${body}`);
  }
  const params = new URLSearchParams(body);
  const accessToken = params.get('oauth_token') ?? '';
  const accessSecret = params.get('oauth_token_secret') ?? '';
  if (!accessToken || !accessSecret) {
    throw new Error(`Malformed X OAuth access_token response: ${body}`);
  }
  return { accessToken, accessSecret };
}

async function listenWithRandomFallback(
  server: HttpServer,
  host: string,
  preferredPort: number,
): Promise<{ actualPort: number; usedFallbackPort: boolean }> {
  if (preferredPort > 0) {
    try {
      await new Promise<void>((resolveListen, rejectListen) => {
        const onErr = (err: NodeJS.ErrnoException) => {
          server.off('listening', onListening);
          rejectListen(err);
        };
        const onListening = () => {
          server.off('error', onErr);
          resolveListen();
        };
        server.once('error', onErr);
        server.once('listening', onListening);
        server.listen(preferredPort, host);
      });
      const addr = server.address() as AddressInfo;
      return { actualPort: addr.port, usedFallbackPort: false };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== 'EADDRINUSE' && code !== 'EACCES') {
        throw err;
      }
      process.stderr.write(
        `[@wezzard/mcp-x-articles] Port ${preferredPort} is in use; falling back to an OS-assigned random port with OAuth 1.0a PIN mode.\n`,
      );
    }
  }

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, host, () => {
      server.off('error', rejectListen);
      resolveListen();
    });
  });
  const addr = server.address() as AddressInfo;
  return { actualPort: addr.port, usedFallbackPort: true };
}

export interface InteractiveAuthResult {
  credentials: ConsumerCredentials;
  credentialSource: CredentialSource;
  accessToken: string;
  accessSecret: string;
  usedOobPinFallback: boolean;
  boundPort: number;
  entryUrl: string;
}

/**
 * Unified local loopback onboarding & OAuth 1.0a flow:
 * - Tries preferred port 8976 first so X's exact-match `http://127.0.0.1:8976/oauth/callback`
 *   completes in one click without manual PIN entry.
 * - If port 8976 is occupied (`EADDRINUSE`) or `X_OAUTH_CALLBACK_PORT=0` or X rejects the callback URL,
 *   automatically binds an OS-assigned random port (`port: 0`) and switches to `oauth_callback="oob"`
 *   PIN entry inside the same local browser tab—preventing port conflicts completely.
 * - If Consumer Key/Secret are not yet configured, serves `/setup` on `127.0.0.1` so GUI users
 *   (Claude Desktop, Codex GUI, Cursor, Antigravity) save keys straight to macOS Keychain without
 *   opening Terminal or exposing secrets to the LLM.
 */
export async function runInteractiveSetupAndOAuth1Flow(options: {
  existingCredentials: ConsumerCredentials | null;
  existingCredentialSource: CredentialSource;
  onServerReady?: (url: string) => void;
}): Promise<InteractiveAuthResult> {
  const host = (process.env.X_OAUTH_CALLBACK_HOST ?? '127.0.0.1').trim() || '127.0.0.1';
  const rawPort = (process.env.X_OAUTH_CALLBACK_PORT ?? '8976').trim();
  const preferredPort = rawPort === '0' ? 0 : Number(rawPort) || 8976;
  const callbackPath = (process.env.X_OAUTH_CALLBACK_PATH ?? '/oauth/callback').trim() || '/oauth/callback';
  const timeoutSec = Number(process.env.X_OAUTH_CALLBACK_TIMEOUT || '300') || 300;
  const csrfSecret = randomBytes(16).toString('hex');

  let creds: ConsumerCredentials | null = options.existingCredentials;
  let credSource: CredentialSource = options.existingCredentialSource;

  const hostUi = detectHostConfigUi();
  if (!creds && hostUi.hasNativeConfigUi) {
    throw new Error(
      `Missing X OAuth Consumer Key and Secret. The localhost web setup form is only used when the host agent has no native configuration UI. ${hostUi.setupInstruction}`,
    );
  }
  let activeReqToken = '';
  let activeReqSecret = '';
  let useOobMode = false;
  let actualPort = preferredPort;

  const sendHtml = (res: ServerResponse, status: number, html: string) => {
    res.statusCode = status;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
    );
    res.end(html);
  };

  let resolveDone!: (res: InteractiveAuthResult) => void;
  let rejectDone!: (err: Error) => void;
  const donePromise = new Promise<InteractiveAuthResult>((res, rej) => {
    resolveDone = res;
    rejectDone = rej;
  });

  const initiateOAuthStep = async (currentCreds: ConsumerCredentials): Promise<string> => {
    if (!useOobMode) {
      const cbUrl = `http://${host}:${actualPort}${callbackPath}`;
      const attempt = await requestXToken(
        currentCreds.consumerKey,
        currentCreds.consumerSecret,
        cbUrl,
      );
      if (attempt.ok) {
        activeReqToken = attempt.requestToken;
        activeReqSecret = attempt.requestTokenSecret;
        return `${getOAuthBaseUrl()}/oauth/authorize?oauth_token=${encodeURIComponent(activeReqToken)}`;
      }
      // If callback URL is not whitelisted in console.x.com, fall back seamlessly to OOB PIN mode!
      if (
        attempt.body.toLowerCase().includes('callback') ||
        attempt.status === 401 ||
        attempt.status === 403 ||
        attempt.status === 400
      ) {
        const oobAttempt = await requestXToken(
          currentCreds.consumerKey,
          currentCreds.consumerSecret,
          'oob',
        );
        if (oobAttempt.ok) {
          useOobMode = true;
          activeReqToken = oobAttempt.requestToken;
          activeReqSecret = oobAttempt.requestTokenSecret;
          return `http://${host}:${actualPort}/pin?s=${csrfSecret}`;
        }
      }
      throw new Error(`X OAuth request_token failed (HTTP ${attempt.status}): ${attempt.body}`);
    }

    const oobRes = await requestXToken(
      currentCreds.consumerKey,
      currentCreds.consumerSecret,
      'oob',
    );
    if (!oobRes.ok) {
      throw new Error(`X OAuth request_token (oob) failed (HTTP ${oobRes.status}): ${oobRes.body}`);
    }
    activeReqToken = oobRes.requestToken;
    activeReqSecret = oobRes.requestTokenSecret;
    return `http://${host}:${actualPort}/pin?s=${csrfSecret}`;
  };

  const renderSetupForm = (errorMsg?: string): string =>
    renderHtmlPage(
      'Setup @wezzard/mcp-x-articles',
      [
        '<h1>Connect @wezzard/mcp-x-articles</h1>',
        '<p>Enter your X Developer App keys from <code>https://console.x.com</code>. They are saved directly into your local OS Keychain and never sent to any AI model.</p>',
        errorMsg ? `<div class="err">${escapeHtml(errorMsg)}</div>` : '',
        '<form method="POST" action="/setup">',
        `<input type="hidden" name="s" value="${csrfSecret}" />`,
        '<label for="ck">X API Key (Consumer Key)</label>',
        '<input id="ck" name="consumer_key" type="text" autocomplete="off" required />',
        '<label for="cs">X API Key Secret (Consumer Secret)</label>',
        '<input id="cs" name="consumer_secret" type="password" autocomplete="off" required />',
        '<button type="submit">Save to Keychain &amp; Authorize on X &rarr;</button>',
        '</form>',
      ].join('\n'),
    );

  const renderPinForm = (authorizeUrl: string, errorMsg?: string): string =>
    renderHtmlPage(
      'Authorize @wezzard/mcp-x-articles',
      [
        '<h1>Enter Your X Authorization PIN</h1>',
        '<p>1. Open X in a new tab and click <strong>Authorize app</strong>.<br/>2. Copy the 7-digit PIN displayed by X and paste it below.</p>',
        `<p><a class="btn" href="${escapeHtml(authorizeUrl)}" target="_blank" rel="noopener noreferrer">1. Open X Authorization Page &nearr;</a></p>`,
        errorMsg ? `<div class="err">${escapeHtml(errorMsg)}</div>` : '',
        '<form method="POST" action="/pin">',
        `<input type="hidden" name="s" value="${csrfSecret}" />`,
        '<label for="pin">2. X OAuth PIN Code</label>',
        '<input id="pin" name="verifier" type="text" inputmode="numeric" autocomplete="one-time-code" placeholder="1234567" required />',
        '<button type="submit">Complete Authentication</button>',
        '</form>',
      ].join('\n'),
      true,
    );

  const server = createServer(async (req, res) => {
    try {
      const reqUrl = new URL(req.url ?? '/', `http://${host}:${actualPort}`);

      if (req.method === 'GET' && reqUrl.pathname === '/setup') {
        if (reqUrl.searchParams.get('s') !== csrfSecret) {
          sendHtml(res, 403, renderHtmlPage('Forbidden', '<h1>Invalid setup session token.</h1>'));
          return;
        }
        sendHtml(res, 200, renderSetupForm());
        return;
      }

      if (req.method === 'POST' && reqUrl.pathname === '/setup') {
        const form = await readFormBody(req);
        if (form.get('s') !== csrfSecret) {
          sendHtml(res, 403, renderHtmlPage('Forbidden', '<h1>Invalid setup session token.</h1>'));
          return;
        }
        const ck = (form.get('consumer_key') ?? '').trim();
        const cs = (form.get('consumer_secret') ?? '').trim();
        if (!ck || !cs) {
          sendHtml(res, 400, renderSetupForm('Both API Key and API Key Secret are required.'));
          return;
        }
        const candidate: ConsumerCredentials = { consumerKey: ck, consumerSecret: cs };
        try {
          const nextUrl = await initiateOAuthStep(candidate);
          credSource = saveConsumerCredentials(candidate);
          creds = candidate;
          res.statusCode = 302;
          res.setHeader('Location', nextUrl);
          res.end();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          sendHtml(res, 400, renderSetupForm(msg));
        }
        return;
      }

      if (req.method === 'GET' && reqUrl.pathname === '/pin') {
        if (reqUrl.searchParams.get('s') !== csrfSecret || !activeReqToken) {
          sendHtml(res, 403, renderHtmlPage('Forbidden', '<h1>Invalid PIN session.</h1>'));
          return;
        }
        const authUrl = `${getOAuthBaseUrl()}/oauth/authorize?oauth_token=${encodeURIComponent(activeReqToken)}`;
        sendHtml(res, 200, renderPinForm(authUrl));
        return;
      }

      if (req.method === 'POST' && reqUrl.pathname === '/pin') {
        const form = await readFormBody(req);
        if (form.get('s') !== csrfSecret || !creds || !activeReqToken) {
          sendHtml(res, 403, renderHtmlPage('Forbidden', '<h1>Invalid PIN session.</h1>'));
          return;
        }
        const verifier = (form.get('verifier') ?? '').trim();
        if (!verifier) {
          const authUrl = `${getOAuthBaseUrl()}/oauth/authorize?oauth_token=${encodeURIComponent(activeReqToken)}`;
          sendHtml(res, 400, renderPinForm(authUrl, 'Please enter the PIN code from X.'));
          return;
        }
        try {
          const exchanged = await exchangeXAccessToken({
            consumerKey: creds.consumerKey,
            consumerSecret: creds.consumerSecret,
            requestToken: activeReqToken,
            requestTokenSecret: activeReqSecret,
            verifier,
          });
          sendHtml(
            res,
            200,
            renderHtmlPage(
              'OAuth Complete',
              '<h1>Authentication Complete</h1><p>Your X credentials and token are saved in your local Keychain. You may close this tab and return to your agent.</p>',
            ),
          );
          clearTimeout(timer);
          server.close();
          resolveDone({
            credentials: creds,
            credentialSource: credSource,
            accessToken: exchanged.accessToken,
            accessSecret: exchanged.accessSecret,
            usedOobPinFallback: true,
            boundPort: actualPort,
            entryUrl,
          });
        } catch (err) {
          const authUrl = `${getOAuthBaseUrl()}/oauth/authorize?oauth_token=${encodeURIComponent(activeReqToken)}`;
          const msg = err instanceof Error ? err.message : String(err);
          sendHtml(res, 400, renderPinForm(authUrl, msg));
        }
        return;
      }

      if (req.method === 'GET' && reqUrl.pathname === callbackPath) {
        const cbToken = reqUrl.searchParams.get('oauth_token') ?? '';
        const cbVerifier = reqUrl.searchParams.get('oauth_verifier') ?? '';
        if (!creds || !cbToken || !cbVerifier || cbToken !== activeReqToken) {
          sendHtml(
            res,
            400,
            renderHtmlPage('OAuth Error', '<h1>OAuth callback parameters were invalid or mismatched.</h1>'),
          );
          return;
        }
        const exchanged = await exchangeXAccessToken({
          consumerKey: creds.consumerKey,
          consumerSecret: creds.consumerSecret,
          requestToken: activeReqToken,
          requestTokenSecret: activeReqSecret,
          verifier: cbVerifier,
        });
        sendHtml(
          res,
          200,
          renderHtmlPage(
            'OAuth Complete',
            '<h1>Authentication Complete</h1><p>Authorization succeeded. You may close this tab and return to your agent.</p>',
          ),
        );
        clearTimeout(timer);
        server.close();
        resolveDone({
          credentials: creds,
          credentialSource: credSource,
          accessToken: exchanged.accessToken,
          accessSecret: exchanged.accessSecret,
          usedOobPinFallback: false,
          boundPort: actualPort,
          entryUrl,
        });
        return;
      }

      res.statusCode = 404;
      res.end('Not found.');
    } catch (err) {
      clearTimeout(timer);
      server.close();
      rejectDone(err instanceof Error ? err : new Error(String(err)));
    }
  });

  const bindRes = await listenWithRandomFallback(server, host, preferredPort);
  actualPort = bindRes.actualPort;
  useOobMode = bindRes.usedFallbackPort;

  const timer = setTimeout(() => {
    server.close();
    rejectDone(new Error('Timed out waiting for X OAuth setup/authorization in browser.'));
  }, timeoutSec * 1000);

  let entryUrl: string;
  try {
    if (!creds) {
      entryUrl = `http://${host}:${actualPort}/setup?s=${csrfSecret}`;
    } else {
      entryUrl = await initiateOAuthStep(creds);
    }
  } catch (err) {
    clearTimeout(timer);
    server.close();
    throw err;
  }

  process.stderr.write(`[@wezzard/mcp-x-articles] Opening browser for X authentication: ${entryUrl}\n`);
  options.onServerReady?.(entryUrl);
  openBrowserUrl(entryUrl);

  return donePromise;
}
