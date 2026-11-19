import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_KEYCHAIN_SERVICE = '@wezzard/mcp-x-articles';
const CLIENT_ACCOUNT = 'oauth2_client_credentials';
const REFRESH_LOCK_STALE_MS = 30_000;
const REFRESH_LOCK_TIMEOUT_MS = 15_000;
const REFRESH_LOCK_POLL_MS = 50;

export function keychainServiceName(): string {
  return (process.env.MCP_X_ARTICLES_KEYCHAIN_SERVICE ?? '').trim() || DEFAULT_KEYCHAIN_SERVICE;
}

export interface OAuth2ClientCredentials {
  clientId: string;
  clientSecret?: string;
}

export interface OAuth2UserTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  scope?: string;
  savedAt: number;
  seedRefreshTokenHash?: string;
}

export type CredentialSource = 'env' | 'macos-keychain' | 'xdg-config' | 'none';

export interface ResolvedOAuth2ClientCredentials {
  credentials: OAuth2ClientCredentials | null;
  source: CredentialSource;
}

export interface HostConfigUiInfo {
  hasNativeConfigUi: boolean;
  hostName: 'antigravity' | 'cursor' | 'none';
  configUiUrl: string | null;
  setupInstruction: string;
}

export function detectHostConfigUi(): HostConfigUiInfo {
  const pluginRoot = (process.env.PLUGIN_ROOT ?? '').trim();
  const pluginData = (process.env.PLUGIN_DATA ?? '').trim();
  const isAntigravity =
    process.env.ANTIGRAVITY_VSCODE_HOST === '1' ||
    Boolean((process.env.ANTIGRAVITY_AUTH_SUCCESS_APP ?? '').trim()) ||
    Boolean(pluginRoot) ||
    Boolean(pluginData);

  if (isAntigravity) {
    const baseSource = pluginRoot || pluginData;
    const segments = baseSource.replace(/\/+$/, '').split('/').filter(Boolean);
    const dir = segments[segments.length - 1] || 'x-articles';
    const configUiUrl = `customization://${dir}`;
    return {
      hasNativeConfigUi: true,
      hostName: 'antigravity',
      configUiUrl,
      setupInstruction: `Open Antigravity's MCP plugin configuration UI at [X Articles](${configUiUrl}) and configure X_OAUTH2_CLIENT_ID and X_OAUTH2_CLIENT_SECRET from https://console.x.com -> Keys & Tokens -> OAuth 2.0 Keys. Then ensure http://127.0.0.1:8976/oauth/callback is registered in App Settings -> User authentication settings and call \`x_article_auth_status({ login: true })\` once to authorize with media.write + offline.access.`,
    };
  }

  if ((process.env.CURSOR_PLUGIN_ROOT ?? '').trim()) {
    return {
      hasNativeConfigUi: true,
      hostName: 'cursor',
      configUiUrl: null,
      setupInstruction:
        "Open Cursor's MCP plugin settings UI and configure X_OAUTH2_CLIENT_ID and X_OAUTH2_CLIENT_SECRET from https://console.x.com -> Keys & Tokens -> OAuth 2.0 Keys. Then ensure http://127.0.0.1:8976/oauth/callback is registered in App Settings -> User authentication settings and call `x_article_auth_status({ login: true })` once to authorize with media.write + offline.access.",
    };
  }

  return {
    hasNativeConfigUi: false,
    hostName: 'none',
    configUiUrl: null,
    setupInstruction:
      'Call `x_article_auth_status({ login: true })` to open the local browser setup form (saves OAuth 2.0 Client ID/Secret directly to macOS Keychain and completes X OAuth 2.0 PKCE with offline.access), or run `npx @wezzard/mcp-x-articles auth` in a terminal.',
  };
}

