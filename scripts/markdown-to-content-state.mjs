#!/usr/bin/env node
/**
 * markdown-to-content-state — convert a Markdown file into the content_state
 * accepted by X API v2 POST /2/articles/draft (articleCreateDraft).
 *
 * Usage:
 *   node markdown-to-content-state.mjs <file.md> [--title T] [--media-map map.json] [--out out.json]
 *
 * --media-map: JSON object mapping image src -> { "media_id": "...", "media_category": "tweet_image" }.
 *              Run once without it to learn which images need uploading (output.pending_images),
 *              upload them via the X media upload endpoints, then re-run with the map.
 *
 * Output (stdout or --out): { title, content_state, pending_images, warnings }.
 *
 * All offsets/lengths are UTF-16 code units, matching JavaScript string length.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { lexer } from 'marked';

const args = process.argv.slice(2);
if (args.length === 0 || args.includes('--help')) {
  console.error('usage: node markdown-to-content-state.mjs <file.md> [--title T] [--media-map map.json] [--out out.json]');
  process.exit(args.length === 0 ? 1 : 0);
}

const file = args[0];
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const mediaMap = opt('--media-map')
  ? JSON.parse(readFileSync(opt('--media-map'), 'utf8'))
  : {};
const explicitTitle = opt('--title');
const outPath = opt('--out');

const rawMarkdown = readFileSync(file, 'utf8');

// Strip YAML frontmatter; its `title` becomes the default article title.
let frontmatterTitle = null;
let markdown = rawMarkdown;
const fmMatch = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(rawMarkdown);
if (fmMatch) {
  const t = /^title:\s*["']?(.*?)["']?\s*$/m.exec(fmMatch[1]);
  if (t) frontmatterTitle = t[1];
  markdown = rawMarkdown.slice(fmMatch[0].length);
}

const warnings = [];
const pendingImages = [];

let nextKey = 0;
const blockKey = () => (nextKey++).toString(36).padStart(5, '0');

const entities = []; // official schema: array of { key: string, value: { type, mutability, data } }

function addEntity(value) {
  const key = String(entities.length);
  entities.push({ key, value });
  return Number(key);
}

const TWEET_URL_RE = /^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/[A-Za-z0-9_]+\/status(?:es)?\/(\d+)\/?(?:\?[^\s]*)?$/;

/**
 * Walk marked inline tokens, building the block's plain text plus
 * inline_style_ranges and entity_ranges. Offsets are UTF-16 code units
 * (JS string length), which is what the X backend counts.
 */
function walkInline(tokens, state, activeStyles = []) {
  for (const tok of tokens) {
    switch (tok.type) {
      case 'text': {
        // A link token's child text; plain text.
        state.text += tok.text;
        break;
      }
      case 'escape': {
        state.text += tok.text;
        break;
      }
      case 'strong':
      case 'em':
      case 'del': {
        const style = tok.type === 'strong' ? 'bold' : tok.type === 'em' ? 'italic' : 'strikethrough';
        const start = state.text.length;
        walkInline(tok.tokens, state, activeStyles);
        const length = state.text.length - start;
        state.inlineStyleRanges.push({ offset: start, length, style });
        break;
      }
      case 'codespan': {
        // X Articles has no inline-code style; degrade to plain text.
        state.text += tok.text;
        break;
      }
      case 'link': {
        const start = state.text.length;
        walkInline(tok.tokens, state, activeStyles);
        const length = state.text.length - start;
        if (length > 0) {
          const key = addEntity({ type: 'link', mutability: 'mutable', data: { url: tok.href } });
          state.entityRanges.push({ key, offset: start, length });
        }
        break;
      }
      case 'image': {
        // CommonMark: tok.text is screen-reader alt text; tok.title is the optional visible figure caption.
        state.images.push({ src: tok.href, caption: (tok.title || '').trim() });
        break;
      }
      case 'br': {
        state.text += '\n';
        break;
      }
      default: {
        if (tok.tokens) walkInline(tok.tokens, state, activeStyles);
        else if (typeof tok.text === 'string') state.text += tok.text;
      }
    }
  }
}

