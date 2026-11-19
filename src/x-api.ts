import { readFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import type { ContentState } from './converter.js';
import {
  clearOAuth2UserTokens,
  detectHostConfigUi,
  loadOAuth2ClientCredentials,
  loadOAuth2UserTokens,
  saveOAuth2UserTokens,
  sha256Hex,
  withOAuth2RefreshLock,
  type CredentialSource,
  type OAuth2ClientCredentials,
  type OAuth2UserTokens,
} from './keychain.js';
import {
  getApiBaseUrl,
  OAuth2TokenError,
  refreshOAuth2Token,
  runInteractiveSetupAndOAuth2Flow,
} from './oauth2.js';
import { isRemoteUrl } from './scanner.js';

const CHUNK_SIZE_BYTES = 2_500_000;
const REFRESH_BUFFER_SECONDS = 300;

export { getApiBaseUrl };

export function guessMediaType(pathOrUrl: string): string {
  const clean = pathOrUrl.split('?')[0].split('#')[0];
  const ext = extname(clean).toLowerCase();
  const mapping: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.tif': 'image/tiff',
    '.tiff': 'image/tiff',
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.webm': 'video/webm',
  };
  return mapping[ext] ?? 'image/png';
}

export function guessMediaCategory(mediaType: string): 'tweet_gif' | 'tweet_video' | 'tweet_image' {
  const normalized = mediaType.trim().toLowerCase();
  if (normalized === 'image/gif') return 'tweet_gif';
  if (normalized.startsWith('video/')) return 'tweet_video';
  return 'tweet_image';
}

export interface AuthSession {
  credentials: OAuth2ClientCredentials;
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  scope?: string;
  credentialSource: CredentialSource;
  tokenSource: CredentialSource;
  refreshed?: boolean;
  seedRefreshTokenHash?: string;
  user?: { id?: string; username?: string; name?: string };
}

function activeEnvRefreshSeedHash(): string | undefined {
  const raw = (process.env.X_OAUTH2_REFRESH_TOKEN ?? '').trim();
  if (!raw || raw.startsWith('${')) return undefined;
  return sha256Hex(raw);
}

async function refreshSessionLocked(
  credentials: OAuth2ClientCredentials,
  staleTokens: OAuth2UserTokens,
): Promise<{ tokens: OAuth2UserTokens; tokenSource: CredentialSource; refreshed: boolean }> {
  return withOAuth2RefreshLock(async () => {
    const latest = loadOAuth2UserTokens(credentials.clientId);
    const now = Math.floor(Date.now() / 1000);

    if (
      latest.tokens &&
      latest.tokens.accessToken &&
      latest.tokens.accessToken !== staleTokens.accessToken &&
      latest.tokens.expiresAt > now + REFRESH_BUFFER_SECONDS
    ) {
      return {
        tokens: latest.tokens,
        tokenSource: latest.source,
        refreshed: false,
      };
    }

    const refreshTokenToUse = latest.tokens?.refreshToken ?? staleTokens.refreshToken;
    if (!refreshTokenToUse) {
      throw new OAuth2TokenError('No OAuth 2.0 refresh token is available to refresh session.', 401);
    }

    const refreshed = await refreshOAuth2Token({
      credentials,
      refreshToken: refreshTokenToUse,
    });

    const nextRefreshToken = refreshed.refreshToken ?? refreshTokenToUse;
    const nextScope = refreshed.scope ?? latest.tokens?.scope ?? staleTokens.scope;
    const seedRefreshTokenHash =
      latest.tokens?.seedRefreshTokenHash ?? staleTokens.seedRefreshTokenHash ?? activeEnvRefreshSeedHash();

    const savedAt = Math.floor(Date.now() / 1000);
    const savedSource = saveOAuth2UserTokens(credentials.clientId, {
      accessToken: refreshed.accessToken,
      refreshToken: nextRefreshToken,
      expiresAt: refreshed.expiresAt,
      scope: nextScope,
      savedAt,
      seedRefreshTokenHash,
    });

    return {
      tokens: {
        accessToken: refreshed.accessToken,
        refreshToken: nextRefreshToken,
        expiresAt: refreshed.expiresAt,
        ...(nextScope ? { scope: nextScope } : {}),
        savedAt,
        ...(seedRefreshTokenHash ? { seedRefreshTokenHash } : {}),
      },
      tokenSource: savedSource,
      refreshed: true,
    };
  });
}

