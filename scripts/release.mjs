#!/usr/bin/env node
/**
 * Single-command autonomous release script for coding agents:
 *   npm run release -- patch
 *   npm run release -- minor
 *   npm run release -- major
 *   npm run release -- 0.2.2
 *
 * Bumps package.json + package-lock.json, runs `npm run check` (which rebuilds
 * dist/server.mjs, syncs all plugin manifests & pi-mcp.json, typechecks, tests,
 * and verifies the tarball), commits, tags `v<version>`, and pushes `main` + tag
 * so GitHub Actions OIDC (`npm publish --provenance --access public`) finishes
 * the GitHub Release and npm publish with zero manual browser or 2FA steps.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: 'inherit' });
const capture = (cmd, args) =>
  execFileSync(cmd, args, { cwd: root, encoding: 'utf8' }).trim();

const target = (process.argv[2] ?? 'patch').trim();
if (!target) {
  console.error('Usage: npm run release -- <patch|minor|major|x.y.z>');
  process.exit(1);
}

const dirty = capture('git', ['status', '--porcelain']);
if (dirty) {
  console.error('Working tree is not clean. Commit or stash changes before running `npm run release`.');
  process.exit(1);
}

const branch = capture('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
if (branch !== 'main') {
  console.error(`Expected branch "main", found "${branch}".`);
  process.exit(1);
}

const pkgPath = join(root, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const [maj, min, pat] = pkg.version.split('.').map(Number);

let nextVersion;
if (target === 'patch') nextVersion = `${maj}.${min}.${pat + 1}`;
else if (target === 'minor') nextVersion = `${maj}.${min + 1}.0`;
else if (target === 'major') nextVersion = `${maj + 1}.0.0`;
else if (/^\d+\.\d+\.\d+$/.test(target)) nextVersion = target;
else {
  console.error(`Invalid release increment or semver "${target}".`);
  process.exit(1);
}

pkg.version = nextVersion;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');

const lockPath = join(root, 'package-lock.json');
if (existsSync(lockPath)) {
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  lock.version = nextVersion;
  if (lock.packages?.['']) {
    lock.packages[''].version = nextVersion;
  }
  writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n', 'utf8');
}

if (!existsSync(join(root, 'node_modules'))) {
  run('npm', ['install']);
}

run('npm', ['run', 'check']);
run('git', ['add', '-A']);
run('git', ['commit', '-m', `Release v${nextVersion}`]);
run('git', ['tag', '-a', `v${nextVersion}`, '-m', `v${nextVersion}`]);
run('git', ['push', 'origin', 'main', `v${nextVersion}`]);

console.log(`Released v${nextVersion} to origin; GitHub Actions OIDC will publish to npm and GitHub Releases.`);
