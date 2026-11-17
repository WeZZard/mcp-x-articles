import { createHash, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { isRemoteUrl } from './scanner.js';

export interface PreflightDigestInput {
  markdownPath: string;
  inlineImageSrcs: string[];
  coverImagePath?: string;
}

function sha256Bytes(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex');
}

export function resolveCoverImagePath(
  markdownPath: string,
  explicitCoverPath?: string,
  omitCover?: boolean,
): string | undefined {
  if (omitCover) return undefined;
  if (explicitCoverPath && explicitCoverPath.trim()) {
    if (isRemoteUrl(explicitCoverPath.trim())) {
      return explicitCoverPath.trim();
    }
    const resolved = resolve(dirname(resolve(markdownPath)), explicitCoverPath.trim());
    if (existsSync(resolved)) return resolved;
    return resolve(explicitCoverPath.trim());
  }
  const siblingCover = resolve(dirname(resolve(markdownPath)), 'cover-image-x-article.png');
  if (existsSync(siblingCover)) {
    return siblingCover;
  }
  return undefined;
}

export function computePreflightToken(input: PreflightDigestInput): string {
  const absMd = resolve(input.markdownPath);
  const mdDir = dirname(absMd);
  if (!existsSync(absMd)) {
    throw new Error(`Markdown file not found: ${absMd}`);
  }
  const mdHash = sha256Bytes(readFileSync(absMd));

  const imageFingerprints = input.inlineImageSrcs.map((src) => {
    if (isRemoteUrl(src)) {
      return { src, kind: 'remote', hash: sha256Bytes(src) };
    }
    const imgPath = resolve(mdDir, src);
    if (!existsSync(imgPath)) {
      throw new Error(`Referenced local image not found: ${src} (expected at ${imgPath})`);
    }
    return { src, kind: 'local', path: imgPath, hash: sha256Bytes(readFileSync(imgPath)) };
  });

  let coverFingerprint: Record<string, string> | null = null;
  if (input.coverImagePath) {
    if (isRemoteUrl(input.coverImagePath)) {
      coverFingerprint = { kind: 'remote', url: input.coverImagePath, hash: sha256Bytes(input.coverImagePath) };
    } else {
      const absCover = resolve(input.coverImagePath);
      if (!existsSync(absCover)) {
        throw new Error(`Cover image not found: ${absCover}`);
      }
      coverFingerprint = { kind: 'local', path: absCover, hash: sha256Bytes(readFileSync(absCover)) };
    }
  }

  const canonicalPayload = JSON.stringify({
    v: 1,
    markdownPath: absMd,
    markdownSha256: mdHash,
    images: imageFingerprints,
    cover: coverFingerprint,
  });

  return `sha256:v1:${sha256Bytes(canonicalPayload)}`;
}

export function verifyPreflightToken(providedToken: string, input: PreflightDigestInput): boolean {
  const trimmed = providedToken.trim();
  if (!trimmed.startsWith('sha256:v1:')) return false;
  const expected = computePreflightToken(input);
  const a = Buffer.from(trimmed, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