async function rawBearerJsonRequest<T = Record<string, unknown>>(options: {
  method: 'GET' | 'POST';
  pathWithQuery: string;
  accessToken: string;
  jsonBody?: unknown;
}): Promise<{ status: number; data: T; rawText: string }> {
  const url = `${getApiBaseUrl()}${options.pathWithQuery}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${options.accessToken}`,
    'X-B3-Flags': (process.env.X_B3_FLAGS ?? '1').trim() || '1',
  };

  let bodyStr: string | undefined;
  if (options.jsonBody !== undefined) {
    headers['Content-Type'] = 'application/json';
    bodyStr = JSON.stringify(options.jsonBody);
  }

  const resp = await fetch(url, {
    method: options.method,
    headers,
    body: bodyStr,
  });

  const text = await resp.text();
  let parsed: unknown = {};
  if (text.trim()) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }
  }

  if (resp.status === 402) {
    throw new Error(
      `X API returned 402 Payment Required (${options.pathWithQuery}): your X Developer App credit balance is depleted. Top up credits at https://console.x.com. Raw response: ${text}`,
    );
  }

  return { status: resp.status, data: parsed as T, rawText: text };
}

async function authorizedJsonRequest<T = Record<string, unknown>>(options: {
  method: 'GET' | 'POST';
  pathWithQuery: string;
  session: AuthSession;
  jsonBody?: unknown;
}): Promise<{ status: number; data: T; rawText: string }> {
  const first = await rawBearerJsonRequest<T>({
    method: options.method,
    pathWithQuery: options.pathWithQuery,
    accessToken: options.session.accessToken,
    jsonBody: options.jsonBody,
  });

  if (first.status !== 401 || !options.session.refreshToken) {
    return first;
  }

  const rotated = await refreshSessionLocked(options.session.credentials, {
    accessToken: options.session.accessToken,
    refreshToken: options.session.refreshToken,
    expiresAt: options.session.expiresAt,
    scope: options.session.scope,
    savedAt: Math.floor(Date.now() / 1000),
    seedRefreshTokenHash: options.session.seedRefreshTokenHash,
  });

  options.session.accessToken = rotated.tokens.accessToken;
  options.session.refreshToken = rotated.tokens.refreshToken;
  options.session.expiresAt = rotated.tokens.expiresAt;
  options.session.scope = rotated.tokens.scope;
  options.session.tokenSource = rotated.tokenSource;
  options.session.seedRefreshTokenHash = rotated.tokens.seedRefreshTokenHash;
  options.session.refreshed = options.session.refreshed || rotated.refreshed;

  return rawBearerJsonRequest<T>({
    method: options.method,
    pathWithQuery: options.pathWithQuery,
    accessToken: options.session.accessToken,
    jsonBody: options.jsonBody,
  });
}

function buildMissingTokenHint(credentialSource: CredentialSource, reason?: string): string {
  const hostUi = detectHostConfigUi();
  const prefix = reason ? `${reason} ` : '';
  if (hostUi.hasNativeConfigUi) {
    return `${prefix}Client ID found (${credentialSource}), but no valid OAuth 2.0 user token is configured yet. Ensure callback URI \`http://127.0.0.1:8976/oauth/callback\` is registered under App Settings -> User authentication settings in https://console.x.com and call \`x_article_auth_status({ login: true })\` once to authorize your account via browser PKCE (requests \`media.write\` + long-term rotating \`offline.access\`).`;
  }
  return `${prefix}No cached OAuth 2.0 user token found. Call \`x_article_auth_status({ login: true })\` or run \`npx @wezzard/mcp-x-articles auth\` to authorize in your browser.`;
}

