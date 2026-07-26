#!/usr/bin/env node
/** Tests for markdown-to-content-state: fixture assertions + live OpenAPI schema validation. */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, '..', 'scripts', 'markdown-to-content-state.mjs');

const run = (args) =>
  JSON.parse(execFileSync('node', [script, ...args], { encoding: 'utf8' }));

// --- 1. Fixture semantics -------------------------------------------------

const out = run([join(here, 'fixture.md'), '--media-map', join(here, 'media-map.json')]);
const { title, content_state: cs, pending_images, warnings } = out;

assert.equal(title, '测试标题');

// Body block 1: 这是一段正文,包含加粗和一个链接。
const p = cs.blocks[0];
assert.equal(p.type, 'unstyled');
assert.equal(p.text, '这是一段正文,包含加粗和一个链接。');
// '加粗' starts at UTF-16 offset 9 (each BMP CJK char = 1 unit), length 2.
assert.deepEqual(p.inline_style_ranges, [{ offset: 9, length: 2, style: 'bold' }]);
// '链接' at offset 14, length 2, pointing at entities[0].
assert.deepEqual(p.entity_ranges, [{ key: 0, offset: 14, length: 2 }]);
assert.equal(cs.entities[0].value.type, 'link');
assert.equal(cs.entities[0].value.data.url, 'https://example.com');

// Heading: ## -> header-one.
const h = cs.blocks.find((b) => b.type === 'header-one');
assert.equal(h.text, '小节');

// List items.
const items = cs.blocks.filter((b) => b.type === 'unordered-list-item');
assert.deepEqual(items.map((b) => b.text), ['第一项', '第二项']);

// Code fence -> atomic + markdown entity.
const code = cs.blocks.find((b) => b.type === 'atomic' && cs.entities[b.entity_ranges[0].key].value.data.markdown?.startsWith('```python'));
assert.ok(code, 'code fence should become a markdown entity');

// Table -> atomic + markdown entity containing a pipe table.
const table = cs.blocks.find((b) => b.type === 'atomic' && cs.entities[b.entity_ranges[0].key].value.data.markdown?.includes('| A | B |'));
assert.ok(table, 'table should become a markdown entity');

// Divider.
assert.ok(cs.entities.some((e) => e.value.type === 'divider'));

// Image -> media_id resolved from the media map.
const image = cs.entities.find((e) => e.value.type === 'image');
assert.equal(image.value.data.media_items[0].media_id, '9999999999');
assert.equal(image.value.data.caption, '示意图');
assert.deepEqual(pending_images, []);

// Standalone status URL -> post entity.
const post = cs.entities.find((e) => e.value.type === 'post');
assert.equal(post.value.data.post_id, '1234567890');

console.log('fixture assertions: OK');

// --- 2. Pending-image flow -------------------------------------------------

const out2 = run([join(here, 'fixture.md')]);
assert.deepEqual(out2.pending_images, ['./img/diagram.png']);
const img2 = out2.content_state.entities.find((e) => e.value.type === 'image');
assert.equal(img2.value.data.media_items[0].media_id, '');
console.log('pending-image flow: OK');

// --- 3. Live OpenAPI schema validation -------------------------------------

const spec = JSON.parse(
  execFileSync('curl', ['-s', 'https://api.twitter.com/2/openapi.json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }),
);
const schemas = spec.components.schemas;
const draftReq = schemas.ArticleCreateDraftRequest;
assert.deepEqual(draftReq.required.sort(), ['content_state', 'title']);

const blockSchema = schemas.ArticleCreateDraftContentStateBlocks;
const blockTypes = new Set(blockSchema.properties.type.enum);
const styleEnum = new Set(schemas.ArticleCreateDraftContentStateBlocksInlineStyleRanges.properties.style.enum);
const entityTypes = new Set(schemas.ArticleCreateDraftContentStateEntitiesValue.properties.type.enum);
const mutabilityEnum = new Set(schemas.ArticleCreateDraftContentStateEntitiesValue.properties.mutability.enum);
const blockProps = new Set(Object.keys(blockSchema.properties));
const reqBlockProps = new Set(blockSchema.required);

for (const b of cs.blocks) {
  assert.ok(blockTypes.has(b.type), `block type ${b.type} not in schema enum`);
  for (const k of Object.keys(b)) assert.ok(blockProps.has(k), `block property ${k} not in schema`);
  for (const k of reqBlockProps) assert.ok(k in b, `required block property ${k} missing`);
  for (const r of b.inline_style_ranges) assert.ok(styleEnum.has(r.style), `style ${r.style} not in schema enum`);
}
for (const e of cs.entities) {
  assert.ok(entityTypes.has(e.value.type), `entity type ${e.value.type} not in schema enum`);
  assert.ok(mutabilityEnum.has(e.value.mutability), `mutability ${e.value.mutability} not in schema enum`);
}
const entitySchemaProps = new Set(Object.keys(schemas.ArticleCreateDraftContentStateEntitiesValueData.properties));
for (const e of cs.entities) {
  for (const k of Object.keys(e.value.data)) assert.ok(entitySchemaProps.has(k), `entity data property ${k} not in schema`);
}
console.log('live OpenAPI schema validation: OK');

console.log('\nAll tests passed.');
