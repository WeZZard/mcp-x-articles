import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export interface SensitiveFinding {
  kind: string;
  source: string;
  line: number;
  preview: string;
  length: number;
}

export interface ScanSensitiveResult {
  findings: SensitiveFinding[];
  images_for_visual_review: string[];
  resolved_images: Array<{
    src: string;
    is_remote: boolean;
    resolved_path: string;
  }>;
}

const PATTERNS: Array<{ kind: string; re: RegExp }> = [
  { kind: 'x-bearer-token', re: /AAAAAA[A-Za-z0-9%]{20,}/g },
  { kind: 'github-token', re: /\b(ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/g },
  { kind: 'aws-access-key', re: /\b(AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  {
    kind: 'secret-assignment',
    re: /\b(api[_-]?key|secret|token|password|passwd|bearer)\b\s*[:=]\s*["']?[A-Za-z0-9+/_.%=-]{16,}["']?/gi,
  },
  { kind: 'email', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { kind: 'phone-ish', re: /(?<!\d)(?:\+?\d[\d -]{7,14}\d)(?!\d)/g },
  { kind: 'high-entropy-string', re: /\b[A-Za-z0-9+/=_%-]{40,}\b/g },
];

const ALLOW: RegExp[] = [
  /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?/,
  /^[0-9]{15,}$/,
  /^\d{4}-\d{2}-\d{2}/,
  /^x\.com|^twitter\.com|^github\.com|^docs\.x\.com|^console\.x\.com/i,
];

function entropy(s: string): number {
  const freq: Record<string, number> = {};
  for (const c of s) freq[c] = (freq[c] || 0) + 1;
  return -Object.values(freq).reduce((h, n) => {
    const p = n / s.length;
    return h + p * Math.log2(p);
  }, 0);
}

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split('\n').length;
}

export function scanText(text: string, source: string): SensitiveFinding[] {
  const findings: SensitiveFinding[] = [];
  for (const { kind, re } of PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const value = m[0];
      if (ALLOW.some((a) => a.test(value))) continue;
      const before = text.slice(Math.max(0, m.index - 200), m.index);
      if (/https?:\/\/\S*$/.test(before) || /[\w-]+:\/\/\S*$/.test(before)) continue;
      if (kind === 'high-entropy-string' && entropy(value) < 4.0) continue;
      if (kind === 'phone-ish' && !/^\+?\d[\d -]{8,}\d$/.test(value.replace(/ /g, ''))) continue;
      if (kind === 'secret-assignment' && /example|placeholder|your|xxx|\.\.\./i.test(value)) continue;
      findings.push({
        kind,
        source,
        line: lineOf(text, m.index),
        preview: value.length > 12 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value,
        length: value.length,
      });
    }
  }
  return findings;
}

export function extractMarkdownImageSrcs(markdown: string): string[] {
  const matches = [...markdown.matchAll(/!\[[^\]]*\]\((?:<)?([^)\s>]+)(?:>)?(?:\s+"[^"]*")?\)/g)].map(
    (m) => m[1],
  );
  return [...new Set(matches)];
}

export function isRemoteUrl(src: string): boolean {
  return /^https?:\/\//i.test(src);
}

export function scanSensitiveFile(markdownPath: string, alsoPaths: string[] = []): ScanSensitiveResult {
  const absMd = resolve(markdownPath);
  const mdDir = dirname(absMd);
  const mdText = readFileSync(absMd, 'utf8');

  const findings: SensitiveFinding[] = [...scanText(mdText, markdownPath)];
  for (const extra of alsoPaths) {
    findings.push(...scanText(readFileSync(resolve(extra), 'utf8'), extra));
  }

  const srcs = extractMarkdownImageSrcs(mdText);
  const resolvedImages = srcs.map((src) => ({
    src,
    is_remote: isRemoteUrl(src),
    resolved_path: isRemoteUrl(src) ? src : resolve(mdDir, src),
  }));

  return {
    findings,
    images_for_visual_review: srcs,
    resolved_images: resolvedImages,
  };
}
