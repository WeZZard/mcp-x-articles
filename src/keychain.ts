import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_KEYCHAIN_SERVICE = '@wezzard/mcp-x-articles';
const CONSUMER_ACCOUNT = 'consumer_credentials';

export function keychainServiceName(): string {
  return (process.env.MCP_X_ARTICLES_KEYCHAIN_SERVICE ?? '').trim() || DEFAULT_KEYCHAIN_SERVICE;
}

export interface ConsumerCredentials {
  consumerKey: string;
  consumerSecret: string;
}

export interface UserOAuthTokens {
  accessToken: string;
  accessSecret: string;
  savedAt: number;
}

export type CredentialSource = 'env' | 'macos-keychain' | 'xdg-config' | 'none';

export interface ResolvedCredentials {
  credentials: ConsumerCredentials | null;
  source: CredentialSource;
}

function cleanEnvValue(raw: string | undefined): string {
  const val = (raw ?? '').trim();
  if (!val || val.startsWith('${')) return '';
  return val;
}

export function configDirPath(): string {
  const xdg = (process.env.XDG_CONFIG_HOME ?? '').trim();
  const base = xdg ? xdg : join(homedir(), '.config');
  return join(base, 'mcp-x-articles');
}

function credentialsFilePath(): string {
  return join(configDirPath(), 'credentials.json');
}

function tokensFilePath(): string {
  return join(configDirPath(), 'oauth1_tokens.json');
}

export function consumerKeyId(consumerKey: string): string {
  return createHash('sha256').update(consumerKey, 'utf8').digest('hex').slice(0, 16);
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

export function clearConsumerCredentials(): void {
  keychainDelete(CONSUMER_ACCOUNT);
  const file = credentialsFilePath();
  if (existsSync(file)) {
    writeAtomic0600(file, {});
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

export function loadConsumerCredentials(): ResolvedCredentials {
  const envKey = cleanEnvValue(process.env.X_OAUTH_CONSUMER_KEY);
  const envSecret = cleanEnvValue(process.env.X_OAUTH_CONSUMER_SECRET);
  if (envKey && envSecret) {
    return {
      credentials: {
        consumerKey: envKey,
        consumerSecret: envSecret,
      },
      source: 'env',
    };
  }

  const kcRaw = keychainRead(CONSUMER_ACCOUNT);
  if (kcRaw) {
    try {
      const parsed = JSON.parse(kcRaw) as Partial<ConsumerCredentials>;
      if (parsed.consumerKey && parsed.consumerSecret) {
        return {
          credentials: {
            consumerKey: parsed.consumerKey,
            consumerSecret: parsed.consumerSecret,
          },
          source: 'macos-keychain',
        };
      }
    } catch {
      // Fall through to XDG config file.
    }
  }

  const fileCreds = readJsonSafe<Partial<ConsumerCredentials>>(credentialsFilePath());
  if (fileCreds?.consumerKey && fileCreds?.consumerSecret) {
    return {
      credentials: {
        consumerKey: fileCreds.consumerKey,
        consumerSecret: fileCreds.consumerSecret,
      },
      source: 'xdg-config',
    };
  }

  return { credentials: null, source: 'none' };
}

export function saveConsumerCredentials(creds: ConsumerCredentials): CredentialSource {
  const payload: ConsumerCredentials = {
    consumerKey: creds.consumerKey.trim(),
    consumerSecret: creds.consumerSecret.trim(),
  };
  if (keychainWrite(CONSUMER_ACCOUNT, JSON.stringify(payload))) {
    return 'macos-keychain';
  }
  writeAtomic0600(credentialsFilePath(), payload);
  return 'xdg-config';
}

export function loadUserOAuthTokens(consumerKey: string): {
  tokens: UserOAuthTokens | null;
  source: CredentialSource;
} {
  const envTok = cleanEnvValue(process.env.X_OAUTH_ACCESS_TOKEN);
  const envSec = cleanEnvValue(process.env.X_OAUTH_ACCESS_TOKEN_SECRET);
  if (envTok && envSec) {
    return {
      tokens: { accessToken: envTok, accessSecret: envSec, savedAt: 0 },
      source: 'env',
    };
  }

  const keyId = consumerKeyId(consumerKey);
  const kcAccount = `oauth1_user_token:${keyId}`;
  const kcRaw = keychainRead(kcAccount);
  if (kcRaw) {
    try {
      const parsed = JSON.parse(kcRaw) as Partial<UserOAuthTokens>;
      if (parsed.accessToken && parsed.accessSecret) {
        return {
          tokens: {
            accessToken: parsed.accessToken,
            accessSecret: parsed.accessSecret,
            savedAt: parsed.savedAt ?? 0,
          },
          source: 'macos-keychain',
        };
      }
    } catch {
      // Fall through to XDG file.
    }
  }

  const map = readJsonSafe<Record<string, Partial<UserOAuthTokens>>>(tokensFilePath());
  const entry = map?.[keyId];
  if (entry?.accessToken && entry?.accessSecret) {
    return {
      tokens: {
        accessToken: entry.accessToken,
        accessSecret: entry.accessSecret,
        savedAt: entry.savedAt ?? 0,
      },
      source: 'xdg-config',
    };
  }

  return { tokens: null, source: 'none' };
}

export function saveUserOAuthTokens(
  consumerKey: string,
  accessToken: string,
  accessSecret: string,
): CredentialSource {
  const keyId = consumerKeyId(consumerKey);
  const record: UserOAuthTokens = {
    accessToken: accessToken.trim(),
    accessSecret: accessSecret.trim(),
    savedAt: Math.floor(Date.now() / 1000),
  };

  if (keychainWrite(`oauth1_user_token:${keyId}`, JSON.stringify(record))) {
    return 'macos-keychain';
  }

  const existing = readJsonSafe<Record<string, UserOAuthTokens>>(tokensFilePath()) ?? {};
  existing[keyId] = record;
  writeAtomic0600(tokensFilePath(), existing);
  return 'xdg-config';
}

export function clearUserOAuthTokens(consumerKey: string): void {
  const keyId = consumerKeyId(consumerKey);
  keychainDelete(`oauth1_user_token:${keyId}`);
  const file = tokensFilePath();
  const existing = readJsonSafe<Record<string, UserOAuthTokens>>(file);
  if (existing && keyId in existing) {
    delete existing[keyId];
    writeAtomic0600(file, existing);
  }
}
