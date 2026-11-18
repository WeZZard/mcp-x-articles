#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (rel) => JSON.parse(readFileSync(join(root, rel), 'utf8'));

const pkg = readJson('package.json');
const version = pkg.version;

// 1. Verify version alignment across all plugin manifests.
const agyPlugin = readJson('plugin.json');
const claudePlugin = readJson('.claude-plugin/plugin.json');
const codexPlugin = readJson('.codex-plugin/plugin.json');
const cursorPlugin = readJson('.cursor-plugin/plugin.json');
const piMcp = readJson('pi-mcp.json');

assert.equal(pkg.name, '@wezzard/mcp-x-articles');
assert.equal(agyPlugin.version, version, 'plugin.json version mismatch');
assert.equal(claudePlugin.version, version, '.claude-plugin/plugin.json version mismatch');
assert.equal(codexPlugin.version, version, '.codex-plugin/plugin.json version mismatch');
assert.equal(cursorPlugin.version, version, '.cursor-plugin/plugin.json version mismatch');
assert.deepEqual(
  piMcp.mcpServers['x-articles'].args,
  ['-y', `@wezzard/mcp-x-articles@${version}`],
  'pi-mcp.json args must match package name and version',
);

// 2. Verify path-variable isolation across coexisting manifests.
const claudeMcpRaw = readFileSync(join(root, '.mcp.json'), 'utf8');
const codexMcpRaw = readFileSync(join(root, '.codex-plugin/mcp.json'), 'utf8');
const cursorRaw = readFileSync(join(root, '.cursor-plugin/plugin.json'), 'utf8');
const agyMcpRaw = readFileSync(join(root, 'mcp_config.json'), 'utf8');

assert.ok(claudeMcpRaw.includes('${CLAUDE_PLUGIN_ROOT}/dist/server.mjs'));
assert.ok(!codexMcpRaw.includes('CLAUDE_PLUGIN_ROOT'), 'Codex MCP config must not contain CLAUDE_PLUGIN_ROOT');
assert.equal(codexPlugin.mcpServers, './.codex-plugin/mcp.json');
assert.ok(cursorRaw.includes('${CURSOR_PLUGIN_ROOT}/dist/server.mjs'));
assert.ok(!cursorRaw.includes('CLAUDE_PLUGIN_ROOT'));
assert.equal(cursorPlugin.variables?.type, 'object', '.cursor-plugin/plugin.json must declare variables schema');
assert.ok(!cursorRaw.includes('X_BEARER_TOKEN'), '.cursor-plugin/plugin.json must not include unused X_BEARER_TOKEN');
assert.ok(agyMcpRaw.includes('dist/server.mjs'));
assert.ok(!agyMcpRaw.includes('xmcp-stdio.py'), 'mcp_config.json must not reference legacy Python script');
assert.ok(!agyMcpRaw.includes('X_BEARER_TOKEN'), 'mcp_config.json must not include unused X_BEARER_TOKEN');

// 3. Pack an actual npm tarball into an isolated temp directory, extract it, verify every
//    required file is present with zero runtime dependencies, and run an MCP stdio handshake
//    directly against the unpacked dist/server.mjs (no node_modules!).
assert.equal(pkg.dependencies, undefined, 'package.json must have zero runtime dependencies');
const isolatedDir = mkdtempSync(join(tmpdir(), 'mcp-xa-isolated-'));
try {
  execFileSync('npm', ['pack', '--silent', '--pack-destination', isolatedDir], {
    cwd: root,
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const tgzName = readdirSync(isolatedDir).find((name) => name.endsWith('.tgz'));
  assert.ok(tgzName, 'npm pack did not produce a .tgz archive');
  execFileSync('tar', ['-xzf', join(isolatedDir, tgzName), '-C', isolatedDir]);

  const unpackedRoot = join(isolatedDir, 'package');
  const expectedInTarball = [
    'package.json',
    'dist/server.mjs',
    'skills/x-articles/SKILL.md',
    'plugin.json',
    'mcp_config.json',
    'pi-mcp.json',
    '.mcp.json',
    '.claude-plugin/plugin.json',
    '.claude-plugin/marketplace.json',
    '.codex-plugin/plugin.json',
    '.codex-plugin/mcp.json',
    '.cursor-plugin/plugin.json',
  ];
  for (const reqPath of expectedInTarball) {
    assert.ok(existsSync(join(unpackedRoot, reqPath)), `Missing ${reqPath} in npm pack tarball`);
  }

  const isolatedEntry = join(unpackedRoot, 'dist', 'server.mjs');
  const verOut = execFileSync(process.execPath, [isolatedEntry, '--version'], { encoding: 'utf8' }).trim();
  assert.equal(verOut, version);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [isolatedEntry],
    cwd: isolatedDir,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'verify-package-client', version: '1.0.0' });
  await client.connect(transport);

  const toolsRes = await client.listTools();
  assert.deepEqual(
    toolsRes.tools.map((t) => t.name),
    [
      'x_article_auth_status',
      'x_article_preflight',
      'x_article_create_draft',
      'x_article_publish',
    ],
  );
  const promptsRes = await client.listPrompts();
  assert.deepEqual(
    promptsRes.prompts.map((p) => p.name),
    ['publish-x-article'],
  );

  await client.close();
} finally {
  rmSync(isolatedDir, { recursive: true, force: true });
}

console.log('verify:package: OK');
