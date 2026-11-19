#!/usr/bin/env node
/**
 * Comprehensive test suite for @wezzard/mcp-x-articles:
 * 1. Fixture AST & UTF-16 offset semantics
 * 2. Pending-image discovery
 * 3. Live X OpenAPI v2 schema validation
 * 4. X API Playground contract test (when running locally)
 * 5. Sensitive-information scanner assertions
 * 6. OAuth 2.0 PKCE S256, 0600 XDG fallback, seed refresh-token rotation guard, and Keychain roundtrip
 * 7. End-to-end MCP stdio server + mock X API v2 + auto-refresh rotation + GIF category + reactive 401 retry
 * 8. Browser /setup -> PKCE /oauth/callback flow & public/confidential client token auth rules
 * 9. Native host configuration UI detection & /setup suppression
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
  generatePkcePair,
  buildOAuth2AuthorizeUrl,
  refreshOAuth2Token,
  runInteractiveSetupAndOAuth2Flow,
  detectHostConfigUi,
  saveOAuth2ClientCredentials,
  loadOAuth2ClientCredentials,
  clearOAuth2ClientCredentials,
  saveOAuth2UserTokens,
  loadOAuth2UserTokens,
  clearOAuth2UserTokens,
  sha256Hex,
  withOAuth2RefreshLock,
  guessMediaCategory,
  matchLinksToPublishedArticles,
  filterPublishedXArticles,
  extractLocalMarkdownTitle,
} = await import(serverBundlePath);

// Ensure outer IDE or OAuth env vars don't leak into standalone tests.
for (const envKey of [
  'ANTIGRAVITY_VSCODE_HOST',
  'ANTIGRAVITY_AUTH_SUCCESS_APP',
  'PLUGIN_ROOT',
  'PLUGIN_DATA',
  'CURSOR_PLUGIN_ROOT',
  'X_OAUTH2_CLIENT_ID',
  'X_OAUTH2_CLIENT_SECRET',
  'X_OAUTH2_REFRESH_TOKEN',
  'X_OAUTH2_ACCESS_TOKEN',
  'X_CLIENT_ID',
  'X_CLIENT_SECRET',
]) {
  delete process.env[envKey];
}

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
const BEARER_AUTH = 'Bearer mock_playground_user_token';

async function postDraft(body) {
  const res = await fetch(`${PLAYGROUND}/2/articles/draft`, {
    method: 'POST',
    headers: { Authorization: BEARER_AUTH, 'Content-Type': 'application/json' },
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
    headers: { Authorization: BEARER_AUTH },
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

  // --- 6. OAuth 2.0 PKCE, 0600 XDG fallback & seed rotation guard ---------

  const pkce = generatePkcePair();
  assert.ok(pkce.codeVerifier.length >= 43);
  assert.equal(
    pkce.codeChallenge,
    createHash('sha256').update(pkce.codeVerifier, 'utf8').digest('base64url'),
  );
  const sampleAuthUrl = new URL(
    buildOAuth2AuthorizeUrl({
      clientId: 'cid_sample',
      redirectUri: 'http://127.0.0.1:8976/oauth/callback',
      state: 'st_sample',
      codeChallenge: pkce.codeChallenge,
    }),
  );
  assert.equal(sampleAuthUrl.searchParams.get('response_type'), 'code');
  assert.equal(sampleAuthUrl.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(sampleAuthUrl.searchParams.get('scope')?.includes('offline.access'));
  assert.ok(sampleAuthUrl.searchParams.get('scope')?.includes('media.write'));
  assert.ok(sampleAuthUrl.searchParams.get('scope')?.includes('tweet.write'));

  assert.equal(guessMediaCategory('image/png'), 'tweet_image');
  assert.equal(guessMediaCategory('image/gif'), 'tweet_gif');
  assert.equal(guessMediaCategory('video/mp4'), 'tweet_video');

  const prevXdg = process.env.XDG_CONFIG_HOME;
  const prevDisableKc = process.env.MCP_X_ARTICLES_DISABLE_KEYCHAIN;
  const prevCid = process.env.X_OAUTH2_CLIENT_ID;
  const prevCsec = process.env.X_OAUTH2_CLIENT_SECRET;
  const prevRt = process.env.X_OAUTH2_REFRESH_TOKEN;
  try {
    const xdgDir = join(tempDir, 'xdg');
    process.env.XDG_CONFIG_HOME = xdgDir;
    process.env.MCP_X_ARTICLES_DISABLE_KEYCHAIN = '1';
    // Verify unexpanded Antigravity template placeholders fall through cleanly!
    process.env.X_OAUTH2_CLIENT_ID = '${X_OAUTH2_CLIENT_ID}';
    process.env.X_OAUTH2_CLIENT_SECRET = '${X_OAUTH2_CLIENT_SECRET}';
    process.env.X_OAUTH2_REFRESH_TOKEN = '${X_OAUTH2_REFRESH_TOKEN}';

    const savedSrc = saveOAuth2ClientCredentials({
      clientId: 'cid_test_1',
      clientSecret: 'csec_test_1',
    });
    assert.equal(savedSrc, 'xdg-config');
    const loadedCreds = loadOAuth2ClientCredentials();
    assert.equal(loadedCreds.source, 'xdg-config');
    assert.equal(loadedCreds.credentials.clientId, 'cid_test_1');
    assert.equal(loadedCreds.credentials.clientSecret, 'csec_test_1');

    const nowSec = Math.floor(Date.now() / 1000);
    process.env.X_OAUTH2_REFRESH_TOKEN = 'seed_rt_v1';
    const initialEnvTok = loadOAuth2UserTokens('cid_test_1');
    assert.equal(initialEnvTok.source, 'env');
    assert.equal(initialEnvTok.tokens.refreshToken, 'seed_rt_v1');
    assert.equal(initialEnvTok.tokens.seedRefreshTokenHash, sha256Hex('seed_rt_v1'));

    saveOAuth2UserTokens('cid_test_1', {
      accessToken: 'rot_at_1',
      refreshToken: 'rot_rt_1',
      expiresAt: nowSec + 7200,
      scope: 'tweet.read tweet.write users.read media.write offline.access',
      seedRefreshTokenHash: sha256Hex('seed_rt_v1'),
    });
    const loadedRotated = loadOAuth2UserTokens('cid_test_1');
    assert.equal(loadedRotated.source, 'xdg-config');
    assert.equal(loadedRotated.tokens.accessToken, 'rot_at_1');
    assert.equal(loadedRotated.tokens.refreshToken, 'rot_rt_1');

    // Updating env to a brand-new Console seed must supersede the older rotated cache.
    process.env.X_OAUTH2_REFRESH_TOKEN = 'seed_rt_v2';
    const nextEnvTok = loadOAuth2UserTokens('cid_test_1');
    assert.equal(nextEnvTok.source, 'env');
    assert.equal(nextEnvTok.tokens.refreshToken, 'seed_rt_v2');
    assert.equal(nextEnvTok.tokens.seedRefreshTokenHash, sha256Hex('seed_rt_v2'));

    const credStat = statSync(join(xdgDir, 'mcp-x-articles', 'oauth2_client.json'));
    assert.equal(credStat.mode & 0o777, 0o600, 'oauth2_client.json must have mode 0600');
    const tokStat = statSync(join(xdgDir, 'mcp-x-articles', 'oauth2_tokens.json'));
    assert.equal(tokStat.mode & 0o777, 0o600, 'oauth2_tokens.json must have mode 0600');

    // Verify withOAuth2RefreshLock serializes concurrent callers without overlap.
    let activeWorkers = 0;
    let maxConcurrent = 0;
    await Promise.all(
      [1, 2, 3].map((n) =>
        withOAuth2RefreshLock(async () => {
          activeWorkers += 1;
          maxConcurrent = Math.max(maxConcurrent, activeWorkers);
          await new Promise((r) => setTimeout(r, n * 15));
          activeWorkers -= 1;
        }),
      ),
    );
    assert.equal(maxConcurrent, 1, 'withOAuth2RefreshLock must serialize concurrent refresh callers');
  } finally {
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    if (prevDisableKc === undefined) delete process.env.MCP_X_ARTICLES_DISABLE_KEYCHAIN;
    else process.env.MCP_X_ARTICLES_DISABLE_KEYCHAIN = prevDisableKc;
    if (prevCid === undefined) delete process.env.X_OAUTH2_CLIENT_ID;
    else process.env.X_OAUTH2_CLIENT_ID = prevCid;
    if (prevCsec === undefined) delete process.env.X_OAUTH2_CLIENT_SECRET;
    else process.env.X_OAUTH2_CLIENT_SECRET = prevCsec;
    if (prevRt === undefined) delete process.env.X_OAUTH2_REFRESH_TOKEN;
    else process.env.X_OAUTH2_REFRESH_TOKEN = prevRt;
  }
  console.log('oauth2 PKCE, rotation guard & 0600 fallback tests: OK');

  if (process.platform === 'darwin') {
    const prevKcSvc = process.env.MCP_X_ARTICLES_KEYCHAIN_SERVICE;
    const prevDisableKc2 = process.env.MCP_X_ARTICLES_DISABLE_KEYCHAIN;
    const prevCid2 = process.env.X_OAUTH2_CLIENT_ID;
    const prevCsec2 = process.env.X_OAUTH2_CLIENT_SECRET;
    const prevRt2 = process.env.X_OAUTH2_REFRESH_TOKEN;
    process.env.MCP_X_ARTICLES_KEYCHAIN_SERVICE = `@wezzard/mcp-x-articles-test-${process.pid}`;
    delete process.env.MCP_X_ARTICLES_DISABLE_KEYCHAIN;
    delete process.env.X_OAUTH2_CLIENT_ID;
    delete process.env.X_OAUTH2_CLIENT_SECRET;
    delete process.env.X_OAUTH2_REFRESH_TOKEN;
    try {
      const kcSource = saveOAuth2ClientCredentials({
        clientId: 'kc_cid_live_test',
        clientSecret: 'kc_csec_live_test',
      });
      if (kcSource === 'macos-keychain') {
        const readBack = loadOAuth2ClientCredentials();
        assert.equal(readBack.source, 'macos-keychain');
        assert.equal(readBack.credentials.clientId, 'kc_cid_live_test');

        const tokSource = saveOAuth2UserTokens('kc_cid_live_test', {
          accessToken: 'kc_at_live',
          refreshToken: 'kc_rt_live',
          expiresAt: Math.floor(Date.now() / 1000) + 7200,
          scope: 'tweet.read tweet.write users.read media.write offline.access',
        });
        assert.equal(tokSource, 'macos-keychain');
        const readTok = loadOAuth2UserTokens('kc_cid_live_test');
        assert.equal(readTok.source, 'macos-keychain');
        assert.equal(readTok.tokens.accessToken, 'kc_at_live');
        assert.equal(readTok.tokens.refreshToken, 'kc_rt_live');
        console.log('macos keychain roundtrip test: OK');
      } else {
        console.log('macos keychain roundtrip test: SKIPPED (keychain locked/unavailable)');
      }
    } finally {
      clearOAuth2UserTokens('kc_cid_live_test');
      clearOAuth2ClientCredentials();
      if (prevKcSvc === undefined) delete process.env.MCP_X_ARTICLES_KEYCHAIN_SERVICE;
      else process.env.MCP_X_ARTICLES_KEYCHAIN_SERVICE = prevKcSvc;
      if (prevDisableKc2 === undefined) delete process.env.MCP_X_ARTICLES_DISABLE_KEYCHAIN;
      else process.env.MCP_X_ARTICLES_DISABLE_KEYCHAIN = prevDisableKc2;
      if (prevCid2 === undefined) delete process.env.X_OAUTH2_CLIENT_ID;
      else process.env.X_OAUTH2_CLIENT_ID = prevCid2;
      if (prevCsec2 === undefined) delete process.env.X_OAUTH2_CLIENT_SECRET;
      else process.env.X_OAUTH2_CLIENT_SECRET = prevCsec2;
      if (prevRt2 === undefined) delete process.env.X_OAUTH2_REFRESH_TOKEN;
      else process.env.X_OAUTH2_REFRESH_TOKEN = prevRt2;
    }
  }

  // --- 7. End-to-end MCP stdio server + mock X API v2 + refresh rotation ---

  let nextMediaId = 5000000001;
  const recordedRequests = [];
  let statusChecks = 0;
  let activeRefreshToken = 'initial_seed_rt';
  let activeAccessToken = '';
  let refreshCalls = 0;
  let forceOne401 = true;

  const mockApiServer = createServer(async (req, res) => {
    const chunks = [];
    for await (const ch of req) chunks.push(ch);
    const bodyText = Buffer.concat(chunks).toString('utf8');

    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'POST' && req.url === '/2/oauth2/token') {
      const form = new URLSearchParams(bodyText);
      recordedRequests.push({
        method: req.method,
        url: req.url,
        auth: req.headers.authorization,
        body: Object.fromEntries(form.entries()),
      });

      const expectedBasic = 'Basic ' + Buffer.from('mock_cid:mock_csec', 'utf8').toString('base64');
      assert.equal(req.headers.authorization, expectedBasic, 'Confidential client must use Basic Auth');
      assert.equal(form.has('client_id'), false, 'Confidential client must NOT include client_id in body');
      assert.equal(form.has('client_secret'), false, 'Confidential client must NOT include client_secret in body');

      if (form.get('grant_type') === 'refresh_token') {
        const providedRt = form.get('refresh_token');
        if (providedRt !== activeRefreshToken) {
          res.statusCode = 400;
          res.end(
            JSON.stringify({
              error: 'invalid_grant',
              error_description: `Refresh token ${providedRt} was already rotated or invalid (expected ${activeRefreshToken})`,
            }),
          );
          return;
        }
        refreshCalls += 1;
        activeAccessToken = `access_tok_${refreshCalls}`;
        activeRefreshToken = `rotated_rt_${refreshCalls}`;
        res.end(
          JSON.stringify({
            token_type: 'bearer',
            expires_in: 7200,
            access_token: activeAccessToken,
            refresh_token: activeRefreshToken,
            scope: 'tweet.read tweet.write users.read media.write offline.access',
          }),
        );
        return;
      }

      if (form.get('grant_type') === 'authorization_code') {
        res.end(
          JSON.stringify({
            token_type: 'bearer',
            expires_in: 7200,
            access_token: 'pkce_at_999',
            refresh_token: 'pkce_rt_888',
            scope: 'tweet.read tweet.write users.read media.write offline.access',
          }),
        );
        return;
      }
    }

    const parsedBody = bodyText ? JSON.parse(bodyText) : null;
    recordedRequests.push({
      method: req.method,
      url: req.url,
      auth: req.headers.authorization,
      body: parsedBody,
    });

    if (req.headers.authorization !== `Bearer ${activeAccessToken}`) {
      res.statusCode = 401;
      res.end(JSON.stringify({ title: 'Unauthorized', status: 401 }));
      return;
    }

    if (req.method === 'GET' && req.url === '/2/users/me') {
      res.end(JSON.stringify({ data: { id: '42', username: 'mockwriter', name: 'Mock Writer' } }));
      return;
    }
    if (req.method === 'GET' && req.url.startsWith('/2/users/42/tweets')) {
      res.end(
        JSON.stringify({
          data: [
            {
              id: '900000000000000001',
              text: 'https://t.co/enArticle',
              created_at: '2026-11-16T10:00:00Z',
              lang: 'en',
              article: {
                id: '300000000000000001',
                title: '9 Tips to Make Antigravity CLI Less Painful',
                preview_text: 'CLI guide in English',
              },
            },
            {
              id: '900000000000000002',
              text: 'https://t.co/zhArticle',
              created_at: '2026-11-16T11:00:00Z',
              lang: 'zh',
              article: {
                id: '300000000000000002',
                title: '9 招让你的 Antigravity CLI 不那么难用',
                preview_text: 'CLI 指南中文版',
              },
            },
          ],
          meta: { result_count: 2 },
        }),
      );
      return;
    }
    if (req.method === 'POST' && req.url === '/2/media/upload/initialize') {
      if (forceOne401) {
        forceOne401 = false;
        res.statusCode = 401;
        res.end(JSON.stringify({ title: 'Unauthorized', status: 401 }));
        return;
      }
      const id = String(nextMediaId++);
      res.end(JSON.stringify({ data: { id } }));
      return;
    }
    if (req.method === 'POST' && /^\/2\/media\/upload\/\d+\/append$/.test(req.url)) {
      res.end(JSON.stringify({ data: {} }));
      return;
    }
    if (req.method === 'POST' && /^\/2\/media\/upload\/\d+\/finalize$/.test(req.url)) {
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

  // Create a companion post + sample post directory with inline PNG, animated GIF, cross-links, and cover PNG.
  const otherPostDir = join(tempDir, 'other-post');
  execFileSync('mkdir', ['-p', otherPostDir]);
  writeFileSync(
    join(otherPostDir, 'index.md'),
    ['---', 'title: "9 Tips to Make Antigravity CLI Less Painful"', '---', '', 'CLI body.'].join('\n'),
  );

  const postDir = join(tempDir, 'sample-post');
  execFileSync('mkdir', ['-p', postDir]);
  const onePixelPng = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  );
  const onePixelGif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
  writeFileSync(join(postDir, 'inline.png'), onePixelPng);
  writeFileSync(join(postDir, 'anim.gif'), onePixelGif);
  writeFileSync(join(postDir, 'cover-image-x-article.png'), onePixelPng);
  const postMdPath = join(postDir, 'index.md');
  writeFileSync(
    postMdPath,
    [
      '# End-to-End MCP Test Title',
      '',
      'Body paragraph with **bold** text, a [9 Tips to Make Antigravity CLI Less Painful](https://example.com/post/2026/11/making-antigravity-cli-usable-7276/) link, and [local post](../other-post/index.md).',
      '',
      '![Screen reader description](./inline.png "Figure 1")',
      '',
      '![Animated demo](./anim.gif "Figure 2")',
    ].join('\n'),
  );

  const e2eXdgDir = join(tempDir, 'xdg-e2e');
  const transport = new StdioClientTransport({
    command: 'node',
    args: [serverBundlePath],
    env: {
      ...process.env,
      X_API_BASE_URL: `http://127.0.0.1:${mockPort}`,
      X_OAUTH2_CLIENT_ID: 'mock_cid',
      X_OAUTH2_CLIENT_SECRET: 'mock_csec',
      X_OAUTH2_REFRESH_TOKEN: 'initial_seed_rt',
      XDG_CONFIG_HOME: e2eXdgDir,
      MCP_X_ARTICLES_DISABLE_KEYCHAIN: '1',
    },
    stderr: 'pipe',
  });
  const mcpClient = new Client({ name: 'e2e-test-client', version: '1.0.0' });

  try {
    await mcpClient.connect(transport);

    const instructions = mcpClient.getInstructions();
    assert.ok(instructions?.includes('x_article_preflight'));

    const { tools } = await mcpClient.listTools();
    assert.equal(tools.length, 5);
    for (const tool of tools) {
      assert.equal(tool.inputSchema.type, 'object');
      assert.equal(tool.inputSchema.anyOf, undefined);
      assert.equal(tool.inputSchema.oneOf, undefined);
    }
    const pubTool = tools.find((t) => t.name === 'x_article_publish');
    assert.equal(pubTool.annotations?.destructiveHint, true);
    assert.equal(pubTool.annotations?.idempotentHint, false);

    // 7a. Bootstrap auth from env X_OAUTH2_REFRESH_TOKEN -> rotates initial_seed_rt -> access_tok_1 + rotated_rt_1
    const authRes = await mcpClient.callTool({
      name: 'x_article_auth_status',
      arguments: { verify: true },
    });
    assert.ok(!authRes.isError, `x_article_auth_status failed: ${authRes.content[0]?.text}`);
    const authJson = JSON.parse(authRes.content[0].text);
    assert.equal(authJson.auth_mode, 'oauth2');
    assert.equal(authJson.configured, true);
    assert.equal(authJson.verified, true);
    assert.equal(authJson.has_refresh_token, true);
    assert.equal(authJson.refreshed, true);
    assert.equal(authJson.authenticated_user.username, 'mockwriter');

    // 7a-bis. List published X Articles on timeline & filter by query.
    const listAllRes = await mcpClient.callTool({
      name: 'x_article_list_published',
      arguments: {},
    });
    assert.ok(!listAllRes.isError, `x_article_list_published failed: ${listAllRes.content[0]?.text}`);
    const listAllJson = JSON.parse(listAllRes.content[0].text);
    assert.equal(listAllJson.total_found, 2);
    assert.equal(listAllJson.articles.length, 2);

    const listFilteredRes = await mcpClient.callTool({
      name: 'x_article_list_published',
      arguments: { query: 'Painful' },
    });
    assert.ok(!listFilteredRes.isError);
    const listFilteredJson = JSON.parse(listFilteredRes.content[0].text);
    assert.equal(listFilteredJson.articles.length, 1);
    assert.equal(listFilteredJson.articles[0].post_id, '900000000000000001');

    // 7b. Gate 1 rejects create_draft without a valid preflight_token.
    const rejected = await mcpClient.callTool({
      name: 'x_article_create_draft',
      arguments: {
        markdown_path: postMdPath,
        preflight_token: 'sha256:v1:0000000000000000000000000000000000000000000000000000000000000000',
      },
    });
    assert.equal(rejected.isError, true);

    // 7c. Run preflight -> verify token, auto-detected cover, MCP image blocks, and X link suggestions.
    const preflightRes = await mcpClient.callTool({
      name: 'x_article_preflight',
      arguments: { markdown_path: postMdPath },
    });
    assert.ok(!preflightRes.isError);
    const preflightJson = JSON.parse(preflightRes.content[0].text);
    assert.equal(preflightJson.resolved_title, 'End-to-End MCP Test Title');
    assert.ok(preflightJson.cover_image_path.endsWith('cover-image-x-article.png'));
    assert.ok(preflightJson.preflight_token.startsWith('sha256:v1:'));
    assert.equal(preflightJson.x_link_resolution?.status, 'checked');
    const blogSugg = preflightJson.link_rewrite_suggestions?.find(
      (s) => s.original_href === 'https://example.com/post/2026/11/making-antigravity-cli-usable-7276/',
    );
    const relSugg = preflightJson.link_rewrite_suggestions?.find(
      (s) => s.original_href === '../other-post/index.md',
    );
    assert.ok(blogSugg, 'preflight should suggest X URL for matching blog cross-link');
    assert.equal(blogSugg.suggested_url, 'https://x.com/mockwriter/status/900000000000000001');
    assert.ok(relSugg, 'preflight should suggest X URL for matching relative .md link via frontmatter');
    assert.equal(relSugg.suggested_url, 'https://x.com/mockwriter/status/900000000000000001');
    const imageBlocks = preflightRes.content.filter((c) => c.type === 'image');
    assert.equal(imageBlocks.length, 3, 'inline.png, anim.gif, and cover-image-x-article.png should attach');

    // 7d. Mutating the file invalidates preflight_token.
    writeFileSync(postMdPath, readFileSync(postMdPath, 'utf8') + '\nExtra paragraph.\n');
    const staleRes = await mcpClient.callTool({
      name: 'x_article_create_draft',
      arguments: {
        markdown_path: postMdPath,
        preflight_token: preflightJson.preflight_token,
      },
    });
    assert.equal(staleRes.isError, true);

    // 7e. Re-scan and create draft with non-destructive link_rewrites -> verify reactive 401 refresh + rewritten URL!
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
        link_rewrites: {
          'https://example.com/post/2026/11/making-antigravity-cli-usable-7276/':
            'https://x.com/mockwriter/status/900000000000000001',
        },
      },
    });
    assert.ok(!draftRes.isError, `create_draft failed: ${draftRes.content[0]?.text}`);
    const draftJson = JSON.parse(draftRes.content[0].text);
    assert.equal(draftJson.article_id, '777777777777777777');
    assert.equal(draftJson.editor_url, 'https://x.com/compose/articles/edit/777777777777777777');
    assert.equal(draftJson.cover_media_id, '5000000003');
    assert.deepEqual(draftJson.applied_link_rewrites, [
      {
        from: 'https://example.com/post/2026/11/making-antigravity-cli-usable-7276/',
        to: 'https://x.com/mockwriter/status/900000000000000001',
        occurrences: 1,
      },
    ]);
    assert.equal(refreshCalls, 2, 'Should have refreshed once for initial seed and once on reactive 401 retry');

    const initCalls = recordedRequests.filter((r) => r.url === '/2/media/upload/initialize');
    assert.ok(initCalls.some((r) => r.body?.media_category === 'tweet_image'));
    assert.ok(initCalls.some((r) => r.body?.media_category === 'tweet_gif'));

    const draftApiCall = recordedRequests.find((r) => r.url === '/2/articles/draft');
    assert.ok(draftApiCall, 'POST /2/articles/draft should have been called');
    assert.equal(
      draftApiCall.auth,
      'Bearer access_tok_2',
      'Draft request must use refreshed Bearer access_tok_2',
    );
    assert.deepEqual(draftApiCall.body.cover_media, {
      media_category: 'tweet_image',
      media_id: '5000000003',
    });
    assert.ok(
      draftApiCall.body.content_state.entities.some(
        (e) => e.value.type === 'link' && e.value.data.url === 'https://x.com/mockwriter/status/900000000000000001',
      ),
      'Sent content_state must contain the rewritten X URL',
    );
    assert.ok(
      readFileSync(postMdPath, 'utf8').includes('https://example.com/post/2026/11/making-antigravity-cli-usable-7276/'),
      'Disk Markdown file must remain untouched by non-destructive link_rewrites',
    );
    const uploadedImgEntity = draftApiCall.body.content_state.entities.find((e) => e.value.type === 'image');
    assert.equal(uploadedImgEntity.value.data.media_items[0].media_id, '5000000001');
    assert.equal(uploadedImgEntity.value.data.caption, 'Figure 1');

    // 7f. Publish draft -> verify post_url with Bearer token and rotated refresh guard.
    const pubRes = await mcpClient.callTool({
      name: 'x_article_publish',
      arguments: { article_id: draftJson.article_id },
    });
    assert.ok(!pubRes.isError, `publish failed: ${pubRes.content[0]?.text}`);
    const pubJson = JSON.parse(pubRes.content[0].text);
    assert.equal(pubJson.post_id, '888888888888888888');
    assert.equal(pubJson.post_url, 'https://x.com/mockwriter/status/888888888888888888');

    console.log('end-to-end MCP stdio server & OAuth 2.0 refresh rotation pipeline: OK');
  } finally {
    await mcpClient.close().catch(() => {});
    mockApiServer.close();
  }

  // --- 8. Browser /setup -> PKCE /oauth/callback flow & public client rule -

  let seenPublicClientBody = null;
  const mockOAuthServer = createServer(async (req, res) => {
    const chunks = [];
    for await (const ch of req) chunks.push(ch);
    const bodyText = Buffer.concat(chunks).toString('utf8');
    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'POST' && req.url === '/2/oauth2/token') {
      const form = new URLSearchParams(bodyText);
      const grantType = form.get('grant_type');
      if (grantType === 'refresh_token' && !req.headers.authorization) {
        // Public client path: must NOT send Basic auth header and MUST pass client_id in body.
        seenPublicClientBody = Object.fromEntries(form.entries());
        res.end(
          JSON.stringify({
            token_type: 'bearer',
            expires_in: 7200,
            access_token: 'pub_at_123',
            refresh_token: 'pub_rt_456',
          }),
        );
        return;
      }

      const expectedBasic =
        'Basic ' + Buffer.from('mock_browser_cid:mock_browser_csec', 'utf8').toString('base64');
      assert.equal(req.headers.authorization, expectedBasic);
      assert.equal(form.has('client_id'), false);
      assert.equal(form.get('grant_type'), 'authorization_code');
      assert.equal(form.get('code'), 'auth_code_123');
      assert.ok(form.get('code_verifier'));
      assert.ok(form.get('redirect_uri'));
      res.end(
        JSON.stringify({
          token_type: 'bearer',
          expires_in: 7200,
          access_token: 'pkce_at_999',
          refresh_token: 'pkce_rt_888',
          scope: 'tweet.read tweet.write users.read media.write offline.access',
        }),
      );
      return;
    }

    res.statusCode = 404;
    res.end('not found');
  });
  await new Promise((r) => mockOAuthServer.listen(0, '127.0.0.1', r));
  const oauthMockPort = mockOAuthServer.address().port;

  const blocker = createServer((_req, res) => res.end('busy'));
  await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
  const occupiedPort = blocker.address().port;

  const prevEnvSnapshot = {
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    MCP_X_ARTICLES_DISABLE_KEYCHAIN: process.env.MCP_X_ARTICLES_DISABLE_KEYCHAIN,
    MCP_X_ARTICLES_NO_BROWSER: process.env.MCP_X_ARTICLES_NO_BROWSER,
    X_OAUTH_CALLBACK_PORT: process.env.X_OAUTH_CALLBACK_PORT,
    X_API_BASE_URL: process.env.X_API_BASE_URL,
    X_OAUTH2_CLIENT_ID: process.env.X_OAUTH2_CLIENT_ID,
    X_OAUTH2_CLIENT_SECRET: process.env.X_OAUTH2_CLIENT_SECRET,
    X_OAUTH2_REFRESH_TOKEN: process.env.X_OAUTH2_REFRESH_TOKEN,
  };

  try {
    process.env.XDG_CONFIG_HOME = join(tempDir, 'xdg-browser-setup');
    process.env.MCP_X_ARTICLES_DISABLE_KEYCHAIN = '1';
    process.env.MCP_X_ARTICLES_NO_BROWSER = '1';
    process.env.X_API_BASE_URL = `http://127.0.0.1:${oauthMockPort}`;
    delete process.env.X_OAUTH2_CLIENT_ID;
    delete process.env.X_OAUTH2_CLIENT_SECRET;
    delete process.env.X_OAUTH2_REFRESH_TOKEN;

    // 8a. Public client token refresh must omit Basic Auth and pass client_id in form body.
    const pubRes = await refreshOAuth2Token({
      credentials: { clientId: 'public_cid_only' },
      refreshToken: 'public_rt_seed',
    });
    assert.equal(pubRes.accessToken, 'pub_at_123');
    assert.equal(seenPublicClientBody.client_id, 'public_cid_only');

    // 8b. Explicit busy port must fail loudly with EADDRINUSE + guidance.
    process.env.X_OAUTH_CALLBACK_PORT = String(occupiedPort);
    await assert.rejects(
      () =>
        runInteractiveSetupAndOAuth2Flow({
          existingCredentials: null,
          existingCredentialSource: 'none',
        }),
      /EADDRINUSE/,
    );

    // 8c. Dynamic free port -> GET /setup -> POST /setup -> 302 authorize URL -> GET /oauth/callback -> tokens!
    process.env.X_OAUTH_CALLBACK_PORT = '0';
    let setupEntryUrl = '';
    const flowPromise = runInteractiveSetupAndOAuth2Flow({
      existingCredentials: null,
      existingCredentialSource: 'none',
      onServerReady: (url) => {
        setupEntryUrl = url;
      },
    });

    while (!setupEntryUrl) {
      await new Promise((r) => setTimeout(r, 10));
    }

    const parsedSetup = new URL(setupEntryUrl);
    const csrf = parsedSetup.searchParams.get('s');
    assert.ok(csrf, 'CSRF session token missing on /setup URL');

    const getSetup = await fetch(setupEntryUrl);
    assert.equal(getSetup.status, 200);
    const setupHtml = await getSetup.text();
    assert.ok(setupHtml.includes('Save to Keychain'));

    const postSetup = await fetch(`http://127.0.0.1:${parsedSetup.port}/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        s: csrf,
        client_id: 'mock_browser_cid',
        client_secret: 'mock_browser_csec',
      }),
      redirect: 'manual',
    });
    assert.equal(postSetup.status, 302);
    const authRedirect = new URL(postSetup.headers.get('location'));
    assert.equal(authRedirect.origin, 'https://x.com');
    const cbUri = authRedirect.searchParams.get('redirect_uri');
    const oauthState = authRedirect.searchParams.get('state');
    assert.ok(cbUri && oauthState);

    const cbResp = await fetch(`${cbUri}?code=auth_code_123&state=${encodeURIComponent(oauthState)}`);
    assert.equal(cbResp.status, 200);

    const authResult = await flowPromise;
    assert.equal(authResult.credentials.clientId, 'mock_browser_cid');
    assert.equal(authResult.accessToken, 'pkce_at_999');
    assert.equal(authResult.refreshToken, 'pkce_rt_888');

    const persistedCreds = loadOAuth2ClientCredentials();
    assert.equal(persistedCreds.credentials.clientId, 'mock_browser_cid');
    const persistedTok = loadOAuth2UserTokens('mock_browser_cid');
    assert.equal(persistedTok.tokens.accessToken, 'pkce_at_999');
    assert.equal(persistedTok.tokens.refreshToken, 'pkce_rt_888');
    console.log('browser /setup -> PKCE /oauth/callback flow tests: OK');

    // --- 9. Native host configuration UI (Antigravity / Cursor) suppresses /setup Web UI ---
    process.env.ANTIGRAVITY_VSCODE_HOST = '1';
    process.env.PLUGIN_ROOT = '/Users/example/.gemini/config/plugins/x-articles';
    process.env.X_OAUTH2_CLIENT_ID = '${X_OAUTH2_CLIENT_ID}';
    process.env.X_OAUTH2_CLIENT_SECRET = '${X_OAUTH2_CLIENT_SECRET}';

    const agyHost = detectHostConfigUi();
    assert.equal(agyHost.hasNativeConfigUi, true);
    assert.equal(agyHost.hostName, 'antigravity');
    assert.equal(agyHost.configUiUrl, 'customization://x-articles');

    const nativeCreds = loadOAuth2ClientCredentials();
    assert.equal(nativeCreds.credentials, null);
    assert.equal(nativeCreds.source, 'none');

    await assert.rejects(
      () =>
        runInteractiveSetupAndOAuth2Flow({
          existingCredentials: null,
          existingCredentialSource: 'none',
        }),
      /customization:\/\/x-articles/,
      'Native host UI must block the localhost /setup web form when credentials are not configured',
    );
    console.log('native host configuration UI detection & /setup suppression test: OK');
  } finally {
    delete process.env.ANTIGRAVITY_VSCODE_HOST;
    delete process.env.PLUGIN_ROOT;
    blocker.close();
    mockOAuthServer.close();
    for (const [k, v] of Object.entries(prevEnvSnapshot)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }

  // --- 10. Link resolver, language isolation & non-destructive rewriting -----

  const resolverDir = join(tempDir, 'resolver-post', 'zh-Hans');
  execFileSync('mkdir', ['-p', resolverDir]);
  const zhLinkedDir = join(tempDir, 'zh-linked-post');
  execFileSync('mkdir', ['-p', zhLinkedDir]);
  writeFileSync(
    join(zhLinkedDir, 'index.md'),
    ['---', 'title: "9 招让你的 Antigravity CLI 不那么难用"', '---', '', '内容。'].join('\n'),
  );
  const currentZhMd = join(resolverDir, 'index.md');
  writeFileSync(currentZhMd, '# 示例文章\n\n正文。');

  const sampleArticles = [
    {
      post_id: '111',
      article_id: '2111',
      title: '9 Tips to Make Antigravity CLI Less Painful',
      preview_text: 'Tips for agy CLI',
      created_at: '2026-11-16T10:00:00Z',
      lang: 'en',
      post_url: 'https://x.com/author/status/111',
      article_url: 'https://x.com/author/article/2111',
    },
    {
      post_id: '222',
      article_id: '2222',
      title: '9 招让你的 Antigravity CLI 不那么难用',
      preview_text: 'agy 命令行技巧',
      created_at: '2026-11-16T11:00:00Z',
      lang: 'zh',
      post_url: 'https://x.com/author/status/222',
      article_url: 'https://x.com/author/article/2222',
    },
  ];

  // Exact match respects EN vs ZH script isolation and reads relative .md frontmatter.
  assert.equal(extractLocalMarkdownTitle(currentZhMd, '../../zh-linked-post/index.md'), '9 招让你的 Antigravity CLI 不那么难用');

  const resolvedMix = matchLinksToPublishedArticles({
    markdownPath: currentZhMd,
    sourceTitle: '示例文章',
    publishedArticles: sampleArticles,
    links: [
      {
        href: 'https://example.com/post/2026/11/making-antigravity-cli-usable-7276/',
        text: '9 Tips to Make Antigravity CLI Less Painful',
        is_relative: false,
        is_x_url: false,
      },
      {
        href: 'https://example.com/zh-Hans/post/2026/11/making-antigravity-cli-usable-7276/',
        text: '之前的命令行指南',
        is_relative: false,
        is_x_url: false,
      },
      {
        href: '../../zh-linked-post/index.md',
        text: '这篇文章',
        is_relative: true,
        is_x_url: false,
      },
      {
        href: '../missing-post/index.md',
        text: '尚未同步的本地文章',
        is_relative: true,
        is_x_url: false,
      },
    ],
  });

  const enMatch = resolvedMix.suggestions.find(
    (s) => s.original_href === 'https://example.com/post/2026/11/making-antigravity-cli-usable-7276/',
  );
  assert.equal(enMatch?.matched_post_id, '111');
  assert.equal(enMatch?.match_reason, 'exact-title');

  // Strict language isolation: /zh-Hans/ URL must NOT mismatch EN article 111 even though anchor lacks exact ZH title!
  const zhBlogShouldNotHitEn = resolvedMix.suggestions.find(
    (s) => s.original_href === 'https://example.com/zh-Hans/post/2026/11/making-antigravity-cli-usable-7276/',
  );
  assert.equal(zhBlogShouldNotHitEn, undefined);

  const zhRelMatch = resolvedMix.suggestions.find(
    (s) => s.original_href === '../../zh-linked-post/index.md',
  );
  assert.equal(zhRelMatch?.matched_post_id, '222');
  assert.equal(zhRelMatch?.match_reason, 'exact-title');

  assert.equal(resolvedMix.unresolved_local_links.length, 1);
  assert.equal(resolvedMix.unresolved_local_links[0].original_href, '../missing-post/index.md');

  // Verify converter emits relative-link warning unless linkRewrites supplies target URL.
  const convNoRewrite = markdownToContentState('# T\n\nSee [A](../other.md) and [B](https://blog.example/a).');
  assert.ok(convNoRewrite.warnings.some((w) => w.startsWith('relative-link: "../other.md"')));
  assert.equal(convNoRewrite.links.length, 2);

  const convWithRewrite = markdownToContentState('# T\n\nSee [A](../other.md) and [B](https://blog.example/a).', {
    linkRewrites: {
      '../other.md': 'https://x.com/author/status/222',
      'https://blog.example/a': 'https://x.com/author/status/111',
    },
  });
  assert.ok(!convWithRewrite.warnings.some((w) => w.startsWith('relative-link:')));
  const linkUrls = convWithRewrite.content_state.entities
    .filter((e) => e.value.type === 'link')
    .map((e) => e.value.data.url);
  assert.deepEqual(linkUrls, ['https://x.com/author/status/222', 'https://x.com/author/status/111']);
  assert.equal(filterPublishedXArticles(sampleArticles, 'Less Painful').length, 1);

  console.log('link resolver, language isolation & non-destructive rewriting tests: OK');
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

console.log('\nAll tests passed.');
