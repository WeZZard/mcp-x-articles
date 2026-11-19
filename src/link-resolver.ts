import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import type { ExtractedLink } from './converter.js';
import type { PublishedXArticle } from './x-api.js';

export type LinkScriptKind = 'cjk' | 'latin' | 'mixed';

export interface LinkRewriteSuggestion {
  original_href: string;
  anchor_texts: string[];
  occurrences: number;
  is_relative: boolean;
  resolved_source_title: string | null;
  suggested_url: string;
  matched_article_id: string | null;
  matched_post_id: string;
  matched_title: string;
  matched_article_url: string | null;
  matched_post_url: string;
  match_reason: 'exact-title' | 'title-substring' | 'token-overlap' | 'slug-match';
  confidence: number;
}

export interface UnresolvedLocalLink {
  original_href: string;
  anchor_texts: string[];
  occurrences: number;
  resolved_source_title: string | null;
  reason: string;
}

export interface MatchLinksResult {
  suggestions: LinkRewriteSuggestion[];
  unresolved_local_links: UnresolvedLocalLink[];
}

const STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'to',
  'for',
  'of',
  'in',
  'on',
  'at',
  'and',
  'or',
  'my',
  'your',
  'our',
  'with',
  'how',
  'why',
  'what',
  'from',
  'by',
  'as',
  'is',
  'are',
  'this',
  'that',
  'post',
  'posts',
  'article',
  'articles',
  'blog',
  'more',
  'here',
  'read',
  'link',
  'index',
  'html',
  'md',
  'mdx',
  'http',
  'https',
  'www',
  'com',
  'org',
  'net',
  'zh',
  'hans',
  'hant',
  'en',
]);

const GENERIC_SLUG_SEGMENTS = new Set([
  'post',
  'posts',
  'article',
  'articles',
  'blog',
  'en',
  'zh',
  'zh-hans',
  'zh-hant',
  'zh-cn',
  'zh-tw',
  'index',
  'readme',
]);

export function detectTextScript(text: string): LinkScriptKind {
  const cjkMatches = text.match(/[\u4e00-\u9fff]/g);
  const cjkCount = cjkMatches ? cjkMatches.length : 0;
  if (cjkCount >= 2) return 'cjk';

  const latinMatches = text.match(/[a-zA-Z]/g);
  const latinCount = latinMatches ? latinMatches.length : 0;
  if (latinCount >= 2) return 'latin';

  return 'mixed';
}

function detectHrefScriptHint(href: string): LinkScriptKind | null {
  const lower = href.toLowerCase();
  if (/\/(?:zh-hans|zh-hant|zh-cn|zh-tw|zh)\b/.test(lower)) {
    return 'cjk';
  }
  return null;
}

