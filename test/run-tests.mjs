#!/usr/bin/env node
/**
 * Comprehensive test suite for @wezzard/mcp-x-articles:
 * 1. Fixture AST & UTF-16 offset semantics
 * 2. Pending-image discovery
 * 3. Live X OpenAPI v2 schema validation
 * 4. X API Playground contract test (when running locally)
 * 5. Sensitive-information scanner assertions
 * 6. OAuth 1.0a RFC 5849 HMAC-SHA1 signing & 0600 credential fallback
 * 7. End-to-end MCP stdio server protocol & mock X API v2 pipeline test
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const serverBundlePath = join(root, 'dist', 'server.mjs');

const {
  convertMarkdownFile,
  markdownToContentState,
  scanSensitiveFile,
  signOAuth1Header,
  runInteractiveSetupAndOAuth1Flow,
  saveConsumerCredentials,
  loadConsumerCredentials,
  clearConsumerCredentials,
  saveUserOAuthTokens,
  loadUserOAuthTokens,
  clearUserOAuthTokens,
} = await import(serverBundlePath);

const mediaMap = JSON.parse(readFileSync(join(here, 'media-map.json'), 'utf8'));
const fixturePath = join(here, 'fixture.md');

// --- 1. Fixture semantics -------------------------------------------------

const out = convertMarkdownFile(fixturePath, { mediaMap });
const { title, content_state: cs, pending_images } = out;

assert.equal(title, '测试标题');

const p = cs.blocks[0];
assert.equal(p.type, 'unstyled');
assert.equal(p.text, '这是一段正文,包含加粗和一个链接。');
assert.deepEqual(p.inline_style_ranges, [{ offset: 9, length: 2, style: 'bold' }]);
assert.deepEqual(p.entity_ranges, [{ key: 0, offset: 14, length: 2 }]);
assert.equal(cs.entities[0].value.type, 'link');
assert.equal(cs.entities[0].value.data.url, 'https://example.com');

const h = cs.blocks.find((b) => b.type === 'header-one');
assert.equal(h.text, '小节');

// Verify h4+ clamps to header-two (X Articles only support two heading levels).
const hClamp = markdownToContentState('# Title\n\n#### Deep Section\n\nBody.');
assert.equal(hClamp.content_state.blocks[0].type, 'header-two');
assert.ok(hClamp.warnings.includes('heading-depth: h4 clamped to header-two.'));

const items = cs.blocks.filter((b) => b.type === 'unordered-list-item');
assert.deepEqual(
  items.map((b) => b.text),
  ['第一项', '第二项'],
);

const code = cs.blocks.find(
  (b) => b.type === 'atomic' && cs.entities[b.entity_ranges[0].key].value.data.markdown?.startsWith('```python'),
);
assert.ok(code, 'code fence should become a markdown entity');

const table = cs.blocks.find(
  (b) => b.type === 'atomic' && cs.entities[b.entity_ranges[0].key].value.data.markdown?.includes('| A | B |'),
);
assert.ok(table, 'table should become a markdown entity');

assert.ok(cs.entities.some((e) => e.value.type === 'divider'));

const imageEntities = cs.entities.filter((e) => e.value.type === 'image');
assert.equal(imageEntities.length, 2);
assert.equal(imageEntities[0].value.data.media_items[0].media_id, '9999999999');
assert.equal(imageEntities[0].value.data.caption, '示意图');
assert.equal(imageEntities[1].value.data.media_items[0].media_id, '8888888888');
assert.equal(imageEntities[1].value.data.caption, undefined);
assert.deepEqual(pending_images, []);

const post = cs.entities.find((e) => e.value.type === 'post');
assert.equal(post.value.data.post_id, '1234567890');

console.log('fixture assertions: OK');

// --- 2. Pending-image flow -------------------------------------------------

const out2 = convertMarkdownFile(fixturePath);
assert.deepEqual(out2.pending_images, ['./img/diagram.png', './img/no-caption.png']);
const img2 = out2.content_state.entities.find((e) => e.value.type === 'image');
assert.equal(img2.value.data.media_items[0].media_id, '');
console.log('pending-image flow: OK');

// --- 3. Live OpenAPI schema validation -------------------------------------

const spec = JSON.parse(
  execFileSync('curl', ['-s', 'https://api.twitter.com/2/openapi.json'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  }),
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
  for (const k of Object.keys(e.value.data)) {
    assert.ok(entitySchemaProps.has(k), `entity data property ${k} not in schema`);
  }
}
console.log('live OpenAPI schema validation: OK');

// --- 4. Playground contract test (skipped if playground is not running) ----

const PLAYGROUND = process.env.PLAYGROUND_URL ?? 'http://127.0.0.1:8791';
const OAUTH1 =
  'OAuth oauth_consumer_key="t",oauth_token="t",oauth_signature_method="HMAC-SHA1",oauth_timestamp="1",oauth_nonce="n",oauth_version="1.0",oauth_signature="s"';

async function postDraft(body) {
  const res = await fetch(`${PLAYGROUND}/2/articles/draft`, {
    method: 'POST',
    headers: { Authorization: OAUTH1, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

const reachable = await fetch(`${PLAYGROUND}/health`)
  .then((r) => r.ok)
  .catch(() => false);
if (!reachable) {
  console.log(`playground contract test: SKIPPED (no playground at ${PLAYGROUND})`);
} else {
  const req = { title: out.title, content_state: out.content_state };
  const ok = await postDraft(req);
  assert.equal(ok.status, 200, `playground rejected converter output: ${JSON.stringify(ok.body)}`);

  const missing = await postDraft({ title: 'x' });
  assert.equal(missing.status, 400);
  const badType = await postDraft({
    title: 'x',
    content_state: { blocks: [{ text: 'x', type: 'not-a-real-type' }], entities: [] },
  });
  assert.equal(badType.status, 400);

  const pub = await fetch(`${PLAYGROUND}/2/articles/1234567890/publish`, {
    method: 'POST',
    headers: { Authorization: OAUTH1 },
  });
  const pubBody = await pub.json();
  assert.equal(pub.status, 200);
  assert.ok(pubBody.data?.post_id, 'publish response should carry data.post_id');
  console.log('playground contract test: OK');
}

// --- 5. Sensitive scanner --------------------------------------------------

const clean = scanSensitiveFile(fixturePath);
assert.deepEqual(clean.findings, []);
assert.deepEqual(clean.images_for_visual_review, ['./img/diagram.png', './img/no-caption.png']);

const tempDir = mkdtempSync(join(tmpdir(), 'xa-test-'));
try {
  const dirtyPath = join(tempDir, 'dirty.md');
  writeFileSync(
    dirtyPath,
    [
      '# t',
      'token: ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      'mail me at bob@example.com',
      'key = "mK9xQ2vL8nP4rT6yU1wE3sD5fG7hJ9kL0zX2cV4bN6mQ8"',
      'callback: http://127.0.0.1:8976/oauth/callback',
      'post id 2081215845620236345',
    ].join('\n'),
  );
  const dirty = scanSensitiveFile(dirtyPath);
  const kinds = dirty.findings.map((f) => f.kind);
  assert.ok(kinds.includes('github-token'), 'github-token missed');
  assert.ok(kinds.includes('email'), 'email missed');
  assert.ok(kinds.includes('high-entropy-string') || kinds.includes('secret-assignment'), 'secret string missed');
  assert.ok(!dirty.findings.some((f) => f.preview.includes('127.0.0.1')), 'loopback must be allow-listed');
  assert.ok(
    !dirty.findings.some((f) => f.preview.includes('2081215845620236345')),
    'snowflake IDs must be allow-listed',
  );
  console.log('scan-sensitive tests: OK');

  // --- 6. OAuth 1.0a signing & isolated 0600 XDG fallback ------------------

  const authHeader = signOAuth1Header({
    method: 'GET',
    url: 'https://api.x.com/2/media/upload?media_id=999&command=STATUS',
    credentials: {
      consumerKey: 'xvz1evFS4wEEPTGEFPHBog',
      consumerSecret: 'kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw',
      tokenKey: '370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb',
      tokenSecret: 'LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE',
    },
    nonce: 'kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg',
    timestamp: '1318622958',
  });
  assert.ok(authHeader.startsWith('OAuth '));
  assert.ok(authHeader.includes('oauth_signature='));

  const prevXdg = process.env.XDG_CONFIG_HOME;
  const prevDisableKc = process.env.MCP_X_ARTICLES_DISABLE_KEYCHAIN;
  const prevKey = process.env.X_OAUTH_CONSUMER_KEY;
  const prevSec = process.env.X_OAUTH_CONSUMER_SECRET;
  try {
    const xdgDir = join(tempDir, 'xdg');
    process.env.XDG_CONFIG_HOME = xdgDir;
    process.env.MCP_X_ARTICLES_DISABLE_KEYCHAIN = '1';
    // Verify unexpanded Antigravity template placeholders fall through cleanly!
    process.env.X_OAUTH_CONSUMER_KEY = '${X_OAUTH_CONSUMER_KEY}';
    process.env.X_OAUTH_CONSUMER_SECRET = '${X_OAUTH_CONSUMER_SECRET}';

    const savedSrc = saveConsumerCredentials({
      consumerKey: 'ck_test_1',
      consumerSecret: 'cs_test_1',
    });
    assert.equal(savedSrc, 'xdg-config');
    const loadedCreds = loadConsumerCredentials();
    assert.equal(loadedCreds.source, 'xdg-config');
    assert.equal(loadedCreds.credentials.consumerKey, 'ck_test_1');

    saveUserOAuthTokens('ck_test_1', 'at_test_1', 'as_test_1');
    const loadedTok = loadUserOAuthTokens('ck_test_1');
    assert.equal(loadedTok.source, 'xdg-config');
    assert.equal(loadedTok.tokens.accessToken, 'at_test_1');

    const credStat = statSync(join(xdgDir, 'mcp-x-articles', 'credentials.json'));
    assert.equal(credStat.mode & 0o777, 0o600, 'credentials.json must have mode 0600');
  } finally {
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    if (prevDisableKc === undefined) delete process.env.MCP_X_ARTICLES_DISABLE_KEYCHAIN;
    else process.env.MCP_X_ARTICLES_DISABLE_KEYCHAIN = prevDisableKc;
    if (prevKey === undefined) delete process.env.X_OAUTH_CONSUMER_KEY;
    else process.env.X_OAUTH_CONSUMER_KEY = prevKey;
    if (prevSec === undefined) delete process.env.X_OAUTH_CONSUMER_SECRET;
    else process.env.X_OAUTH_CONSUMER_SECRET = prevSec;
  }
  console.log('oauth1 & 0600 credential fallback tests: OK');

  if (process.platform === 'darwin') {
    const prevKcSvc = process.env.MCP_X_ARTICLES_KEYCHAIN_SERVICE;
    const prevDisableKc2 = process.env.MCP_X_ARTICLES_DISABLE_KEYCHAIN;
    const prevKey2 = process.env.X_OAUTH_CONSUMER_KEY;
    const prevSec2 = process.env.X_OAUTH_CONSUMER_SECRET;
    process.env.MCP_X_ARTICLES_KEYCHAIN_SERVICE = `@wezzard/mcp-x-articles-test-${process.pid}`;
    delete process.env.MCP_X_ARTICLES_DISABLE_KEYCHAIN;
    delete process.env.X_OAUTH_CONSUMER_KEY;
    delete process.env.X_OAUTH_CONSUMER_SECRET;
    try {
      const kcSource = saveConsumerCredentials({
        consumerKey: 'kc_ck_live_test',
        consumerSecret: 'kc_cs_live_test',
      });
      if (kcSource === 'macos-keychain') {
        const readBack = loadConsumerCredentials();
        assert.equal(readBack.source, 'macos-keychain');
        assert.equal(readBack.credentials.consumerKey, 'kc_ck_live_test');

        const tokSource = saveUserOAuthTokens('kc_ck_live_test', 'kc_at_live', 'kc_as_live');
        assert.equal(tokSource, 'macos-keychain');
        const readTok = loadUserOAuthTokens('kc_ck_live_test');
        assert.equal(readTok.source, 'macos-keychain');
        assert.equal(readTok.tokens.accessToken, 'kc_at_live');
        console.log('macos keychain roundtrip test: OK');
      } else {
        console.log('macos keychain roundtrip test: SKIPPED (keychain locked/unavailable)');
      }
    } finally {
      clearUserOAuthTokens('kc_ck_live_test');
      clearConsumerCredentials();
      if (prevKcSvc === undefined) delete process.env.MCP_X_ARTICLES_KEYCHAIN_SERVICE;
      else process.env.MCP_X_ARTICLES_KEYCHAIN_SERVICE = prevKcSvc;
      if (prevDisableKc2 === undefined) delete process.env.MCP_X_ARTICLES_DISABLE_KEYCHAIN;
      else process.env.MCP_X_ARTICLES_DISABLE_KEYCHAIN = prevDisableKc2;
      if (prevKey2 === undefined) delete process.env.X_OAUTH_CONSUMER_KEY;
      else process.env.X_OAUTH_CONSUMER_KEY = prevKey2;
      if (prevSec2 === undefined) delete process.env.X_OAUTH_CONSUMER_SECRET;
      else process.env.X_OAUTH_CONSUMER_SECRET = prevSec2;
    }
  }

  // --- 7. End-to-end MCP stdio server + mock X API v2 pipeline -------------

  let nextMediaId = 5000000001;
  const recordedRequests = [];
  let statusChecks = 0;

  const mockApiServer = createServer(async (req, res) => {
    const chunks = [];
    for await (const ch of req) chunks.push(ch);
    const bodyText = Buffer.concat(chunks).toString('utf8');
    const parsedBody = bodyText ? JSON.parse(bodyText) : null;
    recordedRequests.push({
      method: req.method,
      url: req.url,
      auth: req.headers.authorization,
      body: parsedBody,
    });

    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'GET' && req.url === '/2/users/me') {
      res.end(JSON.stringify({ data: { id: '42', username: 'mockwriter', name: 'Mock Writer' } }));
      return;
    }
    if (req.method === 'POST' && req.url === '/2/media/upload/initialize') {
      const id = String(nextMediaId++);
      res.end(JSON.stringify({ data: { id } }));
      return;
    }
    if (req.method === 'POST' && /^\/2\/media\/upload\/\d+\/append$/.test(req.url)) {
      res.end(JSON.stringify({ data: {} }));
      return;
    }
    if (req.method === 'POST' && /^\/2\/media\/upload\/\d+\/finalize$/.test(req.url)) {
      // Exercise async processing_info status polling on the first media item!
      if (statusChecks === 0) {
        statusChecks += 1;
        res.end(
          JSON.stringify({
            data: { id: '5000000001', processing_info: { state: 'in_progress', check_after_secs: 1 } },
          }),
        );
        return;
      }
      res.end(JSON.stringify({ data: { processing_info: { state: 'succeeded' } } }));
      return;
    }
    if (req.method === 'GET' && req.url.startsWith('/2/media/upload?')) {
      res.end(JSON.stringify({ data: { processing_info: { state: 'succeeded' } } }));
      return;
    }
    if (req.method === 'POST' && req.url === '/2/articles/draft') {
      res.end(JSON.stringify({ data: { id: '777777777777777777' } }));
      return;
    }
    if (req.method === 'POST' && req.url === '/2/articles/777777777777777777/publish') {
      res.end(JSON.stringify({ data: { post_id: '888888888888888888' } }));
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ error: `Unhandled route ${req.method} ${req.url}` }));
  });

  await new Promise((resolveListen) => mockApiServer.listen(0, '127.0.0.1', resolveListen));
  const mockPort = mockApiServer.address().port;

  // Create a sample post directory with an inline PNG and an auto-detected sibling cover image.
  const postDir = join(tempDir, 'sample-post');
  execFileSync('mkdir', ['-p', postDir]);
  // Minimal valid 1x1 PNG
  const onePixelPng = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  );
  writeFileSync(join(postDir, 'inline.png'), onePixelPng);
  writeFileSync(join(postDir, 'cover-image-x-article.png'), onePixelPng);
  const postMdPath = join(postDir, 'index.md');
  writeFileSync(
    postMdPath,
    [
      '# End-to-End MCP Test Title',
      '',
      'Body paragraph with **bold** text.',
      '',
      '![Screen reader description](./inline.png "Figure 1")',
    ].join('\n'),
  );

  const transport = new StdioClientTransport({
    command: 'node',
    args: [serverBundlePath],
    env: {
      ...process.env,
      X_API_BASE_URL: `http://127.0.0.1:${mockPort}`,
      X_OAUTH_CONSUMER_KEY: 'mock_ck',
      X_OAUTH_CONSUMER_SECRET: 'mock_cs',
      X_OAUTH_ACCESS_TOKEN: 'mock_at',
      X_OAUTH_ACCESS_TOKEN_SECRET: 'mock_as',
      MCP_X_ARTICLES_DISABLE_KEYCHAIN: '1',
    },
    stderr: 'pipe',
  });
  const mcpClient = new Client({ name: 'e2e-test-client', version: '1.0.0' });

  try {
    await mcpClient.connect(transport);

    // Check server instructions and flat tool schemas + annotations.
    const instructions = mcpClient.getInstructions();
    assert.ok(instructions?.includes('x_article_preflight'));

    const { tools } = await mcpClient.listTools();
    assert.equal(tools.length, 4);
    for (const tool of tools) {
      assert.equal(tool.inputSchema.type, 'object');
      assert.equal(tool.inputSchema.anyOf, undefined);
      assert.equal(tool.inputSchema.oneOf, undefined);
    }
    const pubTool = tools.find((t) => t.name === 'x_article_publish');
    assert.equal(pubTool.annotations?.destructiveHint, true);
    assert.equal(pubTool.annotations?.idempotentHint, false);

    // 7a. Gate 1 rejects create_draft without a valid preflight_token.
    const rejected = await mcpClient.callTool({
      name: 'x_article_create_draft',
      arguments: {
        markdown_path: postMdPath,
        preflight_token: 'sha256:v1:0000000000000000000000000000000000000000000000000000000000000000',
      },
    });
    assert.equal(rejected.isError, true);
    assert.equal(recordedRequests.length, 0, 'No X API requests may fire when preflight_token is invalid');

    // 7b. Run preflight -> verify token, auto-detected cover, and MCP image blocks.
    const preflightRes = await mcpClient.callTool({
      name: 'x_article_preflight',
      arguments: { markdown_path: postMdPath },
    });
    assert.ok(!preflightRes.isError);
    const preflightJson = JSON.parse(preflightRes.content[0].text);
    assert.equal(preflightJson.resolved_title, 'End-to-End MCP Test Title');
    assert.ok(preflightJson.cover_image_path.endsWith('cover-image-x-article.png'));
    assert.ok(preflightJson.preflight_token.startsWith('sha256:v1:'));
    const imageBlocks = preflightRes.content.filter((c) => c.type === 'image');
    assert.equal(imageBlocks.length, 2, 'Both inline.png and cover-image-x-article.png should attach as MCP image blocks');

    // 7c. Mutating the file invalidates preflight_token.
    writeFileSync(postMdPath, readFileSync(postMdPath, 'utf8') + '\nExtra paragraph.\n');
    const staleRes = await mcpClient.callTool({
      name: 'x_article_create_draft',
      arguments: {
        markdown_path: postMdPath,
        preflight_token: preflightJson.preflight_token,
      },
    });
    assert.equal(staleRes.isError, true);

    // 7d. Re-scan and create draft -> verify chunked uploads + draft payload + editor_url.
    const preflightRes2 = await mcpClient.callTool({
      name: 'x_article_preflight',
      arguments: { markdown_path: postMdPath },
    });
    const freshToken = JSON.parse(preflightRes2.content[0].text).preflight_token;

    const draftRes = await mcpClient.callTool({
      name: 'x_article_create_draft',
      arguments: {
        markdown_path: postMdPath,
        preflight_token: freshToken,
      },
    });
    assert.ok(!draftRes.isError, `create_draft failed: ${draftRes.content[0]?.text}`);
    const draftJson = JSON.parse(draftRes.content[0].text);
    assert.equal(draftJson.article_id, '777777777777777777');
    assert.equal(draftJson.editor_url, 'https://x.com/compose/articles/edit/777777777777777777');
    assert.equal(draftJson.cover_media_id, '5000000002');

    const draftApiCall = recordedRequests.find((r) => r.url === '/2/articles/draft');
    assert.ok(draftApiCall, 'POST /2/articles/draft should have been called');
    assert.ok(draftApiCall.auth?.startsWith('OAuth '), 'OAuth 1.0a header missing on draft call');
    assert.deepEqual(draftApiCall.body.cover_media, {
      media_category: 'tweet_image',
      media_id: '5000000002',
    });
    const uploadedImgEntity = draftApiCall.body.content_state.entities.find((e) => e.value.type === 'image');
    assert.equal(uploadedImgEntity.value.data.media_items[0].media_id, '5000000001');
    assert.equal(uploadedImgEntity.value.data.caption, 'Figure 1');

    // 7e. Publish draft -> verify post_url with authenticated username.
    const pubRes = await mcpClient.callTool({
      name: 'x_article_publish',
      arguments: { article_id: draftJson.article_id },
    });
    assert.ok(!pubRes.isError);
    const pubJson = JSON.parse(pubRes.content[0].text);
    assert.equal(pubJson.post_id, '888888888888888888');
    assert.equal(pubJson.post_url, 'https://x.com/mockwriter/status/888888888888888888');

    console.log('end-to-end MCP stdio server & mock X API v2 pipeline: OK');
  } finally {
    await mcpClient.close().catch(() => {});
    mockApiServer.close();
  }

  // --- 8. Port-conflict random-port fallback + Browser /setup -> /pin flow ---

  const mockOAuthServer = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/oauth/request_token') {
      assert.ok(req.headers.authorization?.includes('oauth_callback="oob"'));
      res.end('oauth_token=req_tok_123&oauth_token_secret=req_sec_456&oauth_callback_confirmed=true');
      return;
    }
    if (req.method === 'POST' && req.url === '/oauth/access_token') {
      assert.ok(req.headers.authorization?.includes('oauth_verifier="7654321"'));
      res.end('oauth_token=acc_tok_999&oauth_token_secret=acc_sec_888');
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });
  await new Promise((r) => mockOAuthServer.listen(0, '127.0.0.1', r));
  const oauthMockPort = mockOAuthServer.address().port;

  // Occupy a port to intentionally trigger EADDRINUSE and verify random-port fallback!
  const blocker = createServer((_req, res) => res.end('busy'));
  await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
  const occupiedPort = blocker.address().port;

  const prevEnvSnapshot = {
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    MCP_X_ARTICLES_DISABLE_KEYCHAIN: process.env.MCP_X_ARTICLES_DISABLE_KEYCHAIN,
    MCP_X_ARTICLES_NO_BROWSER: process.env.MCP_X_ARTICLES_NO_BROWSER,
    X_OAUTH_CALLBACK_PORT: process.env.X_OAUTH_CALLBACK_PORT,
    X_OAUTH_BASE_URL: process.env.X_OAUTH_BASE_URL,
    X_OAUTH_CONSUMER_KEY: process.env.X_OAUTH_CONSUMER_KEY,
    X_OAUTH_CONSUMER_SECRET: process.env.X_OAUTH_CONSUMER_SECRET,
  };

  try {
    process.env.XDG_CONFIG_HOME = join(tempDir, 'xdg-browser-setup');
    process.env.MCP_X_ARTICLES_DISABLE_KEYCHAIN = '1';
    process.env.MCP_X_ARTICLES_NO_BROWSER = '1';
    process.env.X_OAUTH_CALLBACK_PORT = String(occupiedPort);
    process.env.X_OAUTH_BASE_URL = `http://127.0.0.1:${oauthMockPort}`;
    delete process.env.X_OAUTH_CONSUMER_KEY;
    delete process.env.X_OAUTH_CONSUMER_SECRET;

    let setupEntryUrl = '';
    const flowPromise = runInteractiveSetupAndOAuth1Flow({
      existingCredentials: null,
      existingCredentialSource: 'none',
      onServerReady: (url) => {
        setupEntryUrl = url;
      },
    });

    // Wait until onServerReady supplies the bound random-port /setup URL.
    while (!setupEntryUrl) {
      await new Promise((r) => setTimeout(r, 10));
    }

    const parsedSetup = new URL(setupEntryUrl);
    assert.notEqual(Number(parsedSetup.port), occupiedPort, 'Must fall back to a random free port on EADDRINUSE');
    const csrf = parsedSetup.searchParams.get('s');
    assert.ok(csrf, 'CSRF session token missing on /setup URL');

    const getSetup = await fetch(setupEntryUrl);
    assert.equal(getSetup.status, 200);
    const setupHtml = await getSetup.text();
    assert.ok(setupHtml.includes('Save to Keychain'));

    // Submit API Key + Secret to POST /setup -> expect 302 redirect to /pin
    const postSetup = await fetch(`http://127.0.0.1:${parsedSetup.port}/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        s: csrf,
        consumer_key: 'browser_ck',
        consumer_secret: 'browser_cs',
      }),
      redirect: 'manual',
    });
    assert.equal(postSetup.status, 302);
    const pinLocation = postSetup.headers.get('location');
    assert.ok(pinLocation?.includes('/pin?s='));

    // Submit 7-digit OOB PIN to POST /pin -> completes flow!
    const postPin = await fetch(pinLocation.replace('/pin?s=' + csrf, '/pin'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        s: csrf,
        verifier: '7654321',
      }),
    });
    assert.equal(postPin.status, 200);

    const authResult = await flowPromise;
    assert.equal(authResult.usedOobPinFallback, true);
    assert.notEqual(authResult.boundPort, occupiedPort);
    assert.equal(authResult.credentials.consumerKey, 'browser_ck');
    assert.equal(authResult.accessToken, 'acc_tok_999');

    const persistedCreds = loadConsumerCredentials();
    assert.equal(persistedCreds.credentials.consumerKey, 'browser_ck');
    console.log('browser /setup + port-conflict random-port OOB fallback test: OK');
  } finally {
    blocker.close();
    mockOAuthServer.close();
    for (const [k, v] of Object.entries(prevEnvSnapshot)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

console.log('\nAll tests passed.');