/** Build inline state from marked inline tokens. */
function inlineState(tokens) {
  const state = { text: '', inlineStyleRanges: [], entityRanges: [], images: [] };
  walkInline(tokens ?? [], state);
  return state;
}

const blocks = [];
let title = explicitTitle ?? frontmatterTitle ?? null;
let h1Seen = false;

function pushTextBlock(type, tokens) {
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

function pushAtomicBlock(entityValue, caption) {
  const key = addEntity(entityValue);
  blocks.push({
    key: blockKey(),
    text: ' ',
    type: 'atomic',
    inline_style_ranges: [],
    entity_ranges: [{ key, offset: 0, length: 1 }],
  });
}

function pushImageBlock({ src, caption }) {
  const media = mediaMap[src];
  if (!media) {
    pendingImages.push(src);
  }
  const data = {
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

function pushMarkdownBlock(rawMarkdown) {
  pushAtomicBlock({ type: 'markdown', mutability: 'mutable', data: { markdown: rawMarkdown.trim() } });
}

function flushParagraph(tokens) {
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

function walkList(listToken) {
  for (const item of listToken.items) {
    // marked task lists: strip the checkbox marker from the first text token.
    if (item.task) warnings.push('task-list: checkbox marker dropped; item rendered as a plain list item.');
    for (const child of item.tokens) {
      if (child.type === 'text' || child.type === 'paragraph') {
        pushTextBlock(listToken.ordered ? 'ordered-list-item' : 'unordered-list-item', child.tokens);
      } else if (child.type === 'list') {
        warnings.push('nested-list: nested list items flattened to one level.');
        walkList(child);
      } else if (child.type === 'blockquote') {
        walkBlock(child);
      } else {
        walkBlock(child);
      }
    }
  }
}

function walkBlock(tok) {
  switch (tok.type) {
    case 'heading': {
      if (tok.depth === 1 && !h1Seen) {
        h1Seen = true;
        title = explicitTitle ?? frontmatterTitle ?? inlineState(tok.tokens).text.trim();
        return;
      }
      const clamped = Math.min(Math.max(tok.depth - 1, 1), 3);
      if (tok.depth > 4) warnings.push(`heading-depth: h${tok.depth} clamped to header-three.`);
      pushTextBlock(`header-${['one', 'two', 'three'][clamped - 1]}`, tok.tokens);
      return;
    }
    case 'paragraph':
      flushParagraph(tok.tokens);
      return;
    case 'text':
      flushParagraph(tok.tokens);
      return;
    case 'blockquote': {
      for (const child of tok.tokens) {
        if (child.type === 'paragraph' || child.type === 'text') {
          pushTextBlock('blockquote', child.tokens);
        } else {
          walkBlock(child);
        }
      }
      return;
    }
    case 'list':
      walkList(tok);
      return;
    case 'code':
      pushMarkdownBlock(tok.raw);
      return;
    case 'table':
      pushMarkdownBlock(tok.raw);
      return;
    case 'hr':
      pushAtomicBlock({ type: 'divider', mutability: 'immutable', data: {} });
      return;
    case 'html':
      warnings.push('html-block: raw HTML block discarded (content loss).');
      return;
    case 'space':
      return;
    default:
      if (tok.tokens) flushParagraph(tok.tokens);
      else warnings.push(`unsupported token type "${tok.type}" skipped.`);
  }
}

for (const tok of lexer(markdown)) walkBlock(tok);

if (title === null) {
  title = basename(file).replace(/\.mdx?$/i, '');
  warnings.push('title: no H1 found and no --title given; fell back to the file name.');
}
if (blocks.length === 0) {
  console.error('error: empty document — X requires a non-empty article body.');
  process.exit(1);
}

const output = {
  title,
  content_state: { blocks, entities },
  pending_images: [...new Set(pendingImages)],
  warnings: [...new Set(warnings)],
};

const json = JSON.stringify(output, null, 2);
if (outPath) writeFileSync(outPath, json + '\n');
else console.log(json);