function normalizeMatchText(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeCompact(text: string): string {
  return normalizeMatchText(text).replace(/\s+/g, '');
}

function extractTokenSet(text: string): { wordTokens: Set<string>; cjkBigrams: Set<string> } {
  const normalized = normalizeMatchText(text);
  const wordTokens = new Set<string>();
  const latinOrDigits = normalized.match(/[a-z0-9]+/g) ?? [];
  for (const tok of latinOrDigits) {
    if (STOPWORDS.has(tok)) continue;
    wordTokens.add(tok);
  }

  const cjkBigrams = new Set<string>();
  const cjkRuns = normalized.match(/[\u4e00-\u9fff]+/g) ?? [];
  for (const run of cjkRuns) {
    if (run.length === 1) {
      cjkBigrams.add(run);
    } else {
      for (let i = 0; i < run.length - 1; i += 1) {
        cjkBigrams.add(run.slice(i, i + 2));
      }
    }
  }

  return { wordTokens, cjkBigrams };
}

function extractSlugTokens(href: string): string[] {
  let pathname = href;
  try {
    pathname = new URL(href).pathname;
  } catch {
    pathname = href.split(/[?#]/)[0];
  }

  const rawSegments = pathname
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean);

  const tokens: string[] = [];
  for (const seg of rawSegments) {
    const cleanExt = seg.replace(/\.(?:html?|mdx?)$/i, '');
    const lower = cleanExt.toLowerCase();
    if (!lower || GENERIC_SLUG_SEGMENTS.has(lower) || /^\d{1,4}$/.test(lower)) {
      continue;
    }
    const stripped = lower
      .replace(/^\d{4}-\d{2}-\d{2}-/, '')
      .replace(/-[0-9a-f]{4,8}$/i, '');
    for (const part of stripped.split(/[-_.]+/)) {
      if (!part || STOPWORDS.has(part)) continue;
      tokens.push(part);
    }
  }
  return tokens;
}

/**
 * Resolve frontmatter `title:` or first `# H1` of a relative Markdown target referenced from `markdownPath`.
 */
export function extractLocalMarkdownTitle(markdownPath: string, relativeHref: string): string | null {
  const cleanHref = relativeHref.split(/[?#]/)[0].trim();
  if (!cleanHref) return null;

  const baseDir = dirname(resolve(markdownPath));
  const candidate = resolve(baseDir, cleanHref);

  const tryFiles: string[] = [];
  if (existsSync(candidate)) {
    try {
      const st = statSync(candidate);
      if (st.isFile()) {
        tryFiles.push(candidate);
      } else if (st.isDirectory()) {
        tryFiles.push(resolve(candidate, 'index.md'));
        tryFiles.push(resolve(candidate, 'index.mdx'));
      }
    } catch {
      return null;
    }
  } else {
    if (!extname(candidate)) {
      tryFiles.push(`${candidate}.md`, `${candidate}.mdx`);
      tryFiles.push(resolve(candidate, 'index.md'));
    }
  }

  for (const targetFile of tryFiles) {
    if (!existsSync(targetFile)) continue;
    try {
      const raw = readFileSync(targetFile, 'utf8');
      const fmMatch = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(raw);
      if (fmMatch) {
        const titleLine = /^title:\s*["']?(.*?)["']?\s*$/m.exec(fmMatch[1]);
        if (titleLine?.[1]?.trim()) {
          return titleLine[1].trim();
        }
      }
      const body = fmMatch ? raw.slice(fmMatch[0].length) : raw;
      const h1Match = /^#\s+(.+?)\s*$/m.exec(body);
      if (h1Match?.[1]?.trim()) {
        return h1Match[1].trim();
      }
    } catch {
      // Ignore unreadable targets and fall back cleanly.
    }
  }

  return null;
}

function isScriptCompatible(candidateScript: LinkScriptKind, articleScript: LinkScriptKind): boolean {
  if (candidateScript === 'mixed' || articleScript === 'mixed') return true;
  return candidateScript === articleScript;
}

interface CandidateScore {
  reason: LinkRewriteSuggestion['match_reason'];
  confidence: number;
}

function scoreCandidateAgainstArticle(options: {
  candidateText: string;
  isSlugCandidate: boolean;
  articleTitle: string;
  candidateScript: LinkScriptKind;
  articleScript: LinkScriptKind;
}): CandidateScore | null {
  if (!isScriptCompatible(options.candidateScript, options.articleScript)) {
    return null;
  }

  const candNorm = normalizeMatchText(options.candidateText);
  const artNorm = normalizeMatchText(options.articleTitle);
  const candCompact = normalizeCompact(options.candidateText);
  const artCompact = normalizeCompact(options.articleTitle);

  if (!candNorm || !artNorm) return null;

  if (!options.isSlugCandidate && (candNorm === artNorm || candCompact === artCompact)) {
    return { reason: 'exact-title', confidence: 1.0 };
  }

  if (!options.isSlugCandidate) {
    const shorter = candCompact.length <= artCompact.length ? candCompact : artCompact;
    const longer = candCompact.length <= artCompact.length ? artCompact : candCompact;
    if (shorter.length >= 6 && longer.includes(shorter)) {
      const ratio = shorter.length / longer.length;
      if (ratio >= 0.45) {
        return { reason: 'title-substring', confidence: 0.9 };
      }
    }
  }

  const candTokens = extractTokenSet(options.candidateText);
  const artTokens = extractTokenSet(options.articleTitle);

  const wordMatches = [...candTokens.wordTokens].filter((t) => artTokens.wordTokens.has(t));
  const cjkMatches = [...candTokens.cjkBigrams].filter((t) => artTokens.cjkBigrams.has(t));

  const candTotal = candTokens.wordTokens.size + candTokens.cjkBigrams.size;
  const artTotal = artTokens.wordTokens.size + artTokens.cjkBigrams.size;
  const matchedTotal = wordMatches.length + cjkMatches.length;

  if (candTotal === 0 || artTotal === 0) return null;

  const hasEnoughEvidence =
    cjkMatches.length >= 3 ||
    wordMatches.length >= 2 ||
    (matchedTotal >= 2 && candTotal >= 2 && artTotal >= 2);
  if (!hasEnoughEvidence) return null;

  const precision = matchedTotal / candTotal;
  const recall = matchedTotal / artTotal;
  const f1 = (2 * precision * recall) / (precision + recall);

  if (f1 >= 0.62) {
    const confidence = Math.min(0.88, Math.round(f1 * 100) / 100);
    return {
      reason: options.isSlugCandidate ? 'slug-match' : 'token-overlap',
      confidence,
    };
  }

  return null;
}

export function filterPublishedXArticles(
  articles: PublishedXArticle[],
  query?: string,
): PublishedXArticle[] {
  const trimmed = (query ?? '').trim();
  if (!trimmed) return articles.slice();

  const qNorm = normalizeMatchText(trimmed);
  const qCompact = normalizeCompact(trimmed);
  const qTokens = extractTokenSet(trimmed);

  return articles.filter((art) => {
    const titleNorm = normalizeMatchText(art.title);
    const titleCompact = normalizeCompact(art.title);
    const previewNorm = normalizeMatchText(art.preview_text ?? '');
    if (
      titleNorm.includes(qNorm) ||
      titleCompact.includes(qCompact) ||
      (previewNorm && previewNorm.includes(qNorm))
    ) {
      return true;
    }
    const artTokens = extractTokenSet(art.title);
    const matches =
      [...qTokens.wordTokens].filter((t) => artTokens.wordTokens.has(t)).length +
      [...qTokens.cjkBigrams].filter((t) => artTokens.cjkBigrams.has(t)).length;
    const total = qTokens.wordTokens.size + qTokens.cjkBigrams.size;
    return total > 0 && matches >= Math.min(2, total);
  });
}

/**
 * Match non-X links extracted from Markdown (including relative `.md` links and external blog URLs)
 * against the user's published X Articles, enforcing language/script isolation and conservative thresholds.
 */
export function matchLinksToPublishedArticles(options: {
  markdownPath: string;
  links: ExtractedLink[];
  publishedArticles: PublishedXArticle[];
  sourceTitle?: string;
}): MatchLinksResult {
  const grouped = new Map<
    string,
    {
      href: string;
      anchorTexts: Set<string>;
      occurrences: number;
      isRelative: boolean;
    }
  >();

  for (const link of options.links) {
    const rawHref = link.href.trim();
    if (!rawHref || link.is_x_url || /^(?:mailto:|tel:|#)/i.test(rawHref)) {
      continue;
    }
    const existing = grouped.get(rawHref);
    if (existing) {
      existing.occurrences += 1;
      if (link.text.trim()) existing.anchorTexts.add(link.text.trim());
    } else {
      const anchors = new Set<string>();
      if (link.text.trim()) anchors.add(link.text.trim());
      grouped.set(rawHref, {
        href: rawHref,
        anchorTexts: anchors,
        occurrences: 1,
        isRelative: link.is_relative,
      });
    }
  }

  const normalizedSourceTitle = options.sourceTitle ? normalizeCompact(options.sourceTitle) : '';
  const suggestions: LinkRewriteSuggestion[] = [];
  const unresolvedLocalLinks: UnresolvedLocalLink[] = [];

  for (const entry of grouped.values()) {
    const resolvedLocalTitle = entry.isRelative
      ? extractLocalMarkdownTitle(options.markdownPath, entry.href)
      : null;

    const anchorArray = [...entry.anchorTexts];
    const hrefScriptHint = detectHrefScriptHint(entry.href);
    const titleOrAnchorScript = detectTextScript(
      resolvedLocalTitle ?? anchorArray.join(' '),
    );
    const effectiveScript: LinkScriptKind =
      hrefScriptHint ??
      (titleOrAnchorScript !== 'mixed'
        ? titleOrAnchorScript
        : options.sourceTitle
          ? detectTextScript(options.sourceTitle)
          : 'mixed');

    const candidates: Array<{ text: string; isSlug: boolean }> = [];
    if (resolvedLocalTitle) {
      candidates.push({ text: resolvedLocalTitle, isSlug: false });
    }
    for (const anchor of anchorArray) {
      candidates.push({ text: anchor, isSlug: false });
    }
    const slugTokens = extractSlugTokens(entry.href);
    if (slugTokens.length > 0) {
      candidates.push({ text: slugTokens.join(' '), isSlug: true });
    }

    let best: {
      article: PublishedXArticle;
      score: CandidateScore;
    } | null = null;

    for (const article of options.publishedArticles) {
      // Avoid matching the current post onto itself when creating its first X draft.
      if (normalizedSourceTitle && normalizeCompact(article.title) === normalizedSourceTitle) {
        continue;
      }

      const articleScript = detectTextScript(article.title);
      for (const cand of candidates) {
        const res = scoreCandidateAgainstArticle({
          candidateText: cand.text,
          isSlugCandidate: cand.isSlug,
          articleTitle: article.title,
          candidateScript: effectiveScript,
          articleScript,
        });
        if (!res) continue;
        if (!best || res.confidence > best.score.confidence) {
          best = { article, score: res };
        }
      }
    }

    if (best) {
      // Prefer canonical X post URL (status/<post_id>) since X API article objects consistently populate post_url.
      const suggestedUrl = best.article.post_url || best.article.article_url || '';
      if (suggestedUrl) {
        suggestions.push({
          original_href: entry.href,
          anchor_texts: anchorArray,
          occurrences: entry.occurrences,
          is_relative: entry.isRelative,
          resolved_source_title: resolvedLocalTitle,
          suggested_url: suggestedUrl,
          matched_article_id: best.article.article_id,
          matched_post_id: best.article.post_id,
          matched_title: best.article.title,
          matched_article_url: best.article.article_url,
          matched_post_url: best.article.post_url,
          match_reason: best.score.reason,
          confidence: best.score.confidence,
        });
        continue;
      }
    }

    if (entry.isRelative) {
      unresolvedLocalLinks.push({
        original_href: entry.href,
        anchor_texts: anchorArray,
        occurrences: entry.occurrences,
        resolved_source_title: resolvedLocalTitle,
        reason:
          options.publishedArticles.length === 0
            ? 'No published X Articles found or timeline lookup unavailable; pass `link_rewrites` manually or keep external URL.'
            : 'Relative/local link does not match any published X Article on this account and will break on X Articles unless rewritten via `link_rewrites`.',
      });
    }
  }

  return { suggestions, unresolved_local_links: unresolvedLocalLinks };
}
