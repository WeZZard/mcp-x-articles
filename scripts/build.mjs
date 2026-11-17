#!/usr/bin/env node
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const version = pkg.version;

mkdirSync(join(root, 'dist'), { recursive: true });
const outFile = join(root, 'dist', 'server.mjs');

await build({
  entryPoints: [join(root, 'src', 'cli.ts')],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: outFile,
  banner: {
    js: [
      '#!/usr/bin/env node',
      'import { createRequire as __mcpCreateRequire } from "node:module";',
      'const require = __mcpCreateRequire(import.meta.url);',
    ].join('\n'),
  },
  define: {
    __PACKAGE_VERSION__: JSON.stringify(version),
  },
  legalComments: 'none',
});

chmodSync(outFile, 0o755);

// Keep pi-mcp.json version pinned to package.json version (matching @wezzard/mcp-relay).
const piMcp = {
  mcpServers: {
    'x-articles': {
      command: 'npx',
      args: ['-y', `${pkg.name}@${version}`],
      lifecycle: 'lazy',
      directTools: true,
      toolPrefix: 'none',
    },
  },
};
writeFileSync(join(root, 'pi-mcp.json'), JSON.stringify(piMcp) + '\n', 'utf8');

console.log(`Built dist/server.mjs and synced pi-mcp.json for ${pkg.name}@${version}`);