function cleanEnvValue(raw: string | undefined): string {
  const val = (raw ?? '').trim();
  if (!val || val.startsWith('${')) return '';
  return val;
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function clientKeyId(clientId: string): string {
  return sha256Hex(clientId).slice(0, 16);
}

export function configDirPath(): string {
  const xdg = (process.env.XDG_CONFIG_HOME ?? '').trim();
  const base = xdg ? xdg : join(homedir(), '.config');
  return join(base, 'mcp-x-articles');
}

function clientCredentialsFilePath(): string {
  return join(configDirPath(), 'oauth2_client.json');
}

function tokensFilePath(): string {
  return join(configDirPath(), 'oauth2_tokens.json');
}

function refreshLockFilePath(): string {
  return join(configDirPath(), 'oauth2_refresh.lock');
}

function isMacKeychainAvailable(): boolean {
  if (process.platform !== 'darwin') return false;
  if (process.env.MCP_X_ARTICLES_DISABLE_KEYCHAIN === '1') return false;
  return existsSync('/usr/bin/security');
}

function keychainRead(account: string): string | null {
  if (!isMacKeychainAvailable()) return null;
  try {
    const out = execFileSync(
      '/usr/bin/security',
      ['find-generic-password', '-s', keychainServiceName(), '-a', account, '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const trimmed = out.trim();
    return trimmed ? trimmed : null;
  } catch {
    return null;
  }
}

function keychainWrite(account: string, secretValue: string): boolean {
  if (!isMacKeychainAvailable()) return false;
  try {
    execFileSync(
      '/usr/bin/security',
      ['add-generic-password', '-U', '-s', keychainServiceName(), '-a', account, '-w', secretValue],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    return true;
  } catch {
    return false;
  }
}

function keychainDelete(account: string): void {
  if (!isMacKeychainAvailable()) return;
  try {
    execFileSync(
      '/usr/bin/security',
      ['delete-generic-password', '-s', keychainServiceName(), '-a', account],
      { stdio: ['ignore', 'ignore', 'ignore'] },
    );
  } catch {
    // Ignore when entry does not exist.
  }
}

function writeAtomic0600(filePath: string, data: unknown): void {
  const dir = configDirPath();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  const fd = openSync(tmpPath, 'w', 0o600);
  try {
    writeFileSync(fd, JSON.stringify(data, null, 2) + '\n', 'utf8');
  } finally {
    closeSync(fd);
  }
  renameSync(tmpPath, filePath);
}

function readJsonSafe<T>(filePath: string): T | null {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as T;
  } catch {
    return null;
  }
}

export function clearOAuth2ClientCredentials(): void {
  keychainDelete(CLIENT_ACCOUNT);
  const file = clientCredentialsFilePath();
  if (existsSync(file)) {
    writeAtomic0600(file, {});
  }
}

export function loadOAuth2ClientCredentials(): ResolvedOAuth2ClientCredentials {
  const envId =
    cleanEnvValue(process.env.X_OAUTH2_CLIENT_ID) || cleanEnvValue(process.env.X_CLIENT_ID);
  const envSecret =
    cleanEnvValue(process.env.X_OAUTH2_CLIENT_SECRET) ||
    cleanEnvValue(process.env.X_CLIENT_SECRET) ||
    undefined;

  if (envId) {
    return {
      credentials: {
        clientId: envId,
        ...(envSecret ? { clientSecret: envSecret } : {}),
      },
      source: 'env',
    };
  }

  // When running inside a host agent that provides a native MCP plugin configuration UI
  // (e.g. Antigravity or Cursor), client credentials must be configured through that UI
  // rather than falling back to a separate Keychain/XDG entry.
  if (
    detectHostConfigUi().hasNativeConfigUi &&
    process.env.MCP_X_ARTICLES_ALLOW_KEYCHAIN_IN_NATIVE_UI !== '1'
  ) {
    return { credentials: null, source: 'none' };
  }

  const kcRaw = keychainRead(CLIENT_ACCOUNT);
  if (kcRaw) {
    try {
      const parsed = JSON.parse(kcRaw) as Partial<OAuth2ClientCredentials>;
      if (parsed.clientId) {
        return {
          credentials: {
            clientId: parsed.clientId,
            ...(parsed.clientSecret ? { clientSecret: parsed.clientSecret } : {}),
          },
          source: 'macos-keychain',
        };
      }
    } catch {
      // Fall through to XDG config file.
    }
  }

  const fileCreds = readJsonSafe<Partial<OAuth2ClientCredentials>>(clientCredentialsFilePath());
  if (fileCreds?.clientId) {
    return {
      credentials: {
        clientId: fileCreds.clientId,
        ...(fileCreds.clientSecret ? { clientSecret: fileCreds.clientSecret } : {}),
      },
      source: 'xdg-config',
    };
  }

  return { credentials: null, source: 'none' };
}

export function saveOAuth2ClientCredentials(creds: OAuth2ClientCredentials): CredentialSource {
  const trimmedSecret = (creds.clientSecret ?? '').trim();
  const payload: OAuth2ClientCredentials = {
    clientId: creds.clientId.trim(),
    ...(trimmedSecret ? { clientSecret: trimmedSecret } : {}),
  };
  if (keychainWrite(CLIENT_ACCOUNT, JSON.stringify(payload))) {
    return 'macos-keychain';
  }
  writeAtomic0600(clientCredentialsFilePath(), payload);
  return 'xdg-config';
}

function readStoredOAuth2UserTokens(clientId: string): {
  tokens: OAuth2UserTokens | null;
  source: CredentialSource;
} {
  const keyId = clientKeyId(clientId);
  const kcAccount = `oauth2_user_token:${keyId}`;
  const kcRaw = keychainRead(kcAccount);
  if (kcRaw) {
    try {
      const parsed = JSON.parse(kcRaw) as Partial<OAuth2UserTokens>;
      if (parsed.accessToken || parsed.refreshToken) {
        return {
          tokens: {
            accessToken: parsed.accessToken ?? '',
            ...(parsed.refreshToken ? { refreshToken: parsed.refreshToken } : {}),
            expiresAt: Number(parsed.expiresAt ?? 0),
            ...(parsed.scope ? { scope: parsed.scope } : {}),
            savedAt: Number(parsed.savedAt ?? 0),
            ...(parsed.seedRefreshTokenHash
              ? { seedRefreshTokenHash: parsed.seedRefreshTokenHash }
              : {}),
          },
          source: 'macos-keychain',
        };
      }
    } catch {
      // Fall through to XDG file.
    }
  }

  const map = readJsonSafe<Record<string, Partial<OAuth2UserTokens>>>(tokensFilePath());
  const entry = map?.[keyId];
  if (entry && (entry.accessToken || entry.refreshToken)) {
    return {
      tokens: {
        accessToken: entry.accessToken ?? '',
        ...(entry.refreshToken ? { refreshToken: entry.refreshToken } : {}),
        expiresAt: Number(entry.expiresAt ?? 0),
        ...(entry.scope ? { scope: entry.scope } : {}),
        savedAt: Number(entry.savedAt ?? 0),
        ...(entry.seedRefreshTokenHash ? { seedRefreshTokenHash: entry.seedRefreshTokenHash } : {}),
      },
      source: 'xdg-config',
    };
  }

  return { tokens: null, source: 'none' };
}

export function loadOAuth2UserTokens(clientId: string): {
  tokens: OAuth2UserTokens | null;
  source: CredentialSource;
} {
  const stored = readStoredOAuth2UserTokens(clientId);
  const envRefresh = cleanEnvValue(process.env.X_OAUTH2_REFRESH_TOKEN);
  const envAccess = cleanEnvValue(process.env.X_OAUTH2_ACCESS_TOKEN);
  const now = Math.floor(Date.now() / 1000);

  if (envRefresh) {
    const envSeedHash = sha256Hex(envRefresh);
    if (stored.tokens && stored.tokens.seedRefreshTokenHash === envSeedHash) {
      return stored;
    }
    return {
      tokens: {
        accessToken: envAccess || '',
        refreshToken: envRefresh,
        expiresAt: envAccess ? now + 300 : 0,
        savedAt: 0,
        seedRefreshTokenHash: envSeedHash,
      },
      source: 'env',
    };
  }

  if (envAccess) {
    if (stored.tokens?.refreshToken && stored.tokens.accessToken) {
      return stored;
    }
    return {
      tokens: {
        accessToken: envAccess,
        expiresAt: now + 3600,
        savedAt: 0,
      },
      source: 'env',
    };
  }

  return stored;
}

export function saveOAuth2UserTokens(
  clientId: string,
  tokens: Omit<OAuth2UserTokens, 'savedAt'> & { savedAt?: number },
): CredentialSource {
  const keyId = clientKeyId(clientId);
  const record: OAuth2UserTokens = {
    accessToken: tokens.accessToken.trim(),
    ...(tokens.refreshToken?.trim() ? { refreshToken: tokens.refreshToken.trim() } : {}),
    expiresAt: Math.floor(Number(tokens.expiresAt || 0)),
    ...(tokens.scope?.trim() ? { scope: tokens.scope.trim() } : {}),
    savedAt: tokens.savedAt ?? Math.floor(Date.now() / 1000),
    ...(tokens.seedRefreshTokenHash?.trim()
      ? { seedRefreshTokenHash: tokens.seedRefreshTokenHash.trim() }
      : {}),
  };

  if (keychainWrite(`oauth2_user_token:${keyId}`, JSON.stringify(record))) {
    return 'macos-keychain';
  }

  const existing = readJsonSafe<Record<string, OAuth2UserTokens>>(tokensFilePath()) ?? {};
  existing[keyId] = record;
  writeAtomic0600(tokensFilePath(), existing);
  return 'xdg-config';
}

export function clearOAuth2UserTokens(clientId: string): void {
  const keyId = clientKeyId(clientId);
  keychainDelete(`oauth2_user_token:${keyId}`);
  const file = tokensFilePath();
  const existing = readJsonSafe<Record<string, OAuth2UserTokens>>(file);
  if (existing && keyId in existing) {
    delete existing[keyId];
    writeAtomic0600(file, existing);
  }
}

export async function withOAuth2RefreshLock<T>(fn: () => Promise<T>): Promise<T> {
  const dir = configDirPath();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lockPath = refreshLockFilePath();
  const deadline = Date.now() + REFRESH_LOCK_TIMEOUT_MS;

  while (true) {
    try {
      const fd = openSync(lockPath, 'wx', 0o600);
      try {
        writeFileSync(fd, `${process.pid}\n`, 'utf8');
      } finally {
        closeSync(fd);
      }
      try {
        return await fn();
      } finally {
        rmSync(lockPath, { force: true });
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== 'EEXIST') {
        throw err;
      }

      try {
        const st = statSync(lockPath);
        if (Date.now() - st.mtimeMs > REFRESH_LOCK_STALE_MS) {
          rmSync(lockPath, { force: true });
          continue;
        }
      } catch {
        // Lock was released between openSync and statSync; retry immediately.
        continue;
      }

      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for OAuth 2.0 refresh lock at ${lockPath}.`);
      }
      await new Promise((r) => setTimeout(r, REFRESH_LOCK_POLL_MS));
    }
  }
}
