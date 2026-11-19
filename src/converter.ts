import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { lexer, type Token, type Tokens } from 'marked';

export interface MediaMapEntry {
  media_id: string;
  media_category?: string;
}

export type MediaMap = Record<string, MediaMapEntry>;

export interface InlineStyleRange {
  offset: number;
  length: number;
  style: 'bold' | 'italic' | 'strikethrough';
}

export interface EntityRange {
  key: number;
  offset: number;
  length: number;
}

export interface ContentStateBlock {
  key: string;
  text: string;
  type: string;
  inline_style_ranges: InlineStyleRange[];
  entity_ranges: EntityRange[];
}

export interface ContentStateEntityValue {
  type: 'link' | 'image' | 'markdown' | 'post' | 'divider';
  mutability: 'mutable' | 'immutable';
  data: Record<string, unknown>;
}

export interface ContentStateEntity {
  key: string;
  value: ContentStateEntityValue;
}

export interface ContentState {
  blocks: ContentStateBlock[];
  entities: ContentStateEntity[];
}

export interface ExtractedLink {
  href: string;
  text: string;
  is_relative: boolean;
  is_x_url: boolean;
}

export interface ConversionResult {
  title: string;
  content_state: ContentState;
  pending_images: string[];
  links: ExtractedLink[];
  warnings: string[];
}

export interface ConvertOptions {
  explicitTitle?: string;
  mediaMap?: MediaMap;
  linkRewrites?: Record<string, string>;
  fallbackFilename?: string;
}

const TWEET_URL_RE =
  /^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/[A-Za-z0-9_]+\/status(?:es)?\/(\d+)\/?(?:\?[^\s]*)?$/;

interface InlineWalkState {
  text: string;
  inlineStyleRanges: InlineStyleRange[];
  entityRanges: EntityRange[];
  images: Array<{ src: string; caption: string }>;
}

