import { readFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import type { ContentState } from './converter.js';
import {
  clearUserOAuthTokens,
  detectHostConfigUi,
  loadConsumerCredentials,
  loadUserOAuthTokens,
  saveUserOAuthTokens,
  type ConsumerCredentials,
  type CredentialSource,
} from './keychain.js';
import {
  runInteractiveSetupAndOAuth1Flow,
  signOAuth1Header,
  type OAuth1SigningCredentials,
} from './oauth1.js';
import { isRemoteUrl } from './scanner.js';

const CHUNK_SIZE_BYTES = 2_500_000;

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

export function getApiBaseUrl(): string {
  return (process.env.X_API_BASE_URL ?? 'https://api.x.com').trim().replace(/\/+$/, '');
}

async function signedJsonRequest<T = Record<string, unknown>>(options: {
  method: 'GET' | 'POST';
  pathWithQuery: string;
  signingCreds: OAuth1SigningCredentials;
  jsonBody?: unknown;
}): Promise<{ status: number; data: T }> {
  const url = `${getApiBaseUrl()}${options.pathWithQuery}`;
  const authHeader = signOAuth1Header({
    method: options.method,
    url,
    credentials: options.signingCreds,
  });

  const headers: Record<string, string> = {
    Authorization: authHeader,
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

  return { status: resp.status, data: parsed as T };
}

export interface AuthSession {
  signingCreds: OAuth1SigningCredentials;
  credentialSource: CredentialSource;
  tokenSource: CredentialSource;
  user?: { id?: string; username?: string; name?: string };
}

export async function ensureAuthenticatedSession(options: {
  allowInteractiveLogin: boolean;
  verifyProbe?: boolean;
}): Promise<AuthSession> {
  let { credentials, source: credentialSource } = loadConsumerCredentials();
  let tokens = credentials ? loadUserOAuthTokens(credentials.consumerKey).tokens : null;
  let tokenSource: CredentialSource = credentials
    ? loadUserOAuthTokens(credentials.consumerKey).source
    : 'none';

  if (credentials && tokens && options.verifyProbe) {
    const signingCreds: OAuth1SigningCredentials = {
      consumerKey: credentials.consumerKey,
      consumerSecret: credentials.consumerSecret,
      tokenKey: tokens.accessToken,
      tokenSecret: tokens.accessSecret,
    };
    const probe = await signedJsonRequest<{ data?: { id?: string; username?: string; name?: string } }>({
      method: 'GET',
      pathWithQuery: '/2/users/me',
      signingCreds,
    });
    if (probe.status !== 401) {
      return {
        signingCreds,
        credentialSource,
        tokenSource,
        user: probe.data?.data,
      };
    }
    if (tokenSource !== 'env') {
      clearUserOAuthTokens(credentials.consumerKey);
      tokens = null;
    } else {
      throw new Error('X_OAUTH_ACCESS_TOKEN in environment variables returned 401 Unauthorized.');
    }
  }

  if (!credentials || !tokens) {
    const hostUi = detectHostConfigUi();
    if (!credentials && hostUi.hasNativeConfigUi) {
      throw new Error(`Missing X OAuth Consumer Key and Secret. ${hostUi.setupInstruction}`);
    }

    if (!options.allowInteractiveLogin) {
      if (!credentials) {
        throw new Error(`Missing X OAuth Consumer Key and Secret. ${hostUi.setupInstruction}`);
      }
      throw new Error(
        hostUi.hasNativeConfigUi
          ? `No user OAuth 1.0a token is configured yet. Either configure X_OAUTH_ACCESS_TOKEN and X_OAUTH_ACCESS_TOKEN_SECRET in ${hostUi.configUiUrl ? `[X Articles](${hostUi.configUiUrl})` : "your host's MCP plugin configuration UI"}, or call \`x_article_auth_status({ login: true })\` to authorize in your browser.`
          : 'No cached OAuth 1.0a user token found. Call `x_article_auth_status({ login: true })` or run `npx @wezzard/mcp-x-articles auth` to authorize in your browser.',
      );
    }

    const interactive = await runInteractiveSetupAndOAuth1Flow({
      existingCredentials: credentials,
      existingCredentialSource: credentialSource,
    });
    credentials = interactive.credentials;
    credentialSource = interactive.credentialSource;
    tokenSource = saveUserOAuthTokens(
      credentials.consumerKey,
      interactive.accessToken,
      interactive.accessSecret,
    );
    tokens = {
      accessToken: interactive.accessToken,
      accessSecret: interactive.accessSecret,
      savedAt: Math.floor(Date.now() / 1000),
    };
  }

  const signingCreds: OAuth1SigningCredentials = {
    consumerKey: credentials.consumerKey,
    consumerSecret: credentials.consumerSecret,
    tokenKey: tokens.accessToken,
    tokenSecret: tokens.accessSecret,
  };

  let user: { id?: string; username?: string; name?: string } | undefined;
  if (options.verifyProbe) {
    const probe = await signedJsonRequest<{ data?: { id?: string; username?: string; name?: string } }>({
      method: 'GET',
      pathWithQuery: '/2/users/me',
      signingCreds,
    });
    if (probe.status >= 400) {
      throw new Error(`X API user verification failed (HTTP ${probe.status}): ${JSON.stringify(probe.data)}`);
    }
    user = probe.data?.data;
  }

  return {
    signingCreds,
    credentialSource,
    tokenSource,
    user,
  };
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
  signingCreds: OAuth1SigningCredentials;
  label?: string;
}): Promise<{ media_id: string; media_category: string; bytes: number }> {
  const mediaCategory = options.mediaCategory ?? 'tweet_image';

  const initResp = await signedJsonRequest<{ data?: { id?: string }; id?: string }>({
    method: 'POST',
    pathWithQuery: '/2/media/upload/initialize',
    signingCreds: options.signingCreds,
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
    const appendResp = await signedJsonRequest({
      method: 'POST',
      pathWithQuery: `/2/media/upload/${encodeURIComponent(mediaId)}/append`,
      signingCreds: options.signingCreds,
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

  const finResp = await signedJsonRequest<FinalizeData>({
    method: 'POST',
    pathWithQuery: `/2/media/upload/${encodeURIComponent(mediaId)}/finalize`,
    signingCreds: options.signingCreds,
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
    const statusResp = await signedJsonRequest<FinalizeData>({
      method: 'GET',
      pathWithQuery: `/2/media/upload?media_id=${encodeURIComponent(mediaId)}&command=STATUS`,
      signingCreds: options.signingCreds,
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
  signingCreds: OAuth1SigningCredentials;
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

  const resp = await signedJsonRequest<{ data?: { id?: string }; id?: string }>({
    method: 'POST',
    pathWithQuery: '/2/articles/draft',
    signingCreds: options.signingCreds,
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
  signingCreds: OAuth1SigningCredentials;
  usernameHint?: string;
}): Promise<{ article_id: string; post_id: string; post_url: string; raw: unknown }> {
  const cleanId = options.articleId.trim();
  if (!/^[0-9]{1,19}$/.test(cleanId)) {
    throw new Error(`Invalid article_id "${options.articleId}": expected a numeric X snowflake ID.`);
  }

  const resp = await signedJsonRequest<{ data?: { post_id?: string; id?: string }; post_id?: string }>({
    method: 'POST',
    pathWithQuery: `/2/articles/${encodeURIComponent(cleanId)}/publish`,
    signingCreds: options.signingCreds,
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

export type { ConsumerCredentials };