export async function ensureAuthenticatedSession(options: {
  allowInteractiveLogin: boolean;
  verifyProbe?: boolean;
}): Promise<AuthSession> {
  const hostUi = detectHostConfigUi();
  let { credentials, source: credentialSource } = loadOAuth2ClientCredentials();
  let tokens: OAuth2UserTokens | null = null;
  let tokenSource: CredentialSource = 'none';
  let refreshedFlag = false;

  if (!credentials) {
    if (hostUi.hasNativeConfigUi || !options.allowInteractiveLogin) {
      throw new Error(`Missing X OAuth 2.0 Client ID. ${hostUi.setupInstruction}`);
    }
    const interactive = await runInteractiveSetupAndOAuth2Flow({
      existingCredentials: null,
      existingCredentialSource: 'none',
    });
    credentials = interactive.credentials;
    credentialSource = interactive.credentialSource;
    tokenSource = interactive.tokenSource;
    tokens = {
      accessToken: interactive.accessToken,
      refreshToken: interactive.refreshToken,
      expiresAt: interactive.expiresAt,
      scope: interactive.scope,
      savedAt: Math.floor(Date.now() / 1000),
      seedRefreshTokenHash: interactive.seedRefreshTokenHash,
    };
  } else {
    const loaded = loadOAuth2UserTokens(credentials.clientId);
    tokens = loaded.tokens;
    tokenSource = loaded.source;
  }

  if (tokens) {
    const now = Math.floor(Date.now() / 1000);
    const needsProactiveRefresh =
      !tokens.accessToken || now >= tokens.expiresAt - REFRESH_BUFFER_SECONDS;

    if (needsProactiveRefresh) {
      if (tokens.refreshToken) {
        try {
          const rotated = await refreshSessionLocked(credentials, tokens);
          tokens = rotated.tokens;
          tokenSource = rotated.tokenSource;
          refreshedFlag = rotated.refreshed;
        } catch (err) {
          const isInvalidGrant =
            err instanceof OAuth2TokenError &&
            (err.oauthError === 'invalid_grant' || err.status === 400 || err.status === 401);
          if (!isInvalidGrant) {
            throw err;
          }
          if (tokenSource !== 'env') {
            clearOAuth2UserTokens(credentials.clientId);
          }
          tokens = null;
          if (!options.allowInteractiveLogin) {
            throw new Error(buildMissingTokenHint(credentialSource, err.message));
          }
        }
      } else if (!tokens.accessToken) {
        if (tokenSource !== 'env') {
          clearOAuth2UserTokens(credentials.clientId);
        }
        tokens = null;
      }
    }
  }

  if (!tokens) {
    if (!options.allowInteractiveLogin) {
      throw new Error(buildMissingTokenHint(credentialSource));
    }

    const interactive = await runInteractiveSetupAndOAuth2Flow({
      existingCredentials: credentials,
      existingCredentialSource: credentialSource,
    });
    credentials = interactive.credentials;
    credentialSource = interactive.credentialSource;
    const seedHash = interactive.seedRefreshTokenHash ?? activeEnvRefreshSeedHash();
    if (seedHash && !interactive.seedRefreshTokenHash) {
      tokenSource = saveOAuth2UserTokens(credentials.clientId, {
        accessToken: interactive.accessToken,
        refreshToken: interactive.refreshToken,
        expiresAt: interactive.expiresAt,
        scope: interactive.scope,
        seedRefreshTokenHash: seedHash,
      });
    } else {
      tokenSource = interactive.tokenSource;
    }
    tokens = {
      accessToken: interactive.accessToken,
      refreshToken: interactive.refreshToken,
      expiresAt: interactive.expiresAt,
      scope: interactive.scope,
      savedAt: Math.floor(Date.now() / 1000),
      ...(seedHash ? { seedRefreshTokenHash: seedHash } : {}),
    };
  }

  const session: AuthSession = {
    credentials,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
    scope: tokens.scope,
    credentialSource,
    tokenSource,
    refreshed: refreshedFlag,
    seedRefreshTokenHash: tokens.seedRefreshTokenHash,
  };

  if (options.verifyProbe) {
    let probe: {
      status: number;
      data: { data?: { id?: string; username?: string; name?: string } };
      rawText: string;
    };
    try {
      probe = await authorizedJsonRequest<{
        data?: { id?: string; username?: string; name?: string };
      }>({
        method: 'GET',
        pathWithQuery: '/2/users/me',
        session,
      });
    } catch (err) {
      const isInvalidGrant =
        err instanceof OAuth2TokenError &&
        (err.oauthError === 'invalid_grant' || err.status === 400 || err.status === 401);
      if (!isInvalidGrant || !options.allowInteractiveLogin) {
        throw err;
      }
      clearOAuth2UserTokens(credentials.clientId);
      const interactive = await runInteractiveSetupAndOAuth2Flow({
        existingCredentials: credentials,
        existingCredentialSource: credentialSource,
      });
      const seedHash = interactive.seedRefreshTokenHash ?? activeEnvRefreshSeedHash();
      session.accessToken = interactive.accessToken;
      session.refreshToken = interactive.refreshToken;
      session.expiresAt = interactive.expiresAt;
      session.scope = interactive.scope;
      session.tokenSource = seedHash
        ? saveOAuth2UserTokens(credentials.clientId, {
            accessToken: interactive.accessToken,
            refreshToken: interactive.refreshToken,
            expiresAt: interactive.expiresAt,
            scope: interactive.scope,
            seedRefreshTokenHash: seedHash,
          })
        : interactive.tokenSource;
      session.seedRefreshTokenHash = seedHash;
      probe = await rawBearerJsonRequest<{
        data?: { id?: string; username?: string; name?: string };
      }>({
        method: 'GET',
        pathWithQuery: '/2/users/me',
        accessToken: session.accessToken,
      });
    }

    if (probe.status === 401 && options.allowInteractiveLogin) {
      clearOAuth2UserTokens(credentials.clientId);
      const interactive = await runInteractiveSetupAndOAuth2Flow({
        existingCredentials: credentials,
        existingCredentialSource: credentialSource,
      });
      const seedHash = interactive.seedRefreshTokenHash ?? activeEnvRefreshSeedHash();
      session.accessToken = interactive.accessToken;
      session.refreshToken = interactive.refreshToken;
      session.expiresAt = interactive.expiresAt;
      session.scope = interactive.scope;
      session.tokenSource = seedHash
        ? saveOAuth2UserTokens(credentials.clientId, {
            accessToken: interactive.accessToken,
            refreshToken: interactive.refreshToken,
            expiresAt: interactive.expiresAt,
            scope: interactive.scope,
            seedRefreshTokenHash: seedHash,
          })
        : interactive.tokenSource;
      session.seedRefreshTokenHash = seedHash;
      probe = await rawBearerJsonRequest<{
        data?: { id?: string; username?: string; name?: string };
      }>({
        method: 'GET',
        pathWithQuery: '/2/users/me',
        accessToken: session.accessToken,
      });
    }

    if (probe.status >= 400) {
      throw new Error(
        `X API user verification failed (HTTP ${probe.status}): ${JSON.stringify(probe.data)}`,
      );
    }
    session.user = probe.data?.data;
  }

  return session;
}