export function markdownToContentState(rawMarkdown: string, options: ConvertOptions = {}): ConversionResult {
  const mediaMap = options.mediaMap ?? {};
  const explicitTitle = options.explicitTitle?.trim() ? options.explicitTitle.trim() : undefined;

  let frontmatterTitle: string | null = null;
  let markdown = rawMarkdown;
  const fmMatch = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(rawMarkdown);
  if (fmMatch) {
    const t = /^title:\s*["']?(.*?)["']?\s*$/m.exec(fmMatch[1]);
    if (t) frontmatterTitle = t[1];
    markdown = rawMarkdown.slice(fmMatch[0].length);
  }

  const warnings: string[] = [];
  const pendingImages: string[] = [];
  const links: ExtractedLink[] = [];
  const entities: ContentStateEntity[] = [];
  const blocks: ContentStateBlock[] = [];

  let nextKey = 0;
  const blockKey = (): string => (nextKey++).toString(36).padStart(5, '0');

  function addEntity(value: ContentStateEntityValue): number {
    const key = String(entities.length);
    entities.push({ key, value });
    return Number(key);
  }

  function walkInline(tokens: Token[], state: InlineWalkState): void {
    for (const tok of tokens) {
      switch (tok.type) {
        case 'text': {
          state.text += (tok as Tokens.Text).text;
          break;
        }
        case 'escape': {
          state.text += (tok as Tokens.Escape).text;
          break;
        }
        case 'strong':
        case 'em':
        case 'del': {
          const style: InlineStyleRange['style'] =
            tok.type === 'strong' ? 'bold' : tok.type === 'em' ? 'italic' : 'strikethrough';
          const start = state.text.length;
          const subTokens = (tok as Tokens.Strong | Tokens.Em | Tokens.Del).tokens ?? [];
          walkInline(subTokens, state);
          const length = state.text.length - start;
          state.inlineStyleRanges.push({ offset: start, length, style });
          break;
        }
        case 'codespan': {
          state.text += (tok as Tokens.Codespan).text;
          break;
        }
        case 'link': {
          const linkTok = tok as Tokens.Link;
          const start = state.text.length;
          walkInline(linkTok.tokens ?? [], state);
          const length = state.text.length - start;
          const anchorText = state.text.slice(start);
          const rawHref = linkTok.href;
          const isXUrl = /^https?:\/\/(?:www\.)?(?:x|twitter)\.com\//i.test(rawHref);
          const isRelative = !/^(?:https?:|mailto:|tel:|#)/i.test(rawHref);
          links.push({
            href: rawHref,
            text: anchorText,
            is_relative: isRelative,
            is_x_url: isXUrl,
          });
          const rewritten = options.linkRewrites?.[rawHref];
          const targetUrl = rewritten ?? rawHref;
          if (isRelative && !rewritten) {
            warnings.push(
              `relative-link: "${rawHref}" is a local/relative link and will break on X Articles unless rewritten via link_rewrites.`,
            );
          }
          if (length > 0) {
            const key = addEntity({ type: 'link', mutability: 'mutable', data: { url: targetUrl } });
            state.entityRanges.push({ key, offset: start, length });
          }
          break;
        }
        case 'image': {
          const imgTok = tok as Tokens.Image;
          state.images.push({ src: imgTok.href, caption: (imgTok.title || '').trim() });
          break;
        }
        case 'br': {
          state.text += '\n';
          break;
        }
        default: {
          const anyTok = tok as { tokens?: Token[]; text?: string };
          if (Array.isArray(anyTok.tokens)) walkInline(anyTok.tokens, state);
          else if (typeof anyTok.text === 'string') state.text += anyTok.text;
        }
      }
    }
  }

  function inlineState(tokens?: Token[]): InlineWalkState {
    const state: InlineWalkState = {
      text: '',
      inlineStyleRanges: [],
      entityRanges: [],
      images: [],
    };
    walkInline(tokens ?? [], state);
    return state;
  }

  let title: string | null = explicitTitle ?? frontmatterTitle ?? null;
  let h1Seen = false;

  function pushAtomicBlock(entityValue: ContentStateEntityValue): void {
    const key = addEntity(entityValue);
    blocks.push({
      key: blockKey(),
      text: ' ',
      type: 'atomic',
      inline_style_ranges: [],
      entity_ranges: [{ key, offset: 0, length: 1 }],
    });
  }

  function pushImageBlock({ src, caption }: { src: string; caption: string }): void {
    const media = mediaMap[src];
    if (!media) {
      pendingImages.push(src);
    }
    const data: Record<string, unknown> = {
      media_items: [
        {
          media_category: media?.media_category ?? 'tweet_image',
          media_id: media?.media_id ?? '',
        },
      ],
    };
    if (caption) data.caption = caption;
    pushAtomicBlock({ type: 'image', mutability: 'immutable', data });
  }

  function pushTextBlock(type: string, tokens?: Token[]): void {
    const state = inlineState(tokens);
    if (state.text.length > 0 || state.images.length === 0) {
      blocks.push({
        key: blockKey(),
        text: state.text,
        type,
        inline_style_ranges: state.inlineStyleRanges,
        entity_ranges: state.entityRanges,
      });
    }
    for (const img of state.images) pushImageBlock(img);
  }

  function pushMarkdownBlock(raw: string): void {
    pushAtomicBlock({ type: 'markdown', mutability: 'mutable', data: { markdown: raw.trim() } });
  }

  function flushParagraph(tokens?: Token[]): void {
    const state = inlineState(tokens);
    const tweetMatch = state.images.length === 0 ? TWEET_URL_RE.exec(state.text.trim()) : null;
    if (tweetMatch) {
      pushAtomicBlock({ type: 'post', mutability: 'immutable', data: { post_id: tweetMatch[1] } });
      return;
    }
    if (state.text.trim().length === 0 && state.images.length === 0) return;
    if (state.text.trim().length > 0) {
      blocks.push({
        key: blockKey(),
        text: state.text,
        type: 'unstyled',
        inline_style_ranges: state.inlineStyleRanges,
        entity_ranges: state.entityRanges,
      });
    }
    for (const img of state.images) pushImageBlock(img);
  }

  function walkList(listToken: Tokens.List): void {
    for (const item of listToken.items) {
      if (item.task) {
        warnings.push('task-list: checkbox marker dropped; item rendered as a plain list item.');
      }
      for (const child of item.tokens) {
        if (child.type === 'text' || child.type === 'paragraph') {
          const childWithTokens = child as { tokens?: Token[] };
          pushTextBlock(
            listToken.ordered ? 'ordered-list-item' : 'unordered-list-item',
            childWithTokens.tokens,
          );
        } else if (child.type === 'list') {
          warnings.push('nested-list: nested list items flattened to one level.');
          walkList(child as Tokens.List);
        } else {
          walkBlock(child);
        }
      }
    }
  }

  function walkBlock(tok: Token): void {
    switch (tok.type) {
      case 'heading': {
        const hTok = tok as Tokens.Heading;
        if (hTok.depth === 1 && !h1Seen) {
          h1Seen = true;
          title = explicitTitle ?? frontmatterTitle ?? inlineState(hTok.tokens).text.trim();
          return;
        }
        const clamped = Math.min(Math.max(hTok.depth - 1, 1), 2);
        if (hTok.depth > 3) warnings.push(`heading-depth: h${hTok.depth} clamped to header-two.`);
        pushTextBlock(`header-${['one', 'two'][clamped - 1]}`, hTok.tokens);
        return;
      }
      case 'paragraph':
      case 'text': {
        flushParagraph((tok as { tokens?: Token[] }).tokens);
        return;
      }
      case 'blockquote': {
        const bq = tok as Tokens.Blockquote;
        for (const child of bq.tokens) {
          if (child.type === 'paragraph' || child.type === 'text') {
            pushTextBlock('blockquote', (child as { tokens?: Token[] }).tokens);
          } else {
            walkBlock(child);
          }
        }
        return;
      }
      case 'list':
        walkList(tok as Tokens.List);
        return;
      case 'code':
        pushMarkdownBlock((tok as Tokens.Code).raw);
        return;
      case 'table':
        pushMarkdownBlock((tok as Tokens.Table).raw);
        return;
      case 'hr':
        pushAtomicBlock({ type: 'divider', mutability: 'immutable', data: {} });
        return;
      case 'html':
        warnings.push('html-block: raw HTML block discarded (content loss).');
        return;
      case 'space':
        return;
      default: {
        const anyTok = tok as { tokens?: Token[] };
        if (Array.isArray(anyTok.tokens)) flushParagraph(anyTok.tokens);
        else warnings.push(`unsupported token type "${tok.type}" skipped.`);
      }
    }
  }

  for (const tok of lexer(markdown)) walkBlock(tok);

  if (title === null || title.length === 0) {
    const base = options.fallbackFilename ?? 'untitled';
    title = basename(base).replace(/\.mdx?$/i, '') || 'untitled';
    warnings.push('title: no H1 found and no --title given; fell back to the file name.');
  }

  if (blocks.length === 0) {
    throw new Error('Empty document: X requires a non-empty article body.');
  }

  return {
    title,
    content_state: { blocks, entities },
    pending_images: [...new Set(pendingImages)],
    links,
    warnings: [...new Set(warnings)],
  };
}

export function convertMarkdownFile(
  markdownPath: string,
  options: Omit<ConvertOptions, 'fallbackFilename'> = {},
): ConversionResult {
  const raw = readFileSync(markdownPath, 'utf8');
  return markdownToContentState(raw, {
    ...options,
    fallbackFilename: markdownPath,
  });
}
