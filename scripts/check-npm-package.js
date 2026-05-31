#!/usr/bin/env node

/**
 * Verifies that the npm package ships the JS launcher and install scripts, but
 * not the platform-specific native binaries. Those binaries are release assets
 * and are downloaded by scripts/postinstall.js for the current platform.
 */

import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const npmCache = mkdtempSync(join(tmpdir(), 'agent-browser-npm-cache-'));
let output;
try {
  output = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      NPM_CONFIG_CACHE: npmCache,
      npm_config_cache: npmCache,
    },
  });
} finally {
  rmSync(npmCache, { recursive: true, force: true });
}
const packs = JSON.parse(output);
const pack = packs[0];

if (!pack || !Array.isArray(pack.files)) {
  console.error('Could not inspect npm package contents');
  process.exit(1);
}

const files = pack.files.map(file => file.path);
const fileSet = new Set(files);
const requiredFiles = [
  'bin/agent-browser.js',
  'scripts/postinstall.js',
  'package.json',
  'README.md',
];
const missing = requiredFiles.filter(file => !fileSet.has(file));
const forbidden = files.filter(file =>
  /^bin\/agent-browser-(?:darwin|linux|linux-musl|win32)/.test(file)
);
const maxUnpackedSize = 1_000_000;

if (missing.length > 0) {
  console.error('npm package is missing required files:');
  for (const file of missing) {
    console.error(`  ${file}`);
  }
  process.exit(1);
}

if (forbidden.length > 0) {
  console.error('npm package includes native binaries that should stay on GitHub Releases:');
  for (const file of forbidden) {
    console.error(`  ${file}`);
  }
  process.exit(1);
}

if (pack.unpackedSize > maxUnpackedSize) {
  console.error(
    `npm package is too large: ${pack.unpackedSize} bytes, expected <= ${maxUnpackedSize}`
  );
  process.exit(1);
}

console.log(
  `npm package contents OK: ${files.length} files, ${pack.unpackedSize} bytes unpacked`
);