export async function loadImageBytes(
  pathOrUrl: string,
): Promise<{ bytes: Buffer; mediaType: string; displaySource: string }> {
  if (isRemoteUrl(pathOrUrl)) {
    const resp = await fetch(pathOrUrl);
    if (!resp.ok) {
      throw new Error(`Failed to download remote image ${pathOrUrl} (HTTP ${resp.status}).`);
    }
    const arrayBuf = await resp.arrayBuffer();
    const headerType = (resp.headers.get('content-type') ?? '').split(';')[0].trim();
    return {
      bytes: Buffer.from(arrayBuf),
      mediaType: headerType || guessMediaType(pathOrUrl),
      displaySource: pathOrUrl,
    };
  }
  const abs = resolve(pathOrUrl);
  return {
    bytes: readFileSync(abs),
    mediaType: guessMediaType(abs),
    displaySource: abs,
  };
}

export async function uploadMediaBuffer(options: {
  bytes: Buffer;
  mediaType: string;
  mediaCategory?: string;
  session: AuthSession;
  label?: string;
}): Promise<{ media_id: string; media_category: string; bytes: number }> {
  const mediaCategory = options.mediaCategory ?? guessMediaCategory(options.mediaType);

  const initResp = await authorizedJsonRequest<{ data?: { id?: string }; id?: string }>({
    method: 'POST',
    pathWithQuery: '/2/media/upload/initialize',
    session: options.session,
    jsonBody: {
      media_category: mediaCategory,
      media_type: options.mediaType,
      total_bytes: options.bytes.length,
    },
  });
  if (initResp.status >= 400) {
    throw new Error(
      `initializeMediaUpload failed for ${options.label ?? 'media'} (HTTP ${initResp.status}): ${JSON.stringify(initResp.data)}`,
    );
  }
  const mediaId = String(initResp.data?.data?.id ?? initResp.data?.id ?? '');
  if (!mediaId) {
    throw new Error(`initializeMediaUpload returned no media id: ${JSON.stringify(initResp.data)}`);
  }

  let segmentIndex = 0;
  for (let offset = 0; offset < options.bytes.length; offset += CHUNK_SIZE_BYTES) {
    const chunk = options.bytes.subarray(offset, offset + CHUNK_SIZE_BYTES);
    const appendResp = await authorizedJsonRequest({
      method: 'POST',
      pathWithQuery: `/2/media/upload/${encodeURIComponent(mediaId)}/append`,
      session: options.session,
      jsonBody: {
        media: chunk.toString('base64'),
        segment_index: segmentIndex,
      },
    });
    if (appendResp.status >= 400) {
      throw new Error(
        `appendMediaUpload segment ${segmentIndex} failed for ${options.label ?? mediaId} (HTTP ${appendResp.status}): ${JSON.stringify(appendResp.data)}`,
      );
    }
    segmentIndex += 1;
  }

  interface ProcessingInfo {
    state?: string;
    check_after_secs?: number;
    error?: unknown;
  }
  interface FinalizeData {
    data?: { processing_info?: ProcessingInfo };
    processing_info?: ProcessingInfo;
  }

  const finResp = await authorizedJsonRequest<FinalizeData>({
    method: 'POST',
    pathWithQuery: `/2/media/upload/${encodeURIComponent(mediaId)}/finalize`,
    session: options.session,
  });
  if (finResp.status >= 400) {
    throw new Error(
      `finalizeMediaUpload failed for ${options.label ?? mediaId} (HTTP ${finResp.status}): ${JSON.stringify(finResp.data)}`,
    );
  }

  let proc = finResp.data?.data?.processing_info ?? finResp.data?.processing_info;
  while (proc && (proc.state === 'pending' || proc.state === 'in_progress')) {
    const waitSeconds = Math.max(1, Number(proc.check_after_secs ?? 2));
    await new Promise((r) => setTimeout(r, waitSeconds * 1000));
    const statusResp = await authorizedJsonRequest<FinalizeData>({
      method: 'GET',
      pathWithQuery: `/2/media/upload?media_id=${encodeURIComponent(mediaId)}&command=STATUS`,
      session: options.session,
    });
    if (statusResp.status >= 400) {
      throw new Error(
        `getMediaUploadStatus failed for ${mediaId} (HTTP ${statusResp.status}): ${JSON.stringify(statusResp.data)}`,
      );
    }
    proc = statusResp.data?.data?.processing_info ?? statusResp.data?.processing_info;
  }

  if (proc?.state === 'failed') {
    throw new Error(`X media processing failed for ${options.label ?? mediaId}: ${JSON.stringify(proc)}`);
  }

  return {
    media_id: mediaId,
    media_category: mediaCategory,
    bytes: options.bytes.length,
  };
}

