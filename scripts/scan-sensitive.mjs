#!/usr/bin/env node
/**
 * scan-sensitive — deterministic sensitive-information scan for a Markdown file
 * before it becomes an X Article.
 *
 * Usage: node scan-sensitive.mjs <file.md> [--also <path> ...]
 *
 * Scans the Markdown text (and any --also files) for:
 *   - known token shapes (X bearer, GitHub, AWS, JWT, OAuth-ish assignments)
 *   - high-entropy long strings (possible keys)
 *   - email addresses, phone-ish numbers
 *   - non-public URLs (localhost is fine in docs, flagged for review)
 *
 * Exit code 0 = clean, 1 = findings. Findings go to stdout as JSON.
 * Image CONTENT cannot be scanned deterministically — the skill's pre-flight
 * has the agent review each image visually; this script only lists which
 * images need that review (output.images_for_visual_review).
 */

import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('usage: node scan-sensitive.mjs <file.md> [--also <path> ...]');
  process.exit(2);
}
const file = args[0];
const also = [];
for (let i = 1; i < args.length; i++) if (args[i] === '--also' && args[i + 1]) also.push(args[++i]);

const PATTERNS = [
  { kind: 'x-bearer-token', re: /AAAAAA[A-Za-z0-9%]{20,}/g },
  { kind: 'github-token', re: /\b(ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/g },
  { kind: 'aws-access-key', re: /\b(AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { kind: 'secret-assignment', re: /\b(api[_-]?key|secret|token|password|passwd|bearer)\b\s*[:=]\s*["']?[A-Za-z0-9+/_.%=-]{16,}["']?/gi },
  { kind: 'email', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { kind: 'phone-ish', re: /(?<!\d)(?:\+?\d[\d -]{7,14}\d)(?!\d)/g },
  { kind: 'high-entropy-string', re: /\b[A-Za-z0-9+/=_%-]{40,}\b/g },
];

// Allow-listed shapes that look sensitive but are normal in tutorials.
const ALLOW = [
  /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?/, // loopback URLs in docs
  /^[0-9]{15,}$/, // X snowflake IDs (public)
  /^\d{4}-\d{2}-\d{2}/, // dates
  /^x\.com|^twitter\.com|^github\.com|^docs\.x\.com|^console\.x\.com/i,
];

function entropy(s) {
  const freq = {};
  for (const c of s) freq[c] = (freq[c] || 0) + 1;
  return -Object.values(freq).reduce((h, n) => {
    const p = n / s.length;
    return h + p * Math.log2(p);
  }, 0);
}

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length;
}

function scan(text, source) {
  const findings = [];
  for (const { kind, re } of PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      const value = m[0];
      if (ALLOW.some((a) => a.test(value))) continue;
      // Skip anything inside a URL (status IDs, tracking params, etc.).
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

const findings = [];
const targets = [file, ...also];
for (const t of targets) {
  findings.push(...scan(readFileSync(t, 'utf8'), t));
}

const md = readFileSync(file, 'utf8');
const images = [...md.matchAll(/!\[[^\]]*\]\((?:<)?([^)\s>]+)(?:>)?(?:\s+"[^"]*")?\)/g)].map((m) => m[1]);

const out = { findings, images_for_visual_review: images };
console.log(JSON.stringify(out, null, 2));
process.exit(findings.length > 0 ? 1 : 0);