export async function createXArticleDraft(options: {
  title: string;
  contentState: ContentState;
  coverMediaId?: string;
  coverMediaCategory?: string;
  session: AuthSession;
}): Promise<{ article_id: string; editor_url: string; raw: unknown }> {
  const payload: Record<string, unknown> = {
    title: options.title,
    content_state: options.contentState,
  };
  if (options.coverMediaId) {
    payload.cover_media = {
      media_category: options.coverMediaCategory ?? 'tweet_image',
      media_id: options.coverMediaId,
    };
  }

  const resp = await authorizedJsonRequest<{ data?: { id?: string }; id?: string }>({
    method: 'POST',
    pathWithQuery: '/2/articles/draft',
    session: options.session,
    jsonBody: payload,
  });

  if (resp.status >= 400) {
    throw new Error(`articleCreateDraft failed (HTTP ${resp.status}): ${JSON.stringify(resp.data)}`);
  }

  const articleId = String(resp.data?.data?.id ?? resp.data?.id ?? '');
  if (!articleId) {
    throw new Error(`articleCreateDraft returned no article id: ${JSON.stringify(resp.data)}`);
  }

  return {
    article_id: articleId,
    editor_url: `https://x.com/compose/articles/edit/${articleId}`,
    raw: resp.data,
  };
}

export async function publishXArticle(options: {
  articleId: string;
  session: AuthSession;
  usernameHint?: string;
}): Promise<{ article_id: string; post_id: string; post_url: string; raw: unknown }> {
  const cleanId = options.articleId.trim();
  if (!/^[0-9]{1,19}$/.test(cleanId)) {
    throw new Error(`Invalid article_id "${options.articleId}": expected a numeric X snowflake ID.`);
  }

  const resp = await authorizedJsonRequest<{ data?: { post_id?: string; id?: string }; post_id?: string }>({
    method: 'POST',
    pathWithQuery: `/2/articles/${encodeURIComponent(cleanId)}/publish`,
    session: options.session,
  });

  if (resp.status >= 400) {
    throw new Error(`articlePublish failed (HTTP ${resp.status}): ${JSON.stringify(resp.data)}`);
  }

  const postId = String(resp.data?.data?.post_id ?? resp.data?.post_id ?? resp.data?.data?.id ?? '');
  const handleSegment = options.usernameHint ? options.usernameHint : 'i';
  const postUrl = postId ? `https://x.com/${handleSegment}/status/${postId}` : '';

  return {
    article_id: cleanId,
    post_id: postId,
    post_url: postUrl,
    raw: resp.data,
  };
}

export type { OAuth2ClientCredentials };
